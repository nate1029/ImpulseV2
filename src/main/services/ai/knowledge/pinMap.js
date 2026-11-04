/**
 * Which pin numbers a chip actually has, and which of them cannot be used the
 * way a sketch is using them. The installed core names a board's pins
 * (LED_BUILTIN, SDA, A0…), but it does not say that an ESP32-C3 has no GPIO 22
 * or that GPIO 34 on an ESP32 can never be an output. This table does, so a
 * sketch can be checked instead of trusted.
 *
 * Every entry is per chip family (the ids of mcuGuide.js). Ranges are
 * inclusive pairs. `scripts/knowledge-audit.mjs` compares this against the
 * pins the installed cores define, so a wrong range shows up as a conflict.
 * @module main/services/ai/knowledge/pinMap
 */

/** Platforms that number pins per board, not by GPIO (the Nano ESP32's
 * "Pin Numbering" option): there the core's own names are the only truth. */
const BOARD_NUMBERED = new Set(['arduino:esp32']);

/** @typedef {{ gpio: [number, number][], inputOnly?: [number, number][], flash?: [number, number][],
 *   strapping?: number[], usb?: number[], noPwm?: number[], adc?: [number, number][], chip: string }} PinMap */

/** @type {Record<string, PinMap>} */
const PIN_MAPS = {
  'avr-atmega328p': {
    chip: 'ATmega328P',
    // 0–13 digital, 14–19 are A0–A5 used as digital; the Nano, Pro Mini and
    // LilyPad add A6 = 20 and A7 = 21, which are analog inputs only.
    gpio: [[0, 21]],
    adc: [[14, 21]],
    noPwm: [0, 1, 2, 4, 7, 8, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
  },
  'avr-atmega2560': {
    chip: 'ATmega2560',
    gpio: [[0, 69]], // 54–69 are A0–A15
    adc: [[54, 69]],
  },
  'avr-atmega32u4': {
    chip: 'ATmega32U4',
    gpio: [[0, 30]], // 18–23 are A0–A5; A6–A11 sit on 4, 6, 8, 9, 10, 12
    adc: [[18, 23]],
  },
  'megaavr-atmega4809': {
    chip: 'ATmega4809',
    gpio: [[0, 21]],
    adc: [[14, 21]],
  },
  'attiny-x5': {
    chip: 'ATtiny85',
    gpio: [[0, 5]], // PB0–PB5; PB5 is RESET unless the fuse is changed
    adc: [[2, 5]],
  },
  'samd21': {
    chip: 'SAMD21',
    gpio: [[0, 21]],
    adc: [[14, 21]],
  },
  'samd51': {
    chip: 'SAMD51',
    gpio: [[0, 25]],
  },
  'renesas-ra4m1': {
    chip: 'RA4M1 (Uno R4)',
    gpio: [[0, 21]], // 14–19 are A0–A5
    adc: [[14, 19]],
  },
  'nrf52840': {
    chip: 'nRF52840',
    gpio: [[0, 21]], // the Arduino numbering of the Nano 33 BLE / XIAO
    adc: [[14, 21]],
  },
  'rp2040': {
    chip: 'RP2040',
    gpio: [[0, 29]],
    adc: [[26, 28]],
  },
  'rp2350': {
    chip: 'RP2350',
    gpio: [[0, 29]],
    adc: [[26, 28]],
  },
  'esp32': {
    chip: 'ESP32',
    // 20, 24, 28–31 are not bonded out on the WROOM/WROVER modules.
    gpio: [[0, 19], [21, 23], [25, 27], [32, 39]],
    inputOnly: [[34, 39]],
    flash: [[6, 11]],
    strapping: [0, 2, 5, 12, 15],
    adc: [[32, 39], [0, 0], [2, 2], [4, 4], [12, 15], [25, 27]],
  },
  'esp32-s2': {
    chip: 'ESP32-S2',
    gpio: [[0, 21], [26, 46]],
    inputOnly: [[46, 46]],
    flash: [[27, 32]],
    strapping: [0, 45, 46],
    usb: [19, 20],
    adc: [[1, 20]],
  },
  'esp32-s3': {
    chip: 'ESP32-S3',
    // 22–25 do not exist; 26–32 are the flash, 33–37 the octal PSRAM on N8R8/N16R8 modules.
    gpio: [[0, 21], [26, 48]],
    flash: [[26, 32]],
    strapping: [0, 3, 45, 46],
    usb: [19, 20],
    adc: [[1, 20]],
  },
  'esp32-c3': {
    chip: 'ESP32-C3',
    gpio: [[0, 21]],
    flash: [[11, 17]],
    strapping: [2, 8, 9],
    usb: [18, 19],
    adc: [[0, 5]],
  },
  'esp32-c6': {
    chip: 'ESP32-C6',
    gpio: [[0, 30]],
    flash: [[24, 30]],
    strapping: [4, 5, 8, 9, 15],
    usb: [12, 13],
    adc: [[0, 6]],
  },
  'esp32-h2': {
    chip: 'ESP32-H2',
    gpio: [[0, 27]],
    flash: [[15, 21]],
    strapping: [2, 3, 8, 9, 25],
    usb: [26, 27],
    adc: [[1, 5]],
  },
  'esp8266': {
    chip: 'ESP8266',
    gpio: [[0, 16]],
    flash: [[6, 11]],
    strapping: [0, 2, 15],
    noPwm: [16],
    adc: [[17, 17]], // A0 is pin 17 in the core's numbering
  },
  'teensy4': {
    chip: 'i.MX RT1062 (Teensy 4.x)',
    gpio: [[0, 41]], // Teensy 4.0 ends at 23 on the headers; 4.1 goes to 41
    adc: [[14, 27]],
  },
};

/** Alias a few ids so a family that shares a map resolves. */
const ALIASES = { 'attiny-modern': null, stm32: null, 'stm32h7-mbed': null, 'esp32-p4': null, 'uno-q': null, general: null };

const inRanges = (pin, ranges) => (ranges || []).some(([lo, hi]) => pin >= lo && pin <= hi);

/** The map for a chip family id, or null when this family is not numbered by GPIO (STM32 uses PA0…). */
function mapFor(familyId) {
  if (!familyId) return null;
  if (familyId in ALIASES) return ALIASES[familyId] ? PIN_MAPS[ALIASES[familyId]] : null;
  return PIN_MAPS[familyId] || null;
}

/** "GPIO 0–19, 21–23, 25–27 and 32–39" for a message. */
function describeRanges(ranges) {
  const parts = (ranges || []).map(([lo, hi]) => (lo === hi ? `${lo}` : `${lo}–${hi}`));
  if (parts.length <= 1) return parts[0] || '';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/**
 * What is wrong with using `pin` on this chip, or null when nothing is.
 * @param {number} pin
 * @param {string} familyId
 * @param {{ output?: boolean, analogWrite?: boolean, analogRead?: boolean, knownPins?: Set<number> }} [use]
 * @returns {{ level: 'error'|'warning', reason: string, fix?: string } | null}
 */
function checkPin(pin, familyId, use = {}) {
  const map = mapFor(familyId);
  if (!map || !Number.isInteger(pin) || pin < 0) return null;
  if (!inRanges(pin, map.gpio)) {
    return {
      level: 'error',
      reason: `the ${map.chip} has no pin ${pin}`,
      fix: `Its pins are ${describeRanges(map.gpio)}. Pick one of those.`,
    };
  }
  if (inRanges(pin, map.flash)) {
    return {
      level: 'error',
      reason: `pin ${pin} is wired to the flash chip on the ${map.chip}`,
      fix: `Pins ${describeRanges(map.flash)} are the flash: using one stops the board from running. Pick another pin.`,
    };
  }
  if (use.output && inRanges(pin, map.inputOnly)) {
    return {
      level: 'error',
      reason: `pin ${pin} on the ${map.chip} is input-only`,
      fix: `Pins ${describeRanges(map.inputOnly)} can read but never drive a pin, and have no pull-ups. Use a lower pin for an output.`,
    };
  }
  if (use.analogWrite && (map.noPwm || []).includes(pin)) {
    return { level: 'error', reason: `pin ${pin} has no PWM on the ${map.chip}`, fix: 'analogWrite does nothing here; use a PWM-capable pin.' };
  }
  if (use.analogRead && map.adc && !inRanges(pin, map.adc)) {
    return { level: 'warning', reason: `pin ${pin} is not an analog input on the ${map.chip}`, fix: `analogRead works on ${describeRanges(map.adc)}.` };
  }
  if ((map.usb || []).includes(pin)) {
    return { level: 'warning', reason: `pin ${pin} is the ${map.chip}'s USB`, fix: 'Using it breaks the USB serial port on boards that use native USB.' };
  }
  if ((map.strapping || []).includes(pin)) {
    return {
      level: 'warning',
      reason: `pin ${pin} is a strapping pin on the ${map.chip}`,
      fix: 'It decides the boot mode: what you wire to it must not hold it at reset. Prefer another pin, or keep it floating at boot.',
    };
  }
  return null;
}

/** Every pin number this family has, for a message or a picker. */
function pinsOf(familyId) {
  const map = mapFor(familyId);
  if (!map) return [];
  const out = [];
  for (const [lo, hi] of map.gpio) for (let p = lo; p <= hi; p++) out.push(p);
  return out;
}

module.exports = { PIN_MAPS, BOARD_NUMBERED, mapFor, checkPin, pinsOf, describeRanges, inRanges };
