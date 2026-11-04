// The ATtiny85: an 8-pin AVR running ATTinyCore firmware through the same
// circuit engine and parts as the Arduino boards.
import { BOARDS, boardForFqbn, boardPinNumber, boardPowerPin, parseBoardPin, pinLabel } from '../boards.js';
import { parseExpectations, evaluateExpectations } from '../expectations.js';
import { runHeadless } from '../headless.js';
import { Bench } from './bench.js';
import { compileSketch, describeWithAttiny } from './cli.js';

const tiny = BOARDS.attiny85;

describe('ATtiny85 board', () => {
  test('pin names and numbers follow ATTinyCore', () => {
    expect(parseBoardPin(tiny, 'PB3')).toBe(3);
    expect(parseBoardPin(tiny, '4')).toBe(4);
    expect(parseBoardPin(tiny, 'A0')).toBe(5);
    expect(parseBoardPin(tiny, 'A1')).toBe(2);
    expect(parseBoardPin(tiny, 'A2')).toBe(4);
    expect(parseBoardPin(tiny, 'A3')).toBe(3);
    expect(parseBoardPin(tiny, 'LED_BUILTIN')).toBe(1);
    expect(parseBoardPin(tiny, 'SDA')).toBe(0);
    expect(parseBoardPin(tiny, 'PB6')).toBeNull();
    expect(parseBoardPin(tiny, 'GP3')).toBeNull();
    expect(boardPinNumber(tiny, 'PB0')).toBe(0);
    expect(boardPinNumber(tiny, 'PB5')).toBe(5);
    expect(boardPinNumber(tiny, 'VCC')).toBeNull();
    expect(pinLabel(tiny, 2)).toBe('PB2');
    expect(boardPowerPin('VCC')).toEqual({ kind: 'vcc', volts: 5 });
    expect(tiny.digitalCount).toBe(6);
    expect(boardForFqbn('ATTinyCore:avr:attinyx5:chip=85,clock=16pll')).toBe(tiny);
    expect(boardForFqbn('ATTinyCore:avr:attinyx5')).toBe(tiny);
    expect(boardForFqbn('ATTinyCore:avr:attinyx5:chip=45')).toBe(tiny);
    expect(boardForFqbn('ATTinyCore:avr:attinyx4')).toBeNull();
  });
});

const build = (code, name) => compileSketch(code, tiny.fqbn, name);

