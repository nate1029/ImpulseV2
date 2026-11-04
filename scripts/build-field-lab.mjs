#!/usr/bin/env node
// Builds docs/design/field-lab.html: the chat-mode character field with a
// slider for every parameter, as one self-contained page (the field module
// and the JetBrains Mono font are embedded), so the look can be tuned in a
// browser and the chosen numbers copied into FIELD_DEFAULTS.
//
//   node scripts/build-field-lab.mjs      (npm run field-lab)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleSource = fs.readFileSync(path.join(root, 'src/renderer/vibe/char-field.js'), 'utf8')
  .replace(/^export (const|class) /gm, '$1 ');
const font = fs.readFileSync(path.join(root, 'cloud/public/assets/fonts/jetbrains-mono.woff2')).toString('base64');
const inter = fs.readFileSync(path.join(root, 'cloud/public/assets/fonts/inter.woff2')).toString('base64');

// Slider schema: [param, label, min, max, step, what it does]
const SCHEMA = [
  ['Ripple: size and timing', [
    ['rippleRadius', 'Reach', 80, 1200, 10, 'how far out the front settles (px)'],
    ['rippleRise', 'Speed', 0.1, 2, 0.05, 'seconds to get most of the way there (smaller = faster)'],
    ['rippleFadeStart', 'Hold', 0, 6, 0.1, 'seconds before it starts to dissolve'],
    ['rippleFadeEnd', 'Gone', 0.3, 10, 0.1, 'seconds until it has dissolved'],
    ['rippleFlow', 'Drift', 0, 3, 0.05, 'how fast the swaths wander while it lives'],
  ]],
  ['Ripple: shape', [
    ['rippleWidth', 'Front thickness', 10, 300, 5, 'the bright front (px)'],
    ['rippleWidthGrow', 'Front widens', 0, 120, 5, 'px per second'],
    ['rippleTail', 'Tail length', 0, 600, 10, 'light trailing behind the front (px)'],
    ['rippleTailGrow', 'Tail lengthens', 0, 300, 5, 'px per second'],
    ['rippleWobble', 'Waviness', 0, 400, 10, 'how far the front wanders from a circle (px)'],
    ['rippleWobbleScale', 'Wave size', 60, 600, 10, 'the size of those waves (px)'],
  ]],
  ['Ripple: glow', [
    ['rippleFront', 'Front glow', 0, 3, 0.05, 'brightness of the front'],
    ['rippleTailGlow', 'Tail glow', 0, 3, 0.05, 'brightness of the tail'],
    ['rippleCoverage', 'Coverage', 0, 1, 0.02, '0 = a few sparse swaths, 1 = the whole ring'],
    ['rippleGrain', 'Grain', 0, 1, 0.02, '0 = even, 1 = every character its own brightness'],
    ['rippleCalm', 'Behind text', 0, 1, 0.05, 'how much of a ripple shows behind the headline and cards'],
  ]],
  ['Resting field', [
    ['baseAlpha', 'Dark characters', 0, 0.3, 0.005, 'how visible unlit characters are'],
    ['litAlpha', 'Lit characters', 0, 1, 0.01, 'how bright a fully lit character gets'],
    ['ambient', 'Drifting light', 0, 2, 0.05, 'the slow light that wanders the field (0 = none)'],
    ['ambientSpeed', 'Drift speed', 0, 4, 0.1, 'how fast it wanders'],
    ['calm', 'Behind text', 0, 1, 0.05, 'how much of the drifting light shows behind the headline and cards'],
    ['sweepEvery', 'Sweep every', 0, 60, 1, 'seconds between the signal sweeps (0 = none)'],
    ['sweepGain', 'Sweep glow', 0, 2, 0.05, 'the sweep\'s brightness'],
    ['pointerGlow', 'Pointer glow', 0, 1, 0.05, 'light that follows the pointer (0 = none)'],
    ['pointerRadius', 'Pointer size', 40, 600, 10, 'its size (px)'],
  ]],
];

const html = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Impulse field lab</title>
<style>
@font-face { font-family: 'JetBrains Mono Variable'; src: url(data:font/woff2;base64,${font}) format('woff2'); font-weight: 100 800; }
@font-face { font-family: 'Inter Variable'; src: url(data:font/woff2;base64,${inter}) format('woff2'); font-weight: 100 900; }
:root {
  --v-canvas: #0c0c0d; --v-panel: #121213; --v-raised: #18181a; --v-raised-2: #1f1f22; --v-line: #26262a; --v-line-strong: #34343a;
  --v-text: #eeeef2; --v-text-2: #b4b4b8; --v-text-3: #8a8a90; --v-white: #fff; --v-trace: #5b8fc9; --v-focus: #70b8ff;
  --v-field-base: 150, 162, 178; --v-field-lit: 64, 124, 204; --v-field-peak: 150, 198, 246;
  --v-mono: 'JetBrains Mono Variable', ui-monospace, Menlo, monospace; --v-sans: 'Inter Variable', -apple-system, system-ui, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--v-canvas); color: var(--v-text); font: 400 13px/1.45 var(--v-sans); -webkit-font-smoothing: antialiased; }
