// Starter-kit modules drawn by Impulse: TM1637 4-digit display, 28BYJ-48
// stepper on its ULN2003 driver board, and the L298N dual H-bridge.

import { ImpulseElement, P, headerPin, escape } from './base.js';

const label = (text, x, y, size = 0.9, fill = '#e0e6ee', anchor = 'middle') =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}">${escape(text)}</text>`;

// One 7-segment digit: polygons for segments a–g plus the decimal point.
function digitSegments(x0, y0, w, h, t, cls) {
  const hseg = (cx, cy, len) => `${cx - len / 2},${cy} ${cx - len / 2 + t / 2},${cy - t / 2} ${cx + len / 2 - t / 2},${cy - t / 2} ${cx + len / 2},${cy} ${cx + len / 2 - t / 2},${cy + t / 2} ${cx - len / 2 + t / 2},${cy + t / 2}`;
  const vseg = (cx, cy, len) => `${cx},${cy - len / 2} ${cx + t / 2},${cy - len / 2 + t / 2} ${cx + t / 2},${cy + len / 2 - t / 2} ${cx},${cy + len / 2} ${cx - t / 2},${cy + len / 2 - t / 2} ${cx - t / 2},${cy - len / 2 + t / 2}`;
  const gap = 0.35;
  const lh = w - 2 * gap;
  const lv = h / 2 - 2 * gap;
  const pts = [
    hseg(x0 + w / 2, y0, lh), vseg(x0 + w, y0 + h / 4, lv), vseg(x0 + w, y0 + (3 * h) / 4, lv),
    hseg(x0 + w / 2, y0 + h, lh), vseg(x0, y0 + (3 * h) / 4, lv), vseg(x0, y0 + h / 4, lv), hseg(x0 + w / 2, y0 + h / 2, lh),
  ];
  return pts.map((p, i) => `<polygon class="${cls}" data-seg="${i}" points="${p}"/>`).join('')
    + `<circle class="${cls}" data-seg="7" cx="${x0 + w + 0.9}" cy="${y0 + h}" r="0.45"/>`;
}

/** TM1637 module: 4 digits with a clock colon, header CLK/DIO/VCC/GND on the right. */
export class Tm1637Element extends ImpulseElement {
  static PINS = ['CLK', 'DIO', 'VCC', 'GND'];

  constructor() {
    super();
    this._segments = [0, 0, 0, 0];
    this._brightness = 7;
    this._on = false;
  }

  get pinInfo() {
    return ImpulseElement.pins(Tm1637Element.PINS.map((name, i) => ({ name, x: 40.6, y: 8.2 + i * P })));
  }

  /** Segment bytes per digit (bit 0 = a … bit 6 = g, bit 7 = DP / colon). */
  set segments(v) { this._segments = Array.from(v || []); this._paint(); }
  get segments() { return this._segments; }
  set brightness(v) { this._brightness = v; this._paint(); }
  set on(v) { this._on = !!v; this._paint(); }

  afterRender() {
    this._segs = Array.from(this.shadowRoot.querySelectorAll('.seg'));
    this._colon = Array.from(this.shadowRoot.querySelectorAll('.colon'));
    this._paint();
  }

  _paint() {
    if (!this._segs) return;
    const lit = (0.45 + 0.55 * (this._brightness / 7)).toFixed(2);
    for (const s of this._segs) {
      const digit = Number(s.dataset.digit);
      const bit = Number(s.dataset.seg);
      const on = this._on && (this._segments[digit] >> bit) & 1;
      // The colon replaces digit 2's decimal point on clock modules.
      s.setAttribute('fill', on ? '#ff3b30' : '#3a1414');
      s.setAttribute('opacity', on ? lit : '1');
    }
    const colon = this._on && (this._segments[1] >> 7) & 1;
    for (const c of this._colon) { c.setAttribute('fill', colon ? '#ff3b30' : '#3a1414'); c.setAttribute('opacity', colon ? lit : '1'); }
  }

