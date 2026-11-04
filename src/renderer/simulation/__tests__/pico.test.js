// The Raspberry Pi Pico: an RP2040 (rp2040js) running Arduino-Pico firmware
// through the same circuit engine and parts as the AVR boards.
import { flashImage } from '../rp2040-runner.js';
import { BOARDS, boardForFqbn, boardPinNumber, boardPowerPin, parseBoardPin, pinLabel } from '../boards.js';
import { parseExpectations, evaluateExpectations } from '../expectations.js';
import { runHeadless } from '../headless.js';
import { Bench } from './bench.js';
import { compileSketch, describeWithPico } from './cli.js';

const pico = BOARDS.pico;

/** A UF2 file: one 512-byte block per payload. */
function uf2(blocks) {
  const out = new Uint8Array(blocks.length * 512);
  const view = new DataView(out.buffer);
  blocks.forEach(({ addr, data, flags = 0x2000 }, i) => {
    const off = i * 512;
    view.setUint32(off, 0x0a324655, true);
    view.setUint32(off + 4, 0x9e5d5157, true);
    view.setUint32(off + 8, flags, true);
    view.setUint32(off + 12, addr, true);
    view.setUint32(off + 16, data.length, true);
    view.setUint32(off + 20, i, true);
    view.setUint32(off + 24, blocks.length, true);
    view.setUint32(off + 28, 0xe48bff56, true);
    out.set(data, off + 32);
    view.setUint32(off + 508, 0x0ab16f30, true);
  });
  return out;
}

describe('Raspberry Pi Pico board', () => {
  test('pin names and numbers follow Arduino-Pico', () => {
    expect(parseBoardPin(pico, 'GP15')).toBe(15);
    expect(parseBoardPin(pico, 'A0')).toBe(26);
    expect(parseBoardPin(pico, 'LED_BUILTIN')).toBe(25);
    expect(parseBoardPin(pico, 'SDA')).toBe(4);
    expect(boardPinNumber(pico, 'GP26')).toBe(26);
    expect(boardPinNumber(pico, 'GP0')).toBe(0);
    expect(boardPinNumber(pico, 'GND.3')).toBeNull();
    expect(pinLabel(pico, 13)).toBe('GP13');
    expect(boardPowerPin('3V3')).toEqual({ kind: 'vcc', volts: 3.3 });
    expect(boardPowerPin('VBUS')).toEqual({ kind: 'vcc', volts: 5 });
    expect(boardPowerPin('RUN')).toEqual({ kind: 'reset' });
    expect(boardForFqbn('rp2040:rp2040:rpipico')).toBe(pico);
    expect(boardForFqbn('rp2040:rp2040:rpipicow')).toBeNull();
    expect(pico).toMatchObject({ logicVolts: 3.3, threshold: 1.65, maxPinVolts: 3.3 });
  });

  test('UF2 images become flash blocks', () => {
    const image = uf2([
      { addr: 0x10000000, data: Uint8Array.of(1, 2, 3) },
      { addr: 0x10000100, data: Uint8Array.of(4) },
      { addr: 0x20000000, data: Uint8Array.of(9), flags: 1 }, // not main flash: skipped
    ]);
    const blocks = flashImage(image);
    expect(blocks.map(b => [b.addr, Array.from(b.data)])).toEqual([[0x10000000, [1, 2, 3]], [0x10000100, [4]]]);
    expect(flashImage(Uint8Array.of(1, 2, 3))).toEqual([{ addr: 0x10000000, data: Uint8Array.of(1, 2, 3) }]);
    expect(() => flashImage(uf2([{ addr: 0x08000000, data: Uint8Array.of(1) }]))).toThrow(/not an RP2040 flash image/);
  });
});

const build = (code, name) => compileSketch(code, pico.fqbn, name);

