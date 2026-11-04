// Pin-aware editor: finds every pin the sketch touches, checks it against
// classic Arduino mistakes and (when a circuit exists) the simulator wiring,
// and decorates the editor with hover info and gutter warnings.

import { boardById, parseBoardPin, pinLabel as boardPinLabel } from './simulation/boards.js';
const PIN_FUNCTIONS = /\b(pinMode|digitalWrite|digitalRead|analogRead|analogWrite|tone|noTone|pulseIn|pulseInLong|digitalPinToInterrupt)\s*\(\s*([A-Za-z_]\w*|\d+)/g;
const SERVO_ATTACH = /\.\s*attach\s*\(\s*([A-Za-z_]\w*|\d+)/g;
const SERIAL_BEGIN = /\bSerial\s*\.\s*begin\s*\(/;
const USES_I2C = /\bWire\s*\.\s*begin\s*\(|#\s*include\s*<(Wire|TinyWireM|LiquidCrystal_I2C|Adafruit_SSD1306|Tiny4kOLED)\.h>/;
const INT_TYPES = new Set(['int', 'byte', 'uint8_t', 'int8_t', 'uint16_t', 'int16_t', 'short', 'long', 'char', 'pin_size_t']);
const QUALIFIERS = new Set(['static', 'const', 'constexpr', 'unsigned', 'volatile']);

// Blank out comments and string/char literals, keeping offsets, so matches
// inside them are ignored.
export function maskCode(code) {
  const out = code.split('');
  let i = 0;
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      const end = code.indexOf('\n', i);
      const stop = end === -1 ? code.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end === -1 ? code.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== c && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
      blank(i, Math.min(j + 1, code.length));
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** `#define LED 13`, `const int BUTTON = 2;`, `byte pot = A0;` → name → raw value */
export function collectConstants(masked) {
  const constants = new Map();
  for (const m of masked.matchAll(/^[ \t]*#define[ \t]+([A-Za-z_]\w*)[ \t]+([A-Za-z_]\w*|\d+)[ \t]*$/gm)) {
    constants.set(m[1], m[2]);
  }
  // `const int LED = 13;` etc.: an assignment whose statement prefix is only
  // qualifiers and an integer type.
  for (const m of masked.matchAll(/\b([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*|\d+)\s*;/g)) {
    const start = Math.max(...[';', '{', '}', '\n'].map(ch => masked.lastIndexOf(ch, m.index))) + 1;
    const words = masked.slice(start, m.index).trim().split(/\s+/).filter(Boolean);
    const isDecl = words.length > 0 && INT_TYPES.has(words[words.length - 1])
      && words.slice(0, -1).every(w => QUALIFIERS.has(w));
    if (isDecl && !constants.has(m[1])) constants.set(m[1], m[2]);
  }
  return constants;
}

function resolvePin(token, constants, board, depth = 0) {
  const direct = parseBoardPin(board, token);
  if (direct !== null) return direct;
  if (depth > 3 || !constants.has(token)) return null;
  return resolvePin(constants.get(token), constants, board, depth + 1);
}

function positionAt(code, index) {
  const before = code.slice(0, index);
  const line = before.split('\n').length - 1;
  return { line, ch: index - before.lastIndexOf('\n') - 1 };
}

/**
 * @returns {{ pin: number, fn: string, mode: string|null, token: string, line: number, ch: number, length: number }[]}
 */
export function analyzePinUsage(code, boardId = 'uno') {
  const board = boardById(boardId);
  const masked = maskCode(String(code || ''));
  const constants = collectConstants(masked);
  const usages = [];

  for (const m of masked.matchAll(PIN_FUNCTIONS)) {
    const token = m[2];
    let pin = resolvePin(token, constants, board);
    if (pin === null) continue;
    // analogRead(0) means analog channel 0 (A0), not digital pin 0.
    if (m[1] === 'analogRead' && /^\d+$/.test(constants.get(token) ?? token)) {
      const channel = board.byAnalog.get(`A${pin}`);
      if (channel) pin = channel.pin;
    }
    const tokenIndex = m.index + m[0].length - token.length;
    let mode = null;
    if (m[1] === 'pinMode') {
      const rest = /^\s*,\s*(\w+)/.exec(masked.slice(m.index + m[0].length));
      mode = rest ? rest[1] : null;
    }
    usages.push({ pin, fn: m[1], mode, token, ...positionAt(masked, tokenIndex), length: token.length });
  }
  for (const m of masked.matchAll(SERVO_ATTACH)) {
    const token = m[1];
    const pin = resolvePin(token, constants, board);
    if (pin === null) continue;
    const tokenIndex = m.index + m[0].length - token.length;
    usages.push({ pin, fn: 'servo.attach', mode: null, token, ...positionAt(masked, tokenIndex), length: token.length });
  }
  return usages.sort((a, b) => a.line - b.line || a.ch - b.ch);
}

const WRITES = new Set(['digitalWrite', 'analogWrite', 'tone', 'noTone', 'servo.attach']);
const READS = new Set(['digitalRead', 'analogRead', 'pulseIn', 'pulseInLong', 'digitalPinToInterrupt']);

// Which side of the wire a part drives: 'input' parts feed the Arduino,
// 'output' parts are driven by it.
const PART_ROLES = {
  'wokwi-pushbutton': () => 'input',
  'wokwi-pushbutton-6mm': () => 'input',
  'wokwi-slide-switch': () => 'input',
  'wokwi-potentiometer': (pin) => (pin === 'SIG' ? 'input' : null),
  'wokwi-slide-potentiometer': (pin) => (pin === 'SIG' ? 'input' : null),
  'wokwi-pir-motion-sensor': (pin) => (pin === 'OUT' ? 'input' : null),
  'wokwi-photoresistor-sensor': (pin) => (pin === 'DO' || pin === 'AO' ? 'input' : null),
  'wokwi-ky-040': (pin) => (['CLK', 'DT', 'SW'].includes(pin) ? 'input' : null),
  'wokwi-analog-joystick': (pin) => (['VERT', 'HORZ', 'SEL'].includes(pin) ? 'input' : null),
  'wokwi-hc-sr04': (pin) => (pin === 'ECHO' ? 'input' : pin === 'TRIG' ? 'output' : null),
  'wokwi-led': (pin) => (pin === 'A' ? 'output' : null),
  'wokwi-rgb-led': (pin) => (['R', 'G', 'B'].includes(pin) ? 'output' : null),
  'wokwi-buzzer': (pin) => (pin === '2' ? 'output' : null),
  'wokwi-servo': (pin) => (pin === 'PWM' ? 'output' : null),
  'wokwi-led-bar-graph': (pin) => (/^A\d+$/.test(pin) ? 'output' : null),
  'wokwi-neopixel': (pin) => (pin === 'DIN' ? 'output' : null),
  'wokwi-led-ring': (pin) => (pin === 'DIN' ? 'output' : null),
  'wokwi-neopixel-matrix': (pin) => (pin === 'DIN' ? 'output' : null),
  'wokwi-7segment': (pin) => (/^([A-G]|DP|DIG\d)$/.test(pin) ? 'output' : null),
  'wokwi-7segment-4': (pin) => (/^([A-G]|DP|DIG\d)$/.test(pin) ? 'output' : null),
  'impulse-74hc595': (pin) => (['DS', 'SHCP', 'STCP'].includes(pin) ? 'output' : null),
  'impulse-relay-module': (pin) => (pin === 'IN' ? 'output' : null),
  'impulse-a4988': (pin) => (['STEP', 'DIR'].includes(pin) ? 'output' : null),
  'wokwi-ir-receiver': (pin) => (pin === 'DAT' ? 'input' : null),
  'wokwi-tilt-switch': (pin) => (pin === 'OUT' ? 'input' : null),
  'wokwi-ntc-temperature-sensor': (pin) => (pin === 'OUT' ? 'input' : null),
  'impulse-lm35': (pin) => (pin === 'VOUT' ? 'input' : null),
  'impulse-tm1637': (pin) => (['CLK', 'DIO'].includes(pin) ? 'output' : null),
  'impulse-stepper-28byj48': (pin) => (/^IN\d$/.test(pin) ? 'output' : null),
  'impulse-l298n': (pin) => (/^(IN\d|ENA|ENB)$/.test(pin) ? 'output' : null),
  'impulse-l293d': (pin) => (/^(IN\d|EN\d)$/.test(pin) ? 'output' : null),
  'impulse-mosfet': (pin) => (pin === 'G' ? 'output' : null),
  'impulse-npn-transistor': (pin) => (pin === 'B' ? 'output' : null),
  'impulse-flipflop-d': (pin) => (pin === 'Q' || pin === 'QN' ? 'input' : pin === 'D' || pin === 'CLK' ? 'output' : null),
};
const MODULE_OUTPUTS = /^(OUT|DO|AO|SIG|AOUT|DOUT)$/;

export function partRole(type, pin) {
  if (PART_ROLES[type]) return PART_ROLES[type](pin);
  // Logic gates: the Arduino drives the inputs and reads Y.
  if (/^impulse-gate-/.test(type)) return pin === 'Y' ? 'input' : 'output';
  // Sensor breakouts drive their output pins.
  if (/^impulse-.*(sensor|moisture|level|obstacle|analog|digital)/.test(type) && MODULE_OUTPUTS.test(pin)) return 'input';
  if (/^wokwi-(gas|flame|big-sound|small-sound|heart-beat)/.test(type) && MODULE_OUTPUTS.test(pin)) return 'input';
  return null;
}

/**
 * @param {ReturnType<typeof analyzePinUsage>} usages
 * @param {{ code: string, wiring?: { hasCircuit: boolean, pins: Record<number, {id: string, type: string, label: string, pin: string}[]> } }} ctx
 * @returns {{ line: number, severity: 'warning'|'info', message: string }[]}
 */
export function diagnosePins(usages, { code, wiring } = {}) {
  const board = boardById(wiring?.board || 'uno');
  const pinLabel = (pin) => boardPinLabel(board, pin);
  const issues = [];
  const byPin = new Map();
  for (const u of usages) {
    if (!byPin.has(u.pin)) byPin.set(u.pin, []);
    byPin.get(u.pin).push(u);
  }
  const usesSerial = SERIAL_BEGIN.test(maskCode(String(code || '')));

  for (const [pin, uses] of byPin) {
    const label = pinLabel(pin);
    const modes = uses.filter(u => u.fn === 'pinMode').map(u => u.mode);
    const firstWrite = uses.find(u => u.fn === 'digitalWrite');
    if (firstWrite && !modes.includes('OUTPUT')) {
      issues.push({ line: firstWrite.line, severity: 'warning',
        message: `${label} is written with digitalWrite but never set to OUTPUT, so it only toggles the weak pull-up (an LED will glow dimly). Add pinMode(${firstWrite.token}, OUTPUT) in setup().` });
    }
    const pwm = uses.find(u => u.fn === 'analogWrite');
    if (pwm && !board.pwmSet.has(pin)) {
      const list = `${board.pwm.slice(0, -1).join(', ')} and ${board.pwm[board.pwm.length - 1]}`;
      issues.push({ line: pwm.line, severity: 'warning',
        message: `${label} has no PWM on an ${board.label}, so analogWrite only switches it fully on or off. PWM pins are ${list}.` });
    }
    // Serial's own pins (none on the Pico, where Serial is the USB port).
    const uart = board.serial[0];
    if (usesSerial && uart && (pin === uart.rx || pin === uart.tx)) {
      issues.push({ line: uses[0].line, severity: 'warning',
        message: `${label} is the Serial ${pin === uart.rx ? 'RX' : 'TX'} line, which Serial.begin() already uses. Pick another pin.` });
    }

    if (!wiring?.hasCircuit) continue;
    const parts = wiring.pins[pin] || [];
    const roles = new Set(parts.map(p => partRole(p.type, p.pin)).filter(Boolean));
    if (parts.length === 0 && pin !== board.ledBuiltin) {
      issues.push({ line: uses[0].line, severity: 'info', message: `Nothing is wired to ${label} in the circuit.` });
      continue;
    }
    const writes = uses.find(u => WRITES.has(u.fn) || (u.fn === 'pinMode' && u.mode === 'OUTPUT'));
    if (writes && roles.has('input') && !roles.has('output')) {
      const names = parts.filter(p => partRole(p.type, p.pin) === 'input').map(p => p.label).join(', ');
      issues.push({ line: writes.line, severity: 'warning',
        message: `${label} drives ${names}, which is an input part. Use pinMode(${writes.token}, INPUT_PULLUP) or INPUT and read it instead.` });
    }
    const reads = uses.find(u => READS.has(u.fn) || (u.fn === 'pinMode' && /^INPUT/.test(u.mode || '')));
    if (reads && roles.has('output') && !roles.has('input')) {
      const names = parts.filter(p => partRole(p.type, p.pin) === 'output').map(p => p.label).join(', ');
      issues.push({ line: reads.line, severity: 'warning',
        message: `${label} reads ${names}, which the Arduino should drive. Set it to OUTPUT and write to it.` });
    }
  }
  // A software Serial on the I²C data pin (the ATtiny85's PB0).
  const masked = maskCode(String(code || ''));
  const soft = board.softSerial;
  if (soft && usesSerial && soft.tx === board.i2c.sda && USES_I2C.test(masked)) {
    const line = masked.slice(0, masked.search(SERIAL_BEGIN)).split('\n').length;
    issues.push({ line, severity: 'warning',
      message: `On the ${board.label}, Serial sends on ${pinLabel(soft.tx)}, which is also I²C SDA, so Serial and Wire garble each other. Use one of them: show output on an I²C display, or leave I²C out.` });
  }
  return issues.sort((a, b) => a.line - b.line);
}

/** Hover text for a pin reference. */
export function describePin(pin, wiring) {
  const board = boardById(wiring?.board || 'uno');
  const label = boardPinLabel(board, pin);
  const extras = [];
  const entry = board.byPin.get(pin);
  if (board.pwmSet.has(pin)) extras.push('PWM');
  if (entry?.analog) extras.push(`analog in ${entry.adc}`);
  if (pin === board.ledBuiltin) extras.push('built-in LED');
  if (pin === board.i2c.sda) extras.push('I²C SDA');
  if (pin === board.i2c.scl) extras.push('I²C SCL');
  board.serial.forEach((s, i) => {
    if (!s) return;
    if (pin === s.rx) extras.push(`Serial${i || ''} RX`);
    if (pin === s.tx) extras.push(`Serial${i || ''} TX`);
  });
  const head = extras.length ? `${label} (${extras.join(', ')})` : label;
  if (!wiring?.hasCircuit) return head;
  const parts = wiring.pins[pin] || [];
  if (!parts.length) return `${head}: not wired in the circuit`;
  return `${head} → ${parts.map(p => `${p.label} ${p.pin}`).join(', ')}`;
}

/**
 * Decorate a CodeMirror 5 editor. Returns a function that re-runs analysis.
 * @param {import('codemirror').Editor} editor
 * @param {{ getWiring: () => object|null, onIssues?: (issues: object[]) => void }} opts
 */
export function attachPinInsights(editor, { getWiring, onIssues }) {
  const GUTTER = 'pin-gutter';
  const gutters = editor.getOption('gutters') || [];
  if (!gutters.includes(GUTTER)) editor.setOption('gutters', [...gutters, GUTTER]);

  let marks = [];
  let timer = null;

  const refresh = () => {
    timer = null;
    const code = editor.getValue();
    let wiring = null;
    try { wiring = getWiring(); } catch { wiring = null; }
    const usages = analyzePinUsage(code, wiring?.board || 'uno');
    const issues = diagnosePins(usages, { code, wiring });

    editor.operation(() => {
      marks.forEach(m => m.clear());
      marks = usages.map(u => editor.markText(
        { line: u.line, ch: u.ch },
        { line: u.line, ch: u.ch + u.length },
        { className: 'cm-pin-ref', attributes: { 'data-tooltip': describePin(u.pin, wiring) } }
      ));
      editor.clearGutter(GUTTER);
      const byLine = new Map();
      for (const issue of issues) {
        if (!byLine.has(issue.line)) byLine.set(issue.line, []);
        byLine.get(issue.line).push(issue);
      }
      for (const [line, lineIssues] of byLine) {
        const marker = document.createElement('span');
        const severe = lineIssues.some(i => i.severity === 'warning');
        marker.className = `pin-gutter-marker ${severe ? 'warning' : 'info'}`;
        marker.textContent = severe ? '!' : 'i';
        marker.setAttribute('data-tooltip', lineIssues.map(i => i.message).join('\n'));
        editor.setGutterMarker(line, GUTTER, marker);
      }
    });
    onIssues?.(issues);
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, 300);
  };
  editor.on('change', schedule);
  editor.on('swapDoc', schedule);
  window.addEventListener('impulse:circuit-changed', schedule);
  schedule();
  return refresh;
}
