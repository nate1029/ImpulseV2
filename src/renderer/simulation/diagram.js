// diagram.json: the circuit saved next to each sketch. The format is Wokwi's,
// so Wokwi projects open in Impulse and Impulse diagrams open in Wokwi.
//
//   { version: 1, author, editor, parts: [{ type, id, top, left, rotate?, attrs }],
//     connections: [["uno:13", "led1:A", "green", ["v-9.6", "h19.2", "*"]], …] }

import { partDef, resolvePartType, savedType, PARTS } from './parts/catalog.js';
import { boardByTag, boardPinNumber, BOARDS } from './boards.js';
import { PART_PINS } from './parts/pins.js';
import { breadboardPins, breadboardHole } from './parts/modules.js';

export const DIAGRAM_VERSION = 1;

/**
 * Canvas model → diagram object.
 * @param {{ parts: {id, type, x, y, rotate?, attrs}[], wires: {from, to, color, points?}[] }} model
 */
export function toDiagram(model, { author = '' } = {}) {
  return {
    version: DIAGRAM_VERSION,
    author,
    editor: 'impulse',
    parts: model.parts.map(p => {
      const out = { type: savedType(p.type), id: p.id, top: round(p.y), left: round(p.x) };
      if (p.rotate) out.rotate = p.rotate;
      out.attrs = cleanAttrs(p.attrs);
      return out;
    }),
    connections: model.wires.map(w => [
      `${w.from.partId}:${w.from.pin}`,
      `${w.to.partId}:${w.to.pin}`,
      w.color || 'green',
      routeHints(w.start, w.points || []),
    ]),
    dependencies: {},
  };
}

const round = (v) => Math.round(Number(v) * 100) / 100;

function cleanAttrs(attrs = {}) {
  const out = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || typeof v === 'object') continue;
    out[k] = String(v);
  }
  return out;
}

/** Absolute waypoints → Wokwi routing hints relative to the start pin. */
export function routeHints(start, points) {
  if (!start || !points.length) return [];
  const hints = [];
  let x = start.x;
  let y = start.y;
  for (const p of points) {
    if (Math.abs(p.x - x) > 0.01) hints.push(`h${round(p.x - x)}`);
    if (Math.abs(p.y - y) > 0.01) hints.push(`v${round(p.y - y)}`);
    x = p.x;
    y = p.y;
  }
  hints.push('*');
  return hints;
}

/** Wokwi routing hints → absolute waypoints (given the wire's two pin positions). */
export function hintsToPoints(hints, start, end) {
  if (!Array.isArray(hints) || !hints.length || !start || !end) return [];
  const star = hints.indexOf('*');
  const before = star < 0 ? hints : hints.slice(0, star);
  const after = star < 0 ? [] : hints.slice(star + 1);
  const pts = [];
  let x = start.x;
  let y = start.y;
  for (const h of before) {
    const m = /^([hv])(-?[\d.]+)$/.exec(String(h));
    if (!m) continue;
    if (m[1] === 'h') x += Number(m[2]);
    else y += Number(m[2]);
    pts.push({ x, y });
  }
  // Hints after "*" walk backwards from the end pin.
  const tail = [];
  x = end.x;
  y = end.y;
  for (const h of after.slice().reverse()) {
    const m = /^([hv])(-?[\d.]+)$/.exec(String(h));
    if (!m) continue;
    if (m[1] === 'h') x -= Number(m[2]);
    else y -= Number(m[2]);
    tail.unshift({ x, y });
  }
  return [...pts, ...tail];
}

/**
 * Diagram object (Impulse or Wokwi) → canvas model.
 * Unknown part types are reported, not dropped silently.
 * @returns {{ parts: object[], wires: object[], unsupported: string[], errors: string[] }}
 */
