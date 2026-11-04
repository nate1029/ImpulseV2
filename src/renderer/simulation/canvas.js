// Circuit canvas: parts (@wokwi/elements and Impulse elements) on a pannable,
// zoomable stage, wires with waypoints above them, and pin targets on top.
//
// Parts dropped on a breadboard snap their pins into its holes and connect
// automatically; moving a breadboard carries the parts plugged into it.

// Registers the part elements (Wokwi's and Impulse's own) the canvas draws.
import '@wokwi/elements';
import './elements/index.js';
import { partDef } from './parts/catalog.js';

const GRID = 4.8;          // half of the 0.1" pin pitch at 96 dpi
const SNAP_PX = 7;         // how close a pin must come to a hole to snap
const HOLE_EPS = 2.5;      // pin-on-hole tolerance for connections
const SVG_NS = 'http://www.w3.org/2000/svg';

const snap = (v) => Math.round(v / GRID) * GRID;

export const WIRE_COLORS = ['green', 'red', 'black', 'blue', 'orange', 'yellow', 'purple', 'white', 'gray', 'brown', 'cyan', 'magenta'];
const AUTO_COLORS = ['green', 'blue', 'orange', 'purple', 'cyan', 'yellow', 'magenta', 'brown'];
const CSS_COLOR = { green: '#2ea44f', red: '#e5484d', black: '#2b2b2e', blue: '#3e7bfa', orange: '#f08c00', yellow: '#e8c53a', purple: '#8e4ec6', white: '#e8e8e8', gray: '#8a8f98', brown: '#8d5524', cyan: '#12b5cb', magenta: '#d6409f' };
export const cssColor = (c) => CSS_COLOR[c] || c || CSS_COLOR.green;

/**
 * Take a part element's built-in controls (a pot's slider, a keypad's keys)
 * out of the Tab order; the mouse still works and the inspector offers
 * labelled equivalents. Runs again once the element has rendered.
 */
function quietControls(el) {
  const apply = () => {
    for (const c of el.shadowRoot?.querySelectorAll('input, button, select, textarea, [tabindex]') || []) c.setAttribute('tabindex', '-1');
  };
  apply();
  if (el.updateComplete) el.updateComplete.then(apply).catch(() => {});
  else requestAnimationFrame(apply);
}

export class CircuitCanvas {
  /**
   * @param {HTMLElement} rootEl
   * @param {{ isInteractive?: (part) => boolean }} [options]
   */
  constructor(rootEl, options = {}) {
    this.root = rootEl;
    this.options = options;
    this.parts = [];
    this.wires = [];
    this.selection = new Set();
    this._ids = new Set();
    this._scale = 1;
    this._panX = 40;
    this._panY = 40;
    this._drag = null;
    this._pan = null;
    this._wiring = null;
    this._marquee = null;
    this._wireSeq = 0;
    this._colorIdx = 0;
    this.overlapLinks = [];
    this._plugged = new Set();

    this.partsLayer = document.createElement('div');
    this.partsLayer.className = 'sim-parts-layer';
    // Part drawings are pictures to assistive tech; their values are edited
    // through the inspector's labelled controls.
    this.partsLayer.setAttribute('aria-hidden', 'true');
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'sim-wires-svg');
    this.pinLayer = document.createElementNS(SVG_NS, 'svg');
    this.pinLayer.setAttribute('class', 'sim-pins-svg');
    this.viewport = document.createElement('div');
    this.viewport.className = 'sim-viewport';
    this.viewport.append(this.partsLayer, this.svg, this.pinLayer);
    this.root.appendChild(this.viewport);

    this.marqueeEl = document.createElement('div');
    this.marqueeEl.className = 'sim-marquee';
    this.marqueeEl.hidden = true;
    this.root.appendChild(this.marqueeEl);

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'sim-pin-tooltip';
    this.tooltip.hidden = true;
    this.root.appendChild(this.tooltip);

    // Callbacks set by the manager
    this.onChange = null;          // (kind) => void — 'add' | 'remove' | 'move' | 'wire' | 'attr' | 'rotate' | 'links'
    this.onSelect = null;          // (selection: Set) => void
    this.onPartPointerDown = null; // (part, event) => void
    this.onPartPointerUp = null;   // (part, event) => void
    this.onPartDoubleClick = null; // (part) => void
    this.onContextMenu = null;     // (target: {part?, wire?}, event) => void
    this.onPinHover = null;        // (part, pin) => string|null — extra tooltip text
    this.onZoom = null;            // (scale) => void

