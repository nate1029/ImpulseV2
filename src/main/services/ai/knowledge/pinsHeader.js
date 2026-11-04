/**
 * A board's pin definitions, read from its core's variant headers
 * (pins_arduino.h, variant.h and the files they include from the same core),
 * the way the compiler sees them: LED_BUILTIN, SDA, A0… with their values.
 *
 * Only simple definitions are read: `#define NAME value` and
 * `static const uint8_t NAME = value;`. Function-like macros and preprocessor
 * branches are not evaluated; a value that can't be worked out is kept as the
 * expression it is written as.
 */
const fs = require('fs');
const path = require('path');

const DEFINE = /^\s*#\s*define\s+([A-Za-z_]\w*)\s+(.+)$/;
const QUALIFIERS = new Set(['static', 'const', 'constexpr', 'volatile', 'unsigned']);
const TYPES = new Set(['uint8_t', 'uint16_t', 'uint32_t', 'int8_t', 'int16_t', 'int32_t', 'int', 'pin_size_t', 'PinName', 'byte', 'size_t']);

/** `static const uint8_t SDA = 8;` → ['SDA', '8'], or null. */
function parseConstant(line) {
  const eq = line.indexOf('=');
  const end = line.lastIndexOf(';');
  if (eq < 0 || end < eq) return null;
  const words = line.slice(0, eq).trim().split(/\s+/);
  const name = words.pop();
  if (!/^[A-Za-z_]\w*$/.test(name || '') || !words.some((w) => TYPES.has(w)) || !words.every((w) => TYPES.has(w) || QUALIFIERS.has(w))) return null;
  return [line, name, line.slice(eq + 1, end).trim()];
}
const INCLUDE = /^\s*#\s*include\s+"([^"]+)"/;
const MAX_FILE_BYTES = 256 * 1024;

const stripComments = (line) => line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '').trim();

/**
 * Definitions in a header and the core headers it includes.
 * @param {string} file  the variant's pins_arduino.h (or variant.h)
 * @param {{ root?: string, depth?: number, seen?: Set<string> }} [opts]
 *   root: includes are followed only inside this folder (the core)
 * @returns {Map<string, { value: string, file: string, line: number }>}
 */
function readDefinitions(file, { root = path.dirname(path.dirname(path.dirname(file))), depth = 3, seen = new Set(), into = new Map() } = {}) {
  const real = path.resolve(file);
  if (seen.has(real) || depth < 0) return into;
  seen.add(real);
  let text;
  try {
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return into;
    text = fs.readFileSync(real, 'utf8');
  } catch {
    return into;
  }
  let inBlockComment = false;
  text.split(/\r?\n/).forEach((raw, i) => {
    let line = raw;
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end < 0) return;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    const open = line.indexOf('/*');
    if (open >= 0 && line.indexOf('*/', open) < 0) {
      inBlockComment = true;
      line = line.slice(0, open);
    }
    line = stripComments(line);
    if (!line) return;
    const inc = INCLUDE.exec(line);
    if (inc) {
      const target = path.resolve(path.dirname(real), inc[1]);
      if (target.startsWith(path.resolve(root) + path.sep)) readDefinitions(target, { root, depth: depth - 1, seen, into });
      return;
    }
    const m = DEFINE.exec(line) || parseConstant(line);
    if (!m) return;
    const [, name, valueRaw] = m;
    const value = valueRaw.trim();
    // `#define LED_BUILTIN LED_BUILTIN` only marks the constant as defined.
    if (value === name) return;
    if (!into.has(name)) into.set(name, { value, file: real, line: i + 1 });
  });
  return into;
}

/** A number, or null: 13, 0x1A, (25u), 18UL, (uint8_t)5. */
function literal(text) {
  let s = String(text).trim();
  for (;;) {
    const unwrapped = s.replace(/^\((?:uint8_t|uint16_t|uint32_t|int|pin_size_t)\)\s*/, '').replace(/^\((.*)\)$/, '$1').trim();
    if (unwrapped === s) break;
    s = unwrapped;
  }
  const m = /^(-?)(0x[0-9a-f]+|\d+)[uUlL]*$/i.exec(s);
  if (!m) return null;
  const n = Number(m[2]);
  return m[1] ? -n : n;
}

/**
 * The value of a definition: a number when it can be worked out, else the
 * expression with the names it could resolve filled in.
 * @returns {{ value: number | null, expr: string }}
 */
