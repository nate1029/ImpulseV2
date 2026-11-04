// The debugger end to end: a real debug build (through the same service the
// app uses), its DWARF read by dwarf.js, and the program stopped, stepped and
// inspected on the simulated CPU.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { decodeExpression, elfSections, parseLineProgram, readDebugInfo } from '../dwarf.js';
import { Debugger, inDirs } from '../debugger.js';
import { AvrRunner } from '../avr-runner.js';
import { CLI, describeWithCli } from './cli.js';
import ArduinoService from '../../../main/services/arduinoService.js';

jest.mock('../../../main/utils/errorHandler', () => ({ handle: jest.fn(), validateInput: jest.fn(() => ({ valid: true, errors: [] })), getFriendlyMessage: jest.fn() }));
jest.mock('../../../main/utils/notifications', () => ({ progress: jest.fn(), updateProgress: jest.fn(), dismiss: jest.fn(), success: jest.fn(), error: jest.fn() }));

describe('DWARF reading', () => {
  test('location expressions decode', () => {
    // DW_OP_reg24, piece 1, DW_OP_reg25, piece 1
    expect(decodeExpression(Uint8Array.from([0x68, 0x93, 0x01, 0x69, 0x93, 0x01]))).toEqual([['reg', 24], ['piece', 1], ['reg', 25], ['piece', 1]]);
    // DW_OP_addr 0x800117 (4-byte addresses), DW_OP_bregx r32 +2, DW_OP_fbreg -3
    expect(decodeExpression(Uint8Array.from([0x03, 0x17, 0x01, 0x80, 0x00, 0x92, 0x20, 0x02, 0x91, 0x7d]))).toEqual([['addr', 0x800117], ['breg', 32, 2], ['fbreg', -3]]);
    // DW_OP_breg24 0, lit1, shl, stack_value; an entry value is not evaluable
    expect(decodeExpression(Uint8Array.from([0x88, 0x00, 0x31, 0x24, 0x9f, 0xf3, 0x01, 0x68, 0x9f]))).toEqual([['breg', 24, 0], ['lit', 1], ['shl'], ['stack_value'], ['unsupported', 'entry value'], ['stack_value']]);
  });

  test('a line program runs its state machine', () => {
    const header = [
      ...[2, 0], // version 2
      ...[0, 0, 0, 0], // header length, patched below
      1, 1, 0xfb, 14, 13, // min inst, default is_stmt, line_base -5, line_range 14, opcode_base 13
      0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1, // standard opcode lengths
      0, // no include directories
      ...new TextEncoder().encode('a.ino\0'), 0, 0, 0,
      0, // end of files
    ];
    const program = [
      0, 3, 2, 0x10, 0x01, // set_address 0x110 (2-byte address)
      3, 4, // advance_line +4 → 5
      1, // copy: row 0x110 line 5
      13 + 34, // special: adjusted 34 = (1 - line_base) + 14 * 2 → address +2, line +1: 0x112 line 6
      2, 4, // advance_pc 4 → 0x116
      0, 1, 1, // end_sequence
    ];
    const headerLength = header.length - 6;
    header[2] = headerLength & 0xff;
    const body = [...header, ...program];
    const bytes = Uint8Array.from([body.length & 0xff, body.length >> 8, 0, 0, ...body]);
    const { files, rows } = parseLineProgram(bytes, 0, '/sketch');
    expect(files[1]).toBe('/sketch/a.ino');
    expect(rows).toEqual([
      { address: 0x110, file: 1, line: 5, stmt: true, end: false },
      { address: 0x112, file: 1, line: 6, stmt: true, end: false },
      { address: 0x116, file: 1, line: 6, stmt: true, end: true },
    ]);
  });

  test('rejects files that are not ELF', () => {
    expect(() => elfSections(Uint8Array.from([1, 2, 3, 4]))).toThrow(/Not an ELF/);
  });

  test('sketch folders match whatever the slashes and case', () => {
    expect(inDirs('C:/Users/Ann/Documents/Arduino/blink/blink.ino', ['c:\\users\\ann\\documents\\arduino\\blink'])).toBe(true);
    expect(inDirs('/home/ann/blink2/blink2.ino', ['/home/ann/blink'])).toBe(false);
  });
});

