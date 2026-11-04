// The ATmega32U4 boards (Leonardo, Micro, Yún…), whose Serial is the chip's
// own USB port: the simulated USB controller and the host that enumerates it.
// Also Timer4's PWM, the ATmega8 (Arduino NG) and the 8 MHz boards that run at
// the simulator's 16 MHz.
import { BOARDS, simulationTarget, boardPinNumber, parseBoardPin } from '../boards.js';
import { runHeadless } from '../headless.js';
import { F_CPU } from '../avr-runner.js';
import { compileSketch, describeWithCli } from './cli.js';

const leo = BOARDS.leonardo;

describe('ATmega32U4 boards', () => {
  test('every 32U4 board runs on the Leonardo, 8 MHz ones compiled for 16 MHz', () => {
    expect(simulationTarget('arduino:avr:leonardo')).toMatchObject({ board: leo, fqbn: 'arduino:avr:leonardo', mcu: 'atmega32u4', note: undefined });
    for (const id of ['leonardoeth', 'micro', 'esplora', 'yun', 'yunmini', 'chiwawa', 'one', 'robotControl', 'robotMotor']) {
      expect(simulationTarget(`arduino:avr:${id}`)).toMatchObject({ board: leo, fqbn: `arduino:avr:${id}`, note: expect.stringMatching(/ATmega32U4/) });
    }
    for (const id of ['LilyPadUSB', 'circuitplay32u4cat']) {
      expect(simulationTarget(`arduino:avr:${id}`)).toMatchObject({ board: leo, properties: { 'build.f_cpu': '16000000L' }, note: expect.stringMatching(/16 MHz/) });
    }
  });

  test('Leonardo pins: A0-A5 are 18-23, SDA/SCL are 2/3, A6-A11 share digital pins', () => {
    expect(parseBoardPin(leo, 'A0')).toBe(18);
    expect(parseBoardPin(leo, 'A5')).toBe(23);
    expect(parseBoardPin(leo, 'SDA')).toBe(2);
    expect(boardPinNumber(leo, 'A4.2')).toBe(2);
    expect(boardPinNumber(leo, '4')).toBe(4);
    expect(leo.byPin.get(4).adc).toBe(8);
    expect(leo.byPin.get(12).adc).toBe(9);
    expect(leo.byPin.get(18)).toMatchObject({ port: 'F', bit: 7, adc: 7 });
  });

  test('the Gemma, the Uno WiFi and Arduino NG (ATmega8 or 168) run too', () => {
    expect(simulationTarget('arduino:avr:gemma')).toMatchObject({ board: BOARDS.attiny85, mcu: 'attiny85-gemma', properties: { 'build.f_cpu': '16000000L' } });
    expect(simulationTarget('arduino:avr:unowifi').board).toBe(BOARDS.uno);
    expect(simulationTarget('arduino:avr:atmegang:cpu=atmega8')).toMatchObject({ board: BOARDS.uno, mcu: 'atmega8' });
    expect(simulationTarget('arduino:avr:atmegang:cpu=atmega168')).toMatchObject({ mcu: 'atmega168' });
  });
});

/** Run a program headless, recording each Serial port and typing into Serial after `typeAt` seconds. */
async function run(hex, board, seconds, { mcu, type, typeAt = 0.5 } = {}) {
  const ports = {};
  const result = await runHeadless(hex, {
    seconds, board, mcu,
    setup: (runner) => {
      const prev = runner.onSerial;
      runner.onSerial = (ch, port) => { ports[port] = (ports[port] || '') + ch; prev?.(ch, port); };
      if (type) runner.schedule(typeAt * F_CPU, () => runner.serialWrite(type, 0));
    },
  });
  return { ...result, ports };
}

/** Duty cycle and frequency of a pin from a run's trace, after `from` seconds. */
function pwm(trace, pin, from = 0.05) {
  const ev = trace.filter(e => e.pin === pin && e.t > from);
  let high = 0;
  let total = 0;
  for (let i = 0; i + 1 < ev.length; i++) {
    const dt = ev[i + 1].t - ev[i].t;
    total += dt;
    if (ev[i].high) high += dt;
  }
  const rises = ev.filter(e => e.high).map(e => e.t);
  return { duty: total ? high / total : 0, hz: rises.length >= 2 ? (rises.length - 1) / (rises.at(-1) - rises[0]) : 0 };
}

