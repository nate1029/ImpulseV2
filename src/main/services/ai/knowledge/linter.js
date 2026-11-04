/**
 * Hardware linter (knowledge strategy §4.2): reads a sketch the way an
 * embedded engineer would, before or after it compiles, and flags what
 * compiles but fails on the bench (ADC2 with Wi-Fi on, a delay() inside an
 * interrupt, prints lost on a native-USB board) and what will not compile on
 * this board and core (core 2 LEDC on core 3). Each finding has a level, the
 * line, what is wrong, the fix and, where the fix is mechanical, a rewrite.
 *
 * Context comes from the board facts: the FQBN, the installed core version
 * and whether LED_BUILTIN exists. Pins a board lacks are pinCheck's job.
 *
 * proofLevel says how each rule is known (knowledge/proof.js): 3 when the
 * error decoder proved the same API fact on a real compiler, 5 when it was
 * seen on a real board, 2 when it comes from the installed core, 0 when
 * nothing has checked it yet (documented behaviour, not yet tested by Impulse).
 * @module main/services/ai/knowledge/linter
 */

const { ledcToCore3, ledcToCore2, timerToCore3, timerToCore2, espNowRecvToCore3, espNowRecvToCore2 } = require('./errorDecoder');

const platformOf = (fqbn) => String(fqbn || '').split(':').slice(0, 2).join(':');
const boardOf = (fqbn) => String(fqbn || '').split(':')[2] || '';
const majorOf = (v) => Number(String(v || '').split('.')[0]) || null;
const minorOf = (v) => Number(String(v || '').split('.')[1]) || 0;

/**
 * Comments and string contents blanked out with spaces, lengths and line
 * breaks kept (so positions and line numbers stay right). A scanner, so a
 * "//" inside a URL string or a quote inside a comment is read correctly.
 */
