/**
 * What the AI knows about a board, from the source the compiler uses: the
 * installed core's board definition (arduino-cli board details) and its
 * variant headers, plus the family guide for the chip. Works for any board of
 * any installed core; boards whose core isn't installed are found with
 * search() and named with the core to install.
 */
const { proof, proofLine, coreProof, boardProof, driftProof, guideProof } = require('./proof');
const { readDefinitions, pinFacts, variantHeaders } = require('./pinsHeader');
const { familyOf, familyById, guideText } = require('./mcuGuide');
const records = require('./boardRecords');
const { pinsText } = require('./pinCheck');
const { mapFor } = require('./pinMap');

const CACHE_LIMIT = 40;

class BoardKnowledge {
  /** @param {(args: string[], opts?: object) => Promise<{ success: boolean, stdout: string, stderr: string }>} runCli */
  constructor(runCli) {
    this.runCli = runCli;
    this.cache = new Map();
  }

  /** arduino-cli's view of a board: name, core, build properties and options. */
  async details(fqbn) {
    if (!fqbn) throw new Error('No board selected. Select a board first, or pass its FQBN (e.g. arduino:avr:uno).');
    if (this.cache.has(fqbn)) return this.cache.get(fqbn);
    const res = await this.runCli(['board', 'details', '-b', fqbn, '--format', 'json', '--show-properties=expanded'], { timeout: 20000 });
    if (!res?.success) {
      const err = String(res?.stderr || res?.stdout || '').trim();
      const platform = String(fqbn).split(':').slice(0, 2).join(':');
      throw new Error(/not found|unknown package|platform not installed|invalid fqbn|not installed/i.test(err)
        ? `The core for ${fqbn} isn't installed. Install it with the Boards Manager (core ${platform}), then ask again.`
        : `arduino-cli couldn't describe ${fqbn}: ${err.split('\n')[0] || 'unknown error'}`);
    }
    const data = JSON.parse(res.stdout);
    const props = {};
    for (const line of data.build_properties || []) {
      const i = line.indexOf('=');
      if (i > 0) props[line.slice(0, i)] = line.slice(i + 1);
    }
    const details = {
      fqbn,
      name: data.name || props.name || fqbn,
      core: `${data.package?.name || fqbn.split(':')[0]}:${data.platform?.architecture || fqbn.split(':')[1]}`,
      coreName: data.platform?.name || '',
      coreVersion: data.version || '',
      props,
      options: (data.config_options || []).map((o) => {
        const sel = (o.values || []).find((v) => v.selected) || (o.values || [])[0] || {};
        return { option: o.option, label: o.option_label || o.option, value: sel.value, valueLabel: sel.value_label || sel.value };
      }),
    };
    this.cache.set(fqbn, details);
    if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
    return details;
  }

