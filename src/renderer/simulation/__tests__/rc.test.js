// Capacitors charge and discharge through their resistors in simulated time,
// and real firmware sees the result: ADC curves, input thresholds, PWM smoothing.
import process from 'process';
import { Circuit, solveIsland } from '../netlist.js';
import { parseCapacitance } from '../parts/catalog.js';
import { Bench } from './bench.js';
import { compileSketch, describeWithCli } from './cli.js';
import { BOARDS } from '../boards.js';

describe('RC transients in the netlist', () => {
  // 5 V → 10 kΩ → node "n" → 100 µF → GND: τ = 1 s.
  const circuit = () => new Circuit({
    nodes: ['vcc', 'n', 'gnd'],
    resistors: [['vcc', 'n', 10e3]],
    capacitors: [['n', 'gnd', 100e-6, 'c1']],
  });
  const sources = (vcc) => (c) => (net) => {
    if (net === c.netOf('vcc')) return [{ volts: vcc }];
    if (net === c.netOf('gnd')) return [{ volts: 0 }];
    return [];
  };

  test('charges along 5·(1 − e^(−t/τ))', () => {
    const c = circuit();
    const island = c.islandOf[c.netOf('n')];
    const capVolts = new Float64Array(1);
    const src = sources(5)(c);
    // The instant the supply appears, the capacitor still holds 0 V.
    expect(solveIsland(c, island, src, { dt: 0, capVolts }).volts.get(c.netOf('n'))).toBeCloseTo(0, 3);
    let t = 0;
    for (; t < 1 - 1e-9; t += 1e-3) solveIsland(c, island, src, { dt: 1e-3, capVolts });
    expect(capVolts[0]).toBeCloseTo(5 * (1 - Math.exp(-1)), 2); // 3.16 V
    for (; t < 5 - 1e-9; t += 1e-3) solveIsland(c, island, src, { dt: 1e-3, capVolts });
    expect(capVolts[0]).toBeGreaterThan(4.95);
  });

  test('discharges, and is open at DC without a time step', () => {
    const c = circuit();
    const island = c.islandOf[c.netOf('n')];
    const capVolts = Float64Array.of(5);
    const src = sources(0)(c);
    for (let t = 0; t < 1 - 1e-9; t += 1e-3) solveIsland(c, island, src, { dt: 1e-3, capVolts });
    expect(capVolts[0]).toBeCloseTo(5 * Math.exp(-1), 2); // 1.84 V
    // DC operating point: no current flows into the capacitor, so the node sits at the supply.
    expect(solveIsland(c, island, sources(5)(c)).volts.get(c.netOf('n'))).toBeCloseTo(5, 6);
  });

  test('a large step is stable (backward Euler)', () => {
    const c = circuit();
    const island = c.islandOf[c.netOf('n')];
    const capVolts = new Float64Array(1);
    solveIsland(c, island, sources(5)(c), { dt: 100, capVolts });
    expect(capVolts[0]).toBeGreaterThan(4.9);
    expect(capVolts[0]).toBeLessThanOrEqual(5);
  });

  test('capacitance values', () => {
    expect(parseCapacitance('100nF')).toBeCloseTo(100e-9, 15);
    expect(parseCapacitance('10uF')).toBeCloseTo(10e-6, 12);
    expect(parseCapacitance('4.7µF')).toBeCloseTo(4.7e-6, 12);
    expect(parseCapacitance('22pF')).toBeCloseTo(22e-12, 18);
    expect(parseCapacitance('1mF')).toBeCloseTo(1e-3, 9);
    expect(parseCapacitance('0.1u')).toBeCloseTo(100e-9, 15);
    expect(parseCapacitance('banana')).toBe(100e-9);
  });
});

const uno = (code, name) => compileSketch(code, BOARDS.uno.fqbn, name);
const adc = (volts) => Math.round((volts / 5) * 1023);

