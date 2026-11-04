/**
 * Error decoder (knowledge strategy §4.5): the common Arduino compile and link
 * errors, each with its cause and the fix, without a model call. Where the
 * fix is mechanical (an API that moved between core versions, a missing
 * include, smart quotes pasted from a web page) a rewrite applies it.
 *
 * Every rule carries an `example`, a sketch that fails with that error on a
 * real core. `npm run knowledge:errors` compiles each example, records the
 * compiler's real output in test/fixtures/compile-errors/ (the tests decode
 * those), and checks that the rewrite of each example compiles: proof L3 for
 * the rule and for its rewrite, kept in proofs.json.
 * @module main/services/ai/knowledge/errorDecoder
 */

const { parseDiagnostics } = require('../../buildOutput');
const { PROOFS, proof, proofLine } = require('./proof');

const platformOf = (fqbn) => String(fqbn || '').split(':').slice(0, 2).join(':');
const isEsp32 = (p) => /:esp32$/.test(p);
const isAvr = (p) => /^arduino:(avr|megaavr)$/.test(p) || /:avr$/.test(p);

// ---- rewrites -------------------------------------------------------------------

/** The value of a simple argument: a literal or a #define/const in the sketch. */
function constantValue(code, token) {
  const t = String(token || '').trim();
  if (/^\d+$/.test(t)) return Number(t);
  const def = new RegExp(`#define\\s+${t}\\s+(\\d+)\\b`).exec(code) || new RegExp(`(?:const\\s+)?(?:int|uint8_t|unsigned|byte|uint16_t|uint32_t|long)\\s+${t}\\s*=\\s*(\\d+)\\s*;`).exec(code);
  return def ? Number(def[1]) : null;
}

const ARG = '([^,()]+(?:\\([^()]*\\))?)';

