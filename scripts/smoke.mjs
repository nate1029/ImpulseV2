// Smoke test: launch the built app, open chat mode's menus and side panel,
// then every IDE panel and the simulator, and fail on any uncaught exception
// or console error. Requires `npm run build:renderer`.
// Linux CI: run under xvfb (`xvfb-run -a node scripts/smoke.mjs`).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9399;
await assertPortFree(PORT);
const electron = (await import('electron')).default;
// A throwaway profile: the simulator steps add parts, which must not touch real sketches.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-smoke-'));

/** Fail fast when a debugging port is taken: the test would drive whatever app holds it. */
async function assertPortFree(port) {
  const free = await new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
  if (!free) {
    console.error(`Port ${port} is in use (another Impulse or Chrome debugging session?). Close it and run again.`);
    process.exit(2);
  }
}
const args = [root, `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`];
if (process.platform === 'linux') args.push('--no-sandbox', '--disable-gpu');
const app = spawn(electron, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1', IMPULSE_HIDE_DOCK: '1', IMPULSE_CLOUD_URL: process.env.IMPULSE_CLOUD_URL || 'off' } });
let mainOutput = '';
app.stdout.on('data', d => { mainOutput += d; });
app.stderr.on('data', d => { mainOutput += d; });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const problems = [];

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page' && !t.url.startsWith('devtools://'));
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('App did not expose a debuggable window within 30 s');
}