describeWithCli('RC circuits on a simulated Uno', () => {
  function rcBench(ohms, cap, { from = '8', to = 'A0' } = {}) {
    const b = new Bench('uno');
    b.add('wokwi-resistor', 'r1', { value: String(ohms) });
    b.add('impulse-capacitor', 'c1', { value: cap, type: 'electrolytic' });
    b.wire(`uno:${from}`, 'r1:1', 'r1:2', `uno:${to}`, 'r1:2', 'c1:1', 'c1:2', 'uno:GND.1');
    return b;
  }

  test('analogRead follows the charging and discharging curve', () => {
    const hex = uno(`
void setup() {
  Serial.begin(115200);
  pinMode(8, OUTPUT);
  digitalWrite(8, HIGH);
  for (int i = 0; i <= 6; i++) {
    Serial.println(analogRead(A0));
    delay(500);
  }
  digitalWrite(8, LOW);
  delay(1000);
  Serial.println(analogRead(A0));
}
void loop() {}`, 'rc_charge');
    const b = rcBench(10000, '100uF').load(hex).run(4.6);
    const values = b.serial.trim().split(/\r?\n/).map(Number);
    if (process.env.RC_REPORT) console.log('curve', values.join(' '), [0, 1, 2, 3, 4, 5, 6].map(i => adc(5 * (1 - Math.exp(-i * 0.5)))).join(' '));
    expect(values).toHaveLength(8);
    // τ = 10 kΩ × 100 µF = 1 s; readings every 0.5 s.
    for (let i = 0; i <= 6; i++) {
      const expected = adc(5 * (1 - Math.exp(-i * 0.5)));
      expect(Math.abs(values[i] - expected)).toBeLessThanOrEqual(Math.max(6, expected * 0.015));
    }
    const discharged = adc(5 * (1 - Math.exp(-3.5)) * Math.exp(-1));
    expect(Math.abs(values[7] - discharged)).toBeLessThanOrEqual(8);
    expect(b.behavior('c1').status()).toMatch(/^\d\.\d\d V across it$/);
  }, 120000);

  test('a digital input sees the threshold after τ·ln 2', () => {
    const hex = uno(`
void setup() {
  Serial.begin(115200);
  pinMode(2, INPUT);
  pinMode(7, OUTPUT);
  digitalWrite(7, HIGH);
  unsigned long t0 = micros();
  while (digitalRead(2) == LOW) {}
  Serial.println(micros() - t0);
}
void loop() {}`, 'rc_threshold');
    const b = rcBench(10000, '10uF', { from: '7', to: '2' }).load(hex).run(0.3);
    const micros = Number(b.serial.trim());
    const expected = 0.1 * Math.log(2) * 1e6; // 69.3 ms
    if (process.env.RC_REPORT) console.log('threshold', micros, expected);
    expect(Math.abs(micros - expected) / expected).toBeLessThan(0.01);
  }, 120000);

  test('an RC filter turns PWM into a steady voltage', () => {
    const hex = uno(`
void setup() {
  Serial.begin(115200);
  analogWrite(9, 128);
  delay(1500);
  int lo = 1023, hi = 0;
  for (int i = 0; i < 200; i++) {
    int v = analogRead(A0);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  Serial.print(lo);
  Serial.print(' ');
  Serial.println(hi);
}
void loop() {}`, 'rc_pwm');
    const b = rcBench(10000, '10uF', { from: '9', to: 'A0' }).load(hex).run(1.8);
    const [lo, hi] = b.serial.trim().split(' ').map(Number);
    const mean = (128 / 255) * 1023;
    if (process.env.RC_REPORT) console.log('pwm', lo, hi, mean);
    // τ = 0.1 s against a 490 Hz PWM: a small ripple around the duty cycle.
    expect(Math.abs((lo + hi) / 2 - mean)).toBeLessThan(15);
    expect(hi - lo).toBeLessThan(15);
  }, 120000);
});
