// Chat mode: Impulse's default view. One conversation to plan, build and
// debug; the board, the simulator, the serial monitor and the code are one
// click away; the full IDE is behind the Chat | IDE switch.
//
// Layout follows the owner's sketch (docs/design/chat-mode.md): chats and
// projects on the left with the account at the bottom; the board chip, the
// switch, Serial and Simulator on top; the composer at the bottom with mode,
// model, "+" and the credits ring; a side panel for the bench.

import './vibe.css';
import { CharField } from './char-field.js';
import { createChats, projectNameFrom } from './chats.js';
import { createAccount } from './account.js';
import { openLibraries } from './libraries.js';
import { simulatorFixPrompt } from '../verify.js';
import { refillWhen } from './credits-text.js';
import { createBench } from './bench.js';
import { closePopover, menu, popover } from './menu.js';
import { ICON } from './icons.js';
import { avatar, fill, fmtCredits, h, icon, led, timeAgo, toast } from './dom.js';
import { stepLabel } from '../morph-orb/morph-orb.js';
import { verdictText } from '../verify.js';

const SHELL_KEY = 'impulse-shell';
const SIDE_KEY = 'impulse-vibe-side';

const MODES = {
  agent: { label: 'Agent', sub: 'Writes the code, wires the circuit, runs it', icon: ICON.agent, placeholder: 'Build something. What should your board do?' },
  plan: { label: 'Plan', sub: 'Parts, wiring and steps first. Changes nothing', icon: ICON.plan, placeholder: 'Plan a build. What are you making?' },
  debug: { label: 'Debug', sub: 'Finds out why it doesn\'t work and fixes it', icon: ICON.debug, placeholder: 'What\'s going wrong?' },
};

const STARTERS = [
  { text: 'Blink the onboard LED every 500 ms and print each toggle to Serial', label: 'Blink the onboard LED and log it' },
  { text: 'Fade an LED on pin 9 with a potentiometer on A0', label: 'Fade an LED with a potentiometer' },
  { text: 'Show the temperature and humidity from a DHT22 on a 16x2 I2C LCD', label: 'Show DHT22 readings on an LCD' },
];

const api = window.electronAPI;
const impulse = window.impulse;

/* ═════════════════════════════ build the view ═══════════════════════════ */

const root = h('div', { class: 'vibe-root', id: 'vibeRoot' });

