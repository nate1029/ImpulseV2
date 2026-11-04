import { Esp32Runner, setEsp32Bridge } from '../esp32-runner.js';
import { PinState, F_CPU } from '../avr-runner.js';
import { BOARDS, simulationTarget, esp32ChipOf, registerBoardChip, parseBoardPin, pinLabel, boardPinNumber, boardForFqbn } from '../boards.js';
import { runnerFamily, createRunner, programOf } from '../runners.js';

/** A stand-in for the main process: records what the runner sends, delivers what the firmware says. */
function fakeEmulator() {
  const fake = { sent: [], written: [], controls: [], listeners: new Set(), session: 7 };
  fake.api = {
    start: async () => ({ success: true, session: fake.session }),
    send: (id, lines) => fake.sent.push(...lines),
    write: (id, text) => fake.written.push(text),
    control: async (id, action) => { fake.controls.push(action); return true; },
    onEvent: (cb) => { fake.listeners.add(cb); return () => fake.listeners.delete(cb); },
  };
  fake.say = (...lines) => { for (const cb of fake.listeners) cb({ session: fake.session, type: 'bridge', data: lines }); };
  fake.serial = (text) => { for (const cb of fake.listeners) cb({ session: fake.session, type: 'serial', data: text }); };
  return fake;
}

const tick = () => new Promise(r => setTimeout(r, 0));

async function booted(boardId = 'esp32') {
  const fake = fakeEmulator();
  setEsp32Bridge(() => fake.api);
  const runner = new Esp32Runner();
  expect(runner.load({ image: 'img-1', chip: BOARDS[boardId].mcu }, boardId)).toBe(true);
  runner.start();
  await tick();
  return { runner, fake };
}

