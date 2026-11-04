/**
 * Compiles a sketch for the ESP32 simulator: a copy of the sketch plus the
 * simulator bridge (impulse_sim.cpp), built with the board's own core and the
 * settings QEMU needs, then merged into a flash image.
 *
 * Settings changed for the simulator only: DIO flash (QEMU's flash model
 * doesn't do QIO/OPI), Serial on UART0 (USB CDC On Boot off: the native USB
 * port isn't emulated), quad PSRAM on the S3 (octal isn't emulated). ESP32-S2
 * boards, which QEMU doesn't emulate, are built for the ESP32-S3 with the
 * board's own pin definitions: both are single-USB Xtensa LX7 chips with
 * GPIO 0–21 and 26–46.
 * @module main/services/esp32sim/build
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { buildFlashImage } = require('./image');

const BRIDGE_FILE = 'zz_impulse_simulator.cpp';

/* global __IMPULSE_BRIDGE_SOURCE__ */
/**
 * The bridge's source: built into the bundled command-line runner (an ES
 * module, with no __dirname), else the file next to this one.
 */
function bridgeSource() {
  if (typeof __IMPULSE_BRIDGE_SOURCE__ === 'string') return Buffer.from(__IMPULSE_BRIDGE_SOURCE__);
  return fs.readFileSync(path.join(__dirname, 'impulse_sim.cpp'));
}

/** Functions the bridge takes over at link time (the rest are weak in the core). */
const WRAPPED = [
  'initArduino', '__attachInterruptFunctionalArg', 'pulseIn', 'pulseInLong',
  // ESP-IDF's GPIO driver, so sketches that use it simulate like digitalWrite ones.
  'gpio_set_level', 'gpio_get_level', 'gpio_set_direction', 'gpio_reset_pin', 'gpio_config', 'gpio_set_pull_mode',
  // LEDC by channel (core 2.x) and by pin (core 3.x): the bridge defines the set its core has.
  'ledcSetup', 'ledcChangeFrequency', 'ledcAttachPin', 'ledcDetachPin', 'ledcWrite', 'ledcRead', 'ledcReadFreq',
  'ledcWriteTone', 'ledcWriteNote', 'ledcAttach', 'ledcAttachChannel', 'ledcWriteChannel', 'ledcDetach', 'ledcOutputInvert',
  'ledcFade', 'ledcFadeWithInterrupt', 'ledcFadeWithInterruptArg', 'ledcFadeGamma', 'ledcFadeGammaWithInterrupt', 'ledcFadeGammaWithInterruptArg',
  'analogWrite', 'analogWriteFrequency', 'analogWriteResolution', 'neopixelWrite', 'rgbLedWrite', 'rgbLedWriteOrdered',
  'i2cInit', 'i2cDeinit', 'i2cIsInit', 'i2cSetClock', 'i2cGetClock', 'i2cWrite', 'i2cRead', 'i2cWriteReadNonStop',
  'double_tap_init', 'double_tap_mark', 'double_tap_invalidate', 'double_tap_check_match',
  // SPI: every driver function that takes the bus handle.
  'spiStartBus', 'spiStopBus', 'spiAttachSCK', 'spiAttachMISO', 'spiAttachMOSI', 'spiDetachSCK', 'spiDetachMISO',
  'spiDetachMOSI', 'spiAttachSS', 'spiDetachSS', 'spiEnableSSPins', 'spiDisableSSPins', 'spiSSEnable', 'spiSSDisable',
  'spiSSSet', 'spiSSClear', 'spiWaitReady', 'spiGetClockDiv', 'spiGetDataMode', 'spiGetBitOrder', 'spiSetClockDiv',
  'spiSetDataMode', 'spiSetBitOrder', 'spiTransaction', 'spiSimpleTransaction', 'spiEndTransaction',
  'spiWrite', 'spiWriteByte', 'spiWriteWord', 'spiWriteLong', 'spiWriteNL', 'spiWriteByteNL', 'spiWriteShortNL',
  'spiWriteLongNL', 'spiWritePixelsNL', 'spiTransfer', 'spiTransferByte', 'spiTransferWord', 'spiTransferLong',
  'spiTransferBytes', 'spiTransferBits', 'spiTransferByteNL', 'spiTransferShortNL', 'spiTransferLongNL',
  'spiTransferBytesNL', 'spiTransferBitsNL',
  // Wi-Fi: a pretend network (the emulator has no radio).
  'esp_wifi_init', 'esp_wifi_deinit', 'esp_wifi_set_mode', 'esp_wifi_get_mode', 'esp_wifi_start', 'esp_wifi_stop',
  'esp_wifi_restore', 'esp_wifi_set_config', 'esp_wifi_get_config', 'esp_wifi_connect', 'esp_wifi_disconnect',
  'esp_wifi_scan_start', 'esp_wifi_scan_stop', 'esp_wifi_scan_get_ap_num', 'esp_wifi_scan_get_ap_records',
  'esp_wifi_sta_get_ap_info', 'esp_wifi_get_mac', 'esp_wifi_get_channel', 'esp_wifi_set_channel', 'esp_wifi_set_ps',
  'esp_wifi_set_storage', 'esp_wifi_set_protocol', 'esp_wifi_get_protocol', 'esp_wifi_set_bandwidth',
  'esp_wifi_set_max_tx_power', 'esp_wifi_get_max_tx_power', 'esp_wifi_ap_get_sta_list',
  'esp_netif_create_default_wifi_sta', 'esp_netif_create_default_wifi_ap', 'esp_netif_get_ip_info', 'esp_netif_is_netif_up',
];

