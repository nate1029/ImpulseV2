// Compiles every recipe in the knowledge layer for a real board of each chip
// family, and records which ones built, with which core: a sketch is only
// ever called known-good when it is in that record.
//
//   npm run knowledge:recipes                      # every recipe, every board whose core is installed
//   npm run knowledge:recipes -- --only dht,servo  # some recipes (the record is merged)
//   npm run knowledge:recipes -- --boards esp32s3,uno
//   npm run knowledge:recipes -- --write           # update recipes.verified.json
//   npm run knowledge:recipes -- --changed --write # only what is not yet proven for its exact text
//
// It never changes the global Arduino setup. Cores are only read: the global
// ones, plus those of the arduino-cli config in IMPULSE_EXTRA_CORES_CONFIG (for
// the Pico). Libraries go into a scratch sketchbook (--scratch DIR, default
// a folder in the system temp dir), installed with a scratch config that has
// its own library index, and each compile sees only that sketchbook, so a
// recipe cannot pass thanks to a library that happens to be installed here.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { COMPONENTS, RECIPES, recipeFor, sketchHash } = require(path.join(root, 'src/main/services/ai/knowledge/components.js'));
const RECORD = path.join(root, 'src/main/services/ai/knowledge/recipes.verified.json');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const cli = process.env.ARDUINO_CLI || 'arduino-cli';
const scratch = path.resolve(value('scratch', path.join(os.tmpdir(), 'impulse-recipes')));
const extraConfig = value('extra-cores-config', process.env.IMPULSE_EXTRA_CORES_CONFIG || '');
const only = value('only') ? value('only').split(',') : null;
const jobsPerTime = Math.max(1, Number(value('jobs', 3)));

// One real board per family the recipes know.
const BOARDS = [
  { id: 'uno', fqbn: 'arduino:avr:uno', family: 'avr', platform: 'arduino:avr' },
  { id: 'esp32', fqbn: 'esp32:esp32:esp32', family: 'esp32', platform: 'esp32:esp32' },
  { id: 'esp32s2', fqbn: 'esp32:esp32:esp32s2', family: 'esp32s2', platform: 'esp32:esp32' },
  { id: 'esp32s3', fqbn: 'esp32:esp32:esp32s3', family: 'esp32s3', platform: 'esp32:esp32' },
  { id: 'esp32c3', fqbn: 'esp32:esp32:esp32c3', family: 'esp32c3', platform: 'esp32:esp32' },
  { id: 'esp32c6', fqbn: 'esp32:esp32:esp32c6', family: 'esp32c6', platform: 'esp32:esp32' },
  { id: 'nano-esp32', fqbn: 'arduino:esp32:nano_nora', family: 'nano-esp32', platform: 'arduino:esp32' },
  { id: 'pico', fqbn: 'rp2040:rp2040:rpipico', family: 'rp2040', platform: 'rp2040:rp2040', extra: true },
];
const wantedBoards = value('boards') ? value('boards').split(',') : null;