describeWithCli('Leonardo firmware', () => {
  test('USB Serial: the board enumerates, sees DTR, prints and reads what is typed; Serial1 is pins 0/1', async () => {
    const hex = compileSketch(`
void setup() {
  Serial.begin(9600);
  while (!Serial);
  Serial1.begin(9600);
  pinMode(13, OUTPUT);
  Serial.println("hello usb");
  Serial1.println("hello uart");
}
void loop() {
  digitalWrite(13, !digitalRead(13));
  Serial.print("t=");
  Serial.println(millis());
  while (Serial.available()) { Serial.print("got "); Serial.println((char)Serial.read()); }
  delay(200);
}`, leo.fqbn, 'leo_usb');
    const r = await run(hex, 'leonardo', 1.2, { type: 'xy' });
    expect(r.ports[0]).toMatch(/^hello usb\r\nt=\d+\r\n/);
    expect(r.ports[0]).toContain('got x\r\ngot y\r\n');
    expect(r.ports[1]).toBe('hello uart\r\n');
    expect(r.trace.filter(e => e.pin === 13).length).toBeGreaterThanOrEqual(5);
  }, 120000);

  test('analogWrite: Timer4 on pins 13 and 6, Timer1 on 10, Timer3 on 5, all at 490 Hz', async () => {
    const hex = compileSketch(`
void setup() { analogWrite(13, 64); analogWrite(6, 192); analogWrite(10, 128); analogWrite(5, 32); }
void loop() {}`, leo.fqbn, 'leo_pwm');
    const r = await run(hex, 'leonardo', 0.2);
    for (const [pin, duty] of [[13, 0.25], [6, 0.75], [10, 0.5], [5, 0.125]]) {
      const m = pwm(r.trace, pin);
      expect(Math.abs(m.duty - duty)).toBeLessThan(0.01);
      expect(Math.abs(m.hz - 490)).toBeLessThan(5);
    }
  }, 120000);

  test('a LilyPad USB (8 MHz) compiled for 16 MHz keeps time', async () => {
    const t = simulationTarget('arduino:avr:LilyPadUSB');
    const hex = compileSketch(`
// @expect pin 13 frequency 2Hz
void setup() { pinMode(13, OUTPUT); }
void loop() { digitalWrite(13, HIGH); delay(250); digitalWrite(13, LOW); delay(250); }`, t.fqbn, 'lilypad_usb', t.properties);
    const r = await run(hex, 'leonardo', 1.5);
    const m = pwm(r.trace, 13, 0.1);
    expect(Math.abs(m.hz - 2)).toBeLessThan(0.05);
  }, 120000);
});

describeWithCli('ATmega8 firmware (Arduino NG)', () => {
  test('millis, Serial, analogRead and PWM on Timer1 and the split TCCR2', async () => {
    const t = simulationTarget('arduino:avr:atmegang:cpu=atmega8');
    const hex = compileSketch(`
void setup() { Serial.begin(9600); pinMode(13, OUTPUT); analogWrite(9, 64); analogWrite(11, 192); }
void loop() {
  digitalWrite(13, HIGH); delay(250); digitalWrite(13, LOW); delay(250);
  Serial.print("a0="); Serial.print(analogRead(A0)); Serial.print(" ms="); Serial.println(millis());
}`, t.fqbn, 'ng_atmega8');
    const r = await run(hex, 'uno', 1.2, { mcu: t.mcu });
    const times = [...r.ports[0].matchAll(/^a0=\d+ ms=(\d+)\r$/gm)].map(m => Number(m[1]));
    expect(times.slice(0, 2).map(t => Math.round(t / 100))).toEqual([5, 10]);
    expect(Math.abs(pwm(r.trace, 13, 0.1).hz - 2)).toBeLessThan(0.05);
    expect(Math.abs(pwm(r.trace, 9).duty - 0.25)).toBeLessThan(0.01);
    expect(Math.abs(pwm(r.trace, 11).duty - 0.75)).toBeLessThan(0.01);
  }, 120000);
});

describeWithCli('Gemma (Arduino core, 8 MHz ATtiny85) at 16 MHz', () => {
  test('blinks at its own rate on the ATtiny85, with no Serial decoder on PB0', async () => {
    const t = simulationTarget('arduino:avr:gemma');
    const hex = compileSketch(`
void setup() { pinMode(0, OUTPUT); pinMode(1, OUTPUT); }
void loop() { digitalWrite(0, HIGH); digitalWrite(1, HIGH); delay(100); digitalWrite(0, LOW); digitalWrite(1, LOW); delay(100); }`, t.fqbn, 'gemma_blink', t.properties);
    const r = await run(hex, 'attiny85', 1, { mcu: t.mcu });
    expect(Math.abs(pwm(r.trace, 1, 0.1).hz - 5)).toBeLessThan(0.1);
    expect(r.ports[0] || '').toBe('');
  }, 120000);
});
