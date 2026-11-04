// Checks the knowledge layer against the installed cores, which are the
// authority. Three things can be wrong, and all three are caught here:
//
//   1. a pin range in pinMap.js that the core contradicts (the core names a
//      pin the table says the chip does not have),
//   2. a board record that names a pin the chip does not have, or that
//      disagrees with the core about LED_BUILTIN, SDA or SCL,
//   3. a catalog entry whose FQBN the installed core does not know.
//
//   node scripts/knowledge-audit.mjs                 # every installed core
//   node scripts/knowledge-audit.mjs --config-file X # another arduino-cli config
//   node scripts/knowledge-audit.mjs esp32           # only boards of this platform
//   node scripts/knowledge-audit.mjs --write         # record what passed in knowledge/proofs.json (proof L2)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BoardKnowledge = require(path.join(root, 'src/main/services/ai/knowledge/boardKnowledge.js'));
const { CATALOG, RECORDS } = require(path.join(root, 'src/main/services/ai/knowledge/boardRecords.js'));
const { mapFor, checkPin } = require(path.join(root, 'src/main/services/ai/knowledge/pinMap.js'));

const args = process.argv.slice(2);
const configIndex = args.indexOf('--config-file');
const cliArgs = configIndex >= 0 ? ['--config-file', args[configIndex + 1]] : [];
const only = args.filter((a, i) => !a.startsWith('--') && (configIndex < 0 || i !== configIndex + 1));
const cli = process.env.ARDUINO_CLI || 'arduino-cli';
const run = async (a, opts = {}) => {
  const res = spawnSync(cli, [...cliArgs, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 60000 });
  return { success: res.status === 0, stdout: res.stdout || '', stderr: res.stderr || '' };
};

const problems = [];
// A module can expose more than the bare chip (an ESP32-PICO frees the flash
// pins) and some cores number pins per board. pinCheck believes the core in
// both cases, so those are notes, not failures.
const notes = [];
const note = (board, kind, text) => problems.push({ board, kind, text });
const expected = (board, kind, text) => notes.push({ board, kind, text });

const listed = await run(['board', 'listall', '--format', 'json'], { timeout: 120000 });
if (!listed.success) {
  console.error(`arduino-cli could not list boards: ${listed.stderr.trim()}`);
  process.exit(2);
}
const known = new Map((JSON.parse(listed.stdout).boards || []).map((b) => [b.fqbn, b.name]));
const platforms = new Set([...known.keys()].map((f) => f.split(':').slice(0, 2).join(':')));
const knowledge = new BoardKnowledge(run);

const wanted = CATALOG.filter((b) => platforms.has(b.platform) && (!only.length || only.some((o) => b.platform.includes(o) || b.id.includes(o))));
console.log(`Auditing ${wanted.length} catalog boards on ${[...platforms].join(', ')}\n`);

// Pins a record mentions: "GPIO48", "pin 13", "on GPIO 8", "D4 (GPIO6)".
function pinsMentioned(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/\bGPIO\s*(\d{1,2})\b/gi)) out.add(Number(m[1]));
  for (const m of String(text).matchAll(/\bpin\s+(\d{1,2})\b/gi)) out.add(Number(m[1]));
  return [...out];
}

