// Generic modules, bare components and breadboard wiring.

import { Behavior, clamp } from './behavior.js';

/** Sensor module with one digital output (IR obstacle, hall, touch, …). */
export class DigitalModuleBehavior extends Behavior {
  get outPin() {
    const pins = String(this.ctx.attr('pins', 'VCC,GND,OUT')).split(',');
    return pins.find(p => /^(OUT|DO|D0|SIG)$/i.test(p.trim()))?.trim() || 'OUT';
  }

  start() {
    this.apply();
  }

  apply() {
    const active = this.ctx.attr('active', false);
    const activeLow = this.ctx.attr('activeLow', false);
    this.ctx.drive(this.outPin, active === !activeLow ? 1 : 0);
    this.el.active = active;
    this.ctx.changed();
  }

  press() {
    if (this.ctx.attr('momentary', false)) this.ctx.setAttr('active', true);
    else this.ctx.setAttr('active', !this.ctx.attr('active', false));
    this.apply();
  }

  release() {
    if (!this.ctx.attr('momentary', false)) return;
    this.ctx.setAttr('active', false);
    this.apply();
  }

  control() { this.apply(); }

  stop() { this.el.active = false; }

  status() {
    const active = this.ctx.attr('active', false);
    const high = active === !this.ctx.attr('activeLow', false);
    return `${active ? 'Active' : 'Idle'} · ${this.outPin} ${high ? 'HIGH' : 'LOW'}`;
  }
}

/** Module with an analog output set from the inspector. */
export class AnalogOutModuleBehavior extends Behavior {
  start() { this.apply(); }

  apply() {
    const level = this.ctx.attr('level', 0);
    const max = this.ctx.attr('max', 5);
    const volts = this.ctx.attr('unit', 'V') === 'V' ? level : (level / max) * 5;
    this.volts = clamp(volts, 0, 5);
    this.ctx.driveVolts(this.ctx.attr('out', 'OUT'), this.volts, 100);
    this.ctx.changed();
  }

  control() { this.apply(); }

  status() {
    return `${this.ctx.attr('out', 'OUT')} ${this.volts?.toFixed(2) ?? '–'} V (≈${Math.round((this.volts || 0) / 5 * 1023)})`;
  }
}

/** Bare photoresistor: resistance falls with light (GL5528-like). */
export class LdrBehavior extends Behavior {
  ohms() {
    const lux = Math.max(0.1, this.ctx.attr('lux', 500));
    return 50000 * Math.pow(10, 0.7) / Math.pow(lux, 0.7);
  }

  resistors() {
    return [['1', '2', this.ohms()]];
  }

  control() {
    this.ctx.invalidate();
    this.ctx.changed();
  }

  status() {
    const r = this.ohms();
    return `${this.ctx.attr('lux', 500)} lux · ${r >= 1000 ? `${(r / 1000).toFixed(1)} kΩ` : `${Math.round(r)} Ω`}`;
  }
}

/** NPN transistor as a switch: C-E conducts while the base is above the emitter. */
export class TransistorBehavior extends Behavior {
  start() { this.on = false; }

  links() {
    return this.on ? [['C', 'E']] : null;
  }

  update() {
    const vb = this.ctx.volts('B');
    const ve = this.ctx.volts('E') ?? 0;
    const on = vb !== null && vb - ve > 0.6;
    if (on === this.on) return;
    this.on = on;
    this.ctx.invalidate();
    this.ctx.changed();
  }

  onPin() { this.update(); }
  frame() { this.update(); }

  status() {
    return this.on ? 'Saturated · C↔E conducting' : 'Off';
  }
}

export class ReedSwitchBehavior extends Behavior {
  links() {
    return this.ctx.attr('closed', false) ? [['1', '2']] : null;
  }

  press() {
    this.ctx.setAttr('closed', !this.ctx.attr('closed', false));
    this.control();
  }

  control() {
    this.el.closed = this.ctx.attr('closed', false);
    this.ctx.invalidate();
    this.ctx.changed();
  }

  start() { this.el.closed = this.ctx.attr('closed', false); }