function resolve(defs, name, depth = 0) {
  const entry = defs.get(name);
  if (!entry || depth > 8) return { value: null, expr: entry ? entry.value : name };
  const raw = entry.value;
  const direct = literal(raw);
  if (direct !== null) return { value: direct, expr: raw };
  const inner = raw.replace(/^\((.*)\)$/, '$1').trim();
  if (/^[A-Za-z_]\w*$/.test(inner)) {
    const r = resolve(defs, inner, depth + 1);
    return { value: r.value, expr: r.value !== null ? String(r.value) : inner };
  }
  // a + b, with either side a number or a name.
  const sum = /^([A-Za-z_]\w*|\d+[uUlL]*)\s*\+\s*([A-Za-z_]\w*|\d+[uUlL]*)$/.exec(inner);
  if (sum) {
    const side = (t) => literal(t) ?? resolve(defs, t, depth + 1).value;
    const a = side(sum[1]);
    const b = side(sum[2]);
    if (a !== null && b !== null) return { value: a + b, expr: inner };
    const show = (t, v) => (v !== null && !/^\d/.test(t) ? `${t}(=${v})` : t);
    return { value: null, expr: `${show(sum[1], a)} + ${show(sum[2], b)}` };
  }
  return { value: null, expr: inner };
}

// The definitions worth showing, in this order; analog, digital and touch
// aliases (A0, D0, T0…) are listed separately.
const KEY_NAMES = [
  'LED_BUILTIN', 'BUILTIN_LED', 'PIN_LED', 'LED_STATE_ON', 'LED_BUILTIN_2', 'PIN_LED2',
  'LEDR', 'LEDG', 'LEDB', 'LED_RED', 'LED_GREEN', 'LED_BLUE', 'PIN_LED_R', 'PIN_LED_G', 'PIN_LED_B', 'LED_PWR',
  'RGB_BUILTIN', 'RGB_BRIGHTNESS', 'PIN_NEOPIXEL', 'PIN_RGB_LED', 'NEOPIXEL_POWER', 'PIN_NEOPIXEL_POWER',
  'BUTTON', 'PIN_BUTTON', 'BOOT_PIN', 'KEY_BUILTIN',
  'SDA', 'SCL', 'SDA1', 'SCL1', 'PIN_WIRE_SDA', 'PIN_WIRE_SCL', 'PIN_WIRE1_SDA', 'PIN_WIRE1_SCL',
  'MOSI', 'MISO', 'SCK', 'SS', 'PIN_SPI_MOSI', 'PIN_SPI_MISO', 'PIN_SPI_SCK', 'PIN_SPI_SS',
  'TX', 'RX', 'TX1', 'RX1', 'TX2', 'RX2', 'PIN_SERIAL_TX', 'PIN_SERIAL_RX', 'PIN_SERIAL1_TX', 'PIN_SERIAL1_RX', 'PIN_SERIAL2_TX', 'PIN_SERIAL2_RX',
  'DAC0', 'DAC1', 'DAC2', 'PIN_DAC0',
  'NUM_DIGITAL_PINS', 'NUM_ANALOG_INPUTS', 'NUM_ANALOG_OUTPUTS', 'PINS_COUNT',
  'USB_VID', 'USB_PID',
];

/**
 * What a board's definitions say, ready to show: key pins, analog/digital/touch
 * aliases, and plain-language notes for the traps (an RGB LED_BUILTIN, an
 * active-LOW LED, no LED at all).
 * @param {Map} defs  from readDefinitions
 * @param {{ family?: string, coreVersion?: string }} [ctx]
 */