.lab { display: grid; grid-template-columns: minmax(0, 1fr) 340px; height: 100vh; }
.stage { position: relative; overflow: hidden; cursor: crosshair; }
canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.mock { position: absolute; inset: 0; display: grid; align-content: center; justify-items: center; gap: 26px; pointer-events: none; padding: 40px 24px 160px; }
.mock h1 { margin: 0; font-size: 28px; font-weight: 480; letter-spacing: -0.022em; color: var(--v-white); text-align: center; }
.mock p { margin: 10px auto 0; max-width: 470px; color: var(--v-text-2); font-size: 14px; text-align: center; }
.card { width: min(520px, 100%); border: 1px solid var(--v-line); border-radius: 8px; background: var(--v-raised); overflow: hidden; }
.card .label { padding: 12px 14px 6px; font: 500 10.5px/1 var(--v-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--v-text-3); }
.card .row { display: flex; gap: 10px; align-items: center; min-height: 40px; padding: 8px 14px; border-top: 1px solid var(--v-line); font-size: 13px; }
.card .row:first-of-type { border-top: 0; }
.composer { position: absolute; left: 50%; bottom: 28px; transform: translateX(-50%); width: min(760px, calc(100% - 48px)); height: 96px; border: 1px solid var(--v-line-strong); border-radius: 10px; background: var(--v-raised); box-shadow: 0 12px 32px rgba(0,0,0,.45); color: var(--v-text-3); padding: 14px 16px; font-size: 14.5px; pointer-events: none; }
.hint { position: absolute; top: 14px; left: 16px; font: 500 10.5px/1 var(--v-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--v-text-3); pointer-events: none; }
.panel { background: var(--v-panel); border-left: 1px solid var(--v-line); overflow-y: auto; padding: 14px 16px 24px; display: grid; gap: 14px; align-content: start; }
.panel h2 { margin: 0; font-size: 15px; font-weight: 520; letter-spacing: -0.01em; color: var(--v-white); }
.panel .sub { margin: -8px 0 0; color: var(--v-text-3); font-size: 12px; }
fieldset { margin: 0; padding: 10px 0 2px; border: 0; border-top: 1px solid var(--v-line); display: grid; gap: 9px; }
legend { padding: 0 0 6px; font: 500 10.5px/1 var(--v-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--v-text-3); }
.ctl { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; align-items: center; }
.ctl label { font-size: 12.5px; color: var(--v-text-2); }
.ctl output { font: 500 12px/1 var(--v-mono); color: var(--v-text); min-width: 44px; text-align: right; }
.ctl input[type=range] { grid-column: 1 / -1; width: 100%; accent-color: var(--v-trace); height: 18px; }
.ctl small { grid-column: 1 / -1; color: var(--v-text-3); font-size: 11px; line-height: 1.3; }
.colors { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.colors label { display: grid; gap: 4px; font-size: 11.5px; color: var(--v-text-2); }
.colors input { width: 100%; height: 30px; border: 1px solid var(--v-line-strong); border-radius: 3px; background: var(--v-raised); padding: 2px; }
.btns { display: flex; flex-wrap: wrap; gap: 6px; }
button { height: 30px; padding: 0 10px; border-radius: 3px; border: 1px solid var(--v-line-strong); background: var(--v-raised); color: var(--v-text); font: 500 12.5px var(--v-sans); cursor: pointer; }
button:hover { background: var(--v-raised-2); }
button.primary { background: #eeeef2; border-color: #eeeef2; color: #121213; }
textarea { width: 100%; height: 190px; resize: vertical; border-radius: 6px; border: 1px solid var(--v-line-strong); background: var(--v-canvas); color: var(--v-text); font: 11.5px/1.45 var(--v-mono); padding: 8px; }
.note { color: var(--v-text-3); font-size: 11.5px; }
@media (max-width: 860px) { .lab { grid-template-columns: 1fr; grid-template-rows: 60vh 1fr; } .panel { border-left: 0; border-top: 1px solid var(--v-line); } .composer, .mock .card .row { display: none; } }
</style>
</head>
<body>
<div class="lab">
  <section class="stage" id="stage">
    <canvas id="field" aria-hidden="true"></canvas>
    <div class="hint">Click anywhere for a ripple · move the pointer for its glow</div>
    <div class="mock" id="mock">
      <div>
        <h1>What should your board do?</h1>
        <p>Describe it. Impulse writes the sketch, wires the circuit, runs it in the simulator and fixes what breaks.</p>
      </div>
      <div class="card">
        <div class="label">Start with an idea</div>
        <div class="row">→ Blink the onboard LED and log it</div>
        <div class="row">→ Fade an LED with a potentiometer</div>
        <div class="row">→ Show DHT22 readings on an LCD</div>
      </div>
    </div>
    <div class="composer">Build something. What should your board do?</div>
  </section>
  <aside class="panel">
    <h2>Field lab</h2>
    <p class="sub">The chat-mode background, live. Move the sliders, click the field, then copy the settings (or screenshot this panel) and send them.</p>
    <div class="btns">
      <button type="button" id="copy" class="primary">Copy settings</button>
      <button type="button" id="reset">Reset to app</button>
      <button type="button" id="three">3 clicks</button>
      <button type="button" id="centre">Ripple at centre</button>
    </div>
    <div id="controls"></div>
    <fieldset>
      <legend>Colours</legend>
      <div class="colors">
        <label>Dark <input type="color" id="c-base" value="#96a2b2"></label>
        <label>Lit <input type="color" id="c-lit" value="#407ccc"></label>
        <label>Peak <input type="color" id="c-peak" value="#96c6f6"></label>
      </div>
    </fieldset>
    <fieldset>
      <legend>Settings</legend>
      <textarea id="json" readonly spellcheck="false"></textarea>
      <p class="note">Paste these over FIELD_DEFAULTS in src/renderer/vibe/char-field.js (colours go to --v-field-* in vibe.css).</p>
    </fieldset>
  </aside>
</div>
<script type="module">
${moduleSource}

const SCHEMA = ${JSON.stringify(SCHEMA)};
const canvas = document.getElementById('field');
const stage = document.getElementById('stage');
const field = new CharField(canvas);
const colors = { base: '#96a2b2', lit: '#407ccc', peak: '#96c6f6' };
const outputs = {};
const json = document.getElementById('json');

function render() {
  const settings = {};
  for (const key of Object.keys(FIELD_DEFAULTS)) settings[key] = Number(field.params[key].toFixed(3));
  json.value = JSON.stringify({ ...settings, colors }, null, 2);
}

const controls = document.getElementById('controls');
for (const [group, items] of SCHEMA) {
  const set = document.createElement('fieldset');
  const legend = document.createElement('legend');
  legend.textContent = group;
  set.append(legend);
  for (const [key, label, min, max, step, what] of items) {
    const ctl = document.createElement('div');
    ctl.className = 'ctl';
    const lab = document.createElement('label');
    lab.textContent = label;
    lab.htmlFor = 'in-' + key;
    const out = document.createElement('output');
    out.textContent = String(field.params[key]);
    const input = document.createElement('input');
    input.type = 'range'; input.id = 'in-' + key; input.min = min; input.max = max; input.step = step; input.value = field.params[key];
    const small = document.createElement('small');
    small.textContent = what;
    input.addEventListener('input', () => {
      field.setParams({ [key]: Number(input.value) });
      out.textContent = input.value;
      render();
    });
    outputs[key] = { input, out };
    ctl.append(lab, out, input, small);
    set.append(ctl);
  }
  controls.append(set);
}

for (const which of ['base', 'lit', 'peak']) {
  document.getElementById('c-' + which).addEventListener('input', (e) => {
    colors[which] = e.target.value;
    field.setParams({ colors: { ...colors } });
    render();
  });
}

function focusOnMock() {
  const r = canvas.getBoundingClientRect();
  const m = document.getElementById('mock').firstElementChild.getBoundingClientRect();
  const c = document.querySelector('.card').getBoundingClientRect();
  const left = Math.min(m.left, c.left), right = Math.max(m.right, c.right);
  field.setFocus({ x: (left + right) / 2 - r.left, y: (m.top + c.bottom) / 2 - r.top, rx: (right - left) / 2 + 40, ry: (c.bottom - m.top) / 2 + 36 });
}
new ResizeObserver(focusOnMock).observe(stage);

stage.addEventListener('pointermove', (e) => { const r = canvas.getBoundingClientRect(); field.setPointer(e.clientX - r.left, e.clientY - r.top); });
stage.addEventListener('pointerleave', () => field.setPointer(null));
stage.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; const r = canvas.getBoundingClientRect(); field.ripple(e.clientX - r.left, e.clientY - r.top); });