export function fromDiagram(data) {
  const errors = [];
  const unsupported = [];
  if (!data || typeof data !== 'object' || !Array.isArray(data.parts)) {
    return { parts: [], wires: [], unsupported, errors: ['This file is not a diagram (no "parts" list).'] };
  }
  const parts = [];
  const ids = new Set();
  for (const p of data.parts) {
    if (!p || typeof p.type !== 'string' || typeof p.id !== 'string') continue;
    const attrs = cleanAttrs(p.attrs);
    const type = resolvePartType(p.type, attrs);
    if (!type) {
      if (!unsupported.includes(p.type)) unsupported.push(p.type);
      continue;
    }
    if (ids.has(p.id)) continue;
    ids.add(p.id);
    const def = PARTS[type];
    parts.push({
      id: p.id,
      type,
      x: Number(p.left) || 0,
      y: Number(p.top) || 0,
      rotate: normRotate(p.rotate),
      attrs: { ...def.attrs, ...attrs },
    });
  }
  const wires = [];
  for (const c of Array.isArray(data.connections) ? data.connections : []) {
    if (!Array.isArray(c) || typeof c[0] !== 'string' || typeof c[1] !== 'string') continue;
    const from = splitEnd(c[0]);
    const to = splitEnd(c[1]);
    if (!from || !to || !ids.has(from.partId) || !ids.has(to.partId)) continue;
    wires.push({ from, to, color: typeof c[2] === 'string' ? c[2] : null, hints: Array.isArray(c[3]) ? c[3] : [] });
  }
  return { parts, wires, unsupported, errors };
}

export function splitEnd(end) {
  const sep = end.indexOf(':');
  if (sep <= 0) return null;
  return { partId: end.slice(0, sep), pin: end.slice(sep + 1) };
}

function normRotate(r) {
  const n = ((Math.round((Number(r) || 0) / 90) * 90) % 360 + 360) % 360;
  return n;
}

// ── Board swap ───────────────────────────────────────────────────────────────

const I2C_PART_PINS = new Set(['SDA', 'SCL', 'DATA', 'CLK']);

/**
 * Move connections from one board to another, keeping pin numbers where the
 * new board has them and moving I²C wires to its SDA/SCL pins.
 * @returns {{ wires: object[], moved: string[], dropped: string[] }}
 */
export function remapBoardWires(wires, boardId, fromTag, toTag, partTypes = {}) {
  const from = boardByTag(fromTag);
  const to = boardByTag(toTag);
  const toPins = new Set(partDef(toTag)?.pinNames?.() || []);
  const moved = [];
  const dropped = [];
  const out = [];
  for (const w of wires) {
    const ends = [w.from, w.to];
    let ok = true;
    const next = ends.map((end, i) => {
      if (end.partId !== boardId) return end;
      const other = ends[1 - i];
      const pin = mapBoardPin(end.pin, from, to, toPins, I2C_PART_PINS.has(other.pin) && isI2cPart(partTypes[other.partId]));
      if (pin === null) { ok = false; return end; }
      if (pin !== end.pin) moved.push(`${end.pin} → ${pin}`);
      return { partId: end.partId, pin };
    });
    if (ok) out.push({ ...w, from: next[0], to: next[1] });
    else dropped.push(`${w.from.partId}:${w.from.pin} ↔ ${w.to.partId}:${w.to.pin}`);
  }
  return { wires: out, moved, dropped };
}

function isI2cPart(type) {
  return ['wokwi-lcd1602', 'wokwi-lcd2004', 'wokwi-ssd1306', 'wokwi-ds1307', 'wokwi-mpu6050'].includes(type);
}