const run = (cmdArgs, opts = {}) => spawnSync(cli, cmdArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

/** Installed platforms and versions for a config ('' = the global one). */
function cores(config) {
  const res = run([...(config ? ['--config-file', config] : []), 'core', 'list', '--format', 'json']);
  if (res.status !== 0) return new Map();
  const parsed = JSON.parse(res.stdout || '{}');
  const list = parsed.platforms || parsed || [];
  return new Map(list.map((p) => [p.id || p.ID, p.installed_version || p.installed || p.Installed]).filter(([id]) => id));
}

// The scratch library setup: its own index and sketchbook.
fs.mkdirSync(path.join(scratch, 'sketchbook', 'libraries'), { recursive: true });
const libConfig = path.join(scratch, 'arduino-cli.yaml');
if (!fs.existsSync(libConfig)) {
  fs.writeFileSync(libConfig, [
    'directories:',
    `  data: ${path.join(scratch, 'data')}`,
    `  downloads: ${path.join(scratch, 'downloads')}`,
    `  user: ${path.join(scratch, 'sketchbook')}`,
    '',
  ].join('\n'));
}
if (!fs.existsSync(path.join(scratch, 'data', 'library_index.json'))) {
  console.log('Downloading the library index into the scratch folder…');
  const res = run(['--config-file', libConfig, 'lib', 'update-index']);
  if (res.status !== 0) {
    console.error(`arduino-cli lib update-index failed: ${res.stderr || res.error}`);
    process.exit(2);
  }
}

const globalCores = cores('');
const extraCores = extraConfig ? cores(extraConfig) : new Map();
const boards = BOARDS.filter((b) => !wantedBoards || wantedBoards.includes(b.id)).filter((b) => {
  const version = (b.extra ? extraCores : globalCores).get(b.platform);
  if (!version) {
    console.log(`skip  ${b.id}: ${b.platform} is not installed${b.extra ? ' (set IMPULSE_EXTRA_CORES_CONFIG)' : ''}`);
    return false;
  }
  b.core = `${b.platform}@${version}`;
  return true;
});

// Every (recipe, board) pair that has a recipe.
const jobs = [];
for (const c of COMPONENTS) {
  if (!RECIPES[c.id] || (only && !only.includes(c.id))) continue;
  for (const b of boards) {
    const recipe = recipeFor(c, b.family);
    // --changed: skip what the record already proves for this exact sketch text and core.
    if (recipe && flag('changed') && recipe.verified && recipe.verified.core === b.core) continue;
    if (recipe) jobs.push({ id: c.id, board: b, recipe });
  }
}

// The libraries they need, installed once.
const installedLibs = () => {
  const res = run(['--config-file', libConfig, 'lib', 'list', '--format', 'json']);
  const parsed = JSON.parse(res.stdout || '{}');
  const list = parsed.installed_libraries || parsed || [];
  return new Set(list.map((l) => (l.library?.name || l.name || '').toLowerCase()).filter(Boolean));
};
const have = installedLibs();
const libFailures = new Map();
for (const lib of [...new Set(jobs.flatMap((j) => j.recipe.libs))].sort()) {
  if (have.has(lib.toLowerCase())) continue;
  process.stdout.write(`install  ${lib}… `);
  const res = run(['--config-file', libConfig, 'lib', 'install', lib]);
  if (res.status === 0) console.log('ok');
  else {
    const why = (res.stderr || res.stdout || '').trim().split('\n').pop();
    libFailures.set(lib, why);
    console.log(`FAILED: ${why}`);
  }
}

const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-recipe-build-'));
function compile(job) {
  return new Promise((resolve) => {
    const name = `${job.id.replace(/[^a-z0-9]/gi, '_')}_${job.board.id.replace(/[^a-z0-9]/gi, '_')}`;
    const dir = path.join(buildRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.ino`), job.recipe.sketch);
    const cmd = [...(job.board.extra ? ['--config-file', extraConfig] : []), 'compile', '--fqbn', job.board.fqbn, '--warnings', 'none', dir];
    const started = Date.now();
    const child = spawn(cli, cmd, { env: { ...process.env, ARDUINO_DIRECTORIES_USER: path.join(scratch, 'sketchbook') } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10 * 60 * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const ok = code === 0;
      const error = ok ? null : out.split('\n').filter((l) => /error|undefined reference|No such file|fatal|not declared|has no member/i.test(l)).slice(0, 3).join(' | ').replace(new RegExp(buildRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '…').slice(0, 500) || out.trim().split('\n').slice(-2).join(' | ').slice(0, 300);
      resolve({ id: job.id, board: job.board.id, family: job.board.family, fqbn: job.board.fqbn, core: job.board.core, sketch: sketchHash(job.recipe.sketch), ok, seconds: Math.round((Date.now() - started) / 1000), error });
    });
  });
}

// One board's jobs run one after another (they share its build cache); a few boards at a time.
const byBoard = new Map();
for (const j of jobs) byBoard.set(j.board.id, [...(byBoard.get(j.board.id) || []), j]);
const results = [];
const queue = [...byBoard.values()];
console.log(`\n${jobs.length} compiles: ${[...byBoard.keys()].join(', ')}, ${jobsPerTime} boards at a time`);
async function worker() {
  while (queue.length) {
    const list = queue.shift();
    for (const job of list) {
      const r = await compile(job);
      results.push(r);
      if (flag('write')) writeRecord(results);
      console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.id} on ${r.board} (${r.seconds}s)${r.error ? `  ${r.error}` : ''}`);
    }
  }
}
await Promise.all(Array.from({ length: jobsPerTime }, worker));
fs.rmSync(buildRoot, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(scratch, 'last-run.json'), JSON.stringify({ at: new Date().toISOString(), results, libFailures: Object.fromEntries(libFailures) }, null, 2));
console.log(`\n${results.length - failed.length} of ${results.length} compiled; report in ${path.join(scratch, 'last-run.json')}`);

if (flag('write')) {
  writeRecord(results);
  console.log(`Updated ${path.relative(root, RECORD)}`);
}
process.exit(failed.length ? 1 : 0);

function writeRecord(list) {
  const record = fs.existsSync(RECORD) ? JSON.parse(fs.readFileSync(RECORD, 'utf8')) : { results: {} };
  record.results = record.results || {};
  for (const r of list) {
    record.results[r.id] = record.results[r.id] || {};
    if (r.ok) record.results[r.id][r.family] = { fqbn: r.fqbn, core: r.core, sketch: r.sketch };
    else delete record.results[r.id][r.family];
    if (!Object.keys(record.results[r.id]).length) delete record.results[r.id];
  }
  // Recipes that no longer exist drop out.
  for (const id of Object.keys(record.results)) if (!RECIPES[id]) delete record.results[id];
  record.updated = new Date().toISOString().slice(0, 10);
  record.note = 'Written by npm run knowledge:recipes. A recipe is called known-good for a family only when it is listed here.';
  const sorted = Object.fromEntries(Object.entries(record.results).sort(([a], [b]) => a.localeCompare(b)).map(([id, fams]) => [id, Object.fromEntries(Object.entries(fams).sort(([a], [b]) => a.localeCompare(b)))]));
  fs.writeFileSync(RECORD, `${JSON.stringify({ note: record.note, updated: record.updated, results: sorted }, null, 1)}\n`);
}