  draw() {
    let digits = '';
    const xs = [4.2, 11.4, 21.0, 28.2];
    xs.forEach((x, d) => {
      digits += digitSegments(x, 6.4, 5.2, 10.4, 1.05, 'seg').replace(/class="seg"/g, `class="seg" data-digit="${d}" fill="#3a1414"`);
    });
    // Digit 2 has no decimal point on clock modules: the colon takes its bit.
    digits = digits.replace(/(<circle class="seg" data-digit="1"[^>]*\/>)/, '');
    let pins = '';
    Tm1637Element.PINS.forEach((n, i) => { pins += headerPin(40.6, 8.2 + i * P) + label(n, 38.3, 8.5 + i * P, 0.95, '#e0e6ee', 'end'); });
    const body = `
      <rect x="0" y="0" width="42" height="24" rx="1" fill="#1d5fa8"/>
      <circle cx="2" cy="2" r="1" fill="#0f3a69"/><circle cx="2" cy="22" r="1" fill="#0f3a69"/>
      <circle cx="40" cy="2" r="1" fill="#0f3a69"/><circle cx="40" cy="22" r="1" fill="#0f3a69"/>
      <rect x="2.4" y="4.4" width="33.2" height="15.2" rx="0.4" fill="#111214"/>
      ${digits}
      <circle class="colon" cx="18.6" cy="9.4" r="0.6" fill="#3a1414"/>
      <circle class="colon" cx="18.6" cy="13.8" r="0.6" fill="#3a1414"/>
      ${label('TM1637', 19, 22.6, 1.0, '#cfe0f5')}
      ${pins}`;
    return { width: 42, height: 24, body };
  }
}

/** 28BYJ-48 geared stepper wired to its ULN2003 driver board. */
export class Stepper28byjElement extends ImpulseElement {
  static PINS = ['IN1', 'IN2', 'IN3', 'IN4', 'VCC', 'GND'];

  constructor() {
    super();
    this._angle = 0;
    this._coils = [0, 0, 0, 0];
  }

  get pinInfo() {
    return ImpulseElement.pins(Stepper28byjElement.PINS.map((name, i) => ({ name, x: 1.4, y: 5 + i * P + (i >= 4 ? P : 0) })));
  }

  set angle(v) {
    this._angle = v;
    this.shadowRoot?.querySelector('#shaft')?.setAttribute('transform', `rotate(${v.toFixed(2)} 52 15.5)`);
  }

  get angle() { return this._angle; }

  set coils(v) {
    this._coils = Array.from(v || []);
    this.shadowRoot?.querySelectorAll('.coil').forEach((c, i) => c.setAttribute('fill', this._coils[i] ? '#ff3b30' : '#4a1c1c'));
  }

  draw() {
    let pins = '';
    Stepper28byjElement.PINS.forEach((n, i) => {
      const y = 5 + i * P + (i >= 4 ? P : 0);
      pins += headerPin(1.4, y) + label(n === 'VCC' ? '+5V' : n === 'GND' ? '−' : n, 3.0, y + 0.3, 0.85, '#e8f3ea', 'start');
    });
    const coils = ['A', 'B', 'C', 'D'].map((n, i) => `
      <circle class="coil" cx="${9 + i * 3.4}" cy="25.6" r="0.9" fill="${this._coils[i] ? '#ff3b30' : '#4a1c1c'}"/>
      ${label(n, 9 + i * 3.4, 28.1, 0.85, '#e8f3ea')}`).join('');
    const wires = ['#3b6fd6', '#e889b5', '#e8c33a', '#f08a2c', '#d6453d'].map((c, i) => `<path d="M 30.4 ${12.6 + i * 0.9} C 34 ${12.6 + i * 0.9}, 34 ${14 + i * 0.9}, 38.5 ${14 + i * 0.9}" stroke="${c}" stroke-width="0.6" fill="none"/>`).join('');
    const body = `
      <rect x="0" y="0" width="31" height="31" rx="0.8" fill="#1f6b3f"/>
      <rect x="9" y="5" width="9" height="15" rx="0.5" fill="#1b1b1d"/>
      ${label('ULN2003', 13.5, 12.9, 0.95, '#cfd3d8')}
      <rect x="26" y="10.8" width="4.6" height="7.2" rx="0.4" fill="#f2f2ef"/>
      ${coils}
      ${wires}
      <rect x="35.4" y="13.6" width="33.2" height="3.8" rx="1.9" fill="#a9aeb6"/>
      <circle cx="37.6" cy="15.5" r="0.9" fill="#1f2125"/><circle cx="66.4" cy="15.5" r="0.9" fill="#1f2125"/>
      <circle cx="52" cy="15.5" r="13.8" fill="#c4c8ce" stroke="#8d939b" stroke-width="0.4"/>
      <circle cx="52" cy="15.5" r="11.6" fill="#b5bac1"/>
      ${label('28BYJ-48', 52, 25.3, 1.1, '#4b5058')}
      <g id="shaft" transform="rotate(${this._angle.toFixed(2)} 52 15.5)">
        <circle cx="52" cy="15.5" r="3.2" fill="#d9b54a" stroke="#a5852d" stroke-width="0.3"/>
        <rect x="51.4" y="12.6" width="1.2" height="5.8" rx="0.3" fill="#7c6420"/>
        <path d="M 52 6.4 l 1.1 2.4 h -2.2 z" fill="#ff3b30"/>
        <rect x="51.75" y="8.6" width="0.5" height="4" fill="#ff3b30"/>
      </g>
      ${pins}`;
    return { width: 68.6, height: 31, body };
  }
}