document.getElementById('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(json.value); document.getElementById('copy').textContent = 'Copied'; }
  catch { json.select(); document.execCommand('copy'); }
  setTimeout(() => { document.getElementById('copy').textContent = 'Copy settings'; }, 1200);
});
document.getElementById('reset').addEventListener('click', () => {
  field.setParams({ ...FIELD_DEFAULTS });
  for (const [key, { input, out }] of Object.entries(outputs)) { input.value = FIELD_DEFAULTS[key]; out.textContent = String(FIELD_DEFAULTS[key]); }
  render();
});
document.getElementById('three').addEventListener('click', () => {
  const r = canvas.getBoundingClientRect();
  [[0.2, 0.3], [0.7, 0.25], [0.5, 0.8]].forEach(([x, y], i) => setTimeout(() => field.ripple(x * r.width, y * r.height), i * 350));
});
document.getElementById('centre').addEventListener('click', () => { const r = canvas.getBoundingClientRect(); field.ripple(r.width / 2, r.height * 0.4); });

await field.start();
focusOnMock();
render();
setTimeout(() => { const r = canvas.getBoundingClientRect(); field.ripple(r.width / 2, r.height * 0.4); }, 500);
window.lab = { field, FIELD_DEFAULTS };
</script>
</body>
</html>
`;

const out = path.join(root, 'docs/design/field-lab.html');
fs.writeFileSync(out, html);
console.log(`Wrote ${path.relative(root, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
