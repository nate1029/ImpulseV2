// impulse-test: compile Arduino sketches, run them in the simulator against
// their diagram.json circuit, and check the sketch's `// @expect` lines.
// Meant for CI. Exit codes: 0 every expectation passed, 1 something failed
// (an expectation, a compile, a short circuit), 2 nothing could be tested
// (bad arguments, no arduino-cli, no sketch or no @expect lines).

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { runHeadless } from '../renderer/simulation/headless.js';
import { parseExpectations, evaluateExpectations } from '../renderer/simulation/expectations.js';
import { fromDiagram, plugLinks } from '../renderer/simulation/diagram.js';
import { circuitChecks } from '../renderer/simulation/checks.js';
import { BOARDS, boardForFqbn, simulationTarget } from '../renderer/simulation/boards.js';
import { partDef } from '../renderer/simulation/parts/catalog.js';
import toolchain from '../main/services/toolchain.js';
import esp32sim from '../main/services/esp32sim/index.js';
import { setEsp32Bridge } from '../renderer/simulation/esp32-runner.js';

export const EXIT = { PASS: 0, FAIL: 1, ERROR: 2 };

const MAX_SECONDS = 60;
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', '.pio', 'dist', 'out']);

export class UsageError extends Error {}

export const HELP = `Usage: impulse-test [options] <sketch>...

Compiles each Arduino sketch, simulates it with the circuit in its
diagram.json, and checks the "// @expect" lines in its source.

A <sketch> is a sketch folder, its .ino file, or a folder of sketches.

Options:
  --board <id>             Board to simulate: uno, nano, mega, pico, attiny85, esp32, esp32s3, esp32c3 or
                           nanoesp32 (default: the board in diagram.json, else uno)
  --fqbn <fqbn>            Compile for this FQBN (must be a board the simulator runs)
  --seconds <n>            Simulated time per sketch, overriding "// @run" (max ${MAX_SECONDS})
  --expect <line>          Extra expectation for every sketch, e.g. --expect 'pin 13 toggles'
  --hex <file>             Test a prebuilt program instead of compiling: a .hex (AVR boards and the
                           ATtiny85) or a .uf2/.bin (Pico); one sketch, or none with --expect
  --diagram <file>         Circuit to use instead of the sketch's diagram.json
  --strict                 Also fail on wiring errors found by the circuit check
  --format <human|json|junit>  What to print (default: human)
  --json <file>            Also write a JSON report to <file>
  --junit <file>           Also write a JUnit XML report to <file>
  --cli <path>             arduino-cli to use (default: $ARDUINO_CLI, PATH, Arduino IDE or Impulse's own copy)
  --libraries <dir>        Extra library folder for compiling (repeatable)
  -h, --help               Show this help
  -v, --version            Show the version

Expectations (in the sketch, one per line):
  // @expect serial contains "ready"
  // @expect serial matches /temp=\\d+/
  // @expect no serial
  // @expect pin 13 toggles
  // @expect pin 13 frequency 1Hz ±10%
  // @expect pin LED_BUILTIN high
  // @run 5s

Exit codes: 0 all passed, 1 a test failed, 2 nothing could be tested.`;

