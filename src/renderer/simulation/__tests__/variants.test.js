// Boards that run on an emulated chip's smaller sibling or another RP2040
// board: what the menu's FQBN maps to, and real firmware on each.
import { BOARDS, simulationTarget, compileTarget, boardForFqbn } from '../boards.js';
import { MCUS } from '../mcu.js';
import { flashImage } from '../rp2040-runner.js';
import { runHeadless } from '../headless.js';
import { compileSketch, describeWithCli, describeWithAttiny, describeWithPico } from './cli.js';

describe('which boards the simulator runs, and how', () => {
  test('the ATmega328P family runs as the Uno or Nano it is', () => {
    expect(simulationTarget('arduino:avr:uno')).toMatchObject({ board: BOARDS.uno, fqbn: 'arduino:avr:uno', mcu: 'atmega328p' });
    expect(simulationTarget('arduino:avr:pro:cpu=8MHzatmega328')).toMatchObject({ board: BOARDS.nano, fqbn: BOARDS.nano.fqbn, mcu: 'atmega328p' });
    for (const id of ['ethernet', 'duemilanove', 'unomini']) expect(boardForFqbn(`arduino:avr:${id}`)).toBe(BOARDS.uno);
    for (const id of ['fio', 'bt', 'lilypad', 'mini']) expect(boardForFqbn(`arduino:avr:${id}`)).toBe(BOARDS.nano);
  });

  test('ATmega168 boards compile as the 16 MHz Diecimila and run on the ATmega168', () => {
    for (const fqbn of ['arduino:avr:pro:cpu=8MHzatmega168', 'arduino:avr:nano:cpu=atmega168', 'arduino:avr:diecimila:cpu=atmega168']) {
      const t = simulationTarget(fqbn);
      expect(t.fqbn).toBe('arduino:avr:diecimila:cpu=atmega168');
      expect(t.mcu).toBe('atmega168');
      expect(t.note).toMatch(/ATmega168/);
    }
    expect(simulationTarget('arduino:avr:diecimila:cpu=atmega168').board).toBe(BOARDS.uno);
    expect(simulationTarget('arduino:avr:nano:cpu=atmega168').board).toBe(BOARDS.nano);
    // The ATmega8 has a register map of its own, emulated too.
    expect(simulationTarget('arduino:avr:nano:cpu=atmega8')).toMatchObject({ board: BOARDS.nano, mcu: 'atmega8' });
  });

  test('the Mega 1280 and Mega ADK run on the Mega', () => {
    expect(simulationTarget('arduino:avr:mega:cpu=atmega1280')).toMatchObject({ board: BOARDS.mega, mcu: 'atmega1280' });
    expect(simulationTarget('arduino:avr:megaADK')).toMatchObject({ board: BOARDS.mega, mcu: 'atmega2560' });
    expect(MCUS.atmega1280.flashBytes).toBe(128 * 1024);
  });

  test('ATtiny25 and 45 run on the ATtiny85 drawing', () => {
    expect(simulationTarget('ATTinyCore:avr:attinyx5:chip=45,clock=8internal')).toMatchObject({ board: BOARDS.attiny85, mcu: 'attiny45', fqbn: 'ATTinyCore:avr:attinyx5:chip=45,clock=16pll' });
    expect(simulationTarget('ATTinyCore:avr:attinyx5:chip=25')).toMatchObject({ mcu: 'attiny25' });
    expect(simulationTarget('ATTinyCore:avr:attinyx4')).toBeNull();
  });

  test('RP2040 boards compile with their own pin names and run on the Pico; RP2350 and Pico W do not', () => {
    expect(simulationTarget('rp2040:rp2040:rpipico')).toMatchObject({ board: BOARDS.pico, fqbn: BOARDS.pico.fqbn });
    expect(simulationTarget('rp2040:rp2040:seeed_xiao_rp2040:usbstack=tinyusb')).toMatchObject({ board: BOARDS.pico, fqbn: 'rp2040:rp2040:seeed_xiao_rp2040' });
    expect(simulationTarget('rp2040:rp2040:arduino_nano_connect').note).toMatch(/GPIO/);
    for (const id of ['rpipico2', 'pimoroni_pico_plus_2', 'adafruit_feather_rp2350_hstx', 'olimex_pico2xl', 'rpipicow']) {
      expect(simulationTarget(`rp2040:rp2040:${id}`)).toBeNull();
    }
  });

  test('chips with no emulator are not simulated', () => {
    for (const fqbn of ['arduino:megaavr:uno2018', 'arduino:megaavr:nona4809', 'arduino:renesas_uno:unor4wifi', 'esp32:esp32:esp32c6', 'arduino:samd:mkrzero']) {
      expect(simulationTarget(fqbn)).toBeNull();
    }
  });

  test('a drawn board compiles for the upload board when it runs there, else for itself', () => {
    expect(compileTarget(BOARDS.nano, 'arduino:avr:pro:cpu=8MHzatmega168').mcu).toBe('atmega168');
    expect(compileTarget(BOARDS.uno, 'arduino:avr:pro:cpu=8MHzatmega168')).toMatchObject({ fqbn: BOARDS.uno.fqbn, mcu: 'atmega328p' });
    expect(compileTarget(BOARDS.mega, 'esp32:esp32:esp32')).toMatchObject({ fqbn: BOARDS.mega.fqbn, mcu: 'atmega2560' });
  });

  test('a UF2 built for the RP2350 is refused with a reason', () => {
    const block = new Uint8Array(512);
    const view = new DataView(block.buffer);
    [0x0a324655, 0x9e5d5157, 0x2000, 0x10000000, 256, 0, 1, 0xe48bff59].forEach((v, i) => view.setUint32(i * 4, v, true));
    view.setUint32(508, 0x0ab16f30, true);
    expect(() => flashImage(block)).toThrow(/another chip/);
  });
});