describe('ESP32 runner', () => {
  it('sends the circuit\'s state when the bridge starts, then lets setup() run', async () => {
    const { runner, fake } = await booted();
    runner.setInputPin(4, false);
    runner.setAnalogVoltage(34, 1.65);
    runner.i2c.add(0x27, {});
    expect(fake.sent).toEqual([]); // nothing before the bridge is up
    fake.say('Besp32');
    await tick();
    expect(fake.sent).toEqual(['I4,0', 'A34,1650', 'D27', 'G']);
  });

  it('follows the firmware\'s pins and clock', async () => {
    const { runner, fake } = await booted();
    const changes = [];
    runner.onPinChange = (pin, high, cycles) => changes.push([pin, high, cycles / F_CPU]);
    fake.say('Besp32', 'M2,3,1000', 'W2,1,250000', 'H400000', 'W2,0,500000');
    expect(changes).toEqual([[2, true, 0.25], [2, false, 0.5]]);
    expect(runner.time).toBe(0.5);
    expect(runner.isOutput(2)).toBe(true);
    expect(runner.pinState(2)).toBe(PinState.Low);
    fake.say('M4,5,600000');
    expect(runner.pinState(4)).toBe(PinState.InputPullUp);
    expect(runner.isOutput(4)).toBe(false);
  });

  it('ignores what arrives after a reset until the bridge restarts', async () => {
    const { runner, fake } = await booted();
    let resets = 0;
    runner.onReset = () => resets++;
    fake.say('Besp32', 'W2,1,9000000');
    runner.reset();
    expect(resets).toBe(1);
    expect(fake.controls).toContain('reset');
    fake.say('H9100000', 'W2,1,9200000'); // from before the reset
    expect(runner.time).toBe(0);
    fake.say('Besp32', 'H100000');
    expect(runner.time).toBeCloseTo(0.1);
  });

  it('counts a headless run from setup(), not from power-on', async () => {
    const { runner, fake } = await booted();
    let done = false;
    runner.waitUntil(0.5).then(() => { done = true; });
    fake.say('Besp32,120000', 'H1600000', 'S1650000', 'H2000000');
    await new Promise(r => setTimeout(r, 50));
    expect(done).toBe(false);
    expect(runner.sketchTime).toBeCloseTo(0.35);
    fake.say('H2200000');
    await new Promise(r => setTimeout(r, 50));
    expect(done).toBe(true);
  });

  it('runs parts\' timers at the firmware\'s time, in order', async () => {
    const { runner, fake } = await booted();
    fake.say('Besp32', 'H100000');
    const fired = [];
    runner.schedule(0.05 * F_CPU, () => fired.push(['b', runner.time]));
    runner.schedule(0.01 * F_CPU, () => fired.push(['a', runner.time]));
    const cancelled = runner.schedule(0.02 * F_CPU, () => fired.push(['x']));
    runner.cancel(cancelled);
    fake.say('H120000');
    expect(fired).toEqual([['a', 0.11]]);
    fake.say('H200000');
    expect(fired.map(f => f[0])).toEqual(['a', 'b']);
    expect(fired[1][1]).toBeCloseTo(0.15);
  });

  it('reports PWM as duty and frequency, and slow PWM (servos) as timed edges', async () => {
    const { runner, fake } = await booted();
    fake.say('Besp32', 'P5,128,8,5000,1000');
    expect(runner.pwmOf(5)).toEqual({ duty: 128 / 255, freq: 5000 });
    expect(runner.isOutput(5)).toBe(true);
    const edges = [];
    runner.onPinChange = (pin, high, cycles) => { if (pin === 18) edges.push([high, +(cycles / F_CPU).toFixed(6)]); };
    // 50 Hz with a 1.5 ms pulse: 16-bit duty 4915.
    fake.say('P18,4915,16,50,100000', 'H160000');
    expect(edges.slice(0, 4)).toEqual([[true, 0.1], [false, 0.1015], [true, 0.12], [false, 0.1215]]);
    fake.say('P18,-1,0,0,170000');
    expect(runner.pwmOf(18)).toBeNull();
  });

  it('shows the RGB LED\'s colour', async () => {
    const { runner, fake } = await booted('esp32s3');
    fake.say('Besp32s3', 'N48,10,20,30,5000');
    expect(runner.rgbOf(48)).toEqual([10, 20, 30]);
  });

  it('answers pulseIn() from the input\'s edges, to the microsecond', async () => {
    const { runner, fake } = await booted();
    fake.say('Besp32', 'M5,1,0', 'H100000', 'Q1,5,1,1000000,100000');
    // An echo 250 µs later, 1160 µs long, driven by a part's timers.
    runner.schedule(250e-6 * F_CPU, () => {
      runner.setInputPin(5, true);
      runner.schedule(1160e-6 * F_CPU, () => runner.setInputPin(5, false));
    });
    fake.say('H110000');
    await tick();
    expect(fake.sent).toContain('q1,1160');
  });

  it('times out pulseIn() when no pulse comes', async () => {
    const { fake } = await booted();
    fake.say('Besp32', 'Q2,5,1,1000,100000', 'H102000');
    await tick();
    expect(fake.sent).toContain('q2,0');
  });

  it('lets I²C devices answer the firmware', async () => {
    const { runner, fake } = await booted();
    const log = [];
    let reg = 0;
    runner.i2c.add(0x68, {
      i2cConnect: (read) => { log.push(read ? 'R' : 'W'); return true; },
      i2cWrite: (b) => { reg = b; log.push(b); return true; },
      i2cRead: () => reg++,
      i2cStop: () => log.push('stop'),
    });
    fake.say('Besp32', 'T0,104,3b6b,1000', 'X5,0,104,3b,2,2000', 'R6,0,80,1,3000');
    await tick();
    expect(log).toEqual(['W', 0x3b, 0x6b, 'stop', 'W', 0x3b, 'R', 'stop']);
    expect(fake.sent).toContain('r5,1,3b3c');
    expect(fake.sent).toContain('r6,0,'); // nothing at 0x50
  });

  it('gives SPI bytes to the selected devices and returns what they answer', async () => {
    const { runner, fake } = await booted();
    const got = [];
    runner.spiBus.add({ selected: () => true, transfer: (b) => { got.push(b); return b ^ 0xff; } });
    fake.say('Besp32', 'Z2,0f00,1000', 'Y9,2,a5,2000');
    await tick();
    expect(got).toEqual([0x0f, 0x00, 0xa5]);
    expect(fake.sent).toContain('y9,5a');
  });

  it('says once that Wi-Fi joined a pretend network', async () => {
    const { runner, fake } = await booted();
    const notices = [];
    runner.onNotice = (n) => notices.push(n);
    fake.say('Besp32', 'Fjoin,Home, upstairs', 'Fjoin,Home, upstairs');
    expect(notices).toEqual([expect.stringMatching(/pretend network "Home, upstairs" and got IP 10\.0\.2\.15/)]);
  });

  it('passes Serial both ways', async () => {
    const { runner, fake } = await booted();
    let text = '';
    runner.onSerial = (ch, port) => { if (port === 0) text += ch; };
    fake.say('Besp32');
    fake.serial('hello\r\n');
    runner.serialWrite('ping\n');
    expect(text).toBe('hello\r\n');
    expect(fake.written).toEqual(['ping\n']);
  });

  it('tells the user when the emulator doesn\'t start', async () => {
    const fake = fakeEmulator();
    fake.api.start = async () => ({ success: false, error: 'no QEMU' });
    setEsp32Bridge(() => fake.api);
    const runner = new Esp32Runner();
    const errors = [];
    runner.onError = (e) => errors.push(e);
    runner.load({ image: 'x', chip: 'esp32' }, 'esp32');
    runner.start();
    await tick();
    expect(errors).toEqual(['no QEMU']);
    await expect(runner.waitUntil(1)).rejects.toThrow('no QEMU');
  });
});