// Sidebar
const chatList = h('nav', { class: 'v-chats', 'aria-label': 'Chats' });
const meButton = h('button', { type: 'button', class: 'v-me', 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
const settingsButton = h('button', { type: 'button', class: 'v-icon-btn', 'aria-label': 'Settings', title: 'Settings', html: ICON.settings, 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
const side = h('aside', { class: 'v-side', 'aria-label': 'Chats and projects' },
  h('div', { class: 'v-side-head' },
    h('span', { class: 'v-brand' }, icon(ICON.pulse), h('span', { class: 'v-label', text: 'Impulse' })),
    h('button', { type: 'button', class: 'v-icon-btn', 'aria-label': 'Hide the sidebar', title: 'Hide the sidebar', html: ICON.sidebar, onclick: () => setSide(false) })),
  h('div', { class: 'v-side-actions' },
    h('button', { type: 'button', class: 'v-side-action primary', onclick: () => newChat() }, icon(ICON.plus), 'New chat', h('span', { class: 'v-kbd', text: '⌘N' })),
    h('button', { type: 'button', class: 'v-side-action', onclick: (e) => openSearch(e.currentTarget) }, icon(ICON.search), 'Search', h('span', { class: 'v-kbd', text: '⌘K' }))),
  chatList,
  h('div', { class: 'v-side-foot' }, meButton, settingsButton));

// Top bar
const boardChip = h('button', { type: 'button', class: 'v-board-chip', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Board and port' });
const sideToggle = h('button', { type: 'button', class: 'v-icon-btn', 'aria-label': 'Show the sidebar', title: 'Show the sidebar', html: ICON.sidebar, hidden: true, onclick: () => setSide(true) });
// Upload sits next to the board it uploads to; Verify beside it.
const uploadButton = h('button', { type: 'button', class: 'v-board-action upload', 'aria-label': 'Upload to the board', title: 'Upload to the board (⌘U)' }, icon(ICON.upload), h('span', { text: 'Upload' }));
const verifyButton = h('button', { type: 'button', class: 'v-board-action', 'aria-label': 'Verify (compile)', title: 'Verify: compile without uploading (⌘R)' }, icon(ICON.verify));
const switchChat = h('button', { type: 'button', 'aria-pressed': 'true', text: 'Chat' });
const switchIde = h('button', { type: 'button', 'aria-pressed': 'false', text: 'IDE', title: 'The full IDE: files, editor, tools (⌘E)' });
const serialButton = h('button', { type: 'button', class: 'v-icon-btn', 'aria-label': 'Serial monitor', title: 'Serial monitor', 'aria-pressed': 'false', html: ICON.terminal });
const simButton = h('button', { type: 'button', class: 'v-icon-btn', 'aria-label': 'Simulator', title: 'Simulator', 'aria-pressed': 'false', html: ICON.sim });
const serialDot = led('green');
serialDot.hidden = true;
serialButton.append(serialDot);
const updateChip = h('button', { type: 'button', class: 'v-update', hidden: true });
const top = h('header', { class: 'v-top' },
  sideToggle,
  boardChip,
  uploadButton,
  verifyButton,
  h('div', { class: 'v-top-right' },
    updateChip,
    h('div', { class: 'v-switch', role: 'group', 'aria-label': 'View' }, switchChat, switchIde),
    serialButton, simButton));

// Stage: field, empty state, conversation
const field = h('canvas', { class: 'v-field', 'aria-hidden': 'true' });
const emptyState = h('div', { class: 'v-empty v-column' });
const thread = h('div', { class: 'v-thread v-column', role: 'log', 'aria-label': 'Conversation', 'aria-live': 'polite' });
const scroller = h('div', { class: 'v-scroll' }, emptyState, thread);

// Dock: folder, composer, credits
const folderChip = h('button', { type: 'button', class: 'v-folder-chip', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Where the code goes' });
const announce = h('span', { class: 'v-announce', hidden: true }, led('amber'), h('span'));
const input = h('textarea', { class: 'v-input', rows: '1', spellcheck: 'false', 'aria-label': 'Message Impulse' });
const modeChip = h('button', { type: 'button', class: 'v-chip', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'Mode' });
const plusButton = h('button', { type: 'button', class: 'v-icon-btn', 'aria-label': 'More tools', title: 'Libraries, examples, upload…', 'aria-haspopup': 'menu', 'aria-expanded': 'false', html: ICON.plus });
const sendButton = h('button', { type: 'submit', class: 'v-send', 'aria-label': 'Send', title: 'Send (Enter)', html: ICON.send, disabled: true });
const composer = h('form', { class: 'v-composer', novalidate: true },
  input,
  h('div', { class: 'v-composer-row' }, modeChip, plusButton, h('span', { class: 'v-spacer' }), sendButton));
const hint = h('span', { class: 'v-hint', text: 'Enter to send · Shift+Enter for a new line' });
const creditsButton = h('button', { type: 'button', class: 'v-credits', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' });
// The gateway refuses AI below 1 credit (MIN_TO_START). Keep the UI's "out of
// credits" state in step, so a balance the server will reject never looks usable.
const MIN_CREDITS = 1;
const dock = h('div', { class: 'v-dock' },
  h('div', { class: 'v-column' },
    h('div', { class: 'v-dock-row' }, folderChip, announce),
    composer,
    h('div', { class: 'v-dock-foot' }, hint, creditsButton)));

const stage = h('section', { class: 'v-stage' }, field, scroller, dock);
const main = h('main', { class: 'v-main', id: 'vibeMain' }, top, stage);
root.append(side, main);

/* ═════════════════════════════ state ══════════════════════════════════ */

const chats = createChats(api);
const account = createAccount({
  api,
  onSignedIn: () => {
    const queued = pending;
    pending = null;
    if (queued) send(queued.text, { mode: queued.mode });
  },
});
let bench = null;
let charField = null;
let busy = false;
let mode = 'agent';
let pending = null;
let shellReady = false;

/* ═════════════════════════════ shell: Chat | IDE ════════════════════════ */

function shellMode() {
  return document.documentElement.dataset.shell === 'ide' ? 'ide' : 'vibe';
}

function setMode(next, { save = true } = {}) {
  const target = next === 'ide' ? 'ide' : 'vibe';
  if (shellReady && target === shellMode()) return;
  shellReady = true;
  closePopover();
  if (target === 'ide') {
    bench?.release();
    charField?.pause();
    impulse.ideChat?.render(chats.current.messages);
  } else {
    bench?.reclaim();
    if (!chats.current.messages.length) charField?.resume();
    renderThread();
  }
  document.documentElement.dataset.shell = target;
  switchChat.setAttribute('aria-pressed', String(target === 'vibe'));
  switchIde.setAttribute('aria-pressed', String(target === 'ide'));
  window.dispatchEvent(new CustomEvent('impulse:shell-changed', { detail: { mode: target } }));
  api.ui?.setShellMode?.(target);
  if (save) {
    try { localStorage.setItem(SHELL_KEY, target); } catch { /* no storage */ }
  }
  if (target === 'ide') setTimeout(() => window.state?.editor?.refresh?.(), 30);
  else requestAnimationFrame(() => input.focus({ preventScroll: true }));
}

let sideAutoHidden = false;

/**
 * Show or hide the sidebar. `auto` changes are the layout's own (the side
 * panel opening on a narrow window) and aren't remembered as a preference.
 */
function setSide(open, { auto = false } = {}) {
  root.dataset.side = open ? 'open' : 'closed';
  sideToggle.hidden = open;
  if (auto) return;
  sideAutoHidden = false;
  try { localStorage.setItem(SIDE_KEY, open ? 'open' : 'closed'); } catch { /* no storage */ }
}

/** Below this width the chat, its sidebar and the side panel don't fit side by side. */
const NARROW_PX = 1180;

function onBenchChange(tab) {
  serialButton.setAttribute('aria-pressed', String(tab === 'serial'));
  simButton.setAttribute('aria-pressed', String(tab === 'sim'));
  if (tab && window.innerWidth < NARROW_PX && root.dataset.side === 'open') {
    setSide(false, { auto: true });
    sideAutoHidden = true;
  } else if (!tab && sideAutoHidden) {
    setSide(true, { auto: true });
    sideAutoHidden = false;
  }
}

/* ═════════════════════════════ empty state ══════════════════════════════ */

function renderEmpty() {
  const recent = chats.list.filter((c) => c.id !== chats.current.id).slice(0, 3);
  const rows = [];
  if (recent.length) {
    rows.push(h('div', { class: 'v-launch-label v-label', text: 'Pick up where you left off' }));
    for (const c of recent) {
      const state = c.status === 'error' ? ['red', 'Hit an error'] : c.status === 'stopped' ? ['amber', 'Stopped'] : c.status === 'working' ? ['amber', 'Was working'] : ['green', c.project ? 'Built' : 'Answered'];
      rows.push(h('button', { type: 'button', class: 'v-launch-row', onclick: () => openChat(c.id) },
        led(state[0]),
        h('span', { class: 'v-status-word', dataset: { state: state[0] }, text: state[1] }),
        h('span', { class: 'v-row-text', text: c.title }),
        h('span', { class: 'v-row-meta', text: timeAgo(c.updatedAt) })));
    }
  }
  rows.push(h('div', { class: `v-launch-label v-label${recent.length ? ' v-launch-split' : ''}`, text: recent.length ? 'Or start something new' : 'Start with an idea' }));
  for (const s of STARTERS) {
    rows.push(h('button', { type: 'button', class: 'v-launch-row', onclick: () => useStarter(s.text) },
      icon(ICON.arrowRight), h('span', { class: 'v-row-text', text: s.label })));
  }
  fill(emptyState, 
    h('div', { class: 'v-empty-head' },
      h('h1', { text: 'What should your board do?' }),
      h('p', { text: 'Describe it. Impulse writes the sketch, wires the circuit, runs it in the simulator and fixes what breaks.' })),
    h('div', { class: 'v-launch' }, rows));
  requestAnimationFrame(updateFieldFocus);
}

function useStarter(text) {
  input.value = text;
  autosize();
  input.focus();
  input.setSelectionRange(text.length, text.length);
}

/** The character field stays calm behind the headline and cards. */
function updateFieldFocus() {
  if (!charField) return;
  const canvas = field.getBoundingClientRect();
  const head = emptyState.querySelector('.v-empty-head');
  const card = emptyState.querySelector('.v-launch');
  if (!head || !card || emptyState.hidden) return;
  const a = head.getBoundingClientRect();
  const b = card.getBoundingClientRect();
  const left = Math.min(a.left, b.left);
  const right = Math.max(a.right, b.right);
  const topY = a.top;
  const bottom = b.bottom;
  charField.setFocus({
    x: (left + right) / 2 - canvas.left,
    y: (topY + bottom) / 2 - canvas.top,
    rx: (right - left) / 2 + 40,
    ry: (bottom - topY) / 2 + 36,
  });
}

/** The field greets an empty chat with one ripple from behind the headline. */
function greet() {
  setTimeout(() => {
    if (!charField || emptyState.hidden) return;
    const canvas = field.getBoundingClientRect();
    const head = emptyState.querySelector('.v-empty-head')?.getBoundingClientRect();
    charField.ripple(canvas.width / 2, head ? head.top + head.height / 2 - canvas.top : canvas.height * 0.4);
  }, 450);
}

function setEmpty(isEmpty) {
  emptyState.hidden = !isEmpty;
  thread.hidden = isEmpty;
  if (!charField) return;
  if (isEmpty) {
    field.removeAttribute('data-leaving');
    charField.restart();
    requestAnimationFrame(() => field.setAttribute('data-on', ''));
    greet();
  } else if (field.hasAttribute('data-on')) {
    // The field only greets an empty chat: fade it out and stop it.
    field.setAttribute('data-leaving', '');
    field.removeAttribute('data-on');
    setTimeout(() => { if (!emptyState.hidden) return; charField.stop(); }, 360);
  }
}

/* ═════════════════════════════ conversation ═════════════════════════════ */

function readout(parts) {
  const row = h('div', { class: 'v-readout' });
  parts.filter(Boolean).forEach((p, i) => {
    if (i) row.append(h('span', { class: 'v-sep', 'aria-hidden': 'true' }));
    row.append(typeof p === 'string' ? h('span', { class: 'v-label', text: p }) : p);
  });
  return row;
}

const seconds = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);

function stepsBlock(steps, { open = false } = {}) {
  if (!steps?.length) return null;
  const list = h('ul', { class: 'v-steps', hidden: !open }, steps.map((s) => h('li', { class: 'v-step', dataset: { state: 'done' } }, led('green'), h('span', { text: s.label }), h('span', { class: 'v-step-time', text: s.ms ? seconds(s.ms) : '' }))));
  const toggle = h('button', { type: 'button', class: 'v-steps-toggle', 'aria-expanded': String(open) }, icon(ICON.chevronRight), `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`);
  toggle.addEventListener('click', () => {
    const show = list.hidden;
    list.hidden = !show;
    toggle.setAttribute('aria-expanded', String(show));
  });
  return h('div', { style: 'display:grid;gap:8px' }, toggle, list);
}

function userMessage(m) {
  const copy = h('button', { type: 'button', class: 'v-icon-btn', 'aria-label': 'Copy', title: 'Copy', html: ICON.copy });
  copy.addEventListener('click', () => api.clipboard.writeText(m.text).then(() => toast('Copied')));
  const tools = h('div', { class: 'v-msg-tools' }, copy);
  if (m.snapshot) {
    tools.prepend(h('button', {
      type: 'button', class: 'v-icon-btn', 'aria-label': 'Undo the code changes from here', title: 'Put the code back as it was before this message', html: ICON.retry,
      onclick: () => {
        if (impulse.ai.revert(m.snapshot)) toast('Code put back as it was before this message');
      },
    }));
  }
  return h('div', { class: 'v-msg-user', dataset: { id: m.id } }, h('div', { class: 'v-bubble', text: m.text }), tools);
}

function errorActions(m) {
  const actions = [];
  if (m.code === 'signed_out') actions.push(h('button', { type: 'button', class: 'v-btn primary', text: 'Sign in', onclick: () => account.openSignIn() }));
  if (m.code === 'insufficient_credits') actions.push(h('button', { type: 'button', class: 'v-btn primary', text: 'See plans', onclick: () => account.openPlans() }));
  if (m.code === 'forbidden' && /plan/i.test(m.text)) actions.push(h('button', { type: 'button', class: 'v-btn', text: 'See plans', onclick: () => account.openPlans() }));
  if (!m.stopped && m.prompt) actions.push(h('button', { type: 'button', class: 'v-btn', onclick: () => send(m.prompt, { mode: m.mode }) }, icon(ICON.retry), 'Try again'));
  return actions.length ? h('div', { class: 'v-answer-actions' }, actions) : null;
}

function assistantMessage(m) {
  const state = m.ok ? 'green' : m.stopped ? 'amber' : 'red';
  const parts = [led(state), m.model || null, m.ms ? seconds(m.ms) : null, m.credits > 0 ? `${fmtCredits(m.credits)} credits` : null];
  const head = readout(parts);
  if (m.ok && m.text) {
    const copy = h('button', { type: 'button', class: 'v-icon-btn', 'aria-label': 'Copy the answer', title: 'Copy', html: ICON.copy });
    copy.addEventListener('click', () => api.clipboard.writeText(m.text).then(() => toast('Copied')));
    head.append(copy);
  }
  const body = h('div', { class: 'v-prose', html: impulse.ai.format(m.text || '') });
  if (m.applied) impulse.ai.markApplied(body, m.applied);
  const parts2 = [head, body];
  if (m.ok && m.mode === 'plan') {
    parts2.push(h('div', { class: 'v-answer-actions' },
      h('button', { type: 'button', class: 'v-btn primary', onclick: () => send('Build the plan above.', { mode: 'agent' }) }, icon(ICON.agent), 'Build this'),
      h('button', { type: 'button', class: 'v-btn', text: 'Change something', onclick: () => input.focus() })));
  }
  if (!m.ok) parts2.push(errorActions(m));
  parts2.push(stepsBlock(m.steps));
  return h('div', { class: 'v-msg-ai', dataset: { id: m.id } }, ...parts2.filter(Boolean));
}

function verifyCard(m) {
  const r = m.result;
  const failures = r.stage === 'done' ? (r.results || []).filter((x) => !x.pass).map((x) => `${x.raw}: ${x.detail}`) : [r.error];
  const card = h('div', { class: 'v-card' },
    h('div', { class: 'v-card-head' }, led(r.ok ? 'green' : 'red'), r.ok ? 'Works in the simulator' : 'The simulator found a problem'),
    h('p', { text: verdictText(r) }));
  if (!r.ok && failures.length) {
    card.append(h('ul', { class: 'v-steps' }, failures.slice(0, 4).map((f) => h('li', { class: 'v-step' }, led('red'), h('span', { text: String(f).split('\n')[0].slice(0, 180) })))));
    card.append(h('div', { class: 'v-answer-actions' },
      h('button', { type: 'button', class: 'v-btn primary', onclick: () => send(`The simulator check failed:\n${failures.join('\n')}\nFix the sketch so it compiles and these checks pass.`, { mode: 'agent' }) }, 'Fix it'),
      h('button', { type: 'button', class: 'v-btn', onclick: () => bench.open('sim') }, icon(ICON.sim), 'Open the simulator')));
  } else if (r.ok) {
    card.append(h('div', { class: 'v-answer-actions' },
      h('button', { type: 'button', class: 'v-btn', onclick: () => { bench.open('sim'); impulse.sim.run(); } }, icon(ICON.sim), 'Watch it run'),
      impulse.board.current().portPresent ? h('button', { type: 'button', class: 'v-btn', onclick: () => boardAction('upload') }, icon(ICON.upload), 'Upload to the board') : null));
  }
  return h('div', { class: 'v-msg-ai', dataset: { id: m.id } }, card);
}

function noticeCard(m) {
  const card = h('div', { class: 'v-card' }, h('div', { class: 'v-card-head' }, led(m.state || 'amber'), m.title));
  if (m.text) card.append(m.kind === 'board' ? h('pre', { class: 'v-card-log', text: m.text }) : h('p', { text: m.text }));
  if (m.prompt) {
    card.append(h('div', { class: 'v-answer-actions' },
      h('button', { type: 'button', class: 'v-btn primary', onclick: () => send(m.prompt, { mode: 'debug' }) }, icon(ICON.debug), 'Fix it'),
      h('button', { type: 'button', class: 'v-btn', text: 'Open the simulator', onclick: () => bench.open('sim') })));
  }
  return h('div', { class: 'v-msg-ai', dataset: { id: m.id } }, card);
}

function renderMessage(m) {
  if (m.role === 'user') return userMessage(m);
  if (m.role === 'assistant') return assistantMessage(m);
  if (m.role === 'card' && m.kind === 'build') return buildRecordCard(m);
  if (m.role === 'card' && m.kind === 'verify' && m.result) return verifyCard(m);
  if (m.role === 'card') return noticeCard(m);
  return null;
}

function renderThread() {
  const messages = chats.current.messages;
  fill(thread, ...messages.map(renderMessage).filter(Boolean));
  setEmpty(messages.length === 0);
  if (!messages.length) renderEmpty();
  requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
}

function append(node) {
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  thread.append(node);
  if (nearBottom) requestAnimationFrame(() => node.scrollIntoView({ block: 'end', behavior: 'smooth' }));
}

/** The answer while the agent works: live steps, a timer and the signal line. */
function liveMessage() {
  const started = performance.now();
  const steps = [];
  const label = h('span', { class: 'v-label', text: 'Thinking' });
  const timer = h('span', { class: 'v-label', text: '0.0s' });
  const list = h('ul', { class: 'v-steps' });
  const el = h('div', { class: 'v-msg-ai', 'aria-busy': 'true' },
    readout([led('amber', { pulse: true }), label, timer]),
    list,
    h('div', { class: 'v-signal', 'aria-hidden': 'true' }));
  const tick = setInterval(() => { timer.textContent = seconds(performance.now() - started); }, 100);
  let last = null;
  return {
    el,
    steps,
    step(step) {
      const [text] = stepLabel(step);
      const now = performance.now();
      if (last && last.label === text) return;
      if (last) {
        last.ms = now - last.at;
        last.li.dataset.state = 'done';
        last.li.querySelector('.v-led').dataset.state = 'green';
        last.li.querySelector('.v-led').removeAttribute('data-pulse');
        last.li.querySelector('.v-step-time').textContent = seconds(last.ms);
      }
      const li = h('li', { class: 'v-step', dataset: { state: 'live' } }, led('amber', { pulse: true }), h('span', { text: text }), h('span', { class: 'v-step-time' }));
      list.append(li);
      last = { label: text, at: now, li, ms: 0 };
      steps.push(last);
      label.textContent = text;
    },
    finish() {
      clearInterval(tick);
      if (last) last.ms = performance.now() - last.at;
      return { ms: performance.now() - started, steps: steps.map((s) => ({ label: s.label, ms: Math.round(s.ms) })) };
    },
  };
}

/* ═════════════════════════════ sending ══════════════════════════════════ */

function setBusy(on) {
  busy = on;
  sendButton.toggleAttribute('data-busy', on);
  sendButton.innerHTML = on ? ICON.stop : ICON.send;
  sendButton.setAttribute('aria-label', on ? 'Stop' : 'Send');
  sendButton.title = on ? 'Stop (Esc)' : 'Send (Enter)';
  sendButton.disabled = !on && !input.value.trim();
}

function shake() {
  composer.removeAttribute('data-shake');
  requestAnimationFrame(() => composer.setAttribute('data-shake', ''));
}


async function send(textArg, { mode: modeArg, autoFix = 0 } = {}) {
  const text = String(textArg ?? input.value).trim();
  if (busy) return;
  if (!text) {
    shake();
    return;
  }
  if (impulse.ai.busy()) {
    toast('The IDE\'s chat is still answering. Wait for it, or stop it there.');
    return;
  }
  const useMode = modeArg || mode;
  if (useMode !== mode) setChatMode(useMode);

  const ready = await impulse.ai.ensureModel();
  if (!ready.ok) {
    if (ready.needsSignIn) {
      pending = { text, mode: useMode };
      account.openSignIn({ pendingPrompt: text });
      return;
    }
    toast(ready.error || 'Impulse AI isn\'t available right now.');
    return;
  }
  const credits = account.status.credits;
  if (credits && credits.remaining < MIN_CREDITS) {
    append(noticeCard({
      id: 'out', state: 'red', title: 'You\'re out of credits',
      text: `Your ${credits.planName} credits refill ${refillWhen(credits.periodEnd, credits.periodHours)}. Upgrade to keep building now.`,
    }));
    account.openPlans();
    return;
  }

  if (textArg === undefined || textArg === input.value) {
    input.value = '';
    autosize();
  }
  setBusy(true);
  chats.begin(text);

  // Builds need a sketch to write into: a new chat gets its own project.
  if ((useMode === 'agent' || useMode === 'debug') && !impulse.project.current()) {
    const project = await impulse.project.create(projectNameFrom(text));
    if (project) {
      chats.set({ project });
      renderFolder();
      await loadProjectFiles();
      renderChats();
    } else {
      toast('Couldn\'t create a project folder. The answer will show the code instead.');
    }
  }

  const userRecord = chats.add({ role: 'user', text, snapshot: impulse.ai.snapshot(text) });
  setEmpty(false);
  append(userMessage(userRecord));
  chats.set({ status: 'working', mode: useMode });
  renderChats();

  const live = liveMessage();
  append(live.el);
  const offStep = api.ai.onStep?.((step) => live.step(step));
  // Every model runs on the account's credits: show what this turn cost.
  const before = account.status.credits?.remaining ?? null;
  let result;
  try {
    result = await api.ai.processQuery(text, impulse.ai.context(), useMode);
  } catch (error) {
    result = { success: false, error: error?.message || 'Something went wrong.' };
  }
  offStep?.();
  const { ms, steps } = live.finish();
  await account.refresh();
  const after = account.status.credits?.remaining ?? null;

  const ok = !!result?.success;
  const record = chats.add({
    role: 'assistant',
    ok,
    stopped: !!result?.stopped,
    code: result?.code || null,
    text: ok ? (result.data?.response || result.data?.content || 'Done.') : result?.stopped ? 'Stopped. Nothing after this point was done.' : (result?.error || 'Something went wrong.'),
    prompt: ok ? null : text,
    mode: useMode,
    model: 'Impulse AI',
    ms: Math.round(ms),
    credits: before !== null && after !== null && before !== undefined && after !== undefined ? Math.max(0, Math.round((before - after) * 10) / 10) : 0,
    steps,
  });
  const answerEl = assistantMessage(record);
  live.el.replaceWith(answerEl);
  chats.set({ status: ok ? 'ok' : result?.stopped ? 'stopped' : 'error' });
  setBusy(false);
  renderChats();
  syncIde();
  if (ok) impulse.ai.recordUsage(result.data);

  // The answer carries the whole sketch instead of editing the file: write it in for the user.
  let edited = ok && impulse.ai.editedCode(result.data);
  if (ok && !edited && (useMode === 'agent' || useMode === 'debug')) {
    const applied = await impulse.ai.applyAnswerCode(record.text);
    if (applied) {
      edited = true;
      chats.update(record.id, { applied: applied.code });
      impulse.ai.markApplied(answerEl, applied.code);
      toast(`Code written to ${applied.file}`);
    }
  }

  // Code changed: run it in the simulator before anyone trusts it.
  if (edited) {
    bench.refreshCode();
    const checking = noticeCard({ id: 'checking', state: 'amber', title: 'Checking it in the simulator…' });
    checking.querySelector('.v-led').setAttribute('data-pulse', '');
    append(checking);
    const check = await impulse.ai.verify();
    checking.remove();
    if (check) {
      const card = chats.add({ role: 'card', kind: 'verify', result: check });
      append(verifyCard(card));
      syncIde();
    }
    await loadProjectFiles();
    renderChats();
    chats.save();
    // A failed check goes straight back to the agent once, with what the run
    // actually showed. Waiting for a click and sending only the failing lines
    // is what made this go round in circles.
    if (check && !check.ok && autoFix < 1) {
      const circuit = await impulse.sim.facts?.();
      await send(simulatorFixPrompt(check, { wiring: circuit?.lines?.join('\n') || '', hasCircuit: !!circuit?.hasCircuit }), { mode: 'agent', autoFix: autoFix + 1 });
    }
    return;
  }
  chats.save();
}

/** The IDE's chat panel shows this conversation too (when it's the view on screen). */
function syncIde() {
  if (shellMode() === 'ide') impulse.ideChat.render(chats.current.messages);
}

function stop() {
  if (!busy) return;
  api.ai.cancel?.().catch(() => {});
}

/* ═════════════════════════════ composer ═════════════════════════════════ */

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
  if (!busy) sendButton.disabled = !input.value.trim();
}

function setChatMode(next) {
  mode = MODES[next] ? next : 'agent';
  impulse.ai.setMode(mode);
  fill(modeChip, icon(MODES[mode].icon), MODES[mode].label, icon(ICON.caret));
  input.placeholder = MODES[mode].placeholder;
}

function openModeMenu(anchor) {
  menu(anchor, Object.entries(MODES).map(([id, m]) => ({
    label: m.label, sub: m.sub, icon: m.icon, checked: mode === id, onSelect: () => setChatMode(id),
  })), { label: 'Mode', side: 'top' });
}

function openPlusMenu(anchor) {
  const board = impulse.board.current();
  menu(anchor, [
    { heading: 'Add to your project' },
    { label: 'Libraries', sub: 'What this sketch needs, and anything else to add', icon: ICON.library, onSelect: () => openLibraries({ impulse }) },
    { label: 'Files', sub: 'Open, add, rename or delete the project\'s files', icon: ICON.folder, onSelect: () => bench.open('files') },
    { label: 'Examples', sub: 'Open a ready-made sketch and circuit', icon: ICON.examples, onSelect: () => openExamples() },
    { label: 'Open a folder…', sub: 'Work on a sketch you already have', icon: ICON.folderPlus, onSelect: () => openExistingFolder() },
    { separator: true },
    { heading: 'Board' },
    { label: 'Verify (compile)', meta: '⌘R', icon: ICON.verify, disabled: !impulse.project.current(), onSelect: () => boardAction('verify') },
    { label: 'Upload to the board', meta: '⌘U', sub: board.portPresent ? `${board.name || 'Board'} on ${board.port}` : 'Connect a board first', icon: ICON.upload, disabled: !board.portPresent || !impulse.project.current(), onSelect: () => boardAction('upload') },
    { label: 'Choose a board', sub: 'Impulse installs what a board needs when you pick it', icon: ICON.chip, onSelect: () => openBoardMenu(boardChip) },
    { label: 'Serial monitor', icon: ICON.terminal, onSelect: () => bench.open('serial') },
    { label: 'Serial plotter', sub: 'Opens the IDE view', icon: ICON.plotter, onSelect: () => impulse.tools.open('plotter') },
  ], { label: 'More tools', side: 'top' });
}

/** The simulator's gallery of ready-made sketches and circuits, in the side panel. */
function openExamples() {
  bench.open('sim');
  requestAnimationFrame(() => impulse.sim.examples());
}

/* ═════════════════════════════ builds ═══════════════════════════════════ */
// A compile or upload as it runs (main/services/buildJobs.js streams it): a
// card with the stage, the upload percentage and the last lines; at the end,
// Arduino IDE's memory summary, or what went wrong and what to do.

let liveBuild = null;
const BUILD_LOG_LINES = 400;
// arduino-cli colours its output; the codes are noise in the card's log.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const stripAnsi = (text) => text.replace(ANSI, '');

function boardLabel(fqbn) {
  if (fqbn === 'platformio:project') return 'the PlatformIO environment';
  const named = impulse.board.nameOf?.(fqbn);
  if (named) return named;
  const b = impulse.board.current();
  const base = fqbn ? fqbn.split(':').slice(0, 3).join(':') : '';
  if (b?.name && (!base || !b.fqbn || b.fqbn.startsWith(base))) return b.name;
  return base ? base.split(':').pop() : 'the board';
}

/** A port as the board chip names it: usbmodem1101 for /dev/cu.usbmodem1101, COM3 as it is. */
const shortPort = (port) => String(port || '').replace(/^\/dev\/(?:cu|tty)\./, '');

/** "Traffic light" for the project folder traffic-light; null without a project. */
function projectTitle() {
  const name = impulse.project.current()?.name;
  return name ? name.replace(/[-_]+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase()) : null;
}

function liveBuildCard(info) {
  const started = performance.now();
  const timer = h('span', { class: 'v-step-time', text: '0.0s' });
  const stage = h('span', { class: 'v-label', text: info.kind === 'upload' ? 'Compiling' : 'Starting' });
  const bar = h('span');
  const meter = h('div', { class: 'v-meter v-build-meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', hidden: true }, bar);
  const log = h('pre', { class: 'v-card-log v-build-log', hidden: true });
  const all = [];
  let stageText = stage.textContent;
  const el = h('div', { class: 'v-msg-ai', 'aria-busy': 'true', dataset: { build: info.id } },
    h('div', { class: 'v-card v-build' },
      h('div', { class: 'v-card-head' }, led('amber', { pulse: true }), h('span', { text: info.title }), timer),
      h('div', { class: 'v-build-stage' }, stage, meter),
      log));
  const tick = setInterval(() => { timer.textContent = seconds(performance.now() - started); }, 100);
  return {
    ...info,
    el,
    lines(lines) {
      all.push(...lines.map((l) => stripAnsi(String(l))));
      if (all.length > BUILD_LOG_LINES) all.splice(0, all.length - BUILD_LOG_LINES);
      log.hidden = false;
      log.textContent = all.slice(-12).join('\n');
      log.scrollTop = log.scrollHeight;
    },
    stage(label) {
      stageText = label;
      stage.textContent = label;
      meter.hidden = true;
      bar.style.width = '0%';
    },
    progress(pct) {
      meter.hidden = false;
      bar.style.width = `${pct}%`;
      meter.setAttribute('aria-valuenow', String(pct));
      stage.textContent = `${stageText} ${pct}%`;
    },
    tail: (n) => all.slice(-n),
    stop: () => clearInterval(tick),
  };
}

function fixPrompt(m) {
  const lines = [`${m.build === 'upload' ? 'Uploading' : 'Compiling'} the sketch failed: ${m.error?.title || 'unknown error'}.`];
  if (m.error?.excerpt) lines.push(m.error.excerpt);
  for (const d of (m.error?.diagnostics || []).slice(0, 8)) lines.push(`${String(d.file).split(/[\\/]/).pop()}:${d.line}: ${d.level}: ${d.message}`);
  lines.push('Find the cause and fix it.');
  return lines.join('\n');
}

/** "313 KB", "1.25 MB", "640 bytes". */
function sizeText(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2).replace(/\.?0+$/, '')} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(bytes >= 100 * 1024 ? 0 : 1).replace(/\.0$/, '')} KB`;
  return `${bytes} bytes`;
}

/** Flash and RAM from Arduino IDE's summary sentences, as label / meter / value rows; null when there are none. */
function memoryRows(lines) {
  const num = (v) => Number(String(v).replace(/,/g, ''));
  // One sentence each; the used size, the percentage and the maximum are read from it separately.
  const read = (start) => {
    const line = lines.find((l) => l.startsWith(start));
    const used = line && /([\d,]+) bytes/.exec(line);
    if (!used) return null;
    const pct = /\((\d+)%\)/.exec(line);
    const max = /Maximum is ([\d,]+) bytes/.exec(line);
    return { used: num(used[1]), pct: pct ? Number(pct[1]) : null, max: max ? num(max[1]) : null };
  };
  const rows = [['Flash', read('Sketch uses')], ['RAM', read('Global variables use')]].filter(([, v]) => v);
  if (!rows.length) return null;
  return h('div', { class: 'v-build-mem' }, rows.flatMap(([label, v]) => {
    const pct = v.pct ?? (v.max ? Math.round((v.used / v.max) * 100) : null);
    const level = pct >= 90 ? 'empty' : pct >= 75 ? 'low' : null;
    return [
      h('span', { class: 'v-mem-label', text: label }),
      pct === null ? h('span') : h('div', { class: 'v-meter', role: 'meter', 'aria-label': `${label} used`, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), dataset: level ? { level } : {} }, h('span', { style: `width:${Math.min(100, pct)}%` })),
      h('span', { class: 'v-mem-value', text: `${sizeText(v.used)}${v.max ? ` of ${sizeText(v.max)}` : ''}${pct !== null ? ` · ${pct}%` : ''}` }),
    ];
  }));
}

function buildRecordCard(m) {
  const stopped = m.error?.code === 'CANCELLED';
  const card = h('div', { class: 'v-card v-build' },
    h('div', { class: 'v-card-head' }, led(m.ok ? 'green' : stopped ? 'amber' : 'red'), h('span', { text: m.title }), m.ms ? h('span', { class: 'v-step-time', text: seconds(m.ms) }) : null));
  if (!m.ok && !stopped && m.error?.hint) card.append(h('p', { text: m.error.hint }));
  if (!m.ok && !stopped && m.error?.excerpt) card.append(h('pre', { class: 'v-card-log', text: m.error.excerpt }));
  // Arduino IDE's two memory sentences become two short meters; the full
  // sentences stay in the Output below.
  const memory = memoryRows(m.summary || []);
  if (memory) card.append(memory);
  for (const line of m.summary || []) {
    if (memory && /^(Sketch uses|Global variables use) /.test(line)) continue;
    // The pin check's lines are a finding, not a size report.
    card.append(h('p', { class: /^\[PIN CHECK\]|^- |^Low memory/.test(line) ? 'v-build-pin' : 'v-build-summary', text: line.replace(/^\[PIN CHECK\] /, '') }));
  }
  const actions = [];
  if (!m.ok && !stopped) actions.push(h('button', { type: 'button', class: 'v-btn primary', onclick: () => send(fixPrompt(m), { mode: 'debug' }) }, icon(ICON.debug), 'Fix it'));
  if (m.ok && m.build === 'compile' && impulse.board.current().portPresent) actions.push(h('button', { type: 'button', class: 'v-btn', onclick: () => boardAction('upload') }, icon(ICON.upload), 'Upload to the board'));
  let fullLog = null;
  if (m.log?.length) {
    fullLog = h('pre', { class: 'v-card-log', text: m.log.join('\n'), hidden: true });
    const toggle = h('button', { type: 'button', class: 'v-steps-toggle', 'aria-expanded': 'false' }, icon(ICON.chevronRight), 'Output');
    toggle.addEventListener('click', () => {
      const show = fullLog.hidden;
      fullLog.hidden = !show;
      toggle.setAttribute('aria-expanded', String(show));
    });
    actions.push(toggle);
  }
  if (actions.length) card.append(h('div', { class: 'v-answer-actions' }, ...actions));
  if (fullLog) card.append(fullLog);
  return h('div', { class: 'v-msg-ai', dataset: { id: m.id } }, card);
}

/**
 * The agent asked to upload. Nothing reaches the board until this is answered,
 * so it is a card in the conversation with the board and port it would use.
 */
function askUpload(request) {
  const board = impulse.board.current();
  setEmpty(false);
  chats.begin(projectTitle() || `Upload to ${board.name || 'the board'}`);
  const card = h('div', { class: 'v-card' },
    h('div', { class: 'v-card-head' }, led('amber', { pulse: true }), 'Upload to the board?'),
    h('p', { text: `Impulse wants to put ${request.name} on ${board.name || request.boardFQBN} (${shortPort(request.port)}). Anything wired to the board runs the new code.` }));
  const answer = (allowed) => {
    api.ui.replyConfirmUpload(request.id, allowed);
    card.replaceChildren(
      h('div', { class: 'v-card-head' }, led(allowed ? 'green' : null), allowed ? 'Uploading…' : 'Upload cancelled'),
      h('p', { text: allowed ? `${request.name} is going to ${board.name || 'the board'} (${shortPort(request.port)}).` : 'Nothing was sent to the board.' }));
  };
  card.append(h('div', { class: 'v-answer-actions' },
    h('button', { type: 'button', class: 'v-btn primary', onclick: () => answer(true) }, icon(ICON.upload), 'Upload'),
    h('button', { type: 'button', class: 'v-btn', text: 'Not now', onclick: () => answer(false) })));
  append(h('div', { class: 'v-msg-ai' }, card));
}

function onBuildEvent(ev) {
  if (ev.phase === 'start') {
    liveBuild?.stop();
    const name = boardLabel(ev.fqbn);
    const title = ev.kind === 'upload' ? `Uploading to ${name}${ev.port ? ` on ${shortPort(ev.port)}` : ''}` : `Compiling for ${name}`;
    liveBuild = liveBuildCard({ id: ev.jobId, kind: ev.kind, title, name, port: ev.port, fqbn: ev.fqbn });
    // A chat that starts with a build is about the project, not about "Compiling…".
    chats.begin(projectTitle() || title);
    setEmpty(false);
    // During an agent turn the card goes above the live answer; otherwise at the end.
    const working = thread.querySelector('.v-msg-ai[aria-busy="true"]:not([data-build])');
    if (working) thread.insertBefore(liveBuild.el, working);
    else append(liveBuild.el);
    setAnnounce(`${title}…`, 'amber', { pulse: true });
    return;
  }
  if (!liveBuild || ev.jobId !== liveBuild.id) return;
  if (ev.phase === 'output') liveBuild.lines(ev.lines);
  else if (ev.phase === 'stage') liveBuild.stage(ev.label);
  else if (ev.phase === 'progress') liveBuild.progress(ev.percent);
  else if (ev.phase === 'done') {
    const live = liveBuild;
    liveBuild = null;
    live.stop();
    setAnnounce('');
    const title = ev.ok
      ? (live.kind === 'upload' ? `Uploaded to ${live.name}${ev.port || live.port ? ` on ${shortPort(ev.port || live.port)}` : ''}` : `Compiled for ${live.name}`)
      : ev.error?.code === 'CANCELLED' ? (live.kind === 'upload' ? 'The upload was stopped' : 'The build was stopped') : (ev.error?.title || 'Failed');
    const record = chats.add({
      role: 'card', kind: 'build', build: live.kind, ok: !!ev.ok, title,
      port: ev.port || live.port || null, fqbn: live.fqbn || null, ms: Math.round(ev.ms || 0),
      summary: ev.summary || [],
      error: ev.ok ? null : { code: ev.error?.code || null, title: ev.error?.title || '', hint: ev.error?.hint || '', excerpt: ev.error?.excerpt || '', diagnostics: (ev.error?.diagnostics || []).slice(0, 8) },
      log: live.tail(60),
    });
    live.el.replaceWith(buildRecordCard(record));
    renderChats();
  }
}

/* ═════════════════════════════ board, folder, credits ════════════════════ */

let boardBusy = false;

/** Verify or upload from chat mode. The build itself appears in the thread as a card (onBuildEvent). */
async function boardAction(kind) {
  if (boardBusy) return;
  if (!impulse.project.current()) {
    toast('Ask Impulse to build something first: there is no sketch yet.');
    return;
  }
  boardBusy = true;
  renderBoard();
  const res = await (kind === 'upload' ? impulse.board.upload() : impulse.board.verify());
  boardBusy = false;
  renderBoard();
  renderAccount();
  if (!res) return;
  if (res.needsBoard) {
    toast(res.error);
    impulse.board.openPicker();
    return;
  }
  // No build ran (nothing to save, no sketch…) or one is already running: say so; a build that ran has its card.
  if (!res.ok && (!res.code || res.code === 'BUSY')) toast(res.error);
}

function setAnnounce(message, state = 'amber', { pulse = false } = {}) {
  announce.hidden = !message;
  announce.lastChild.textContent = message || '';
  announce.firstChild.dataset.state = state;
  announce.firstChild.toggleAttribute('data-pulse', pulse);
}

function renderBoard() {
  const b = impulse.board.current();
  const hasProject = !!impulse.project.current();
  uploadButton.disabled = boardBusy || !hasProject || !b.portPresent;
  uploadButton.title = !hasProject ? 'Ask Impulse to build something first'
    : b.portPresent ? `Upload to ${b.name || 'the board'} on ${b.port} (⌘U)` : 'Connect a board and pick its port to upload';
  verifyButton.disabled = boardBusy || !hasProject;
  const state = b.portPresent ? 'green' : b.fqbn ? 'amber' : null;
  fill(boardChip, 
    led(state),
    icon(ICON.chip),
    h('span', { class: 'v-board-name', text: b.name || 'Choose a board' }),
    b.portPresent ? h('span', { class: 'v-board-port', text: b.port.replace(/^\/dev\/(cu\.)?/, '') }) : null,
    icon(ICON.caret));
  boardChip.title = b.portPresent ? `${b.name} on ${b.port}` : b.fqbn ? `${b.name}: no port, the simulator stands in` : 'Choose a board';
}

function openBoardMenu(anchor) {
  const b = impulse.board.current();
  const ports = impulse.board.ports();
  const items = [{ heading: 'Connected' }];
  if (ports.length) {
    for (const p of ports) {
      items.push({
        label: p.boardName || p.label,
        sub: p.port,
        icon: ICON.board,
        checked: p.port === b.port,
        onSelect: () => impulse.board.choosePort(p.port),
      });
    }
  } else {
    items.push({ label: 'No boards plugged in', sub: 'The simulator runs your sketch meanwhile', disabled: true });
  }
  items.push(
    { separator: true },
    { label: 'Choose a board and port…', icon: ICON.chip, onSelect: () => impulse.board.openPicker() },
    { label: 'Board options…', disabled: !b.fqbn, onSelect: () => impulse.board.openOptions() },
    { label: 'Run in the simulator', icon: ICON.sim, onSelect: () => bench.open('sim') });
  menu(anchor, items, { label: 'Board' });
}

function renderFolder() {
  const p = impulse.project.current();
  fill(folderChip, icon(p ? ICON.folder : ICON.folderPlus), h('span', { text: p ? p.name : 'New project' }), icon(ICON.caret));
  folderChip.title = p ? p.folder : 'A new project folder is made when Impulse writes code';
}

async function openExistingFolder(path) {
  if (busy) {
    toast('Wait for the current answer, or stop it first.');
    return;
  }
  const p = path ? await impulse.project.openFolder(path) : await impulse.project.pick();
  if (!p) {
    if (path) toast('That folder couldn\'t be opened.');
    return;
  }
  if (chats.current.messages.length && chats.current.project?.folder !== p.folder) await newChat({ keepProject: true });
  chats.set({ project: p });
  renderFolder();
  await loadProjectFiles();
  renderChats();
  bench.refreshCode();
}

function openFolderMenu(anchor) {
  const p = impulse.project.current();
  const items = [];
  if (p) {
    items.push({ heading: 'This chat\'s project' }, { label: p.name, sub: p.folder, icon: ICON.folder, checked: true, onSelect: () => bench.open('code') });
    items.push({ label: 'Show in Finder', onSelect: () => api.shell.showItemInFolder(p.file || p.folder) });
    items.push({ separator: true });
  }
  items.push(
    { label: 'Start a new project', sub: 'A fresh chat and folder', icon: ICON.folderPlus, onSelect: () => newChat() },
    { label: 'Open a folder…', sub: 'Work on a sketch you already have', icon: ICON.folder, onSelect: () => openExistingFolder() });
  menu(anchor, items, { label: 'Project', side: 'top' });
}

function renderCredits() {
  const s = account.status;
  const c = s.credits;
  if (!s.configured) {
    creditsButton.hidden = true;
    return;
  }
  creditsButton.hidden = false;
  if (!s.signedIn || !c) {
    fill(creditsButton, h('span', { text: 'Sign in' }));
    creditsButton.removeAttribute('data-level');
    creditsButton.setAttribute('aria-label', 'Sign in to Impulse');
    return;
  }
  const total = Math.max(1, c.monthly + Math.max(0, c.bonusCredits));
  const share = Math.max(0, Math.min(1, c.remaining / total));
  const level = c.remaining < MIN_CREDITS ? 'empty' : c.remaining < Math.max(10, c.monthly * 0.15) ? 'low' : '';
  const r = 6;
  const len = 2 * Math.PI * r;
  const ring = h('span', {
    html: `<svg class="v-ring" viewBox="0 0 16 16" aria-hidden="true"><circle class="track" cx="8" cy="8" r="${r}"/><circle class="fill" cx="8" cy="8" r="${r}" stroke-dasharray="${len.toFixed(2)}" stroke-dashoffset="${(len * (1 - share)).toFixed(2)}"/></svg>`,
    style: 'display:inline-flex',
  });
  fill(creditsButton, ring, h('span', { text: fmtCredits(c.remaining) }));
  if (level) creditsButton.dataset.level = level;
  else creditsButton.removeAttribute('data-level');
  creditsButton.setAttribute('aria-label', `${fmtCredits(c.remaining)} credits left. Details`);
}

function renderAccount() {
  const s = account.status;
  if (s.signedIn && s.user) {
    fill(meButton, avatar(s.user), h('span', { class: 'v-me-text' },
      h('span', { class: 'v-me-name', text: s.user.name || s.user.email }),
      h('span', { class: 'v-me-plan', text: s.credits ? `${s.credits.planName} plan` : s.needsVerification ? 'Verify your email' : '' })));
  } else {
    fill(meButton, h('span', { class: 'v-avatar', html: ICON.user, style: 'color:var(--v-text-3)' }), h('span', { class: 'v-me-text' },
      h('span', { class: 'v-me-name', text: s.configured ? 'Sign in' : 'Impulse Cloud isn\'t connected' }),
      h('span', { class: 'v-me-plan', text: s.configured ? 'Free credits to start' : 'This build has no cloud address' })));
  }
  if (boardBusy) return;
  const message = s.maintenance ? 'Impulse AI is in maintenance' : s.offline ? 'Offline: showing your last known credits' : s.announcement;
  setAnnounce(message, s.offline || s.maintenance ? 'amber' : 'green');
}

/** An app update: a quiet chip in the top bar. */
function onUpdateStatus(e) {
  const { status, data } = e.detail || {};
  updateChip.onclick = null;
  if (status === 'available') {
    fill(updateChip, led('green'), `Update${data?.version ? ` ${data.version}` : ''} available`);
    updateChip.title = 'Download the update';
    updateChip.onclick = () => api.updater.download();
    updateChip.hidden = false;
  } else if (status === 'progress') {
    fill(updateChip, led('amber', { pulse: true }), `Downloading update… ${Math.round(data?.percent ?? 0)}%`);
    updateChip.title = '';
    updateChip.hidden = false;
  } else if (status === 'downloaded') {
    fill(updateChip, led('green'), 'Restart to update');
    updateChip.title = 'Restart Impulse to install the update';
    updateChip.onclick = () => api.updater.install();
    updateChip.hidden = false;
  } else {
    updateChip.hidden = true;
  }
}

function openSettingsMenu(anchor) {
  const dark = document.documentElement.dataset.theme !== 'light';
  menu(anchor, [
    { label: dark ? 'Light theme' : 'Dark theme', icon: dark ? ICON.sun : ICON.moon, onSelect: () => impulse.theme.toggle() },
    { label: 'Switch to the IDE', icon: ICON.ide, meta: '⌘E', onSelect: () => setMode('ide') },
    { label: 'Preferences…', icon: ICON.settings, onSelect: () => impulse.tools.open('preferences') },
    { separator: true },
    { label: 'Report a problem…', onSelect: () => impulse.tools.open('report') },
  ], { label: 'Settings', side: 'top' });
}

/* ═════════════════════════════ chats ════════════════════════════════════ */

function groupOf(ms) {
  const day = 86400000;
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  if (ms >= startOfToday) return 'Today';
  if (ms >= startOfToday - day) return 'Yesterday';
  if (ms >= startOfToday - 7 * day) return 'Previous 7 days';
  return 'Older';
}

let projectFiles = { folder: null, files: [] };

async function loadProjectFiles() {
  const p = chats.current.project;
  if (!p?.folder) {
    projectFiles = { folder: null, files: [] };
    return;
  }
  const files = await impulse.project.files(p.folder);
  projectFiles = { folder: p.folder, files };
}

function renderChats() {
  const list = chats.list;
  const nodes = [];
  if (!list.length && !chats.current.id) {
    nodes.push(h('p', { class: 'v-chats-empty', text: 'Your chats and the projects they build show up here.' }));
  }
  let group = null;
  const shown = chats.current.id && !list.some((c) => c.id === chats.current.id)
    ? [{ ...chats.current, updatedAt: Date.now() }, ...list]
    : list;
  for (const saved of shown) {
    // The open chat's row follows the live chat (the saved summary lags a save behind).
    const c = saved.id === chats.current.id ? { ...saved, title: chats.current.title, status: chats.current.status, project: chats.current.project } : saved;
    const g = groupOf(c.updatedAt);
    if (g !== group) {
      group = g;
      nodes.push(h('div', { class: 'v-chat-group v-label', text: g }));
    }
    const isCurrent = c.id === chats.current.id;
    const state = c.status === 'error' ? 'red' : c.status === 'working' || c.status === 'stopped' ? 'amber' : c.project ? 'green' : null;
    const more = h('span', { class: 'v-icon-btn v-chat-more', role: 'button', tabindex: '0', 'aria-label': `More for ${c.title}`, html: ICON.more });
    const row = h('button', { type: 'button', class: 'v-chat', 'aria-current': String(isCurrent), title: c.title }, led(isCurrent && busy ? 'amber' : state, { pulse: isCurrent && busy }), h('span', { class: 'v-chat-title', text: c.title }), more);
    row.addEventListener('click', (e) => {
      if (more.contains(e.target)) return;
      openChat(c.id);
    });
    const openMore = (e) => {
      e.preventDefault();
      e.stopPropagation();
      chatMenu(more, c, row);
    };
    more.addEventListener('click', openMore);
    more.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') openMore(e); });
    nodes.push(row);
    if (isCurrent && c.project && projectFiles.folder === c.project.folder && projectFiles.files.length) {
      nodes.push(h('ul', { class: 'v-chat-files' }, projectFiles.files.map((f) => h('li', {},
        h('button', { type: 'button', class: 'v-chat-file', title: f.path, onclick: () => openFile(f.path) }, icon(ICON.file), h('span', { class: 'v-chat-file-name', text: f.name }))))));
    }
  }
  fill(chatList, ...nodes);
}

async function openFile(path) {
  await impulse.project.openFile(path);
  bench.open('code');
}

function chatMenu(anchor, c, row) {
  menu(anchor, [
    { label: 'Rename', onSelect: () => renameInline(c, row) },
    c.project ? { label: 'Show the project in Finder', onSelect: () => api.shell.showItemInFolder(c.project.file || c.project.folder) } : null,
    { separator: true },
    {
      label: 'Delete chat', danger: true, sub: c.project ? 'The project folder stays on disk' : null,
      onSelect: () => {
        const removal = chats.remove(c.id);
        renderChats();
        if (!chats.current.id) renderThread();
        toast('Chat deleted', { action: { label: 'Undo', run: () => { removal.undo(); renderChats(); }, expire: () => removal.commit() }, duration: 6000 });
      },
    },
  ], { label: 'Chat' });
}

function renameInline(c, row) {
  const field = h('input', { class: 'v-chat-rename', value: c.title, 'aria-label': 'Chat name', maxlength: '120' });
  const titleEl = row.querySelector('.v-chat-title');
  titleEl.replaceWith(field);
  field.focus();
  field.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const value = field.value.trim();
    if (save && value && value !== c.title) {
      if (c.id === chats.current.id && !chats.list.some((x) => x.id === c.id)) chats.set({ title: value });
      else chats.rename(c.id, value);
    }
    renderChats();
  };
  field.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  field.addEventListener('click', (e) => e.stopPropagation());
  field.addEventListener('blur', () => finish(true));
}

async function openChat(id) {
  if (busy) {
    toast('Wait for the current answer, or stop it first.');
    return;
  }
  const chat = await chats.open(id);
  if (!chat) {
    toast('That chat couldn\'t be opened.');
    return;
  }
  if (chat.project?.folder && !await impulse.project.open(chat.project)) {
    toast('This chat\'s project folder is gone. The conversation is still here.');
  }
  if (chat.mode) setChatMode(chat.mode);
  renderFolder();
  await loadProjectFiles();
  renderChats();
  renderThread();
  bench.refreshCode();
  input.focus({ preventScroll: true });
}

async function newChat({ keepProject = false } = {}) {
  if (busy) {
    toast('Wait for the current answer, or stop it first.');
    return;
  }
  await chats.startNew();
  if (!keepProject) impulse.project.close();
  renderFolder();
  projectFiles = { folder: null, files: [] };
  renderChats();
  renderThread();
  input.focus({ preventScroll: true });
}

function openSearch(anchor) {
  const box = h('input', { class: 'v-text', placeholder: 'Search chats and actions', 'aria-label': 'Search', style: 'margin-bottom:6px' });
  const results = h('div', { role: 'listbox' });
  const actions = [
    { label: 'New chat', icon: ICON.plus, run: () => newChat() },
    { label: 'Open the IDE', icon: ICON.ide, run: () => setMode('ide') },
    { label: 'Libraries', icon: ICON.library, run: () => openLibraries({ impulse }) },
    { label: 'Files', icon: ICON.folder, run: () => bench.open('files') },
    { label: 'Examples', icon: ICON.examples, run: () => openExamples() },
    { label: 'Serial monitor', icon: ICON.terminal, run: () => bench.open('serial') },
    { label: 'Simulator', icon: ICON.sim, run: () => bench.open('sim') },
    { label: 'Credits and plans', icon: ICON.bolt, run: () => account.openPlans() },
  ];
  const render = () => {
    const q = box.value.trim().toLowerCase();
    const found = chats.list.filter((c) => !q || c.title.toLowerCase().includes(q) || (c.preview || '').toLowerCase().includes(q)).slice(0, 8);
    const acts = actions.filter((a) => !q || a.label.toLowerCase().includes(q));
    const rows = [];
    if (found.length) rows.push(h('div', { class: 'v-pop-label v-label', text: 'Chats' }));
    for (const c of found) rows.push(h('button', { type: 'button', class: 'v-item', onclick: () => { closePopover(); openChat(c.id); } }, h('span', { class: 'v-item-text' }, h('span', { class: 'v-item-title', text: c.title }), h('span', { class: 'v-item-sub', text: c.preview || timeAgo(c.updatedAt) })), h('span', { class: 'v-item-meta', text: timeAgo(c.updatedAt) })));
    if (acts.length) rows.push(h('div', { class: 'v-pop-label v-label', text: 'Actions' }));
    for (const a of acts) rows.push(h('button', { type: 'button', class: 'v-item', onclick: () => { closePopover(); a.run(); } }, icon(a.icon), h('span', { class: 'v-item-text' }, h('span', { class: 'v-item-title', text: a.label }))));
    if (!rows.length) rows.push(h('div', { class: 'v-pop-label', style: 'color:var(--v-text-3)', text: 'Nothing matches.' }));
    fill(results, ...rows);
  };
  box.addEventListener('input', render);
  box.addEventListener('keydown', (e) => {
    const items = [...results.querySelectorAll('button.v-item')];
    if (e.key === 'ArrowDown' && items.length) {
      e.preventDefault();
      items[0].focus();
    } else if (e.key === 'Enter' && items.length) {
      e.preventDefault();
      items[0].click();
    }
  });
  results.addEventListener('keydown', (e) => {
    const items = [...results.querySelectorAll('button.v-item')];
    const at = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(items.length - 1, at + 1)]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); if (at <= 0) box.focus(); else items[at - 1].focus(); }
  });
  render();
  const pop = popover(anchor, h('div', { style: 'width:340px' }, box, results), { label: 'Search', focus: false });
  if (pop) requestAnimationFrame(() => box.focus());
}

/* ═════════════════════════════ wiring ═══════════════════════════════════ */

function wire() {
  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy) stop();
    else send();
  });
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!busy) send();
    }
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && busy && !document.querySelector('.v-pop, .v-overlay')) {
      e.preventDefault();
      stop();
    }
  });
  modeChip.addEventListener('click', () => openModeMenu(modeChip));
  plusButton.addEventListener('click', () => openPlusMenu(plusButton));
  boardChip.addEventListener('click', () => openBoardMenu(boardChip));
  uploadButton.addEventListener('click', () => boardAction('upload'));
  verifyButton.addEventListener('click', () => boardAction('verify'));
  folderChip.addEventListener('click', () => openFolderMenu(folderChip));
  creditsButton.addEventListener('click', () => (account.status.signedIn ? account.creditsPopover(creditsButton) : account.openSignIn()));
  meButton.addEventListener('click', () => account.accountMenu(meButton));
  settingsButton.addEventListener('click', () => openSettingsMenu(settingsButton));
  switchChat.addEventListener('click', () => setMode('vibe'));
  switchIde.addEventListener('click', () => setMode('ide'));
  serialButton.addEventListener('click', () => bench.toggle('serial'));
  simButton.addEventListener('click', () => bench.toggle('sim'));

  stage.addEventListener('pointermove', (e) => {
    if (!charField || emptyState.hidden) return;
    const r = field.getBoundingClientRect();
    charField.setPointer(e.clientX - r.left, e.clientY - r.top);
  });
  stage.addEventListener('pointerleave', () => charField?.setPointer(null));
  // A click anywhere on the empty screen sends a ripple of light out from it.
  stage.addEventListener('pointerdown', (e) => {
    if (!charField || emptyState.hidden || e.button !== 0) return;
    const r = field.getBoundingClientRect();
    charField.ripple(e.clientX - r.left, e.clientY - r.top);
  });
  new ResizeObserver(() => updateFieldFocus()).observe(stage);

  // Keyboard: ⌘K search, ⌘⇧I the IDE, ⌘N a new chat (in chat mode).
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (e.key.toLowerCase() === 'k' && !e.shiftKey && shellMode() === 'vibe') {
      e.preventDefault();
      openSearch(side.querySelectorAll('.v-side-action')[1]);
    }
  });

  window.addEventListener('impulse:board-changed', renderBoard);
  window.addEventListener('impulse:board-display', renderBoard);
  window.addEventListener('impulse:sketch-changed', async () => {
    renderFolder();
    await loadProjectFiles();
    renderChats();
    bench.refreshCode();
  });
  window.addEventListener('impulse:update-status', onUpdateStatus);
  impulse.serial.onState((s) => { serialDot.hidden = !s.connected; });

  // Messages the IDE raises (a board plugged in, an update ready…) show as this view's toast.
  window.addEventListener('impulse:notify', (e) => {
    const n = e.detail || {};
    if (shellMode() !== 'vibe' || !(n.message || n.title)) return;
    toast(n.message || n.title, { duration: n.duration > 0 ? Math.min(n.duration, 8000) : 3200 });
  });

  // Code blocks in answers: Copy.
  thread.addEventListener('click', (e) => {
    const copy = e.target.closest('.code-copy-btn');
    if (!copy) return;
    const code = copy.closest('.code-block-wrapper')?.querySelector('code');
    if (code) impulse.ai.copy(code.textContent, copy);
  });

  chats.onChange((what) => {
    if (what === 'list') renderChats();
  });
  account.onChange(() => {
    renderAccount();
    renderCredits();
  });

  new MutationObserver(() => charField?.colors()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

/* ═════════════════════════════ start ════════════════════════════════════ */

export async function startChatMode() {
  document.body.append(root);
  bench = createBench({ host: root, impulse, onChange: onBenchChange });

  impulse.shell = {
    get mode() { return shellMode(); },
    setMode,
    newChat: () => newChat(),
    openFolder: (path) => openExistingFolder(path),
    openBench: (tab) => bench.open(tab),
    toggleBench: (tab) => bench.toggle(tab),
    closeBench: () => bench.hide(),
    focusComposer: () => input.focus(),
    boardAction,
  };
  // The IDE's chat panel writes into the same chats.
  impulse.chatLog = {
    get busy() { return busy; },
    user: (text, meta = {}) => {
      chats.begin(text);
      chats.add({ role: 'user', text, snapshot: meta.snapshot || null });
      chats.set({ status: 'working', mode: meta.mode || mode });
      renderChats();
    },
    assistant: (result, meta = {}) => {
      chats.add({ role: 'assistant', ok: !!result.ok, stopped: !!result.stopped, code: result.code || null, text: String(result.content || ''), mode: meta.mode || mode, model: 'Impulse AI' });
      chats.set({ status: result.ok ? 'ok' : result.stopped ? 'stopped' : 'error' });
      renderChats();
    },
    startNew: () => newChat({ keepProject: true }),
  };
  impulse.account = account;

  wire();
  api.arduino?.onBuildEvent?.(onBuildEvent);
  api.ui?.onConfirmUpload?.(askUpload);
  let side0 = 'open';
  try { side0 = localStorage.getItem(SIDE_KEY) || 'open'; } catch { /* no storage */ }
  setSide(side0 !== 'closed');
  setChatMode(impulse.ai.info().mode === 'plan' || impulse.ai.info().mode === 'debug' ? impulse.ai.info().mode : 'agent');
  renderBoard();
  renderFolder();
  renderAccount();
  renderCredits();

  let saved = 'vibe';
  try { saved = localStorage.getItem(SHELL_KEY) || 'vibe'; } catch { /* no storage */ }
  setMode(saved, { save: false });

  await Promise.all([chats.load(), account.load()]);
  renderChats();
  renderThread();

  charField = new CharField(field);
  if (!chats.current.messages.length) {
    await charField.start();
    if (shellMode() !== 'vibe') charField.pause();
    requestAnimationFrame(() => {
      field.setAttribute('data-on', '');
      updateFieldFocus();
    });
    greet();
  }
}
