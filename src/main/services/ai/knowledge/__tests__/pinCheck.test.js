const { checkPin, mapFor, pinsOf } = require('../pinMap');
const { checkSketchPins, pinReport, constantsOf, resolvePin } = require('../pinCheck');

const ESP32C3 = { family: 'esp32-c3', name: 'ESP32-C3 SuperMini', pins: { LED_BUILTIN: 8, SDA: 6, SCL: 7, TX: 21, RX: 20 }, analogPins: { A0: 0, A1: 1, A2: 2, A3: 3 }, digitalAliases: { D0: 2, D1: 3 } };
const ESP32 = { family: 'esp32', name: 'ESP32 DevKit V1', pins: { LED_BUILTIN: 2, SDA: 21, SCL: 22 }, analogPins: { A0: 36 } };
const UNO = { family: 'avr-atmega328p', name: 'Arduino Uno', pins: { LED_BUILTIN: 13, SDA: 18, SCL: 19 }, analogPins: { A0: 14, A5: 19 } };

describe('what a chip has', () => {
  it('knows the pins of the families the catalog uses', () => {
    expect(pinsOf('esp32-c3')).toEqual(Array.from({ length: 22 }, (_, i) => i));
    expect(pinsOf('esp32')).toContain(39);
    expect(pinsOf('esp32')).not.toContain(20);
    expect(pinsOf('esp32')).not.toContain(24);
    expect(pinsOf('rp2040').at(-1)).toBe(29);
    expect(pinsOf('avr-atmega328p').at(-1)).toBe(21); // A6 and A7 on the Nano and Pro Mini
    expect(mapFor('stm32')).toBeNull(); // STM32 pins are PA0…, not numbers
  });

  it('refuses a pin the chip does not have, and says what it does have', () => {
    const bad = checkPin(22, 'esp32-c3');
    expect(bad).toMatchObject({ level: 'error', reason: 'the ESP32-C3 has no pin 22' });
    expect(bad.fix).toBe('Its pins are 0–21. Pick one of those.');
    expect(checkPin(20, 'esp32')).toMatchObject({ level: 'error', reason: 'the ESP32 has no pin 20' });
    expect(checkPin(21, 'esp32')).toBeNull();
  });

  it('knows the flash pins, the input-only pins and the strapping pins', () => {
    expect(checkPin(7, 'esp32', { output: true })).toMatchObject({ level: 'error', reason: expect.stringMatching(/wired to the flash/) });
    expect(checkPin(34, 'esp32', { output: true })).toMatchObject({ level: 'error', reason: 'pin 34 on the ESP32 is input-only' });
    expect(checkPin(34, 'esp32', {})).toBeNull(); // reading it is fine
    expect(checkPin(12, 'esp32', { output: true })).toMatchObject({ level: 'warning', reason: expect.stringMatching(/strapping pin/) });
    expect(checkPin(13, 'esp32-c3')).toMatchObject({ level: 'error', reason: expect.stringMatching(/flash/) });
    expect(checkPin(18, 'esp32-c3')).toMatchObject({ level: 'warning', reason: expect.stringMatching(/USB/) });
  });
});

