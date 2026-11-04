/**
 * The error decoder: common compile errors get a cause and a fix without a
 * model call, and mechanical fixes are rewritten. The fixtures are real
 * compiler output, recorded by `npm run knowledge:errors` from each rule's
 * example on a real core.
 */
const fs = require('fs');
const path = require('path');
const { RULES, decode, rewrite, decodedText } = require('../errorDecoder');

const FIXTURES = path.join(__dirname, '../../../../../../test/fixtures/compile-errors');
const fixture = (id) => fs.readFileSync(path.join(FIXTURES, `${id}.txt`), 'utf8');
const fqbnOf = (text) => /^# (\S+)/.exec(text)?.[1] || '';

describe('the rules', () => {
  test('there are at least 50, with unique ids and a cause and a fix each', () => {
    expect(RULES.length).toBeGreaterThanOrEqual(50);
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    for (const r of RULES) {
      expect([r.id, typeof r.cause === 'string' || typeof r.cause === 'function']).toEqual([r.id, true]);
      expect([r.id, typeof r.fix === 'string' || typeof r.fix === 'function']).toEqual([r.id, true]);
    }
  });

  test('every recorded real compiler output decodes to its own rule', () => {
    const files = fs.existsSync(FIXTURES) ? fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.txt')) : [];
    expect(files.length).toBeGreaterThanOrEqual(30);
    for (const file of files) {
      const id = file.replace(/\.txt$/, '');
      const text = fixture(id);
      const found = decode(text, { fqbn: fqbnOf(text) }).map((f) => f.id);
      expect([id, found.includes(id)]).toEqual([id, true]);
    }
  });
});

describe('decoding', () => {
  test('specific rules win over the generic ones, with the board in mind', () => {
    const ledc = "sketch.ino:2:3: error: 'ledcSetup' was not declared in this scope";
    expect(decode(ledc, { fqbn: 'esp32:esp32:esp32' })[0].id).toBe('esp32-ledc-core3');
    expect(decode(ledc, { fqbn: 'arduino:avr:uno' })[0].id).toBe('not-declared'); // not an ESP32: no core-3 advice
    const typo = "sketch.ino:3:30: error: 'dlay' was not declared in this scope; did you mean 'delay'?";
    expect(decode(typo, { fqbn: 'arduino:avr:uno' })[0]).toMatchObject({ id: 'not-declared', line: 3, fix: expect.stringMatching(/Did you mean delay\?/) });
  });

  test('linker errors without a file and line are read too', () => {
    const out = "/tmp/x/core.a(main.cpp.o): In function `main':\nmain.cpp:(.text.startup.main+0x84): undefined reference to `loop'\ncollect2: error: ld returned 1 exit status";
    expect(decode(out, { fqbn: 'arduino:avr:uno' })[0]).toMatchObject({ id: 'missing-setup-loop', title: 'The sketch has no loop()' });
  });

  test('a .cpp file without Arduino.h is told apart from a typo in the .ino', () => {
    const cpp = "/x/sketch/helpers.cpp:3:3: error: 'digitalWrite' was not declared in this scope";
    expect(decode(cpp, { fqbn: 'arduino:avr:uno' })[0].id).toBe('missing-arduino-h');
    const ino = "/x/sketch/sketch.ino:3:3: error: 'digitalWrite' was not declared in this scope";
    expect(decode(ino, { fqbn: 'arduino:avr:uno' })[0].id).not.toBe('missing-arduino-h');
  });

  test('an error inside a core macro is placed on the sketch line that used it', () => {
    const out = "/x/s/s.ino: In function 'void loop()':\n~/Arduino15/packages/arduino/hardware/avr/1.8.8/cores/arduino/Arduino.h:40:14: error: lvalue required as left operand of assignment\n/x/s/s.ino:3:24: note: in expansion of macro 'HIGH'";
    expect(decode(out, { fqbn: 'arduino:avr:uno' })[0]).toMatchObject({ id: 'lvalue-assign', file: '/x/s/s.ino', line: 3 });
  });

  test('decoded errors carry their proof: L3 for rules checked on a real compiler', () => {
    const [ledc] = decode("s.ino:2:3: error: 'ledcSetup' was not declared in this scope", { fqbn: 'esp32:esp32:esp32' });
    expect(ledc.proof).toMatch(/^Proof L3, compiled by Impulse: seen on esp32:esp32@3\.\d+\.\d+ .*its automatic fix compiles/);
    const [generic] = decode("s.ino:2:3: error: call of overloaded 'f(int)' is ambiguous", { fqbn: 'arduino:avr:uno' });
    expect(generic.proof).toMatch(/^Proof L0/);
  });

  test('the text for the model and the Problems tab', () => {
    const text = decodedText(decode("s.ino:1:14: error: 'INPUT_PULLDOWN' was not declared in this scope", { fqbn: 'arduino:avr:uno' }));
    expect(text).toMatch(/^AVR chips have pull-ups only: .* Fix: Use INPUT_PULLUP/);
    expect(decodedText([])).toBe('');
  });
});

