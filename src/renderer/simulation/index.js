// Simulation manager: the simulator view. Owns the canvas, the AVR runner and
// the circuit engine, and the UI around them (toolbar, part picker, inspector,
// examples, serial monitor, logic analyzer, circuit checks, debugger).
//
// The circuit belongs to the open sketch and is saved next to it as
// diagram.json (Wokwi format). Without a saved sketch it lives in local storage.

import { F_CPU } from './avr-runner.js';
import { createRunner, runnerFamily, programOf } from './runners.js';
import { CircuitEngine, staticTopology } from './engine.js';
import { CircuitCanvas } from './canvas.js';
import { PARTS, partDef } from './parts/catalog.js';
import { BOARDS, BOARD_ORDER, boardByTag, boardForFqbn, compileTarget, simulationTarget, boardPinNumber, boardPowerPin, pinLabel, simulatedBoardsText, registerBoardChip } from './boards.js';
import { circuitChecks } from './checks.js';
import { toDiagram, fromDiagram, hintsToPoints, remapBoardWires } from './diagram.js';
import { validateCircuit, layoutCircuit, catalogText } from './circuit-ai.js';
import { LogicAnalyzer } from './logic-analyzer.js';
import { PartPicker } from './ui/picker.js';
import { Inspector } from './ui/inspector.js';
import { ExamplesGallery } from './ui/gallery.js';
import { exampleDiagram, EXAMPLES } from './examples.js';
import { h, icon, iconSvg, mod } from './ui/dom.js';
import { isMuted, setMuted, onMuteChange } from './audio.js';
import { confirmDialog } from '../dialog.js';
import { detectBaud } from '../compare.js';
import { readDebugInfo } from './dwarf.js';
import { Debugger, inDirs } from './debugger.js';
import { DebugPane } from './ui/debug-pane.js';

const SCRATCH_KEY = 'impulse-sim-diagram';
const DIAGRAM_FILE = 'diagram.json';
const HISTORY_LIMIT = 100;
const SERIAL_LIMIT = 200_000;
const LINE_ENDINGS = { newline: '\n', none: '', cr: '\r', both: '\r\n' };

const sketchFolder = (p) => p.replace(/[/\\][^/\\]+$/, '');

/** Where a sketch's diagram.json lives: next to it, or at the root of its PlatformIO project (as in Wokwi). */
function diagramFolder(sketchPath) {
  const root = window.state?.pio?.root;
  if (root) {
    const norm = (x) => x.replace(/\\/g, '/').toLowerCase();
    if (norm(sketchPath).startsWith(`${norm(root).replace(/\/+$/, '')}/`)) return root;
  }
  return sketchFolder(sketchPath);
}
const joinPath = (folder, name) => `${folder}${folder.includes('\\') && !folder.includes('/') ? '\\' : '/'}${name}`;

export class SimulationManager {
  constructor() {
    this.runner = createRunner('uno');
    this._runnerFamily = 'avr';
    this.engine = new CircuitEngine(this.runner);
    this.canvas = null;
    this.running = false;
    this.paused = false;
    this.sketchPath = null;
    this._history = [];
    this._future = [];
    this._loading = false;
    this._saveTimer = null;
    this._historyTimer = null;
    this._serialLines = ['', '', '', ''];
    this._captureBuf = '';
    this._pinActivity = {};
    this._agentRunning = false;
    this._shorts = [];
    this._libCache = null;
    this.debug = null; // { dbg, dirs, stopped } while debugging

    this._buildUI();
    this._bindRunner();
    this._bindGlobalKeys();
    this._restore();
  }

  // ── UI ───────────────────────────────────────────────────────────────────