/** Command-line arguments → options. Throws UsageError. */
export function parseArgs(argv) {
  const opts = {
    sketches: [], board: null, fqbn: null, seconds: null, expect: [], hex: null, diagram: null,
    strict: false, format: 'human', json: null, junit: null, cli: null, libraries: [], help: false, version: false,
  };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || (v.startsWith('-') && v !== '-')) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const take = () => {
      if (eq > 0) return raw.slice(eq + 1);
      const v = value(i, flag);
      i++;
      return v;
    };
    switch (flag) {
      case '-h': case '--help': opts.help = true; break;
      case '-v': case '--version': opts.version = true; break;
      case '--strict': opts.strict = true; break;
      case '--board': {
        const b = take().toLowerCase();
        if (!BOARDS[b]) throw new UsageError(`Unknown board "${b}". The simulator runs: ${Object.keys(BOARDS).join(', ')}`);
        opts.board = b;
        break;
      }
      case '--fqbn': opts.fqbn = take(); break;
      case '--seconds': {
        const s = Number(take());
        if (!(s > 0) || s > MAX_SECONDS) throw new UsageError(`--seconds must be between 0 and ${MAX_SECONDS}`);
        opts.seconds = s;
        break;
      }
      case '--expect': opts.expect.push(take()); break;
      case '--hex': opts.hex = take(); break;
      case '--diagram': opts.diagram = take(); break;
      case '--format': {
        const f = take();
        if (!['human', 'json', 'junit'].includes(f)) throw new UsageError(`--format must be human, json or junit`);
        opts.format = f;
        break;
      }
      case '--json': opts.json = take(); break;
      case '--junit': opts.junit = take(); break;
      case '--cli': opts.cli = take(); break;
      case '--libraries': opts.libraries.push(take()); break;
      default:
        if (raw.startsWith('-') && raw !== '-') throw new UsageError(`Unknown option ${raw}`);
        opts.sketches.push(raw);
    }
  }
  if (opts.fqbn) {
    const board = boardForFqbn(opts.fqbn);
    if (!board) throw new UsageError(`The simulator can't run ${opts.fqbn}. It runs: ${Object.values(BOARDS).map(b => b.fqbn).join(', ')}`);
    if (opts.board && opts.board !== board.id) throw new UsageError(`--fqbn ${opts.fqbn} is not a ${BOARDS[opts.board].label}`);
  }
  if (opts.hex && opts.sketches.length > 1) throw new UsageError('--hex tests one sketch at a time');
  const hexBoard = opts.board ? BOARDS[opts.board] : opts.fqbn ? boardForFqbn(opts.fqbn) : null;
  if (opts.hex && hexBoard?.family === 'esp32') throw new UsageError('--hex runs AVR and Pico programs; ESP32 sketches are compiled for the simulator (its bridge is built in)');
  if (!opts.help && !opts.version && !opts.sketches.length && !(opts.hex && opts.expect.length)) {
    throw new UsageError('Give a sketch to test (or --hex with --expect)');
  }
  return opts;
}

/** The sketch a folder or .ino stands for: { name, dir, files: [main .ino, other .ino…] }. */
function sketchAt(dir) {
  const name = path.basename(dir);
  const main = path.join(dir, `${name}.ino`);
  if (!isFile(main)) return null;
  const others = fs.readdirSync(dir).filter(f => f.endsWith('.ino') && f !== `${name}.ino`).sort();
  return { name, dir, files: [main, ...others.map(f => path.join(dir, f))] };
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/**
 * Sketches named by a command-line target, searching subfolders when the
 * target is a folder of sketches. Throws UsageError when there are none.
 */
export function findSketches(target) {
  const abs = path.resolve(target);
  if (isFile(abs)) {
    if (!abs.endsWith('.ino')) throw new UsageError(`${target} is not an .ino file`);
    const sketch = sketchAt(path.dirname(abs));
    if (!sketch) throw new UsageError(`${target}: an Arduino sketch's main file must be named after its folder (${path.basename(path.dirname(abs))}.ino)`);
    return [sketch];
  }
  if (!isDir(abs)) throw new UsageError(`${target} does not exist`);
  const found = [];
  const walk = (dir, depth) => {
    const sketch = sketchAt(dir);
    if (sketch) { found.push(sketch); return; }
    if (depth >= 6) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(abs, 0);
  if (!found.length) {
    const loose = fs.readdirSync(abs).filter(f => f.endsWith('.ino'));
    if (loose.length) throw new UsageError(`${target}: an Arduino sketch's main file must be named after its folder (${path.basename(abs)}.ino), found ${loose.join(', ')}`);
    throw new UsageError(`No Arduino sketches in ${target}`);
  }
  return found;
}

/** The folder Electron uses for Impulse's data on this system. */
function appDataDirs(platform = process.platform, env = process.env, home = os.homedir()) {
  const base = platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : platform === 'win32' ? (env.APPDATA || path.join(home, 'AppData', 'Roaming'))
      : (env.XDG_CONFIG_HOME || path.join(home, '.config'));
  return ['Impulse IDE', 'arduino-ide-cursor'].map(name => path.join(base, name));
}

/** A command given as a path, or as a name to look up on PATH (with PATHEXT on Windows). */
export function resolveCommand(command, env = process.env, platform = process.platform) {
  if (/[\\/]/.test(command)) return isFile(command) ? command : null;
  const exts = platform === 'win32' && !path.extname(command)
    ? ['', ...String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean).map(e => e.toLowerCase())]
    : [''];
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** arduino-cli to compile with: --cli, $ARDUINO_CLI, then where Impulse looks. */
export function findCli(explicit = null, env = process.env) {
  if (explicit) return resolveCommand(explicit, env);
  if (env.ARDUINO_CLI) return resolveCommand(env.ARDUINO_CLI, env);
  const seen = new Set();
  for (const dir of appDataDirs()) {
    for (const c of toolchain.cliCandidates({ managedDir: path.join(dir, 'toolchain'), env })) {
      if (seen.has(c.path)) continue;
      seen.add(c.path);
      if (isFile(c.path)) return c.path;
    }
  }
  return null;
}

function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code, stdout: String(stdout || ''), stderr: String(stderr || ''), killed: !!err?.killed });
    });
  });
}

