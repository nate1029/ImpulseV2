// EmbedBench: real embedded tasks, scored by compiling the sketch a model
// writes and running it in Impulse's simulator against the task's own checks.
// It compares the same model alone and with Impulse's knowledge (the facts
// the app sends with every request), and says what each costs. bench/README.md
// explains the tasks, the variants and the report.
//
//   npm run bench -- --reference                        # every task with its reference sketch (validates the tasks)
//   npm run bench -- --model gpt-5.4-mini               # both variants, every task
//   npm run bench -- --model gpt-5.4-mini --variants impulse --tasks uno-,esp32-timer
//   npm run bench -- --model gpt-5.4 --limit 10 --jobs 4 --write --label nightly
//
// Needs arduino-cli with arduino:avr, esp32:esp32 and arduino:esp32 installed.
// Pico tasks need IMPULSE_EXTRA_CORES_CONFIG (an arduino-cli config whose data
// folder has rp2040:rp2040) and are skipped without it. Model runs read
// OPENAI_API_KEY, or the OPENAI_API_KEY line of cloud/.env. Libraries a sketch
// needs are installed into a scratch sketchbook (--scratch DIR), never the
// global one, the way the app installs them.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { markdownReport } from './embedbench-report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const BoardKnowledge = require(path.join(root, 'src/main/services/ai/knowledge/boardKnowledge.js'));
const { componentFacts } = require(path.join(root, 'src/main/services/ai/knowledge/components.js'));
const { namedBoardFacts } = require(path.join(root, 'src/main/services/ai/knowledge/boardRecords.js'));
const { circuitBlock } = require(path.join(root, 'src/main/services/ai/knowledge/circuitFacts.js'));
const { LibraryService } = require(path.join(root, 'src/main/services/libraryService.js'));
const { lint, autofix, lintReport } = require(path.join(root, 'src/main/services/ai/knowledge/linter.js'));
const { decode, rewrite, decodedText } = require(path.join(root, 'src/main/services/ai/knowledge/errorDecoder.js'));
const { validateCircuit, layoutCircuit } = await import(pathToFileURL(path.join(root, 'src/renderer/simulation/circuit-ai.js')).href);
const { PARTS } = await import(pathToFileURL(path.join(root, 'src/renderer/simulation/parts/catalog.js')).href);
const { MODELS } = await import(pathToFileURL(path.join(root, 'cloud/src/pricing.js')).href);

// ---- arguments ------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const REFERENCE = flag('reference');
const MODEL = value('model', REFERENCE ? null : 'gpt-5.4-mini');
const VARIANTS = REFERENCE ? ['reference'] : value('variants', 'alone,impulse').split(',').map((v) => v.trim()).filter(Boolean);
const ONLY = value('tasks') ? value('tasks').split(',').map((t) => t.trim()).filter(Boolean) : null;
const LIMIT = Number(value('limit', 0)) || 0;
const JOBS = Math.max(1, Number(value('jobs', 3)) || 3);
// Simulations at once: the ESP32 emulator follows the host clock, so too many
// at a time slow it enough to fail timing checks a correct sketch passes.
const SIM_JOBS = Math.max(1, Number(value('sim-jobs', 2)) || 2);
const EFFORT = value('effort', 'low');
const MAX_OUTPUT = Number(value('max-output', 12000)) || 12000;
const LABEL = value('label', REFERENCE ? 'reference' : MODEL);
const SCRATCH = path.resolve(value('scratch', path.join(os.tmpdir(), 'impulse-bench')));
const cli = process.env.ARDUINO_CLI || 'arduino-cli';
for (const v of VARIANTS) {
  if (!['alone', 'impulse', 'impulse-fix', 'reference'].includes(v)) throw new Error(`Unknown variant "${v}": use alone, impulse, impulse-fix or --reference`);
}