// Varargs (sprintf) read their arguments past the return address, so they
// show whether the emulated program counter matches the chip's.
const PROBE = `
char buf[40];
void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  sprintf(buf, "v=%d,%ld,%s", 42, 70000L, "ok");
  Serial.println(buf);
}
void loop() {
  digitalWrite(LED_BUILTIN, HIGH); delay(100);
  digitalWrite(LED_BUILTIN, LOW); delay(100);
}
`;
const period = (run, pin) => {
  const rises = run.trace.filter(e => e.pin === pin && e.high).map(e => e.t);
  return (rises[rises.length - 1] - rises[0]) / (rises.length - 1);
};

describeWithCli('real firmware on the smaller ATmegas (needs arduino-cli + arduino:avr)', () => {
  test.each([
    ['ATmega168 Pro Mini, drawn as the Nano', 'arduino:avr:pro:cpu=8MHzatmega168', 'nano'],
    ['ATmega1280 Mega', 'arduino:avr:mega:cpu=atmega1280', 'mega'],
  ])('%s', async (_, uploadFqbn, boardId) => {
    const t = compileTarget(BOARDS[boardId], uploadFqbn);
    const hex = compileSketch(PROBE, t.fqbn, `variant_${t.mcu}`);
    const run = await runHeadless(hex, { board: boardId, mcu: t.mcu, seconds: 1.05 });
    expect(run.serial).toContain('v=42,70000,ok');
    expect(period(run, 13)).toBeGreaterThan(0.19);
    expect(period(run, 13)).toBeLessThan(0.21);
  }, 120000);
});

describeWithAttiny('ATTinyCore firmware on the ATtiny45 (needs ATTinyCore)', () => {
  test('blinks and prints on its software Serial', async () => {
    const t = simulationTarget('ATTinyCore:avr:attinyx5:chip=45');
    const hex = compileSketch(PROBE.replace('115200', '9600'), t.fqbn, 'variant_tiny45');
    const run = await runHeadless(hex, { board: 'attiny85', mcu: t.mcu, seconds: 1.05 });
    expect(run.serial).toContain('v=42,70000,ok');
    expect(period(run, 1)).toBeGreaterThan(0.19);
    expect(period(run, 1)).toBeLessThan(0.21);
  }, 180000);
});

describePico('an RP2040 board other than the Pico (needs the Arduino-Pico core)', () => {
  test('the Seeed XIAO RP2040 blinks its own LED pin and prints over USB', async () => {
    const t = simulationTarget('rp2040:rp2040:seeed_xiao_rp2040');
    // Serial is USB here: like on the real board, what's printed before the host connects is dropped.
    const sketch = PROBE.replace('  Serial.println(buf);\n}', '}').replace('void loop() {', 'void loop() {\n  Serial.println(buf);');
    const run = await runHeadless(compileSketch(sketch, t.fqbn, 'variant_xiao'), { board: 'pico', seconds: 1.2 });
    expect(run.serial).toContain('v=42,70000,ok');
    // LED_BUILTIN is GPIO17 on the XIAO, not the Pico's 25.
    expect(period(run, 17)).toBeGreaterThan(0.19);
    expect(period(run, 17)).toBeLessThan(0.21);
    expect(run.trace.some(e => e.pin === 25)).toBe(false);
  }, 300000);
});

function describePico(name, fn) {
  return describeWithPico(name, fn);
}