const SKETCH = `#include "helper.h"

struct Reading { int raw; float volts; bool ok; };
enum Mode { IDLE, RUNNING, DONE };

int counter = 0;
float temperature = 21.5;
bool flag;
char name[8] = "Uno";
int samples[4] = {10, 20, 30, 40};
Reading last = {512, 2.5, true};
Mode mode = RUNNING;
String label = "hello";
const char *greeting = "hi there";
volatile unsigned long ticks;
unsigned long neverUsed;

int twice(int x) {
  int y = x * 2;
  return y;
}

void setup() {
  Serial.begin(115200);
  Serial.println(name);
  Serial.println(greeting);
  Serial.println(last.raw);
  Serial.println(last.volts);
  Serial.println(last.ok);
  Serial.println((int)mode);
  pinMode(13, OUTPUT);
}

void loop() {
  counter = twice(counter + 1);
  digitalWrite(13, counter & 1);
  temperature += 0.5;
  flag = !flag;
  ticks = scale(counter);
  samples[counter & 3] = counter;
  label += "!";
  Serial.println(label);
  delay(10);
}
`;

const HELPER_H = 'long scale(int v);\n';
const HELPER_CPP = `#include "helper.h"

long scale(int v) {
  long r = (long)v * 1000;
  return r + 7;
}
`;

const lineOf = (code, text) => code.split('\n').findIndex(l => l.includes(text)) + 1;