function stripCode(code) {
  const s = String(code || '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (c === '/' && n === '/') {
      while (i < s.length && s[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && n === '*') {
      out += '  ';
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) { out += s[i] === '\n' ? '\n' : ' '; i++; }
      if (i < s.length) { out += '  '; i += 2; }
    } else if (c === '"' || c === "'") {
      out += c;
      i++;
      while (i < s.length && s[i] !== c && s[i] !== '\n') {
        if (s[i] === '\\' && i + 1 < s.length && s[i + 1] !== '\n') { out += '  '; i += 2; } else { out += ' '; i++; }
      }
      if (s[i] === c) { out += c; i++; }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/** The body of a function by name (from the stripped text), with where it starts. */
function functionBody(stripped, name) {
  const re = new RegExp(`\\b(?:void|int|bool)\\s+(?:IRAM_ATTR\\s+|ARDUINO_ISR_ATTR\\s+)?${name}\\s*\\([^)]*\\)\\s*\\{`);
  const m = re.exec(stripped);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < stripped.length && depth > 0) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') depth--;
    i++;
  }
  return { body: stripped.slice(start, i - 1), index: m.index, header: m[0] };
}

/** Functions used as interrupt handlers (attachInterrupt, timers). */
function isrNames(stripped) {
  const names = new Set();
  for (const m of stripped.matchAll(/attachInterrupt\s*\([^,]+,\s*&?\s*(\w+)\s*,/g)) names.add(m[1]);
  for (const m of stripped.matchAll(/timerAttachInterrupt\s*\(\s*\w+\s*,\s*&?\s*(\w+)\s*[,)]/g)) names.add(m[1]);
  return [...names];
}

function family(ctx) {
  const p = platformOf(ctx.fqbn);
  const b = boardOf(ctx.fqbn).toLowerCase();
  if (/^arduino:avr$/.test(p) && /leonardo|micro|esplora|yun|lilypadusb|robot/.test(b)) return 'avr-usb';
  if (/:avr$/.test(p) || p === 'arduino:megaavr') return 'avr';
  if (p === 'arduino:esp32') return 'nano-esp32';
  if (/:esp32$/.test(p)) {
    if (/c3/.test(b)) return 'esp32c3';
    if (/s3|nano_nora/.test(b)) return 'esp32s3';
    if (/s2/.test(b)) return 'esp32s2';
    if (/c6/.test(b)) return 'esp32c6';
    return 'esp32';
  }
  if (/rp2040/.test(p)) return 'rp2040';
  if (/samd|renesas/.test(p)) return 'native-usb';
  return 'other';
}

/** Boards whose Serial is the chip's own USB: what is printed before the monitor connects is lost. */
function nativeUsb(ctx) {
  const f = family(ctx);
  if (['avr-usb', 'nano-esp32', 'rp2040', 'native-usb'].includes(f)) return true;
  return /CDCOnBoot=cdc/i.test(String(ctx.fqbn || '')) || ctx.cdcOnBoot === true;
}

const isEsp32 = (ctx) => /:esp32$/.test(platformOf(ctx.fqbn));
const isAvr = (ctx) => family(ctx) === 'avr' || family(ctx) === 'avr-usb';
// The ESP32's own core 3 vs 2: Arduino's Nano ESP32 core is 2.0.x.
const espMajor = (ctx) => (isEsp32(ctx) ? majorOf(ctx.coreVersion) : null);

/**
 * The rules. test(stripped, code, ctx) returns null, or one or more
 * { index, message, fix } where index is a position in the text.
 */
const RULES = [
  {
    id: 'esp32-ledc-core2-api', level: 'error', proofLevel: 3, compileError: true,
    when: (ctx) => espMajor(ctx) >= 3,
    test: (s) => { const m = /\bledc(?:Setup|AttachPin)\s*\(/.exec(s); return m && { index: m.index }; },
    message: 'ledcSetup/ledcAttachPin are the core 2 LEDC API; this ESP32 core is 3.x, where they no longer exist.',
    fix: 'ledcAttach(pin, freq, bits), then ledcWrite(pin, duty).',
    rewrite: ledcToCore3,
  },
  {
    id: 'esp32-ledc-core3-api', level: 'error', proofLevel: 3, compileError: true,
    when: (ctx) => espMajor(ctx) === 2,
    test: (s) => { const m = /\bledcAttach\s*\(/.exec(s); return m && { index: m.index }; },
    message: 'ledcAttach is the core 3 LEDC API; this board\'s core is 2.x (Arduino\'s Nano ESP32 core is 2.0.x).',
    fix: 'ledcSetup(channel, freq, bits); ledcAttachPin(pin, channel); ledcWrite(channel, duty).',
    rewrite: ledcToCore2,
  },
  {
    id: 'esp32-timer-core2-api', level: 'error', proofLevel: 3, compileError: true,
    when: (ctx) => espMajor(ctx) >= 3,
    test: (s) => { const m = /\btimerBegin\s*\(\s*[^,()]+,\s*[^,()]+,|\btimerAlarm(?:Write|Enable)\s*\(/.exec(s); return m && { index: m.index }; },
    message: 'This is the core 2 timer API; on this ESP32 core (3.x) timerBegin takes a frequency and the alarm calls became timerAlarm.',
    fix: 'hw_timer_t *t = timerBegin(1000000); timerAttachInterrupt(t, &onTimer); timerAlarm(t, 500000, true, 0);',
    rewrite: timerToCore3,
  },
  {
    id: 'esp32-timer-core3-api', level: 'error', proofLevel: 3, compileError: true,
    when: (ctx) => espMajor(ctx) === 2,
    test: (s) => { const m = /\btimerBegin\s*\(\s*[^,()]+\s*\)|\btimerAlarm\s*\(/.exec(s); return m && { index: m.index }; },
    message: 'This is the core 3 timer API; this board\'s core is 2.x.',
    fix: 'hw_timer_t *t = timerBegin(0, 80, true); timerAttachInterrupt(t, &onTimer, true); timerAlarmWrite(t, 500000, true); timerAlarmEnable(t);',
    rewrite: timerToCore2,
  },
  {
    id: 'esp32-espnow-core2-callback', level: 'error', proofLevel: 3, compileError: true,
    when: (ctx) => espMajor(ctx) >= 3,
    test: (s) => {
      const m = /void\s+(\w+)\s*\(\s*const\s+uint8_t\s*\*\s*\w+\s*,\s*const\s+uint8_t\s*\*\s*\w+\s*,\s*int\s+\w+\s*\)/.exec(s);
      return m && new RegExp(`esp_now_register_recv_cb\\s*\\(\\s*&?\\s*${m[1]}\\b`).test(s) ? { index: m.index } : null;
    },
    message: 'This ESP-NOW receive callback has the core 2 signature; core 3 passes a const esp_now_recv_info_t * first.',
    fix: 'void onRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) { const uint8_t *mac = info->src_addr; … }',
    rewrite: espNowRecvToCore3,
  },
  {
    id: 'esp32-espnow-core3-callback', level: 'error', proofLevel: 3, compileError: true,
    when: (ctx) => espMajor(ctx) === 2,
    test: (s) => { const m = /\besp_now_recv_info_t\b/.exec(s); return m && { index: m.index }; },
    message: 'esp_now_recv_info_t is core 3; on this core (2.x) the receive callback gets the sender\'s MAC address.',
    fix: 'void onRecv(const uint8_t *mac, const uint8_t *data, int len) { … }',
    rewrite: espNowRecvToCore2,
  },
  {
    id: 'esp32-espnow-send-callback', level: 'error', proofLevel: 3, compileError: true,
    when: (ctx) => espMajor(ctx) >= 3 && (espMajor(ctx) > 3 || minorOf(ctx.coreVersion) >= 2),
    test: (s) => { const m = /void\s+\w+\s*\(\s*const\s+uint8_t\s*\*\s*\w+\s*,\s*esp_now_send_status_t\s+\w+\s*\)/.exec(s); return m && /esp_now_register_send_cb/.test(s) ? { index: m.index } : null; },
    message: 'From core 3.2 the ESP-NOW send callback gets a const wifi_tx_info_t * instead of the MAC address.',
    fix: 'void onSent(const wifi_tx_info_t *info, esp_now_send_status_t status) { … } (the peer is info->des_addr).',
  },
  {
    id: 'esp32-softwareserial', level: 'error', proofLevel: 3, compileError: true,
    when: isEsp32,
    test: (s, code) => { const m = /#include\s*<SoftwareSerial\.h>/.exec(code); return m && { index: m.index }; },
    message: 'The ESP32 core has no SoftwareSerial.',
    fix: 'Use a spare hardware UART on your pins: Serial1.begin(9600, SERIAL_8N1, rxPin, txPin).',
  },
  {
    id: 'esp32-adc2-with-wifi', level: 'error', proofLevel: 0,
    when: (ctx) => ['esp32', 'esp32c3'].includes(family(ctx)),
    test: (s, code, ctx) => {
      if (!/\bWiFi\s*\.\s*(?:begin|mode|softAP)\s*\(/.test(s)) return null;
      const adc2 = family(ctx) === 'esp32c3' ? new Set([5]) : new Set([0, 2, 4, 12, 13, 14, 15, 25, 26, 27]);
      const out = [];
      for (const m of s.matchAll(/\banalogRead(?:MilliVolts)?\s*\(\s*(?:GPIO_NUM_)?(\d{1,2})\s*\)/g)) {
        if (adc2.has(Number(m[1]))) out.push({ index: m.index, message: `GPIO ${m[1]} is an ADC2 pin, and ADC2 cannot read while Wi-Fi is on: analogRead returns garbage or fails.` });
      }
      return out.length ? out : null;
    },
    message: 'ADC2 pins cannot be read while Wi-Fi is on.',
    fix: (ctx) => (family(ctx) === 'esp32c3' ? 'Use an ADC1 pin (GPIO 0–4).' : 'Use an ADC1 pin: GPIO 32–39 (34–39 are input-only, fine for analog).'),
  },
  {
    id: 'avr-input-pulldown', level: 'error', proofLevel: 3, compileError: true,
    when: isAvr,
    test: (s) => { const m = /\bINPUT_PULLDOWN\b/.exec(s); return m && { index: m.index }; },
    message: 'AVR chips have no internal pull-down resistors.',
    fix: 'INPUT_PULLUP with the button to GND (pressed reads LOW), or INPUT with a 10 kΩ resistor to GND.',
  },
  {
    id: 'avr-serial-printf', level: 'error', proofLevel: 3, compileError: true,
    when: isAvr,
    test: (s) => { const m = /\bSerial\d?\s*\.\s*printf\s*\(/.exec(s); return m && { index: m.index }; },
    message: 'Serial.printf does not exist on AVR boards.',
    fix: 'char buf[64]; snprintf(buf, sizeof buf, "x=%d", x); Serial.println(buf); (%f does not work on AVR: use Serial.print(value, 2).)',
  },
  {
    id: 'avr-wire-pins', level: 'error', proofLevel: 3, compileError: true,
    when: isAvr,
    test: (s) => { const m = /\bWire\s*\.\s*begin\s*\(\s*[^,()]+,\s*[^,()]+\)/.exec(s); return m && { index: m.index }; },
    message: 'AVR I2C pins are fixed (Uno and Nano: A4 = SDA, A5 = SCL); Wire.begin takes no pins.',
    fix: 'Wire.begin(); with SDA on A4 and SCL on A5 (Mega: 20 and 21).',
  },
  {
    id: 'avr-analog-only-pins', level: 'error', proofLevel: 0,
    when: (ctx) => family(ctx) === 'avr',
    test: (s) => {
      const out = [];
      for (const m of s.matchAll(/\b(?:pinMode|digitalWrite|digitalRead)\s*\(\s*(A[67])\b/g)) out.push({ index: m.index, message: `${m[1]} is analog input only on the ATmega328P: pinMode, digitalWrite and digitalRead do not work on it.` });
      return out.length ? out : null;
    },
    message: 'A6 and A7 are analog input only.',
    fix: 'Use analogRead(A6) (> 512 means high), or move the part to a digital pin.',
  },
  {
    id: 'avr-pwm-pin', level: 'warning', proofLevel: 0,
    when: (ctx) => family(ctx) === 'avr' && /^(uno|nano|pro|mini|diecimila|ethernet|bt|fio|lilypad|atmegang)/.test(boardOf(ctx.fqbn)),
    test: (s, code) => {
      const out = [];
      for (const m of s.matchAll(/\banalogWrite\s*\(\s*(\w+)\s*,/g)) {
        const pin = /^\d+$/.test(m[1]) ? Number(m[1]) : Number((new RegExp(`(?:#define\\s+${m[1]}\\s+|(?:const\\s+)?(?:int|byte|uint8_t)\\s+${m[1]}\\s*=\\s*)(\\d+)`).exec(code) || [])[1]);
        if (Number.isInteger(pin) && ![3, 5, 6, 9, 10, 11].includes(pin)) out.push({ index: m.index, message: `Pin ${pin} has no PWM on this board: analogWrite turns it fully on (128 and up) or off.` });
      }
      return out.length ? out : null;
    },
    message: 'analogWrite on a pin without PWM.',
    fix: 'Use a PWM pin: 3, 5, 6, 9, 10 or 11.',
  },
  {
    id: 'avr-serial-pins', level: 'warning', proofLevel: 0,
    when: (ctx) => family(ctx) === 'avr' && /^(uno|nano|pro|mini|diecimila|ethernet)/.test(boardOf(ctx.fqbn)),
    test: (s) => {
      if (!/\bSerial\s*\.\s*begin\s*\(/.test(s)) return null;
      const m = /\b(?:pinMode|digitalWrite)\s*\(\s*([01])\s*,/.exec(s);
      return m && { index: m.index, message: `Pin ${m[1]} is the serial ${m[1] === '0' ? 'RX' : 'TX'} pin: using it while Serial runs garbles the serial monitor and can block uploads.` };
    },
    message: 'Pins 0 and 1 are the serial port.',
    fix: 'Move the part to pin 2 or higher.',
  },
  {
    id: 'attach-interrupt-pin-number', level: 'warning', proofLevel: 0,
    test: (s, code, ctx) => {
      const m = /\battachInterrupt\s*\(\s*(\d+)\s*,/.exec(s);
      if (!m) return null;
      const n = Number(m[1]);
      if (isAvr(ctx) && n > 1) return { index: m.index, message: `attachInterrupt's first argument is an interrupt number, not a pin: on this board interrupt ${n} does not exist, so the handler never runs.` };
      if (isAvr(ctx)) return { index: m.index, message: `attachInterrupt(${n}, …) means interrupt ${n} (pin ${n + 2} on the Uno), not pin ${n}.` };
      return null;
    },
    message: 'attachInterrupt takes an interrupt number.',
    fix: 'attachInterrupt(digitalPinToInterrupt(pin), handler, mode).',
  },
  {
    id: 'isr-delay-or-serial', level: 'error', proofLevel: 0,
    test: (s) => {
      const out = [];
      for (const name of isrNames(s)) {
        const fn = functionBody(s, name);
        if (!fn) continue;
        const d = /\bdelay(?:Microseconds)?\s*\(\s*\d{2,}|\bdelay\s*\(/.exec(fn.body);
        if (d) out.push({ index: fn.index, message: `${name}() runs as an interrupt handler and calls delay(): interrupts are off inside it, so delay() hangs or returns at once.` });
        const p = /\bSerial\d?\s*\.\s*(?:print|println|printf|write)\s*\(/.exec(fn.body);
        if (p) out.push({ index: fn.index, level: 'warning', message: `${name}() runs as an interrupt handler and prints: Serial waits on interrupts, so this can lock up or lose output.` });
      }
      return out.length ? out : null;
    },
    message: 'Slow work inside an interrupt handler.',
    fix: 'Set a volatile flag in the handler and do the slow work (delays, printing) in loop().',
  },
  {
    id: 'isr-volatile', level: 'warning', proofLevel: 0,
    test: (s) => {
      const out = [];
      for (const name of isrNames(s)) {
        const fn = functionBody(s, name);
        if (!fn) continue;
        for (const m of fn.body.matchAll(/\b([A-Za-z_]\w*)\s*(?:\+\+|--|[+\-|&^]?=(?!=))/g)) {
          const v = m[1];
          const decl = new RegExp(`^\\s*((?:static\\s+)?(?:volatile\\s+)?(?:unsigned\\s+)?(?:int|long|bool|byte|uint8_t|uint16_t|uint32_t|int32_t|float|char|size_t)\\b[^;(]*\\b${v}\\b)`, 'm').exec(s);
          const outside = s.slice(0, fn.index) + s.slice(fn.index + fn.header.length + fn.body.length);
          const usedOutside = (outside.match(new RegExp(`\\b${v}\\b`, 'g')) || []).length > 1; // more than its declaration
          if (decl && usedOutside && !/\bvolatile\b/.test(decl[1]) && decl.index < fn.index) out.push({ index: decl.index, message: `${v} is changed in the interrupt handler ${name}() and read elsewhere, but is not volatile: the compiler may keep a stale copy.` });
        }
      }
      const seen = new Set();
      return out.filter((f) => !seen.has(f.message) && seen.add(f.message)).slice(0, 3) || null;
    },
    message: 'A variable shared with an interrupt handler is not volatile.',
    fix: 'Declare it volatile (volatile unsigned long count = 0;), and read multi-byte values with interrupts off.',
  },
  {
    id: 'esp32-isr-iram', level: 'warning', proofLevel: 0,
    when: isEsp32,
    test: (s) => {
      const out = [];
      for (const name of isrNames(s)) {
        const fn = functionBody(s, name);
        if (fn && !/IRAM_ATTR|ARDUINO_ISR_ATTR/.test(fn.header)) out.push({ index: fn.index, message: `${name}() is an interrupt handler without IRAM_ATTR: if it runs while the flash is busy (Wi-Fi, Preferences), the ESP32 crashes.` });
      }
      return out.length ? out : null;
    },
    message: 'An ESP32 interrupt handler outside IRAM.',
    fix: 'void IRAM_ATTR onPin() { … }',
  },
  {
    id: 'millis-in-int', level: 'warning', proofLevel: 0,
    test: (s, code, ctx) => {
      const m = /\b(int|long|short|int16_t|int32_t|float)\s+(\w+)\s*=\s*(?:millis|micros)\s*\(\s*\)/.exec(s);
      if (!m) return null;
      const why = m[1] === 'int' || m[1] === 'short' || m[1] === 'int16_t'
        ? (isAvr(ctx) ? 'an int on this board holds 32,767 ms, so it goes negative after 33 seconds' : 'a signed type breaks the time arithmetic when the counter wraps')
        : 'a signed type breaks the time arithmetic when the counter wraps (after 25 days for millis)';
      return { index: m.index, message: `${m[2]} stores millis()/micros() in ${m[1]}: ${why}.` };
    },
    message: 'Time stored in the wrong type.',
    fix: 'unsigned long last = millis(); and compare with millis() - last >= interval.',
  },
  {
    id: 'serial-without-begin', level: 'error', proofLevel: 0,
    test: (s, code, ctx) => {
      const p = /\bSerial\s*\.\s*(?:print|println|printf|write)\s*\(/.exec(s);
      // Serial.begin may live in another tab of the sketch (ctx.project).
      const everywhere = `${s}\n${stripCode(ctx.project || '')}`;
      return p && !/\bSerial\s*\.\s*begin\s*\(/.test(everywhere) ? { index: p.index } : null;
    },
    message: 'The sketch prints to Serial but never calls Serial.begin(), so nothing appears.',
    fix: 'Serial.begin(115200); at the start of setup().',
  },
  {
    id: 'while-serial-forever', level: 'warning', proofLevel: 0,
    when: nativeUsb,
    test: (s) => { const m = /while\s*\(\s*!\s*Serial\s*\)/.exec(s); return m && { index: m.index }; },
    message: 'while (!Serial) waits forever on battery or a charger: the sketch never starts without a computer.',
    fix: 'Wait with a time limit: while (!Serial && millis() < 3000) delay(10);',
  },
  {
    // An error: the user sees nothing at all (seen on a real ESP32-S3, 2026-10-19). The fix is mechanical.
    id: 'native-usb-early-print', level: 'error', proofLevel: 5,
    when: nativeUsb,
    test: (s) => {
      const setup = functionBody(s, 'setup');
      if (!setup) return null;
      // A print in setup(), or a call to one of the sketch's functions that prints.
      const PRINT = /\bSerial\s*\.\s*(?:print|println|printf)\s*\(/;
      const printers = [...s.matchAll(/\b(?:void|int|bool)\s+(\w+)\s*\([^)]*\)\s*\{/g)]
        .map((m) => m[1]).filter((name) => name !== 'setup' && name !== 'loop' && PRINT.test(functionBody(s, name)?.body || ''));
      const calls = [PRINT, ...printers.map((name) => new RegExp(`\\b${name}\\s*\\(`))]
        .map((re) => re.exec(setup.body)?.index).filter((i) => i !== undefined);
      if (!calls.length) return null;
      const before = setup.body.slice(0, Math.min(...calls));
      if (/while\s*\(\s*!\s*Serial|delay\s*\(\s*(?:[1-9]\d{3,}|\w+)\s*\)/.test(before)) return null;
      return { index: setup.index };
    },
    message: 'This board\'s Serial is its own USB: what setup() prints right after a reset is lost before the serial monitor reconnects.',
    fix: 'Wait for the monitor first: Serial.begin(115200); while (!Serial && millis() < 3000) delay(10);',
    rewrite: (code) => {
      const m = /(Serial\s*\.\s*begin\s*\([^;]*\)\s*;)/.exec(code);
      if (!m || /while\s*\(\s*!\s*Serial/.test(code)) return null;
      return code.replace(m[1], `${m[1]} while (!Serial && millis() < 3000) delay(10);  // native USB: wait for the monitor`);
    },
  },
  {
    id: 'esp-eeprom-begin', level: 'error', proofLevel: 0,
    when: (ctx) => isEsp32(ctx) || /esp8266/.test(platformOf(ctx.fqbn)),
    test: (s) => {
      const w = /\bEEPROM\s*\.\s*(?:write|put|update)\s*\(/.exec(s);
      if (!w) return null;
      if (!/\bEEPROM\s*\.\s*begin\s*\(/.test(s)) return { index: w.index, message: 'EEPROM on the ESP32/ESP8266 is emulated in flash: without EEPROM.begin(size) the writes go nowhere.' };
      if (!/\bEEPROM\s*\.\s*commit\s*\(/.test(s)) return { index: w.index, level: 'warning', message: 'EEPROM writes stay in RAM until EEPROM.commit(): without it they are lost at reset.' };
      return null;
    },
    message: 'Emulated EEPROM used without begin/commit.',
    fix: 'EEPROM.begin(512); … EEPROM.write(0, v); EEPROM.commit(); (the Preferences library is the better choice on the ESP32).',
  },
  {
    id: 'char-compared-with-string', level: 'warning', proofLevel: 3,
    test: (s, code) => {
      const chars = [...s.matchAll(/\bchar\s+(\w+)\s*(?:=|;)/g)].map((m) => m[1]);
      for (const v of chars) {
        const m = new RegExp(`\\b${v}\\s*[!=]=\\s*"`).exec(code);
        if (m) return { index: m.index, message: `${v} is a char compared with a string ("…"): the comparison is always false. AVR builds accept it with only a warning.` };
      }
      return null;
    },
    message: 'A char compared with a string.',
    fix: "Use single quotes: if (c == 'a').",
  },
  {
    id: 'string-in-loop-avr', level: 'info', proofLevel: 0,
    when: (ctx) => family(ctx) === 'avr',
    test: (s) => {
      const loop = functionBody(s, 'loop');
      if (!loop) return null;
      const m = /\b\w+\s*\+=\s*(?:String\s*\(|")|\bString\s+\w+\s*=\s*[^;]*\+/.exec(loop.body);
      return m && { index: loop.index };
    },
    message: 'Building Strings in loop() on a 2 KB-RAM board fragments the heap: long-running sketches crash or reset after hours.',
    fix: 'Print the parts one after another (Serial.print("T="); Serial.print(t);), or use a fixed char buffer with snprintf.',
  },
  {
    id: 'led-builtin-undefined', level: 'error', proofLevel: 2, compileError: true,
    when: (ctx) => ctx.ledBuiltin === null,
    test: (s) => { const m = /\bLED_BUILTIN\b/.exec(s); return m && { index: m.index }; },
    message: 'LED_BUILTIN is not defined for this board (its core names no user LED), so this does not compile.',
    fix: 'Use the pin your LED is on (many ESP32 DevKits: GPIO 2), or select the exact board.',
  },
];

/**
 * Lint a sketch (one file's text).
 * @param {string} code
 * @param {{ fqbn?: string, coreVersion?: string, ledBuiltin?: number|string|null|undefined, cdcOnBoot?: boolean, file?: string, project?: string, built?: boolean }} [ctx]
 *   project: the sketch's other files, for rules that look across tabs (Serial.begin in another file);
 *   built: the sketch just compiled, so rules that predict a compile error are skipped
 * @returns {Array<{ id: string, level: 'error'|'warning'|'info', line: number, file: string|null, message: string, fix: string, canRewrite: boolean, proofLevel: number }>}
 */
function lint(code, ctx = {}) {
  const stripped = stripCode(code);
  const out = [];
  for (const rule of RULES) {
    if (rule.when && !rule.when(ctx)) continue;
    // After a build that worked, a rule that predicts a compile error can only be wrong.
    if (ctx.built && rule.compileError) continue;
    let hits;
    try {
      hits = rule.test(stripped, String(code || ''), ctx);
    } catch {
      continue;
    }
    if (!hits) continue;
    for (const h of [].concat(hits).filter(Boolean)) {
      out.push({
        id: rule.id,
        level: h.level || rule.level,
        line: lineAt(stripped, h.index ?? 0),
        file: ctx.file || null,
        message: h.message || rule.message,
        fix: typeof rule.fix === 'function' ? rule.fix(ctx) : rule.fix,
        canRewrite: typeof rule.rewrite === 'function',
        proofLevel: rule.proofLevel,
      });
    }
  }
  const order = { error: 0, warning: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level] || a.line - b.line);
}

/** Apply every mechanical fix the findings allow. */
function autofix(code, ctx = {}) {
  let current = String(code || '');
  const applied = [];
  for (const f of lint(current, ctx)) {
    const rule = RULES.find((r) => r.id === f.id);
    if (!rule?.rewrite || applied.includes(rule.id)) continue;
    const next = rule.rewrite(current, ctx);
    if (next && next !== current) { current = next; applied.push(rule.id); }
  }
  return { code: current, applied };
}

/** Findings as lines for the model, the console and the Problems tab. */
function lintReport(findings, { max = 6 } = {}) {
  if (!findings?.length) return '';
  const label = { error: 'Problem', warning: 'Warning', info: 'Note' };
  return findings.slice(0, max).map((f) => `${label[f.level]} (line ${f.line}): ${f.message} Fix: ${f.fix}`).join('\n');
}

module.exports = { RULES, lint, autofix, lintReport, stripCode, family };
