import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  main, parseArgs, findSketches, findCli, resolveCommand, junitReport, exitCode, diagramBoard, loadDiagram, UsageError, EXIT,
} from '../impulse-test.js';
import { exampleById, exampleDiagram } from '../../renderer/simulation/examples.js';
import { wordsToHex, TOGGLE_D13 } from '../../renderer/simulation/__tests__/helpers.js';
import { CLI, describeWithCli, describeWithAttiny, EXTRA_CONFIG_FILE } from '../../renderer/simulation/__tests__/cli.js';

let temp;
beforeEach(() => { temp = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-cli-test-')); });
afterEach(() => { fs.rmSync(temp, { recursive: true, force: true }); });

function sketch(name, code, diagram = null, parent = temp) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.ino`), code);
  if (diagram) fs.writeFileSync(path.join(dir, 'diagram.json'), JSON.stringify(diagram));
  return dir;
}

async function capture(argv) {
  let out = '';
  let err = '';
  const code = await main(argv, { version: '9.9.9', stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
  return { code, out, err };
}

describe('impulse-test arguments', () => {
  test('reads flags, = values and repeated options', () => {
    const o = parseArgs(['a', '--board=mega', '--seconds', '2', '--expect', 'no serial', '--expect=pin 13 high', '--libraries', 'x', '--libraries', 'y', '--strict', 'b']);
    expect(o).toMatchObject({ sketches: ['a', 'b'], board: 'mega', seconds: 2, expect: ['no serial', 'pin 13 high'], libraries: ['x', 'y'], strict: true });
  });

  test('rejects what it cannot do', () => {
    expect(() => parseArgs([])).toThrow(UsageError);
    expect(() => parseArgs(['a', '--board', 'due'])).toThrow(/Unknown board/);
    expect(() => parseArgs(['a', '--fqbn', 'esp32:esp32:esp32c6'])).toThrow(/can't run/);
    expect(() => parseArgs(['a', '--hex', 'x.bin', '--board', 'esp32s3'])).toThrow(/--hex runs AVR/);
    expect(() => parseArgs(['a', '--board', 'uno', '--fqbn', 'arduino:avr:mega'])).toThrow(/not a/);
    expect(() => parseArgs(['a', '--seconds', '0'])).toThrow(/--seconds/);
    expect(() => parseArgs(['a', '--seconds'])).toThrow(/needs a value/);
    expect(() => parseArgs(['a', '--format', 'xml'])).toThrow(/--format/);
    expect(() => parseArgs(['a', 'b', '--hex', 'x.hex'])).toThrow(/one sketch/);
    expect(() => parseArgs(['a', '--colour'])).toThrow(/Unknown option/);
    expect(parseArgs(['--hex', 'x.hex', '--expect', 'no serial']).sketches).toEqual([]);
    expect(parseArgs(['--version']).version).toBe(true);
  });

  test('help and version print and succeed', async () => {
    expect((await capture(['--help'])).out).toMatch(/Usage: impulse-test/);
    expect(await capture(['-v'])).toMatchObject({ code: EXIT.PASS, out: '9.9.9\n' });
    expect(await capture(['--nope'])).toMatchObject({ code: EXIT.ERROR });
  });
});

describe('finding sketches', () => {
  test('a sketch folder, its .ino, or a folder of sketches', () => {
    const a = sketch('alpha', '');
    const b = sketch('beta', '', null, path.join(temp, 'more'));
    fs.writeFileSync(path.join(a, 'extra.ino'), '');
    fs.mkdirSync(path.join(temp, 'node_modules', 'gamma'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'node_modules', 'gamma', 'gamma.ino'), '');

    expect(findSketches(a)[0]).toMatchObject({ name: 'alpha', files: [path.join(a, 'alpha.ino'), path.join(a, 'extra.ino')] });
    expect(findSketches(path.join(b, 'beta.ino'))[0].dir).toBe(b);
    expect(findSketches(temp).map(s => s.name)).toEqual(['alpha', 'beta']);
  });

  test('explains folders that are not sketches', () => {
    fs.writeFileSync(path.join(temp, 'wrong.ino'), '');
    expect(() => findSketches(temp)).toThrow(/named after its folder/);
    expect(() => findSketches(path.join(temp, 'missing'))).toThrow(/does not exist/);
    expect(() => findSketches(fs.mkdtempSync(path.join(temp, 'empty-')))).toThrow(/No Arduino sketches/);
  });

  test('arduino-cli: a path must exist; a bare name is looked up on PATH', () => {
    expect(findCli(path.join(temp, 'arduino-cli'))).toBeNull();
    const fake = path.join(temp, 'arduino-cli');
    fs.writeFileSync(fake, '');
    expect(findCli(fake)).toBe(fake);
    expect(findCli(null, { ARDUINO_CLI: fake })).toBe(fake);
    expect(findCli('arduino-cli', { PATH: ['/nonexistent', temp].join(path.delimiter) })).toBe(fake);
    expect(findCli('arduino-cli', { PATH: '/nonexistent' })).toBeNull();
    expect(resolveCommand('arduino-cli', { PATH: temp, PATHEXT: '.EXE' }, 'win32')).toBe(fake);
    fs.writeFileSync(path.join(temp, 'tool.exe'), '');
    expect(resolveCommand('tool', { PATH: temp, PATHEXT: '.EXE;.CMD' }, 'win32')).toBe(path.join(temp, 'tool.exe'));
  });
});

describe('circuits', () => {
  test('the board comes from the diagram', () => {
    const file = path.join(temp, 'diagram.json');
    fs.writeFileSync(file, JSON.stringify(exampleDiagram(exampleById('mega-wave'))));
    expect(diagramBoard(loadDiagram(file))).toBe('mega');
    fs.writeFileSync(file, '{ nope');
    expect(() => loadDiagram(file)).toThrow(/not valid JSON/);
    expect(loadDiagram(path.join(temp, 'none.json'))).toBeNull();
  });
});

describe('prebuilt HEX', () => {
  test('passes and fails expectations, with the right exit codes', async () => {
    const hex = path.join(temp, 'toggle.ino.hex');
    fs.writeFileSync(hex, wordsToHex(TOGGLE_D13));
    const pass = await capture(['--hex', hex, '--expect', 'pin 13 toggles', '--expect', 'no serial', '--seconds', '0.1']);
    expect(pass.code).toBe(EXIT.PASS);
    expect(pass.out).toMatch(/PASS toggle/);
    expect(pass.out).toMatch(/2\/2 expectations passed/);

    const json = path.join(temp, 'report.json');
    const fail = await capture(['--hex', hex, '--expect', 'serial contains "hi"', '--seconds', '0.1', '--format', 'json', '--json', json]);
    expect(fail.code).toBe(EXIT.FAIL);
    const report = JSON.parse(fail.out);
    expect(report).toMatchObject({ passed: false, version: '9.9.9', summary: { failed: 1, expectationsFailed: 1 } });
    expect(JSON.parse(fs.readFileSync(json, 'utf8')).summary).toEqual(report.summary);
  });

  test('a board that does not match the circuit is an error', async () => {
    const hex = path.join(temp, 'toggle.hex');
    fs.writeFileSync(hex, wordsToHex(TOGGLE_D13));
    const diagram = path.join(temp, 'diagram.json');
    fs.writeFileSync(diagram, JSON.stringify(exampleDiagram(exampleById('blink'))));
    const r = await capture(['--hex', hex, '--diagram', diagram, '--board', 'mega', '--expect', 'pin 13 toggles']);
    expect(r.code).toBe(EXIT.FAIL);
    expect(r.out).toMatch(/built around an Arduino Uno/);
  });
});

describe('reports', () => {
  const entries = [
    { name: 'a<b>', path: '/x', status: 'failed', error: null, duration: 0.5, serial: 'ok & \u0001done',
      results: [{ expectation: 'serial contains "x"', file: 'a.ino', line: 2, pass: false, detail: 'not "found"' },
        { expectation: 'no serial', file: null, line: null, pass: true, detail: 'fine' }] },
    { name: 'c', path: '/y', status: 'error', error: 'Compile failed: c.ino:1: error\nmore', duration: 0.1, serial: '', results: [] },
    { name: 'd', path: '/z', status: 'skipped', error: 'No // @expect lines', duration: 0, serial: '', results: [] },
  ];

  test('JUnit XML is escaped and counts every case', () => {
    const xml = junitReport(entries);
    expect(xml).toMatch(/<testsuites name="impulse-test" tests="4" failures="1" errors="1" skipped="1"/);
    expect(xml).toContain('<testsuite name="a&lt;b&gt;"');
    expect(xml).toContain('<failure message="not &quot;found&quot;">');
    expect(xml).toContain('<error message="Compile failed: c.ino:1: error">');
    expect(xml).toContain('<system-out>ok &amp; done</system-out>');
    expect(xml).toContain('<skipped message="No // @expect lines"/>');
  });

  test('exit codes', () => {
    expect(exitCode(entries)).toBe(EXIT.FAIL);
    expect(exitCode([entries[2]])).toBe(EXIT.ERROR);
    expect(exitCode([{ ...entries[0], status: 'passed' }, entries[2]])).toBe(EXIT.PASS);
  });
});

describeWithCli('impulse-test with arduino-cli', () => {
  test('compiles, runs the circuit and checks the sketch', async () => {
    const blink = exampleById('blink');
    sketch('blink', blink.code, exampleDiagram(blink));
    sketch('broken', '// @expect no serial\nvoid setup() { nope(); }\nvoid loop() {}\n');
    sketch('untested', 'void setup() {}\nvoid loop() {}\n');
    const junit = path.join(temp, 'junit.xml');
    const r = await capture([temp, '--cli', CLI, '--junit', junit]);
    expect(r.out).toMatch(/PASS blink \(Arduino Uno, 2\.2 s simulated\)/);
    expect(r.out).toMatch(/measured 1\.00 Hz/);
    expect(r.out).toMatch(/ERROR broken[\s\S]*Compile failed: broken\.ino:2:\d+: error: 'nope' was not declared/);
    expect(r.out).toMatch(/SKIP untested/);
    expect(r.code).toBe(EXIT.FAIL);
    expect(fs.readFileSync(junit, 'utf8')).toMatch(/tests="3" failures="0" errors="1" skipped="1"/);
  }, 180000);
});

describeWithAttiny('impulse-test on an ATtiny85 (needs ATTinyCore)', () => {
  test('takes the chip from diagram.json and checks the sketch', async () => {
    const ex = exampleById('attiny-dimmer');
    sketch('dimmer', ex.code, exampleDiagram(ex), path.join(temp, 'sketches'));
    // The configuration that has ATTinyCore, through a wrapper (child processes
    // don't see a test's process.env).
    let cli = CLI;
    if (EXTRA_CONFIG_FILE && process.platform !== 'win32') {
      cli = path.join(temp, 'arduino-cli');
      fs.writeFileSync(cli, `#!/bin/sh\nexec '${CLI}' --config-file '${EXTRA_CONFIG_FILE}' "$@"\n`, { mode: 0o755 });
    }
    const r = await capture([path.join(temp, 'sketches'), '--cli', cli]);
    expect(r.err).toMatch(/^Compiling dimmer for ATTinyCore:avr:attinyx5:chip=85,clock=16pll…$/m);
    expect(r.out).toMatch(/PASS dimmer \(ATtiny85, 0\.6 s simulated\)/);
    expect(r.code).toBe(EXIT.PASS);
  }, 300000);
});
