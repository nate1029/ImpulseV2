// Logic, power and starter-kit parts end to end: gates and flip-flops driven
// by the Arduino and by other parts, batteries, diodes, MOSFETs, DS18B20 on
// 1-Wire, TM1637, 28BYJ-48 + ULN2003 and the L298N.
import { Bench } from './bench.js';
import { compileSketch, describeWithCli, installedLibraries } from './cli.js';
import { BOARDS } from '../boards.js';
import { Ds18b20, crc8, romFor } from '../devices/ds18b20.js';
import { TM1637 } from '../devices/tm1637.js';

const LIBS = installedLibraries();
const withLibs = (...names) => (names.every(n => LIBS.has(n.toLowerCase())) ? it : it.skip);
const uno = (code, name) => compileSketch(code, BOARDS.uno.fqbn, name);
const T = 120000;
const IDLE = 'void setup() {}\nvoid loop() {}';

describe('DS18B20 device', () => {
  it('builds valid ROM codes and scratchpads', () => {
    const rom = romFor('t1');
    expect(rom[0]).toBe(0x28);
    expect(crc8(rom.slice(0, 7))).toBe(rom[7]);
    expect(romFor('t1')).toEqual(rom);
    expect(romFor('t2')).not.toEqual(rom);
    const dev = new Ds18b20(rom, () => 25.0625);
    const pad = dev.scratchpad();
    expect(crc8(pad.slice(0, 8))).toBe(pad[8]);
    expect(pad[0] | (pad[1] << 8)).toBe(85 * 16); // power-on value
  });

  it('converts at the configured resolution', () => {
    const dev = new Ds18b20(romFor('x'), () => -10.3);
    const send = (byte) => { for (let i = 0; i < 8; i++) dev.writeSlot((byte >> i) & 1, 0); };
    dev.reset(); send(0xcc); send(0x44);
    expect(dev.readSlot(0.1)).toBe(0); // still converting (750 ms at 12 bits)
    expect(dev.readSlot(0.8)).toBe(1);
    const raw = dev.raw;
    expect(raw).toBe(Math.round(-10.3 * 16));
  });
});

describe('TM1637 decoder', () => {
  it('takes a data command, an address and four digits', () => {
    const chip = new TM1637();
    const byte = (b) => {
      for (let i = 0; i < 8; i++) { chip.clockRise((b >> i) & 1); chip.clockFall(); }
      chip.clockRise(0);
      expect(chip.clockFall()).toBe('release');
    };
    chip.start(); byte(0x40); chip.stop();
    chip.start(); byte(0xc0); [0x3f, 0x06, 0x5b, 0x4f].forEach(byte); chip.stop();
    chip.start(); byte(0x8a); chip.stop();
    expect(chip.digits.slice(0, 4)).toEqual([0x3f, 0x06, 0x5b, 0x4f]);
    expect(chip.on).toBe(true);
    expect(chip.brightness).toBe(2);
  });
});