describe('rewrites', () => {
  const ledc2 = 'void setup() {\n  ledcSetup(0, 5000, 8);\n  ledcAttachPin(4, 0);\n  ledcWrite(0, 128);\n}\nvoid loop() {}\n';
  const ledc3 = 'void setup() {\n  ledcAttach(D3, 5000, 8);\n  ledcWrite(D3, 128);\n}\nvoid loop() {}\n';

  test('LEDC moves between the channel and the pin API', () => {
    const to3 = rewrite(ledc2, "s.ino:2:3: error: 'ledcSetup' was not declared in this scope", { fqbn: 'esp32:esp32:esp32' });
    expect(to3.applied).toEqual(['esp32-ledc-core3']);
    expect(to3.code).toBe('void setup() {\n  ledcAttach(4, 5000, 8);\n  ledcWrite(4, 128);\n}\nvoid loop() {}\n');
    const to2 = rewrite(ledc3, "s.ino:2:3: error: 'ledcAttach' was not declared in this scope", { fqbn: 'arduino:esp32:nano_nora' });
    expect(to2.code).toBe('void setup() {\n  ledcSetup(0, 5000, 8); ledcAttachPin(D3, 0);\n  ledcWrite(0, 128);\n}\nvoid loop() {}\n');
  });

  test('timers move between core 2 and core 3', () => {
    const core2 = 'void setup() {\n  t = timerBegin(0, 80, true);\n  timerAttachInterrupt(t, &onTimer, true);\n  timerAlarmWrite(t, 500000, true);\n  timerAlarmEnable(t);\n}\n';
    const to3 = rewrite(core2, "s.ino:2:22: error: too many arguments to function 'hw_timer_t* timerBegin(uint32_t)'", { fqbn: 'esp32:esp32:esp32' });
    expect(to3.code).toBe('void setup() {\n  t = timerBegin(1000000);\n  timerAttachInterrupt(t, &onTimer);\n  timerAlarm(t, 500000, true, 0);\n}\n');
    const back = rewrite(to3.code, "s.ino:2:7: error: too few arguments to function 'hw_timer_t* timerBegin(uint8_t, uint16_t, bool)'", { fqbn: 'arduino:esp32:nano_nora' });
    expect(back.code).toBe('void setup() {\n  t = timerBegin(0, 80, true);\n  timerAttachInterrupt(t, &onTimer, true);\n  timerAlarmWrite(t, 500000, true); timerAlarmEnable(t);\n}\n');
  });

  test('the ESP-NOW receive callback gains or loses its info struct', () => {
    const old = 'void onRecv(const uint8_t *mac, const uint8_t *data, int len) {\n  Serial.println(mac[0]);\n}\nvoid setup() { esp_now_register_recv_cb(onRecv); }\n';
    const out = rewrite(old, "s.ino:4:41: error: invalid conversion from 'void (*)(const uint8_t*, const uint8_t*, int)' {aka 'void (*)(const unsigned char*, const unsigned char*, int)'} to 'esp_now_recv_cb_t'", { fqbn: 'esp32:esp32:esp32' });
    expect(out.code).toMatch(/void onRecv\(const esp_now_recv_info_t \*info, const uint8_t \*data, int len\) \{\n {2}const uint8_t \*mac = info->src_addr;/);
  });

  test('pasted smart quotes become plain quotes on the flagged line only', () => {
    const code = 'void setup() {\n  Serial.println(“hi”);\n}\n// “quoted” in a comment\n';
    const out = rewrite(code, "s.ino:2:18: error: stray '\\342' in program", { fqbn: 'arduino:avr:uno' });
    expect(out.code).toBe('void setup() {\n  Serial.println("hi");\n}\n// “quoted” in a comment\n');
  });

  test('missing includes, braces and setup/loop are added; == replaces = in a condition', () => {
    expect(rewrite('void setup() { WiFi.begin("a", "b"); }\nvoid loop() {}\n', "s.ino:1:16: error: 'WiFi' was not declared in this scope", { fqbn: 'esp32:esp32:esp32' }).code).toMatch(/^#include <WiFi\.h>\n/);
    // The function left open is closed before the next one starts, not at the end of the file.
    expect(rewrite('void setup() {\n  pinMode(13, OUTPUT);\n\nvoid loop() {}\n', "s.ino:4:15: error: expected '}' at end of input", { fqbn: 'arduino:avr:uno' }).code).toBe('void setup() {\n  pinMode(13, OUTPUT);\n\n}\nvoid loop() {}\n');
    expect(rewrite('void setup() {}\n', "main.cpp:(.text+0x8): undefined reference to `loop'", { fqbn: 'arduino:avr:uno' }).code).toBe('void setup() {}\n\nvoid loop() {}\n');
    expect(rewrite('void loop() {\n  if (digitalRead(2) = HIGH) delay(10);\n}\n', 's.ino:2:21: error: lvalue required as left operand of assignment', { fqbn: 'arduino:avr:uno' }).code).toMatch(/if \(digitalRead\(2\) == HIGH\)/);
  });

  test('nothing to rewrite leaves the sketch alone', () => {
    const code = 'void setup() {}\nvoid loop() {}\n';
    expect(rewrite(code, "s.ino:1:1: error: 'Foo' does not name a type", { fqbn: 'arduino:avr:uno' })).toEqual({ code, applied: [] });
  });
});