// The boards the simulator runs, as the tasks name them.
const BOARDS = {
  uno: { fqbn: 'arduino:avr:uno', part: 'wokwi-arduino-uno', id: 'uno', name: 'Arduino Uno R3' },
  esp32: { fqbn: 'esp32:esp32:esp32doit-devkit-v1', part: 'wokwi-esp32-devkit-v1', id: 'esp', name: 'ESP32 DevKit V1' },
  esp32s3: { fqbn: 'esp32:esp32:esp32s3', part: 'impulse-esp32-s3-devkitc', id: 'esp', name: 'ESP32-S3 DevKitC-1' },
  esp32c3: { fqbn: 'esp32:esp32:esp32c3', part: 'impulse-esp32-c3-devkitm', id: 'esp', name: 'ESP32-C3 DevKitM-1' },
  pico: { fqbn: 'rp2040:rp2040:rpipico', part: 'impulse-pi-pico', id: 'pico', name: 'Raspberry Pi Pico', extra: true },
  nanoesp32: { fqbn: 'arduino:esp32:nano_nora', part: 'impulse-nano-esp32', id: 'nano', name: 'Arduino Nano ESP32' },
};

// ---- scratch setup: its own library index and sketchbook ------------------
const run = (cmd, opts = {}) => spawnSync(cli, cmd, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
fs.mkdirSync(path.join(SCRATCH, 'sketchbook', 'libraries'), { recursive: true });
const libConfig = path.join(SCRATCH, 'arduino-cli.yaml');
if (!fs.existsSync(libConfig)) {
  fs.writeFileSync(libConfig, ['directories:', `  data: ${path.join(SCRATCH, 'data')}`, `  downloads: ${path.join(SCRATCH, 'downloads')}`, `  user: ${path.join(SCRATCH, 'sketchbook')}`, ''].join('\n'));
}
if (!fs.existsSync(path.join(SCRATCH, 'data', 'library_index.json'))) {
  console.log('Downloading the library index into the scratch folder…');
  const res = run(['--config-file', libConfig, 'lib', 'update-index']);
  if (res.status !== 0) throw new Error(`arduino-cli lib update-index failed: ${res.stderr}`);
}
const extraConfig = process.env.IMPULSE_EXTRA_CORES_CONFIG || '';
const extraData = extraConfig && fs.existsSync(extraConfig) ? /data:\s*(.+)/.exec(fs.readFileSync(extraConfig, 'utf8'))?.[1]?.trim() : '';

const runCliAsync = (prefix) => (cmdArgs, { timeout = 60000 } = {}) => new Promise((resolve) => {
  const child = spawn(cli, [...prefix, ...cmdArgs]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  child.on('close', (code) => { clearTimeout(timer); resolve({ success: code === 0, stdout, stderr }); });
});
const libraries = new LibraryService(runCliAsync(['--config-file', libConfig]));
const knowledge = new BoardKnowledge(runCliAsync([]));
const picoKnowledge = extraConfig ? new BoardKnowledge(runCliAsync(['--config-file', extraConfig])) : null;

// ---- tasks ------------------------------------------------------------------
const TASKS = JSON.parse(fs.readFileSync(path.join(root, 'bench/tasks.json'), 'utf8')).tasks;
let tasks = TASKS.filter((t) => !ONLY || ONLY.some((o) => t.id.startsWith(o) || t.id === o));
const skipped = [];
tasks = tasks.filter((t) => {
  if (BOARDS[t.board]?.extra && !extraData) { skipped.push(`${t.id} (Pico: set IMPULSE_EXTRA_CORES_CONFIG)`); return false; }
  return true;
});
if (LIMIT) tasks = tasks.slice(0, LIMIT);

/** A task's circuit as diagram.json, built the way the app's circuit builder builds one. */
function diagramFor(task) {
  if (!task.circuit) return null;
  const board = BOARDS[task.board];
  const spec = { parts: [{ type: board.part, id: board.id }, ...task.circuit.parts], connections: task.circuit.connections };
  const checked = validateCircuit(spec);
  if (!checked.ok) throw new Error(`${task.id}: bad circuit: ${checked.errors.join('; ')}`);
  const laid = layoutCircuit(checked.circuit);
  return {
    version: 1,
    author: 'EmbedBench',
    editor: 'impulse',
    parts: laid.parts.map((p) => ({ type: PARTS[p.type]?.saveAs || p.type, id: p.id, top: p.y, left: p.x, attrs: p.attrs })),
    connections: laid.wires.map((w) => [`${w.from.partId}:${w.from.pin}`, `${w.to.partId}:${w.to.pin}`, 'green', []]),
  };
}

/** The [CIRCUIT] block the app would send, from the task's wiring. */
function circuitText(task) {
  if (!task.circuit) return null;
  const board = BOARDS[task.board];
  const label = (id) => {
    const p = task.circuit.parts.find((x) => x.id === id);
    return p ? `${PARTS[p.type]?.label || p.type} (${id})` : id;
  };
  const lines = [];
  for (const [a, b] of task.circuit.connections) {
    const [ida, pina] = a.split(':');
    const [idb, pinb] = b.split(':');
    if (ida === board.id && idb !== board.id) lines.push(`Board pin ${pina}: ${label(idb)} ${pinb}`);
    else if (idb === board.id && ida !== board.id) lines.push(`Board pin ${pinb}: ${label(ida)} ${pina}`);
    else if (ida === board.id && idb === board.id) lines.push(`Board pin ${pina} is wired to board pin ${pinb}`);
  }
  return circuitBlock({ hasCircuit: true, parts: task.circuit.parts.map((p) => label(p.id)), lines, checks: [], changedBy: 'user' });
}

// ---- prompts ----------------------------------------------------------------
const BASE = [
  'You write Arduino sketches. Reply with one complete sketch for the board in the request, in a single ```cpp code block, then at most two sentences.',
  'The sketch must compile with arduino-cli for that board as it is, using only the board\'s core and libraries from the Arduino Library Manager.',
].join(' ');
const IMPULSE_RULES = [
  'Use the facts below, which Impulse read from this computer\'s toolchain: the board\'s real pins, its core version and that version\'s API, the parts and their wiring.',
  'They say how they are known (Proof L0 not yet checked … L2 read from the installed core, L3 compiled by Impulse). Prefer them to your memory. Never guess a pin, a voltage, an address or an API.',
].join(' ');

async function impulseFacts(task) {
  const board = BOARDS[task.board];
  const kb = board.extra ? picoKnowledge : knowledge;
  const blocks = [];
  const facts = kb ? await kb.summary(board.fqbn).catch(() => null) : null;
  if (facts) blocks.push(facts);
  const named = namedBoardFacts(userMessage(task), { fqbn: board.fqbn });
  if (named) blocks.push(named);
  const parts = componentFacts(task.ask, { fqbn: board.fqbn });
  if (parts) blocks.push(parts);
  const circuit = circuitText(task);
  if (circuit) blocks.push(circuit);
  return blocks.join('\n\n');
}

function userMessage(task) {
  return `Board: ${task.boardName || BOARDS[task.board].name}.\n${task.ask}`;
}

// ---- the model ----------------------------------------------------------------
function openaiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const env = path.join(root, 'cloud/.env');
  if (!fs.existsSync(env)) return '';
  for (const line of fs.readFileSync(env, 'utf8').split('\n')) {
    const m = /^\s*OPENAI_API_KEY\s*=\s*(.*)\s*$/.exec(line);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}
const KEY = REFERENCE ? '' : openaiKey();
if (!REFERENCE && !KEY) throw new Error('No OpenAI key: set OPENAI_API_KEY or put it in cloud/.env.');
const PRICE = MODEL ? MODELS[MODEL] : null;
if (!REFERENCE && !PRICE) throw new Error(`Unknown model "${MODEL}". Known: ${Object.keys(MODELS).filter((m) => MODELS[m].vendor === 'openai').join(', ')}`);

/** One POST over a fresh HTTPS connection: no shared pool to go stale after a network blip. */
function postJson(url, body, { timeoutMs = 240000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(url, {
      method: 'POST',
      agent: new https.Agent({ keepAlive: false }),
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: timeoutMs,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(data);
  });
}

async function callModel(instructions, input) {
  // input: the user's message, or a conversation [{ role, content }] for a repair round.
  const body = { model: MODEL, instructions, input, reasoning: { effort: EFFORT }, max_output_tokens: MAX_OUTPUT, store: false };
  let lastError = '';
  for (let attempt = 0; attempt < 7; attempt++) {
    try {
      const { status, json } = await postJson('https://api.openai.com/v1/responses', body);
      if (status >= 200 && status < 300) {
        const text = (json.output || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
        return { text, usage: json.usage || {} };
      }
      lastError = `${status} ${json?.error?.message || ''}`.trim();
      if (![408, 409, 429, 500, 502, 503, 504].includes(status)) break;
    } catch (error) {
      lastError = error.message; // network trouble: wait and try a fresh connection
    }
    await new Promise((r) => setTimeout(r, Math.min(60000, 2000 * 2 ** attempt)));
  }
  return { error: lastError || 'the model call failed', text: '', usage: {} };
}

function costOf(usage) {
  if (!PRICE) return 0;
  const cached = usage.input_tokens_details?.cached_tokens || 0;
  const input = (usage.input_tokens || 0) - cached;
  return (input * PRICE.input + cached * (PRICE.cacheRead ?? PRICE.input) + (usage.output_tokens || 0) * PRICE.output) / 1e6;
}

/** The sketch in an answer: the longest code block that has setup(). */
function extractSketch(text) {
  const blocks = [...String(text).matchAll(/```[ \t]*([\w+-]*)[ \t]*\r?\n([\s\S]*?)```/g)].map((m) => m[2]);
  const withSetup = blocks.filter((b) => /\bvoid\s+setup\s*\(/.test(b));
  const pick = (withSetup.length ? withSetup : blocks).sort((a, b) => b.length - a.length)[0];
  return pick ? `${pick.trim()}\n` : null;
}

// ---- scoring --------------------------------------------------------------------
function prepareSketch(dir, name, code, task) {
  fs.mkdirSync(dir, { recursive: true });
  // The checks are the task's, not the writer's: drop any the sketch brought.
  const body = code.split('\n').filter((l) => !/^\s*\/\/\s*@(expect|run)\b/.test(l)).join('\n').trimEnd();
  const checks = [...task.expect.map((e) => `// @expect ${e}`), `// @run ${task.seconds || 3}s`];
  fs.writeFileSync(path.join(dir, `${name}.ino`), `${body}\n\n// Checks added by EmbedBench:\n${checks.join('\n')}\n`);
  const diagram = diagramFor(task);
  if (diagram) fs.writeFileSync(path.join(dir, 'diagram.json'), JSON.stringify(diagram, null, 2));
  return diagram ? path.join(dir, 'diagram.json') : null;
}

const installing = new Map();
async function installLibraries(code, fqbn) {
  const installed = [];
  const missing = await libraries.missingFor(code, { fqbn }).catch(() => []);
  for (const m of missing) {
    const name = m.suggestion.name;
    if (!installing.has(name)) {
      installing.set(name, libraries.install(name).then(() => true, () => false));
    }
    if (await installing.get(name)) installed.push(name);
  }
  return [...new Set(installed)];
}

let simRunning = 0;
const simQueue = [];
async function withSimSlot(fn) {
  if (simRunning >= SIM_JOBS) await new Promise((resolve) => simQueue.push(resolve));
  simRunning++;
  try {
    return await fn();
  } finally {
    simRunning--;
    simQueue.shift()?.();
  }
}

function runSim(task, dir, diagram) {
  const board = BOARDS[task.board];
  const json = path.join(dir, 'impulse-test.json');
  const env = {
    ...process.env,
    ARDUINO_DIRECTORIES_USER: path.join(SCRATCH, 'sketchbook'),
    ARDUINO_DIRECTORIES_DOWNLOADS: path.join(SCRATCH, 'downloads'),
    ...(board.extra ? { ARDUINO_DIRECTORIES_DATA: extraData } : {}),
  };
  const cmd = [path.join(root, 'bin/impulse-test.mjs'), '--board', task.board, '--json', json, ...(diagram ? ['--diagram', diagram] : []), dir];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, cmd, { env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    // SIGTERM first, so impulse-test can stop the emulator it started.
    const timer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000); }, 8 * 60 * 1000);
    child.on('close', () => {
      clearTimeout(timer);
      let report = null;
      try { report = JSON.parse(fs.readFileSync(json, 'utf8')); } catch { /* no report */ }
      const s = report?.sketches?.[0];
      if (!s) return resolve({ status: 'error', error: out.trim().split('\n').slice(-3).join(' | ').slice(0, 400), results: [] });
      resolve({ status: s.status, error: s.error, results: s.results || [], serial: String(s.serial || '').slice(-1500), seconds: s.duration });
    });
  });
}

/** Compile-only tasks (features the simulator cannot run, like ESP-NOW): pass when the sketch builds. */
function compileOnly(task, dir) {
  const board = BOARDS[task.board];
  const env = {
    ...process.env,
    ARDUINO_DIRECTORIES_USER: path.join(SCRATCH, 'sketchbook'),
    ARDUINO_DIRECTORIES_DOWNLOADS: path.join(SCRATCH, 'downloads'),
    ...(board.extra ? { ARDUINO_DIRECTORIES_DATA: extraData } : {}),
  };
  return new Promise((resolve) => {
    const child = spawn(cli, ['compile', '--fqbn', board.fqbn, '--warnings', 'none', dir], { env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 8 * 60 * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { status: 'passed', results: [] } : { status: 'error', error: out, results: [] });
    });
  });
}