describeWithPico('Arduino-Pico firmware on the simulated Pico', () => {
  test('Serial over USB, the LED on GP25 and @expect lines', async () => {
    const code = `
// @run 1s
// @expect serial contains "tick 3"
// @expect pin LED_BUILTIN frequency 5Hz ±5%
int n = 0;
void setup() {
  Serial.begin(115200);
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
    const run = await runHeadless(build(code, 'pico_blink'), { seconds: 1, board: 'pico' });
    expect(run.board).toBe('pico');
    const { items } = parseExpectations(code, 'pico');
    for (const r of evaluateExpectations(items, run, 'pico')) expect({ check: r.raw, pass: r.pass, detail: r.detail }).toMatchObject({ pass: true });
  }, 300000);

  test('a button on an input with a pull-up, an interrupt, and an LED', () => {
    const hex = build(`
volatile int presses = 0;
void onPress() { presses++; }
void setup() {
  Serial.begin(115200);
  pinMode(15, INPUT_PULLUP);
  pinMode(16, OUTPUT);
  attachInterrupt(digitalPinToInterrupt(15), onPress, FALLING);
}
void loop() {
  digitalWrite(16, digitalRead(15) == LOW);
  static int last = 0;
  if (presses != last) { last = presses; Serial.print("presses="); Serial.println(presses); }
  delay(5);
}`, 'pico_button');
    const b = new Bench('pico');
    b.add('wokwi-pushbutton', 'btn1');
    b.add('wokwi-led', 'led1', { color: 'green' });
    b.add('wokwi-resistor', 'r1', { value: '220' });
    b.wire('btn1:1.l', 'pico:GP15', 'btn1:2.l', 'pico:GND.4', 'pico:GP16', 'r1:1', 'r1:2', 'led1:A', 'led1:C', 'pico:GND.6');
    b.load(hex).run(0.3);
    expect(b.part('led1').el.value).toBe(false);
    b.run(0.2, [[0, (x) => x.behavior('btn1').set(true)]]);
    expect(b.part('led1').el.value).toBe(true);
    b.run(0.2, [[0, (x) => x.behavior('btn1').set(false)]]);
    b.run(0.2, [[0, (x) => x.behavior('btn1').set(true)]]);
    expect(b.serial).toContain('presses=2');
  }, 300000);

  test('analogRead against the 3.3 V reference, and PWM brightness', () => {
    const hex = build(`
void setup() {
  Serial.begin(115200);
  analogWrite(16, 64);
}
void loop() {
  Serial.println(analogRead(A0));
  delay(50);
}`, 'pico_analog');
    const b = new Bench('pico');
    b.add('wokwi-potentiometer', 'pot1', { value: '512' });
    b.add('wokwi-led', 'led1', { color: 'red' });
    b.add('wokwi-resistor', 'r1', { value: '220' });
    b.wire('pot1:VCC', 'pico:3V3', 'pot1:GND', 'pico:AGND', 'pot1:SIG', 'pico:GP26',
      'pico:GP16', 'r1:1', 'r1:2', 'led1:A', 'led1:C', 'pico:GND.6');
    b.load(hex).run(0.4);
    // Arduino-Pico reads 10 bits by default: half of 3.3 V is about 512.
    const readings = b.lines().map(Number).filter(Number.isFinite);
    expect(Math.abs(readings[readings.length - 1] - 512)).toBeLessThan(12);
    // analogWrite(64) of 255: a quarter duty cycle.
    expect(b.part('led1').el.brightness).toBeGreaterThan(0.15);
    expect(b.part('led1').el.brightness).toBeLessThan(0.35);
  }, 300000);

  test('Serial1 on UART0, and I²C on GP4/GP5 to a simulated MPU6050', () => {
    const hex = build(`
#include <Wire.h>
void setup() {
  Serial1.begin(9600);
  Wire.begin();
  Wire.beginTransmission(0x68);
  Wire.write(0x75); // WHO_AM_I
  Wire.endTransmission(false);
  Wire.requestFrom(0x68, 1);
  Serial1.print("who=");
  Serial1.println(Wire.read(), HEX);
}
void loop() {}`, 'pico_i2c');
    const b = new Bench('pico');
    b.add('wokwi-mpu6050', 'imu1');
    b.wire('imu1:SDA', 'pico:GP4', 'imu1:SCL', 'pico:GP5', 'imu1:VCC', 'pico:3V3', 'imu1:GND', 'pico:GND.2');
    let uart = '';
    b.load(hex);
    const prev = b.runner.onSerial;
    b.runner.onSerial = (ch, port) => { if (port === 1) uart += ch; prev?.(ch, port); };
    b.run(0.3);
    expect(uart).toContain('who=68');
  }, 300000);
});

describe('switching between an Uno and a Pico', () => {
  test('wires follow the same Arduino pins and supplies', async () => {
    const { remapBoardWires } = await import('../diagram.js');
    const wires = [
      { from: { partId: 'uno', pin: '13' }, to: { partId: 'led1', pin: 'A' } },
      { from: { partId: 'uno', pin: 'A0' }, to: { partId: 'pot1', pin: 'SIG' } },
      { from: { partId: 'uno', pin: '5V' }, to: { partId: 'pot1', pin: 'VCC' } },
      { from: { partId: 'uno', pin: '3.3V' }, to: { partId: 'x', pin: 'VCC' } },
      { from: { partId: 'uno', pin: 'GND.1' }, to: { partId: 'led1', pin: 'C' } },
    ];
    const toPico = remapBoardWires(wires, 'uno', 'wokwi-arduino-uno', 'impulse-pi-pico');
    expect(toPico.dropped).toEqual([]);
    expect(toPico.wires.map(w => w.from.pin)).toEqual(['GP13', 'GP26', 'VBUS', '3V3', 'GND.1']);
    const back = remapBoardWires(toPico.wires, 'uno', 'impulse-pi-pico', 'wokwi-arduino-uno');
    expect(back.wires.map(w => w.from.pin)).toEqual(['13', 'A0', '5V', '3.3V', 'GND.1']);
  });
});

describe('circuit check on a 3.3 V board', () => {
  test('5 V on a Pico pin is caught', async () => {
    const { circuitChecks } = await import('../checks.js');
    const base = { id: 'pico', type: 'impulse-pi-pico', attrs: {} };
    const sonar = {
      parts: [base, { id: 'sonar', type: 'wokwi-hc-sr04', attrs: {} }],
      wires: [
        ['sonar:VCC', 'pico:VBUS'], ['sonar:GND', 'pico:GND.1'], ['sonar:TRIG', 'pico:GP2'], ['sonar:ECHO', 'pico:GP3'],
      ].map(([a, b]) => ({ from: { partId: a.split(':')[0], pin: a.split(':')[1] }, to: { partId: b.split(':')[0], pin: b.split(':')[1] } })),
    };
    const issues = circuitChecks(sonar).map(i => i.text);
    expect(issues.some(t => /runs from 5 V, so TRIG, ECHO can reach 5 V on a Pico pin that takes at most 3.3 V/.test(t))).toBe(true);
    const battery = {
      parts: [base, { id: 'bat', type: 'impulse-battery', attrs: { voltage: '4.5' } }],
      wires: [{ from: { partId: 'bat', pin: '+' }, to: { partId: 'pico', pin: 'GP5' } }, { from: { partId: 'bat', pin: '-' }, to: { partId: 'pico', pin: 'GND.2' } }],
    };
    expect(circuitChecks(battery).map(i => i.text).join('\n')).toMatch(/puts 4.5 V straight onto GP5\. Pico pins take at most 3.3 V/);
    const onVsys = { ...battery, wires: [{ from: { partId: 'bat', pin: '+' }, to: { partId: 'pico', pin: 'VSYS' } }, battery.wires[1]] };
    expect(circuitChecks(onVsys).filter(i => i.level === 'error')).toEqual([]);
  });
});