/** Chips QEMU emulates, and the chip each board's sketch runs on. */
const EMULATED = new Set(['esp32', 'esp32s3', 'esp32c3']);
const RUNS_ON = { esp32: 'esp32', esp32s3: 'esp32s3', esp32c3: 'esp32c3', esp32s2: 'esp32s3' };

/** PSRAM the emulator gives a board that has it (QEMU's ESP32 takes 4 MB at most). */
const PSRAM_MB = { esp32: 4, esp32s3: 8 };

/** Folders in a sketch that are never part of the build. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'build', '.pio', '.vscode']);
const MAX_COPY_BYTES = 64 * 1024 * 1024;

function propsOf(detailsJson) {
  const props = {};
  for (const line of detailsJson.build_properties || []) {
    const i = line.indexOf('=');
    if (i > 0) props[line.slice(0, i)] = line.slice(i + 1);
  }
  return props;
}

/**
 * What the simulator builds for a board: the chip it runs on, the FQBN and
 * extra build properties, the bootloader offset and the PSRAM to emulate.
 * @param {string} fqbn
 * @param {Record<string, string>} props  expanded board properties
 */
function simBuildPlan(fqbn, props) {
  const mcu = props['build.mcu'];
  const chip = RUNS_ON[mcu];
  if (!chip) return null;
  const properties = {
    'build.boot': 'dio',
    'build.boot_freq': '80m',
    'build.flash_mode': 'dio',
    'build.flash_freq': '80m',
    // QEMU's flash chip stays in dual I/O: SDK builds for quad or octal flash
    // (which some boards name outright) assert at startup.
    'build.memory_type': 'dio_qspi',
    'build.cdc_on_boot': '0',
    'compiler.c.elf.extra_flags': `${props['compiler.c.elf.extra_flags'] || ''} -Wl,${WRAPPED.map(f => `--wrap=${f}`).join(',')}`.trim(),
  };
  const defines = props['build.defines'] || '';
  const hasPsram = /-DBOARD_HAS_PSRAM\b/.test(defines);
  let buildFqbn = fqbn;
  let bootloaderAddr = Number(props['build.bootloader_addr'] || (chip === 'esp32' ? 0x1000 : 0));
  if (mcu === 'esp32s2') {
    // The S3's core settings with the S2 board's pins.
    const [vendor, arch] = fqbn.split(':');
    buildFqbn = `${vendor}:${arch}:esp32s3`;
    Object.assign(properties, {
      'build.variant': props['build.variant'] || 'esp32s2',
      'build.board': props['build.board'] || 'ESP32S2_DEV',
      'build.defines': defines,
      'build.psram_type': 'qspi',
    });
    bootloaderAddr = 0;
  } else if (chip === 'esp32s3') {
    properties['build.psram_type'] = 'qspi';
  }
  return {
    chip,
    mcu,
    fqbn: buildFqbn,
    properties,
    bootloaderAddr,
    flashSize: props['build.flash_size'] || '4MB',
    psramMB: hasPsram ? PSRAM_MB[chip] || 0 : 0,
    platformPath: props['runtime.platform.path'] || '',
    note: mcu === 'esp32s2' ? 'ESP32-S2 boards run on the emulated ESP32-S3 with their own pin definitions.' : null,
  };
}

