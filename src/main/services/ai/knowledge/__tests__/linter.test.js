/**
 * The hardware linter: what compiles but fails on the bench, and what will not
 * compile on this board's core, found before the build.
 */
const { RULES, lint, autofix, lintReport, stripCode } = require('../linter');

const ESP32 = { fqbn: 'esp32:esp32:esp32', coreVersion: '3.3.12' };
const NANO_ESP32 = { fqbn: 'arduino:esp32:nano_nora', coreVersion: '2.0.18-arduino.5' };
const UNO = { fqbn: 'arduino:avr:uno', coreVersion: '1.8.8' };
const PICO = { fqbn: 'rp2040:rp2040:rpipico', coreVersion: '6.3.0' };
const ids = (code, ctx) => lint(code, ctx).map((f) => f.id);

describe('the linter', () => {
  test('rules have unique ids, a level, a fix and an honest proof level', () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    for (const r of RULES) {
      expect([r.id, ['error', 'warning', 'info'].includes(r.level)]).toEqual([r.id, true]);
      expect([r.id, [0, 1, 2, 3, 4, 5, 6].includes(r.proofLevel)]).toEqual([r.id, true]);
      expect([r.id, Boolean(r.fix)]).toEqual([r.id, true]);
    }
  });

  test('comments and strings never trigger a rule', () => {
    expect(ids('// ledcSetup(0, 5000, 8);\nvoid setup() { Serial.begin(115200); Serial.println("delay(5) in an ISR"); }\nvoid loop() {}\n', ESP32)).toEqual([]);
    expect(stripCode('a = "x"; // y\nb')).toBe('a = " ";     \nb');
    expect(stripCode('url("http://x"); /* "q */ c')).toBe(`url("${' '.repeat(8)}"); ${' '.repeat(8)} c`);
  });

  test('the core\'s own API: core 2 code on core 3, and core 3 code on the Nano ESP32\'s core 2', () => {
    const core2 = 'void setup() { ledcSetup(0, 5000, 8); ledcAttachPin(4, 0); ledcWrite(0, 128); }\nvoid loop() {}\n';
    expect(ids(core2, ESP32)).toContain('esp32-ledc-core2-api');
    expect(ids(core2, NANO_ESP32)).not.toContain('esp32-ledc-core2-api');
    expect(autofix(core2, ESP32)).toEqual({ code: 'void setup() { ledcAttach(4, 5000, 8); ledcWrite(4, 128); }\nvoid loop() {}\n', applied: ['esp32-ledc-core2-api'] });
    const core3 = 'hw_timer_t *t;\nvoid IRAM_ATTR f() {}\nvoid setup() { t = timerBegin(1000000); timerAttachInterrupt(t, &f); timerAlarm(t, 250000, true, 0); }\nvoid loop() {}\n';
    expect(ids(core3, NANO_ESP32)).toContain('esp32-timer-core3-api');
    expect(ids(core3, ESP32)).not.toContain('esp32-timer-core3-api');
    expect(autofix(core3, NANO_ESP32).applied).toEqual(['esp32-timer-core3-api']);
  });

  test('ADC2 pins with Wi-Fi on the classic ESP32, not without Wi-Fi', () => {
    const withWifi = '#include <WiFi.h>\nvoid setup() { Serial.begin(115200); WiFi.begin("a", "b"); }\nvoid loop() { Serial.println(analogRead(25)); Serial.println(analogRead(34)); }\n';
    const found = lint(withWifi, ESP32).filter((f) => f.id === 'esp32-adc2-with-wifi');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ level: 'error', line: 3, message: expect.stringMatching(/GPIO 25 is an ADC2 pin/) });
    expect(ids(withWifi.replace('WiFi.begin("a", "b");', ''), ESP32)).not.toContain('esp32-adc2-with-wifi');
  });

  test('interrupt handlers: no delay, no printing, shared variables volatile, IRAM on the ESP32', () => {
    const code = 'int count = 0;\nvoid onPin() { count++; delay(5); }\nvoid setup() { Serial.begin(9600); attachInterrupt(digitalPinToInterrupt(2), onPin, RISING); }\nvoid loop() { Serial.println(count); }\n';
    expect(ids(code, UNO)).toEqual(expect.arrayContaining(['isr-delay-or-serial', 'isr-volatile']));
    expect(ids(code.replace('int count', 'volatile int count').replace(' delay(5);', ''), UNO)).toEqual([]);
    expect(ids(code, ESP32)).toContain('esp32-isr-iram');
    expect(lint('void f() {}\nvoid setup() { attachInterrupt(2, f, RISING); }\nvoid loop() {}\n', UNO)[0]).toMatchObject({ id: 'attach-interrupt-pin-number', message: expect.stringMatching(/interrupt 2 does not exist/) });
  });

  test('AVR limits', () => {
    expect(ids('void setup() { pinMode(2, INPUT_PULLDOWN); }\nvoid loop() {}\n', UNO)).toContain('avr-input-pulldown');
    expect(ids('void setup() { Serial.begin(9600); Serial.printf("%d", 1); }\nvoid loop() {}\n', UNO)).toContain('avr-serial-printf');
    expect(ids('void setup() { Serial.begin(9600); Serial.printf("%d", 1); }\nvoid loop() {}\n', ESP32)).not.toContain('avr-serial-printf');
    expect(lint('void setup() { pinMode(7, OUTPUT); analogWrite(7, 100); }\nvoid loop() {}\n', UNO)[0]).toMatchObject({ id: 'avr-pwm-pin', message: expect.stringMatching(/Pin 7 has no PWM/) });
    expect(ids('const int LED = 9;\nvoid setup() { analogWrite(LED, 100); }\nvoid loop() {}\n', UNO)).toEqual([]);
    expect(ids('void setup() { pinMode(A7, INPUT); }\nvoid loop() {}\n', { fqbn: 'arduino:avr:nano', coreVersion: '1.8.8' })).toContain('avr-analog-only-pins');
    expect(ids('void setup() { Serial.begin(9600); pinMode(1, OUTPUT); }\nvoid loop() {}\n', UNO)).toContain('avr-serial-pins');
  });

  test('serial: begin, prints lost on native USB, and waiting forever', () => {
    expect(ids('void setup() { Serial.println("x"); }\nvoid loop() {}\n', UNO)).toContain('serial-without-begin');
    expect(ids('void report() { Serial.println("x"); }\n', { ...UNO, project: 'void setup() { Serial.begin(9600); }' })).not.toContain('serial-without-begin'); // begin() in another tab
    const early = 'void setup() { Serial.begin(115200); Serial.println("count=0"); }\nvoid loop() {}\n';
    expect(ids(early, PICO)).toContain('native-usb-early-print');
    // A print through one of the sketch's own functions counts too.
    expect(ids('void report(bool p) { Serial.println(p ? "pressed" : "released"); }\nvoid setup() { Serial.begin(115200); report(false); }\nvoid loop() {}\n', PICO)).toContain('native-usb-early-print');
    expect(ids(early, UNO)).not.toContain('native-usb-early-print'); // the Uno's USB chip keeps the port open
    expect(ids(early.replace('Serial.begin(115200);', 'Serial.begin(115200); while (!Serial && millis() < 3000) delay(10);'), PICO)).toEqual([]);
    expect(ids('void setup() { Serial.begin(115200); while (!Serial); }\nvoid loop() {}\n', PICO)).toContain('while-serial-forever');
    expect(ids('void setup() { Serial.begin(115200); Serial.println("x"); }\nvoid loop() {}\n', { fqbn: 'esp32:esp32:esp32s3:CDCOnBoot=cdc', coreVersion: '3.3.12' })).toContain('native-usb-early-print');
  });

  test('time in the wrong type, chars compared with strings, emulated EEPROM, LED_BUILTIN', () => {
    expect(lint('void setup() { int t = millis(); }\nvoid loop() {}\n', UNO)[0]).toMatchObject({ id: 'millis-in-int', message: expect.stringMatching(/32,767 ms/) });
    expect(ids('void setup() { Serial.begin(9600); }\nvoid loop() { char c = Serial.read(); if (c == "a") {} }\n', UNO)).toContain('char-compared-with-string');
    expect(ids('#include <EEPROM.h>\nvoid setup() { EEPROM.write(0, 1); }\nvoid loop() {}\n', ESP32)).toContain('esp-eeprom-begin');
    expect(ids('#include <EEPROM.h>\nvoid setup() { EEPROM.begin(8); EEPROM.write(0, 1); EEPROM.commit(); }\nvoid loop() {}\n', ESP32)).not.toContain('esp-eeprom-begin');
    expect(ids('void setup() { pinMode(LED_BUILTIN, OUTPUT); }\nvoid loop() {}\n', { ...ESP32, ledBuiltin: null })).toContain('led-builtin-undefined');
    expect(ids('void setup() { pinMode(LED_BUILTIN, OUTPUT); }\nvoid loop() {}\n', { ...ESP32, ledBuiltin: 2 })).toEqual([]);
    // After a build that worked, what would have been a compile error cannot be one.
    expect(ids('void setup() { pinMode(LED_BUILTIN, OUTPUT); }\nvoid loop() {}\n', { ...ESP32, ledBuiltin: null, built: true })).toEqual([]);
    expect(ids('void setup() { ledcSetup(0, 5000, 8); }\nvoid loop() {}\n', { ...ESP32, built: true })).toEqual([]);
  });

  test('the report for the model and the Problems tab', () => {
    const report = lintReport(lint('void setup() { pinMode(2, INPUT_PULLDOWN); }\nvoid loop() {}\n', UNO));
    expect(report).toMatch(/^Problem \(line 1\): AVR chips have no internal pull-down resistors\. Fix: INPUT_PULLUP/);
    expect(lintReport([])).toBe('');
  });
});
