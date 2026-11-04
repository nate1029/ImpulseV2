// Logic gates (ANSI symbols) and a D flip-flop. Inputs on the left, outputs
// on the right, all on the 0.1" grid; the output lead lights up when HIGH.

import { ImpulseElement, P } from './base.js';

const STROKE = '#c9cbcf';
const FILL = '#26282c';
const HIGH = '#30d158';
const W = 5 * P;
const H = 3 * P;
const MID = H / 2;
const IN_A = 1.27;
const IN_B = H - 1.27;

// Body outlines, x from 2.54 (back) to about 10 (front).
const SHAPES = {
  and: { d: `M 2.54 0.45 H 6.2 A 3.36 3.36 0 0 1 6.2 ${H - 0.45} H 2.54 Z`, front: 9.56, back: 2.54 },
  or: { d: `M 2.1 0.45 Q 4 ${MID} 2.1 ${H - 0.45} Q 7.4 ${H - 0.45} 9.8 ${MID} Q 7.4 0.45 2.1 0.45 Z`, front: 9.8, back: 3.0 },
  not: { d: `M 3.2 0.7 L 9.0 ${MID} L 3.2 ${H - 0.7} Z`, front: 9.0, back: 3.2 },
};

class GateElement extends ImpulseElement {
  get shape() { return 'and'; }
  get invert() { return false; }
  get exclusive() { return false; }
  get inputs() { return ['A', 'B']; }
  get title() { return ''; }

  get pinInfo() {
    const ins = this.inputs.length === 1 ? [{ name: 'A', x: 0, y: MID }] : [{ name: 'A', x: 0, y: IN_A }, { name: 'B', x: 0, y: IN_B }];
    return ImpulseElement.pins([...ins, { name: 'Y', x: W, y: MID }]);
  }

  set value(v) {
    this._value = !!v;
    const out = this.shadowRoot?.querySelector('#out');
    if (out) out.setAttribute('stroke', this._value ? HIGH : STROKE);
  }

  get value() { return !!this._value; }

  draw() {
    const s = SHAPES[this.shape];
    const bubble = this.invert ? 0.55 : 0;
    const outStart = s.front + bubble * 2;
    // Input leads stop at the curved back of OR-type gates.
    const back = (y) => (this.shape === 'or' ? 2.1 + 1.9 * (1 - ((y - MID) / (MID - 0.45)) ** 2) * 0.55 : s.back);
    const ins = this.inputs.length === 1 ? [MID] : [IN_A, IN_B];
    const leads = ins.map(y => `<line x1="0" y1="${y}" x2="${back(y)}" y2="${y}" stroke="${STROKE}" stroke-width="0.35"/>`).join('');
    const body = `
      ${leads}
      ${this.exclusive ? `<path d="M 1.3 0.45 Q 3.2 ${MID} 1.3 ${H - 0.45}" fill="none" stroke="${STROKE}" stroke-width="0.35"/>` : ''}
      <path d="${s.d}" fill="${FILL}" stroke="${STROKE}" stroke-width="0.35" stroke-linejoin="round"/>
      ${bubble ? `<circle cx="${s.front + bubble}" cy="${MID}" r="${bubble}" fill="${FILL}" stroke="${STROKE}" stroke-width="0.35"/>` : ''}
      <line id="out" x1="${outStart}" y1="${MID}" x2="${W}" y2="${MID}" stroke="${this._value ? HIGH : STROKE}" stroke-width="0.45"/>
      <text x="${this.shape === 'or' ? 5.9 : 5.6}" y="${MID + 0.6}" font-size="${this.title.length > 3 ? 1.45 : 1.7}" fill="#e7e9ec" text-anchor="middle" font-weight="600">${this.title}</text>`;
    return { width: W, height: H, body };
  }
}

export class AndGateElement extends GateElement { get title() { return 'AND'; } }
export class NandGateElement extends GateElement { get invert() { return true; } get title() { return 'NAND'; } }
export class OrGateElement extends GateElement { get shape() { return 'or'; } get title() { return 'OR'; } }
export class NorGateElement extends GateElement { get shape() { return 'or'; } get invert() { return true; } get title() { return 'NOR'; } }
export class XorGateElement extends GateElement { get shape() { return 'or'; } get exclusive() { return true; } get title() { return 'XOR'; } }
export class NotGateElement extends GateElement {
  get shape() { return 'not'; }
  get invert() { return true; }
  get inputs() { return ['A']; }
  get title() { return ''; }
}

const FF_TOP = P;
const FF_BOTTOM = 3 * P;

/** Positive-edge D flip-flop with Q and Q̄ outputs. */
export class FlipFlopDElement extends ImpulseElement {
  get pinInfo() {
    return ImpulseElement.pins([
      { name: 'D', x: 0, y: FF_TOP }, { name: 'CLK', x: 0, y: FF_BOTTOM },
      { name: 'Q', x: W, y: FF_TOP }, { name: 'QN', x: W, y: FF_BOTTOM },
    ]);
  }

  /** true / false while simulating; null when idle (neither output lit). */
  set value(v) {
    this._value = v === null || v === undefined ? null : !!v;
    this.shadowRoot?.querySelector('#q')?.setAttribute('stroke', this._value === true ? HIGH : STROKE);
    this.shadowRoot?.querySelector('#qn')?.setAttribute('stroke', this._value === false ? HIGH : STROKE);
  }

  get value() { return this._value ?? null; }

  draw() {
    const h = 4 * P;
    const yTop = FF_TOP;
    const yBot = FF_BOTTOM;
    const q = this._value ?? null;
    const body = `
      <line x1="0" y1="${yTop}" x2="2.54" y2="${yTop}" stroke="${STROKE}" stroke-width="0.35"/>
      <line x1="0" y1="${yBot}" x2="2.54" y2="${yBot}" stroke="${STROKE}" stroke-width="0.35"/>
      <line id="q" x1="${W - 2.54}" y1="${yTop}" x2="${W}" y2="${yTop}" stroke="${q === true ? HIGH : STROKE}" stroke-width="0.45"/>
      <line id="qn" x1="${W - 2.54}" y1="${yBot}" x2="${W}" y2="${yBot}" stroke="${q === false ? HIGH : STROKE}" stroke-width="0.45"/>
      <rect x="2.54" y="0.4" width="${W - 5.08}" height="${h - 0.8}" rx="0.4" fill="${FILL}" stroke="${STROKE}" stroke-width="0.35"/>
      <path d="M 2.54 ${yBot - 0.8} L 3.6 ${yBot} L 2.54 ${yBot + 0.8}" fill="none" stroke="${STROKE}" stroke-width="0.3"/>
      <text x="3.3" y="${yTop + 0.5}" font-size="1.4" fill="#e7e9ec">D</text>
      <text x="${W - 3.3}" y="${yTop + 0.5}" font-size="1.4" fill="#e7e9ec" text-anchor="end">Q</text>
      <text x="${W - 3.3}" y="${yBot + 0.5}" font-size="1.4" fill="#e7e9ec" text-anchor="end">Q̄</text>
      <text x="${W / 2}" y="${h / 2 + 0.5}" font-size="1.3" fill="#8a8f98" text-anchor="middle">D-FF</text>`;
    return { width: W, height: h, body };
  }
}
