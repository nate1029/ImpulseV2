// AI circuit builder — describes the parts catalog to the model, validates
// the circuit it returns and lays it out on the canvas.

import { PARTS, partDef, resolvePartType } from './parts/catalog.js';
import { BOARDS } from './boards.js';

/** Plain-text catalog for the model: type, what it is, attrs and pins. */
export function catalogText() {
  const lines = [];
  for (const def of Object.values(PARTS)) {
    if (def.board || def.category === 'Breadboards') continue;
    const attrs = def.attrs && Object.keys(def.attrs).length ? ` attrs ${JSON.stringify(def.attrs)}.` : '';
    const pins = def.pinNames(def.attrs).filter(p => !/\.\d+$/.test(p) || /^GND\.\d$/.test(p));
    const pinText = pins.map(p => (def.pins?.[p] ? `${p} (${def.pins[p]})` : p)).join(', ');
    const saved = def.saveAs ? ` Saved as "${def.saveAs}" with these attrs.` : '';
    lines.push(`${def.type} — ${def.label}: ${def.description}${attrs}${saved} Pins: ${pinText || 'none (wireless)'}.`);
  }
  return lines.join('\n');
}

/**
 * Validate the AI circuit spec. Returns { ok, errors, warnings, circuit } where
 * circuit has catalog types resolved.
 */
export function validateCircuit(circuit) {
  const errors = [];
  const warnings = [];
  const parts = [];
  const ids = new Set();
  let boards = 0;

  for (const part of circuit?.parts || []) {
    if (!part || typeof part !== 'object') { errors.push('Malformed part entry'); continue; }
    const type = resolvePartType(String(part.type || ''), part.attrs || {});
    if (!type) { errors.push(`Unknown part type: ${part.type}`); continue; }
    if (!part.id || typeof part.id !== 'string' || !/^[A-Za-z][\w-]{0,31}$/.test(part.id)) {
      errors.push(`Part of type ${part.type} has an invalid id`);
      continue;
    }
    if (ids.has(part.id)) { errors.push(`Duplicate part id: ${part.id}`); continue; }
    ids.add(part.id);
    if (PARTS[type].board) boards++;
    parts.push({ id: part.id, type, attrs: { ...PARTS[type].attrs, ...stringAttrs(part.attrs) } });
  }

  if (boards === 0) errors.push('Circuit has no Arduino board');
  if (boards > 1) errors.push('Circuit has more than one Arduino board');

  const byId = new Map(parts.map(p => [p.id, p]));
  const wires = [];
  for (const conn of circuit?.connections || []) {
    if (!Array.isArray(conn) || conn.length < 2) { errors.push('Malformed connection entry'); continue; }
    const ends = [];
    for (const end of [conn[0], conn[1]]) {
      if (typeof end !== 'string' || !end.includes(':')) { errors.push(`Bad connection endpoint: ${JSON.stringify(end)}`); continue; }
      const sep = end.indexOf(':');
      const id = end.slice(0, sep);
      const pin = end.slice(sep + 1);
      const part = byId.get(id);
      if (!part) { errors.push(`Connection references unknown part: ${id}`); continue; }
      const pins = partDef(part.type).pinNames(part.attrs);
      if (pins.length && !pins.includes(pin)) { errors.push(`${part.type} "${id}" has no pin "${pin}"`); continue; }
      ends.push({ partId: id, pin });
    }
    if (ends.length === 2) wires.push({ from: ends[0], to: ends[1], color: typeof conn[2] === 'string' ? conn[2] : null });
  }

  const ledCount = parts.filter(p => p.type === 'wokwi-led').length;
  const resistors = parts.filter(p => p.type === 'wokwi-resistor').length;
  if (ledCount > 0 && resistors === 0) {
    warnings.push('LEDs are wired without series resistors (works in simulation; add 220 Ω for real hardware).');
  }

  return { ok: errors.length === 0, errors, warnings, circuit: { parts, wires } };
}

function stringAttrs(attrs) {
  const out = {};
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && typeof v !== 'object') out[k] = String(v);
  return out;
}

/**
 * Positions for a validated circuit: the board on the left, parts in
 * columns to its right, wide parts on their own rows.
 * @returns {{ parts: object[], wires: object[] }}
 */
export function layoutCircuit({ parts, wires }) {
  const board = parts.find(p => PARTS[p.type].board);
  const others = parts.filter(p => p !== board);
  const placed = [];
  const boardSize = PARTS[board?.type]?.size || { w: 274, h: 207 };
  if (board) placed.push({ ...board, x: 0, y: 160, rotate: 0 });

  const gap = 36;
  const startX = boardSize.w + 80;
  const colWidth = 190;
  const cols = [0, 0, 0];
  for (const part of others) {
    const size = PARTS[part.type].size || { w: 90, h: 90 };
    let x;
    let y;
    if (size.w > colWidth * 1.4) {
      y = Math.max(...cols);
      x = startX;
      const bottom = y + size.h + gap;
      cols.fill(bottom);
    } else {
      const c = cols.indexOf(Math.min(...cols));
      x = startX + c * colWidth;
      y = cols[c];
      cols[c] = y + size.h + gap;
    }
    placed.push({ ...part, x, y, rotate: 0 });
  }
  return { parts: placed, wires };
}

/** Boards the AI may target. */
export const AI_BOARDS = Object.keys(BOARDS);