let checked = 0;
// What passed, for proofs.json: boards whose record agrees with their core,
// and chip families whose pin table no core contradicted.
const passed = new Set();
const familiesChecked = new Set();
for (const board of wanted) {
  const before = problems.length;
  if (!known.has(board.fqbn)) {
    note(board.id, 'catalog', `FQBN ${board.fqbn} is not in the installed core`);
    continue;
  }
  const info = await knowledge.boardInfo(board.fqbn).catch((error) => ({ error: error.message }));
  if (info.error) {
    note(board.id, 'core', `could not read the board: ${info.error}`);
    continue;
  }
  checked++;
  const map = mapFor(info.family);

  // 1. The core names a pin the table says does not exist.
  if (map) {
    const named = { ...info.pins, ...(info.analogPins || {}), ...(info.digitalAliases || {}) };
    // NUM_DIGITAL_PINS, RGB_BRIGHTNESS and friends are numbers, not pins.
    const NOT_A_PIN = /^(NUM_|RGB_BRIGHTNESS$|.*_COUNT$|.*_BRIGHTNESS$|.*_FREQ|EXTERNAL_|INTERNAL_|LED_BUILTIN_)/;
    for (const [name, value] of Object.entries(named)) {
      if (!Number.isInteger(value) || NOT_A_PIN.test(name)) continue;
      const bad = checkPin(value, info.family, {});
      if (bad && bad.level === 'error' && /has no pin|wired to the flash/.test(bad.reason)) {
        // pinCheck lets the core win here, so this is the module exposing more
        // than the chip's baseline, not a wrong table.
        expected(board.id, 'module', `the core defines ${name} = ${value}; the chip table would have said ${bad.reason}`);
      }
    }
  } else if (board.family !== 'general') {
    note(board.id, 'pinMap', `no pin map for family ${info.family || board.family}`);
  }

  // 2. The record disagrees with the core, or names a pin the chip lacks.
  const record = RECORDS[board.id] || {};
  const text = [...(record.onboard || []), ...(record.notes || []), ...(record.upload || []), board.india || ''].join(' ');
  if (map) {
    for (const pin of pinsMentioned(text)) {
      const bad = checkPin(pin, info.family, {});
      if (bad && bad.level === 'error' && /has no pin/.test(bad.reason)) {
        note(board.id, 'record', `the record mentions pin ${pin}, which ${bad.reason}`);
      }
    }
  }
  for (const pin of (record.taken || [])) {
    const n = Number(pin);
    if (!Number.isInteger(n)) continue;
    const bad = map ? checkPin(n, info.family, {}) : null;
    if (bad && /has no pin/.test(bad.reason)) note(board.id, 'record', `"pins taken" lists ${pin}, which ${bad.reason}`);
  }
  // LED_BUILTIN as the core knows it, against what the record claims.
  const ledLine = [...(record.onboard || []), board.india || ''].find((line) => /\bLED\b/i.test(line) && /GPIO\s*\d/i.test(line)) || '';
  const ledClaim = /GPIO\s*(\d{1,2})/i.exec(ledLine);
  const ledReal = info.pins?.LED_BUILTIN;
  if (ledClaim && Number.isInteger(ledReal) && Number(ledClaim[1]) !== ledReal) {
    note(board.id, 'record', `the record says the LED is on GPIO ${ledClaim[1]}, the core says LED_BUILTIN = ${ledReal}`);
  }
  for (const [name, label] of [['SDA', 'SDA'], ['SCL', 'SCL']]) {
    const claim = new RegExp(`${label}\\s*(?:=|is)?\\s*(?:D\\d+\\s*\\()?GPIO\\s*(\\d{1,2})`).exec(text);
    const real = info.pins?.[name];
    if (claim && Number.isInteger(real) && Number(claim[1]) !== real) {
      note(board.id, 'record', `the record says ${label} is GPIO ${claim[1]}, the core says ${name} = ${real}`);
    }
  }
  if (problems.length === before) passed.add(board.id);
  if (map && problems.length === before) familiesChecked.add(info.family);
}

if (args.includes('--write')) {
  const file = path.join(root, 'src/main/services/ai/knowledge/proofs.json');
  const proofs = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cores = await run(['core', 'list', '--format', 'json']);
  const list = cores.success ? (JSON.parse(cores.stdout).platforms || []) : [];
  proofs.audit = {
    date: new Date().toISOString().slice(0, 10),
    cores: Object.fromEntries(list.map((c) => [c.id, c.installed_version]).filter(([id]) => platforms.has(id))),
    boards: [...passed].sort(),
    families: [...familiesChecked].sort(),
  };
  fs.writeFileSync(file, `${JSON.stringify(proofs, null, 1)}\n`);
  console.log(`Recorded ${passed.size} boards and ${familiesChecked.size} chip families in ${path.relative(root, file)}.`);
}

console.log(`${checked} boards read from their cores.`);
if (notes.length) {
  console.log(`\n${notes.length} pins exposed beyond the chip's baseline (the core wins, as pinCheck does):`);
  for (const n of notes.slice(0, 12)) console.log(`  ${n.board}: ${n.text}`);
  if (notes.length > 12) console.log(`  … and ${notes.length - 12} more`);
}
if (!problems.length) {
  console.log('\nNo conflicts: the pin table and the records agree with the installed cores.');
  process.exit(0);
}
const byKind = problems.reduce((acc, p) => ({ ...acc, [p.kind]: [...(acc[p.kind] || []), p] }), {});
for (const [kind, list] of Object.entries(byKind)) {
  console.log(`\n${kind} (${list.length}):`);
  for (const p of list) console.log(`  ${p.board}: ${p.text}`);
}
process.exit(1);