describeWithCli('logic, power and kit parts', () => {
  it('evaluates gates driven by the Arduino and by another gate', () => {
    const hex = uno(`
void setup() {
  Serial.begin(115200);
  pinMode(2, OUTPUT); pinMode(3, OUTPUT);
  for (int v = 0; v < 4; v++) {
    digitalWrite(2, v & 1); digitalWrite(3, (v >> 1) & 1);
    delayMicroseconds(5);
    Serial.print(v & 1); Serial.print((v >> 1) & 1); Serial.print(' ');
    for (int p = 4; p <= 9; p++) Serial.print(digitalRead(p));
    Serial.println();
  }
}
void loop() {}`, 'gates');
    const b = new Bench('uno');
    const gates = [['and', 4], ['or', 5], ['nand', 6], ['nor', 7], ['xor', 8]];
    for (const [g, pin] of gates) {
      b.add(`impulse-gate-${g}`, g);
      b.wire(`${g}:A`, 'uno:2', `${g}:B`, 'uno:3', `${g}:Y`, `uno:${pin}`);
    }
    // NOT fed by the AND gate: NOT(A AND B) on pin 9.
    b.add('impulse-gate-not', 'not');
    b.wire('not:A', 'and:Y', 'not:Y', 'uno:9');
    b.load(hex).run(0.05);
    expect(b.lines()).toEqual(['00 001101', '10 011011', '01 011011', '11 110000']);
    expect(b.shorts).toEqual([]);
  }, T);

  it('reacts to a pushbutton on a gate input and clocks a D flip-flop', () => {
    const hex = uno(`
void setup() {
  Serial.begin(115200);
  pinMode(10, OUTPUT); pinMode(11, OUTPUT);
  digitalWrite(10, HIGH); delayMicroseconds(5); Serial.print(digitalRead(12));
  digitalWrite(11, HIGH); delayMicroseconds(5); Serial.print(digitalRead(12)); Serial.print(digitalRead(A0));
  digitalWrite(10, LOW); delayMicroseconds(5); Serial.print(digitalRead(12));
  digitalWrite(11, LOW); digitalWrite(11, HIGH); delayMicroseconds(5); Serial.println(digitalRead(12));
}
void loop() { static int last = -1; int v = digitalRead(4); if (v != last) { Serial.print("Y="); Serial.println(v); last = v; } }`, 'dff');
    const b = new Bench('uno');
    b.add('impulse-flipflop-d', 'ff');
    b.wire('ff:D', 'uno:10', 'ff:CLK', 'uno:11', 'ff:Q', 'uno:12', 'ff:QN', 'uno:A0');
    b.add('impulse-gate-and', 'g');
    b.add('wokwi-pushbutton', 'btn');
    b.wire('btn:1.l', 'uno:5V', 'btn:2.l', 'g:A', 'g:B', 'uno:5V', 'g:Y', 'uno:4');
    b.load(hex).run(0.1);
    b.run(0.2, [[0.05, () => b.behavior('btn').set(true)], [0.15, () => b.behavior('btn').set(false)]]);
    expect(b.lines()).toEqual(['01010', 'Y=0', 'Y=1', 'Y=0']);
  }, T);

  it('lights an LED from a battery, and only with the loop closed', () => {
    const b = new Bench('uno');
    for (const [id, closed] of [['a', true], ['b', false]]) {
      b.add('impulse-battery', `bat_${id}`, { voltage: '9' });
      b.add('wokwi-resistor', `r_${id}`, { value: '470' });
      b.add('wokwi-led', `led_${id}`);
      b.wire(`bat_${id}:+`, `r_${id}:1`, `r_${id}:2`, `led_${id}:A`);
      if (closed) b.wire(`led_${id}:C`, `bat_${id}:-`);
    }
    b.load(uno(IDLE, 'idle')).run(0.05);
    expect(b.part('led_a').el.value).toBe(true);
    expect(b.part('led_b').el.value).toBe(false);
  }, T);

  it('passes current one way through a diode and switches a load with a MOSFET', () => {
    const hex = uno(`
void setup() { pinMode(7, OUTPUT); pinMode(8, OUTPUT); pinMode(9, OUTPUT); digitalWrite(7, HIGH); digitalWrite(8, HIGH); }
void loop() { digitalWrite(9, HIGH); delay(100); digitalWrite(9, LOW); delay(100); }`, 'diode_fet');
    const b = new Bench('uno');
    b.add('impulse-diode', 'd1'); b.add('wokwi-led', 'led1');
    b.wire('uno:8', 'd1:A', 'd1:C', 'led1:A', 'led1:C', 'uno:GND.1');
    b.add('impulse-diode', 'd2'); b.add('wokwi-led', 'led2');
    b.wire('uno:7', 'd2:C', 'd2:A', 'led2:A', 'led2:C', 'uno:GND.1');
    b.add('impulse-mosfet', 'q1'); b.add('wokwi-resistor', 'r3', { value: '220' }); b.add('wokwi-led', 'led3');
    b.wire('uno:9', 'q1:G', 'uno:5V', 'r3:1', 'r3:2', 'led3:A', 'led3:C', 'q1:D', 'q1:S', 'uno:GND.2');
    b.load(hex).run(0.05);
    expect(b.part('led1').el.value).toBe(true);
    expect(b.part('led2').el.value).toBe(false);
    expect(b.part('led3').el.value).toBe(true);
    b.run(0.1);
    expect(b.part('led3').el.value).toBe(false);
    expect(b.shorts).toEqual([]);
  }, T);

  withLibs('OneWire', 'DallasTemperature')('reads two DS18B20s on one 1-Wire bus with DallasTemperature', () => {
    const hex = uno(`
#include <OneWire.h>
#include <DallasTemperature.h>
OneWire bus(2);
DallasTemperature sensors(&bus);
void setup() {
  Serial.begin(115200);
  sensors.begin();
  Serial.print("devices="); Serial.println(sensors.getDeviceCount());
  sensors.requestTemperatures();
  Serial.print("t0="); Serial.println(sensors.getTempCByIndex(0), 2);
  Serial.print("t1="); Serial.println(sensors.getTempCByIndex(1), 2);
}
void loop() {}`, 'ds18b20');
    const b = new Bench('uno');
    b.add('impulse-ds18b20', 't1', { temperature: '22.5' });
    b.add('impulse-ds18b20', 't2', { temperature: '-10.25' });
    b.wire('t1:DQ', 'uno:2', 't2:DQ', 'uno:2', 't1:VCC', 'uno:5V', 't2:VCC', 'uno:5V', 't1:GND', 'uno:GND.1', 't2:GND', 'uno:GND.1');
    b.load(hex).run(1.6);
    const lines = b.lines();
    expect(lines[0]).toBe('devices=2');
    const temps = [lines[1], lines[2]].map(l => Number(l.split('=')[1])).sort((x, y) => x - y);
    expect(temps).toEqual([-10.25, 22.5]);
  }, T);

  withLibs('TM1637')('shows digits and the colon on a TM1637 with TM1637Display', () => {
    const hex = uno(`
#include <TM1637Display.h>
TM1637Display display(2, 3);
void setup() { display.setBrightness(5); display.showNumberDecEx(1234, 0b01000000, true); }
void loop() {}`, 'tm1637');
    const b = new Bench('uno');
    b.add('impulse-tm1637', 'disp');
    b.wire('disp:CLK', 'uno:2', 'disp:DIO', 'uno:3', 'disp:VCC', 'uno:5V', 'disp:GND', 'uno:GND.1');
    b.load(hex).run(0.1);
    expect(b.part('disp').el.segments).toEqual([0x06, 0x5b | 0x80, 0x4f, 0x66]);
    expect(b.part('disp').el.on).toBe(true);
    expect(b.part('disp').el.brightness).toBe(5);
    expect(b.shorts).toEqual([]);
  }, T);

  withLibs('Stepper')('turns a 28BYJ-48 a quarter turn with the Stepper library', () => {
    const hex = uno(`
#include <Stepper.h>
Stepper motor(2048, 8, 10, 9, 11);
void setup() { motor.setSpeed(12); motor.step(512); }
void loop() {}`, 'byj');
    const b = new Bench('uno');
    b.add('impulse-stepper-28byj48', 'm');
    b.wire('m:IN1', 'uno:8', 'm:IN2', 'uno:9', 'm:IN3', 'uno:10', 'm:IN4', 'uno:11', 'm:VCC', 'uno:5V', 'm:GND', 'uno:GND.1');
    b.load(hex).run(1.5);
    expect(Math.round(b.behavior('m').steps)).toBe(512);
    expect(b.part('m').el.angle).toBeCloseTo(90, 0);
  }, T);

  it('drives a DC motor through an L298N with PWM on ENA', () => {
    const hex = uno(`
void setup() { pinMode(7, OUTPUT); pinMode(6, OUTPUT); digitalWrite(7, HIGH); digitalWrite(6, LOW); analogWrite(5, 128); }
void loop() {}`, 'l298n');
    const b = new Bench('uno');
    b.add('impulse-l298n', 'drv');
    b.add('impulse-dc-motor', 'motor');
    b.wire('drv:IN1', 'uno:7', 'drv:IN2', 'uno:6', 'drv:ENA', 'uno:5', 'drv:OUT1', 'motor:A', 'drv:OUT2', 'motor:B', 'drv:GND', 'uno:GND.1');
    b.load(hex).run(1.0);
    const rpm = b.behavior('motor').rpm;
    expect(rpm).toBeGreaterThan(70);
    expect(rpm).toBeLessThan(130);
  }, T);
});
