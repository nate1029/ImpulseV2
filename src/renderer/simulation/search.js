// Part search: ranks catalog parts for a query using labels, keywords,
// categories and descriptions, with typo tolerance and a fallback that
// always offers something useful.

import { PARTS, CATEGORY_ORDER } from './parts/catalog.js';

const SYNONYMS = {
  temp: 'temperature', thermometer: 'temperature', heat: 'temperature',
  dist: 'distance', range: 'distance', sonar: 'ultrasonic',
  screen: 'display', monitor: 'display',
  strip: 'neopixel', ws2811: 'neopixel', ws2812b: 'ws2812', rgbw: 'neopixel',
  brightness: 'light', photo: 'photoresistor',
  speaker: 'buzzer', piezo: 'buzzer',
  pot: 'potentiometer', knob: 'potentiometer', trimpot: 'potentiometer',
  btn: 'button', tactile: 'button',
  mic: 'microphone', move: 'motion',
  engine: 'motor', fan: 'motor',
  '7seg': 'segment',
  imu: 'mpu6050', gyro: 'gyroscope', accel: 'accelerometer',
  loadcell: 'hx711',
  bb: 'breadboard', protoboard: 'breadboard',
  batt: 'battery', thermistor: 'ntc', microswitch: 'limit',
  ic: 'chip',
};

