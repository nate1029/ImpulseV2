/**
 * compile() and upload() as build jobs: output streamed line by line, the
 * memory summary and failure codes parsed, one job at a time.
 */
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('../../utils/errorHandler', () => ({
  handle: jest.fn((err) => ({ success: false, error: { message: err.message, code: err.code } })),
  validateInput: jest.fn(() => ({ valid: true, errors: [] })),
  getFriendlyMessage: jest.fn((err) => err.message),
}));

const { spawn } = require('child_process');
const ArduinoService = require('../arduinoService');

/** A child process that prints a script: ['out'|'err', text] chunks, then ['exit', code]. */
function fakeProcess(script) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = jest.fn(() => { proc.killed = true; setImmediate(() => proc.emit('close', null)); });
  setImmediate(async () => {
    for (const [kind, value] of script) {
      if (proc.killed) return;
      if (kind === 'exit') { proc.emit('close', value); return; }
      proc[kind === 'out' ? 'stdout' : 'stderr'].emit('data', Buffer.from(value));
      await new Promise((r) => setImmediate(r));
    }
  });
  return proc;
}

const UNO_OK = [
  ['out', 'Detecting libraries used...\n'],
  ['out', '/x/bin/avr-g++ -c -g -Os -w -std=gnu++11 -fpermissive -fno-exceptions -ffunction-sections -fdata-sections -fno-threadsafe-statics -Wno-error=narrowing -MMD -flto -mmcu=atmega328p -DF_CPU=16000000L -DARDUINO=10607 -DARDUINO_AVR_UNO -DARDUINO_ARCH_AVR -I/x/cores/arduino -I/x/variants/standard /tmp/sketch/Blink.ino.cpp -o /dev/null\n'],
  ['out', 'Compiling sketch...\nCompiling libraries...\nCompiling core...\nLinking everything together...\n'],
  ['out', 'Sketch uses 924 bytes (2%) of program storage space. Maximum is 32256 bytes.\nGlobal variables use 9 bytes (0%) of dynamic memory, leaving 2039 bytes for local variables. Maximum is 2048 bytes.\n'],
  ['exit', 0],
];

const UNO_TOO_BIG = [
  ['out', 'Linking everything together...\n'],
  ['out', 'Sketch uses 40102 bytes (124%) of program storage space. Maximum is 32256 bytes.\nGlobal variables use 9 bytes (0%) of dynamic memory, leaving 2039 bytes for local variables. Maximum is 2048 bytes.\n'],
  ['err', 'Sketch too big; see https://support.arduino.cc/hc/en-us/articles/360013825179 for tips on reducing it.\ntext section exceeds available space in board\nError during build: text section exceeds available space in board\n'],
  ['exit', 1],
];