describeWithCli('debugger on a debug build', () => {
  let temp;
  const service = new ArduinoService({ cliPath: CLI });

  beforeAll(() => { temp = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-debugger-test-')); });
  afterAll(() => { fs.rmSync(temp, { recursive: true, force: true }); });

  async function start(name, files, fqbn, board) {
    const dir = path.join(temp, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
    const build = await service.compileDebug(dir, fqbn);
    if (!build.success) throw new Error(build.error);
    const runner = new AvrRunner();
    let serial = '';
    runner.onSerial = (c) => { serial += c; };
    expect(runner.load(build.hex, board)).toBe(true);
    const info = readDebugInfo(build.elf);
    const dbg = new Debugger(runner, info, {
      sketchDirs: build.sketchDirs,
      remap: build.buildSketchDirs.map(b => [b, build.sketchDirs[0]]),
      live: false,
    });
    const stops = [];
    dbg.onStop = (s) => stops.push(s);
    const run = (action, maxSeconds = 2) => {
      action();
      if (!runner.runUntilStop(16e6 * maxSeconds)) throw new Error('did not stop');
      return stops[stops.length - 1];
    };
    return { dir, dbg, runner, run, serial: () => serial, build };
  }

  test('breakpoints, stepping and values on an Uno', async () => {
    const { dir, dbg, run, serial } = await start('dbgtest', { 'dbgtest.ino': SKETCH, 'helper.h': HELPER_H, 'helper.cpp': HELPER_CPP }, 'arduino:avr:uno', 'uno');
    const ino = path.join(dir, 'dbgtest.ino');
    const cpp = path.join(dir, 'helper.cpp');
    const L = (text) => lineOf(SKETCH, text);

    // A line without code moves to the next one that has some.
    const set = dbg.setBreakpoints(ino, [L('Serial.begin'), L('temperature += 0.5'), L('struct Reading')]);
    expect(set.get(L('Serial.begin'))).toBe(L('Serial.begin'));
    expect(set.get(L('temperature += 0.5'))).toBe(L('temperature += 0.5'));
    // The next line with code is a global's constructor, which runs before setup().
    expect(set.get(L('struct Reading'))).toBe(L('String label'));

    let stop = run(() => dbg.continue());
    expect(stop).toMatchObject({ reason: 'breakpoint', location: { function: 'global constructors', line: L('String label') } });
    stop = run(() => dbg.continue());
    expect(stop).toMatchObject({ reason: 'breakpoint', location: { function: 'setup', line: L('Serial.begin'), inSketch: true } });
    expect(stop.location.file).toBe(ino.replace(/\\/g, '/'));
    dbg.setBreakpoints(ino, [L('temperature += 0.5')]);

    stop = run(() => dbg.stepOver());
    expect(stop.location.line).toBe(L('Serial.println(name)'));

    stop = run(() => dbg.continue());
    expect(stop.location).toMatchObject({ function: 'loop', line: L('temperature += 0.5') });

    const globals = Object.fromEntries(dbg.globals().map(g => [g.name, g]));
    expect(globals.counter).toMatchObject({ type: 'int', value: '2' });
    expect(globals.temperature).toMatchObject({ type: 'float', value: '21.5' });
    expect(globals.flag).toMatchObject({ type: 'bool', value: 'false' });
    expect(globals.name).toMatchObject({ type: 'char[8]', value: '"Uno"' });
    expect(globals.samples.value).toBe('[10, 20, 30, 40]');
    expect(globals.samples.children.map(c => c.value)).toEqual(['10', '20', '30', '40']);
    expect(globals.last.children).toEqual([
      { name: 'raw', type: 'int', value: '512' },
      { name: 'volts', type: 'float', value: '2.5' },
      { name: 'ok', type: 'bool', value: 'true' },
    ]);
    expect(globals.mode).toMatchObject({ type: 'Mode', value: 'RUNNING (1)' });
    expect(globals.label).toMatchObject({ type: 'String', value: '"hello"' });
    expect(globals.greeting.value).toMatch(/^0x[0-9a-f]{4} "hi there"$/);
    expect(globals.ticks).toMatchObject({ type: 'volatile long unsigned int', value: '0' });
    expect(globals.neverUsed).toMatchObject({ unavailable: true, value: 'optimized out (never used)' });

    // Over a function call, into a function in another file, and out again.
    stop = run(() => dbg.stepOver());
    expect(stop.location.line).toBe(L('flag = !flag'));
    stop = run(() => dbg.stepOver());
    expect(stop.location.line).toBe(L('ticks = scale(counter)'));
    stop = run(() => dbg.stepInto());
    expect(stop.location).toMatchObject({ function: 'scale', line: lineOf(HELPER_CPP, 'long r =') });
    // Compiled from the build folder's copy, shown as the sketch's own file.
    expect(stop.location.file).toBe(cpp.replace(/\\/g, '/'));
    expect(dbg.locals().find(v => v.name === 'v')).toMatchObject({ param: true, value: '2' });
    // The call stack, from the frame descriptions.
    expect(dbg.callStack().map(f => [f.function, f.line])).toEqual([
      ['scale', lineOf(HELPER_CPP, 'long r =')], ['loop', L('ticks = scale(counter)')], ['main', null],
    ]);
    stop = run(() => dbg.stepOut());
    expect(stop.location.function).toBe('loop');
    expect(stop.location.line).toBe(L('ticks = scale(counter)'));
    stop = run(() => dbg.stepOver());
    expect(stop.location.line).toBe(L('samples[counter & 3]'));
    expect(Object.fromEntries(dbg.globals().map(g => [g.name, g.value])).ticks).toBe('2007');

    // delay(10) is stepped over in 10 ms of simulated time.
    dbg.setBreakpoints(ino, []);
    stop = run(() => dbg.stepOver());
    stop = run(() => dbg.stepOver());
    expect(stop.location.line).toBe(L('Serial.println(label)'));
    stop = run(() => dbg.stepOver());
    expect(stop.location.line).toBe(L('delay(10)'));
    const before = dbg.registers().cycles;
    stop = run(() => dbg.stepOver());
    expect((dbg.registers().cycles - before) / 16e6).toBeGreaterThanOrEqual(0.01);
    expect(Object.fromEntries(dbg.globals().map(g => [g.name, g.value])).label).toBe('"hello!"');
    expect(serial()).toContain('Uno\r\nhi there\r\n512\r\n2.50\r\n1\r\n1\r\nhello!\r\n');

    // Into a sketch function; locals there.
    stop = run(() => dbg.stepOver());
    expect(stop.location.line).toBe(L('counter = twice'));
    stop = run(() => dbg.stepInto());
    expect(stop.location.function).toBe('twice');
    const locals = Object.fromEntries(dbg.locals().map(v => [v.name, v.value]));
    expect(locals.x).toBe('3');
    expect(dbg.callStack().map(f => f.function)).toEqual(['twice', 'loop', 'main']);

    // Paused inside the Arduino core: the stack leads back to the sketch.
    dbg.setBreakpoints(ino, [L('delay(10)')]);
    run(() => dbg.continue());
    dbg.setBreakpoints(ino, []);
    dbg.runner.stopCheck = null;
    dbg.runner.step(16000 * 3);
    const inDelay = dbg.callStack();
    // Somewhere in delay() (or micros(), which it calls).
    expect(inDelay[0].inSketch).toBe(false);
    const names = inDelay.map(f => f.function);
    expect(names.slice(names.indexOf('delay'))).toEqual(['delay', 'loop', 'main']);
    expect(inDelay.find(f => f.function === 'loop').line).toBe(L('delay(10)'));
    dbg.runner.stopCheck = (cpu) => dbg._check(cpu);

    // Run to a line, and pause anywhere.
    expect(dbg.runToLine(ino, L('digitalWrite(13'))).toBe(true);
    expect(dbg.runner.runUntilStop(16e6)).toBe(true);
    expect(dbg.location().line).toBe(L('digitalWrite(13'));
    const regs = dbg.registers();
    expect(regs.r).toHaveLength(32);
    expect(regs.flags).toMatch(/^[Ii][Tt][Hh][Ss][Vv][Nn][Zz][Cc]$/);
    expect(regs.sp).toBeGreaterThan(0x100);
  }, 240000);

  test('a Mega (22-bit program counter) stops and steps too', async () => {
    const code = `int n = 0;

int bump(int v) {
  int w = v + 1;
  return w;
}

void setup() {
  pinMode(13, OUTPUT);
}

void loop() {
  n++;
  digitalWrite(13, n & 1);
  n = bump(n) - 1;
  delay(5);
}
`;
    const { dir, dbg, run } = await start('megadbg', { 'megadbg.ino': code }, 'arduino:avr:mega:cpu=atmega2560', 'mega');
    const ino = path.join(dir, 'megadbg.ino');
    dbg.setBreakpoints(ino, [lineOf(code, 'n++')]);
    let stop = run(() => dbg.continue());
    expect(stop.location).toMatchObject({ function: 'loop', line: lineOf(code, 'n++') });
    stop = run(() => dbg.stepOver());
    expect(stop.location.line).toBe(lineOf(code, 'digitalWrite'));
    expect(dbg.globals().find(g => g.name === 'n').value).toBe('1');
    stop = run(() => dbg.continue());
    expect(dbg.globals().find(g => g.name === 'n').value).toBe('1');
    stop = run(() => dbg.stepOver());
    expect(dbg.globals().find(g => g.name === 'n').value).toBe('2');
    // Into bump(): three-byte return addresses unwind to loop().
    stop = run(() => dbg.stepOver());
    expect(stop.location.line).toBe(lineOf(code, 'n = bump(n)'));
    stop = run(() => dbg.stepInto());
    expect(stop.location.function).toBe('bump');
    expect(dbg.callStack().map(f => [f.function, f.line])).toEqual([
      ['bump', stop.location.line], ['loop', lineOf(code, 'n = bump(n)')], ['main', null],
    ]);
    expect(dbg.locals().find(v => v.name === 'v').value).toBe('2');
  }, 240000);
});