export function normalize(s) {
  return String(s || '').toLowerCase().replace(/[‐-―]/g, '-').replace(/[^a-z0-9.+#\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(q) {
  return normalize(q).split(' ').filter(Boolean).map(t => SYNONYMS[t] || t);
}

function words(s) {
  return normalize(s).split(/[ \-/.]+/).filter(Boolean);
}

/** Levenshtein distance capped at 2 (cheap typo tolerance). */
function near(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function index(part) {
  if (part._search) return part._search;
  const label = normalize(part.label);
  const kw = (part.keywords || []).map(normalize);
  part._search = {
    label,
    labelWords: words(part.label),
    type: normalize(part.type.replace(/^(wokwi|impulse)-/, '')),
    keywords: kw,
    keywordWords: kw.flatMap(k => words(k)),
    category: normalize(part.category),
    description: normalize(part.description),
  };
  return part._search;
}

function scoreToken(ix, t) {
  let s = 0;
  if (ix.labelWords.includes(t)) s = Math.max(s, 12);
  else if (ix.labelWords.some(w => w.startsWith(t))) s = Math.max(s, 9);
  else if (ix.label.includes(t)) s = Math.max(s, 6);
  if (ix.keywords.includes(t)) s = Math.max(s, 10);
  else if (ix.keywordWords.includes(t)) s = Math.max(s, 8);
  else if (ix.keywords.some(k => k.startsWith(t))) s = Math.max(s, 7);
  else if (t.length >= 3 && ix.keywords.some(k => k.includes(t))) s = Math.max(s, 4);
  if (ix.type.includes(t)) s = Math.max(s, 5);
  if (ix.category.split(' ').some(w => w.startsWith(t))) s = Math.max(s, 3);
  if (!s && t.length >= 4 && ix.description.includes(t)) s = 1.5;
  if (!s && t.length >= 4 && [...ix.labelWords, ...ix.keywordWords].some(w => near(w, t))) s = 3;
  return s;
}

/**
 * @param {string} query
 * @param {object[]} [parts]
 * @returns {{ part: object, score: number }[]} best first; empty query returns everything in catalog order
 */
export function searchParts(query, parts = Object.values(PARTS)) {
  const ts = tokens(query);
  const order = (p) => CATEGORY_ORDER.indexOf(p.category);
  if (!ts.length) return parts.map(part => ({ part, score: 0 })).sort((a, b) => order(a.part) - order(b.part));
  const phrase = normalize(query);
  const out = [];
  for (const part of parts) {
    const ix = index(part);
    let total = 0;
    let all = true;
    for (const t of ts) {
      const s = scoreToken(ix, t);
      if (!s) { all = false; break; }
      total += s;
    }
    if (!all) continue;
    if (ix.label.startsWith(phrase)) total += 8;
    else if (ix.label.includes(phrase)) total += 4;
    if (ix.keywords.includes(phrase)) total += 6;
    out.push({ part, score: total });
  }
  out.sort((a, b) => b.score - a.score || order(a.part) - order(b.part) || a.part.label.localeCompare(b.part.label));
  // Parts that only matched on their description or category are noise next
  // to a real name or keyword match; keep them only when nothing better exists.
  const strong = out.filter(r => ts.some(t => scoreToken(index(r.part), t) >= 4));
  if (strong.length) return strong;
  return adviceFor(query) ? [] : out;
}

// Things people look for that the simulator can't run, with a way forward.
const ADVICE = [
  {
    match: /\b(esp ?32-?(c2|c5|c6|c61|h2|p4)|esp ?8266|esp-?01|nodemcu|wemos|d1 mini|pico ?w|pico ?2|rp2350|raspberry ?pi ?([2-5]|zero|4b)|stm32|blue ?pill|teensy|due|zero|mkr|r4|minima|giga|portenta|nano ?(33|every|rp2040)|attiny(?!85)\d+|digispark)\b/,
    title: 'This board isn’t simulated',
    text: 'The simulator runs the Arduino Uno, Nano, Mega 2560 and Leonardo (and the Micro and other ATmega32U4 boards), the Raspberry Pi Pico, the ATtiny85, and ESP32, ESP32-S2, ESP32-S3, ESP32-C3 and Nano ESP32 boards. You can still write, compile and upload code for other boards — or try your logic on one of these first (an ESP32 for Wi-Fi boards like the ESP8266, a Pico for 3.3 V and ARM projects, the ATtiny85 for other ATtinys and the Digispark).',
    parts: ['wokwi-arduino-uno', 'wokwi-arduino-nano', 'wokwi-arduino-mega', 'impulse-pi-pico', 'impulse-attiny85', 'wokwi-esp32-devkit-v1', 'impulse-esp32-s3-devkitc'],
  },
  {
    match: /\b(bluetooth|hc-?0[56]|hm-?10|ble)\b/,
    title: 'Bluetooth modules are serial bridges',
    text: 'HC-05/HC-06 just pass text to the board’s serial port. Type what the phone would send into the simulator’s Serial monitor to test your sketch.',
  },
  {
    match: /\b(gps|neo-?6m|nmea|gnss)\b/,
    title: 'GPS modules send text over serial',
    text: 'Paste NMEA sentences (like $GPGGA,…) into the Serial monitor to test your parsing code.',
  },
  {
    match: /\b(wifi|wi-fi|wlan|internet|iot|mqtt|http)\b/,
    title: 'Wi-Fi isn’t simulated',
    text: 'The simulated boards have no radio. On ESP32 boards, WiFi.begin() joins a pretend network and gets an IP address, so the rest of the sketch runs, but requests to the internet get no answer. Test the sensor and output side of your project here, and print what you would send over Serial.',
  },
  {
    match: /\b(sd|micro ?sd|sd ?card|sdcard)\b/,
    title: 'SD cards aren’t simulated yet',
    text: 'For small amounts of data use the EEPROM library — the simulator keeps EEPROM contents between runs.',
  },
  {
    match: /\b(rfid|rc522|mfrc522|pn532|nfc)\b/,
    title: 'RFID readers aren’t simulated yet',
    text: 'Use a pushbutton as “card detected” to test what your sketch does after a scan.',
    parts: ['wokwi-pushbutton'],
  },
  {
    match: /\b(acs712|current sensor|voltage sensor|co2|mq-?135|dust|uv|uvm|pressure|bmp\d*|bme\d*|ms5611|compass|hmc5883|color sensor|tcs\d+|gsr|flex|force|fsr|ph sensor|turbidity)\b/,
    title: 'Use the generic analog sensor',
    text: 'Most sensors like this give a voltage that analogRead() measures. The generic analog sensor has a slider for that voltage, so your code sees realistic readings.',
    parts: ['impulse-generic-analog', 'impulse-generic-digital'],
  },
  {
    match: /\b(regulator|7805|lm7805|ams1117|lm317|buck|boost|step ?down|step ?up|ldo)\b/,
    title: 'No regulator needed here',
    text: 'The board’s 5V and 3.3V pins give clean supplies, and the Battery part covers 3–12 V packs. Wire a battery’s − to GND to share a ground.',
    parts: ['impulse-battery'],
  },
  {
    match: /\b(optocoupler|opto|pc817|4n35|ssr|solid state relay)\b/,
    title: 'Switch it like a relay',
    text: 'An optocoupler or solid-state relay turns a load on from a pin, just like a relay module or a transistor does in the simulator.',
    parts: ['impulse-relay-module', 'impulse-mosfet', 'impulse-npn-transistor'],
  },
  {
    match: /\b(74hc165|165|cd4051|4051|multiplexer|mux|demux|74hc138|cd4017|4017|555|ne555|mcp23017)\b/,
    title: 'This chip isn’t simulated yet',
    text: 'For more outputs use the 74HC595; logic gates and flip-flops are here too. Timing and counting are easiest in your sketch with millis().',
    parts: ['impulse-74hc595', 'impulse-gate-and', 'impulse-flipflop-d'],
  },
  {
    match: /\b(nokia|5110|pcd8544|e-?paper|e-?ink|touch ?screen|st7735|st7789|1\.8)\b/,
    title: 'Try a display the simulator has',
    text: 'The SSD1306 OLED (I²C or SPI) and the ILI9341 TFT are simulated with their usual libraries.',
    parts: ['wokwi-ssd1306', 'wokwi-ili9341'],
  },
];

/** Advice for a query that names something the simulator can't run, or null. */
export function adviceFor(query) {
  const q = normalize(query);
  const hit = ADVICE.find(a => a.match.test(q));
  if (!hit) return null;
  return { title: hit.title, text: hit.text, parts: (hit.parts || []).map(t => PARTS[t]).filter(Boolean) };
}

/**
 * When nothing matches every word: parts matching any word, plus the generic
 * stand-ins so the user can always keep building.
 */
export function suggestParts(query, parts = Object.values(PARTS)) {
  const ts = tokens(query);
  const partial = [];
  for (const part of parts) {
    const ix = index(part);
    const s = ts.reduce((a, t) => a + scoreToken(ix, t), 0);
    if (s > 0) partial.push({ part, score: s });
  }
  partial.sort((a, b) => b.score - a.score);
  const generic = ['impulse-generic-digital', 'impulse-generic-analog'].map(t => PARTS[t]).filter(Boolean);
  const advice = adviceFor(query);
  const seen = new Set([...partial.slice(0, 6).map(r => r.part.type), ...(advice?.parts || []).map(p => p.type)]);
  return {
    similar: partial.slice(0, 6).map(r => r.part).filter(p => !advice?.parts.includes(p)),
    generic: generic.filter(g => !seen.has(g.type)),
    advice,
  };
}