describeWithAttiny('ATTinyCore firmware on the simulated ATtiny85', () => {
  test('blink, millis() and Serial on PB0 with @expect lines', async () => {
    const code = `
// @run 1s
// @expect serial contains "tick 4"
// @expect pin LED_BUILTIN frequency 4.8Hz ±2%
int n = 0;
void setup() {
  Serial.begin(9600);
  pinMode(LED_BUILTIN, OUTPUT);
}
void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(100);
  digitalWrite(LED_BUILTIN, LOW);
  delay(100);
  Serial.print("tick ");
  Serial.println(++n);
}`;
    // 200 ms of delays plus 8 characters at 9600 baud (8.3 ms) per blink.
    const run = await runHeadless(build(code, 'tiny_blink'), { seconds: 1, board: 'attiny85' });
    expect(run.board).toBe('attiny85');
    expect(run.serial).toMatch(/^tick 1\r\ntick 2\r\ntick 3\r\ntick 4\r\n/);
    const { items } = parseExpectations(code, 'attiny85');
    for (const r of evaluateExpectations(items, run, 'attiny85')) expect({ check: r.raw, pass: r.pass, detail: r.detail }).toMatchObject({ pass: true });
  }, 300000);

  test('Serial at 115200 baud and typed input echoed back', () => {
    const hex = build(`
void setup() {
  Serial.begin(115200);
  Serial.println("ready");
}
void loop() {
  if (Serial.available()) {
    char c = Serial.read();
    Serial.print('<');
    Serial.print(c);
    Serial.println('>');
  }
}`, 'tiny_echo');
    const b = new Bench('attiny85');
    b.load(hex).run(0.05);
    expect(b.serial).toBe('ready\r\n');
    // TinySoftwareSerial is half duplex: it can't receive while it sends
    // (interrupts are off), so type one character at a time, as on the chip.
    b.runner.serialWrite('o');
    b.run(0.05);
    b.runner.serialWrite('k');
    b.run(0.05);
    expect(b.serial).toBe('ready\r\n<o>\r\n<k>\r\n');
  }, 300000);

  test('analogRead on A1 (PB2), and PWM on PB4 (Timer1 OC1B)', () => {
    const hex = build(`
void setup() {
  Serial.begin(9600);
  analogWrite(4, 64);
}
void loop() {
  Serial.println(analogRead(A1));
  delay(50);
}`, 'tiny_analog');
    const b = new Bench('attiny85');
    b.add('wokwi-potentiometer', 'pot1', { value: '256' });
    b.add('wokwi-led', 'led1', { color: 'red' });
    b.add('wokwi-resistor', 'r1', { value: '220' });
    b.wire('pot1:VCC', 'attiny85:VCC', 'pot1:GND', 'attiny85:GND', 'pot1:SIG', 'attiny85:PB2',
      'attiny85:PB4', 'r1:1', 'r1:2', 'led1:A', 'led1:C', 'attiny85:GND');
    b.load(hex).run(0.4);
    const readings = b.lines().map(Number).filter(Number.isFinite);
    expect(Math.abs(readings[readings.length - 1] - 256)).toBeLessThan(8);
    // analogWrite(64) of 255 on Timer1's OC1B: a quarter duty cycle.
    expect(b.part('led1').el.brightness).toBeGreaterThan(0.15);
    expect(b.part('led1').el.brightness).toBeLessThan(0.35);
  }, 300000);

  test('PWM on PB0 (Timer0), PB1 and PB4 (Timer1), and a fade on LED_BUILTIN', () => {
    const hex = build(`
void setup() {
  analogWrite(0, 192);
  analogWrite(1, 128);
  analogWrite(4, 32);
}
void loop() {}`, 'tiny_pwm');
    const b = new Bench('attiny85');
    for (const [pin, id] of [['PB0', 'a'], ['PB1', 'b'], ['PB4', 'c']]) {
      b.add('wokwi-led', `led_${id}`, { color: 'red' });
      b.add('wokwi-resistor', `r_${id}`, { value: '220' });
      b.wire(`attiny85:${pin}`, `r_${id}:1`, `r_${id}:2`, `led_${id}:A`, `led_${id}:C`, 'attiny85:GND');
    }
    b.load(hex).run(0.3);
    const brightness = (id) => b.part(`led_${id}`).el.brightness;
    expect(Math.abs(brightness('a') - 192 / 256)).toBeLessThan(0.05);
    expect(Math.abs(brightness('b') - 128 / 256)).toBeLessThan(0.05);
    expect(Math.abs(brightness('c') - 32 / 256)).toBeLessThan(0.05);
  }, 300000);

  test('every SRAM byte holds what the sketch stores (no ATmega register hooks in it)', () => {
    // avr8js' peripherals default to ATmega addresses; on the ATtiny85 0x60 and
    // up is SRAM, where a stray hook (CLKPR at 0x61 was one) eats writes.
    const hex = build(`
#include <EEPROM.h>
void setup() {
  volatile byte *ram = (volatile byte *)0x60;
  byte bad = 0;
  for (int i = 0; i < 0x40; i++) ram[i] = i ^ 0x5A;
  for (int i = 0; i < 0x40; i++) if (ram[i] != (i ^ 0x5A)) bad++;
  EEPROM.write(0, bad);
  EEPROM.write(1, 0x42);
}
void loop() {}`, 'tiny_sram');
    const b = new Bench('attiny85');
    b.load(hex).run(0.05);
    expect(Array.from(b.runner.eeprom.backend.memory.slice(0, 2))).toEqual([0, 0x42]);
    expect(b.runner.clock.config.CLKPR).toBe(0x46);
  }, 300000);

  test('EEPROM survives a reset; pin-change interrupts on PB3', () => {
    const hex = build(`
#include <EEPROM.h>
#include <avr/interrupt.h>
volatile int changes = 0;
ISR(PCINT0_vect) { changes++; }
void setup() {
  Serial.begin(9600);
  byte boots = EEPROM.read(7);
  if (boots == 255) boots = 0;
  EEPROM.write(7, boots + 1);
  Serial.print("boots=");
  Serial.println(boots + 1);
  pinMode(3, INPUT_PULLUP);
  GIMSK |= _BV(PCIE);
  PCMSK |= _BV(PCINT3);
  sei();
}
void loop() {
  static int last = 0;
  if (changes != last) { last = changes; Serial.print("changes="); Serial.println(changes); }
}`, 'tiny_eeprom');
    const b = new Bench('attiny85');
    b.add('wokwi-pushbutton', 'btn1');
    b.wire('btn1:1.l', 'attiny85:PB3', 'btn1:2.l', 'attiny85:GND');
    b.load(hex).run(0.1);
    expect(b.serial).toContain('boots=1');
    b.run(0.1, [[0, (x) => x.behavior('btn1').set(true)]]);
    b.run(0.1, [[0, (x) => x.behavior('btn1').set(false)]]);
    expect(b.serial).toMatch(/changes=2/);
    b.serial = '';
    b.runner.reset();
    b.run(0.1);
    expect(b.serial).toContain('boots=2');
  }, 300000);

  test('I²C through the USI: an RTC\'s RAM round trip, its clock, and a missing device', () => {
    // Serial shares PB0 with SDA, so results go to EEPROM.
    const hex = build(`
#include <Wire.h>
#include <EEPROM.h>
void setup() {
  Wire.begin();
  // Three bytes into the DS1307's RAM at 0x10, then read back.
  Wire.beginTransmission(0x68);
  Wire.write(0x10);
  Wire.write(0xA5); Wire.write(0x5A); Wire.write(0x3C);
  EEPROM.write(0, Wire.endTransmission());
  Wire.beginTransmission(0x68);
  Wire.write(0x10);
  EEPROM.write(1, Wire.endTransmission(false));
  EEPROM.write(2, Wire.requestFrom(0x68, 3));
  for (int i = 0; i < 3; i++) EEPROM.write(3 + i, Wire.read());
  // Seconds, in BCD.
  Wire.beginTransmission(0x68);
  Wire.write(0);
  Wire.endTransmission();
  Wire.requestFrom(0x68, 1);
  EEPROM.write(6, Wire.read());
  // Nobody answers at 0x50.
  Wire.beginTransmission(0x50);
  EEPROM.write(7, Wire.endTransmission());
  EEPROM.write(8, 0x42); // done
}
void loop() {}`, 'tiny_i2c');
    const b = new Bench('attiny85');
    b.add('wokwi-ds1307', 'rtc1');
    b.wire('rtc1:SDA', 'attiny85:PB0', 'rtc1:SCL', 'attiny85:PB2', 'rtc1:5V', 'attiny85:VCC', 'rtc1:GND', 'attiny85:GND');
    b.load(hex).run(0.2);
    const rom = Array.from(b.runner.eeprom.backend.memory.slice(0, 9));
    expect(rom[8]).toBe(0x42);
    expect(rom.slice(0, 6)).toEqual([0, 0, 3, 0xa5, 0x5a, 0x3c]);
    expect(rom[6] >> 4).toBeLessThan(6); // BCD seconds
    expect(rom[6] & 0x0f).toBeLessThan(10);
    expect(rom[7]).not.toBe(0);
  }, 300000);

  test('SPI through the USI: SPI.transfer() into a 74HC595, fast and slow clocks', () => {
    const hex = build(`
#include <SPI.h>
const int LATCH = 3;
void send(byte b) {
  digitalWrite(LATCH, LOW);
  SPI.transfer(b);
  digitalWrite(LATCH, HIGH);
}
void setup() {
  pinMode(LATCH, OUTPUT);
  SPI.begin();
  send(0xA5);
  delay(10);
  SPI.beginTransaction(SPISettings(100000, MSBFIRST, SPI_MODE0));
  send(0x3C);
  SPI.endTransaction();
}
void loop() {}`, 'tiny_spi');
    const b = new Bench('attiny85');
    b.add('impulse-74hc595', 'sr1');
    b.wire('sr1:DS', 'attiny85:PB1', 'sr1:SHCP', 'attiny85:PB2', 'sr1:STCP', 'attiny85:PB3',
      'sr1:VCC', 'attiny85:VCC', 'sr1:MR', 'attiny85:VCC', 'sr1:GND', 'attiny85:GND', 'sr1:OE', 'attiny85:GND');
    b.load(hex).run(0.005);
    expect(b.behavior('sr1').reg.latched).toBe(0xa5);
    b.run(0.05);
    expect(b.behavior('sr1').reg.latched).toBe(0x3c);
  }, 300000);

  test('a button on INT0 (PB2) with the pull-up, and the 1.1 V reference', () => {
    const hex = build(`
volatile int presses = 0;
void onPress() { presses++; }
void setup() {
  Serial.begin(9600);
  pinMode(2, INPUT_PULLUP);
  pinMode(3, OUTPUT);
  attachInterrupt(0, onPress, FALLING);
  analogReference(INTERNAL1V1);
}
void loop() {
  digitalWrite(3, digitalRead(2) == LOW);
  static int last = 0;
  if (presses != last) { last = presses; Serial.print("presses="); Serial.println(presses); }
  static unsigned long t = 0;
  if (millis() - t > 200) { t = millis(); Serial.print("a2="); Serial.println(analogRead(A2)); }
}`, 'tiny_button');
    const b = new Bench('attiny85');
    b.add('wokwi-pushbutton', 'btn1');
    b.add('wokwi-led', 'led1', { color: 'green' });
    b.add('wokwi-resistor', 'r1', { value: '220' });
    b.add('impulse-battery', 'bat', { voltage: '0.55' });
    b.wire('btn1:1.l', 'attiny85:PB2', 'btn1:2.l', 'attiny85:GND',
      'attiny85:PB3', 'r1:1', 'r1:2', 'led1:A', 'led1:C', 'attiny85:GND',
      'bat:+', 'attiny85:PB4', 'bat:-', 'attiny85:GND');
    b.load(hex).run(0.3);
    expect(b.part('led1').el.value).toBe(false);
    b.run(0.2, [[0, (x) => x.behavior('btn1').set(true)]]);
    expect(b.part('led1').el.value).toBe(true);
    b.run(0.2, [[0, (x) => x.behavior('btn1').set(false)]]);
    b.run(0.2, [[0, (x) => x.behavior('btn1').set(true)]]);
    expect(b.serial).toContain('presses=2');
    // 0.55 V against the 1.1 V reference: half scale.
    const a2 = b.lines().filter(l => l.startsWith('a2=')).map(l => Number(l.slice(3)));
    expect(Math.abs(a2[a2.length - 1] - 512)).toBeLessThan(8);
  }, 300000);
});