/** L298N dual H-bridge module with heatsink, screw terminals and control header. */
export class L298nElement extends ImpulseElement {
  static HEADER = ['ENA', 'IN1', 'IN2', 'IN3', 'IN4', 'ENB'];

  get pinInfo() {
    const x0 = 21.5 - 2.5 * P;
    return ImpulseElement.pins([
      ...L298nElement.HEADER.map((name, i) => ({ name, x: x0 + i * P, y: 41.6 })),
      { name: 'OUT1', x: 1.4, y: 16.0 }, { name: 'OUT2', x: 1.4, y: 16.0 + 2 * P },
      { name: 'OUT3', x: 41.6, y: 16.0 }, { name: 'OUT4', x: 41.6, y: 16.0 + 2 * P },
      { name: '12V', x: 4.2, y: 41.6 }, { name: 'GND', x: 4.2 + P, y: 41.6 }, { name: '5V', x: 4.2 + 2 * P, y: 41.6 },
    ]);
  }

  draw() {
    const x0 = 21.5 - 2.5 * P;
    const term = (x, y) => `<rect x="${x - 1.6}" y="${y - 1.6}" width="3.2" height="3.2" rx="0.3" fill="#2e6fd6"/><circle cx="${x}" cy="${y}" r="0.9" fill="#c9cbcf"/><path d="M ${x - 0.6} ${y} h 1.2" stroke="#7d8189" stroke-width="0.25"/>`;
    let header = '';
    L298nElement.HEADER.forEach((n, i) => { header += headerPin(x0 + i * P, 41.6) + label(n, x0 + i * P, 39.6, 0.8); });
    let fins = '';
    for (let i = 0; i < 9; i++) fins += `<rect x="${13.2 + i * 1.9}" y="2" width="1.1" height="16" fill="#2a2c30"/>`;
    const body = `
      <rect x="0" y="0" width="43" height="43" rx="0.9" fill="#b3202a"/>
      <rect x="12.4" y="1.4" width="18.2" height="17.4" rx="0.4" fill="#16171a"/>
      ${fins}
      ${label('L298N', 21.5, 22.2, 1.5, '#ffe9ea')}
      ${term(1.4, 16.0)}${term(1.4, 16.0 + 2 * P)}
      ${label('OUT1', 4.0, 16.3, 0.85, '#ffe9ea', 'start')}${label('OUT2', 4.0, 16.0 + 2 * P + 0.3, 0.85, '#ffe9ea', 'start')}
      ${term(41.6, 16.0)}${term(41.6, 16.0 + 2 * P)}
      ${label('OUT3', 39.0, 16.3, 0.85, '#ffe9ea', 'end')}${label('OUT4', 39.0, 16.0 + 2 * P + 0.3, 0.85, '#ffe9ea', 'end')}
      ${term(4.2, 41.6)}${term(4.2 + P, 41.6)}${term(4.2 + 2 * P, 41.6)}
      ${label('12V', 4.2, 38.6, 0.8, '#ffe9ea')}${label('GND', 4.2 + P, 38.6, 0.8, '#ffe9ea')}${label('5V', 4.2 + 2 * P, 38.6, 0.8, '#ffe9ea')}
      ${header}`;
    return { width: 43, height: 43, body };
  }
}