describe('ArduinoService build jobs', () => {
  let service;
  let dir;
  let sketch;

  beforeEach(() => {
    spawn.mockReset();
    service = new ArduinoService({ cliPath: '/fake/arduino-cli' });
    service.checkCLI = async () => true;
    service.ensureCoreIndexed = async () => {};
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-build-'));
    sketch = path.join(dir, 'Blink.ino');
    fs.writeFileSync(sketch, 'void setup(){} void loop(){}');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('streams a compile and returns Arduino IDE\'s memory summary', async () => {
    const events = [];
    service.jobs.on('event', (e) => events.push(e));
    spawn.mockImplementationOnce(() => fakeProcess(UNO_OK));
    const result = await service.compile(sketch, 'arduino:avr:uno');
    expect(spawn).toHaveBeenCalledWith('/fake/arduino-cli', ['compile', '--fqbn', 'arduino:avr:uno', '--verbose', sketch], expect.objectContaining({ cwd: dir }));
    expect(result.success).toBe(true);
    expect(result.memory.flash).toEqual({ used: 924, percent: 2, max: 32256 });
    expect(result.summary).toEqual([
      'Sketch uses 924 bytes (2%) of program storage space. Maximum is 32,256 bytes.',
      'Global variables use 9 bytes (0%) of dynamic memory, leaving 2,039 bytes for local variables. Maximum is 2,048 bytes.',
    ]);
    expect(result.programSize).toBe(924);
    expect(result.usagePercent).toBe(2);
    expect(result.message).toMatch(/^Sketch uses 924 bytes/);
    const stages = events.filter((e) => e.phase === 'stage').map((e) => e.stage);
    expect(stages).toEqual(['compiling', 'detecting', 'compiling-sketch', 'compiling-libraries', 'compiling-core', 'linking', 'sizing']);
    const shown = events.filter((e) => e.phase === 'output').flatMap((e) => e.lines);
    expect(shown).toContain('Compiling sketch...');
    expect(shown.some((l) => l.includes('avr-g++ -c -g -Os'))).toBe(false); // compiler command lines stay out of the live view
    expect(result.output).toContain('avr-g++ -c -g -Os'); // but the full log keeps them
    expect(events[events.length - 1]).toMatchObject({ phase: 'done', ok: true, kind: 'compile' });
  });

  it('names a sketch that is too big, with the numbers, instead of a bare exit code', async () => {
    spawn.mockImplementationOnce(() => fakeProcess(UNO_TOO_BIG));
    const result = await service.compile(sketch, 'arduino:avr:uno');
    expect(result.success).toBe(false);
    expect(result.code).toBe('SKETCH_TOO_BIG');
    expect(result.title).toBe("The sketch is too big: 40,102 bytes, and this board's flash holds 32,256");
    expect(result.hint).toMatch(/PROGMEM/);
    expect(result.summary[0]).toBe('Sketch uses 40,102 bytes (124%) of program storage space. Maximum is 32,256 bytes.');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.output).toContain('text section exceeds available space');
  });

  it('runs an upload as one job with a compiling and an uploading stage', async () => {
    const events = [];
    service.jobs.on('event', (e) => events.push(e));
    service.listPorts = async () => [{ port: '/dev/cu.usbmodem1101' }];
    spawn
      .mockImplementationOnce(() => fakeProcess(UNO_OK))
      .mockImplementationOnce(() => fakeProcess([
        ['err', 'avrdude: AVR device initialized and ready to accept instructions\navrdude: Device signature = 0x1e950f (probably m328p)\n'],
        ['err', 'avrdude: writing flash (924 bytes):\nWriting | ##########                                         | 20% 0.02s\nWriting | ################################################## | 100% 0.15s\n'],
        ['err', 'avrdude: reading on-chip flash data:\nReading | ################################################## | 100% 0.12s\navrdude: 924 bytes of flash verified\n\navrdude done.  Thank you.\n'],
        ['exit', 0],
      ]));
    const result = await service.upload(sketch, 'arduino:avr:uno', '/dev/cu.usbmodem1101');
    expect(result.success).toBe(true);
    expect(result.port).toBe('/dev/cu.usbmodem1101');
    expect(result.memory.flash.used).toBe(924);
    expect(events.filter((e) => e.phase === 'start')).toHaveLength(1);
    const stages = events.filter((e) => e.phase === 'stage').map((e) => e.stage);
    expect(stages.slice(0, 1)).toEqual(['compiling']);
    expect(stages).toEqual(expect.arrayContaining(['uploading', 'connecting', 'writing', 'verifying']));
    expect(stages.indexOf('uploading')).toBeGreaterThan(stages.indexOf('sizing'));
    // Writing 20%, 100%, then the verification read's own 100%.
    expect(events.filter((e) => e.phase === 'progress').map((e) => e.percent)).toEqual([20, 100, 100]);
    expect(events[events.length - 1]).toMatchObject({ phase: 'done', ok: true, kind: 'upload', port: '/dev/cu.usbmodem1101' });
  });

  it('explains an upload that cannot sync with the board', async () => {
    service.listPorts = async () => [{ port: '/dev/cu.usbserial-1' }];
    spawn
      .mockImplementationOnce(() => fakeProcess(UNO_OK))
      .mockImplementationOnce(() => fakeProcess([
        ['err', 'avrdude: stk500_recv(): programmer is not responding\navrdude: stk500_getsync() attempt 1 of 10: not in sync: resp=0x00\n'],
        ['err', 'Failed uploading: uploading error: exit status 1\n'],
        ['exit', 1],
      ]));
    const result = await service.upload(sketch, 'arduino:avr:nano', '/dev/cu.usbserial-1');
    expect(result.success).toBe(false);
    expect(result.code).toBe('UPLOAD_SYNC');
    expect(result.title).toBe('The board did not answer the programmer');
    expect(result.hint).toMatch(/pins 0 and 1/);
  });

  it('refuses a different job while one runs and joins the same one', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    spawn.mockImplementationOnce(() => {
      const proc = fakeProcess([]);
      gate.then(() => { for (const [k, v] of UNO_OK) { if (k === 'exit') proc.emit('close', v); else proc[k === 'out' ? 'stdout' : 'stderr'].emit('data', Buffer.from(v)); } });
      return proc;
    });
    const first = service.compile(sketch, 'arduino:avr:uno');
    await new Promise((r) => setImmediate(r));
    const second = service.compile(sketch, 'arduino:avr:uno');
    service.listPorts = async () => [{ port: '/dev/x' }];
    const busy = await service.upload(sketch, 'arduino:avr:uno', '/dev/x');
    expect(busy.success).toBe(false);
    expect(busy.code).toBe('BUSY');
    expect(busy.title).toMatch(/A compile is already running/);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('stops a build that prints nothing for too long and says so', async () => {
    service.timeouts.compileIdleMs = 80;
    spawn.mockImplementationOnce(() => fakeProcess([['out', 'Compiling sketch...\n']]));
    const result = await service.compile(sketch, 'arduino:avr:uno');
    expect(result.success).toBe(false);
    expect(result.code).toBe('TIMEOUT');
    expect(result.title).toBe('The build stopped responding');
    expect(result.hint).toMatch(/Nothing was printed/);
  });
});