  /**
   * Everything about a board, as data.
   * @param {string} fqbn
   * @param {{ raw?: boolean }} [opts]  raw: also the pin definitions as written in the core
   */
  async boardInfo(fqbn, { raw = false } = {}) {
    const d = await this.details(fqbn);
    const p = d.props;
    const family = familyOf(p, fqbn);
    const headers = variantHeaders(p);
    const defs = new Map();
    const seen = new Set();
    for (const h of headers) readDefinitions(h, { root: p['runtime.platform.path'], seen, into: defs });
    const facts = pinFacts(defs, { family: family?.id || '', coreVersion: d.coreVersion });
    const num = (k) => (p[k] && /^\d+$/.test(p[k]) ? Number(p[k]) : null);
    const cpuHz = p['build.f_cpu'] ? Number(String(p['build.f_cpu']).replace(/[^\d]/g, '')) : null;
    const usb = {};
    if (p['build.cdc_on_boot'] !== undefined) usb.cdcOnBoot = p['build.cdc_on_boot'] === '1';
    if (p['build.usb_mode'] !== undefined) usb.usbMode = p['build.usb_mode'] === '1' ? 'hardware CDC (USB Serial/JTAG)' : 'TinyUSB (OTG)';
    const notes = [...facts.notes];
    if (fqbn.startsWith('arduino:') && ['LEDR', 'LEDG', 'LEDB'].every((k) => k in facts.pins) && !notes.some((n) => n.startsWith('LEDR'))) {
      notes.push('LEDR, LEDG and LEDB drive the board\'s RGB LED, which is active-LOW on Arduino boards: LOW turns a colour on.');
    }
    const numbering = d.options.find((o) => /pin numbering/i.test(o.label));
    if (numbering) {
      notes.push(`Pin numbering is set to "${numbering.valueLabel}" (Tools › Pin Numbering): with Arduino pin numbering, numbers and D-constants are the board's labels (D13 is pin 13), not GPIO numbers.`);
    }
    if (usb.cdcOnBoot === false && /^esp32-(s2|s3|c3|c6|h2)/.test(family?.id || '')) {
      notes.push(`USB CDC On Boot is off, so Serial is UART0${facts.pins.TX !== undefined ? ` (TX ${facts.pins.TX}, RX ${facts.pins.RX})` : ''}: it prints on the board's USB-to-serial port, not on the chip's native USB port. Impulse turns USB CDC On Boot on by itself when the board is on its native USB port.`);
    }
    const info = {
      fqbn: d.fqbn,
      name: d.name,
      core: `${d.core} ${d.coreVersion}`.trim(),
      mcu: p['build.mcu'] || null,
      family: family ? family.id : null,
      familyTitle: family ? family.title : null,
      cpuMHz: cpuHz ? Math.round(cpuHz / 1e6) : null,
      sketchFlashBytes: num('upload.maximum_size'),
      ramBytes: num('upload.maximum_data_size'),
      variant: p['build.variant'] || null,
      usb: Object.keys(usb).length ? usb : undefined,
      pins: facts.pins,
      analogPins: Object.keys(facts.analog).length ? facts.analog : undefined,
      digitalAliases: Object.keys(facts.digital).length ? facts.digital : undefined,
      touchPins: Object.keys(facts.touch).length ? facts.touch : undefined,
      boardOptions: d.options.length ? Object.fromEntries(d.options.map((o) => [o.label, o.valueLabel])) : undefined,
      notes,
      source: headers.length ? headers.map((h) => h.replace(/^.*\/packages\//, 'packages/')) : ['(no variant pin header found)'],
      more: family ? `get_mcu_guide("${family.id}") has the chip's limits, pins to avoid and common mistakes.` : 'get_mcu_guide("general") has the rules that apply to every board.',
    };
    // The knowledge layer: what the core cannot say (onboard parts, upload, power, clones, API drift).
    const layer = records.boardNotes(d.fqbn, { familyId: family?.id || null, coreVersion: d.coreVersion });
    if (layer) {
      info.catalog = layer.entry ? { id: layer.entry.id, name: layer.entry.name, rank: layer.entry.rank, india: layer.entry.india } : null;
      info.onboard = layer.record?.onboard || [];
      info.pinsTaken = layer.record?.taken || [];
      info.upload = [...(layer.record?.upload || []), ...(layer.family?.upload || [])];
      info.power = layer.family?.power || [];
      info.clones = layer.family?.clones || [];
      info.libraries = layer.family?.libraries || [];
      info.boardNotes = [...(layer.record?.notes || []), ...(layer.family?.notes || [])];
      const drift = records.driftText(records.platformOf(d.fqbn), d.coreVersion);
      if (drift) info.coreApi = drift;
    }
    // How each part of this answer is known (knowledge/proof.js).
    info.proof = {
      pins: proofLine(coreProof(info.core)),
      notes: layer?.entry ? proofLine(boardProof(layer.entry)) : (layer ? proofLine(proof(0, "Impulse's family notes")) : undefined),
      coreApi: info.coreApi ? proofLine(driftProof(records.platformOf(d.fqbn), d.coreVersion)) : undefined,
    };
    if (raw) {
      info.definitions = [...defs.entries()].slice(0, 400).map(([name, v]) => `${name} = ${v.value}`);
    }
    return info;
  }

  /**
   * A short paragraph for every request, so even a model that doesn't call
   * tools writes for the right pins. Null when the board can't be described.
   */
  async summary(fqbn) {
    let info;
    try {
      info = await this.boardInfo(fqbn);
    } catch {
      return null;
    }
    const family = info.family ? familyById(info.family) : null;
    const volts = family?.logic || '';
    // On boards numbered the Arduino way, analog pins double as digital ones: show 18 as "18 (A4)".
    const arduinoNumbering = /^(avr|megaavr|renesas)/.test(info.family || '');
    const analogName = new Map(Object.entries(info.analogPins || {}).map(([k, v]) => [v, k]));
    const pin = (k) => {
      const v = info.pins[k];
      if (v === undefined) return null;
      return arduinoNumbering && analogName.has(v) ? `${v} (${analogName.get(v)})` : v;
    };
    const parts = [`${info.name} (${info.fqbn}), ${info.core}`];
    const chip = [info.mcu && info.mcu.toUpperCase(), info.cpuMHz && `${info.cpuMHz} MHz`, volts].filter(Boolean).join(', ');
    if (chip) parts.push(chip);
    const led = pin('LED_BUILTIN') ?? pin('PIN_LED');
    parts.push(led !== null ? `LED_BUILTIN = ${led}` : 'LED_BUILTIN is NOT defined (code using it won\'t compile)');
    if (pin('SDA') !== null) parts.push(`I2C SDA ${pin('SDA')}, SCL ${pin('SCL')}`);
    if (pin('MOSI') !== null) parts.push(`SPI MOSI ${pin('MOSI')}, MISO ${pin('MISO')}, SCK ${pin('SCK')}, SS ${pin('SS')}`);
    if (pin('TX') !== null) parts.push(`Serial pins TX ${pin('TX')}, RX ${pin('RX')}`);
    // Which pins the chip has at all: the one fact that stops invented GPIOs.
    const map = mapFor(info.family);
    if (map) {
      const ranges = pinsText(info.family);
      const inputOnly = map.inputOnly?.length ? ` Pins ${map.inputOnly.map(([lo, hi]) => (lo === hi ? lo : `${lo}–${hi}`)).join(', ')} are input-only.` : '';
      const flash = map.flash?.length ? ` Pins ${map.flash.map(([lo, hi]) => (lo === hi ? lo : `${lo}–${hi}`)).join(', ')} are the flash: never use them.` : '';
      parts.push(`pins ${ranges} and no others${inputOnly}${flash}`);
    }
    const text = [`[BOARD FACTS, proof L2: read from the installed core] ${parts.join('; ')}.`, ...info.notes.slice(0, 3)];
    text.push('Use the core\'s constants (LED_BUILTIN, SDA, A0…); call get_board_info, get_mcu_guide or get_component_guide before guessing a pin, voltage or I2C address.');
    const notes = records.notesText(info.fqbn, { familyId: info.family, coreVersion: (info.core.split(' ')[1] || '') });
    return notes ? `${text.join(' ')}\n${notes}` : text.join(' ');
  }

  /** The family guide for a chip, family id or board. */
  async mcuGuide({ chip, fqbn } = {}) {
    if (chip && /^general$/i.test(chip)) {
      const { GENERAL } = require('./mcuGuide');
      return `# ${GENERAL.title}\n${GENERAL.facts.map((f) => `- ${f}`).join('\n')}\n${proofLine(proof(0, "Impulse's general rules"))}`;
    }
    let family = chip ? familyById(chip) : null;
    let coreVersion = '';
    if (!family && (fqbn || !chip)) {
      const d = await this.details(fqbn);
      family = familyOf(d.props, d.fqbn);
      coreVersion = d.coreVersion;
    }
    if (!family) {
      const { FAMILIES } = require('./mcuGuide');
      return `No guide for "${chip}". Known families: ${FAMILIES.map((f) => f.id).join(', ')}, or "general".`;
    }
    return `${guideText(family, { coreVersion })}\n${proofLine(guideProof(family.id))}`;
  }

  /**
   * Boards matching a name, installed or installable.
   * @returns {Promise<Array<{ name: string, fqbn: string | null, core: string, installed: boolean }>>}
   */
  async search(query) {
    const out = [];
    const seen = new Set();
    // The catalog first: the boards people actually have, with the core each needs.
    for (const b of records.searchCatalog(query)) {
      if (seen.has(b.fqbn)) continue;
      seen.add(b.fqbn);
      out.push({ name: b.name, fqbn: b.fqbn, core: b.platform, installed: null, catalog: true, note: b.india, proof: proofLine(boardProof(b)) });
    }
    const listed = await this.runCli(['board', 'listall', query, '--format', 'json'], { timeout: 20000 });
    if (listed?.success) {
      const installedBoards = JSON.parse(listed.stdout).boards || [];
      // Catalog hits learn whether their core is installed from what arduino-cli lists.
      const installedPlatforms = new Set(installedBoards.map((b) => String(b.fqbn || '').split(':').slice(0, 2).join(':')));
      for (const o of out) if (o.catalog) o.installed = installedPlatforms.has(o.core);
      for (const b of installedBoards) {
        if (!b.fqbn || seen.has(b.fqbn)) continue;
        seen.add(b.fqbn);
        out.push({ name: b.name, fqbn: b.fqbn, core: b.fqbn.split(':').slice(0, 2).join(':'), installed: true });
      }
    }
    const searched = await this.runCli(['board', 'search', query, '--format', 'json'], { timeout: 20000 });
    if (searched?.success) {
      for (const b of JSON.parse(searched.stdout).boards || []) {
        const core = b.platform?.metadata?.id || '';
        const key = b.fqbn || `${core}|${b.name}`;
        const same = (a, c) => String(a || '').toLowerCase() === String(c || '').toLowerCase();
        if (seen.has(key) || out.some((o) => same(o.name, b.name) && o.core === core)) continue;
        seen.add(key);
        out.push({ name: b.name, fqbn: b.fqbn || null, core, installed: !!b.fqbn });
      }
    }
    return out.slice(0, 40);
  }
}

module.exports = BoardKnowledge;
