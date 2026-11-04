// Breakpoints in the editor: a gutter left of the line numbers (click to
// toggle, or Debug › Toggle Breakpoint), kept per file across tab switches
// and restarts, plus the highlight of the line the debugger is stopped on.
// The editor is one CodeMirror instance whose text is swapped per tab.

const GUTTER = 'impulse-bp-gutter';
const STORE_KEY = 'impulse-breakpoints';

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return new Map(Object.entries(raw).map(([file, lines]) => [file, new Set(lines.filter(n => Number.isInteger(n) && n > 0))]));
  } catch {
    return new Map();
  }
}

/**
 * @param {import('codemirror').Editor} editor
 * @param {{ getFile: () => string|null, announce?: (text: string) => void, onChange?: () => void }} opts
 */
export function attachBreakpoints(editor, { getFile, announce = () => {}, onChange = () => {} }) {
  const store = load();
  const unverified = new Map(); // file → Set of lines without code
  let current = null; // { file, line } where the debugger is stopped
  let currentHandle = null;
  let frame = null; // { file, line } of a selected caller frame
  let frameHandle = null;

  const gutters = (editor.getOption('gutters') || []).filter(g => g !== GUTTER);
  editor.setOption('gutters', [GUTTER, ...gutters]);

  const save = () => {
    try {
      const out = {};
      for (const [file, lines] of store) if (lines.size) out[file] = [...lines].sort((a, b) => a - b);
      localStorage.setItem(STORE_KEY, JSON.stringify(out));
    } catch { /* storage unavailable: breakpoints last for this session */ }
  };

  /** Gutter content for a line: its breakpoint dot, and the arrow when the debugger is stopped there. */
  const marker = (line, file, { breakpoint, here }) => {
    const slot = document.createElement('span');
    slot.className = 'bp-slot';
    slot.setAttribute('aria-hidden', 'true');
    if (breakpoint) {
      const dot = document.createElement('span');
      const missing = unverified.get(file)?.has(line);
      dot.className = `bp-marker${missing ? ' unverified' : ''}`;
      slot.title = missing ? 'Breakpoint: no code runs on this line or the lines after it' : `Breakpoint on line ${line}`;
      slot.appendChild(dot);
    }
    if (here) {
      const arrow = document.createElement('span');
      arrow.className = 'bp-current';
      slot.title = slot.title ? `${slot.title} · stopped here` : 'Stopped here';
      slot.appendChild(arrow);
    }
    return slot;
  };

  const render = () => {
    const file = getFile();
    editor.operation(() => {
      editor.clearGutter(GUTTER);
      const lines = new Set(file ? store.get(file) : []);
      const hereLine = current && file && current.file === file && current.line - 1 < editor.lineCount() ? current.line : null;
      for (const line of new Set([...lines, ...(hereLine ? [hereLine] : [])])) {
        if (line - 1 < editor.lineCount()) editor.setGutterMarker(line - 1, GUTTER, marker(line, file, { breakpoint: lines.has(line), here: line === hereLine }));
      }
      if (currentHandle) {
        editor.removeLineClass(currentHandle, 'background', 'cm-debug-current');
        editor.removeLineClass(currentHandle, 'gutter', 'cm-debug-current-gutter');
        currentHandle = null;
      }
      if (hereLine) {
        currentHandle = editor.addLineClass(hereLine - 1, 'background', 'cm-debug-current');
        editor.addLineClass(currentHandle, 'gutter', 'cm-debug-current-gutter');
      }
      if (frameHandle) {
        editor.removeLineClass(frameHandle, 'background', 'cm-debug-frame');
        frameHandle = null;
      }
      if (frame && file && frame.file === file && frame.line - 1 < editor.lineCount()) {
        frameHandle = editor.addLineClass(frame.line - 1, 'background', 'cm-debug-frame');
      }
    });
  };

  /** After an edit, breakpoints follow their lines (CodeMirror moves the markers). */
  const readBack = () => {
    const file = getFile();
    if (!file) return;
    const lines = new Set();
    editor.eachLine((handle) => {
      if (handle.gutterMarkers?.[GUTTER]?.querySelector('.bp-marker')) lines.add(editor.getLineNumber(handle) + 1);
    });
    const before = store.get(file) || new Set();
    if (lines.size === before.size && [...lines].every(l => before.has(l))) return;
    if (lines.size) store.set(file, lines);
    else store.delete(file);
    unverified.delete(file);
    save();
    onChange();
  };

  const toggle = (line = editor.getCursor().line + 1) => {
    const file = getFile();
    if (!file) return false;
    const lines = store.get(file) || new Set();
    const adding = !lines.has(line);
    if (adding) lines.add(line);
    else lines.delete(line);
    if (lines.size) store.set(file, lines);
    else store.delete(file);
    unverified.get(file)?.delete(line);
    save();
    render();
    announce(adding ? `Breakpoint added on line ${line}` : `Breakpoint removed from line ${line}`);
    onChange();
    return adding;
  };

  editor.on('gutterClick', (cm, line, gutter) => {
    if (gutter === GUTTER || gutter === 'CodeMirror-linenumbers') toggle(line + 1);
  });
  editor.on('change', (cm, change) => {
    if (change.origin === 'setValue') render();
    else readBack();
  });

  render();

  return {
    toggle,
    render,
    /** Breakpoint lines (1-based) per file. */
    all: () => new Map([...store].map(([f, lines]) => [f, [...lines].sort((a, b) => a - b)])),
    lines: (file) => [...(store.get(file) || [])].sort((a, b) => a - b),
    clearAll() {
      store.clear();
      unverified.clear();
      save();
      render();
      onChange();
    },
    /**
     * What the debugger made of a file's breakpoints: lines without code move
     * to the line that has it, or are shown hollow when there is none.
     * @param {Map<number, number|null>} resolved requested line → actual line
     */
    setResolved(file, resolved) {
      const lines = store.get(file);
      if (!lines) return;
      const missing = new Set();
      for (const [requested, actual] of resolved) {
        if (actual === null) missing.add(requested);
        else if (actual !== requested && lines.has(requested)) {
          lines.delete(requested);
          lines.add(actual);
        }
      }
      unverified.set(file, missing);
      save();
      render();
    },
    remove(file, line) {
      const lines = store.get(file);
      if (!lines?.delete(line)) return;
      if (!lines.size) store.delete(file);
      unverified.get(file)?.delete(line);
      save();
      render();
      announce(`Breakpoint removed from line ${line}`);
      onChange();
    },
    unverifiedLines: (file) => new Set(unverified.get(file) || []),
    /** Highlight a caller's line while its stack frame is selected (null clears it). */
    setFrame(location) {
      frame = location?.file && location.line ? { file: location.file, line: location.line } : null;
      render();
      if (frame && frame.file === getFile()) editor.scrollIntoView({ line: frame.line - 1, ch: 0 }, 80);
    },
    clearResolved() {
      unverified.clear();
      render();
    },
    /** Highlight the line the debugger stopped on (null clears it, and any selected frame). */
    setCurrent(location) {
      current = location?.file && location.line ? { file: location.file, line: location.line } : null;
      frame = null;
      render();
      if (current && current.file === getFile()) editor.scrollIntoView({ line: current.line - 1, ch: 0 }, 80);
    },
  };
}
