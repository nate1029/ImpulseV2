// Proves the error decoder against real compilers: each rule's example is a
// sketch that fails with that error on a real core. This compiles every
// example, saves the compiler's output in test/fixtures/compile-errors/
// (home folders masked; the tests decode these files), checks that the
// decoder names that rule, and that the rule's rewrite of the example
// compiles. Results go to knowledge/proofs.json (decoder: proof L3).
//
//   npm run knowledge:errors                 # every rule whose core is installed
//   npm run knowledge:errors -- esp32-ledc   # rules whose id starts with this
//   npm run knowledge:errors -- --write      # also update proofs.json
//
// It reads the global cores but compiles with a scratch sketchbook, so
// libraries installed on this computer cannot change the outcome.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { RULES, decode, rewrite } = require(path.join(root, 'src/main/services/ai/knowledge/errorDecoder.js'));
const cli = process.env.ARDUINO_CLI || 'arduino-cli';
const args = process.argv.slice(2);
const only = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--sketchbook');
const fixtures = path.join(root, 'test/fixtures/compile-errors');
fs.mkdirSync(fixtures, { recursive: true });

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-errors-')));
// Libraries a rewrite adds (Servo.h) come from --sketchbook DIR when given
// (the app would install them); otherwise the sketchbook is empty.
const sbIndex = args.indexOf('--sketchbook');
const sketchbook = sbIndex >= 0 ? path.resolve(args[sbIndex + 1]) : path.join(work, 'sketchbook');
fs.mkdirSync(path.join(sketchbook, 'libraries'), { recursive: true });
const env = { ...process.env, ARDUINO_DIRECTORIES_USER: sketchbook };
const listed = spawnSync(cli, ['core', 'list', '--format', 'json'], { encoding: 'utf8' });
const versions = new Map((JSON.parse(listed.stdout || '{}').platforms || []).map((p) => [p.id, p.installed_version]));

function compile(name, code, fqbn) {
  const dir = path.join(work, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.ino`), code);
  const res = spawnSync(cli, ['compile', '--fqbn', fqbn, '--warnings', 'none', dir], { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  const output = `${res.stdout || ''}\n${res.stderr || ''}`;
  return { ok: res.status === 0, output, dir };
}

// What goes into the fixture: the error lines, with this computer's paths masked.
const mask = (text, dir) => text
  .split(fs.realpathSync(dir)).join('<sketch>')
  .split(dir).join('<sketch>')
  .split(work).join('<work>')
  .split(os.homedir()).join('~')
  .split('\n').filter((l) => /error|undefined reference|multiple definition|No such file|In function|note:|\^|^\s*\d+ \|/.test(l)).slice(0, 40).join('\n');

const proofsFile = path.join(root, 'src/main/services/ai/knowledge/proofs.json');
const proofs = JSON.parse(fs.readFileSync(proofsFile, 'utf8'));
proofs.decoder = proofs.decoder || {};
const today = new Date().toISOString().slice(0, 10);
let failures = 0;
let ran = 0;
for (const rule of RULES) {
  if (!rule.example) continue;
  if (only.length && !only.some((o) => rule.id.startsWith(o))) continue;
  const { fqbn, code, ctx = {} } = rule.example;
  const platform = fqbn.split(':').slice(0, 2).join(':');
  if (!versions.has(platform)) {
    console.log(`skip  ${rule.id}: ${platform} is not installed`);
    continue;
  }
  ran++;
  const name = rule.id.replace(/[^a-z0-9]/gi, '_');
  const broken = compile(name, code, fqbn);
  if (broken.ok) {
    failures++;
    console.log(`FAIL  ${rule.id}: the example compiled on ${fqbn}, so it proves nothing`);
    delete proofs.decoder[rule.id];
    continue;
  }
  const fixture = mask(broken.output, broken.dir);
  fs.writeFileSync(path.join(fixtures, `${rule.id}.txt`), `# ${fqbn} with ${platform}@${versions.get(platform)}\n${fixture}\n`);
  const found = decode(broken.output, { fqbn, ...ctx });
  const hit = found.findIndex((f) => f.id === rule.id);
  if (hit < 0) {
    failures++;
    console.log(`FAIL  ${rule.id}: the decoder read ${found.map((f) => f.id).join(', ') || 'nothing'}\n      ${fixture.split('\n').find((l) => /error/.test(l)) || ''}`);
    delete proofs.decoder[rule.id];
    continue;
  }
  let rewriteOk = null;
  if (rule.rewrite) {
    const fixed = rewrite(code, broken.output, { fqbn, ...ctx });
    rewriteOk = fixed.applied.includes(rule.id) && compile(`${name}_fixed`, fixed.code, fqbn).ok;
    if (!rewriteOk) {
      failures++;
      console.log(`FAIL  ${rule.id}: its rewrite ${fixed.applied.includes(rule.id) ? 'does not compile' : 'did not apply'}`);
    }
  }
  proofs.decoder[rule.id] = { fqbn, core: `${platform}@${versions.get(platform)}`, date: today, rewrite: rewriteOk };
  console.log(`ok    ${rule.id}${hit > 0 ? ` (decoded as #${hit + 1})` : ''}${rule.rewrite ? (rewriteOk ? ', rewrite compiles' : '') : ''}`);
}
fs.rmSync(work, { recursive: true, force: true });
if (args.includes('--write')) {
  fs.writeFileSync(proofsFile, `${JSON.stringify(proofs, null, 1)}\n`);
  console.log(`Recorded ${Object.keys(proofs.decoder).length} decoder rules in ${path.relative(root, proofsFile)}.`);
}
console.log(`${ran} examples compiled, ${failures} problems`);
process.exit(failures ? 1 : 0);