/** The board facts the linter needs (core version, LED_BUILTIN), as the app reads them. */
async function lintContext(task) {
  const board = BOARDS[task.board];
  const kb = board.extra ? picoKnowledge : knowledge;
  const info = kb ? await kb.boardInfo(board.fqbn).catch(() => null) : null;
  const pins = info?.pins && Object.keys(info.pins).length ? info.pins : null;
  return { fqbn: board.fqbn, coreVersion: String(info?.core || '').split(' ')[1] || '', ledBuiltin: pins ? (pins.LED_BUILTIN ?? null) : undefined };
}

/**
 * The app's verify loop on a sketch: the linter's mechanical fixes, a compile,
 * the error decoder's rewrites, and (when something still fails) one more
 * round with the model, given the decoded causes and the linter's findings.
 */
async function verifyLoop(task, dir, name, code, conversation, instructions) {
  const ctx = await lintContext(task);
  const steps = [];
  let current = code;
  const fixed = autofix(current, ctx);
  if (fixed.applied.length) { current = fixed.code; steps.push(`lint rewrite: ${fixed.applied.join(', ')}`); }
  const tryCompile = async (text) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.ino`), text);
    await installLibraries(text, BOARDS[task.board].fqbn);
    return compileOnly(task, dir);
  };
  let built = await tryCompile(current);
  if (built.status === 'error') {
    const rw = rewrite(current, built.error, { fqbn: ctx.fqbn, ledPin: typeof ctx.ledBuiltin === 'number' ? ctx.ledBuiltin : null });
    if (rw.applied.length) {
      steps.push(`decoder rewrite: ${rw.applied.join(', ')}`);
      current = rw.code;
      built = await tryCompile(current);
    }
  }
  const lintErrors = lint(current, { ...ctx, built: built.status !== 'error' }).filter((f) => f.level === 'error');
  let extra = null;
  if (built.status === 'error' || lintErrors.length) {
    const decoded = built.status === 'error' ? decode(built.error, { fqbn: ctx.fqbn }) : [];
    const feedback = [
      built.status === 'error' ? `[VERIFY] The sketch does not compile:\n${decoded.length ? decodedText(decoded) : String(built.error).split('\n').filter((l) => /error/.test(l)).slice(0, 4).join('\n')}` : '',
      lintErrors.length ? `[LINT] Impulse's hardware linter found what will fail on this board:\n${lintReport(lintErrors)}` : '',
      'Fix it and reply with the whole corrected sketch in one ```cpp block.',
    ].filter(Boolean).join('\n\n');
    const answer = await callModel(instructions, [...conversation, { role: 'user', content: feedback }]);
    extra = answer;
    steps.push('repair round');
    const next = answer.error ? null : extractSketch(answer.text);
    if (next) {
      current = autofix(next, ctx).code;
    }
  }
  return { code: current, steps, extra };
}