function pinFacts(defs, { family = '', coreVersion = '' } = {}) {
  // Arduino-Pico marks pins a board doesn't break out as 31 (the RP2040 stops at GPIO29).
  const notPinned = (v) => /^rp2/.test(family) && v === 31;
  const shown = (r) => (r.value !== null ? (notPinned(r.value) ? 'not pinned out' : r.value) : r.expr);
  const pins = {};
  for (const name of KEY_NAMES) {
    if (!defs.has(name)) continue;
    const r = resolve(defs, name);
    pins[name] = /^USB_[VP]ID$/.test(name) && r.value !== null ? `0x${r.value.toString(16).padStart(4, '0')}` : shown(r);
  }
  const aliases = (prefix) => {
    const out = {};
    const re = new RegExp(`^${prefix}(\\d+)$`);
    for (const name of defs.keys()) {
      const m = re.exec(name);
      if (!m) continue;
      const r = resolve(defs, name);
      // Declared under an #ifdef this board doesn't meet (A0 = __PIN_A0 with no __PIN_A0): not on this board.
      if (r.value === null && /^[A-Za-z_]\w*$/.test(r.expr) && !defs.has(r.expr)) continue;
      out[name] = shown(r);
    }
    return Object.fromEntries(Object.entries(out).sort((a, b) => Number(a[0].slice(prefix.length)) - Number(b[0].slice(prefix.length))));
  };
  const analog = aliases('A');
  const digital = aliases('D');
  const touch = aliases('T');

  const notes = [];
  const ledEntry = defs.get('LED_BUILTIN');
  const esp32 = /^esp32/.test(family);
  const core3 = /^[3-9]\./.test(coreVersion);
  const rgbMatch = ledEntry && /SOC_GPIO_PIN_COUNT\s*\+\s*([A-Za-z_]\w*|\d+)/.exec(ledEntry.value);
  if (rgbMatch) {
    const gpio = literal(rgbMatch[1]) ?? resolve(defs, rgbMatch[1]).value;
    pins.LED_BUILTIN = `RGB LED${gpio !== null ? ` on GPIO${gpio}` : ''}`;
    if (gpio !== null) pins.RGB_LED_GPIO = gpio;
    if ('RGB_BUILTIN' in pins) pins.RGB_BUILTIN = pins.LED_BUILTIN;
    const colour = core3 ? 'rgbLedWrite(RGB_BUILTIN, r, g, b)' : 'neopixelWrite(RGB_BUILTIN, r, g, b)';
    notes.push(`LED_BUILTIN is an addressable RGB LED (WS2812/NeoPixel)${gpio !== null ? ` on GPIO${gpio}` : ''}, not a plain LED. To blink it, pinMode(LED_BUILTIN, OUTPUT) and digitalWrite(LED_BUILTIN, HIGH/LOW) are enough (white/off), through the core's built-in RGB driver; for colours use ${colour}${core3 ? '' : ' (renamed rgbLedWrite() in ESP32 core 3.x)'}. No library is needed. LED_BUILTIN and RGB_BUILTIN are codes for that driver, not GPIO numbers: a NeoPixel library (Adafruit_NeoPixel, FastLED) would need the real GPIO${gpio !== null ? `, ${gpio}` : ''}, and passing LED_BUILTIN to it drives the wrong pin.`);
  }
  // A name that stands for another key pin (BUILTIN_LED = LED_BUILTIN) shows that pin's value.
  for (const [name, value] of Object.entries(pins)) {
    if (typeof value === 'string' && value in pins && value !== name) pins[name] = pins[value];
  }
  if (!rgbMatch && typeof pins.PIN_NEOPIXEL === 'number') {
    const power = pins.NEOPIXEL_POWER ?? pins.PIN_NEOPIXEL_POWER;
    notes.push(`The board has an addressable RGB LED (NeoPixel) on pin ${pins.PIN_NEOPIXEL}: drive it with Adafruit_NeoPixel (or FastLED), 1 pixel${typeof power === 'number' ? `; its power is switched by pin ${power}, so set that pin OUTPUT and HIGH first` : ''}.`);
  }
  const ledOn = pins.LED_STATE_ON;
  if (ledOn === 0) notes.push('The built-in LED is active-LOW: digitalWrite(LED_BUILTIN, LOW) turns it ON.');
  if (!('LED_BUILTIN' in pins) && !('PIN_LED' in pins) && !('BUILTIN_LED' in pins)) {
    notes.push(esp32
      ? 'LED_BUILTIN is NOT defined for this board, so code using it does not compile. Define the pin yourself: many ESP32 DevKit V1 / DOIT boards have a blue LED on GPIO2 (const int LED_PIN = 2;); boards with only a power LED need an external LED with a resistor on a free GPIO.'
      : 'LED_BUILTIN is NOT defined for this board, so code using it does not compile: it has no user LED on a pin. Define a pin yourself and wire an LED (with a resistor) to it.');
  }

  return { pins, analog, digital, touch, notes };
}

/** The variant headers to read for a board, from its build properties. */
function variantHeaders(props) {
  const dir = props['build.variant.path'] || (props['runtime.platform.path'] && props['build.variant']
    ? path.join(props['runtime.platform.path'], 'variants', props['build.variant'])
    : null);
  if (!dir) return [];
  return ['pins_arduino.h', 'variant.h', 'variant_pins.h', 'pins.h']
    .map((f) => path.join(dir, f))
    .filter((f) => {
      try {
        return fs.statSync(f).isFile();
      } catch {
        return false;
      }
    });
}

module.exports = { readDefinitions, resolve, literal, pinFacts, variantHeaders, KEY_NAMES };