/** Last useful lines of compiler output. */
function compilerError(out, dir) {
  // The compiler names files by their real path (/private/var/… for /var/… on macOS), with either slash on Windows.
  const real = (() => { try { return fs.realpathSync.native(dir); } catch { return dir; } })();
  // Longest first: the real path contains the given one.
  const prefixes = [...new Set([dir, real].flatMap(d => [d + path.sep, `${d.split(path.sep).join('/')}/`]))]
    .sort((a, b) => b.length - a.length);
  const relative = (line) => prefixes.reduce((l, p) => l.split(p).join(''), line);
  const lines = out.split('\n').map(l => relative(l.trimEnd())).filter(Boolean);
  const errors = lines.filter(l => /error:|not found|No such file/i.test(l) && !/^Error during build/.test(l));
  return (errors.length ? errors : lines).slice(0, 12).join('\n') || 'arduino-cli failed without output';
}

export class SetupError extends Error {}

/** Board-manager URLs of the simulated boards' cores that arduino-cli doesn't know by default. */
const CORE_URLS = {
  'rp2040:rp2040': 'https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json',
  'ATTinyCore:avr': 'https://drazzy.com/package_drazzy.com_index.json',
};

let esp32 = null;

/** The ESP32 simulator (Espressif's QEMU), shared with an installed Impulse when there is one. */
function esp32Simulator(cli) {
  if (esp32) return esp32;
  const dataRoot = appDataDirs().find(d => fs.existsSync(d)) || appDataDirs()[0];
  const bundled = process.platform === 'darwin' ? '/Applications/Impulse IDE.app/Contents/Resources' : null;
  esp32 = new esp32sim.Esp32Simulator({
    runCli: async (args, o = {}) => {
      const r = await run(cli, args, o.timeout || 15 * 60 * 1000);
      return { success: r.ok, stdout: r.stdout, stderr: r.stderr };
    },
    dataDir: process.env.IMPULSE_EMULATOR_DIR || path.join(dataRoot, 'emulators'),
    bundledDir: bundled ? esp32sim.bundledQemuDir(bundled) : null,
  });
  setEsp32Bridge(() => esp32sim.localBridge(esp32));
  return esp32;
}

/** Stop ESP32 emulators still running (end of a test run). */
export function stopEmulators() {
  esp32?.stopAll();
}