function mapBoardPin(pin, from, to, toPins, i2c) {
  if (from && to) {
    const num = boardPinNumber(from, pin);
    if (i2c && num !== null && (num === from.i2c.sda || num === from.i2c.scl)) {
      const target = num === from.i2c.sda ? to.i2c.sda : to.i2c.scl;
      const name = [...toPins].find(n => boardPinNumber(to, n) === target && !/\.\d$/.test(n));
      if (name) return name;
    }
  }
  if (toPins.has(pin)) return pin;
  // Duplicate headers (A4.2, 13.2, 5V.2) fall back to the base pin.
  const base = pin.replace(/\.\d+$/, '');
  if (toPins.has(base)) return base;
  // Boards that name pins differently (13 ↔ GP13): the same Arduino pin,
  // analog inputs by their A-number (A0 ↔ GP26).
  if (from && to) {
    const num = boardPinNumber(from, pin);
    const entry = num !== null ? from.byPin.get(num) : null;
    const target = entry?.analog ? to.byAnalog.get(entry.analog)?.pin ?? null : num;
    if (target !== null && target !== undefined) {
      const name = [...toPins].find(n => boardPinNumber(to, n) === target && !/\.\d$/.test(n));
      if (name) return name;
    }
  }
  if (/^(A?GND)/.test(pin)) return [...toPins].find(n => /^GND/.test(n)) || null;
  for (const candidate of POWER_EQUIVALENTS[base] || []) if (toPins.has(candidate)) return candidate;
  return null;
}

/** Supply pins of one board family and their counterparts on another. */
const POWER_EQUIVALENTS = {
  '5V': ['5V', 'VBUS', 'VSYS'],
  VIN: ['VIN', 'VSYS', '5V'],
  IOREF: ['IOREF', '5V', 'VBUS'],
  '3.3V': ['3.3V', '3V3'],
  '3V3': ['3V3', '3.3V'],
  ADC_VREF: ['ADC_VREF', 'AREF', '3.3V'],
  VBUS: ['VBUS', '5V'],
  VSYS: ['VSYS', 'VIN', '5V'],
  RUN: ['RUN', 'RESET'],
  RESET: ['RESET', 'RUN'],
};

export const BOARD_TAGS = Object.values(BOARDS).map(b => b.tag);

// ── Breadboard plugging without a DOM ────────────────────────────────────────

function rotatePoint(x, y, w, h, deg) {
  if (!deg) return { x, y };
  const a = (deg * Math.PI) / 180;
  const dx = x - w / 2;
  const dy = y - h / 2;
  return { x: w / 2 + dx * Math.cos(a) - dy * Math.sin(a), y: h / 2 + dx * Math.sin(a) + dy * Math.cos(a) };
}

/**
 * Pins sitting in breadboard holes, from part positions alone (headless runs,
 * tests, AI-built circuits). The canvas does the same from rendered elements.
 * @param {{ id, type, x, y, rotate?, attrs? }[]} parts
 * @returns {[string, string][]}
 */
export function plugLinks(parts, tolerance = 2.5) {
  const holes = new Map();
  const key = (x, y) => `${Math.round(x / 4.8)},${Math.round(y / 4.8)}`;
  for (const bb of parts) {
    const def = partDef(bb.type);
    if (def?.category !== 'Breadboards') continue;
    const size = bb.attrs?.size || def.attrs?.size || 'full';
    for (const name of breadboardPins(size)) {
      const hpos = breadboardHole(size, name);
      const r = rotatePoint(hpos.x, hpos.y, def.size?.w || 0, def.size?.h || 0, bb.rotate || 0);
      const x = bb.x + r.x;
      const y = bb.y + r.y;
      const k = key(x, y);
      if (!holes.has(k)) holes.set(k, []);
      holes.get(k).push({ node: `${bb.id}:${name}`, x, y });
    }
  }
  if (!holes.size) return [];
  const links = [];
  for (const part of parts) {
    const def = partDef(part.type);
    const table = PART_PINS[part.type];
    if (!table || def?.category === 'Breadboards') continue;
    for (const [name, [px, py]] of Object.entries(table.at)) {
      const r = rotatePoint(px, py, table.w, table.h, part.rotate || 0);
      const x = part.x + r.x;
      const y = part.y + r.y;
      const kx = Math.round(x / 4.8);
      const ky = Math.round(y / 4.8);
      let best = null;
      let bestD = tolerance;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const h of holes.get(`${kx + dx},${ky + dy}`) || []) {
            const d = Math.hypot(h.x - x, h.y - y);
            if (d < bestD) { bestD = d; best = h; }
          }
        }
      }
      if (best) links.push([`${part.id}:${name}`, best.node]);
    }
  }
  return links;
}