/** Copy a sketch folder (sources only, timestamps kept so unchanged files aren't rebuilt). */
function copySketch(from, to) {
  let bytes = 0;
  const wanted = new Set();
  const walk = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) { wanted.add(d); walk(s, d); }
      } else if (entry.isFile()) {
        const st = fs.statSync(s);
        bytes += st.size;
        if (bytes > MAX_COPY_BYTES) throw new Error('The sketch folder is too large to simulate (over 64 MB). Move data files out of it.');
        wanted.add(d);
        const prev = fs.existsSync(d) ? fs.statSync(d) : null;
        // Copied timestamps keep whole milliseconds only.
        if (!prev || Math.abs(prev.mtimeMs - st.mtimeMs) >= 1 || prev.size !== st.size) fs.cpSync(s, d, { preserveTimestamps: true });
      }
    }
  };
  walk(from, to);
  // Files deleted from the sketch since the last copy.
  const prune = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (p === path.join(to, BRIDGE_FILE)) continue;
      if (entry.isDirectory()) {
        if (!wanted.has(p)) fs.rmSync(p, { recursive: true, force: true });
        else prune(p);
      } else if (!wanted.has(p)) {
        fs.rmSync(p, { force: true });
      }
    }
  };
  prune(to);
}

class Esp32SimBuilder {
  /**
   * @param {{ runCli: (args: string[], opts?: object) => Promise<{ success: boolean, stdout: string, stderr: string }>,
   *   workDir?: string }} opts
   */
  constructor({ runCli, workDir = path.join(os.tmpdir(), 'impulse-esp32-sim') }) {
    this.runCli = runCli;
    this.workDir = workDir;
    this.detailsCache = new Map();
    this.images = new Map();
  }

  async boardProps(fqbn) {
    if (this.detailsCache.has(fqbn)) return this.detailsCache.get(fqbn);
    const res = await this.runCli(['board', 'details', '-b', fqbn, '--format', 'json', '--show-properties=expanded'], { timeout: 30000 });
    if (!res.success) {
      const err = `${res.stderr || ''}${res.stdout || ''}`;
      const e = new Error(/not found|not installed|unknown package|invalid fqbn/i.test(err)
        ? `The core for ${fqbn} isn't installed.`
        : `arduino-cli couldn't describe ${fqbn}: ${err.trim().split('\n')[0] || 'unknown error'}`);
      e.missingCore = /not found|not installed|unknown package/i.test(err);
      throw e;
    }
    const props = propsOf(JSON.parse(res.stdout));
    this.detailsCache.set(fqbn, props);
    return props;
  }