    this._applyTransform();
    this._bindEvents();
  }

  // ── Parts ────────────────────────────────────────────────────────────────

  _newId(def) {
    const base = (def.idBase || def.label.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '').slice(0, 10)) || 'part';
    for (let n = 1; ; n++) {
      const id = `${base}${n}`;
      if (!this._ids.has(id)) return id;
    }
  }

  addPart(type, x = 100, y = 100, attrs = {}, id = null, rotate = 0) {
    const def = partDef(type);
    if (!def) return null;
    if (!id || this._ids.has(id)) id = this._newId(def);
    this._ids.add(id);

    const el = document.createElement(def.tag);
    el.classList.add('sim-part');
    el.dataset.partId = id;
    const merged = { ...def.attrs, ...attrs };
    applyAttrs(el, merged);

    // Positions are kept exactly (diagrams place pins on breadboard holes);
    // interactive placement snaps before calling this.
    const part = { id, type, x: Number(x) || 0, y: Number(y) || 0, rotate: rotate || 0, el, attrs: merged };
    this._place(part);
    if (def.category === 'Breadboards') this.partsLayer.prepend(el);
    else this.partsLayer.appendChild(el);
    this.parts.push(part);
    quietControls(el);

    el.addEventListener('pointerdown', (e) => this._onPartDown(part, e));
    el.addEventListener('pointerup', (e) => this.onPartPointerUp?.(part, e));
    el.addEventListener('pointerleave', (e) => this.onPartPointerUp?.(part, e));
    el.addEventListener('dblclick', () => this.onPartDoubleClick?.(part));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this.selection.has(part)) this.select([part]);
      this.onContextMenu?.({ part }, e);
    });
    el.addEventListener('pininfo-change', () => { this._renderPins(part); this._refreshWiresOf(part); this._scheduleOverlaps(); });

    requestAnimationFrame(() => {
      this._renderPins(part);
      this._refreshWiresOf(part);
      this._scheduleOverlaps();
    });
    this._emit('add');
    return part;
  }

  removePart(id) {
    const idx = this.parts.findIndex(p => p.id === id);
    if (idx < 0) return;
    const part = this.parts[idx];
    for (const w of [...this.wires]) if (w.from.partId === id || w.to.partId === id) this.removeWire(w.id, { silent: true });
    part.el.remove();
    this._removePinDots(id);
    this.parts.splice(idx, 1);
    this._ids.delete(id);
    this.selection.delete(part);
    this._scheduleOverlaps();
    this._emit('remove');
  }

  getPart(id) {
    return this.parts.find(p => p.id === id) || null;
  }

  setPartAttr(id, key, value) {
    const part = this.getPart(id);
    if (!part) return;
    if (value === undefined || value === null || value === '') delete part.attrs[key];
    else part.attrs[key] = String(value);
    applyAttrs(part.el, { [key]: value });
    requestAnimationFrame(() => { this._renderPins(part); this._refreshWiresOf(part); });
    quietControls(part.el);
    this._emit('attr');
  }

  rotateSelection(delta = 90) {
    const parts = [...this.selection].filter(s => s.el);
    for (const part of parts) {
      part.rotate = (((part.rotate || 0) + delta) % 360 + 360) % 360;
      this._place(part);
      this._renderPins(part);
      this._refreshWiresOf(part);
    }
    if (parts.length) {
      this._scheduleOverlaps();
      this._emit('rotate');
    }
  }

  _place(part) {
    part.el.style.left = `${part.x}px`;
    part.el.style.top = `${part.y}px`;
    part.el.style.transform = part.rotate ? `rotate(${part.rotate}deg)` : '';
  }

  _size(part) {
    const w = part.el.offsetWidth || partDef(part.type)?.size?.w || 60;
    const h = part.el.offsetHeight || partDef(part.type)?.size?.h || 60;
    return { w, h };
  }

  /** Bounding box in world coordinates (rotation aware). */
  bounds(part) {
    const { w, h } = this._size(part);
    const rot = ((part.rotate || 0) % 180) !== 0;
    const bw = rot ? h : w;
    const bh = rot ? w : h;
    const cx = part.x + w / 2;
    const cy = part.y + h / 2;
    return { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
  }

  // ── Pins ─────────────────────────────────────────────────────────────────

  pinPosition(part, pinName) {
    const info = (part.el.pinInfo || []).find(p => p.name === pinName);
    if (!info) return null;
    return this._pinWorld(part, info);
  }

  _pinWorld(part, info) {
    if (!part.rotate) return { x: part.x + info.x, y: part.y + info.y };
    const { w, h } = this._size(part);
    const a = (part.rotate * Math.PI) / 180;
    const dx = info.x - w / 2;
    const dy = info.y - h / 2;
    return {
      x: part.x + w / 2 + dx * Math.cos(a) - dy * Math.sin(a),
      y: part.y + h / 2 + dx * Math.sin(a) + dy * Math.cos(a),
    };
  }

  _renderPins(part) {
    this._removePinDots(part.id);
    const pins = part.el.pinInfo || [];
    if (!pins.length) return;
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('data-part-id', part.id);
    const isBoard = partDef(part.type)?.category === 'Breadboards';
    const r = isBoard ? 3.4 : 5;
    let markup = '';
    for (const pin of pins) {
      const pos = this._pinWorld(part, pin);
      const plugged = this._plugged.has(`${part.id}:${pin.name}`) ? ' plugged' : '';
      markup += `<circle class="sim-pin-dot${isBoard ? ' hole' : ''}${plugged}" data-pin="${escapeAttr(pin.name)}" cx="${pos.x.toFixed(2)}" cy="${pos.y.toFixed(2)}" r="${r}"/>`;
    }
    group.innerHTML = markup;
    if (isBoard) this.pinLayer.prepend(group);
    else this.pinLayer.appendChild(group);
  }

  _removePinDots(partId) {
    this.pinLayer.querySelectorAll(`g[data-part-id="${cssEscape(partId)}"]`).forEach(g => g.remove());
  }

  _showTooltip(part, pinName, clientX, clientY) {
    const def = partDef(part.type);
    const info = (part.el.pinInfo || []).find(p => p.name === pinName);
    const doc = def?.pins?.[pinName];
    const signals = (info?.signals || []).map(s => (s.type === 'pwm' ? 'PWM' : s.type === 'power' ? '' : `${s.type.toUpperCase()} ${s.signal || ''}`.trim())).filter(Boolean);
    let text = pinName;
    if (doc) text += ` — ${doc}`;
    else if (signals.length) text += ` — ${signals.join(', ')}`;
    const extra = this.onPinHover?.(part, pinName);
    if (extra) text += `\n${extra}`;
    this.tooltip.textContent = text;
    this.tooltip.hidden = false;
    const rect = this.root.getBoundingClientRect();
    this.tooltip.style.left = `${clientX - rect.left + 14}px`;
    this.tooltip.style.top = `${clientY - rect.top - 30}px`;
  }

  // ── Breadboards ──────────────────────────────────────────────────────────

  _isBreadboard(part) {
    return partDef(part.type)?.category === 'Breadboards';
  }

  _holeIndex(exclude = new Set()) {
    const index = new Map();
    for (const bb of this.parts) {
      if (!this._isBreadboard(bb) || exclude.has(bb)) continue;
      for (const info of bb.el.pinInfo || []) {
        const pos = this._pinWorld(bb, info);
        const key = `${Math.round(pos.x / GRID)},${Math.round(pos.y / GRID)}`;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push({ bb, pin: info.name, ...pos });
      }
    }
    return index;
  }

  _nearestHole(index, pos, maxDist) {
    const kx = Math.round(pos.x / GRID);
    const ky = Math.round(pos.y / GRID);
    let best = null;
    let bestD = maxDist;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        for (const h of index.get(`${kx + dx},${ky + dy}`) || []) {
          const d = Math.hypot(h.x - pos.x, h.y - pos.y);
          if (d < bestD) { bestD = d; best = h; }
        }
      }
    }
    return best;
  }

  /** Parts whose pins sit in a breadboard's holes. */
  _pluggedInto(bb) {
    const ids = new Set();
    for (const [a, b] of this.overlapLinks) {
      if (b.startsWith(`${bb.id}:`)) ids.add(a.slice(0, a.lastIndexOf(':')));
    }
    return this.parts.filter(p => ids.has(p.id));
  }

  _scheduleOverlaps() {
    if (this._overlapPending) return;
    this._overlapPending = true;
    requestAnimationFrame(() => {
      this._overlapPending = false;
      this.computeOverlaps();
    });
  }

  /** Recompute pin-in-hole connections; emits 'links' when they change. */
  computeOverlaps() {
    const index = this._holeIndex();
    const links = [];
    const plugged = new Set();
    if (index.size) {
      for (const part of this.parts) {
        if (this._isBreadboard(part)) continue;
        for (const info of part.el.pinInfo || []) {
          const hole = this._nearestHole(index, this._pinWorld(part, info), HOLE_EPS);
          if (!hole) continue;
          const a = `${part.id}:${info.name}`;
          const b = `${hole.bb.id}:${hole.pin}`;
          links.push([a, b]);
          plugged.add(a);
          plugged.add(b);
        }
      }
    }
    const key = links.map(l => l.join('=')).sort().join('|');
    const changedVisual = [...plugged].some(n => !this._plugged.has(n)) || [...this._plugged].some(n => !plugged.has(n));
    this.overlapLinks = links;
    this._plugged = plugged;
    if (changedVisual) {
      this.pinLayer.querySelectorAll('.sim-pin-dot').forEach((dot) => {
        const partId = dot.parentNode?.getAttribute('data-part-id');
        dot.classList.toggle('plugged', plugged.has(`${partId}:${dot.getAttribute('data-pin')}`));
      });
    }
    if (key !== this._overlapKey) {
      this._overlapKey = key;
      this.onChange?.('links');
    }
  }

  // ── Wires ────────────────────────────────────────────────────────────────

  addWire(from, to, color = null, id = null, points = [], { silent = false } = {}) {
    const dup = this.wires.find(w =>
      (w.from.partId === from.partId && w.from.pin === from.pin && w.to.partId === to.partId && w.to.pin === to.pin) ||
      (w.from.partId === to.partId && w.from.pin === to.pin && w.to.partId === from.partId && w.to.pin === from.pin));
    if (dup) return dup;
    if (!this.getPart(from.partId) || !this.getPart(to.partId)) return null;
    if (!id) id = `w${++this._wireSeq}`;
    else this._wireSeq = Math.max(this._wireSeq, Number(/^w(\d+)$/.exec(id)?.[1]) || 0);

    if (!color) color = this._autoColor(from, to);
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('class', 'sim-wire-group');
    const hit = document.createElementNS(SVG_NS, 'path');
    hit.setAttribute('class', 'sim-wire-hit');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', 'sim-wire');
    group.append(path, hit);
    this.svg.appendChild(group);

    const wire = { id, from, to, color, points: points.map(p => ({ x: p.x, y: p.y })), pathEl: path, hitEl: hit, groupEl: group };
    path.setAttribute('stroke', cssColor(color));
    hit.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.button === 2) return;
      if (e.detail === 2 || e.altKey) { this.removeWire(id); return; }
      this.select([wire], e.shiftKey);
    });
    hit.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.select([wire]);
      this.onContextMenu?.({ wire }, e);
    });
    this.wires.push(wire);
    this._routeWire(wire);
    if (!silent) this._emit('wire');
    return wire;
  }

  _autoColor(from, to) {
    const base = (p) => p.replace(/\.\d+$/, '');
    const isGnd = (p) => ['GND', 'VSS', 'tn', 'bn', '-'].includes(base(p));
    const isPower = (p) => ['5V', '3.3V', 'VIN', 'VCC', 'VDD', 'V+', '3V3', 'VS', 'VMOT', '12V', '+', 'tp', 'bp'].includes(base(p));
    if (isGnd(from.pin) || isGnd(to.pin)) return 'black';
    if (isPower(from.pin) || isPower(to.pin)) return 'red';
    const c = AUTO_COLORS[this._colorIdx % AUTO_COLORS.length];
    this._colorIdx++;
    return c;
  }

  removeWire(id, { silent = false } = {}) {
    const idx = this.wires.findIndex(w => w.id === id);
    if (idx < 0) return;
    const w = this.wires[idx];
    this.selection.delete(w);
    w.groupEl.remove();
    this.wires.splice(idx, 1);
    if (!silent) this._emit('wire');
  }

  setWireColor(id, color) {
    const w = this.wires.find(x => x.id === id);
    if (!w) return;
    w.color = color;
    w.pathEl.setAttribute('stroke', cssColor(color));
    this._emit('attr');
  }

  wireEnds(wire) {
    const fp = this.getPart(wire.from.partId);
    const tp = this.getPart(wire.to.partId);
    if (!fp || !tp) return null;
    const a = this.pinPosition(fp, wire.from.pin);
    const b = this.pinPosition(tp, wire.to.pin);
    return a && b ? { a, b } : null;
  }

  _routeWire(wire) {
    const ends = this.wireEnds(wire);
    if (!ends) return;
    wire.start = ends.a;
    const d = wirePath([ends.a, ...wire.points, ends.b], wire.points.length === 0);
    wire.pathEl.setAttribute('d', d);
    wire.hitEl.setAttribute('d', d);
  }

  _refreshWiresOf(part) {
    for (const w of this.wires) if (w.from.partId === part.id || w.to.partId === part.id) this._routeWire(w);
  }

  updateWires() {
    this.wires.forEach(w => this._routeWire(w));
  }

  _startWire(partId, pin) {
    const part = this.getPart(partId);
    const pos = part && this.pinPosition(part, pin);
    if (!pos) return;
    const temp = document.createElementNS(SVG_NS, 'path');
    temp.setAttribute('class', 'sim-wire sim-wire-temp');
    temp.setAttribute('stroke', cssColor('green'));
    this.svg.appendChild(temp);
    this._wiring = { from: { partId, pin }, start: pos, points: [], temp, cursor: pos };
    this.root.classList.add('wiring');
  }

  _drawTemp() {
    const w = this._wiring;
    if (!w) return;
    w.temp.setAttribute('d', wirePath([w.start, ...w.points, w.cursor], w.points.length === 0));
  }

  _finishWire(partId, pin) {
    const w = this._wiring;
    if (!w) return;
    this._cancelWire();
    if (w.from.partId === partId && w.from.pin === pin) return;
    const wire = this.addWire(w.from, { partId, pin }, null, null, w.points);
    if (wire) this.select([wire]);
  }

  _cancelWire() {
    if (!this._wiring) return;
    this._wiring.temp.remove();
    this._wiring = null;
    this.root.classList.remove('wiring');
  }

  get isWiring() {
    return !!this._wiring;
  }

  // ── Selection ────────────────────────────────────────────────────────────

  select(items, additive = false) {
    if (!additive) {
      for (const s of this.selection) this._markSelected(s, false);
      this.selection.clear();
    }
    for (const item of items || []) {
      if (!item) continue;
      if (additive && this.selection.has(item)) {
        this.selection.delete(item);
        this._markSelected(item, false);
      } else {
        this.selection.add(item);
        this._markSelected(item, true);
      }
    }
    this.onSelect?.(this.selection);
  }

  _markSelected(item, on) {
    if (item.el) item.el.classList.toggle('selected', on);
    else if (item.groupEl) item.groupEl.classList.toggle('selected', on);
  }

  get selectedParts() {
    return [...this.selection].filter(s => s.el);
  }

  get selectedWires() {
    return [...this.selection].filter(s => s.groupEl);
  }

  deleteSelected() {
    const items = [...this.selection];
    this.select([]);
    for (const it of items) {
      if (it.groupEl) this.removeWire(it.id, { silent: true });
    }
    for (const it of items) {
      if (it.el) this.removePart(it.id);
    }
    if (items.length) this._emit('remove');
  }

  // ── View ─────────────────────────────────────────────────────────────────

  get scale() {
    return this._scale;
  }

  _applyTransform() {
    this.viewport.style.transform = `translate(${this._panX}px, ${this._panY}px) scale(${this._scale})`;
    this.root.style.setProperty('--sim-zoom', String(this._scale));
    this.root.style.backgroundPosition = `${this._panX}px ${this._panY}px`;
    this.root.style.backgroundSize = `${GRID * 4 * this._scale}px ${GRID * 4 * this._scale}px`;
    this.onZoom?.(this._scale);
  }

  toWorld(clientX, clientY) {
    const rect = this.root.getBoundingClientRect();
    return { x: (clientX - rect.left - this._panX) / this._scale, y: (clientY - rect.top - this._panY) / this._scale };
  }

  /** World point at the center of the visible canvas. */
  viewCenter() {
    const rect = this.root.getBoundingClientRect();
    return this.toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  zoomBy(factor, clientX, clientY) {
    const rect = this.root.getBoundingClientRect();
    const mx = clientX === undefined ? rect.width / 2 : clientX - rect.left;
    const my = clientY === undefined ? rect.height / 2 : clientY - rect.top;
    const next = Math.max(0.2, Math.min(4, this._scale * factor));
    this._panX = mx - ((mx - this._panX) / this._scale) * next;
    this._panY = my - ((my - this._panY) / this._scale) * next;
    this._scale = next;
    this._applyTransform();
  }

  /**
   * Fit everything in view, leaving room for floating chrome.
   * @param {{ top?: number, right?: number, bottom?: number, left?: number }} [insets] px
   */
  zoomFit(insets = {}) {
    if (!this.parts.length) return true;
    const pad = { top: 60, right: 16, bottom: 56, left: 16, ...insets };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of this.parts) {
      const b = this.bounds(p);
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    for (const w of this.wires) for (const pt of w.points) { minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y); maxX = Math.max(maxX, pt.x); maxY = Math.max(maxY, pt.y); }
    const rect = this.root.getBoundingClientRect();
    if (!rect.width || !rect.height) return false; // not visible yet
    if (!isFinite(minX)) return true;
    const availW = Math.max(80, rect.width - pad.left - pad.right - 24);
    const availH = Math.max(80, rect.height - pad.top - pad.bottom - 24);
    const scale = Math.min(availW / (maxX - minX || 1), availH / (maxY - minY || 1), 1.6);
    this._scale = Math.max(0.2, scale);
    this._panX = pad.left + (rect.width - pad.left - pad.right - (maxX - minX) * this._scale) / 2 - minX * this._scale;
    this._panY = pad.top + (rect.height - pad.top - pad.bottom - (maxY - minY) * this._scale) / 2 - minY * this._scale;
    this._applyTransform();
    return true;
  }

  /** Pan so a part that is out of view comes to the middle of the canvas. */
  _keepInView(part) {
    const rect = this.root.getBoundingClientRect();
    const b = this.bounds(part);
    const left = this._panX + b.x * this._scale;
    const top = this._panY + b.y * this._scale;
    const inside = left >= 0 && top >= 0 && left + b.w * this._scale <= rect.width && top + b.h * this._scale <= rect.height;
    if (inside) return;
    this._panX = rect.width / 2 - (b.x + b.w / 2) * this._scale;
    this._panY = rect.height / 2 - (b.y + b.h / 2) * this._scale;
    this._applyTransform();
  }

  /** Pan just enough that `part` isn't hidden behind `cover` (a client rect, e.g. a floating panel). */
  reveal(part, cover) {
    const rect = this.root.getBoundingClientRect();
    const b = this.bounds(part);
    const left = rect.left + this._panX + b.x * this._scale;
    const right = left + b.w * this._scale;
    const top = rect.top + this._panY + b.y * this._scale;
    const bottom = top + b.h * this._scale;
    if (!cover || right <= cover.left || left >= cover.right || bottom <= cover.top || top >= cover.bottom) return;
    // Slide left until the part clears the panel, but never push its left edge off the canvas.
    const dx = Math.max(cover.left - 16 - right, rect.left + 16 - left);
    if (dx >= 0) return;
    const from = this._panX;
    const t0 = performance.now();
    cancelAnimationFrame(this._revealFrame);
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 200);
      this._panX = from + dx * (1 - (1 - k) ** 3);
      this._applyTransform();
      if (k < 1) this._revealFrame = requestAnimationFrame(step);
    };
    this._revealFrame = requestAnimationFrame(step);
  }

  /** Free spot for a new part near the view center. */
  freeSpot(w = 80, h = 80) {
    const c = this.viewCenter();
    const boxes = this.parts.map(p => this.bounds(p));
    const fits = (x, y) => !boxes.some(b => x < b.x + b.w + 12 && x + w + 12 > b.x && y < b.y + b.h + 12 && y + h + 12 > b.y);
    for (let r = 0; r < 900; r += 24) {
      for (let a = 0; a < 360; a += 30) {
        const x = c.x - w / 2 + r * Math.cos((a * Math.PI) / 180);
        const y = c.y - h / 2 + r * Math.sin((a * Math.PI) / 180);
        if (fits(x, y)) return { x: snap(x), y: snap(y) };
      }
    }
    return { x: snap(c.x - w / 2), y: snap(c.y - h / 2) };
  }

  // ── Pointer handling ─────────────────────────────────────────────────────

  _onPartDown(part, e) {
    if (e.button !== 0) return;
    if (this._wiring) return;
    const interactive = this.options.isInteractive?.(part);
    this.onPartPointerDown?.(part, e);
    if (interactive) return; // the part handles the pointer itself while running
    e.preventDefault();
    if (e.shiftKey) {
      this.select([part], true);
      return;
    }
    if (!this.selection.has(part)) this.select([part]);
    // Moving a breadboard carries everything plugged into it.
    const moving = new Set(this.selectedParts);
    for (const p of [...moving]) if (this._isBreadboard(p)) this._pluggedInto(p).forEach(x => moving.add(x));
    const breadboardsMoving = new Set([...moving].filter(p => this._isBreadboard(p)));
    this._drag = {
      parts: [...moving].map(p => ({ part: p, x: p.x, y: p.y })),
      wires: this.wires.filter(w => moving.has(this.getPart(w.from.partId)) && moving.has(this.getPart(w.to.partId))).map(w => ({ wire: w, points: w.points.map(pt => ({ ...pt })) })),
      px: e.clientX,
      py: e.clientY,
      moved: false,
      holes: breadboardsMoving.size === moving.size ? null : this._holeIndex(breadboardsMoving),
      lead: part,
    };
  }

  _dragMove(e) {
    const d = this._drag;
    let dx = (e.clientX - d.px) / this._scale;
    let dy = (e.clientY - d.py) / this._scale;
    if (!d.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    d.moved = true;
    dx = snap(dx);
    dy = snap(dy);
    // Pin-to-hole snapping for the part under the pointer.
    if (d.holes && d.holes.size && !this._isBreadboard(d.lead)) {
      const start = d.parts.find(p => p.part === d.lead);
      const ghost = { ...d.lead, x: start.x + dx, y: start.y + dy };
      for (const info of d.lead.el.pinInfo || []) {
        const pos = this._pinWorld(ghost, info);
        const hole = this._nearestHole(d.holes, pos, SNAP_PX);
        if (hole) {
          dx += hole.x - pos.x;
          dy += hole.y - pos.y;
          break;
        }
      }
    }
    for (const { part, x, y } of d.parts) {
      part.x = Math.round((x + dx) * 100) / 100;
      part.y = Math.round((y + dy) * 100) / 100;
      this._place(part);
      this._renderPins(part);
    }
    for (const { wire, points } of d.wires) wire.points = points.map(pt => ({ x: pt.x + dx, y: pt.y + dy }));
    for (const { part } of d.parts) this._refreshWiresOf(part);
  }

  _bindEvents() {
    const root = this.root;

    this.pinLayer.addEventListener('pointerover', (e) => {
      const dot = e.target.closest?.('.sim-pin-dot');
      if (!dot) return;
      dot.classList.add('hover');
      const part = this.getPart(dot.parentNode.getAttribute('data-part-id'));
      if (part) this._showTooltip(part, dot.getAttribute('data-pin'), e.clientX, e.clientY);
    });
    this.pinLayer.addEventListener('pointerout', (e) => {
      const dot = e.target.closest?.('.sim-pin-dot');
      if (!dot) return;
      dot.classList.remove('hover');
      this.tooltip.hidden = true;
    });
    this.pinLayer.addEventListener('pointerdown', (e) => {
      const dot = e.target.closest?.('.sim-pin-dot');
      if (!dot || e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const partId = dot.parentNode.getAttribute('data-part-id');
      const pin = dot.getAttribute('data-pin');
      if (this._wiring) this._finishWire(partId, pin);
      else this._startWire(partId, pin);
    });

    root.addEventListener('pointermove', (e) => {
      if (this._drag) {
        this._dragMove(e);
      } else if (this._pan) {
        this._panX = this._pan.panX + (e.clientX - this._pan.px);
        this._panY = this._pan.panY + (e.clientY - this._pan.py);
        this._applyTransform();
      } else if (this._marquee) {
        const m = this._marquee;
        m.x2 = e.clientX;
        m.y2 = e.clientY;
        const rect = root.getBoundingClientRect();
        Object.assign(this.marqueeEl.style, {
          left: `${Math.min(m.x1, m.x2) - rect.left}px`, top: `${Math.min(m.y1, m.y2) - rect.top}px`,
          width: `${Math.abs(m.x2 - m.x1)}px`, height: `${Math.abs(m.y2 - m.y1)}px`,
        });
        this.marqueeEl.hidden = false;
      } else if (this._wiring) {
        const w = this.toWorld(e.clientX, e.clientY);
        this._wiring.cursor = { x: w.x, y: w.y };
        this._drawTemp();
      }
    });

    window.addEventListener('pointerup', () => {
      if (this._drag) {
        const moved = this._drag.moved;
        this._drag = null;
        if (moved) {
          this.computeOverlaps();
          this._emit('move');
        }
      }
      if (this._marquee) {
        const m = this._marquee;
        this._marquee = null;
        this.marqueeEl.hidden = true;
        if (m.x2 !== undefined) {
          const a = this.toWorld(Math.min(m.x1, m.x2), Math.min(m.y1, m.y2));
          const b = this.toWorld(Math.max(m.x1, m.x2), Math.max(m.y1, m.y2));
          const hits = this.parts.filter(p => {
            const r = this.bounds(p);
            return r.x >= a.x && r.y >= a.y && r.x + r.w <= b.x && r.y + r.h <= b.y;
          });
          this.select(hits, m.additive);
        }
      }
      if (this._pan) {
        this._pan = null;
        root.classList.remove('panning');
      }
    });

    root.addEventListener('pointerdown', (e) => {
      const onEmpty = e.target === root || e.target === this.viewport || e.target === this.svg ||
        e.target === this.pinLayer || e.target === this.partsLayer;
      if (e.button === 1 || (e.button === 0 && onEmpty && e.altKey)) {
        e.preventDefault();
        this._pan = { px: e.clientX, py: e.clientY, panX: this._panX, panY: this._panY };
        root.classList.add('panning');
        return;
      }
      if (!onEmpty || e.button !== 0) return;
      if (this._wiring) {
        // Clicking empty canvas while wiring adds a bend point.
        const w = this.toWorld(e.clientX, e.clientY);
        this._wiring.points.push({ x: snap(w.x), y: snap(w.y) });
        this._drawTemp();
        return;
      }
      if (e.shiftKey) {
        this._marquee = { x1: e.clientX, y1: e.clientY, additive: true };
        return;
      }
      this.select([]);
      this._pan = { px: e.clientX, py: e.clientY, panX: this._panX, panY: this._panY };
      root.classList.add('panning');
    });

    root.addEventListener('contextmenu', (e) => {
      if (e.target === root || e.target === this.viewport || e.target === this.svg || e.target === this.pinLayer || e.target === this.partsLayer) {
        e.preventDefault();
        if (this._wiring) { this._cancelWire(); return; }
        this.onContextMenu?.({}, e);
      }
    });

    // Wheel zooms around the cursor (pinch arrives as ctrl+wheel); Shift+wheel pans.
    root.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      if (e.shiftKey) {
        this._panX -= e.deltaX || dy;
        this._applyTransform();
        return;
      }
      this.zoomBy(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX, e.clientY);
    }, { passive: false });
  }

  /** Keyboard handling for the canvas; returns true when the key was used. */
  handleKey(e) {
    if (e.key === 'Escape') {
      if (this._wiring) { this._cancelWire(); return true; }
      if (this.selection.size) { this.select([]); return true; }
      return false;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && this._wiring) {
      this._wiring.points.pop();
      this._drawTemp();
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection.size) {
      this.deleteSelected();
      return true;
    }
    // [ and ] step the selection through the parts (keyboard and screen-reader access).
    if ((e.key === '[' || e.key === ']') && !e.metaKey && !e.ctrlKey && this.parts.length) {
      const n = this.parts.length;
      const cur = this.selectedParts.length === 1 ? this.parts.indexOf(this.selectedParts[0]) : -1;
      const next = e.key === ']' ? (cur + 1) % n : (cur <= 0 ? n - 1 : cur - 1);
      this.select([this.parts[next]]);
      this._keepInView(this.parts[next]);
      return true;
    }
    if ((e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey && this.selectedParts.length) {
      this.rotateSelection(e.shiftKey ? -90 : 90);
      return true;
    }
    if (e.key.startsWith('Arrow') && this.selectedParts.length) {
      const step = e.shiftKey ? GRID * 4 : GRID;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      for (const p of this.selectedParts) {
        p.x += dx;
        p.y += dy;
        this._place(p);
        this._renderPins(p);
        this._refreshWiresOf(p);
      }
      this._scheduleOverlaps();
      this._emit('move');
      return true;
    }
    return false;
  }

  _emit(kind) {
    this.onChange?.(kind);
  }

  // ── Model ────────────────────────────────────────────────────────────────

  /** Plain model for saving: parts and wires without DOM references. */
  model() {
    return {
      parts: this.parts.map(p => ({ id: p.id, type: p.type, x: p.x, y: p.y, rotate: p.rotate || 0, attrs: { ...p.attrs } })),
      wires: this.wires.map(w => ({ id: w.id, from: { ...w.from }, to: { ...w.to }, color: w.color, points: w.points.map(pt => ({ ...pt })), start: w.start })),
    };
  }

  /**
   * Replace the canvas contents.
   * @param {{ parts: {id,type,x,y,rotate,attrs}[], wires: {from,to,color,points?,hints?}[] }} model
   * @param {(hints, a, b) => {x,y}[]} [toPoints] converts routing hints once pin positions are known
   */
  load(model, toPoints = null) {
    this.clear({ silent: true });
    for (const p of model.parts) this.addPart(p.type, p.x, p.y, p.attrs || {}, p.id, p.rotate || 0);
    return new Promise((resolve) => {
      // Lit elements render on the next frame; pins and sizes need that.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        for (const w of model.wires) {
          let points = w.points || [];
          if (!points.length && w.hints?.length && toPoints) {
            const fp = this.getPart(w.from.partId);
            const tp = this.getPart(w.to.partId);
            const a = fp && this.pinPosition(fp, w.from.pin);
            const b = tp && this.pinPosition(tp, w.to.pin);
            if (a && b) points = toPoints(w.hints, a, b);
          }
          this.addWire(w.from, w.to, w.color || null, w.id || null, points, { silent: true });
        }
        this.parts.forEach(p => this._renderPins(p));
        this.computeOverlaps();
        this._emit('load');
        resolve();
      }));
    });
  }

  clear({ silent = false } = {}) {
    this.select([]);
    for (const w of this.wires) w.groupEl.remove();
    this.wires = [];
    for (const p of this.parts) p.el.remove();
    this.parts = [];
    this._ids.clear();
    this.pinLayer.innerHTML = '';
    this.overlapLinks = [];
    this._plugged = new Set();
    this._overlapKey = '';
    this._wireSeq = 0;
    this._cancelWire();
    if (!silent) this._emit('remove');
  }
}