/** Compile for the ESP32 simulator: a flash image ({ image, chip }) with the bridge built in. */
async function compileEsp32(cli, sketch, fqbn, libraries) {
  if (libraries.length) throw new Error('--libraries isn\'t supported for ESP32 boards yet; install the libraries with arduino-cli lib install');
  const sim = esp32Simulator(cli);
  const res = await sim.build(sketch.dir, fqbn);
  if (!res.success) {
    if (res.missingCore) {
      const core = fqbn.split(':').slice(0, 2).join(':');
      const url = core === 'esp32:esp32' ? ' --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json' : '';
      throw new SetupError(`arduino-cli has no core for ${fqbn}. Install it with: arduino-cli core install ${core}${url}`);
    }
    throw new Error(compilerError(res.error, sketch.dir));
  }
  try {
    await sim.installEmulator(res.esp32.chip);
  } catch (err) {
    throw new SetupError(`The ESP32 emulator isn't available: ${err.message}`);
  }
  return res.esp32;
}

/** Compile a sketch folder; resolves to the HEX text. Throws SetupError when the toolchain is missing. */
export async function compile(cli, sketch, fqbn, libraries = [], properties = {}) {
  if (/^(esp32|arduino):esp32:/.test(fqbn)) return compileEsp32(cli, sketch, fqbn, libraries);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-test-'));
  try {
    const props = Object.entries(properties).flatMap(([k, v]) => ['--build-property', `${k}=${v}`]);
    const args = ['compile', '--fqbn', fqbn, ...props, ...libraries.flatMap(l => ['--libraries', path.resolve(l)]), '--output-dir', out, sketch.dir];
    const res = await run(cli, args, 15 * 60 * 1000);
    if (!res.ok) {
      const text = `${res.stderr}\n${res.stdout}`;
      if (/platform not installed|Platform '[^']+' not found|unknown package/i.test(text)) {
        const core = fqbn.split(':').slice(0, 2).join(':');
        const url = CORE_URLS[core] ? ` --additional-urls ${CORE_URLS[core]}` : '';
        throw new SetupError(`arduino-cli has no core for ${fqbn}. Install it with: arduino-cli core install ${core}${url}`);
      }
      throw new Error(res.killed ? 'Compiling took longer than 15 minutes' : compilerError(text, sketch.dir));
    }
    // AVR chips: the HEX text; the Raspberry Pi Pico: the UF2 image.
    const pico = /^rp2040:/.test(fqbn);
    const file = path.join(out, `${sketch.name}.ino.${pico ? 'uf2' : 'hex'}`);
    if (!isFile(file)) throw new Error(`arduino-cli did not produce ${path.basename(file)}`);
    return pico ? new Uint8Array(fs.readFileSync(file)) : fs.readFileSync(file, 'utf8');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

/** Read and convert a diagram.json; null when there is none. */
export function loadDiagram(file) {
  if (!file || !isFile(file)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
  const model = fromDiagram(data);
  if (model.errors.length) throw new Error(`${file}: ${model.errors.join(' ')}`);
  return model;
}

/** The simulated board a circuit is built around, or null. */
export function diagramBoard(model) {
  const boardPart = model?.parts.find(p => partDef(p.type)?.board);
  return boardPart ? partDef(boardPart.type).board : null;
}

/**
 * Test one sketch (or a prebuilt HEX with no sketch).
 * @returns {Promise<object>} the sketch's report entry
 */
export async function testSketch(sketch, opts, { cli, onStage = () => {} } = {}) {
  const started = Date.now();
  const entry = {
    name: sketch?.name || path.basename(opts.hex).replace(/(\.ino)?(\.with_bootloader)?\.hex$/i, ''),
    path: sketch?.dir || path.resolve(opts.hex),
    board: null, fqbn: null, seconds: null, status: 'passed', error: null,
    results: [], warnings: [], serial: '', duration: 0,
  };
  const finish = (status, error = null) => {
    entry.status = status;
    entry.error = error;
    entry.duration = (Date.now() - started) / 1000;
    return entry;
  };
  try {
    const diagramFile = opts.diagram ? path.resolve(opts.diagram) : sketch && path.join(sketch.dir, 'diagram.json');
    if (opts.diagram && !isFile(diagramFile)) throw new UsageError(`${opts.diagram} does not exist`);
    const model = loadDiagram(diagramFile);
    const circuitBoard = diagramBoard(model);
    const asked = opts.board || (opts.fqbn && boardForFqbn(opts.fqbn).id) || null;
    if (asked && circuitBoard && asked !== circuitBoard) {
      const a = (label) => `${/^[AEIOU]/i.test(label) ? 'an' : 'a'} ${label}`;
      return finish('error', `diagram.json is built around ${a(BOARDS[circuitBoard].label)}, but the test asks for ${a(BOARDS[asked].label)}`);
    }
    const board = BOARDS[asked || circuitBoard || 'uno'];
    entry.board = board.id;
    // A board the simulator runs as another (a Pro Mini 168 on the Nano) compiles as its 16 MHz twin.
    const target = opts.fqbn ? simulationTarget(opts.fqbn) : null;
    entry.fqbn = target?.fqbn || board.fqbn;
    if (model?.unsupported.length) entry.warnings.push(`Not simulated: ${model.unsupported.join(', ')}`);

    // Expectations from every .ino tab; @run comes from the main file.
    const items = [];
    const parseErrors = [];
    let seconds = 3;
    for (const [i, file] of (sketch?.files || []).entries()) {
      const parsed = parseExpectations(fs.readFileSync(file, 'utf8'), board.id);
      if (i === 0) seconds = parsed.seconds;
      const rel = path.basename(file);
      items.push(...parsed.items.map(it => ({ ...it, file: rel })));
      parseErrors.push(...parsed.errors.map(e => ({ ...e, file: rel })));
    }
    for (const line of opts.expect) {
      const parsed = parseExpectations(`// @expect ${line}`, board.id);
      items.push(...parsed.items.map(it => ({ ...it, file: null, line: null })));
      parseErrors.push(...parsed.errors.map(e => ({ ...e, file: null, line: null })));
    }
    const invalid = parseErrors.map(e => ({ expectation: null, file: e.file, line: e.line, pass: false, detail: e.message }));
    entry.results.push(...invalid);
    if (!items.length && !parseErrors.length) return finish('skipped', 'No // @expect lines');
    entry.seconds = Math.min(opts.seconds ?? seconds, MAX_SECONDS);

    let hex;
    if (opts.hex) {
      if (!isFile(opts.hex)) throw new UsageError(`${opts.hex} does not exist`);
      hex = /\.(uf2|bin)$/i.test(opts.hex) ? new Uint8Array(fs.readFileSync(opts.hex)) : fs.readFileSync(opts.hex, 'utf8');
    } else {
      onStage('compile', entry);
      try {
        hex = await compile(cli, sketch, entry.fqbn, opts.libraries, target?.properties || {});
      } catch (err) {
        if (err instanceof SetupError) throw err;
        return finish('error', `Compile failed: ${err.message}`);
      }
    }

    onStage('run', entry);
    const result = await runHeadless(hex, { seconds: entry.seconds, board: board.id, mcu: target?.mcu, circuit: model || undefined });
    entry.serial = result.serial;
    const order = (sketch?.files || []).map(f => path.basename(f));
    const rank = (r) => [r.file === null ? order.length : order.indexOf(r.file), r.line ?? Number.MAX_SAFE_INTEGER];
    entry.results = [...invalid, ...evaluateExpectations(items, result, board.id).map((r, i) => (
      { expectation: r.raw, file: items[i].file, line: items[i].line, pass: r.pass, detail: r.detail }))]
      .sort((a, b) => { const [fa, la] = rank(a); const [fb, lb] = rank(b); return fa - fb || la - lb; });
    for (const s of result.shorts) {
      entry.results.push({ expectation: 'no short circuits', file: null, line: null, pass: false, detail: `${s.tags.join(' and ')} are wired together while driving different levels` });
    }
    if (model) {
      for (const issue of circuitChecks({ ...model, links: plugLinks(model.parts) })) {
        if (issue.level === 'info') continue;
        if (opts.strict && issue.level === 'error') {
          entry.results.push({ expectation: 'circuit check', file: 'diagram.json', line: null, pass: false, detail: issue.text });
        } else {
          entry.warnings.push(issue.text);
        }
      }
    }
    if (result.truncated) entry.warnings.push('The run produced more serial output or pin changes than are kept; later output was not checked.');
    return finish(entry.results.every(r => r.pass) ? 'passed' : 'failed');
  } catch (err) {
    if (err instanceof UsageError || err instanceof SetupError) throw err;
    if (err.serial) entry.serial = err.serial;
    return finish('error', err.message);
  }
}

// ── Reports ────────────────────────────────────────────────────────────────

export function summarize(entries) {
  const results = entries.flatMap(e => e.results);
  return {
    sketches: entries.length,
    passed: entries.filter(e => e.status === 'passed').length,
    failed: entries.filter(e => e.status === 'failed').length,
    errors: entries.filter(e => e.status === 'error').length,
    skipped: entries.filter(e => e.status === 'skipped').length,
    expectations: results.length,
    expectationsPassed: results.filter(r => r.pass).length,
    expectationsFailed: results.filter(r => !r.pass).length,
  };
}

export function exitCode(entries) {
  const s = summarize(entries);
  if (s.failed || s.errors) return EXIT.FAIL;
  if (!s.passed) return EXIT.ERROR;
  return EXIT.PASS;
}

export function jsonReport(entries, { version, cli } = {}) {
  return JSON.stringify({ tool: 'impulse-test', version, cli, passed: exitCode(entries) === EXIT.PASS, summary: summarize(entries), sketches: entries }, null, 2);
}

const xml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))
  // Characters XML 1.0 can't carry (stray control bytes from a sketch's serial output).
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