// ---- one task, one variant ----------------------------------------------------------
const outRoot = path.join(SCRATCH, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(LABEL).replace(/[^\w.-]/g, '_')}`);
async function runOne(task, variant) {
  const started = Date.now();
  const name = task.id.replace(/[^a-z0-9]/gi, '_');
  const dir = path.join(outRoot, variant, name);
  const result = { id: task.id, board: task.board, category: task.category, variant, ok: false, compiled: false, checks: { passed: 0, total: task.expect.length }, cost: 0, tokens: null, libraries: [], error: null };
  let code;
  if (variant === 'reference') {
    const file = path.join(root, 'bench/reference', `${task.id}.ino`);
    if (!fs.existsSync(file)) return { ...result, error: 'no reference sketch' };
    code = fs.readFileSync(file, 'utf8');
  } else {
    const instructions = variant === 'alone' ? BASE : `${BASE}\n\n${IMPULSE_RULES}\n\n${await impulseFacts(task)}`;
    const answer = await callModel(instructions, userMessage(task));
    result.tokens = { input: answer.usage.input_tokens || 0, output: answer.usage.output_tokens || 0, reasoning: answer.usage.output_tokens_details?.reasoning_tokens || 0 };
    result.cost = costOf(answer.usage);
    if (answer.error) return { ...result, error: `model: ${answer.error}`, seconds: (Date.now() - started) / 1000 };
    code = extractSketch(answer.text);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'answer.md'), answer.text);
    if (!code) return { ...result, error: 'the answer has no sketch', seconds: (Date.now() - started) / 1000 };
    if (variant === 'impulse-fix') {
      const loop = await verifyLoop(task, path.join(dir, 'verify', name), name, code, [{ role: 'user', content: userMessage(task) }, { role: 'assistant', content: answer.text }], instructions);
      code = loop.code;
      result.steps = loop.steps;
      if (loop.extra) {
        result.cost += costOf(loop.extra.usage || {});
        result.tokens.input += loop.extra.usage?.input_tokens || 0;
        result.tokens.output += loop.extra.usage?.output_tokens || 0;
      }
    }
  }
  const diagram = prepareSketch(dir, name, code, task);
  result.libraries = await installLibraries(code, BOARDS[task.board].fqbn);
  let sim = task.compileOnly ? await compileOnly(task, dir) : await withSimSlot(() => runSim(task, dir, diagram));
  // A sketch that built but failed a check gets one more run: the emulator can
  // stall on a busy computer (the app's own check does the same).
  if (sim.status === 'failed' && !task.compileOnly) {
    const again = await withSimSlot(() => runSim(task, dir, diagram));
    if (again.status === 'passed') { sim = again; result.retried = true; }
  }
  result.compiled = sim.status !== 'error';
  result.checks.passed = sim.results.filter((r) => r.pass).length;
  result.ok = sim.status === 'passed' && result.checks.passed === task.expect.length;
  if (!result.ok) {
    result.error = sim.status === 'error'
      ? `did not build or run: ${String(sim.error || '').split('\n').filter((l) => /error|undefined|not declared|No such file|fatal/i.test(l)).slice(0, 2).join(' | ').slice(0, 300) || String(sim.error || '').slice(0, 300)}`
      : sim.results.filter((r) => !r.pass).map((r) => `${r.expectation}: ${r.detail}`).join('; ').slice(0, 300);
  }
  result.seconds = Math.round((Date.now() - started) / 100) / 10;
  return result;
}

// ---- run ------------------------------------------------------------------------------
console.log(`EmbedBench: ${tasks.length} tasks × ${VARIANTS.join(', ')}${MODEL ? ` with ${MODEL} (reasoning ${EFFORT})` : ''}, ${JOBS} at a time, ${SIM_JOBS} simulations at a time`);
if (skipped.length) console.log(`Skipped: ${skipped.join(', ')}`);
const units = tasks.flatMap((t) => VARIANTS.map((v) => ({ t, v })));
const results = [];
let next = 0;
async function worker() {
  while (next < units.length) {
    const { t, v } = units[next++];
    const r = await runOne(t, v).catch((error) => ({ id: t.id, board: t.board, variant: v, ok: false, compiled: false, checks: { passed: 0, total: t.expect.length }, cost: 0, error: `bench: ${error.message}` }));
    results.push(r);
    console.log(`${r.ok ? 'pass' : 'FAIL'}  ${v.padEnd(9)} ${t.id}${r.ok ? '' : `  ${r.error || ''}`}`);
  }
}
await Promise.all(Array.from({ length: JOBS }, worker));

const summary = {};
for (const v of VARIANTS) {
  const list = results.filter((r) => r.variant === v);
  const passed = list.filter((r) => r.ok).length;
  const cost = list.reduce((s, r) => s + (r.cost || 0), 0);
  summary[v] = {
    tasks: list.length,
    passed,
    passRate: list.length ? Math.round((passed / list.length) * 1000) / 10 : 0,
    compiled: list.filter((r) => r.compiled).length,
    costUsd: Math.round(cost * 10000) / 10000,
    costPerWorkingSketchUsd: passed ? Math.round((cost / passed) * 10000) / 10000 : null,
  };
}
const report = {
  bench: 'EmbedBench v0',
  date: new Date().toISOString(),
  model: MODEL,
  reasoning: MODEL ? EFFORT : null,
  label: LABEL,
  summary,
  byBoard: Object.fromEntries(Object.keys(BOARDS).map((b) => [b, Object.fromEntries(VARIANTS.map((v) => {
    const list = results.filter((r) => r.board === b && r.variant === v);
    return [v, `${list.filter((r) => r.ok).length}/${list.length}`];
  }))])),
  results: results.sort((a, b) => a.id.localeCompare(b.id) || a.variant.localeCompare(b.variant)),
  skipped,
};
fs.mkdirSync(outRoot, { recursive: true });
fs.writeFileSync(path.join(outRoot, 'report.json'), JSON.stringify(report, null, 2));
console.log('\n| Variant | Passed | Compiled | Cost (USD) | Cost per working sketch |\n|---|---|---|---|---|');
for (const [v, s] of Object.entries(summary)) {
  console.log(`| ${v} | ${s.passed}/${s.tasks} (${s.passRate} %) | ${s.compiled}/${s.tasks} | ${s.costUsd.toFixed(4)} | ${s.costPerWorkingSketchUsd === null ? '–' : s.costPerWorkingSketchUsd.toFixed(4)} |`);
}
console.log(`\nSketches, answers and the full report: ${outRoot}`);
if (flag('write')) {
  const file = path.join(root, 'bench/reports', `${report.date.slice(0, 10)}-${String(LABEL).replace(/[^\w.-]/g, '_')}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 1)}\n`);
  fs.writeFileSync(file.replace(/\.json$/, '.md'), markdownReport(report));
  console.log(`Report: ${path.relative(root, file)} (and .md)`);
}