/** Set element attributes; some properties need typed values. */
export function applyAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === '') {
      el.removeAttribute(k);
      continue;
    }
    if (k === 'values' && typeof v === 'string' && /^[01]+$/.test(v)) {
      el.values = v.split('').map(Number);
      continue;
    }
    el.setAttribute(k, String(v));
  }
}

/** Orthogonal path through points; with no waypoints, a tidy dog-leg. */
export function wirePath(pts, auto) {
  if (pts.length < 2) return '';
  if (auto) {
    const [p1, p2] = [pts[0], pts[pts.length - 1]];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    if (Math.abs(dx) < 1 || Math.abs(dy) < 1) return `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`;
    const r = Math.min(6, Math.abs(dx) / 2, Math.abs(dy) / 2);
    const sx = Math.sign(dx);
    const sy = Math.sign(dy);
    // Wires leaving neighbouring pins get staggered bends instead of one shared run.
    const lane = Math.abs(dy) > 40 ? ((((Math.round(p1.x / 9.6) % 4) + 4) % 4) - 1.5) * 4.8 : 0;
    const midY = p1.y + dy / 2 + lane;
    return [
      `M ${p1.x} ${p1.y}`, `L ${p1.x} ${midY - sy * r}`, `Q ${p1.x} ${midY} ${p1.x + sx * r} ${midY}`,
      `L ${p2.x - sx * r} ${midY}`, `Q ${p2.x} ${midY} ${p2.x} ${midY + sy * r}`, `L ${p2.x} ${p2.y}`,
    ].join(' ');
  }
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const p = pts[i];
    const next = pts[i + 1];
    if (!next) { d += ` L ${p.x} ${p.y}`; break; }
    const r = Math.min(4, Math.hypot(p.x - prev.x, p.y - prev.y) / 2, Math.hypot(next.x - p.x, next.y - p.y) / 2);
    const inv = (a, b) => { const l = Math.hypot(b.x - a.x, b.y - a.y) || 1; return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }; };
    const u1 = inv(p, prev);
    const u2 = inv(p, next);
    d += ` L ${p.x + u1.x * r} ${p.y + u1.y * r} Q ${p.x} ${p.y} ${p.x + u2.x * r} ${p.y + u2.y * r}`;
  }
  return d;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function cssEscape(s) {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"');
}
