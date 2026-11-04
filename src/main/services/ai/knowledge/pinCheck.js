/**
 * Read the pins a sketch uses and check them against the board.
 *
 * This is the answer to code that drives GPIO 22 on a chip whose pins stop at
 * 21: the numbers are taken out of the code, resolved through the sketch's own
 * constants and the core's pin names, and checked against the chip (pinMap.js)
 * and the board's record (pins its onboard parts already use). It is
 * deterministic, so the harness can correct the model instead of hoping.
 * @module main/services/ai/knowledge/pinCheck
 */
const { checkPin, mapFor, describeRanges, BOARD_NUMBERED } = require('./pinMap');

// How a pin is used decides which rules apply.
const CALLS = [
  { re: /\bpinMode\s*\(\s*([^,()]+?)\s*,\s*([A-Za-z_][\w]*)\s*\)/g, pin: 1, use: (m) => ({ output: /OUTPUT/.test(m[2]) }) },
  { re: /\bdigitalWrite\s*\(\s*([^,()]+?)\s*,/g, pin: 1, use: () => ({ output: true }) },
  { re: /\bdigitalRead\s*\(\s*([^,()]+?)\s*\)/g, pin: 1, use: () => ({}) },
  { re: /\banalogWrite\s*\(\s*([^,()]+?)\s*,/g, pin: 1, use: () => ({ output: true, analogWrite: true }) },
  { re: /\banalogRead\s*\(\s*([^,()]+?)\s*\)/g, pin: 1, use: () => ({ analogRead: true }) },
  { re: /\btone\s*\(\s*([^,()]+?)\s*,/g, pin: 1, use: () => ({ output: true }) },
  { re: /\bldc?Attach\w*\s*\(\s*([^,()]+?)\s*,/g, pin: 1, use: () => ({ output: true }) },
  { re: /\bledcAttach(?:Pin|Channel)?\s*\(\s*([^,()]+?)\s*,/g, pin: 1, use: () => ({ output: true, analogWrite: true }) },
  { re: /\bdigitalPinToInterrupt\s*\(\s*([^,()]+?)\s*\)/g, pin: 1, use: () => ({}) },
  { re: /\.attach\s*\(\s*([^,()]+?)\s*[,)]/g, pin: 1, use: () => ({ output: true }) },
  { re: /\btouchRead\s*\(\s*([^,()]+?)\s*\)/g, pin: 1, use: () => ({}) },
  { re: /\bdacWrite\s*\(\s*([^,()]+?)\s*,/g, pin: 1, use: () => ({ output: true }) },
];

// Wire.begin(sda, scl) and SoftwareSerial(rx, tx): both arguments are pins.
const PAIRS = [
  { re: /\bWire1?\.begin\s*\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*[,)]/g, use: () => ({}) },
  { re: /\bSoftwareSerial\s+\w+\s*\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)/g, use: () => ({}) },
  { re: /\bSerial\d?\.begin\s*\([^,()]+,\s*[A-Z0-9_]+\s*,\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)/g, use: () => ({}) },
];

const DEFINE = /^\s*#\s*define\s+([A-Za-z_]\w*)\s+(\d+)\s*$/gm;
// The type and the name are enough: "const int LED = 22;" and
// "static constexpr byte LED = 22;" both end in "int LED = 22;" / "byte LED = 22;".
const CONST = /\b(?:uint8_t|int8_t|byte|int|short)\s+([A-Za-z_]\w*)\s*=\s*(\d+)\s*;/g;

/** The sketch's own pin constants: #define LED 22, const int LED = 22. */
function constantsOf(code) {
  const out = new Map();
  for (const re of [DEFINE, CONST]) {
    re.lastIndex = 0;
    for (const m of String(code || '').matchAll(re)) out.set(m[1], Number(m[2]));
  }
  return out;
}

/**
 * Resolve one argument to a pin number: a literal, a constant of the sketch,
 * or a name the core defines (LED_BUILTIN, SDA, A0, D3).
 * @returns {{ pin: number, via: string } | null}
 */
function resolvePin(text, { constants, named }) {
  const token = String(text || '').trim();
  if (!token) return null;
  if (/^\d+$/.test(token)) return { pin: Number(token), via: token };
  if (constants.has(token)) return { pin: constants.get(token), via: `${token} = ${constants.get(token)}` };
  if (named.has(token)) {
    const value = named.get(token);
    return Number.isInteger(value) ? { pin: value, via: `${token} = ${value}` } : null;
  }
  return null;
}

// Pins the board is built around: a warning about them is noise, because the
// board's own designer put the LED, the I2C bus or the UART there.
const FUNCTION_PINS = ['LED_BUILTIN', 'PIN_LED', 'LED_RED', 'LED_GREEN', 'LED_BLUE', 'RGB_BUILTIN', 'PIN_NEOPIXEL',
  'SDA', 'SCL', 'SDA1', 'SCL1', 'TX', 'RX', 'TX1', 'RX1', 'MOSI', 'MISO', 'SCK', 'SS'];

/** Pin names the core defines for this board, as name → number. */
function namedPinsOf(boardInfo) {
  const named = new Map();
  const take = (obj) => {
    for (const [name, value] of Object.entries(obj || {})) {
      if (Number.isInteger(value)) named.set(name, value);
    }
  };
  take(boardInfo?.pins);
  take(boardInfo?.analogPins);
  take(boardInfo?.digitalAliases);
  take(boardInfo?.touchPins);
  return named;
}

/**
 * Check a sketch's pins against a board.
 * @param {string} code
 * @param {object} boardInfo  what boardKnowledge.boardInfo() returned
 * @param {{ taken?: string[], boardName?: string }} [extra]  pins the board's onboard parts use (the board record)
 * @returns {{ level: 'error'|'warning', pin: number, via: string, call: string, message: string, fix?: string }[]}
 */
function checkSketchPins(code, boardInfo, { taken = [], boardName = '' } = {}) {
  const family = boardInfo?.family || '';
  if (!mapFor(family)) return []; // a family whose pins are not numbers (STM32's PA0…)
  const platform = String(boardInfo?.fqbn || '').split(':').slice(0, 2).join(':');
  const boardNumbered = BOARD_NUMBERED.has(platform);
  const constants = constantsOf(code);
  const named = namedPinsOf(boardInfo);
  const byDesign = new Set(FUNCTION_PINS.map((name) => named.get(name)).filter(Number.isInteger));
  // The installed core is the authority on this board: a pin it names exists
  // and is usable, whatever the chip-level table says. That is how an
  // ESP32-PICO board legitimately uses GPIO 9, and how the Nano ESP32's
  // Arduino numbering stays correct, while an invented GPIO is still caught.
  const coreKnows = new Set([...named.values()].filter(Number.isInteger));
  const takenPins = new Map();
  for (const entry of taken) {
    const n = Number(String(entry).trim());
    if (Number.isInteger(n)) takenPins.set(n, entry);
  }
  const seen = new Set();
  const warned = new Set();
  const issues = [];
  const add = (resolved, use, call) => {
    if (!resolved) return;
    const key = `${resolved.pin}:${call}:${use.output ? 'o' : ''}${use.analogRead ? 'r' : ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    let problem = checkPin(resolved.pin, family, use);
    // "No such pin" and "that is the flash" are claims about the chip; the
    // board's own core can prove them wrong for this board.
    if (problem && coreKnows.has(resolved.pin) && /has no pin|wired to the flash/.test(problem.reason)) problem = null;
    // Where the core numbers pins per board (the Nano ESP32), only the names
    // it defines are pins at all, whatever the chip could do.
    if (boardNumbered && coreKnows.size && !coreKnows.has(resolved.pin)) {
      const names = [...named.keys()].filter((n) => /^[AD]\d+$/.test(n));
      problem = {
        level: 'error',
        reason: `pin ${resolved.pin} is not a pin on this board`,
        fix: `This board numbers its pins itself: use the ones the core names (${names.slice(0, 10).join(', ') || 'see get_board_info'}).`,
      };
    }
    if (problem) {
      // A pin the board itself uses for its LED, its I2C bus or its UART is
      // meant to be used: only real errors are worth saying.
      if (problem.level === 'warning' && byDesign.has(resolved.pin)) return;
      // One warning per pin, however often the sketch touches it.
      if (problem.level === 'warning') {
        if (warned.has(resolved.pin)) return;
        warned.add(resolved.pin);
      }
      issues.push({
        level: problem.level,
        pin: resolved.pin,
        via: resolved.via,
        call,
        message: `${call}: ${problem.reason}`,
        fix: problem.fix,
      });
      return;
    }
    // The chip is fine with it, but this board already uses the pin.
    if (takenPins.has(resolved.pin) && !warned.has(resolved.pin)) {
      warned.add(resolved.pin);
      issues.push({
        level: 'warning',
        pin: resolved.pin,
        via: resolved.via,
        call,
        message: `${call}: pin ${resolved.pin} is already used by something on ${boardName || 'this board'}`,
        fix: 'Driving it fights the onboard part. Pick a free pin.',
      });
    }
  };

  const source = String(code || '');
  for (const { re, use } of CALLS.map((c) => ({ ...c, use: c.use }))) {
    re.lastIndex = 0;
    for (const m of source.matchAll(re)) {
      add(resolvePin(m[1], { constants, named }), use(m), m[0].split('(')[0].trim());
    }
  }
  for (const { re, use } of PAIRS) {
    re.lastIndex = 0;
    for (const m of source.matchAll(re)) {
      const call = m[0].split('(')[0].trim();
      add(resolvePin(m[1], { constants, named }), use(m), call);
      add(resolvePin(m[2], { constants, named }), use(m), call);
    }
  }
  // Errors first, then by pin, so the first line of a report is the worst one.
  return issues.sort((a, b) => (a.level === b.level ? a.pin - b.pin : a.level === 'error' ? -1 : 1));
}

/**
 * The same, as text for the model or a card.
 * @returns {string|null} null when the sketch's pins are all fine
 */
function pinReport(issues, { boardName = 'this board' } = {}) {
  if (!issues?.length) return null;
  // One line per pin: naming the same pin once for pinMode and again for
  // digitalWrite says nothing more.
  const seenPins = new Set();
  const once = issues.filter((i) => {
    const key = `${i.level}:${i.pin}`;
    if (seenPins.has(key)) return false;
    seenPins.add(key);
    return true;
  });
  const errors = once.filter((i) => i.level === 'error');
  const warnings = once.filter((i) => i.level === 'warning');
  const lines = [];
  if (errors.length) lines.push(`[PIN CHECK] ${errors.length === 1 ? 'A pin in this sketch cannot work' : `${errors.length} pins in this sketch cannot work`} on ${boardName}:`);
  else lines.push(`[PIN CHECK] Worth a look on ${boardName}:`);
  for (const issue of [...errors, ...warnings].slice(0, 8)) {
    lines.push(`- ${issue.message}${issue.via && !/^\d+$/.test(issue.via) ? ` (${issue.via})` : ''}. ${issue.fix || ''}`.trimEnd());
  }
  return lines.join('\n');
}

/** The pins of a family, for a message: "0–19, 21–23, 25–27 and 32–39". */
function pinsText(familyId) {
  const map = mapFor(familyId);
  return map ? describeRanges(map.gpio) : '';
}

module.exports = { checkSketchPins, pinReport, constantsOf, namedPinsOf, resolvePin, pinsText };