  status() {
    return this.ctx.attr('closed', false) ? 'Closed (magnet nearby)' : 'Open';
  }
}

// ── Breadboards ──────────────────────────────────────────────────────────────

export const BREADBOARD_SIZES = {
  full: { cols: 63, rail: 50 },
  half: { cols: 30, rail: 25 },
  mini: { cols: 17, rail: 0 },
};
const TOP_ROWS = ['a', 'b', 'c', 'd', 'e'];
const BOTTOM_ROWS = ['f', 'g', 'h', 'i', 'j'];
export const RAILS = ['tn', 'tp', 'bp', 'bn'];

export function breadboardPins(size = 'full') {
  const { cols, rail } = BREADBOARD_SIZES[size] || BREADBOARD_SIZES.full;
  const out = [];
  for (let c = 1; c <= cols; c++) {
    for (const r of TOP_ROWS) out.push(`${c}t.${r}`);
    for (const r of BOTTOM_ROWS) out.push(`${c}b.${r}`);
  }
  for (const r of RAILS) for (let k = 1; k <= rail; k++) out.push(`${r}.${k}`);
  return out;
}

// Geometry in millimetres (pins are reported in px = mm × 96 / 25.4).
const BB_PITCH = 2.54;
const BB_X0 = 3.6;
const PX_PER_MM = 96 / 25.4;

/** Hole layout of a breadboard size (mm). */
export function breadboardLayout(size = 'full') {
  const spec = BREADBOARD_SIZES[size] || BREADBOARD_SIZES.full;
  const rails = spec.rail > 0;
  const yA = rails ? 11.2 : 4.4;
  const rowY = {};
  TOP_ROWS.forEach((r, i) => { rowY[r] = yA + i * BB_PITCH; });
  BOTTOM_ROWS.forEach((r, i) => { rowY[r] = rowY.e + 3 * BB_PITCH + i * BB_PITCH; });
  const railY = rails ? { tn: 3.2, tp: 3.2 + BB_PITCH, bp: rowY.j + 5.8, bn: rowY.j + 5.8 + BB_PITCH } : {};
  const height = rails ? railY.bn + 3.2 : rowY.j + 4.4;
  const width = BB_X0 * 2 + (spec.cols - 1) * BB_PITCH;
  const span = spec.rail + Math.floor((spec.rail - 1) / 5);
  const startCol = 1 + Math.floor((spec.cols - span) / 2);
  const colX = (c) => BB_X0 + (c - 1) * BB_PITCH;
  const railX = (k) => BB_X0 + (startCol - 1 + (k - 1) + Math.floor((k - 1) / 5)) * BB_PITCH;
  return { spec, rails, rowY, railY, height, width, railX, colX, top: TOP_ROWS, bottom: BOTTOM_ROWS };
}

/** Position (px, relative to the breadboard) of a hole such as "12t.c" or "tp.3". */
export function breadboardHole(size, name) {
  const L = breadboardLayout(size);
  let m = /^(\d+)([tb])\.([a-j])$/.exec(name);
  if (m) return { x: L.colX(Number(m[1])) * PX_PER_MM, y: L.rowY[m[3]] * PX_PER_MM };
  m = /^(tn|tp|bp|bn)\.(\d+)$/.exec(name);
  if (m && L.rails) return { x: L.railX(Number(m[2])) * PX_PER_MM, y: L.railY[m[1]] * PX_PER_MM };
  return null;
}

export function breadboardLinks(size = 'full') {
  const { cols, rail } = BREADBOARD_SIZES[size] || BREADBOARD_SIZES.full;
  const links = [];
  for (let c = 1; c <= cols; c++) {
    for (let i = 1; i < 5; i++) {
      links.push([`${c}t.${TOP_ROWS[i - 1]}`, `${c}t.${TOP_ROWS[i]}`]);
      links.push([`${c}b.${BOTTOM_ROWS[i - 1]}`, `${c}b.${BOTTOM_ROWS[i]}`]);
    }
  }
  for (const r of RAILS) for (let k = 2; k <= rail; k++) links.push([`${r}.${k - 1}`, `${r}.${k}`]);
  return links;
}