describe('ESP32 boards', () => {
  it('runs every ESP32 board on its chip\'s drawing', () => {
    expect(simulationTarget('esp32:esp32:esp32doit-devkit-v1')).toMatchObject({ board: BOARDS.esp32, note: undefined });
    expect(simulationTarget('esp32:esp32:esp32s3:PSRAM=opi')).toMatchObject({ board: BOARDS.esp32s3, fqbn: 'esp32:esp32:esp32s3:PSRAM=opi' });
    expect(simulationTarget('esp32:esp32:heltec_wifi_kit_32_V3').board.id).toBe('esp32s3');
    expect(simulationTarget('esp32:esp32:XIAO_ESP32C3').board.id).toBe('esp32c3');
    expect(simulationTarget('esp32:esp32:lolin_s2_mini')).toMatchObject({ board: BOARDS.esp32s3, mcu: 'esp32s2', note: expect.stringMatching(/ESP32-S3/) });
    expect(simulationTarget('arduino:esp32:nano_nora').board.id).toBe('nanoesp32');
    expect(simulationTarget('esp32:esp32:esp32c6')).toBeNull();
    expect(boardForFqbn('esp32:esp32:esp32').id).toBe('esp32');
  });

  it('learns a board\'s chip from the installed core', () => {
    expect(esp32ChipOf('esp32:esp32:some_new_board')).toBe('esp32');
    registerBoardChip('esp32:esp32:some_new_board:PSRAM=enabled', 'esp32c3');
    expect(esp32ChipOf('esp32:esp32:some_new_board')).toBe('esp32c3');
    expect(simulationTarget('esp32:esp32:some_new_board').board.id).toBe('esp32c3');
  });

  it('numbers pins by GPIO, the Nano ESP32 by its D and A labels', () => {
    expect(boardPinNumber(BOARDS.esp32, 'D13')).toBe(13);
    expect(boardPinNumber(BOARDS.esp32, 'VP')).toBe(36);
    expect(parseBoardPin(BOARDS.esp32, 'LED_BUILTIN')).toBe(2);
    expect(pinLabel(BOARDS.esp32, 2)).toBe('GPIO2');
    expect(boardPinNumber(BOARDS.esp32s3, 'TX')).toBe(43);
    expect(parseBoardPin(BOARDS.esp32s3, 'A0')).toBe(1);
    const nano = BOARDS.nanoesp32;
    expect(boardPinNumber(nano, '13')).toBe(48);
    expect(boardPinNumber(nano, 'A4')).toBe(11);
    expect(parseBoardPin(nano, 'D2')).toBe(5);
    expect(parseBoardPin(nano, 'LED_BUILTIN')).toBe(48);
    expect(pinLabel(nano, 48)).toBe('D13');
    expect(pinLabel(nano, 46)).toBe('LED_RED');
  });

  it('uses the ESP32 runner for ESP32 boards', () => {
    for (const id of ['esp32', 'esp32s3', 'esp32c3', 'nanoesp32']) {
      expect(runnerFamily(id)).toBe('esp32');
      expect(createRunner(id)).toBeInstanceOf(Esp32Runner);
    }
    expect(programOf({ success: true, esp32: { image: 'a' } })).toEqual({ image: 'a' });
  });
});
