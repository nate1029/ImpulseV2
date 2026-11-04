import { BOARDS, boardForFqbn, boardPinNumber, boardPowerPin, parseBoardPin, pinLabel } from '../boards.js';
import { runHeadless } from '../headless.js';
import { AvrRunner, F_CPU } from '../avr-runner.js';
import { compileSketch, describeWithCli } from './cli.js';

describe('board profiles', () => {
  it('maps header pin names to Arduino pin numbers', () => {
    expect(boardPinNumber(BOARDS.uno, '13')).toBe(13);
    expect(boardPinNumber(BOARDS.uno, 'A0')).toBe(14);
    expect(boardPinNumber(BOARDS.uno, 'A4.2')).toBe(18);
    expect(boardPinNumber(BOARDS.uno, 'GND.1')).toBeNull();
    expect(boardPinNumber(BOARDS.uno, '14')).toBeNull();
    expect(boardPinNumber(BOARDS.nano, '13.2')).toBe(13);
    expect(boardPinNumber(BOARDS.nano, 'A7')).toBe(21);
    expect(boardPinNumber(BOARDS.mega, '53')).toBe(53);
    expect(boardPinNumber(BOARDS.mega, 'A15')).toBe(69);
    expect(boardPinNumber(BOARDS.mega, 'SDA')).toBe(20);
  });

  it('classifies power pins', () => {
    expect(boardPowerPin('GND.3')).toEqual({ kind: 'gnd', volts: 0 });
    expect(boardPowerPin('5V.2')).toEqual({ kind: 'vcc', volts: 5 });
    expect(boardPowerPin('3.3V')).toEqual({ kind: 'vcc', volts: 3.3 });
    expect(boardPowerPin('RESET.2')).toEqual({ kind: 'reset' });
    expect(boardPowerPin('7')).toBeNull();
  });

  it('parses pin references per board', () => {
    expect(parseBoardPin(BOARDS.uno, 'LED_BUILTIN')).toBe(13);
    expect(parseBoardPin(BOARDS.uno, 'A5')).toBe(19);
    expect(parseBoardPin(BOARDS.uno, 'A6')).toBeNull();
    expect(parseBoardPin(BOARDS.mega, 'A8')).toBe(62);
    expect(parseBoardPin(BOARDS.mega, 'D40')).toBe(40);
    expect(parseBoardPin(BOARDS.mega, 'SDA')).toBe(20);
    expect(pinLabel(BOARDS.mega, 62)).toBe('A8');
    expect(pinLabel(BOARDS.uno, 7)).toBe('D7');
  });

  it('knows which FQBNs it can simulate', () => {
    expect(boardForFqbn('arduino:avr:uno').id).toBe('uno');
    expect(boardForFqbn('arduino:avr:nano:cpu=atmega328old').id).toBe('nano');
    expect(boardForFqbn('arduino:avr:pro:cpu=16MHzatmega328').id).toBe('nano');
    expect(boardForFqbn('arduino:avr:mega:cpu=atmega2560').id).toBe('mega');
    expect(boardForFqbn('arduino:avr:mega')).not.toBeNull();
    expect(boardForFqbn('arduino:avr:leonardo').id).toBe('leonardo');
    expect(boardForFqbn('arduino:megaavr:uno2018')).toBeNull();
    expect(boardForFqbn('esp32:esp32:esp32').id).toBe('esp32');
    expect(boardForFqbn('esp32:esp32:esp32c6')).toBeNull();
  });

  it('refuses a program larger than the flash', () => {
    const runner = new AvrRunner();
    let error = '';
    runner.onError = (m) => { error = m; };
    const lines = [':020000040001F9', ':0400000000000000FC', ':00000001FF'];
    expect(runner.load(lines.join('\n'), 'uno')).toBe(false);
    expect(error).toMatch(/flash/);
  });
});

const PROBE = `
volatile unsigned long edges = 0;
void onEdge() { edges++; }
void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.println("ready");
}
void loop() {
  digitalWrite(LED_BUILTIN, HIGH); delay(100);
  digitalWrite(LED_BUILTIN, LOW); delay(100);
  Serial.print("a0="); Serial.println(analogRead(A0));
}
`;