/** Core 2 channel LEDC → core 3 pin LEDC: ledcSetup + ledcAttachPin → ledcAttach; channels in ledcWrite → pins. */
function ledcToCore3(code) {
  const setups = new Map();
  for (const m of code.matchAll(new RegExp(`ledcSetup\\s*\\(\\s*${ARG}\\s*,\\s*${ARG}\\s*,\\s*${ARG}\\s*\\)\\s*;`, 'g'))) setups.set(m[1].trim(), { freq: m[2].trim(), bits: m[3].trim() });
  const pins = new Map();
  for (const m of code.matchAll(new RegExp(`ledcAttachPin\\s*\\(\\s*${ARG}\\s*,\\s*${ARG}\\s*\\)`, 'g'))) pins.set(m[2].trim(), m[1].trim());
  if (!setups.size || !pins.size) return null;
  for (const ch of pins.keys()) if (!setups.has(ch)) return null;
  // A ledcSetup alone on its line goes with its line; one sharing a line goes alone.
  const SETUP = `ledcSetup\\s*\\(\\s*${ARG}\\s*,\\s*${ARG}\\s*,\\s*${ARG}\\s*\\)\\s*;`;
  let out = code.replace(new RegExp(`^[ \\t]*${SETUP}[ \\t]*\\r?\\n`, 'gm'), '').replace(new RegExp(`${SETUP}[ \\t]*`, 'g'), '');
  out = out.replace(new RegExp(`ledcAttachPin\\s*\\(\\s*${ARG}\\s*,\\s*${ARG}\\s*\\)`, 'g'), (all, pin, ch) => {
    const s = setups.get(ch.trim());
    return `ledcAttach(${pin.trim()}, ${s.freq}, ${s.bits})`;
  });
  for (const fn of ['ledcWrite', 'ledcWriteTone', 'ledcWriteNote', 'ledcRead', 'ledcReadFreq']) {
    out = out.replace(new RegExp(`\\b${fn}\\s*\\(\\s*${ARG}\\s*([,)])`, 'g'), (all, ch, after) => (pins.has(ch.trim()) ? `${fn}(${pins.get(ch.trim())}${after}` : all));
  }
  out = out.replace(/\bledcDetachPin\s*\(/g, 'ledcDetach(');
  return out === code ? null : out;
}

/** Core 3 pin LEDC → core 2 channels (Arduino's Nano ESP32 core is 2.0.x). */
function ledcToCore2(code) {
  const attaches = [...code.matchAll(new RegExp(`ledcAttach\\s*\\(\\s*${ARG}\\s*,\\s*${ARG}\\s*,\\s*${ARG}\\s*\\)`, 'g'))];
  if (!attaches.length || attaches.length > 16) return null;
  const channel = new Map(attaches.map((m, i) => [m[1].trim(), i]));
  let out = code;
  attaches.forEach((m, i) => {
    out = out.replace(m[0], `ledcSetup(${i}, ${m[2].trim()}, ${m[3].trim()}); ledcAttachPin(${m[1].trim()}, ${i})`);
  });
  for (const fn of ['ledcWrite', 'ledcWriteTone', 'ledcWriteNote', 'ledcRead', 'ledcReadFreq']) {
    out = out.replace(new RegExp(`\\b${fn}\\s*\\(\\s*${ARG}\\s*([,)])`, 'g'), (all, pin, after) => (channel.has(pin.trim()) ? `${fn}(${channel.get(pin.trim())}${after}` : all));
  }
  out = out.replace(/\bledcDetach\s*\(/g, 'ledcDetachPin(');
  return out === code ? null : out;
}

/** Core 2 timers → core 3: timerBegin(n, prescaler, up) → timerBegin(freq); alarm write + enable → timerAlarm. */
function timerToCore3(code) {
  let changed = false;
  let out = code.replace(new RegExp(`timerBegin\\s*\\(\\s*${ARG}\\s*,\\s*${ARG}\\s*,\\s*${ARG}\\s*\\)`, 'g'), (all, num, pre) => {
    const prescaler = constantValue(code, pre);
    if (!prescaler) return all;
    changed = true;
    return `timerBegin(${Math.round(80000000 / prescaler)})`;
  });
  out = out.replace(new RegExp(`timerAttachInterrupt\\s*\\(\\s*${ARG}\\s*,\\s*${ARG}\\s*,\\s*(?:true|false|1|0)\\s*\\)`, 'g'), (all, t, f) => { changed = true; return `timerAttachInterrupt(${t.trim()}, ${f.trim()})`; });
  out = out.replace(new RegExp(`timerAlarmWrite\\s*\\(\\s*${ARG}\\s*,\\s*${ARG}\\s*,\\s*${ARG}\\s*\\)\\s*;`, 'g'), (all, t, ticks, reload) => { changed = true; return `timerAlarm(${t.trim()}, ${ticks.trim()}, ${reload.trim()}, 0);`; });
  out = out.replace(/[ \t]*timerAlarmEnable\s*\(\s*[^()]+\)\s*;[ \t]*\r?\n?/g, () => { changed = true; return ''; });
  out = out.replace(/\btimerAlarmDisable\s*\(/g, () => { changed = true; return 'timerStop('; });
  return changed && out !== code ? out : null;
}

/** Core 3 timers → core 2 (the Nano ESP32's core). */
function timerToCore2(code) {
  let changed = false;
  let out = code.replace(new RegExp(`timerBegin\\s*\\(\\s*${ARG}\\s*\\)`, 'g'), (all, freq) => {
    const hz = constantValue(code, freq);
    if (!hz || 80000000 % hz) return all;
    changed = true;
    return `timerBegin(0, ${80000000 / hz}, true)`;
  });
  out = out.replace(new RegExp(`timerAttachInterrupt\\s*\\(\\s*${ARG}\\s*,\\s*${ARG}\\s*\\)`, 'g'), (all, t, f) => { changed = true; return `timerAttachInterrupt(${t.trim()}, ${f.trim()}, true)`; });
  out = out.replace(new RegExp(`timerAlarm\\s*\\(\\s*${ARG}\\s*,\\s*${ARG}\\s*,\\s*${ARG}\\s*,\\s*${ARG}\\s*\\)\\s*;`, 'g'), (all, t, ticks, reload) => {
    changed = true;
    return `timerAlarmWrite(${t.trim()}, ${ticks.trim()}, ${reload.trim()}); timerAlarmEnable(${t.trim()});`;
  });
  return changed && out !== code ? out : null;
}

/** ESP-NOW receive callback: core 2 (mac, data, len) → core 3 (info, data, len). */
function espNowRecvToCore3(code) {
  const re = /void\s+(\w+)\s*\(\s*const\s+uint8_t\s*\*\s*(\w+)\s*,\s*const\s+uint8_t\s*\*\s*(\w+)\s*,\s*int\s+(\w+)\s*\)\s*\{/;
  const m = re.exec(code);
  if (!m || !new RegExp(`esp_now_register_recv_cb\\s*\\(\\s*&?\\s*${m[1]}\\b`).test(code)) return null;
  return code.replace(re, `void ${m[1]}(const esp_now_recv_info_t *info, const uint8_t *${m[3]}, int ${m[4]}) {\n  const uint8_t *${m[2]} = info->src_addr;`);
}

/** ESP-NOW receive callback: core 3 (info, data, len) → core 2 (mac, data, len). */
function espNowRecvToCore2(code) {
  const re = /void\s+(\w+)\s*\(\s*const\s+esp_now_recv_info_t\s*\*\s*(\w+)\s*,\s*const\s+uint8_t\s*\*\s*(\w+)\s*,\s*int\s+(\w+)\s*\)/;
  const m = re.exec(code);
  if (!m) return null;
  let out = code.replace(re, `void ${m[1]}(const uint8_t *${m[2]}_mac, const uint8_t *${m[3]}, int ${m[4]})`);
  out = out.replace(new RegExp(`\\b${m[2]}\\s*->\\s*src_addr\\b`, 'g'), `${m[2]}_mac`);
  return out;
}

/** ESP-NOW send callback: (mac, status) → core 3.2's (tx info, status). */
function espNowSendToCore32(code) {
  const re = /void\s+(\w+)\s*\(\s*const\s+uint8_t\s*\*\s*(\w+)\s*,\s*esp_now_send_status_t\s+(\w+)\s*\)\s*\{/;
  const m = re.exec(code);
  if (!m) return null;
  return code.replace(re, `void ${m[1]}(const wifi_tx_info_t *info, esp_now_send_status_t ${m[3]}) {\n  const uint8_t *${m[2]} = info->des_addr;`);
}

/**
 * A function left open: close it before the next top-level function starts
 * (or at the end), counting braces outside strings and comments.
 */
function closeBraces(code) {
  const lines = code.split('\n');
  const FUNCTION_START = /^(?:void|int|bool|float|double|long|unsigned|char|byte|String|uint8_t|uint16_t|uint32_t|int8_t|int16_t|int32_t|size_t)\s+[\w:]+\s*\(/;
  const startsFunction = (line) => FUNCTION_START.test(line.replace(/^static\s+/, '').replace(/^inline\s+/, '')) && !/;\s*$/.test(line);
  let depth = 0;
  let changed = false;
  const out = [];
  for (const line of lines) {
    if (depth > 0 && startsFunction(line)) { // a definition, not a prototype
      out.push('}'.repeat(depth));
      depth = 0;
      changed = true;
    }
    out.push(line);
    const bare = line.replace(/\/\/.*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '');
    depth += (bare.match(/\{/g) || []).length - (bare.match(/\}/g) || []).length;
  }
  if (depth > 0 && depth < 4) { out.push('}'.repeat(depth)); changed = true; }
  return changed ? out.join('\n') : null;
}

const rename = (from, to) => (code) => {
  const out = code.replace(new RegExp(`\\b${from}\\s*\\(`, 'g'), `${to}(`);
  return out === code ? null : out;
};

/** Put an #include at the top (after any leading comment block). */
const addInclude = (header) => (code) => {
  if (new RegExp(`#include\\s*[<"]${header.replace('.', '\\.')}[>"]`).test(code)) return null;
  return `#include <${header}>\n${code}`;
};

/** Smart quotes, dashes and non-breaking spaces pasted from a web page, on the lines the compiler flagged. */
function asciiQuotes(code, ctx, diag) {
  const lines = code.split('\n');
  const flagged = new Set((ctx.diagnostics || []).filter((d) => /stray|extended character|not valid in an identifier/.test(d.message)).map((d) => d.line - 1));
  if (diag?.line) flagged.add(diag.line - 1);
  let changed = false;
  for (const i of flagged) {
    if (!lines[i]) continue;
    const fixed = lines[i].replace(/[\u201C\u201D\u201E\u2033]/g, '"').replace(/[\u2018\u2019\u2032]/g, "'").replace(/[\u2013\u2014\u2212]/g, '-').replace(/[\u00A0\u2009\u200B]/g, ' ');
    if (fixed !== lines[i]) { lines[i] = fixed; changed = true; }
  }
  return changed ? lines.join('\n') : null;
}

// ---- rules ------------------------------------------------------------------------
// Order matters: specific rules first, so they win over the generic ones below.

const RULES = [
  // ESP32 core 3 (ESP-IDF 5) against core 2 code, and the reverse on Arduino's Nano ESP32 core (2.0.x).
  {
    id: 'esp32-ledc-core3', when: isEsp32,
    match: /'ledc(?:Setup|AttachPin|DetachPin)' was not declared in this scope/,
    title: 'ESP32 core 3 removed ledcSetup and ledcAttachPin',
    cause: 'This ESP32 core is 3.x, where LEDC works on pins instead of channels, so ledcSetup and ledcAttachPin no longer exist.',
    fix: 'Use ledcAttach(pin, freq, bits) instead of ledcSetup + ledcAttachPin, and ledcWrite(pin, duty) instead of ledcWrite(channel, duty). analogWrite(pin, value) also works.',
    rewrite: ledcToCore3,
    example: { fqbn: 'esp32:esp32:esp32', code: 'void setup() {\n  ledcSetup(0, 5000, 8);\n  ledcAttachPin(4, 0);\n  ledcWrite(0, 128);\n}\nvoid loop() {}\n' },
  },
  {
    id: 'esp32-ledc-core2', when: isEsp32,
    match: /'ledc(?:Attach|Detach)' was not declared in this scope/,
    title: 'This ESP32 core is 2.x: no ledcAttach',
    cause: 'ledcAttach(pin, freq, bits) is the core 3 API. This board\'s core is 2.x (Arduino\'s Nano ESP32 core is 2.0.x), which works with channels.',
    fix: 'Use ledcSetup(channel, freq, bits) and ledcAttachPin(pin, channel), then ledcWrite(channel, duty). analogWrite(pin, value) also works.',
    rewrite: ledcToCore2,
    example: { fqbn: 'arduino:esp32:nano_nora', code: 'void setup() {\n  ledcAttach(D3, 5000, 8);\n  ledcWrite(D3, 128);\n}\nvoid loop() {}\n' },
  },
  {
    id: 'esp32-timer-core3', when: isEsp32,
    match: /too many arguments to function 'hw_timer_t\* timerBegin\(uint32_t\)'|'timerAlarm(?:Write|Enable|Disable)' was not declared in this scope|too many arguments to function 'void timerAttachInterrupt\(/,
    title: 'ESP32 core 3 changed the timer API',
    cause: 'This ESP32 core is 3.x: timerBegin takes the timer frequency, timerAttachInterrupt has no edge argument, and timerAlarmWrite + timerAlarmEnable became timerAlarm.',
    fix: 'hw_timer_t *t = timerBegin(1000000); timerAttachInterrupt(t, &onTimer); timerAlarm(t, 500000, true, 0); // 1 MHz ticks, alarm every 0.5 s',
    rewrite: timerToCore3,
    example: { fqbn: 'esp32:esp32:esp32', code: 'hw_timer_t *t = nullptr;\nvoid IRAM_ATTR onTimer() {}\nvoid setup() {\n  t = timerBegin(0, 80, true);\n  timerAttachInterrupt(t, &onTimer, true);\n  timerAlarmWrite(t, 500000, true);\n  timerAlarmEnable(t);\n}\nvoid loop() {}\n' },
  },
  {
    id: 'esp32-timer-core2', when: isEsp32,
    match: /too few arguments to function 'hw_timer_t\* timerBegin\(uint8_t, uint16_t, bool\)'|'timerAlarm' was not declared in this scope|too few arguments to function 'void timerAttachInterrupt\(/,
    title: 'This ESP32 core is 2.x: the older timer API',
    cause: 'timerBegin(frequency) and timerAlarm are the core 3 API. This board\'s core is 2.x (Arduino\'s Nano ESP32 core is 2.0.x).',
    fix: 'hw_timer_t *t = timerBegin(0, 80, true); timerAttachInterrupt(t, &onTimer, true); timerAlarmWrite(t, 500000, true); timerAlarmEnable(t); // 1 MHz ticks',
    rewrite: timerToCore2,
    example: { fqbn: 'arduino:esp32:nano_nora', code: 'hw_timer_t *t = nullptr;\nvoid IRAM_ATTR onTimer() {}\nvoid setup() {\n  t = timerBegin(1000000);\n  timerAttachInterrupt(t, &onTimer);\n  timerAlarm(t, 500000, true, 0);\n}\nvoid loop() {}\n' },
  },
  {
    id: 'esp32-espnow-recv-core3', when: isEsp32,
    match: /invalid conversion from 'void \(\*\)\(const uint8_t\*, const uint8_t\*, int\)'.*'esp_now_recv_cb_t'|cannot convert '.*' to 'esp_now_recv_cb_t'/,
    title: 'ESP32 core 3 changed the ESP-NOW receive callback',
    cause: 'On core 3.x the receive callback gets a const esp_now_recv_info_t * instead of the sender\'s MAC address.',
    fix: 'void onRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) { const uint8_t *mac = info->src_addr; … }',
    rewrite: espNowRecvToCore3,
    example: { fqbn: 'esp32:esp32:esp32', code: '#include <WiFi.h>\n#include <esp_now.h>\nvoid onRecv(const uint8_t *mac, const uint8_t *data, int len) {}\nvoid setup() {\n  WiFi.mode(WIFI_STA);\n  esp_now_init();\n  esp_now_register_recv_cb(onRecv);\n}\nvoid loop() {}\n' },
  },
  {
    id: 'esp32-espnow-recv-core2', when: isEsp32,
    match: /'esp_now_recv_info_t' (?:does not name a type|has not been declared)/,
    title: 'This ESP32 core is 2.x: the ESP-NOW callback takes the MAC address',
    cause: 'esp_now_recv_info_t is core 3. On this core (2.x; Arduino\'s Nano ESP32 core is 2.0.x) the receive callback gets the sender\'s MAC directly.',
    fix: 'void onRecv(const uint8_t *mac, const uint8_t *data, int len) { … } — or wrap both forms in #if ESP_ARDUINO_VERSION_MAJOR >= 3.',
    rewrite: espNowRecvToCore2,
    example: { fqbn: 'arduino:esp32:nano_nora', code: '#include <WiFi.h>\n#include <esp_now.h>\nvoid onRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) { Serial.println(info->src_addr[0]); }\nvoid setup() {\n  WiFi.mode(WIFI_STA);\n  esp_now_init();\n  esp_now_register_recv_cb(onRecv);\n}\nvoid loop() {}\n' },
  },
  {
    id: 'esp32-espnow-send-core32', when: isEsp32,
    match: /invalid conversion from 'void \(\*\)\(const uint8_t\*, esp_now_send_status_t\)'.*'esp_now_send_cb_t'/,
    title: 'ESP32 core 3.2 changed the ESP-NOW send callback',
    cause: 'From core 3.2 the send callback gets a const wifi_tx_info_t * (the peer address is info->des_addr) instead of the MAC address.',
    fix: 'void onSent(const wifi_tx_info_t *info, esp_now_send_status_t status) { … } — or #if ESP_ARDUINO_VERSION >= ESP_ARDUINO_VERSION_VAL(3, 2, 0) around both forms.',
    rewrite: espNowSendToCore32,
    example: { fqbn: 'esp32:esp32:esp32', code: '#include <WiFi.h>\n#include <esp_now.h>\nvoid onSent(const uint8_t *mac, esp_now_send_status_t status) {}\nvoid setup() {\n  WiFi.mode(WIFI_STA);\n  esp_now_init();\n  esp_now_register_send_cb(onSent);\n}\nvoid loop() {}\n' },
  },
  {
    id: 'esp32-rgbledwrite-core2', when: isEsp32,
    match: /'rgbLedWrite' was not declared in this scope/,
    title: 'This ESP32 core is 2.x: use neopixelWrite',
    cause: 'rgbLedWrite is the core 3 name. On core 2.x (Arduino\'s Nano ESP32 core is 2.0.x) it is neopixelWrite, which core 3 still accepts too.',
    fix: 'neopixelWrite(RGB_BUILTIN, red, green, blue);',
    rewrite: rename('rgbLedWrite', 'neopixelWrite'),
    example: { fqbn: 'arduino:esp32:nano_nora', code: 'void setup() { rgbLedWrite(LED_BUILTIN, 0, 20, 0); }\nvoid loop() {}\n' },
  },
  {
    id: 'esp32-hall-removed', when: isEsp32,
    match: /'(?:hallRead|analogSetClockDiv|adcAttachPin|analogSetVRefPin)' was not declared in this scope/,
    title: 'Removed in ESP32 core 3',
    cause: 'hallRead, analogSetClockDiv, adcAttachPin and analogSetVRefPin were removed in core 3; the ESP32\'s Hall sensor is no longer supported.',
    fix: 'Drop the call. For a magnet, use an external Hall sensor on an analog or digital pin; for the ADC use analogRead/analogSetAttenuation.',
    example: { fqbn: 'esp32:esp32:esp32', code: 'void setup() { Serial.begin(115200); Serial.println(hallRead()); }\nvoid loop() {}\n' },
  },
  {
    id: 'esp32-i2s-core3', when: isEsp32,
    match: /'i2s_driver_install' was not declared|'i2s_set_pin' was not declared|driver\/i2s\.h: No such file/,
    title: 'ESP32 core 3 replaced the old I2S driver',
    cause: 'Core 3 (ESP-IDF 5) drops driver/i2s.h; the Arduino core has its own I2S class.',
    fix: '#include <ESP_I2S.h>  I2SClass i2s; i2s.setPins(bclk, ws, dout); i2s.begin(I2S_MODE_STD, 16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);',
  },
  {
    id: 'esp32-softwareserial', when: isEsp32,
    match: /SoftwareSerial\.h: No such file or directory/,
    title: 'The ESP32 has no SoftwareSerial',
    cause: 'The ESP32 core has no SoftwareSerial: it has spare hardware UARTs that can use almost any pins.',
    fix: 'Use Serial1 or Serial2 with your pins: Serial1.begin(9600, SERIAL_8N1, rxPin, txPin); then Serial1.read()/print(). (EspSoftwareSerial in the Library Manager exists if you need more ports.)',
    example: { fqbn: 'esp32:esp32:esp32', code: '#include <SoftwareSerial.h>\nSoftwareSerial gps(16, 17);\nvoid setup() { gps.begin(9600); }\nvoid loop() {}\n' },
  },
  {
    id: 'esp32-onewire-c6', when: isEsp32,
    match: /OneWire_direct_gpio\.h.*(?:no match for 'operator>>'|error)/,
    title: 'OneWire does not build for this ESP32 chip',
    cause: 'OneWire 2.3.8 accesses GPIO registers the ESP32-C6 (and other new chips) lay out differently, so it does not compile there.',
    fix: 'Use OneWireNg instead: its DSTherm driver reads DS18B20 sensors without OneWire or DallasTemperature (#include <OneWireNg_CurrentPlatform.h> and <drivers/DSTherm.h>).',
  },
  {
    id: 'esp32-adc-cal-core3', when: isEsp32,
    match: /esp_adc_cal\.h: No such file|'esp_adc_cal_characterize' was not declared/,
    title: 'ESP32 core 3 dropped esp_adc_cal',
    cause: 'The old ADC calibration API (esp_adc_cal) is gone in core 3.',
    fix: 'Use analogReadMilliVolts(pin): it returns calibrated millivolts.',
  },
  // Headers that belong to another board's core.
  {
    id: 'esp8266-header-on-esp32', when: isEsp32,
    match: /ESP8266(?:WiFi|WebServer|HTTPClient|mDNS)\.h: No such file or directory/,
    title: 'An ESP8266 header on an ESP32',
    cause: 'ESP8266WiFi.h and friends belong to the ESP8266 core. The ESP32 core names them WiFi.h, WebServer.h, HTTPClient.h and ESPmDNS.h.',
    fix: 'Replace #include <ESP8266WiFi.h> with #include <WiFi.h> (and ESP8266WebServer with WebServer, ESP8266HTTPClient with HTTPClient, ESP8266mDNS with ESPmDNS).',
    rewrite: (code) => {
      const out = code.replace(/ESP8266WiFi\.h/g, 'WiFi.h').replace(/ESP8266WebServer\.h/g, 'WebServer.h').replace(/ESP8266HTTPClient\.h/g, 'HTTPClient.h').replace(/ESP8266mDNS\.h/g, 'ESPmDNS.h')
        .replace(/\bESP8266WebServer\b/g, 'WebServer');
      return out === code ? null : out;
    },
    example: { fqbn: 'esp32:esp32:esp32', code: '#include <ESP8266WiFi.h>\nvoid setup() { WiFi.begin("net", "pass"); }\nvoid loop() {}\n' },
  },
  {
    id: 'wifi-on-avr', when: isAvr,
    match: /(?:WiFi|ESP8266WiFi|WiFiNINA|Preferences|esp_now|BluetoothSerial)\.h: No such file or directory/,
    title: 'This board has no Wi-Fi (or that ESP32 library)',
    cause: 'An AVR board such as the Uno or Nano has no Wi-Fi radio, and ESP32 libraries (Preferences, esp_now, BluetoothSerial) do not exist for it.',
    fix: 'Pick an ESP32 or Uno R4 WiFi board for networking; for saved settings on AVR use EEPROM.h.',
    example: { fqbn: 'arduino:avr:uno', code: '#include <WiFi.h>\nvoid setup() { WiFi.begin("net", "pass"); }\nvoid loop() {}\n' },
  },
  // AVR limits.
  {
    id: 'avr-serial-printf', when: isAvr,
    match: /'class HardwareSerial' has no member named 'printf'/,
    title: 'Serial.printf does not exist on AVR boards',
    cause: 'The AVR core\'s Serial has print and println but no printf.',
    fix: 'Format with snprintf into a buffer, then print it: char buf[64]; snprintf(buf, sizeof buf, "x=%d", x); Serial.println(buf); (%f does not work on AVR: use dtostrf or Serial.print(value, 2).)',
    example: { fqbn: 'arduino:avr:uno', code: 'void setup() { Serial.begin(9600); Serial.printf("x=%d\\n", 5); }\nvoid loop() {}\n' },
  },
  {
    id: 'avr-serial1', when: isAvr,
    match: /'Serial[1-3]' was not declared in this scope/,
    title: 'This board has one hardware serial port',
    cause: 'The Uno and Nano have a single UART (Serial, on pins 0 and 1, shared with USB). Serial1 exists on the Mega, Leonardo and Micro, not here.',
    fix: 'Use SoftwareSerial on two free pins: #include <SoftwareSerial.h>  SoftwareSerial link(10, 11); link.begin(9600);',
    example: { fqbn: 'arduino:avr:uno', code: 'void setup() { Serial1.begin(9600); }\nvoid loop() {}\n' },
  },
  {
    id: 'avr-input-pulldown', when: isAvr,
    match: /'INPUT_PULLDOWN' was not declared in this scope/,
    title: 'AVR chips have pull-ups only',
    cause: 'The ATmega has internal pull-up resistors but no pull-downs.',
    fix: 'Use INPUT_PULLUP, wire the button to GND, and read LOW as pressed; or keep INPUT with a 10 kΩ resistor to GND.',
    example: { fqbn: 'arduino:avr:uno', code: 'void setup() { pinMode(2, INPUT_PULLDOWN); }\nvoid loop() {}\n' },
  },
  {
    id: 'avr-analog-resolution', when: isAvr,
    match: /'analog(?:Read|Write)Resolution' was not declared in this scope/,
    title: 'The Uno\'s ADC and PWM resolution are fixed',
    cause: 'On AVR boards analogRead is always 10-bit (0–1023) and analogWrite 8-bit (0–255); there is no resolution setting.',
    fix: 'Remove the call and scale the values: analogRead() returns 0–1023, analogWrite() takes 0–255.',
    example: { fqbn: 'arduino:avr:uno', code: 'void setup() { analogReadResolution(12); }\nvoid loop() {}\n' },
  },
  {
    id: 'avr-wire-pins', when: isAvr,
    match: /no matching function for call to 'TwoWire::begin\(int, int\)'/,
    title: 'AVR I2C pins are fixed',
    cause: 'On the Uno and Nano the I2C pins are A4 (SDA) and A5 (SCL); Wire.begin() takes no pin numbers there.',
    fix: 'Call Wire.begin(); and wire SDA to A4, SCL to A5 (on the Mega: 20 and 21).',
    rewrite: (code) => { const out = code.replace(/Wire\.begin\s*\(\s*[^()]+,\s*[^()]+\)/g, 'Wire.begin()'); return out === code ? null : out; },
    example: { fqbn: 'arduino:avr:uno', code: '#include <Wire.h>\nvoid setup() { Wire.begin(21, 22); }\nvoid loop() {}\n' },
  },
  {
    id: 'analog-pin-missing',
    match: /'A([6-9]|1[0-5])' was not declared in this scope/,
    title: 'This board has fewer analog pins',
    cause: (m, ctx) => `A${m[1]} does not exist on this board${isAvr(ctx.platform) ? ': the Uno and Nano cores define A0–A7, and A6/A7 are only wired on the Nano and surface-mount boards, analog input only' : ''}.`,
    fix: 'Use one of the board\'s analog pins (see the board facts), or pick the board that has the pin.',
    example: { fqbn: 'arduino:avr:uno', code: 'void setup() { Serial.begin(9600); Serial.println(analogRead(A8)); }\nvoid loop() {}\n' },
  },
  {
    id: 'nodemcu-pin-names',
    match: /'D(?:[0-9]|1[0-6])' was not declared in this scope/,
    title: 'D-numbered pin names belong to other boards',
    cause: 'Names like D4 come from the NodeMCU/Wemos (ESP8266) and Arduino Nano ESP32 cores. This board numbers its pins differently.',
    fix: 'Use the GPIO number (ESP32: 4 for GPIO4) or the board\'s own pin names (see the board facts).',
    example: { fqbn: 'esp32:esp32:esp32', code: 'void setup() { pinMode(D4, OUTPUT); }\nvoid loop() {}\n' },
  },
  {
    id: 'led-builtin-missing',
    match: /'LED_BUILTIN' was not declared in this scope/,
    title: 'This board defines no LED_BUILTIN',
    cause: 'The selected board has no user LED the core knows about, so LED_BUILTIN is not defined (common on generic ESP32 modules).',
    fix: (m, ctx) => (ctx.ledPin !== undefined && ctx.ledPin !== null ? `Use pin ${ctx.ledPin}, where this board's LED is, or add #define LED_BUILTIN ${ctx.ledPin}.` : 'Use the pin your LED is on (many ESP32 DevKits: GPIO 2), or pick the exact board so LED_BUILTIN is defined.'),
    rewrite: (code, ctx) => (ctx.ledPin !== undefined && ctx.ledPin !== null && !/#define\s+LED_BUILTIN/.test(code) ? `#define LED_BUILTIN ${ctx.ledPin}\n${code}` : null),
    // The rewrite needs the board's LED pin (from the board facts); the example says where it is.
    example: { fqbn: 'esp32:esp32:esp32', code: 'void setup() { pinMode(LED_BUILTIN, OUTPUT); }\nvoid loop() {}\n', ctx: { ledPin: 2 } },
  },
  // Missing includes the compiler reports as undeclared names.
  {
    id: 'missing-include-wifi',
    match: /'WiFi' was not declared in this scope|'WiFiClient' (?:was not declared|does not name a type)|'WL_CONNECTED' was not declared/,
    title: 'WiFi.h is not included',
    cause: 'The sketch uses Wi-Fi without including its header.',
    fix: (m, ctx) => (/esp8266/.test(ctx.platform) ? 'Add #include <ESP8266WiFi.h> at the top.' : 'Add #include <WiFi.h> at the top.'),
    rewrite: (code, ctx) => addInclude(/esp8266/.test(ctx.platform) ? 'ESP8266WiFi.h' : 'WiFi.h')(code),
    example: { fqbn: 'esp32:esp32:esp32', code: 'void setup() { WiFi.begin("net", "pass"); }\nvoid loop() {}\n' },
  },
  {
    id: 'missing-include-wire',
    match: /'Wire' was not declared in this scope/,
    title: 'Wire.h is not included',
    cause: 'The sketch uses I2C (Wire) without including its header.',
    fix: 'Add #include <Wire.h> at the top.',
    rewrite: addInclude('Wire.h'),
    example: { fqbn: 'arduino:avr:uno', code: 'void setup() { Wire.begin(); }\nvoid loop() {}\n' },
  },
  {
    id: 'missing-include-spi',
    match: /'SPI' was not declared in this scope/,
    title: 'SPI.h is not included',
    cause: 'The sketch uses SPI without including its header.',
    fix: 'Add #include <SPI.h> at the top.',
    rewrite: addInclude('SPI.h'),
    example: { fqbn: 'arduino:avr:uno', code: 'void setup() { SPI.begin(); }\nvoid loop() {}\n' },
  },
  {
    id: 'missing-include-eeprom',
    match: /'EEPROM' was not declared in this scope/,
    title: 'EEPROM.h is not included',
    cause: 'The sketch uses EEPROM without including its header.',
    fix: 'Add #include <EEPROM.h> at the top. (On ESP32/ESP8266 also call EEPROM.begin(size) first and EEPROM.commit() after writing.)',
    rewrite: addInclude('EEPROM.h'),
    example: { fqbn: 'arduino:avr:uno', code: 'void setup() { EEPROM.write(0, 1); }\nvoid loop() {}\n' },
  },
  {
    id: 'missing-include-preferences', when: isEsp32,
    match: /'Preferences' does not name a type/,
    title: 'Preferences.h is not included',
    cause: 'The sketch uses Preferences without including its header.',
    fix: 'Add #include <Preferences.h> at the top.',
    rewrite: addInclude('Preferences.h'),
    example: { fqbn: 'esp32:esp32:esp32', code: 'Preferences prefs;\nvoid setup() { prefs.begin("app", false); }\nvoid loop() {}\n' },
  },
  {
    id: 'missing-include-servo',
    match: /'Servo' does not name a type/,
    title: 'The Servo header is not included',
    cause: 'The sketch declares a Servo without including the library.',
    fix: (m, ctx) => (isEsp32(ctx.platform) ? 'Add #include <ESP32Servo.h> (Library Manager: ESP32Servo); the AVR Servo library does not run on the ESP32.' : 'Add #include <Servo.h> at the top.'),
    rewrite: (code, ctx) => addInclude(isEsp32(ctx.platform) ? 'ESP32Servo.h' : 'Servo.h')(code),
    example: { fqbn: 'arduino:avr:uno', code: 'Servo s;\nvoid setup() { s.attach(9); }\nvoid loop() {}\n' },
  },
  {
    id: 'missing-arduino-h',
    match: /'(?:Serial|HIGH|LOW|OUTPUT|INPUT|digitalWrite|pinMode|delay|millis|byte|String)' (?:was not declared in this scope|does not name a type)/,
    when: (p, ctx) => !!ctx.file && !/\.ino(?:\.cpp)?$/.test(ctx.file),
    title: 'A .cpp or .h file without Arduino.h',
    cause: 'Only .ino files get Arduino.h automatically; a .cpp or .h file of the sketch must include it itself.',
    fix: 'Add #include <Arduino.h> as the first line of that file.',
  },
  // Pasted text.
  {
    id: 'smart-quotes',
    match: /stray '\\(?:342|302|200|231|234|235|240)' in program|extended character .* is not valid in an identifier/,
    title: 'Curly quotes or dashes pasted from a web page',
    cause: 'The code contains typographic characters (“ ” ‘ ’ – or a non-breaking space), usually from copying a sketch out of a web page or a document. C++ only accepts plain ASCII quotes.',
    fix: 'Replace “ ” with " and ‘ ’ with \' on the flagged lines (and – with -).',
    rewrite: asciiQuotes,
    example: { fqbn: 'arduino:avr:uno', code: 'void setup() {\n  Serial.begin(9600);\n  Serial.println(\u201Chello\u201D);\n}\nvoid loop() {}\n' },
  },
  // Linker.
  {
    id: 'missing-setup-loop', raw: true,
    match: /undefined reference to [`'"]?(setup|loop)['"]?/,
    title: (m) => `The sketch has no ${m[1]}()`,
    cause: (m) => `Every Arduino sketch needs both setup() and loop(); ${m[1]}() is missing (or misspelled, or inside another function).`,
    fix: (m) => `Add void ${m[1]}() { } — even an empty one.`,
    rewrite: (code, ctx, d, m) => (new RegExp(`\\bvoid\\s+${m[1]}\\s*\\(`).test(code) ? null : `${code.trimEnd()}\n\nvoid ${m[1]}() {}\n`),
    example: { fqbn: 'arduino:avr:uno', code: 'void setup() { pinMode(13, OUTPUT); }\n' },
  },
  {
    id: 'multiple-definition', raw: true,
    match: /multiple definition of [`'"]?([\w:~]+)/,
    title: (m) => `${m[1]} is defined twice`,
    cause: (m) => `${m[1]} has two bodies: two tabs or files of the sketch both define it, or a library defines it too.`,
    fix: 'Keep one definition: delete the duplicate (look in every tab of the sketch), or rename one of them.',
  },
  {
    id: 'undefined-reference', raw: true,
    match: /undefined reference to [`'"]?([\w:~<>]+)/,
    title: (m) => `${m[1]} is declared but never defined`,
    cause: (m) => `The code calls ${m[1]}, and the compiler saw its declaration, but no file contains its body. Typical causes: a function prototype without the function, a library's .cpp missing, or a library for another board.`,
    fix: 'Write the function (same name and parameters as its declaration), or install the library that implements it for this board.',
  },
  // Language errors, specific first.
  {
    id: 'redefinition-setup-loop',
    match: /redefinition of 'void (setup|loop)\(\)'/,
    title: (m) => `Two ${m[1]}() functions`,
    cause: (m) => `The sketch defines ${m[1]}() twice, usually because two examples were pasted into one file or two tabs each have one.`,
    fix: (m) => `Merge the two ${m[1]}() bodies into one function and delete the other.`,
    example: { fqbn: 'arduino:avr:uno', code: 'void setup() {}\nvoid loop() {}\nvoid setup() {}\n' },
  },
  {
    id: 'redefinition',
    match: /redefinition of '([^']+)'/,
    title: (m) => `${m[1]} is defined twice`,
    cause: (m) => `${m[1]} is defined twice in the same file.`,
    fix: 'Delete one of the two definitions, or rename one.',
  },
  {
    id: 'conflicting-declaration',
    match: /conflicting declaration '([^']+)'/,
    title: 'A name declared twice with different types',
    cause: (m) => `${m[1]} clashes with an earlier declaration of the same name (often a #define or a variable in a library).`,
    fix: 'Rename your variable, or remove the duplicate declaration.',
  },
  {
    id: 'non-static-member-callback',
    match: /invalid use of non-static member function|cannot convert '.*::\*\)\(\)' to 'void \(\*\)\(\)'/,
    title: 'A class method used as a callback',
    cause: 'attachInterrupt, timers and most C callbacks take a plain function, not a method of an object.',
    fix: 'Write a plain (or static) function that calls the method: void onPin() { myObject.handle(); } and pass onPin.',
  },
  {
    id: 'compare-pointer-integer',
    match: /ISO C\+\+ forbids comparison between pointer and integer/,
    title: 'A character compared with a string',
    cause: 'A char is compared with a string literal ("a"), or a String with a char. In C++ \'a\' is a character and "a" is a string.',
    fix: 'Compare a char with \'a\' (single quotes); compare Strings with == "text" only when the left side is a String object.',
    // AVR builds with -fpermissive, which makes this a warning there (the linter flags it); an error on the ESP32.
    example: { fqbn: 'esp32:esp32:esp32', code: 'void setup() { Serial.begin(115200); }\nvoid loop() { char c = Serial.read(); if (c == "a") Serial.println("A"); }\n' },
  },
  {
    id: 'string-literal-to-char',
    match: /invalid conversion from 'const char\*' to 'char\*'|ISO C\+\+ forbids converting a string constant to 'char\*'/,
    title: 'A string literal passed as char*',
    cause: 'String literals are read-only (const char*), and the code passes one where a modifiable char* is expected.',
    fix: 'Declare the parameter or variable as const char*, or copy into a char buffer first.',
    example: { fqbn: 'esp32:esp32:esp32', code: 'void show(char *t) {}\nvoid setup() { const char *msg = "hi"; show(msg); }\nvoid loop() {}\n' },
  },
  {
    id: 'lvalue-assign',
    match: /lvalue required as left operand of assignment/,
    title: '= where == was meant (or assigning to a value)',
    cause: 'The left side of = is not something that can be assigned, e.g. if (digitalRead(2) = HIGH) or 5 = x.',
    fix: 'Use == to compare: if (digitalRead(2) == HIGH).',
    rewrite: (code, ctx, d) => {
      if (!d?.line) return null;
      const lines = code.split('\n');
      const i = d.line - 1;
      const fixed = lines[i]?.replace(/(\bdigitalRead\s*\([^()]*\)|\banalogRead\s*\([^()]*\)|\b\d+)\s*=\s*(?!=)/, '$1 == ');
      if (!fixed || fixed === lines[i]) return null;
      lines[i] = fixed;
      return lines.join('\n');
    },
    example: { fqbn: 'arduino:avr:uno', code: 'void setup() { pinMode(2, INPUT); }\nvoid loop() {\n  if (digitalRead(2) = HIGH) delay(10);\n}\n' },
  },
  {
    id: 'else-without-if',
    match: /'else' without a previous 'if'/,
    title: 'An else with no matching if',
    cause: 'Usually a semicolon right after if (…) or a missing { } around the if\'s statements, which ends the if before the else.',
    fix: 'Remove the ; after if (…), and put braces around the statements of the if.',
    example: { fqbn: 'arduino:avr:uno', code: 'void setup() {}\nvoid loop() {\n  int x = 1;\n  if (x > 0);\n    x = 2;\n  else\n    x = 3;\n}\n' },
  },
  {
    id: 'missing-semicolon',
    match: /expected ';' before|expected ';' at end of (?:member )?declaration|expected ',' or ';' before/,
    title: 'A missing semicolon',
    cause: 'The statement just before the reported position (often the end of the previous line) has no ;.',
    fix: 'Add ; at the end of the line before the one the error points to.',
    example: { fqbn: 'arduino:avr:uno', code: 'void setup() {\n  int x = 5\n  pinMode(13, OUTPUT);\n}\nvoid loop() {}\n' },
  },
  {
    id: 'missing-brace-end',
    match: /expected '}' at end of input/,
    title: 'A missing closing brace',
    cause: 'A function or block opened with { is never closed.',
    fix: 'Add the missing } (count the braces of the last function: each { needs its }).',
    rewrite: closeBraces,
    example: { fqbn: 'arduino:avr:uno', code: 'void setup() {\n  pinMode(13, OUTPUT);\n\nvoid loop() {}\n' },
  },
  {
    id: 'missing-paren',
    match: /expected '\)' before|expected '\(' before|expected ']' before/,
    title: 'Unbalanced brackets',
    cause: 'A ( or [ is not closed where the compiler expected it, often a missing ) in an if or a function call.',
    fix: 'Check the brackets on the reported line: each ( needs its ).',
  },
  {
    id: 'unterminated-string',
    match: /missing terminating ["'] character/,
    title: 'A string or character without its closing quote',
    cause: 'A string started with " (or a character with \') is not closed on the same line.',
    fix: 'Close the quote on that line; split long strings into "part one" "part two".',
    example: { fqbn: 'arduino:avr:uno', code: 'void setup() { Serial.begin(9600); Serial.println("hello); }\nvoid loop() {}\n' },
  },
  {
    id: 'expected-unqualified-id',
    match: /expected unqualified-id before|expected declaration before '}' token/,
    title: 'Code outside a function, or an extra brace',
    cause: 'Statements must live inside a function; an extra } usually closes a function early and leaves the rest outside.',
    fix: 'Remove the extra }, or move the statements into setup() or loop().',
    example: { fqbn: 'arduino:avr:uno', code: 'void setup() {}\n}\nvoid loop() {}\n' },
  },
  {
    id: 'expected-primary-expression',
    match: /expected primary-expression before/,
    title: 'Something is missing in an expression',
    cause: 'The compiler expected a value: often a type written inside a call (f(int x)), a missing argument, or a stray symbol.',
    fix: 'Check the reported spot: call functions with values, not types, and fill every argument.',
    example: { fqbn: 'arduino:avr:uno', code: 'void setup() { pinMode(int 13, OUTPUT); }\nvoid loop() {}\n' },
  },
  {
    id: 'declared-void',
    match: /variable or field '(\w+)' declared void/,
    title: 'A function that uses a type before it is declared',
    cause: (m) => `${m[1]} takes a parameter whose type (a struct, class or enum) is declared later; the Arduino builder puts its prototype above that type.`,
    fix: 'Move the struct/class/enum to the top of the sketch (or into a .h file), above every function that uses it.',
  },
  {
    id: 'no-member',
    match: /'(?:class |struct )?([\w:]+)' has no member named '(\w+)'/,
    title: (m) => `${m[1]} has no ${m[2]}`,
    cause: (m) => `${m[2]} does not exist in this version of ${m[1]}: the API differs between library or core versions, or it is a typo.`,
    fix: 'Check the library\'s own examples for this version (File › Examples) or its documentation; read_docs and the libraries tool can confirm the installed version.',
  },
  {
    id: 'no-matching-function',
    match: /no matching function for call to '([^']+)'/,
    title: 'No function with these arguments',
    cause: (m) => `${m[1]} exists, but not with the arguments given (their number or types differ, often between library versions).`,
    fix: 'Look at the "candidate" lines under the error for the signatures that exist, and match one of them.',
  },
  {
    id: 'too-many-arguments',
    match: /too (many|few) arguments to function '([^']+)'/,
    title: (m) => `Too ${m[1]} arguments`,
    cause: (m) => `${m[2]} takes a different number of arguments than the call passes (the API changed between versions, or the call is wrong).`,
    fix: 'Match the declaration shown in the note under the error.',
  },
  {
    id: 'ambiguous-overload',
    match: /call of overloaded '([^']+)' is ambiguous/,
    title: 'An ambiguous call',
    cause: (m) => `Several versions of ${m[1]} fit these arguments equally well (common with Wire.requestFrom(address, count) when the types differ).`,
    fix: 'Cast the arguments to the exact types: Wire.requestFrom((uint8_t)address, (uint8_t)count).',
  },
  {
    id: 'narrowing',
    match: /narrowing conversion of/,
    title: 'A value that does not fit the type',
    cause: 'A value inside { } initialisation is wider than the variable\'s type (an int into a byte array, a negative number into an unsigned).',
    fix: 'Use a wider type, or cast explicitly: (uint8_t)value.',
  },
  {
    id: 'does-not-name-type',
    match: /'(\w+)' does not name a type/,
    title: (m) => `${m[1]} is not a known type`,
    cause: (m) => `${m[1]} is used as a type, but nothing declares it: a missing #include for its library, a typo, or a statement outside a function.`,
    fix: (m) => `Include the library that defines ${m[1]} (the libraries tool finds it), check the spelling, and keep statements inside functions.`,
  },
  {
    id: 'not-declared',
    match: /'(\w+)' was not declared in this scope/,
    title: (m) => `${m[1]} is not declared`,
    cause: (m) => `${m[1]} is used but never declared: a typo, a variable declared inside another function or block, or a missing #include for its library.`,
    fix: (m) => {
      const meant = /did you mean '(\w+)'/.exec(m.input || '')?.[1];
      return meant ? `Did you mean ${meant}? Otherwise declare ${m[1]} before it is used, at the top of the sketch for a global.` : `Declare ${m[1]} before it is used (at the top of the sketch for a global), fix its spelling, or include the library that provides it.`;
    },
    example: { fqbn: 'arduino:avr:uno', code: 'void setup() { pinMode(13, OUTPUT); }\nvoid loop() { digitalWrite(13, HIGH); dlay(500); }\n' },
  },
];

const textOf = (v, m, ctx) => (typeof v === 'function' ? v(m, ctx) : v);

/** How a rule is known: L3 when its example failed this way on a real core (npm run knowledge:errors). */
function ruleProof(id) {
  const p = PROOFS.decoder?.[id];
  if (!p) return proofLine(proof(0, 'matched by the error\'s wording; not yet checked against a real compiler'));
  return proofLine(proof(3, `seen on ${p.core} on ${p.date}${p.rewrite ? '; its automatic fix compiles' : ''}`));
}

const IN_TOOLCHAIN = /[\\/](?:packages|hardware|cores|libraries|tools)[\\/]|Arduino15|arduino15/;
/**
 * The errors, each placed in the sketch: an error reported inside a core
 * header (HIGH is a macro in Arduino.h) moves to the sketch line named by
 * the note that follows it ("in expansion of macro 'HIGH'").
 */
function sketchLines(diagnostics) {
  const out = [];
  diagnostics.forEach((d, i) => {
    if (d.level !== 'error') return;
    if (IN_TOOLCHAIN.test(d.file)) {
      const note = diagnostics.slice(i + 1, i + 4).find((n) => n.level === 'note' && /\.(?:ino|pde)$/.test(n.file));
      if (note) { out.push({ ...d, file: note.file, line: note.line, col: note.col }); return; }
    }
    out.push(d);
  });
  return out;
}

/**
 * Decode a build's output.
 * @param {string} output   the compiler's output
 * @param {{ fqbn?: string, ledPin?: number|null }} [ctx]
 * @returns {Array<{ id: string, title: string, cause: string, fix: string, file: string|null, line: number|null, message: string, canRewrite: boolean }>}
 *   one entry per rule that matched, in the order the errors appear
 */
function decode(output, ctx = {}) {
  const platform = platformOf(ctx.fqbn);
  const text = String(output || '');
  const diagnostics = sketchLines(parseDiagnostics(text, { limit: 80 }));
  const raw = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  const consider = (message, where) => {
    for (const rule of RULES) {
      if (rule.raw && where.kind !== 'raw' && !/undefined reference|multiple definition/.test(message)) continue;
      if (rule.when && !rule.when(platform, { ...ctx, file: where.file })) continue;
      const m = rule.match.exec(message);
      if (!m) continue;
      if (seen.has(rule.id)) return;
      seen.add(rule.id);
      const c = { ...ctx, platform, file: where.file };
      out.push({
        id: rule.id,
        title: textOf(rule.title, m, c),
        cause: textOf(rule.cause, m, c),
        fix: textOf(rule.fix, m, c),
        file: where.file || null,
        line: where.line || null,
        message: message.slice(0, 300),
        canRewrite: typeof rule.rewrite === 'function',
        proof: ruleProof(rule.id),
      });
      return;
    }
  };
  for (const d of diagnostics) consider(d.message, { file: d.file, line: d.line, kind: 'diag' });
  // Linker errors and fatal errors that carry no file:line of the sketch.
  for (const line of raw) if (/undefined reference to|multiple definition of|No such file or directory/.test(line)) consider(line, { file: null, line: null, kind: 'raw' });
  return out;
}

/**
 * Apply the rewrites of the decoded errors to a sketch, one after another.
 * @returns {{ code: string, applied: string[] }} code unchanged and applied empty when nothing applies
 */
function rewrite(code, output, ctx = {}) {
  const platform = platformOf(ctx.fqbn);
  const diagnostics = sketchLines(parseDiagnostics(String(output || ''), { limit: 80 }));
  let current = String(code || '');
  const applied = [];
  for (const found of decode(output, ctx)) {
    const rule = RULES.find((r) => r.id === found.id);
    if (!rule?.rewrite) continue;
    const m = rule.match.exec(found.message) || [];
    const next = rule.rewrite(current, { ...ctx, platform, diagnostics }, { line: found.line }, m);
    if (next && next !== current) {
      current = next;
      applied.push(rule.id);
    }
  }
  return { code: current, applied };
}

/** Short text for the model and the Problems tab. */
function decodedText(found) {
  if (!found?.length) return '';
  return found.slice(0, 3).map((f) => `${f.title}: ${f.cause} Fix: ${f.fix}`).join('\n');
}

module.exports = {
  RULES, decode, rewrite, decodedText, platformOf,
  // The mechanical fixes, shared with the linter.
  ledcToCore3, ledcToCore2, timerToCore3, timerToCore2, espNowRecvToCore3, espNowRecvToCore2,
};