let exitCode = 1;
try {
  const ws = new WebSocket(await connect());
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      problems.push(`exception: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      problems.push(`console.error: ${m.params.args.map(a => a.value ?? a.description).join(' ')}`);
    }
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;

  await send('Runtime.enable');
  await send('Page.reload', { ignoreCache: true });
  // Wait for the UI rather than a fixed time: a slow CI runner can take longer than 5 s.
  const uiReady = `!!document.querySelector('.app-footer .status-item') && !!document.getElementById('aiMessages')`;
  let ready = false;
  for (const end = Date.now() + 30000; Date.now() < end && !ready;) {
    await sleep(500);
    ready = await evaluate(uiReady).catch(() => false);
  }
  await sleep(1500);
  if (!ready) problems.push('UI did not finish initialising (status bar / AI panel missing)');

  // Chat mode is the default view: its empty state, every menu, the account
  // (this build has no cloud address, so it explains local mode), the side
  // panel's three tabs, then the switch to the IDE for the rest.
  const esc = `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); !document.querySelector('.v-pop, .v-overlay')`;
  const chatSteps = [
    [`document.documentElement.dataset.shell`, 'vibe'],
    [`!document.querySelector('.v-empty').hidden && document.querySelectorAll('.v-launch-row').length >= 3 && !!document.querySelector('.v-field')`, true],
    [`document.querySelector('.v-chip[title=Mode]').click(); !!document.querySelector('.v-pop [role=menu] .v-item')`, true],
    [esc, true],
    [`document.querySelector('.v-chip[title=Mode]').click(); document.querySelectorAll('.v-pop [role=menuitemradio]').length`, 3],
    [esc, true],
    [`document.querySelector('.v-icon-btn[aria-label="More tools"]').click(); !!document.querySelector('.v-pop [role=menu]')`, true],
    [esc, true],
    [`document.querySelector('.v-board-chip').click(); !!document.querySelector('.v-pop [role=menu]')`, true],
    [esc, true],
    [`document.querySelector('.v-folder-chip').click(); !!document.querySelector('.v-pop [role=menu]')`, true],
    [esc, true],
    [`document.querySelector('.v-icon-btn[aria-label=Settings]').click(); !!document.querySelector('.v-pop [role=menu]')`, true],
    [esc, true],
    [`document.querySelectorAll('.v-side-action')[1].click(); !!document.querySelector('.v-pop input')`, true],
    [esc, true],
    [`document.querySelector('.v-me').click(); !!document.querySelector('.v-pop .v-item')`, true],
    [`document.querySelector('.v-pop .v-item').click(); !!document.querySelector('.v-dialog')`, true],
    [esc, true],
    [`document.querySelector('.v-icon-btn[aria-label=Simulator]').click(); !document.querySelector('.v-bench').hidden && !!document.querySelector('#vPane-sim #simPanel')`, true],
    [`document.getElementById('vTab-serial').click(); !document.getElementById('vPane-serial').hidden`, true],
    [`document.getElementById('vTab-code').click(); !document.getElementById('vPane-code').hidden`, true],
    [`document.querySelector('.v-bench-head .v-icon-btn[aria-label="Close the panel"]').click(); document.querySelector('.v-bench').hidden && !!document.querySelector('#simView #simPanel')`, true],
    [`window.impulse.shell.setMode('ide'); document.documentElement.dataset.shell`, 'ide'],
  ];
  for (const [step, expected] of chatSteps) {
    const got = await evaluate(step);
    if (got !== expected) problems.push(`chat mode step returned ${JSON.stringify(got)} (expected ${JSON.stringify(expected)}): ${step.slice(0, 120)}`);
    await sleep(300);
  }

  const steps = [
    ...['explorer', 'boards', 'libraries', 'debug', 'search', 'serial', 'simulate', 'explorer']
      .map(p => `document.querySelector('.activity-icon[data-panel="${p}"]')?.click()`),
    ...['console', 'serial', 'plotter', 'problems', 'tests', 'playground', 'console']
      .map(t => `document.querySelector('.output-tab[data-tab="${t}"]')?.click()`),
    `document.getElementById('aiAgentTab').click()`,
    `document.querySelector('.ai-starter')?.click()`,
    `document.getElementById('aiAgentTab').click()`,
    `document.getElementById('themeToggleBtn').click()`,
    `document.getElementById('themeToggleBtn').click()`,
    `document.getElementById('boardPortDropdown').click()`,
    `document.body.click()`,
  ];
  for (const step of steps) {
    await evaluate(step);
    await sleep(250);
  }

  // Simulator: part picker, examples gallery, inspector, board switching,
  // undo/redo and the bottom pane tabs.
  const sim = 'window.simManager';
  const simSteps = [
    [`window.impulse.showSimulator(); ${sim}.visible`, true],
    [`document.getElementById('simAddBtn').click(); !document.querySelector('.sim-picker').hidden`, true],
    [`(() => { const s = document.querySelector('.sim-picker-input'); s.value = 'oled'; s.dispatchEvent(new Event('input')); return document.querySelectorAll('.sim-picker-results .sim-tile').length > 0; })()`, true],
    [`document.querySelector('.sim-picker-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); ${sim}.canvas.parts.some(p => p.type === 'wokwi-ssd1306')`, true],
    [`document.getElementById('simAddBtn').click(); (() => { const s = document.querySelector('.sim-picker-input'); s.value = 'flux capacitor'; s.dispatchEvent(new Event('input')); return !!document.querySelector('.sim-picker-empty'); })()`, true],
    [`document.querySelector('.sim-picker-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.querySelector('.sim-picker').hidden`, true],
    [`(() => { const p = ${sim}.canvas.parts.find(q => q.type === 'wokwi-ssd1306'); ${sim}.canvas.select([p]); return !document.querySelector('.sim-inspector').hidden; })()`, true],
    [`${sim}.setBoard('mega'); ${sim}.board.id`, 'mega'],
    [`${sim}.setBoard('nano'); ${sim}.board.id`, 'nano'],
    [`${sim}.setBoard('uno'); ${sim}.board.id`, 'uno'],
    [`document.getElementById('simExamplesBtn').click(); document.querySelectorAll('.sim-gallery-card').length >= 30`, true],
    [`document.querySelectorAll('.sim-gallery-cat')[2]?.click(); document.querySelectorAll('.sim-gallery-card').length > 0`, true],
    [`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); !document.querySelector('.sim-overlay')`, true],
    ...['logic', 'checks', 'serial'].map(t => [`document.querySelector('.sim-pane-tab[data-pane="${t}"]').click(); true`, true]),
    [`document.getElementById('simUndoBtn').click(); document.getElementById('simRedoBtn').click(); true`, true],
  ];
  for (const [step, expected] of simSteps) {
    const got = await evaluate(step);
    if (got !== expected) problems.push(`simulator step returned ${JSON.stringify(got)} (expected ${JSON.stringify(expected)}): ${step.slice(0, 120)}`);
    await sleep(350);
  }
  // And back to chat mode, with the simulator returned to the IDE.
  const back = await evaluate(`window.impulse.shell.setMode('vibe'); document.documentElement.dataset.shell === 'vibe' && !document.querySelector('.v-empty').hidden && !!document.querySelector('#simView #simPanel')`);
  if (back !== true) problems.push('switching back to chat mode did not show the empty state with the simulator back in the IDE');
  ws.close();
  if (/Uncaught|TypeError|ReferenceError/.test(mainOutput)) problems.push(`main process: ${mainOutput.split('\n').find(l => /Uncaught|TypeError|ReferenceError/.test(l))}`);
  exitCode = problems.length ? 1 : 0;
} catch (err) {
  problems.push(err.message);
} finally {
  app.kill();
  if (app.exitCode === null && app.signalCode === null) await Promise.race([new Promise(r => app.once('exit', r)), sleep(5000)]);
  // Windows keeps the profile locked for a moment after the app exits.
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (err) {
    console.warn(`Could not remove ${profile}: ${err.message}`);
  }
}

if (problems.length) {
  console.error(`Smoke test failed:\n- ${problems.join('\n- ')}`);
} else {
  console.log('Smoke test passed: every panel and the simulator opened without errors.');
}
process.exit(exitCode);