describe('reading a sketch', () => {
  it('resolves literals, the sketch\'s own constants and the core\'s names', () => {
    const constants = constantsOf('#define LED 22\nconst int BUTTON = 4;\nconstexpr uint8_t BUZZER = 9;');
    expect([...constants]).toEqual([['LED', 22], ['BUTTON', 4], ['BUZZER', 9]]);
    const named = new Map([['LED_BUILTIN', 8]]);
    expect(resolvePin('13', { constants, named })).toEqual({ pin: 13, via: '13' });
    expect(resolvePin('LED', { constants, named })).toEqual({ pin: 22, via: 'LED = 22' });
    expect(resolvePin('LED_BUILTIN', { constants, named })).toEqual({ pin: 8, via: 'LED_BUILTIN = 8' });
    expect(resolvePin('somethingElse', { constants, named })).toBeNull();
  });

  it('catches the pin that does not exist, through a #define', () => {
    const code = `#define LED 22
void setup() { pinMode(LED, OUTPUT); }
void loop() { digitalWrite(LED, HIGH); }`;
    const issues = checkSketchPins(code, ESP32C3);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toMatchObject({ level: 'error', pin: 22, via: 'LED = 22' });
    expect(issues[0].message).toMatch(/the ESP32-C3 has no pin 22/);
    const report = pinReport(issues, { boardName: 'the ESP32-C3 SuperMini' });
    expect(report).toMatch(/^\[PIN CHECK\]/);
    expect(report).toMatch(/Its pins are 0–21/);
  });

  it('catches driving an input-only pin and using a flash pin', () => {
    const code = `void setup() {
  pinMode(34, OUTPUT);
  digitalWrite(7, HIGH);
  pinMode(36, INPUT);
}`;
    const issues = checkSketchPins(code, ESP32);
    expect(issues.filter((i) => i.level === 'error').map((i) => i.pin).sort((a, b) => a - b)).toEqual([7, 34]);
    expect(issues.find((i) => i.pin === 34).message).toMatch(/input-only/);
    expect(issues.some((i) => i.pin === 36)).toBe(false); // reading an input-only pin is fine
  });

  it('reads pins out of Wire.begin, SoftwareSerial, Servo.attach and ledcAttach', () => {
    const code = `#include <Wire.h>
Servo arm;
SoftwareSerial gps(25, 99);
void setup() {
  Wire.begin(21, 22);
  arm.attach(34);
  ledcAttach(40, 5000, 8);
}`;
    const issues = checkSketchPins(code, ESP32);
    const byPin = Object.fromEntries(issues.map((i) => [i.pin, i]));
    expect(byPin[99]).toMatchObject({ level: 'error' }); // no such pin
    expect(byPin[40]).toMatchObject({ level: 'error' }); // no such pin on the original ESP32
    expect(byPin[34]).toMatchObject({ level: 'error', message: expect.stringMatching(/input-only/) }); // a servo must drive
    expect(byPin[21]).toBeUndefined();
    expect(byPin[22]).toBeUndefined();
  });

  it('warns when a pin is already used by something on the board', () => {
    const code = 'void setup() { pinMode(4, OUTPUT); }';
    const issues = checkSketchPins(code, ESP32C3, { taken: ['4'], boardName: 'the ESP32-C3 SuperMini' });
    expect(issues[0]).toMatchObject({ level: 'warning', pin: 4 });
    expect(issues[0].message).toMatch(/already used by something on the ESP32-C3 SuperMini/);
  });

  it('keeps quiet about the pins the board is built around, and warns once per pin', () => {
    // GPIO8 is the C3's strapping pin and this board's LED: using it is the point.
    const led = 'void setup() { pinMode(LED_BUILTIN, OUTPUT); }\nvoid loop() { digitalWrite(LED_BUILTIN, HIGH); digitalWrite(LED_BUILTIN, LOW); }';
    expect(checkSketchPins(led, ESP32C3)).toEqual([]);
    // A plain header pin that happens to be a strapping pin still warns, once.
    const many = 'void setup() { pinMode(9, OUTPUT); }\nvoid loop() { digitalWrite(9, HIGH); digitalWrite(9, LOW); }';
    const issues = checkSketchPins(many, ESP32C3);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: 'warning', pin: 9 });
  });

  it('says nothing about a sketch whose pins are all fine', () => {
    const code = `void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(3, INPUT_PULLUP);
  analogRead(A0);
}
void loop() { digitalWrite(LED_BUILTIN, HIGH); }`;
    expect(checkSketchPins(code, ESP32C3)).toEqual([]);
    expect(checkSketchPins(code, UNO)).toEqual([]);
    expect(pinReport([], {})).toBeNull();
  });

  it('believes the installed core over the chip table', () => {
    // The ESP32-PICO on a Feather V2 really does expose GPIO 7 and 8, which
    // are flash pins on a WROOM module: the core naming them settles it.
    const feather = { family: 'esp32', name: 'Feather ESP32 V2', fqbn: 'esp32:esp32:adafruit_feather_esp32_v2', pins: { LED_BUILTIN: 13, TX: 8, RX: 7, SDA: 22, SCL: 20 } };
    expect(checkSketchPins('void setup() { pinMode(8, OUTPUT); pinMode(20, INPUT); }', feather)).toEqual([]);
    // A pin no core names and no chip has is still caught.
    const bad = checkSketchPins('void setup() { pinMode(24, OUTPUT); }', feather);
    expect(bad[0]).toMatchObject({ level: 'error', pin: 24 });
  });

  it('uses the board\'s own numbering where the core numbers by board', () => {
    const nano = { family: 'esp32-s3', name: 'Nano ESP32', fqbn: 'arduino:esp32:nano_nora', pins: { LED_BUILTIN: 13, SDA: 21, SCL: 22 }, analogPins: { A0: 17, A5: 22, A7: 24 }, digitalAliases: { D0: 2, D13: 13 } };
    expect(checkSketchPins('void setup() { pinMode(22, OUTPUT); pinMode(24, INPUT); }', nano)).toEqual([]);
    const bad = checkSketchPins('void setup() { pinMode(38, OUTPUT); }', nano);
    expect(bad[0].message).toMatch(/pin 38 is not a pin on this board/);
  });

  it('says nothing for a board whose pins are not numbers', () => {
    const code = 'void setup() { pinMode(PC13, OUTPUT); digitalWrite(PC13, LOW); }';
    expect(checkSketchPins(code, { family: 'stm32', name: 'Blue Pill' })).toEqual([]);
  });

  it('warns about analogRead on a pin with no ADC', () => {
    const issues = checkSketchPins('void loop() { analogRead(9); }', UNO);
    expect(issues[0]).toMatchObject({ level: 'warning', pin: 9, message: expect.stringMatching(/not an analog input/) });
  });
});
