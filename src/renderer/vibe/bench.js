// The side panel in chat mode: the simulator (the same live circuit as the
// IDE's, moved in while shown), the serial monitor, and the code (a second
// editor on the same document as the IDE's, so edits show in both).

import { fill, h, icon, led, toast } from './dom.js';
import { ICON } from './icons.js';
import { askText, confirmAsk } from './ask.js';

const WIDTH_KEY = 'impulse-vibe-bench-width';
const BAUDS = [9600, 19200, 38400, 57600, 74880, 115200, 230400];
const MAX_LINES = 3000;

/**
 * @param {{ host: HTMLElement, impulse: object, onChange?: (tab: string | null) => void }} deps
 */
export function createBench({ host, impulse, onChange }) {
  let tab = null;
  let codeEditor = null;

  const tabButton = (id, label, svg) => h('button', {
    type: 'button', class: 'v-tab', role: 'tab', id: `vTab-${id}`, 'aria-controls': `vPane-${id}`, 'aria-selected': 'false',
    onclick: () => open(id),
  }, icon(svg), label);
  const tabs = {
    sim: tabButton('sim', 'Simulator', ICON.sim),
    serial: tabButton('serial', 'Serial', ICON.terminal),
    code: tabButton('code', 'Code', ICON.code),
    files: tabButton('files', 'Files', ICON.folder),
  };

  // ── Serial ─────────────────────────────────────────────────────────────
  const serialLed = led(null);
  const serialText = h('span', { text: 'Not connected' });
  const baud = h('select', { class: 'v-select', 'aria-label': 'Baud rate' }, BAUDS.map((b) => h('option', { value: String(b), text: String(b) })));
  const connectBtn = h('button', { type: 'button', class: 'v-btn', text: 'Connect' });
  const clearBtn = h('button', { type: 'button', class: 'v-icon-btn', 'aria-label': 'Clear the output', title: 'Clear the output', html: ICON.trash });
  const out = h('div', { class: 'v-serial-out', role: 'log', 'aria-live': 'polite', tabindex: '0', 'aria-label': 'Serial output' });
  const empty = h('div', { class: 'v-serial-empty', text: 'Connect a board to see what it prints. Lines from the simulator show here too while it runs.' });
  const sendInput = h('input', { type: 'text', placeholder: 'Send to the board…', 'aria-label': 'Send to the board', spellcheck: 'false' });
  const sendForm = h('form', { class: 'v-serial-send' }, sendInput, h('button', { type: 'submit', class: 'v-btn', text: 'Send' }));
  let atBottom = true;
  out.addEventListener('scroll', () => { atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 24; });

  const KIND_CLASS = { tx: 'tx', info: 'info', error: 'err', rx: 'rx' };

  /** A batch of lines: one fragment, one trim, one scroll. */
  function lines(batch) {
    if (!batch?.length) return;
    empty.hidden = true;
    const fragment = document.createDocumentFragment();
    for (const entry of batch) {
      const time = new Date(entry.at || Date.now()).toLocaleTimeString(undefined, { hour12: false });
      fragment.append(h('div', { class: KIND_CLASS[entry.kind] || 'rx' },
        h('span', { class: 't', text: entry.source ? `${time} ${entry.source}` : time }), entry.text));
    }
    out.append(fragment);
    while (out.childElementCount > MAX_LINES) out.firstElementChild.remove();
    if (atBottom) out.scrollTop = out.scrollHeight;
  }

  function syncSerial() {
    const s = impulse.serial.state();
    serialLed.dataset.state = s.connected ? 'green' : '';
    serialText.textContent = s.connected ? `${s.port} · ${s.baud}` : s.port ? `Ready: ${s.port}` : 'No board port selected';
    connectBtn.textContent = s.connected ? 'Disconnect' : 'Connect';
    connectBtn.disabled = !s.connected && !s.port;
    baud.value = String(s.baud);
    sendInput.disabled = !s.connected;
  }

  connectBtn.addEventListener('click', async () => {
    connectBtn.disabled = true;
    const s = impulse.serial.state();
    if (s.connected) await impulse.serial.disconnect();
    else await impulse.serial.connect();
    syncSerial();
  });
  baud.addEventListener('change', () => impulse.serial.setBaud(Number(baud.value)));
  clearBtn.addEventListener('click', () => {
    out.replaceChildren();
    empty.hidden = false;
    impulse.serial.clear();
  });
  sendForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = sendInput.value;
    if (!text) return;
    if (await impulse.serial.send(text)) sendInput.value = '';
  });
  impulse.serial.onLines(lines);
  impulse.serial.onCleared(() => { out.replaceChildren(); empty.hidden = false; });
  impulse.serial.onState(syncSerial);
  // What the board printed before this pane existed.
  impulse.serial.history(500).then(lines).catch(() => {});

  const serialPane = h('div', { class: 'v-pane', id: 'vPane-serial', role: 'tabpanel', 'aria-labelledby': 'vTab-serial', hidden: true },
    h('div', { class: 'v-serial-bar' }, h('span', { class: 'v-serial-status' }, serialLed, serialText), baud, connectBtn, clearBtn),
    h('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column' }, empty, out),
    sendForm);

  // ── Simulator ──────────────────────────────────────────────────────────
  const simPane = h('div', { class: 'v-pane v-pane-sim', id: 'vPane-sim', role: 'tabpanel', 'aria-labelledby': 'vTab-sim', hidden: true });

  // ── Code ───────────────────────────────────────────────────────────────
  const codeName = h('span', { text: '' });
  const codeSlot = h('div', { class: 'v-code-slot' });
  const codeEmpty = h('div', { class: 'v-code-empty', text: 'No code yet. Ask Impulse to build something and the sketch shows up here.' });
  const openInIde = h('button', { type: 'button', class: 'v-btn ghost', text: 'Open in IDE', onclick: () => impulse.shell.setMode('ide') });
  const codePane = h('div', { class: 'v-pane', id: 'vPane-code', role: 'tabpanel', 'aria-labelledby': 'vTab-code', hidden: true },
    h('div', { class: 'v-code-head' }, icon(ICON.file), codeName, openInIde), codeEmpty, codeSlot);

  function syncCode() {
    const file = impulse.editor.currentFile();
    codeName.textContent = file ? file.split(/[/\\]/).pop() : '';
    codeEmpty.hidden = !!file;
    codeSlot.hidden = !file;
    openInIde.hidden = !file;
    if (file && !codeEditor) codeEditor = impulse.editor.createLinked(codeSlot);
    if (codeEditor) requestAnimationFrame(() => codeEditor.refresh());
  }

  // ── Files ──────────────────────────────────────────────────────────────
  // The project's files, with the things every editor has: open, rename, add,
  // delete (to the Trash). No trip through the IDE for any of it.
  const fileList = h('div', { class: 'v-files' });
  const filesEmpty = h('div', { class: 'v-code-empty', text: 'No project yet. Ask Impulse to build something and its files show up here.' });
  const newFileBtn = h('button', { type: 'button', class: 'v-btn', 'aria-label': 'New file' }, icon(ICON.plus), 'New file');
  const revealBtn = h('button', { type: 'button', class: 'v-btn ghost', text: 'Show in Finder' });
  const filesPane = h('div', { class: 'v-pane', id: 'vPane-files', role: 'tabpanel', 'aria-labelledby': 'vTab-files', hidden: true },
    h('div', { class: 'v-files-head' }, h('span', { class: 'v-files-folder' }), h('span', { class: 'v-spacer' }), newFileBtn, revealBtn),
    filesEmpty, fileList);

  async function syncFiles() {
    const project = impulse.project.current();
    const head = filesPane.querySelector('.v-files-folder');
    head.textContent = project ? project.name : '';
    filesEmpty.hidden = !!project;
    newFileBtn.hidden = !project;
    revealBtn.hidden = !project;
    fill(fileList);
    if (!project) return;
    const files = await impulse.project.files(project.folder);
    const open = impulse.editor.currentFile();
    for (const file of files) {
      const isOpen = open === file.path;
      const isSketch = /\.ino$/i.test(file.name);
      const row = h('div', { class: `v-file${isOpen ? ' open' : ''}` },
        h('button', {
          type: 'button', class: 'v-file-name', title: file.path,
          onclick: () => impulse.project.openFile(file.path).then(() => { syncFiles(); syncCode(); }),
        }, icon(ICON.file), file.name, isOpen ? h('span', { class: 'v-file-tag', text: 'open' }) : null),
        h('button', {
          type: 'button', class: 'v-icon-btn', 'aria-label': `Rename ${file.name}`, title: 'Rename', html: ICON.file,
          onclick: () => renameFile(file),
        }),
        h('button', {
          type: 'button', class: 'v-icon-btn', 'aria-label': `Delete ${file.name}`, title: isSketch && files.filter((f) => /\.ino$/i.test(f.name)).length === 1 ? 'The sketch itself cannot be deleted here' : 'Delete', html: ICON.trash,
          disabled: isSketch && files.filter((f) => /\.ino$/i.test(f.name)).length === 1,
          onclick: () => deleteFile(file),
        }));
      fileList.append(row);
    }
  }

  async function renameFile(file) {
    const name = await askText({ title: `Rename ${file.name}`, label: 'New name', value: file.name, confirmLabel: 'Rename' });
    if (!name || name === file.name) return;
    const res = await window.electronAPI.file.rename(file.path, name).catch((e) => ({ success: false, error: e.message }));
    if (!res?.success) {
      toast(res?.error || 'Could not rename the file');
      return;
    }
    // The open file moved: reopen it under its new name.
    if (impulse.editor.currentFile() === file.path) await impulse.project.openFile(res.path);
    toast(`Renamed to ${name}`);
    await syncFiles();
    syncCode();
  }

  async function deleteFile(file) {
    const ok = await confirmAsk({
      title: `Delete ${file.name}?`,
      text: 'It goes to the Trash, so you can put it back.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const res = await window.electronAPI.file.remove(file.path).catch((e) => ({ success: false, error: e.message }));
    if (!res?.success) {
      toast(res?.error || 'Could not delete the file');
      return;
    }
    toast(`${file.name} moved to the Trash`);
    await syncFiles();
  }

  newFileBtn.addEventListener('click', async () => {
    const project = impulse.project.current();
    if (!project) return;
    const name = await askText({ title: 'New file', label: 'Name', value: '', placeholder: 'helpers.h', confirmLabel: 'Create' });
    if (!name) return;
    const res = await window.electronAPI.file.create(project.folder, name).catch((e) => ({ success: false, error: e.message }));
    if (!res?.success) {
      toast(res?.error || 'Could not make the file');
      return;
    }
    await impulse.project.openFile(res.path);
    await syncFiles();
    syncCode();
  });
  revealBtn.addEventListener('click', () => {
    const project = impulse.project.current();
    if (project) window.electronAPI.shell?.showItemInFolder?.(project.file || project.folder);
  });

  // ── Frame ──────────────────────────────────────────────────────────────
  const close = h('button', { type: 'button', class: 'v-icon-btn', 'aria-label': 'Close the panel', title: 'Close', html: ICON.close, onclick: () => hide() });
  const resize = h('div', { class: 'v-bench-resize', 'aria-hidden': 'true' });
  const el = h('aside', { class: 'v-bench', hidden: true, 'aria-label': 'Workbench' },
    resize,
    h('div', { class: 'v-bench-head' }, h('div', { class: 'v-tabs', role: 'tablist', 'aria-label': 'Workbench' }, tabs.sim, tabs.serial, tabs.code, tabs.files), close),
    h('div', { class: 'v-bench-body' }, simPane, serialPane, codePane, filesPane));
  host.append(el);

  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    if (saved >= 360) el.style.width = `${saved}px`;
  } catch { /* no storage */ }
  resize.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    resize.setPointerCapture(e.pointerId);
    resize.dataset.dragging = '';
    const startX = e.clientX;
    const startW = el.getBoundingClientRect().width;
    const move = (ev) => {
      // The chat column keeps at least 420px.
      const mainLeft = host.querySelector('.v-main')?.getBoundingClientRect().left || 0;
      const max = Math.min(window.innerWidth * 0.7, window.innerWidth - mainLeft - 420);
      el.style.width = `${Math.round(Math.max(360, Math.min(max, startW + (startX - ev.clientX))))}px`;
    };
    const up = () => {
      delete resize.dataset.dragging;
      resize.removeEventListener('pointermove', move);
      resize.removeEventListener('pointerup', up);
      try { localStorage.setItem(WIDTH_KEY, String(Math.round(el.getBoundingClientRect().width))); } catch { /* no storage */ }
      if (tab === 'sim') impulse.sim.fit();
      codeEditor?.refresh();
    };
    resize.addEventListener('pointermove', move);
    resize.addEventListener('pointerup', up);
  });

  function open(id) {
    if (!['sim', 'serial', 'code', 'files'].includes(id)) return;
    el.hidden = false;
    tab = id;
    for (const [key, button] of Object.entries(tabs)) button.setAttribute('aria-selected', String(key === id));
    simPane.hidden = id !== 'sim';
    serialPane.hidden = id !== 'serial';
    codePane.hidden = id !== 'code';
    filesPane.hidden = id !== 'files';
    if (id === 'sim') impulse.sim.mountInto(simPane);
    if (id === 'serial') {
      syncSerial();
      requestAnimationFrame(() => { out.scrollTop = out.scrollHeight; });
    }
    if (id === 'code') syncCode();
    if (id === 'files') syncFiles();
    onChange?.(tab);
  }

  function hide() {
    el.hidden = true;
    tab = null;
    impulse.sim.restore();
    onChange?.(null);
  }

  return {
    el,
    get tab() { return tab; },
    open,
    hide,
    toggle(id) {
      if (tab === id) hide();
      else open(id);
    },
    /** The sketch changed (a new project, another file). */
    refreshCode() {
      if (tab === 'code') syncCode();
      if (tab === 'files') syncFiles();
    },
    /** Leaving chat mode: hand the simulator back to the IDE. */
    release() {
      impulse.sim.restore();
    },
    /** Back in chat mode. */
    reclaim() {
      if (tab === 'sim') impulse.sim.mountInto(simPane);
      if (tab === 'code') syncCode();
      if (tab === 'files') syncFiles();
    },
  };
}