describeWithCli('real firmware on every board (needs arduino-cli + arduino:avr)', () => {
  for (const id of ['uno', 'nano', 'mega']) {
    it(`runs Blink + Serial + analogRead on the ${BOARDS[id].label}`, async () => {
      const hex = compileSketch(PROBE, BOARDS[id].fqbn, `probe_${id}`);
      const run = await runHeadless(hex, {
        board: id,
        seconds: 1.05,
        setup: (r) => r.setAnalogVoltage(0, 2.5),
      });
      expect(run.serial).toContain('ready');
      expect(run.serial).toMatch(/a0=51[12]/);
      const rises = run.trace.filter(e => e.pin === 13 && e.high).map(e => e.t);
      expect(rises.length).toBeGreaterThanOrEqual(4);
      const period = (rises[rises.length - 1] - rises[0]) / (rises.length - 1);
      expect(period).toBeGreaterThan(0.19);
      expect(period).toBeLessThan(0.21);
    }, 120000);
  }

  it('drives Mega-only pins, timers, ADC channels, Serial1 and INT4', async () => {
    const hex = compileSketch(`
volatile int ticks = 0;
void onEdge() { ticks++; }
void setup() {
  Serial.begin(115200);
  Serial1.begin(9600);
  pinMode(44, OUTPUT);
  pinMode(22, INPUT_PULLUP);
  pinMode(49, OUTPUT);
  analogWrite(44, 64);
  analogWrite(9, 200);
  attachInterrupt(digitalPinToInterrupt(2), onEdge, FALLING);
  Serial1.print("S1");
  Serial.println("mega");
}
void loop() {
  digitalWrite(49, HIGH); delayMicroseconds(50); digitalWrite(49, LOW);
  Serial.print("a15="); Serial.print(analogRead(A15));
  Serial.print(" d22="); Serial.print(digitalRead(22));
  Serial.print(" ticks="); Serial.println(ticks);
  delay(20);
}
`, BOARDS.mega.fqbn, 'mega_features');
    const serial1 = [];
    const run = await runHeadless(hex, {
      board: 'mega',
      seconds: 0.3,
      setup: (r) => {
        r.setAnalogVoltage(15, 5);
        const prev = r.onSerial;
        r.onSerial = (ch, port) => { if (port === 1) serial1.push(ch); prev(ch, port); };
        // Toggle pin 2 (INT4) three times, 20 ms apart.
        for (let i = 1; i <= 6; i++) r.schedule(F_CPU * 0.02 * i, () => r.setInputPin(2, i % 2 === 0));
      },
    });
    expect(run.serial).toContain('mega');
    expect(run.serial).toMatch(/a15=102[23]/);
    expect(run.serial).toMatch(/d22=1/);
    expect(serial1.join('')).toBe('S1');
    expect(run.serial).toMatch(/ticks=2/);
    // PWM on 44 (timer 5) at ~490 Hz with 25 % duty, pulses on 49 (port L).
    const edges44 = run.trace.filter(e => e.pin === 44);
    expect(edges44.length).toBeGreaterThan(100);
    const highs = [];
    for (let i = 1; i < edges44.length; i++) if (!edges44[i].high && edges44[i - 1].high) highs.push(edges44[i].t - edges44[i - 1].t);
    const periodRises = edges44.filter(e => e.high).map(e => e.t);
    const period = (periodRises[periodRises.length - 1] - periodRises[0]) / (periodRises.length - 1);
    expect(1 / period).toBeGreaterThan(480);
    expect(1 / period).toBeLessThan(500);
    expect(highs[5] / period).toBeCloseTo(64 / 255, 1);
    expect(run.trace.filter(e => e.pin === 9).length).toBeGreaterThan(100);
    expect(run.trace.filter(e => e.pin === 49 && e.high).length).toBeGreaterThan(5);
  }, 120000);
});