  _buildUI() {
    const panel = document.getElementById('simPanel');
    if (!panel) return;
    panel.innerHTML = '';

    const btn = (id, iconName, title, cls = '') => {
      const b = h('button', { type: 'button', id, class: `sim-tb-btn ${cls}`.trim(), title, 'aria-label': title });
      b.innerHTML = iconSvg(iconName, iconName === 'play' ? 18 : 16);
      return b;
    };

    this.playBtn = btn('simPlayBtn', 'play', 'Start the simulation', 'go');
    this.stopBtn = btn('simStopBtn', 'stop', 'Stop the simulation');
    this.pauseBtn = btn('simPauseBtn', 'pause', 'Pause');
    this.debugBtn = btn('simDebugBtn', 'bug', 'Debug: run to breakpoints (F5)');
    this.continueBtn = btn('simContinueBtn', 'continue', 'Continue (F5)');
    this.stepOverBtn = btn('simStepOverBtn', 'stepOver', 'Step over (F10)');
    this.stepIntoBtn = btn('simStepIntoBtn', 'stepInto', 'Step into (F11)');
    this.stepOutBtn = btn('simStepOutBtn', 'stepOut', 'Step out (⇧F11)');
    this.debugGroup = h('div', { class: 'sim-tb-group sim-debug-group', role: 'group', 'aria-label': 'Debugger', hidden: true },
      this.continueBtn, this.stepOverBtn, this.stepIntoBtn, this.stepOutBtn);
    this.stopBtn.hidden = true;
    this.pauseBtn.hidden = true;
    this.boardBtn = h('button', { type: 'button', id: 'simBoardBtn', class: 'sim-board-chip', title: 'Choose the simulated board', 'aria-haspopup': 'menu' },
      icon('chip', 15), h('span', { id: 'simBoardLabel' }, 'Arduino Uno'), icon('chevron', 13));
    this.addBtn = h('button', { type: 'button', id: 'simAddBtn', class: 'sim-tb-btn labeled', title: 'Add a part (A)' }, icon('plus', 16), h('span', {}, 'Add part'));
    this.examplesBtn = h('button', { type: 'button', id: 'simExamplesBtn', class: 'sim-tb-btn labeled', title: 'Open an example project' }, icon('book', 15), h('span', {}, 'Examples'));
    this.aiBtn = btn('simAiBtn', 'sparkle', 'Build the circuit from your code with AI');
    this.agentBtn = btn('simAgentBtn', 'agent', 'AI agent: build, simulate, check and fix');
    this.undoBtn = btn('simUndoBtn', 'undo', `Undo (${mod}Z)`);
    this.redoBtn = btn('simRedoBtn', 'redo', `Redo (${mod}⇧Z)`);
    this.menuBtn = btn('simMenuBtn', 'more', 'More');

    const toolbar = h('div', { class: 'sim-toolbar', role: 'toolbar', 'aria-label': 'Simulator' },
      h('div', { class: 'sim-tb-group' }, this.playBtn, this.debugBtn, this.pauseBtn, this.stopBtn),
      this.debugGroup,
      h('span', { class: 'sim-tb-sep' }),
      this.boardBtn,
      h('span', { class: 'sim-tb-sep' }),
      this.addBtn, this.examplesBtn, this.aiBtn, this.agentBtn,
      h('span', { class: 'sim-tb-sep' }),
      this.undoBtn, this.redoBtn, this.menuBtn);

    this.timeLabel = h('span', { id: 'simTimeLabel', class: 'mono' }, '00:00.000');
    this.speedLabel = h('span', { id: 'simSpeedLabel', class: 'mono' }, '0%');
    this.muteBtn = h('button', { type: 'button', class: 'sim-icon-btn', title: 'Mute buzzers' });
    const renderMute = () => {
      this.muteBtn.innerHTML = iconSvg(isMuted() ? 'mute' : 'sound', 15);
      this.muteBtn.title = isMuted() ? 'Unmute buzzers' : 'Mute buzzers';
      this.muteBtn.setAttribute('aria-pressed', isMuted() ? 'true' : 'false');
    };
    renderMute();
    onMuteChange(renderMute);
    this.muteBtn.addEventListener('click', () => setMuted(!isMuted()));
    this.stats = h('div', { class: 'sim-hud', id: 'simStats', hidden: true },
      h('span', { class: 'sim-live-dot' }),
      h('span', { class: 'sim-hud-item', title: 'Simulated time' }, icon('clock', 13), this.timeLabel),
      h('span', { class: 'sim-hud-item', title: 'Speed compared with real time' }, icon('gauge', 13), this.speedLabel),
      this.muteBtn);

    this.zoomLabel = h('button', { type: 'button', class: 'sim-zoom-label', title: 'Fit the circuit (0)' }, '100%');
    const zoomOut = h('button', { type: 'button', class: 'sim-icon-btn', title: 'Zoom out (−)', 'aria-label': 'Zoom out' }, icon('minus', 14));
    const zoomIn = h('button', { type: 'button', class: 'sim-icon-btn', title: 'Zoom in (+)', 'aria-label': 'Zoom in' }, icon('plus', 14));
    const fit = h('button', { type: 'button', class: 'sim-icon-btn', title: 'Fit the circuit (0)', 'aria-label': 'Fit the circuit' }, icon('fit', 14));
    const zoom = h('div', { class: 'sim-zoom' }, zoomOut, this.zoomLabel, zoomIn, fit);

    this.notice = h('div', { class: 'sim-notice', hidden: true, role: 'status' });
    this.toasts = h('div', { class: 'sim-toasts', 'aria-live': 'polite' });
    this.empty = h('div', { class: 'sim-empty', hidden: true });
    // A keyboard-driven widget (arrows move, Delete removes, R rotates).
    this.wrap = h('div', { class: 'sim-canvas-wrap', id: 'simCanvasWrap', tabindex: '0', role: 'application', 'aria-roledescription': 'circuit canvas', 'aria-label': 'Circuit canvas: [ and ] select parts, arrow keys move them, R rotates, Delete removes, A adds a part' });
    this.announcer = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    this.stage = h('div', { class: 'sim-stage', id: 'simStage' }, this.wrap, toolbar, this.stats, zoom, this.notice, this.empty, this.toasts, this.announcer);

    // Bottom pane: serial monitor, logic analyzer, circuit checks.
    this.serialOut = h('div', { id: 'simSerialOut', class: 'sim-serial-out', role: 'log', 'aria-label': 'Simulated serial output', tabindex: '0' });
    this.serialInput = h('input', { type: 'text', id: 'simSerialInput', placeholder: 'Send to the board…', 'aria-label': 'Send to the board', autocomplete: 'off', spellcheck: 'false' });
    this.lineEnding = h('select', { class: 'sim-select small', title: 'Line ending', 'aria-label': 'Line ending' },
      h('option', { value: 'newline' }, 'Newline'), h('option', { value: 'none' }, 'No line ending'), h('option', { value: 'cr' }, 'Carriage return'), h('option', { value: 'both' }, 'Both NL & CR'));
    try { this.lineEnding.value = localStorage.getItem('impulse-sim-line-ending') || 'newline'; } catch { /* default */ }
    this.lineEnding.addEventListener('change', () => { try { localStorage.setItem('impulse-sim-line-ending', this.lineEnding.value); } catch { /* ignore */ } });
    const clearBtn = h('button', { type: 'button', class: 'sim-serial-btn', id: 'simSerialClear', title: 'Clear the output', 'aria-label': 'Clear the output' }, icon('trash', 14));
    this.inputRow = h('div', { class: 'sim-serial-inputrow' }, this.serialInput, this.lineEnding, clearBtn);
    this.logicPane = h('div', { id: 'simLogicPane', class: 'sim-logic-pane', hidden: true });
    this.checksPane = h('div', { id: 'simChecksPane', class: 'sim-checks-pane', hidden: true });
    this.debugPaneEl = h('div', { id: 'simDebugPane', class: 'sim-debug-pane', hidden: true });
    const tab = (pane, label, active = false) => h('button', { type: 'button', class: `sim-pane-tab${active ? ' active' : ''}`, dataset: { pane }, role: 'tab' }, label);
    this.checksTab = tab('checks', 'Circuit check');
    const tabs = h('div', { class: 'sim-pane-tabs', role: 'tablist' }, tab('serial', 'Serial', true), tab('logic', 'Logic analyzer'), this.checksTab, tab('debug', 'Debug'));
    this.pane = h('div', { class: 'sim-serial-pane', id: 'simSerialPane' }, tabs, this.serialOut, this.logicPane, this.checksPane, this.debugPaneEl, this.inputRow);

    panel.append(this.stage, this.pane);

    // Canvas
    this.canvas = new CircuitCanvas(this.wrap, {
      isInteractive: (part) => this.running && !!partDef(part.type)?.interactive,
    });
    this.canvas.onChange = (kind) => this._onCanvasChange(kind);
    this.canvas.onSelect = (sel) => {
      this.inspector.show(sel);
      this._updateEmpty();
      this._revealSelection(sel);
      this._announceSelection(sel);
    };
    this.canvas.onPartPointerDown = (part) => this._partPress(part);
    this.canvas.onPartPointerUp = (part) => this._partRelease(part);
    this.canvas.onPartDoubleClick = (part) => this.canvas.select([part]);
    this.canvas.onContextMenu = (target, e) => this._contextMenu(target, e);
    this.canvas.onPinHover = (part, pin) => this._pinHoverText(part, pin);
    this.canvas.onZoom = (s) => { this.zoomLabel.textContent = `${Math.round(s * 100)}%`; };
    this.wrap.addEventListener('pointerdown', () => this.wrap.focus({ preventScroll: true }));
    window.addEventListener('pointerdown', () => { this._pointerHeld = true; }, true);
    window.addEventListener('pointerup', () => { this._pointerHeld = false; }, true);

    this.picker = new PartPicker(this.stage, {
      onAdd: (type, at) => this.addPart(type, at),
      onAskAi: () => this.buildCircuitFromCode(),
      onRequestPart: async (query) => {
        const res = await window.electronAPI?.problem?.requestPart?.(query).catch(e => ({ success: false, error: e.message }));
        if (res?.success) this.toast(`A part request for “${query}” is open in your browser. Submit it there and it goes on the list.`, 'success');
        else this.toast(`Could not open the part request: ${res?.error || 'unknown error'}`, 'error');
      },
      canDropAt: (x, y) => {
        const r = this.wrap.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      },
    });
    this.inspector = new Inspector(this.stage, {
      canvas: this.canvas,
      isRunning: () => this.running,
      getStatus: (part) => this.engine.behaviorOf(part.id)?.status?.() ?? null,
      onAttr: (part, key, value) => this._setAttr(part, key, value),
      onControl: (part, key, value) => this._setControl(part, key, value),
      onAction: (name) => this._selectionAction(name),
      connectionsOf: (part, pin) => this._connectionsOf(part, pin),
      libraries: () => this._installedLibraries(),
      installLibrary: (name) => this._installLibrary(name),
    });
    this.gallery = new ExamplesGallery({ onOpen: (ex) => this.openExample(ex) });
    this.analyzer = new LogicAnalyzer(this.logicPane);
    this.debugPane = new DebugPane(this.debugPaneEl, {
      onOpenLocation: (file, line) => window.impulse?.revealLine?.(file, line),
      onRemoveBreakpoint: (file, line) => this._removeBreakpoint(file, line),
      onSelectFrame: (index) => this._selectFrame(index),
    });

    // Toolbar
    this.playBtn.addEventListener('click', () => (this.running ? this.restart() : this.run()));
    this.stopBtn.addEventListener('click', () => this.stop());
    this.pauseBtn.addEventListener('click', () => this.togglePause());
    this.debugBtn.addEventListener('click', () => this.debugStart());
    this.continueBtn.addEventListener('click', () => this.debugAction('continue'));
    this.stepOverBtn.addEventListener('click', () => this.debugAction('stepOver'));
    this.stepIntoBtn.addEventListener('click', () => this.debugAction('stepInto'));
    this.stepOutBtn.addEventListener('click', () => this.debugAction('stepOut'));
    this.boardBtn.addEventListener('click', (e) => this._boardMenu(e));
    this.addBtn.addEventListener('click', () => this.picker.toggle());
    this.examplesBtn.addEventListener('click', () => this.gallery.open());
    this.aiBtn.addEventListener('click', () => this.buildCircuitFromCode());
    this.agentBtn.addEventListener('click', () => this.runAgent());
    this.undoBtn.addEventListener('click', () => this.undo());
    this.redoBtn.addEventListener('click', () => this.redo());
    this.menuBtn.addEventListener('click', (e) => this._moreMenu(e));
    zoomIn.addEventListener('click', () => this.canvas.zoomBy(1.2));
    zoomOut.addEventListener('click', () => this.canvas.zoomBy(1 / 1.2));
    fit.addEventListener('click', () => this.fit());
    this.zoomLabel.addEventListener('click', () => this.fit());

    // Bottom pane
    tabs.querySelectorAll('.sim-pane-tab').forEach(t => t.addEventListener('click', () => this._showPane(t.dataset.pane)));
    this.serialInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter') return;
      if (!this.running) { this.toast('Start the simulation to send serial data.'); return; }
      const text = this.serialInput.value + LINE_ENDINGS[this.lineEnding.value];
      this.serialInput.value = '';
      this.runner.serialWrite(text);
      this._systemLine(`→ ${text.replace(/\r?\n$/, '').replace(/\r/g, '')}`, 'sent');
      this._blink('ledRX');
    });
    clearBtn.addEventListener('click', () => this._clearSerial());

    document.addEventListener('pointerdown', (e) => {
      if (this.picker.open && !this.picker.el.contains(e.target) && !this.addBtn.contains(e.target)) this.picker.toggle(false);
    });

    this._updateHistoryButtons();
  }

  _showPane(name) {
    this.pane.querySelectorAll('.sim-pane-tab').forEach(t => t.classList.toggle('active', t.dataset.pane === name));
    this.serialOut.hidden = name !== 'serial';
    this.inputRow.hidden = name !== 'serial';
    this.logicPane.hidden = name !== 'logic';
    this.checksPane.hidden = name !== 'checks';
    this.debugPaneEl.hidden = name !== 'debug';
    this.pane.classList.toggle('logic', name === 'logic');
    if (name === 'debug' && !this.debug) this.debugPane.idle(this._breakpointList());
    if (name === 'logic') this.analyzer.render();
    if (name === 'checks') this._renderChecks();
  }

  // ── Board ────────────────────────────────────────────────────────────────

  get boardPart() {
    return this.canvas?.parts.find(p => partDef(p.type)?.board) || null;
  }

  get board() {
    const part = this.boardPart;
    return (part && boardByTag(partDef(part.type).tag)) || BOARDS.uno;
  }

  _updateBoardLabel() {
    const label = document.getElementById('simBoardLabel');
    if (label) label.textContent = this.boardPart ? this.board.label : 'No board';
    this.analyzer?.setBoard(this.board.id);
  }

  _boardMenu(e) {
    const items = BOARD_ORDER.map((id) => {
      const b = BOARDS[id];
      return { label: b.label, detail: b.description, checked: this.boardPart && this.board.id === id, action: () => this.setBoard(id) };
    });
    this._menu(e.currentTarget, items);
  }

  /** Swap the board on the canvas, keeping wires where the new board has the same pins. */
  setBoard(boardId, { quiet = false } = {}) {
    const target = BOARDS[boardId];
    if (!target) return;
    const old = this.boardPart;
    if (old && old.type === target.tag) return;
    if (this.running) this.stop();
    const model = this.canvas.model();
    const types = Object.fromEntries(model.parts.map(p => [p.id, p.type]));
    let wires = model.wires;
    let report = null;
    if (old) {
      const remap = remapBoardWires(model.wires, old.id, old.type, target.tag, types);
      wires = remap.wires;
      report = remap;
      const idx = model.parts.findIndex(p => p.id === old.id);
      // A board still named after its type ("uno") takes the new one's name ("pico").
      const id = BOARDS[old.id] && !model.parts.some(p => p.id === target.id) ? target.id : old.id;
      if (id !== old.id) {
        const rename = (end) => (end.partId === old.id ? { ...end, partId: id } : end);
        wires = wires.map(w => ({ ...w, from: rename(w.from), to: rename(w.to) }));
      }
      model.parts[idx] = { ...model.parts[idx], id, type: target.tag, attrs: {}, ...this._boardSpot(model.parts[idx], old.type, target.tag, model.parts) };
    } else {
      model.parts.unshift({ id: target.id, type: target.tag, x: 0, y: 160, rotate: 0, attrs: {} });
    }
    this._applyModel({ parts: model.parts, wires }, { record: true });
    if (!quiet) {
      const bits = [`Switched to ${target.label}.`];
      const moved = [...new Set(report?.moved || [])];
      if (moved.length) bits.push(`Moved wires to the matching pins (${moved.slice(0, 4).join(', ')}${moved.length > 4 ? ` and ${moved.length - 4} more` : ''}).`);
      if (report?.dropped.length) bits.push(`Removed ${report.dropped.length} wire${report.dropped.length === 1 ? '' : 's'} on pins the ${target.short} doesn't have.`);
      this.toast(bits.join(' '), report?.dropped.length ? 'warn' : 'info');
    }
    this._checkToolbarBoard();
  }

  /** Where to put a swapped board so a bigger one doesn't land on other parts. */
  _boardSpot(oldPart, oldType, newType, parts) {
    const sizeOf = (type) => PARTS[type]?.size || { w: 120, h: 120 };
    const oldSize = sizeOf(oldType);
    const newSize = sizeOf(newType);
    const others = parts.filter(p => p.id !== oldPart.id).map(p => ({ x: p.x, y: p.y, ...sizeOf(p.type) }));
    const hits = (x, y) => others.some(o => x < o.x + o.w && x + newSize.w > o.x && y < o.y + o.h && y + newSize.h > o.y);
    const dw = newSize.w - oldSize.w;
    const dh = newSize.h - oldSize.h;
    const candidates = [
      [oldPart.x, oldPart.y],
      [oldPart.x - dw, oldPart.y],
      [oldPart.x, oldPart.y - dh],
      [oldPart.x - dw, oldPart.y - dh],
      [oldPart.x, oldPart.y + oldSize.h + 20],
    ];
    for (let step = 1; step <= 12; step++) candidates.push([oldPart.x - dw - step * 48, oldPart.y], [oldPart.x, oldPart.y + oldSize.h + step * 48]);
    const spot = candidates.find(([x, y]) => !hits(x, y)) || candidates[0];
    return { x: Math.round(spot[0] / 4.8) * 4.8, y: Math.round(spot[1] / 4.8) * 4.8 };
  }

  /**
   * ESP32 boards: ask the installed core which chip a board is built on (a
   * board newer than Impulse's table), then check the toolbar board again.
   */
  _learnBoardChip(fqbn) {
    if (!/^(esp32|arduino):esp32:/.test(fqbn)) return;
    const base = fqbn.split(':').slice(0, 3).join(':');
    this._learnedChips ??= new Set();
    if (this._learnedChips.has(base)) return;
    this._learnedChips.add(base);
    window.electronAPI?.esp32sim?.chipOf(base).then((mcu) => {
      if (!mcu) return;
      const before = boardForFqbn(fqbn)?.id;
      registerBoardChip(base, mcu);
      if (boardForFqbn(fqbn)?.id !== before && window.state?.selectedBoard === fqbn) this._checkToolbarBoard();
    }).catch(() => {});
  }

  /** Hint when the upload board (toolbar) differs from the simulated one. */
  _checkToolbarBoard() {
    const pio = window.state?.pio;
    if (pio && this.sketchPath && diagramFolder(this.sketchPath) === pio.root) {
      // A PlatformIO project: its environment names the board, not the board menu.
      const env = pio.envs?.find(e => e.name === pio.env);
      this.notice.hidden = true;
      if (env?.simBoard && env.simBoard !== this.board.id && this.canvas.parts.length <= 1) this.setBoard(env.simBoard, { quiet: true });
      return;
    }
    const fqbn = window.state?.selectedBoard;
    if (!fqbn || this._noticeDismissed === fqbn) { this.notice.hidden = true; return; }
    this._learnBoardChip(fqbn);
    const target = boardForFqbn(fqbn);
    const name = window.state?.boards?.find?.(b => b.fqbn === fqbn)?.name || fqbn;
    this.notice.innerHTML = '';
    const dismiss = h('button', { type: 'button', class: 'sim-icon-btn', 'aria-label': 'Dismiss' }, icon('close', 13));
    dismiss.addEventListener('click', () => { this._noticeDismissed = fqbn; this.notice.hidden = true; });
    if (!target) {
      this.notice.append(icon('info', 15), h('span', {}, `${name} can't be simulated yet, so the simulator runs your sketch on the ${this.board.label}. It simulates ${simulatedBoardsText()}.`), dismiss);
      this.notice.hidden = false;
      return;
    }
    if (target.id === this.board.id) {
      const note = simulationTarget(fqbn)?.note;
      if (!note) { this.notice.hidden = true; return; }
      this.notice.append(icon('chip', 15), h('span', {}, `${name} ${note}.`), dismiss);
      this.notice.hidden = false;
      return;
    }
    const onlyBoard = this.canvas.parts.length <= 1;
    if (onlyBoard) {
      this.setBoard(target.id, { quiet: true });
      this.notice.hidden = true;
      return;
    }
    const sw = h('button', { type: 'button', class: 'sim-btn small' }, `Simulate on ${target.short}`);
    sw.addEventListener('click', () => this.setBoard(target.id));
    this.notice.append(icon('chip', 15), h('span', {}, `Your upload board is ${name}.`), sw, dismiss);
    this.notice.hidden = false;
  }

  // ── Parts and selection ──────────────────────────────────────────────────

  addPart(type, at = null) {
    const def = partDef(type);
    if (!def) return null;
    if (def.board) {
      this.setBoard(def.board);
      return this.boardPart;
    }
    const size = def.size || { w: 80, h: 80 };
    let pos;
    if (at) {
      const w = this.canvas.toWorld(at.clientX, at.clientY);
      pos = { x: Math.round((w.x - size.w / 2) / 4.8) * 4.8, y: Math.round((w.y - size.h / 2) / 4.8) * 4.8 };
    } else {
      pos = this.canvas.freeSpot(size.w, size.h);
    }
    const part = this.canvas.addPart(type, pos.x, pos.y);
    if (part) {
      this.canvas.select([part]);
      if (!at) this._ensureVisible(part);
    }
    return part;
  }

  /** Fit the circuit around the toolbar, inspector and empty-state card. */
  fit() {
    const insets = {};
    if (!this.empty.hidden) insets.bottom = this.empty.offsetHeight + 76;
    if (!this.inspector.el.hidden) insets.right = this.inspector.el.offsetWidth + 24;
    this._needsFit = !this.canvas.zoomFit(insets);
  }

  /** The simulator view became visible. */
  onShow() {
    this._updateEmpty();
    if (this._needsFit) requestAnimationFrame(() => this.fit());
  }

  _ensureVisible(part) {
    requestAnimationFrame(() => {
      const r = part.el.getBoundingClientRect();
      const s = this.wrap.getBoundingClientRect();
      if (r.right > s.right || r.bottom > s.bottom || r.left < s.left || r.top < s.top) this.fit();
    });
  }

  _setAttr(part, key, value) {
    this.canvas.setPartAttr(part.id, key, value);
    if (['digits', 'pins', 'columns', 'pixels', 'rows', 'cols', 'common', 'size', 'model', 'type'].includes(key)) this.inspector.render();
    if (this.running) this.toast('Restart the simulation to apply this change.', 'info', 'restart-hint');
  }

  _setControl(part, key, value) {
    if (value !== true) {
      part.attrs[key] = String(value);
      if (key === 'value' || key === 'label') this.canvas.setPartAttr(part.id, key, value);
    }
    this.engine.behaviorOf(part.id)?.control(key, value);
    this._scheduleSave();
  }

  _selectionAction(name) {
    if (name === 'rotate') this.canvas.rotateSelection(90);
    else if (name === 'delete') this.canvas.deleteSelected();
    else if (name === 'duplicate') this.duplicate();
  }

  duplicate() {
    const clip = this._copySelection();
    if (clip) this._paste(clip, 24);
  }

  _copySelection() {
    const parts = this.canvas.selectedParts.filter(p => !partDef(p.type)?.board);
    if (!parts.length) return null;
    const ids = new Set(parts.map(p => p.id));
    return {
      parts: parts.map(p => ({ id: p.id, type: p.type, x: p.x, y: p.y, rotate: p.rotate, attrs: { ...p.attrs } })),
      wires: this.canvas.wires.filter(w => ids.has(w.from.partId) && ids.has(w.to.partId))
        .map(w => ({ from: { ...w.from }, to: { ...w.to }, color: w.color, points: w.points.map(pt => ({ ...pt })) })),
    };
  }

  _paste(clip, offset = 24) {
    const map = new Map();
    const added = [];
    for (const p of clip.parts) {
      const part = this.canvas.addPart(p.type, p.x + offset, p.y + offset, p.attrs, null, p.rotate);
      if (part) { map.set(p.id, part.id); added.push(part); }
    }
    requestAnimationFrame(() => {
      for (const w of clip.wires) {
        const from = { partId: map.get(w.from.partId), pin: w.from.pin };
        const to = { partId: map.get(w.to.partId), pin: w.to.pin };
        if (from.partId && to.partId) this.canvas.addWire(from, to, w.color, null, w.points.map(pt => ({ x: pt.x + offset, y: pt.y + offset })));
      }
      this.canvas.select(added);
    });
  }

  _connectionsOf(part, pin) {
    const node = `${part.id}:${pin}`;
    const out = [];
    for (const w of this.canvas.wires) {
      if (`${w.from.partId}:${w.from.pin}` === node) out.push(this._nodeLabel(w.to));
      else if (`${w.to.partId}:${w.to.pin}` === node) out.push(this._nodeLabel(w.from));
    }
    for (const [a, b] of this.canvas.overlapLinks) {
      if (a === node) out.push(`breadboard ${b.split(':')[1]}`);
    }
    return out;
  }

  _nodeLabel({ partId, pin }) {
    const part = this.canvas.getPart(partId);
    if (part && partDef(part.type)?.board) {
      const num = boardPinNumber(this.board, pin);
      return num !== null ? `${this.board.short} ${pinLabel(this.board, num)}` : `${this.board.short} ${pin}`;
    }
    return `${partId}:${pin}`;
  }

  _pinHoverText(part, pin) {
    if (!partDef(part.type)?.board) return null;
    const num = boardPinNumber(this.board, pin);
    if (num === null) {
      const power = boardPowerPin(pin);
      if (!power) return pin.startsWith('AREF') ? 'Analog reference voltage' : null;
      if (power.kind === 'gnd') return 'Ground (0 V)';
      if (power.kind === 'reset') return 'RESET — pull LOW to restart the board';
      return `${power.volts} V supply`;
    }
    const bits = [];
    if (this.board.pwmSet.has(num)) bits.push('PWM');
    if (this.board.byPin.get(num)?.analog) bits.push('analog in');
    if (num === this.board.i2c.sda) bits.push('I²C SDA');
    if (num === this.board.i2c.scl) bits.push('I²C SCL');
    for (const [role, n] of Object.entries(this.board.spi)) if (n === num) bits.push(`SPI ${role.toUpperCase()}`);
    if (this.board.interrupts.includes(num)) bits.push(`interrupt ${this.board.interrupts.indexOf(num)}`);
    if (this.running) bits.push(this.runner.isOutput(num) ? (this.runner.getPinState(num) ? 'output HIGH' : 'output LOW') : 'input');
    return `${pinLabel(this.board, num)}${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
  }

  async _installedLibraries() {
    // Short-lived: libraries can also be installed from the Library Manager.
    if (this._libCache && Date.now() - this._libCacheAt < 20000) return this._libCache;
    const res = await window.electronAPI?.lib?.list?.().catch(() => null);
    if (!res?.success) return new Set(); // not cached: retry on the next call
    const list = res.data?.installed_libraries || [];
    const names = new Set();
    for (const l of Array.isArray(list) ? list : []) {
      const name = l?.library?.name || l?.name;
      if (name) names.add(String(name).toLowerCase());
    }
    this._libCache = names;
    this._libCacheAt = Date.now();
    return names;
  }

  async _installLibrary(name) {
    const res = await window.electronAPI?.lib?.install?.(name).catch(e => ({ success: false, error: e.message }));
    const ok = !!res && res.success !== false;
    this._libCache = null;
    this.toast(ok ? `Installed ${name}.` : `Could not install ${name}: ${res?.error || 'unknown error'}`, ok ? 'success' : 'error');
    return ok;
  }

  // ── Interaction while running ────────────────────────────────────────────

  _partPress(part) {
    if (!this.running) return;
    this.engine.behaviorOf(part.id)?.press?.();
  }

  _partRelease(part) {
    if (!this.running) return;
    this.engine.behaviorOf(part.id)?.release?.();
  }

  _bindGlobalKeys() {
    const isTyping = () => {
      const el = document.activeElement;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable || !!el.closest?.('.CodeMirror'));
    };
    const keyMatches = (attr, e) => {
      if (!attr) return false;
      const k = String(attr);
      if (/^space$/i.test(k)) return e.key === ' ';
      return k.length === 1 ? e.key.toLowerCase() === k.toLowerCase() : e.key.toLowerCase() === k.toLowerCase();
    };
    document.addEventListener('keydown', (e) => {
      if (!this.visible || isTyping() || document.querySelector('.sim-overlay, .impulse-dialog-overlay')) return;
      // Keyboard-bound buttons and sensors while running.
      if (this.running && !e.metaKey && !e.ctrlKey) {
        const bound = this.canvas.parts.filter(p => keyMatches(p.attrs.key, e));
        if (bound.length) {
          e.preventDefault();
          if (!e.repeat) bound.forEach(p => this.engine.behaviorOf(p.id)?.press?.());
          return;
        }
      }
      if (!this.stageFocused) return;
      if (this.canvas.handleKey(e)) { e.preventDefault(); return; }
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && e.key.toLowerCase() === 'd') { e.preventDefault(); this.duplicate(); return; }
      if (!cmd && (e.key === '+' || e.key === '=')) { this.canvas.zoomBy(1.2); e.preventDefault(); }
      else if (!cmd && e.key === '-') { this.canvas.zoomBy(1 / 1.2); e.preventDefault(); }
      else if (!cmd && e.key === '0') { this.fit(); e.preventDefault(); }
      else if (!cmd && (e.key === 'a' || e.key === 'A')) { this.picker.toggle(true); e.preventDefault(); }
    });
    document.addEventListener('keyup', (e) => {
      if (!this.running) return;
      for (const p of this.canvas.parts) if (keyMatches(p.attrs.key, e)) this.engine.behaviorOf(p.id)?.release?.();
    });
  }

  /** Tell screen readers what is selected (the inspector shows its controls). */
  _announceSelection(sel) {
    const items = [...sel];
    const parts = items.filter(i => i.el);
    let text = '';
    if (parts.length === 1 && items.length === 1) {
      const p = parts[0];
      text = `${partDef(p.type)?.label || p.type} ${p.id} selected. Its settings are in the inspector.`;
    } else if (items.length === 1) {
      text = 'Wire selected.';
    } else if (items.length > 1) {
      text = `${items.length} items selected.`;
    }
    if (text) this.announcer.textContent = text;
  }

  /** Keep a newly selected part from hiding behind the inspector (after any drag ends). */
  _revealSelection(sel) {
    const items = [...sel];
    const part = items.length === 1 && items[0].el ? items[0] : null;
    if (!part) return;
    const reveal = () => {
      if (this.canvas.selection.has(part) && !this.inspector.el.hidden) this.canvas.reveal(part, this.inspector.el.getBoundingClientRect());
    };
    if (this._pointerHeld) window.addEventListener('pointerup', () => requestAnimationFrame(reveal), { once: true });
    else requestAnimationFrame(reveal);
  }

  get visible() {
    return !!this.stage && this.stage.offsetParent !== null;
  }

  get stageFocused() {
    const el = document.activeElement;
    return !!el && (el === this.wrap || this.stage.contains(el)) && !this.picker.el.contains(el);
  }

  /**
   * Edit-menu commands while the canvas has focus (the app menu owns the
   * accelerators). Returns true when the simulator handled the command.
   */
  handleEditAction(kind) {
    if (!this.visible || !this.stageFocused) return false;
    switch (kind) {
      case 'undo': this.undo(); return true;
      case 'redo': this.redo(); return true;
      case 'copy': this._clipboard = this._copySelection(); return true;
      case 'cut': this._clipboard = this._copySelection(); this.canvas.deleteSelected(); return true;
      case 'paste': if (this._clipboard) this._paste(this._clipboard); return true;
      case 'select-all': this.canvas.select(this.canvas.parts); return true;
      default: return false;
    }
  }

  // ── Menus ────────────────────────────────────────────────────────────────

  _menu(anchor, items, at = null) {
    document.querySelectorAll('.sim-popmenu').forEach(m => m.remove());
    const menu = h('div', { class: 'sim-popmenu', role: 'menu' });
    for (const item of items) {
      if (item === '-') { menu.append(h('div', { class: 'sim-popmenu-sep' })); continue; }
      const row = h('button', { type: 'button', class: `sim-popmenu-item${item.danger ? ' danger' : ''}${item.checked ? ' checked' : ''}`, role: 'menuitem', disabled: item.disabled },
        h('span', { class: 'sim-popmenu-check' }, item.checked ? icon('check', 13) : null),
        h('span', { class: 'sim-popmenu-text' }, h('span', {}, item.label), item.detail ? h('span', { class: 'sim-popmenu-detail' }, item.detail) : null),
        item.shortcut ? h('kbd', { class: 'sim-kbd' }, item.shortcut) : null);
      row.addEventListener('click', () => { menu.remove(); item.action(); });
      menu.append(row);
    }
    document.body.append(menu);
    const r = anchor ? anchor.getBoundingClientRect() : { left: at.x, bottom: at.y, right: at.x };
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const left = Math.min(r.left, window.innerWidth - mw - 8);
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, (anchor ? r.top : at.y) - mh - 6);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${top}px`;
    const close = (ev) => {
      if (menu.contains(ev.target)) return;
      menu.remove();
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', esc, true);
    };
    const esc = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close({ target: document.body }); } };
    setTimeout(() => {
      document.addEventListener('pointerdown', close, true);
      document.addEventListener('keydown', esc, true);
    }, 0);
    menu.querySelector('.sim-popmenu-item:not([disabled])')?.focus();
  }

  _moreMenu(e) {
    this._menu(e.currentTarget, [
      { label: 'Import diagram.json…', detail: 'Open a Wokwi or Impulse circuit', action: () => this.importDiagram() },
      { label: 'Export diagram.json…', action: () => this.exportDiagram() },
      '-',
      { label: 'Fit circuit to view', shortcut: '0', action: () => this.fit() },
      { label: 'Select all', shortcut: `${mod}A`, action: () => this.canvas.select(this.canvas.parts) },
      '-',
      { label: 'Clear circuit…', danger: true, action: () => this.clearCircuit() },
    ]);
  }

  _contextMenu(target, e) {
    const at = { x: e.clientX, y: e.clientY };
    if (target.part) {
      const isBoard = !!partDef(target.part.type)?.board;
      this._menu(null, [
        { label: 'Rotate', shortcut: 'R', action: () => this.canvas.rotateSelection(90) },
        { label: 'Duplicate', shortcut: `${mod}D`, disabled: isBoard, action: () => this.duplicate() },
        { label: 'Copy', shortcut: `${mod}C`, disabled: isBoard, action: () => { this._clipboard = this._copySelection(); } },
        '-',
        { label: 'Delete', shortcut: '⌫', danger: true, action: () => this.canvas.deleteSelected() },
      ], at);
    } else if (target.wire) {
      this._menu(null, [
        { label: 'Delete wire', shortcut: '⌫', danger: true, action: () => this.canvas.deleteSelected() },
      ], at);
    } else {
      this._menu(null, [
        { label: 'Add part…', shortcut: 'A', action: () => this.picker.toggle(true) },
        { label: 'Paste', shortcut: `${mod}V`, disabled: !this._clipboard, action: () => this._paste(this._clipboard) },
        '-',
        { label: 'Fit circuit to view', shortcut: '0', action: () => this.fit() },
      ], at);
    }
  }

  // ── Canvas changes, history, persistence ─────────────────────────────────

  _onCanvasChange(kind) {
    this._updateBoardLabel();
    this._updateEmpty();
    if (this.running && kind !== 'attr') {
      this.engine.setModel(this._engineModel());
    }
    if (this._loading) return;
    if (kind !== 'links' && kind !== 'load') this._recordHistory();
    if (kind !== 'load') {
      // A change from the canvas is the user's own work: the agent is told so.
      this._changedBy = 'user';
      this._changedAt = new Date().toISOString();
      this._scheduleSave();
    }
    window.dispatchEvent(new CustomEvent('impulse:circuit-changed'));
    clearTimeout(this._checkTimer);
    this._checkTimer = setTimeout(() => this._renderChecks(), 250);
  }

  _engineModel() {
    return { parts: this.canvas.parts, wires: this.canvas.wires, links: this.canvas.overlapLinks };
  }

  _snapshot() {
    return JSON.stringify(this.canvas.model(), (k, v) => (k === 'start' ? undefined : v));
  }

  _recordHistory() {
    clearTimeout(this._historyTimer);
    this._historyTimer = setTimeout(() => {
      const snap = this._snapshot();
      if (this._history[this._history.length - 1] === snap) return;
      this._history.push(snap);
      if (this._history.length > HISTORY_LIMIT) this._history.shift();
      this._future = [];
      this._updateHistoryButtons();
    }, 120);
  }

  _resetHistory() {
    clearTimeout(this._historyTimer);
    this._history = [this._snapshot()];
    this._future = [];
    this._updateHistoryButtons();
  }

  _updateHistoryButtons() {
    if (this.undoBtn) this.undoBtn.disabled = this._history.length <= 1;
    if (this.redoBtn) this.redoBtn.disabled = this._future.length === 0;
  }

  undo() {
    if (this._history.length <= 1) return;
    this._future.push(this._history.pop());
    this._restoreSnapshot(this._history[this._history.length - 1]);
  }

  redo() {
    if (!this._future.length) return;
    const snap = this._future.pop();
    this._history.push(snap);
    this._restoreSnapshot(snap);
  }

  async _restoreSnapshot(snap) {
    if (this.running) this.stop();
    this._loading = true;
    await this.canvas.load(JSON.parse(snap));
    this._loading = false;
    this._updateHistoryButtons();
    this._changedBy = 'user';
    this._changedAt = new Date().toISOString();
    this._scheduleSave();
    this._updateBoardLabel();
    this._renderChecks();
    window.dispatchEvent(new CustomEvent('impulse:circuit-changed'));
  }

  /**
   * Replace the canvas with a model (from a diagram, the AI, a board swap).
   * `by` says who made the circuit ('user', 'ai' or 'load' for a file).
   */
  async _applyModel(model, { record = true, fit = true, by = null } = {}) {
    if (this.running) this.stop();
    this._loading = true;
    await this.canvas.load(model, hintsToPoints);
    this._loading = false;
    this._updateBoardLabel();
    this._updateEmpty();
    if (fit) this.fit();
    if (by) {
      this._changedBy = by;
      this._changedAt = new Date().toISOString();
    }
    if (record) {
      this._recordHistory();
      this._scheduleSave();
    }
    this._renderChecks();
    window.dispatchEvent(new CustomEvent('impulse:circuit-changed'));
  }

  _diagram() {
    // `impulse` records who last changed the circuit, so a later chat knows it is the user's work.
    return { ...toDiagram(this.canvas.model(), { author: '' }), impulse: { changedBy: this._changedBy || 'user', updatedAt: this._changedAt || new Date().toISOString() } };
  }

  /**
   * The circuit as the AI agent reads it (published to the main process on
   * every change): one line per wired board pin, the parts, the wiring
   * check's warnings, and who changed it last.
   */
  circuitFacts() {
    const { hasCircuit, board, pins } = this.getWiring();
    const lines = Object.entries(pins).map(([num, list]) => `${pinLabel(this.board, Number(num))} → ${list.map(p => `${p.label}:${p.pin}`).join(', ')}`);
    let checks = [];
    try { checks = this._checks().filter(i => i.level !== 'info').map(i => ({ level: i.level, text: i.text })); } catch { checks = []; }
    const parts = this.canvas
      ? this.canvas.parts.filter(p => !partDef(p.type)?.board && partDef(p.type)?.category !== 'Breadboards').map(p => `${partDef(p.type)?.label || p.type} ${p.id}`)
      : [];
    return { hasCircuit, board, boardLabel: this.board?.label || board, parts, lines, checks, changedBy: this._changedBy || null, updatedAt: this._changedAt || null, sketchPath: this.sketchPath || null };
  }

  _scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._save(), 400);
  }

  async _save() {
    clearTimeout(this._saveTimer);
    // A fired timer's id is not a pending save: switching sketches must not rewrite a file nothing changed.
    this._saveTimer = null;
    if (!this.canvas) return;
    const json = JSON.stringify(this._diagram(), null, 2);
    if (this.sketchPath) {
      const res = await window.electronAPI?.file?.save(joinPath(diagramFolder(this.sketchPath), DIAGRAM_FILE), json).catch(e => ({ success: false, error: e.message }));
      if (res && !res.success && !this._saveErrorShown) {
        this._saveErrorShown = true;
        this.toast(`Couldn't save diagram.json next to the sketch: ${res.error}`, 'error');
      }
    } else {
      try { localStorage.setItem(SCRATCH_KEY, json); } catch { /* storage full */ }
    }
  }

  async _restore() {
    this._loading = true;
    let data = null;
    try { data = JSON.parse(localStorage.getItem(SCRATCH_KEY) || 'null'); } catch { data = null; }
    const model = data ? fromDiagram(data) : null;
    if (model?.parts?.length) {
      await this.canvas.load(model, hintsToPoints);
    } else {
      this.canvas.addPart('wokwi-arduino-uno', 0, 160);
      await new Promise(r => requestAnimationFrame(r));
    }
    this._loading = false;
    this._resetHistory();
    this._updateBoardLabel();
    this._updateEmpty();
    requestAnimationFrame(() => this.fit());

    window.addEventListener('impulse:sketch-changed', (e) => this.setSketch(e.detail?.sketch || null));
    window.addEventListener('impulse:board-changed', () => this._checkToolbarBoard());
    if (window.state?.currentSketch) this.setSketch(window.state.currentSketch);
    this._checkToolbarBoard();
  }

  /** The open sketch changed: load its diagram.json (or keep/adopt the scratch circuit). */
  async setSketch(sketchPath) {
    if (sketchPath === this.sketchPath) return;
    // Another file of the same sketch or project: same circuit.
    if (sketchPath && this.sketchPath && diagramFolder(sketchPath) === diagramFolder(this.sketchPath)) {
      this.sketchPath = sketchPath;
      return;
    }
    const previous = this.sketchPath;
    if (this._saveTimer) await this._save();
    if (this.running) this.stop();
    this.sketchPath = sketchPath;
    this._saveErrorShown = false;
    if (!sketchPath) return;

    const res = await window.electronAPI?.file?.read(joinPath(diagramFolder(sketchPath), DIAGRAM_FILE)).catch(() => null);
    if (res?.success) {
      let data = null;
      try { data = JSON.parse(res.content); } catch { data = null; }
      const model = data && fromDiagram(data);
      if (model && !model.errors.length) {
        // Who made this circuit, from the file (a user's circuit stays the user's in a later chat).
        const meta = data.impulse && typeof data.impulse === 'object' ? data.impulse : {};
        this._changedBy = ['user', 'ai'].includes(meta.changedBy) ? meta.changedBy : 'load';
        this._changedAt = typeof meta.updatedAt === 'string' ? meta.updatedAt : null;
        await this._applyModel(model, { record: false });
        this._resetHistory();
        if (model.unsupported.length) this.toast(`This circuit uses parts Impulse doesn't simulate yet: ${model.unsupported.join(', ')}. They were left out.`, 'warn');
        this._checkToolbarBoard();
        return;
      }
      this.toast('diagram.json next to this sketch could not be read, so the circuit starts fresh.', 'warn');
    }
    if (previous === null && this.canvas.parts.length > 1) {
      // A circuit built before the sketch was saved now belongs to it.
      this._scheduleSave();
      return;
    }
    const board = boardForFqbn(window.state?.selectedBoard) || BOARDS.uno;
    await this._applyModel({ parts: [{ id: board.id, type: board.tag, x: 0, y: 160, rotate: 0, attrs: {} }], wires: [] }, { record: false });
    this._resetHistory();
    this._checkToolbarBoard();
  }

  async importDiagram() {
    const res = await window.electronAPI?.dialog?.openDiagram?.();
    if (!res?.success) {
      if (res && !res.canceled) this.toast(res.error || 'Could not open the file.', 'error');
      return;
    }
    let data;
    try { data = JSON.parse(res.content); } catch { this.toast('That file is not valid JSON.', 'error'); return; }
    const model = fromDiagram(data);
    if (model.errors.length) { this.toast(model.errors[0], 'error'); return; }
    if (!model.parts.some(p => partDef(p.type)?.board)) {
      model.parts.unshift({ id: 'uno', type: 'wokwi-arduino-uno', x: -320, y: 0, rotate: 0, attrs: {} });
    }
    await this._applyModel(model);
    const msg = [`Imported ${model.parts.length} parts and ${model.wires.length} wires.`];
    if (model.unsupported.length) msg.push(`Not simulated yet: ${model.unsupported.join(', ')}.`);
    this.toast(msg.join(' '), model.unsupported.length ? 'warn' : 'success');
  }

  async exportDiagram() {
    const json = JSON.stringify(this._diagram(), null, 2);
    const name = this.sketchPath ? `${diagramFolder(this.sketchPath).split(/[/\\]/).pop()}-diagram.json` : 'diagram.json';
    const res = await window.electronAPI?.dialog?.saveDiagram?.(json, name);
    if (res?.success) this.toast(`Saved ${res.filePath.split(/[/\\]/).pop()}.`, 'success');
    else if (res && !res.canceled) this.toast(res.error || 'Could not save the file.', 'error');
  }

  async clearCircuit() {
    if (!(await confirmDialog('Clear circuit', 'Remove every part and wire except the board? You can undo this.', { confirmLabel: 'Clear', danger: true }))) return;
    const board = this.boardPart;
    await this._applyModel({ parts: board ? [{ id: board.id, type: board.type, x: board.x, y: board.y, rotate: 0, attrs: {} }] : [], wires: [] });
  }

  async openExample(example) {
    const diagram = JSON.stringify(exampleDiagram(example), null, 2);
    const res = await window.electronAPI?.sketch?.createExample?.({ name: example.id, code: example.code, diagram }).catch(e => ({ success: false, error: e.message }));
    if (!res?.success) {
      this.toast(`Could not create the example: ${res?.error || 'unknown error'}`, 'error');
      return;
    }
    await window.impulse?.openSketch?.(res.folderPath, res.filePath);
    // With no board chosen yet, the example's own board is the obvious one (Verify works right away).
    if (!window.impulse?.board?.current?.()?.fqbn && BOARDS[example.board]?.fqbn) window.impulse.board.choose?.(BOARDS[example.board].fqbn);
    if (window.impulse?.showSimulator) window.impulse.showSimulator();
    const missing = [];
    if (example.libraries?.length) {
      const installed = await this._installedLibraries();
      for (const lib of example.libraries) if (!installed.has(lib.toLowerCase())) missing.push(lib);
    }
    this.toast(`Opened “${example.title}”. Press ▶ to run it.${missing.length ? ` It needs ${missing.join(', ')}, which installs automatically when you run it.` : ''}`, 'success');
  }

  // ── Empty state and checks ───────────────────────────────────────────────

  _updateEmpty() {
    if (!this.empty || !this.canvas) return;
    const only = this.canvas.parts.length <= 1 && !this.running;
    if (!only) { this.empty.hidden = true; return; }
    if (!this.empty.childElementCount) {
      const quick = ['blink', 'traffic-light', 'distance-meter', 'neopixel', 'keypad-lock'].map(id => EXAMPLES.find(e => e.id === id)).filter(Boolean);
      const chips = quick.map((ex) => {
        const b = h('button', { type: 'button', class: 'sim-empty-example', title: ex.summary }, ex.title);
        b.addEventListener('click', () => this.openExample(ex));
        return b;
      });
      const add = h('button', { type: 'button', class: 'sim-btn' }, icon('plus', 14), 'Add a part');
      add.addEventListener('click', () => this.picker.toggle(true));
      const all = h('button', { type: 'button', class: 'sim-btn ghost' }, icon('book', 14), `Browse ${EXAMPLES.length} examples`);
      all.addEventListener('click', () => this.gallery.open());
      const ai = h('button', { type: 'button', class: 'sim-btn ghost' }, icon('sparkle', 14), 'Build from my code');
      ai.addEventListener('click', () => this.buildCircuitFromCode());
      this.empty.append(
        h('div', { class: 'sim-empty-card' },
          h('h2', {}, 'Build a circuit'),
          h('p', {}, 'Add parts, then click one pin and another to wire them. Press ▶ to run your sketch on the simulated board.'),
          h('div', { class: 'sim-empty-actions' }, add, all, ai),
          h('div', { class: 'sim-empty-try' }, h('span', { class: 'sim-empty-label' }, 'Try:'), chips)));
    }
    this.empty.hidden = false;
  }

  _checks() {
    return circuitChecks(this._engineModel(), { shorts: this._shorts });
  }

  _renderChecks() {
    if (!this.checksPane || !this.canvas) return;
    let issues = [];
    try { issues = this._checks(); } catch { issues = []; }
    const errors = issues.filter(i => i.level !== 'info').length;
    this.checksTab.textContent = 'Circuit check';
    if (errors) this.checksTab.append(h('span', { class: 'sim-badge' }, String(errors)));
    if (this.checksPane.hidden) return;
    this.checksPane.innerHTML = '';
    if (!issues.length) {
      this.checksPane.append(h('div', { class: 'sim-check ok' }, icon('check', 15), h('span', {}, 'No wiring problems found.')));
      return;
    }
    for (const issue of issues) {
      const row = h('button', { type: 'button', class: `sim-check ${issue.level}` }, icon(issue.level === 'info' ? 'info' : 'warning', 15), h('span', {}, issue.text));
      if (issue.part) row.addEventListener('click', () => { const p = this.canvas.getPart(issue.part); if (p) this.canvas.select([p]); });
      this.checksPane.append(row);
    }
  }

  // ── Runner ───────────────────────────────────────────────────────────────

  _bindRunner() {
    this.runner.onSerial = (ch, port) => this._appendSerial(ch, port);
    this.runner.onError = (msg) => {
      this._systemLine(`Simulator: ${msg}`, 'error');
      this.stop();
    };
    this.runner.onPinChange = (pin, high, cycles) => {
      this._pinActivity[pin] = (this._pinActivity[pin] || 0) + 1;
      this.analyzer?.push(pin, high, cycles / F_CPU);
    };
    this.runner.onReset = () => this.engine.restartParts();
    this.runner.onNotice = (msg) => this._systemLine(msg, 'info');
    this.engine.log = (msg) => this._systemLine(msg.replace(/^\[sim\] /, 'Simulator: '), 'info');
    this.engine.onShort = (short) => {
      this._shorts.push(short);
      this._systemLine(`Short circuit: ${short.tags.join(' and ')} are connected while driving different levels. On real hardware this can damage the board.`, 'error');
      this._flagShort(short);
      this._renderChecks();
    };
    this.engine.onAttrChange = () => this._scheduleSave();
    this.engine.onPartStatus = (part) => { if (this.inspector.target === part) this.inspector.tick(); };
    this.engine.onBoardReset = () => {
      this._systemLine('Board reset.', 'info');
      this.runner.reset();
    };
    this.engine.onResetPin = (held) => {
      if (held) {
        this.runner.stop();
        this._systemLine('RESET is held LOW: the board is in reset.', 'info');
      } else if (this.running && !this.paused) {
        this.runner.reset();
        this.runner.start();
      }
    };
  }

  _flagShort(short) {
    const nodes = new Set(short.nodes);
    for (const w of this.canvas.wires) {
      if (nodes.has(`${w.from.partId}:${w.from.pin}`) || nodes.has(`${w.to.partId}:${w.to.pin}`)) w.groupEl.classList.add('short');
    }
  }

  async run() {
    if (this.debug) this.stop();
    const sketchPath = await this._prepareRun();
    if (!sketchPath) return;
    const board = this.board;
    if (runnerFamily(board.id) === 'esp32' && !await this._ensureEmulator(board)) {
      this._setState('idle');
      return;
    }
    this._systemLine(`Compiling for ${board.label}…`, 'info');
    const result = await this._compile(sketchPath, board);
    if (!result.success) {
      this._compileFailed(result);
      return;
    }
    if (!this._load(programOf(result), board)) return;
    this._systemLine(`Running on ${board.label}.`, 'success');
    this.runner.start();
    this._started();
  }

  /** Checks before compiling: a saved sketch and a board. Returns the sketch path. */
  async _prepareRun() {
    const sketchPath = window.state?.currentSketch || window.state?.currentFile;
    if (!sketchPath) {
      this._systemLine('Open or save a sketch first (File › New Sketch), then press ▶ — or open an example.', 'info');
      this.toast('Save your sketch first, or open an example.', 'info');
      return null;
    }
    if (!this.boardPart) {
      this.toast('Add a board before running.', 'warn');
      return null;
    }
    this._setState('compiling');
    if (window.saveActiveFile && !await window.saveActiveFile()) {
      this._systemLine('Could not save the sketch, so the simulation would run old code. Fix the save error and try again.', 'error');
      this._setState('idle');
      return null;
    }
    return sketchPath;
  }

  _compileFailed(result) {
    this._setState('idle');
    this._systemLine('Compilation failed:', 'error');
    this._appendRaw(`${(result.error || 'unknown error').trim()}\n`);
    const consoleEl = document.getElementById('consoleOutput');
    if (consoleEl) consoleEl.appendChild(h('div', { class: 'console-error' }, result.error || 'Compilation failed'));
  }

  /** The board's runner (avr8js or rp2040js), swapped in when the chip family changes. */
  _runnerFor(board) {
    const family = runnerFamily(board.id);
    if (family === this._runnerFamily) return;
    this.runner.stop();
    this.runner.shutdown?.();
    this.runner = createRunner(board.id);
    this._runnerFamily = family;
    this.engine.runner = this.runner;
    this._bindRunner();
  }

  /** Load a program (HEX, or UF2 for the Pico) and the circuit; false when it can't run on the board. */
  _load(program, board) {
    this._runnerFor(board);
    this._clearSerial();
    this._shorts = [];
    this.canvas.wires.forEach(w => w.groupEl.classList.remove('short'));
    if (!this.runner.load(program, board.id, this._target(board).mcu)) {
      this._setState('idle');
      return false;
    }
    // A software Serial (ATtiny85) takes typed input at the sketch's baud rate.
    this.runner.softSerialBaud = detectBaud(window.state?.editor?.getValue?.() || '');
    this.engine.setModel(this._engineModel());
    this.engine.start();
    this.analyzer?.reset();
    this.analyzer?.setBoard(board.id);
    this._pinActivity = {};
    return true;
  }

  _started() {
    this.running = true;
    this.paused = false;
    this._setState('running');
    this._startLoop();
    this.inspector.render();
    this._updateEmpty();
  }

  // ── Debugger ─────────────────────────────────────────────────────────────

  /** Debug › Start Debugging (F5): continue when stopped, else compile a debug build and run it. */
  async debugStart() {
    if (this.debug) {
      if (this.debug.stopped) this.debugAction('continue');
      return;
    }
    if (this.running) this.stop();
    if (runnerFamily(this.board.id) !== 'avr') {
      this.toast(`The debugger runs the AVR boards (Uno, Nano, Mega 2560, ATtiny85) for now. Press ▶ to simulate the ${this.board.label}.`, 'info');
      return;
    }
    const sketchPath = await this._prepareRun();
    if (!sketchPath) return;
    const board = this.board;
    this._showPane('debug');
    this.debugPane.running(`Compiling a debug build for ${board.label}…`, this._breakpointList());
    this._systemLine(`Compiling a debug build for ${board.label}…`, 'info');
    const compileDebug = () => window.electronAPI.arduino.compileDebug(sketchPath, this._target(board).fqbn).catch(err => ({ success: false, error: err.message }));
    let result = await compileDebug();
    if (!result.success && result.missingCore && await this._installCore(result.missingCore, board)) {
      this._systemLine('Compiling again…', 'info');
      result = await compileDebug();
    }
    if (!result.success) {
      this._compileFailed(result);
      this.debugPane.idle(this._breakpointList());
      return;
    }
    let info;
    try {
      info = readDebugInfo(result.elf);
    } catch (err) {
      this._setState('idle');
      this._systemLine(`Could not read the debug information: ${err.message}`, 'error');
      this.debugPane.idle(this._breakpointList());
      return;
    }
    if (!this._load(programOf(result), board)) return;
    const dbg = new Debugger(this.runner, info, {
      sketchDirs: result.sketchDirs,
      remap: (result.buildSketchDirs || []).map(b => [b, result.sketchDirs[0]]),
    });
    this.debug = { dbg, dirs: result.sketchDirs, stopped: false };
    dbg.onStop = (s) => this._debugStopped(s);
    this._syncBreakpoints();
    this._systemLine(`Debugging on ${board.label}. Debug builds are compiled with -Og and without link-time optimization, so timing can differ slightly from a normal build.`, 'success');
    this._started();
    const hasBreakpoints = dbg.breakWords.some(Boolean);
    const setup = dbg.sketchFunction('setup');
    this.debugPane.running(hasBreakpoints ? 'Running to the first breakpoint…' : 'Running to setup()…', this._breakpointList());
    if (hasBreakpoints) dbg.continue();
    else if (!(setup && dbg.runToLine(setup.file, setup.line))) dbg.runToSketch();
  }

  /** continue | stepOver | stepInto | stepOut, while stopped. */
  debugAction(kind) {
    const session = this.debug;
    if (!session?.stopped) return;
    session.stopped = false;
    this.paused = false;
    window.impulse?.breakpoints?.setCurrent(null);
    this._setState('running');
    this.debugPane.running(kind === 'continue' ? 'Running…' : 'Stepping…', this._breakpointList());
    session.dbg[kind]();
  }

  /** Debug › Run to Cursor. */
  debugRunToCursor() {
    const session = this.debug;
    const file = window.state?.currentFile;
    const line = window.state?.editor ? window.state.editor.getCursor().line + 1 : null;
    if (!session?.stopped || !file || !line) return;
    if (!inDirs(file, session.dirs)) {
      this.toast('Put the cursor on a line of this sketch first.');
      return;
    }
    session.stopped = false;
    this.paused = false;
    window.impulse?.breakpoints?.setCurrent(null);
    if (!session.dbg.runToLine(file, line)) {
      session.stopped = true;
      this.paused = true;
      this.toast('No code runs on that line or the lines after it.', 'warn');
      return;
    }
    this._setState('running');
    this.debugPane.running('Running to the cursor…', this._breakpointList());
  }

  _debugStopped(s) {
    const session = this.debug;
    if (!session) return;
    session.stopped = true;
    this.paused = true;
    this._setState('paused');
    this._flushSerial();
    const file = s.location.file ? this._appPath(s.location.file) : null;
    const location = { ...s.location, file };
    window.impulse?.breakpoints?.setCurrent(file ? { file, line: location.line } : null);
    if (file) window.impulse?.revealLine?.(file, location.line);
    this._showPane('debug');
    session.reason = s.reason;
    session.frame = 0;
    session.stack = session.dbg.callStack().map(f => ({ ...f, file: f.file ? this._appPath(f.file) : null }));
    this._renderStopped();
    const t = this.runner.time;
    this.timeLabel.textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}.${String(Math.floor((t % 1) * 1000)).padStart(3, '0')}`;
    this.announcer.textContent = location.inSketch
      ? `Stopped at line ${location.line}${location.function ? ` in ${location.function}` : ''}`
      : `Paused in ${location.function || 'Arduino core code'}`;
  }

  _renderStopped() {
    const session = this.debug;
    const dbg = session.dbg;
    const loc = dbg.location();
    this.debugPane.stopped({
      reason: session.reason,
      location: { ...loc, file: loc.file ? this._appPath(loc.file) : null },
      stack: session.stack,
      frame: session.frame,
      locals: dbg.locals(session.frame),
      globals: dbg.globals(),
      registers: dbg.registers(),
      breakpoints: this._breakpointList(),
    });
  }

  /** Show a caller's locals and line. */
  _selectFrame(index) {
    const session = this.debug;
    if (!session?.stopped || !session.stack?.[index]) return;
    session.frame = index;
    const f = session.stack[index];
    window.impulse?.breakpoints?.setFrame(index > 0 && f.file ? { file: f.file, line: f.line } : null);
    if (f.file) window.impulse?.revealLine?.(f.file, f.line);
    this._renderStopped();
  }

  /** The app's spelling of a sketch file path from the debugger. */
  _appPath(file) {
    const key = (p) => String(p).replace(/\\/g, '/').toLowerCase();
    const candidates = [
      ...(window.state?.openFiles || []).map(f => f.path),
      ...(window.impulse?.breakpoints ? [...window.impulse.breakpoints.all().keys()] : []),
    ];
    const known = candidates.find(p => key(p) === key(file));
    if (known) return known;
    return this.debug?.dirs[0]?.includes('\\') ? file.replace(/\//g, '\\') : file;
  }

  /** Breakpoints of the current sketch, for the Debug tab. */
  _breakpointList() {
    const bps = window.impulse?.breakpoints;
    const sketch = window.state?.currentSketch;
    if (!bps || !sketch) return [];
    const dirs = this.debug?.dirs || [diagramFolder(sketch)];
    const out = [];
    for (const [file, lines] of bps.all()) {
      if (!inDirs(file, dirs)) continue;
      const missing = bps.unverifiedLines(file);
      for (const line of lines) out.push({ file, line, unverified: missing.has(line) });
    }
    return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  _removeBreakpoint(file, line) {
    const bps = window.impulse?.breakpoints;
    if (!bps) return;
    bps.remove(file, line);
  }

  /** Send the editor's breakpoints to the debugger (on start and whenever they change). */
  _syncBreakpoints() {
    const session = this.debug;
    const bps = window.impulse?.breakpoints;
    if (!bps) return;
    if (session) {
      session.dbg.clearBreakpoints();
      for (const [file, lines] of bps.all()) {
        if (!inDirs(file, session.dirs)) continue;
        bps.setResolved(file, session.dbg.setBreakpoints(file, lines));
      }
    }
    if (!this.debugPaneEl.hidden && (!session || !session.stopped)) {
      if (session) this.debugPane.running(this.runner.running ? 'Running…' : 'Starting…', this._breakpointList());
      else this.debugPane.idle(this._breakpointList());
    }
  }

  /** The editor's breakpoints changed. */
  onBreakpointsChanged() {
    this._syncBreakpoints();
    if (this.debug?.stopped && !this.debugPaneEl.hidden) this._renderStopped();
  }

  _endDebug() {
    if (!this.debug) return;
    this.debug.dbg.detach();
    this.debug = null;
    window.impulse?.breakpoints?.setCurrent(null);
    window.impulse?.breakpoints?.clearResolved();
    this.debugPane.idle(this._breakpointList());
  }

  /** Compile for the simulated board, installing a missing library once if needed. */
  /** What the drawn board compiles and emulates for the upload board (a Pro Mini 168 on the Nano). */
  _target(board = this.board) {
    return compileTarget(board, window.state?.selectedBoard);
  }

  async _compile(sketchPath, board) {
    const target = this._target(board);
    const fqbn = target.fqbn;
    const options = target.properties ? { properties: target.properties } : undefined;
    let result;
    try {
      result = await window.electronAPI.arduino.compileHex(sketchPath, fqbn, options);
    } catch (err) {
      return { success: false, error: err.message };
    }
    if (!result.success && result.missingCore) {
      if (!await this._installCore(result.missingCore, board)) {
        return { success: false, error: `The ${board.label} core isn't installed, so the sketch can't be compiled for it yet.` };
      }
      this._systemLine('Compiling again…', 'info');
      result = await window.electronAPI.arduino.compileHex(sketchPath, fqbn, options);
    }
    if (!result.success) {
      const lib = this._detectMissingLibrary(result.error || '');
      if (lib) {
        this._systemLine(`Missing library “${lib}”. Installing…`, 'info');
        try {
          const inst = await window.electronAPI.lib.install(lib);
          if (inst && inst.success !== false) {
            this._libCache = null;
            this._systemLine(`Installed ${lib}. Compiling again…`, 'success');
            result = await window.electronAPI.arduino.compileHex(sketchPath, fqbn, options);
          } else {
            this._systemLine(`Could not install ${lib}: ${inst?.error || 'unknown error'}`, 'error');
          }
        } catch (err) {
          this._systemLine(`Library install failed: ${err.message}`, 'error');
        }
      }
    }
    return result;
  }

  /**
   * ESP32 boards run in Espressif's QEMU: ask to download it the first time
   * (on macOS it ships with Impulse). True when it's ready.
   */
  async _ensureEmulator(board) {
    const api = window.electronAPI?.esp32sim;
    if (!api) return false;
    const chip = this._target(board).mcu === 'esp32c3' ? 'esp32c3' : 'esp32';
    const status = await api.status(chip).catch(() => null);
    if (!status?.success) return false;
    if (status.data.installed) return true;
    if (!status.data.supported) {
      this._systemLine('The ESP32 emulator has no build for this computer, so ESP32 boards can\'t be simulated here.', 'error');
      return false;
    }
    const name = chip === 'esp32c3' ? 'the ESP32-C3 emulator' : 'the ESP32 emulator';
    const ok = await confirmDialog(`Install ${name}?`,
      `ESP32 boards run in Espressif's QEMU, the emulator Espressif uses to test ESP-IDF: a one-time download of about ${status.data.sizeMB} MB from Espressif's GitHub releases, checked against its published checksum.`,
      { confirmLabel: 'Install' });
    if (!ok) return false;
    const text = h('span', { role: 'status' }, `Installing ${name}…`);
    this.notice.replaceChildren(icon('download', 15), text);
    this.notice.hidden = false;
    const stop = api.onProgress((p) => {
      text.textContent = p.percent === null ? p.message : `${p.message} ${p.percent}%`;
    });
    const res = await api.install(chip).catch(e => ({ success: false, error: e.message }));
    stop?.();
    this.notice.hidden = true;
    if (!res?.success) {
      this._systemLine(`Could not install ${name}: ${res?.error || 'unknown error'}`, 'error');
      return false;
    }
    this._systemLine(`Installed ${name}.`, 'success');
    return true;
  }

  /** Ask to install a board core the simulator needs (the Pico's, ATTinyCore), with progress in the notice bar. */
  async _installCore(key, board) {
    const info = await window.electronAPI.toolchain?.extraCore?.(key).catch(() => null);
    if (!info?.success) return false;
    if (info.data.installed) return true;
    const { label, size } = info.data;
    const ok = await confirmDialog(`Install ${label}?`,
      `Compiling for the ${board.label} needs ${label}: a one-time download of ${size}. Impulse installs it with arduino-cli, as Arduino IDE's Boards Manager does.`,
      { confirmLabel: 'Install' });
    if (!ok) return false;
    const text = h('span', { role: 'status' }, `Installing ${label}…`);
    this.notice.replaceChildren(icon('download', 15), text);
    this.notice.hidden = false;
    const stop = window.electronAPI.toolchain.onProgress((p) => {
      text.textContent = p.percent === null ? p.message : `${p.message} ${p.percent}%`;
    });
    const res = await window.electronAPI.toolchain.installCore(key).catch(e => ({ success: false, error: e.message }));
    stop?.();
    this.notice.hidden = true;
    if (!res?.success) {
      this._systemLine(`Could not install ${label}: ${res?.error || 'unknown error'}`, 'error');
      return false;
    }
    this._systemLine(`${label} installed.`, 'success');
    return true;
  }

  restart() {
    if (!this.running) return;
    this._clearSerial();
    this.analyzer?.reset();
    this._shorts = [];
    this.runner.reset();
    this.engine.restartParts();
    this.paused = false;
    if (this.debug) {
      // Breakpoints stay armed through the restart.
      this.debug.stopped = false;
      window.impulse?.breakpoints?.setCurrent(null);
      this.debugPane.running('Running…', this._breakpointList());
    }
    if (!this.runner.running) this.runner.start();
    this._setState('running');
  }

  stop() {
    this.runner.stop();
    this.runner.shutdown?.();
    this._endDebug();
    this.engine.stop();
    const was = this.running;
    this.running = false;
    this.paused = false;
    this._setState('idle');
    cancelAnimationFrame(this._loopId);
    this._loopId = null;
    if (was) {
      this.inspector.render();
      this._updateEmpty();
    }
  }

  togglePause() {
    if (!this.running) return;
    if (this.debug) {
      if (this.debug.stopped) this.debugAction('continue');
      else this.debug.dbg.pause();
      return;
    }
    if (this.paused) this.runner.start();
    else this.runner.stop();
    this.paused = !this.paused;
    this._setState(this.paused ? 'paused' : 'running');
  }

  _setState(state) {
    /** 'idle' | 'compiling' | 'running' | 'paused': what the toolbar shows. */
    this.state = state;
    const running = state === 'running' || state === 'paused';
    this.playBtn.innerHTML = iconSvg(running ? 'restart' : 'play', running ? 16 : 18);
    this.playBtn.title = running ? 'Restart the simulation' : 'Start the simulation';
    this.playBtn.setAttribute('aria-label', this.playBtn.title);
    this.playBtn.classList.toggle('compiling', state === 'compiling');
    this.playBtn.disabled = state === 'compiling';
    const debugging = !!this.debug;
    this.stopBtn.hidden = !running;
    // Stopped in the debugger, Continue takes the place of Resume.
    this.pauseBtn.hidden = !running || (debugging && state === 'paused');
    this.debugBtn.hidden = running;
    this.debugBtn.disabled = state === 'compiling';
    this.debugGroup.hidden = !debugging;
    const stoppedHere = debugging && state === 'paused';
    for (const b of [this.continueBtn, this.stepOverBtn, this.stepIntoBtn, this.stepOutBtn]) b.disabled = !stoppedHere;
    this.stage.classList.toggle('debugging', debugging);
    this.pauseBtn.innerHTML = iconSvg(state === 'paused' ? 'play' : 'pause', 16);
    this.pauseBtn.title = state === 'paused' ? 'Resume' : 'Pause';
    this.pauseBtn.setAttribute('aria-label', this.pauseBtn.title);
    this.stats.hidden = !running;
    this.stage.classList.toggle('running', running);
    this.stage.classList.toggle('paused', state === 'paused');
  }

  _startLoop() {
    cancelAnimationFrame(this._loopId);
    let lastStats = 0;
    const loop = (now) => {
      if (!this.running) return;
      if (!this.paused) this.engine.frame();
      if (now - lastStats > 100) {
        lastStats = now;
        const t = this.runner.time;
        const mm = String(Math.floor(t / 60)).padStart(2, '0');
        const ss = String(Math.floor(t % 60)).padStart(2, '0');
        const ms = String(Math.floor((t % 1) * 1000)).padStart(3, '0');
        this.timeLabel.textContent = `${mm}:${ss}.${ms}`;
        this.speedLabel.textContent = `${Math.round(this.runner.speed * 100)}%`;
        this.analyzer?.tick(t);
        if (!this.logicPane.hidden) this.analyzer.render();
        this.inspector.tick();
      }
      this._flushSerial();
      this._loopId = requestAnimationFrame(loop);
    };
    this._loopId = requestAnimationFrame(loop);
  }

  // ── Serial ───────────────────────────────────────────────────────────────

  _appendSerial(ch, port = 0) {
    if (port) {
      // Serial1-3 on the Mega: show complete lines with a prefix.
      if (ch === '\n') {
        this._systemLine(`Serial${port} › ${this._serialLines[port].replace(/\r$/, '')}`, 'port');
        this._serialLines[port] = '';
      } else {
        this._serialLines[port] += ch;
      }
      return;
    }
    if (this._capturing) {
      this._captureBuf += ch;
      if (this._captureBuf.length > 8000) this._captureBuf = this._captureBuf.slice(-8000);
    }
    this._pending = (this._pending || '') + ch;
    if (ch === '\n') {
      const line = this._serialLines[0];
      this._serialLines[0] = '';
      window.dispatchEvent(new CustomEvent('impulse:sim-serial-line', { detail: line.replace(/\r$/, '') }));
    } else {
      this._serialLines[0] += ch;
    }
    this._txPending = true;
  }

  _flushSerial() {
    if (this._pending) {
      this._appendRaw(this._pending);
      this._pending = '';
    }
    if (this._txPending) {
      this._txPending = false;
      this._blink('ledTX');
    }
  }

  _appendRaw(text) {
    const out = this.serialOut;
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    let last = out.lastChild;
    if (!last || last.nodeType !== Node.TEXT_NODE) {
      last = document.createTextNode('');
      out.appendChild(last);
    }
    last.appendData(text);
    if (last.length > SERIAL_LIMIT) last.deleteData(0, last.length - SERIAL_LIMIT);
    if (atBottom) out.scrollTop = out.scrollHeight;
  }

  _systemLine(text, kind = 'info') {
    if (!this.serialOut) return;
    this._flushSerial();
    const out = this.serialOut;
    const line = h('div', { class: `sim-sys ${kind}` }, text);
    const last = out.lastChild;
    if (last && last.nodeType === Node.TEXT_NODE && last.length && !last.data.endsWith('\n')) {
      // A sketch line is half printed: show the notice above it and let the line continue.
      const partial = last.splitText(last.data.lastIndexOf('\n') + 1);
      out.insertBefore(line, partial);
    } else {
      out.append(line);
    }
    while (out.childNodes.length > 2000) out.firstChild.remove();
    out.scrollTop = out.scrollHeight;
  }

  _blink(led) {
    const board = this.boardPart?.el;
    if (!board || !this.running) return;
    board[led] = true;
    clearTimeout(this[`_${led}Timer`]);
    this[`_${led}Timer`] = setTimeout(() => { board[led] = false; }, 60);
  }

  _clearSerial() {
    if (this.serialOut) this.serialOut.textContent = '';
    this._pending = '';
    this._serialLines = ['', '', '', ''];
  }

  // ── Toasts ───────────────────────────────────────────────────────────────

  toast(message, kind = 'info', key = null) {
    if (!this.toasts) return;
    if (key) this.toasts.querySelector(`[data-key="${key}"]`)?.remove();
    const t = h('div', { class: `sim-toast ${kind}`, dataset: key ? { key } : {} }, icon(kind === 'error' || kind === 'warn' ? 'warning' : kind === 'success' ? 'check' : 'info', 15), h('span', {}, message));
    this.toasts.append(t);
    while (this.toasts.childElementCount > 3) this.toasts.firstChild.remove();
    setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 300); }, kind === 'error' ? 8000 : 5000);
  }

  // ── AI circuit builder ───────────────────────────────────────────────────

  async buildCircuitFromCode() {
    const code = window.state?.editor?.getValue?.() || '';
    if (!code.trim()) {
      this.toast('The editor is empty — open or write a sketch first.', 'info');
      return false;
    }
    if (this.aiBtn.classList.contains('working')) return false;
    this.aiBtn.classList.add('working');
    this._systemLine('AI is reading your sketch and wiring the circuit…', 'info');
    let result;
    try {
      result = await window.electronAPI.ai.generateCircuit(code, { board: this.board.id, catalog: catalogText() });
    } catch (err) {
      result = { success: false, error: err.message };
    }
    this.aiBtn.classList.remove('working');
    if (!result?.success) {
      this._systemLine(`AI circuit builder: ${result?.error || 'failed'}`, 'error');
      this.toast(result?.error || 'The AI could not build the circuit.', 'error');
      return false;
    }
    const check = validateCircuit(result.circuit);
    if (!check.ok) {
      this._systemLine('The generated circuit failed validation, so nothing was changed:', 'error');
      check.errors.slice(0, 8).forEach(e => this._systemLine(`  ✗ ${e}`, 'error'));
      this.toast('The AI produced an invalid circuit. Try again.', 'error');
      return false;
    }
    await this._applyModel(layoutCircuit(check.circuit), { by: 'ai' });
    check.warnings.forEach(w => this._systemLine(`AI circuit builder: ${w}`, 'warn'));
    this._systemLine(`Placed ${check.circuit.parts.length} parts with ${check.circuit.wires.length} wires. Press ▶ to simulate (${mod}Z undoes).`, 'success');
    return true;
  }

  // ── Agent: build → simulate → observe → fix ──────────────────────────────

  async runAgent() {
    if (this._agentRunning) return;
    const sketchPath = window.state?.currentSketch || window.state?.currentFile;
    if (!sketchPath) {
      this._agentLog('Save your sketch first, then run the agent.');
      return;
    }
    this._agentRunning = true;
    this.agentBtn.classList.add('working');
    this.stop();
    const MAX_ITERS = 4;
    try {
      if (this.canvas.parts.length <= 1) {
        this._agentLog('No circuit yet — generating one from your code…');
        await this.buildCircuitFromCode();
      }
      if (window.saveActiveFile) await window.saveActiveFile();
      for (let iter = 1; iter <= MAX_ITERS; iter++) {
        this._agentLog(`Iteration ${iter} of ${MAX_ITERS}`);
        const code = window.state?.editor?.getValue?.() || '';
        this._agentLog('Compiling…');
        const comp = await this._compile(sketchPath, this.board);
        if (!comp.success) {
          this._agentLog('Compile failed — asking AI to fix the code…');
          const fixed = await this._verify({ code, compile: comp.error || 'compile error', serial: '', pins: '', runSeconds: 0 });
          if (fixed?.fixedCode) {
            await this._applyCode(sketchPath, fixed.fixedCode);
            this._agentLog(`Applied fix: ${fixed.summary || 'code updated'}`);
            continue;
          }
          this._agentLog('Could not fix the compile error automatically. Stopping.');
          return;
        }
        this._agentLog('Compiled. Running the simulation to observe behavior…');
        const obs = await this._captureRun(programOf(comp), 3);
        this._agentLog(`Pins: ${obs.pins}`);
        const firstLine = (obs.serial.split('\n').find(l => l.trim()) || '(no serial output)').slice(0, 80);
        this._agentLog(`Serial: ${firstLine}${obs.serial.length > 80 ? ' …' : ''}`);
        this._agentLog('Checking behavior with AI…');
        const verdict = await this._verify({ code, compile: 'ok', serial: obs.serial, pins: obs.pins, runSeconds: 3 });
        if (!verdict) { this._agentLog('Verification unavailable. Stopping.'); return; }
        if (verdict.status === 'pass') {
          this._agentLog(`PASS — ${verdict.summary || 'behaves as intended.'}`);
          return;
        }
        this._agentLog(`Issue — ${verdict.summary || 'behavior does not match the intent.'}`);
        (verdict.issues || []).forEach(i => this._agentLog(`  • ${i}`));
        if (verdict.fixedCode && iter < MAX_ITERS) {
          await this._applyCode(sketchPath, verdict.fixedCode);
          this._agentLog('Applied a fix, checking again…');
          continue;
        }
        this._agentLog(verdict.fixedCode ? 'Reached the iteration limit.' : 'No automatic fix available. Stopping.');
        return;
      }
    } catch (err) {
      this._agentLog(`Agent error: ${err.message}`);
    } finally {
      this._agentRunning = false;
      this.agentBtn.classList.remove('working');
    }
  }

  async _captureRun(program, seconds) {
    this._captureBuf = '';
    this._pinActivity = {};
    this._capturing = true;
    this._runnerFor(this.board);
    if (!this.runner.load(program, this.board.id, this._target().mcu)) return { serial: '', pins: 'failed to load' };
    this.engine.setModel(this._engineModel());
    this.engine.start();
    this.running = true;
    this.runner.start();
    this._setState('running');
    this._startLoop();
    if (this.runner.realtime) {
      // The ESP32 emulator boots first; wait for the firmware's own time.
      await Promise.race([this.runner.waitUntil(seconds).catch(() => {}), new Promise(r => setTimeout(r, (seconds + 20) * 1000))]);
    } else {
      await new Promise(r => setTimeout(r, seconds * 1000));
    }
    this._capturing = false;
    this.stop();
    return { serial: this._captureBuf, pins: this._summarizePins() };
  }

  /** One line per wired board pin, e.g. "D13 → LED led1:A, Resistor r1:2". */
  _wiringSummary() {
    const { pins } = this.getWiring();
    return Object.entries(pins)
      .map(([num, list]) => `${pinLabel(this.board, Number(num))} → ${list.map(p => `${p.label}:${p.pin}`).join(', ')}`)
      .join('\n');
  }

  async _verify(obs) {
    try {
      const res = await window.electronAPI.ai.verifyExecution({
        ...obs,
        board: `${this.board.label} (${{ atmega2560: 'ATmega2560', rp2040: 'RP2040, 3.3 V logic', esp32: 'ESP32, 3.3 V logic', esp32s3: 'ESP32-S3, 3.3 V logic', esp32c3: 'ESP32-C3, 3.3 V logic' }[this.board.mcu] || 'ATmega328P'})`,
        circuit: this._wiringSummary(),
      });
      if (!res || !res.success) {
        this._agentLog(`Verify error: ${res?.error || 'unknown'}`);
        return null;
      }
      return res;
    } catch (err) {
      this._agentLog(`Verify error: ${err.message}`);
      return null;
    }
  }

  async _applyCode(sketchPath, code) {
    // The editor shows the active tab: only replace its text when that tab is the sketch.
    if (window.state?.editor && window.state.currentFile === sketchPath) window.state.editor.setValue(code);
    const tab = (window.state?.openFiles || []).find(f => f.path === sketchPath);
    if (tab) tab.content = code;
    const saved = await window.electronAPI.file.save(sketchPath, code).catch(e => ({ success: false, error: e.message }));
    if (!saved?.success) this._agentLog(`Could not save the sketch: ${saved?.error || 'unknown error'}`);
  }

  _agentLog(msg) {
    this._systemLine(`Agent: ${msg}`, 'agent');
  }

  _summarizePins() {
    const entries = Object.entries(this._pinActivity).map(([p, n]) => [Number(p), n]).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return 'no digital pin activity observed';
    return entries.map(([pin, n]) => `${pinLabel(this.board, pin)}:${n} edges`).join(', ');
  }

  /** Map a compiler "No such file: X.h" error to an installable library name. */
  _detectMissingLibrary(errorText) {
    const m = /(\w[\w\-.]*\.h):?\s+No such file or directory/i.exec(errorText) || /fatal error:\s*(\w[\w\-.]*\.h)/i.exec(errorText);
    if (!m) return null;
    const KNOWN = {
      'Servo.h': 'Servo', 'LiquidCrystal.h': 'LiquidCrystal', 'LiquidCrystal_I2C.h': 'LiquidCrystal I2C',
      'Adafruit_GFX.h': 'Adafruit GFX Library', 'Adafruit_SSD1306.h': 'Adafruit SSD1306', 'DHT.h': 'DHT sensor library',
      'DHT_U.h': 'DHT sensor library', 'Adafruit_Sensor.h': 'Adafruit Unified Sensor', 'FastLED.h': 'FastLED',
      'Adafruit_NeoPixel.h': 'Adafruit NeoPixel', 'IRremote.h': 'IRremote', 'IRremote.hpp': 'IRremote', 'Keypad.h': 'Keypad',
      'RTClib.h': 'RTClib', 'HX711.h': 'HX711', 'LedControl.h': 'LedControl', 'MD_MAX72xx.h': 'MD_MAX72XX', 'MD_Parola.h': 'MD_Parola',
      'Adafruit_ILI9341.h': 'Adafruit ILI9341', 'Adafruit_MPU6050.h': 'Adafruit MPU6050', 'MPU6050.h': 'MPU6050',
      'SevSeg.h': 'SevSeg', 'AccelStepper.h': 'AccelStepper', 'Stepper.h': 'Stepper', 'NewPing.h': 'NewPing',
      'U8g2lib.h': 'U8g2', 'U8x8lib.h': 'U8g2', 'TM1637Display.h': 'TM1637', 'Encoder.h': 'Encoder', 'Bounce2.h': 'Bounce2',
      'OneWire.h': 'OneWire', 'DallasTemperature.h': 'DallasTemperature', 'ArduinoJson.h': 'ArduinoJson',
      'Wire.h': null, 'SPI.h': null, 'SoftwareSerial.h': null, 'EEPROM.h': null,
    };
    if (m[1] in KNOWN) return KNOWN[m[1]];
    return m[1].replace(/\.(h|hpp)$/i, '');
  }

  // ── Integration ──────────────────────────────────────────────────────────

  /** Board, FQBN and circuit for headless runs (hardware tests, AI verify, compare). */
  simulationContext() {
    const board = this.board;
    const model = this.canvas ? this.canvas.model() : { parts: [], wires: [] };
    const target = this._target(board);
    return { board: board.id, fqbn: target.fqbn, mcu: target.mcu, properties: target.properties, label: board.label, circuit: model };
  }

  /**
   * Which parts each Arduino pin reaches through the current wiring.
   * @returns {{ hasCircuit: boolean, board: string, pins: Record<number, {id: string, type: string, label: string, pin: string}[]> }}
   */
  getWiring() {
    const board = this.board;
    const boardPart = this.boardPart;
    const pins = {};
    if (!this.canvas || !boardPart) return { hasCircuit: false, board: board.id, pins };
    const circuit = staticTopology(this._engineModel());
    for (const name of (boardPart.el.pinInfo || []).map(p => p.name)) {
      const num = boardPinNumber(board, name);
      if (num === null || pins[num]) continue;
      const net = circuit.netOf(`${boardPart.id}:${name}`);
      if (net < 0) continue;
      const nets = [net, ...circuit.resistiveNeighbors(net, 2).map(n => n.net)];
      const list = [];
      for (const n of nets) {
        for (const node of circuit.nodesOf(n)) {
          const sep = node.lastIndexOf(':');
          const partId = node.slice(0, sep);
          const part = this.canvas.getPart(partId);
          if (!part || part === boardPart || partDef(part.type)?.category === 'Breadboards') continue;
          list.push({ id: partId, type: part.type, label: `${partDef(part.type)?.label || part.type} ${partId}`, pin: node.slice(sep + 1) });
        }
      }
      if (list.length) pins[num] = list;
    }
    const hasCircuit = this.canvas.parts.some(p => !partDef(p.type)?.board && partDef(p.type)?.category !== 'Breadboards');
    return { hasCircuit, board: board.id, pins };
  }
}

export { PARTS };