export function junitReport(entries) {
  const s = summarize(entries);
  const total = entries.reduce((t, e) => t + e.duration, 0);
  const out = ['<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="impulse-test" tests="${s.expectations + s.errors + s.skipped}" failures="${s.expectationsFailed}" errors="${s.errors}" skipped="${s.skipped}" time="${total.toFixed(3)}">`];
  for (const e of entries) {
    const failures = e.results.filter(r => !r.pass).length;
    const tests = e.results.length + (e.status === 'error' || e.status === 'skipped' ? 1 : 0);
    out.push(`  <testsuite name="${xml(e.name)}" tests="${tests}" failures="${failures}" errors="${e.status === 'error' ? 1 : 0}" skipped="${e.status === 'skipped' ? 1 : 0}" time="${e.duration.toFixed(3)}" file="${xml(e.path)}">`);
    if (e.status === 'error') out.push(`    <testcase name="compile and run" classname="${xml(e.name)}"><error message="${xml(e.error.split('\n')[0])}">${xml(e.error)}</error></testcase>`);
    if (e.status === 'skipped') out.push(`    <testcase name="expectations" classname="${xml(e.name)}"><skipped message="${xml(e.error)}"/></testcase>`);
    for (const r of e.results) {
      const name = `${r.expectation || 'invalid expectation'}${r.line ? ` (${r.file}:${r.line})` : ''}`;
      if (r.pass) out.push(`    <testcase name="${xml(name)}" classname="${xml(e.name)}"/>`);
      else out.push(`    <testcase name="${xml(name)}" classname="${xml(e.name)}"><failure message="${xml(r.detail)}">${xml(r.detail)}</failure></testcase>`);
    }
    if (e.serial) out.push(`    <system-out>${xml(e.serial)}</system-out>`);
    out.push('  </testsuite>');
  }
  out.push('</testsuites>', '');
  return out.join('\n');
}

export function colors(enabled) {
  const c = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { green: c(32), red: c(31), yellow: c(33), dim: c(2), bold: c(1) };
}

/** Human-readable lines for one finished sketch. */
export function humanSketch(e, paint = colors(false)) {
  const lines = [];
  const where = (r) => (r.line ? paint.dim(`  ${r.file}:${r.line}`) : '');
  const ran = e.status === 'passed' || e.status === 'failed';
  const board = e.board ? `${BOARDS[e.board].label}${ran && e.seconds ? `, ${e.seconds} s simulated` : ''}` : '';
  const mark = { passed: paint.green('PASS'), failed: paint.red('FAIL'), error: paint.red('ERROR'), skipped: paint.yellow('SKIP') }[e.status];
  lines.push(`${mark} ${paint.bold(e.name)}${board ? paint.dim(` (${board})`) : ''}`);
  for (const r of e.results) {
    lines.push(`  ${r.pass ? paint.green('✓') : paint.red('✗')} ${r.expectation || 'invalid expectation'} ${paint.dim('—')} ${r.detail}${where(r)}`);
  }
  if (e.error) lines.push(...e.error.split('\n').map(l => `  ${e.status === 'skipped' ? paint.dim(l) : paint.red(l)}`));
  for (const w of e.warnings) lines.push(`  ${paint.yellow('!')} ${w}`);
  if ((e.status === 'failed' || e.status === 'error') && e.serial) {
    const tail = e.serial.trimEnd().split('\n').slice(-8);
    lines.push(paint.dim('  serial output (last lines):'), ...tail.map(l => paint.dim(`  │ ${l}`)));
  }
  return lines.join('\n');
}

export function humanSummary(entries, seconds, paint = colors(false)) {
  const s = summarize(entries);
  const parts = [`${s.passed} passed`];
  if (s.failed) parts.push(paint.red(`${s.failed} failed`));
  if (s.errors) parts.push(paint.red(`${s.errors} could not run`));
  if (s.skipped) parts.push(paint.yellow(`${s.skipped} without tests`));
  return `\n${s.sketches} sketch${s.sketches === 1 ? '' : 'es'}: ${parts.join(', ')} · ${s.expectationsPassed}/${s.expectations} expectations passed · ${seconds.toFixed(1)} s`;
}

/**
 * Run the command. Returns the exit code; never calls process.exit.
 * @param {string[]} argv
 * @param {{ version?: string, stdout?: {write}, stderr?: {write}, color?: boolean }} [io]
 */
export async function main(argv, { version = '0.0.0', stdout = process.stdout, stderr = process.stderr, color = false } = {}) {
  const started = Date.now();
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    stderr.write(`impulse-test: ${err.message}\nRun impulse-test --help for usage.\n`);
    return EXIT.ERROR;
  }
  if (opts.help) { stdout.write(`${HELP}\n`); return EXIT.PASS; }
  if (opts.version) { stdout.write(`${version}\n`); return EXIT.PASS; }

  const paint = colors(color && opts.format === 'human');
  const human = opts.format === 'human';
  const entries = [];
  let cli = null;
  try {
    const sketches = opts.sketches.flatMap(findSketches);
    if (!opts.hex) {
      cli = findCli(opts.cli);
      if (!cli) {
        throw new SetupError(opts.cli ? `arduino-cli not found at ${opts.cli}`
          : 'arduino-cli not found. Install it (https://arduino.github.io/arduino-cli/), open Impulse IDE once to set it up, or pass --cli <path>.');
      }
    }
    const targets = sketches.length ? sketches : [null];
    for (const sketch of targets) {
      const entry = await testSketch(sketch, opts, {
        cli,
        onStage: (stage, e) => { if (human && stage === 'compile') stderr.write(paint.dim(`Compiling ${e.name} for ${e.fqbn}…\n`)); },
      });
      entries.push(entry);
      if (human) stdout.write(`${humanSketch(entry, paint)}\n`);
    }
  } catch (err) {
    if (!(err instanceof UsageError || err instanceof SetupError)) throw err;
    stderr.write(`impulse-test: ${err.message}\n`);
    return EXIT.ERROR;
  } finally {
    stopEmulators();
  }

  const meta = { version, cli };
  if (opts.format === 'json') stdout.write(`${jsonReport(entries, meta)}\n`);
  if (opts.format === 'junit') stdout.write(junitReport(entries));
  if (opts.json) fs.writeFileSync(opts.json, `${jsonReport(entries, meta)}\n`);
  if (opts.junit) fs.writeFileSync(opts.junit, junitReport(entries));
  const code = exitCode(entries);
  if (human) stdout.write(`${humanSummary(entries, (Date.now() - started) / 1000, paint)}\n`);
  if (code === EXIT.ERROR) stderr.write('impulse-test: no sketch had // @expect lines to check.\n');
  return code;
}