describe('circuit check on a bare ATtiny85', () => {
  const wire = (a, b) => ({ from: { partId: a.split(':')[0], pin: a.split(':')[1] }, to: { partId: b.split(':')[0], pin: b.split(':')[1] } });
  const chip = { id: 'attiny85', type: 'impulse-attiny85', attrs: {} };
  const led = [{ id: 'r1', type: 'wokwi-resistor', attrs: { value: '220' } }, { id: 'led1', type: 'wokwi-led', attrs: {} }];
  const ledWires = [wire('attiny85:PB1', 'r1:1'), wire('r1:2', 'led1:A'), wire('led1:C', 'attiny85:GND')];
  const texts = async (model) => (await import('../checks.js')).circuitChecks(model).map(i => `${i.level}: ${i.text}`);

  test('asks for a supply, and accepts 3×AA on VCC', async () => {
    expect((await texts({ parts: [chip, ...led], wires: ledWires })).join('\n')).toMatch(/^info: Nothing powers the ATtiny85 yet/m);
    const bat = { id: 'bat', type: 'impulse-battery', attrs: { voltage: '4.5' } };
    const powered = { parts: [chip, ...led, bat], wires: [...ledWires, wire('bat:+', 'attiny85:VCC'), wire('bat:-', 'attiny85:GND')] };
    expect(await texts(powered)).toEqual([]);
  });

  test('a 9 V battery on VCC, or one too weak to run it', async () => {
    const at = (voltage) => ({
      parts: [chip, ...led, { id: 'bat', type: 'impulse-battery', attrs: { voltage } }],
      wires: [...ledWires, wire('bat:+', 'attiny85:VCC'), wire('bat:-', 'attiny85:GND')],
    });
    expect((await texts(at('9'))).join('\n')).toMatch(/^error: bat puts 9 V on the ATtiny85's VCC, which takes at most 5.5 V/m);
    expect((await texts(at('1.5'))).join('\n')).toMatch(/^warn: bat gives the ATtiny85 1.5 V, below the 2.7 V it needs/m);
  });

  test('a part on PB5, the RESET pin', async () => {
    const btn = { id: 'btn1', type: 'wokwi-pushbutton', attrs: {} };
    const issues = await texts({ parts: [chip, btn], wires: [wire('btn1:1.l', 'attiny85:PB5'), wire('btn1:2.l', 'attiny85:GND')] });
    expect(issues.join('\n')).toMatch(/^info: PB5 is the ATtiny85's RESET pin/m);
  });
});