  /** The chip a board is built on (build.mcu), or null. */
  async chipOf(fqbn) {
    try {
      return (await this.boardProps(fqbn))['build.mcu'] || null;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} sketchDir
   * @param {string} fqbn  the board from the board menu
   * @returns {Promise<{ success: true, esp32: { image: string, chip: string, mcu: string, psramMB: number, note: string|null } }
   *   | { success: false, error: string, missingCore?: boolean }>}
   */
  async build(sketchDir, fqbn) {
    let props;
    try {
      props = await this.boardProps(fqbn);
    } catch (err) {
      return { success: false, error: err.message, missingCore: !!err.missingCore };
    }
    const plan = simBuildPlan(fqbn, props);
    if (!plan) return { success: false, error: `The simulator runs the ESP32, ESP32-S2, ESP32-S3 and ESP32-C3; this board uses the ${props['build.mcu'] || 'unknown chip'}.` };

    const name = path.basename(sketchDir);
    const key = crypto.createHash('sha1').update(`${sketchDir}\n${fqbn}`).digest('hex').slice(0, 16);
    const root = path.join(this.workDir, key);
    const copyDir = path.join(root, name);
    const buildPath = path.join(root, 'build');
    const outDir = path.join(root, 'out');
    try {
      copySketch(sketchDir, copyDir);
      const bridge = bridgeSource();
      const bridgePath = path.join(copyDir, BRIDGE_FILE);
      if (!fs.existsSync(bridgePath) || !fs.readFileSync(bridgePath).equals(bridge)) fs.writeFileSync(bridgePath, bridge);
      fs.rmSync(outDir, { recursive: true, force: true });
    } catch (err) {
      return { success: false, error: `Could not prepare the sketch for the simulator: ${err.message}` };
    }

    const args = ['compile', '--fqbn', plan.fqbn, '--build-path', buildPath, '--output-dir', outDir];
    for (const [k, v] of Object.entries(plan.properties)) args.push('--build-property', `${k}=${v}`);
    args.push(copyDir);
    const res = await this.runCli(args, { cwd: copyDir, timeout: 15 * 60 * 1000 });
    if (!res.success) {
      // Errors point at the copy (by its real path too, /private/var/… on macOS); show the user's own files.
      let text = `${res.stderr || ''}\n${res.stdout || ''}`;
      for (const dir of new Set([fs.realpathSync.native(copyDir), copyDir])) text = text.split(dir).join(sketchDir);
      text = text.trim();
      return { success: false, error: text || 'Compilation failed', missingCore: /platform not installed|Platform '.+' not found/i.test(text) };
    }

    try {
      const file = (suffix) => fs.readFileSync(path.join(outDir, `${name}.ino${suffix}`));
      const bootApp0Path = path.join(plan.platformPath, 'tools', 'partitions', 'boot_app0.bin');
      const image = buildFlashImage({
        bootloader: file('.bootloader.bin'),
        bootloaderAddr: plan.bootloaderAddr,
        partitions: file('.partitions.bin'),
        bootApp0: fs.existsSync(bootApp0Path) ? fs.readFileSync(bootApp0Path) : null,
        app: file('.bin'),
        flashSize: plan.flashSize,
      });
      const imagePath = path.join(root, 'flash.bin');
      fs.writeFileSync(imagePath, image);
      const id = `${key}-${Date.now().toString(36)}`;
      this.images.set(id, { imagePath, chip: plan.chip, psramMB: plan.psramMB });
      if (this.images.size > 20) this.images.delete(this.images.keys().next().value);
      return { success: true, esp32: { image: id, chip: plan.chip, mcu: plan.mcu, psramMB: plan.psramMB, note: plan.note } };
    } catch (err) {
      return { success: false, error: `Could not make the flash image: ${err.message}` };
    }
  }

  /** A fresh copy of a built image for one run (QEMU writes to its flash). */
  imageForRun(id) {
    const entry = this.images.get(id);
    if (!entry || !fs.existsSync(entry.imagePath)) return null;
    const runPath = path.join(path.dirname(entry.imagePath), `run-${Date.now().toString(36)}.bin`);
    fs.copyFileSync(entry.imagePath, runPath);
    return { ...entry, runPath };
  }
}

module.exports = { Esp32SimBuilder, simBuildPlan, copySketch, WRAPPED, EMULATED, RUNS_ON, BRIDGE_FILE };
