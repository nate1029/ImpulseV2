// Modules drawn by Impulse: MAX7219 8×8 matrix, relay module, DC motor and a
// configurable sensor breakout used for many common sensor boards.

import { ImpulseElement, P, headerPin, escape } from './base.js';

const LED_ON = { red: '#ff3b30', green: '#30d158', blue: '#4ea4ff', yellow: '#ffd60a', white: '#f5f5f5' };

/** MAX7219 module: 8×8 dot matrix, input header at the bottom, output on top. */
export class Max7219MatrixElement extends ImpulseElement {
  static get observedAttributes() { return ['color']; }
  static IN = ['VCC', 'GND', 'DIN', 'CS', 'CLK'];
  static OUT = ['VCC.2', 'GND.2', 'DOUT', 'CS.2', 'CLK.2'];

  constructor() {
    super();
    this._values = new Array(64).fill(0);
  }

  get pinInfo() {
    const x0 = 16 - 2 * P;
    return ImpulseElement.pins([
      ...Max7219MatrixElement.IN.map((name, i) => ({ name, x: x0 + i * P, y: 38.6 })),
      ...Max7219MatrixElement.OUT.map((name, i) => ({ name, x: x0 + i * P, y: 1.4 })),
    ]);
  }

  set values(v) {
    this._values = Array.from(v || []);
    this._paint();
  }

  get values() { return this._values; }

  set intensity(v) { this._intensity = v; }

  afterRender() {
    this._dots = Array.from(this.shadowRoot.querySelectorAll('.dot'));
    this._paint();
  }

  _paint() {
    if (!this._dots) return;
    const on = LED_ON[this.getAttribute('color') || 'red'] || LED_ON.red;
    this._dots.forEach((d, i) => {
      const lit = !!this._values[i];
      d.setAttribute('fill', lit ? on : '#3a1d1d');
      d.setAttribute('filter', lit ? 'url(#glow)' : '');
    });
  }

  draw() {
    const x0 = 16 - 2 * P;
    let pins = '';
    const label = (n, x, y) => `<text x="${x}" y="${y}" font-size="0.85" fill="#e0e6ee" text-anchor="middle">${escape(n.replace(/\.\d+$/, ''))}</text>`;
    Max7219MatrixElement.IN.forEach((n, i) => { pins += headerPin(x0 + i * P, 38.6) + label(n, x0 + i * P, 36.9); });
    Max7219MatrixElement.OUT.forEach((n, i) => { pins += headerPin(x0 + i * P, 1.4) + label(n, x0 + i * P, 3.75); });
    let dots = '';
    const pitch = 3.3;
    const start = 16 - 3.5 * pitch;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) dots += `<circle class="dot" cx="${(start + c * pitch).toFixed(2)}" cy="${(20 - 3.5 * pitch + r * pitch).toFixed(2)}" r="1.25" fill="#3a1d1d"/>`;
    }
    const body = `
      <defs><filter id="glow" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="0.45" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
      <rect x="0" y="0" width="32" height="40" rx="0.8" fill="#1a4e8c"/>
      <rect x="2" y="5.2" width="28" height="29.6" rx="0.6" fill="#111214"/>
      ${dots}
      ${pins}`;
    return { width: 32, height: 40, body };
  }
}

/** One-channel 5 V relay module with screw terminals. */
export class RelayModuleElement extends ImpulseElement {
  get pinInfo() {
    return ImpulseElement.pins([
      { name: 'VCC', x: 1.4, y: 6.4 }, { name: 'GND', x: 1.4, y: 6.4 + P }, { name: 'IN', x: 1.4, y: 6.4 + 2 * P },
      { name: 'NO', x: 40.6, y: 6.4 }, { name: 'COM', x: 40.6, y: 6.4 + P }, { name: 'NC', x: 40.6, y: 6.4 + 2 * P },
    ]);
  }

  set active(v) {
    this._active = !!v;
    const led = this.shadowRoot?.querySelector('#led');
    if (led) led.setAttribute('fill', this._active ? '#ff453a' : '#4a1c1a');
    const arm = this.shadowRoot?.querySelector('#arm');
    if (arm) arm.setAttribute('transform', this._active ? 'rotate(-14 31 12)' : '');
  }

  get active() { return !!this._active; }

  draw() {
    const label = (n, x, y, anchor = 'start') => `<text x="${x}" y="${y + 0.35}" font-size="1.05" fill="#e6ecf5" text-anchor="${anchor}">${n}</text>`;
    const body = `
      <rect x="0" y="0" width="42" height="18.6" rx="0.8" fill="#1f5fae"/>
      ${headerPin(1.4, 6.4)}${headerPin(1.4, 6.4 + P)}${headerPin(1.4, 6.4 + 2 * P)}
      ${label('VCC', 2.7, 6.4)}${label('GND', 2.7, 6.4 + P)}${label('IN', 2.7, 6.4 + 2 * P)}
      <rect x="9.5" y="2.4" width="17" height="13.8" rx="0.6" fill="#2c73d2" stroke="#1a4f94" stroke-width="0.3"/>
      <text x="18" y="7.8" font-size="1.45" fill="#e9f1ff" text-anchor="middle" font-weight="600">SRD-05VDC</text>
      <text x="18" y="10.2" font-size="1.05" fill="#cfe0fb" text-anchor="middle">10A 250VAC</text>
      <circle id="led" cx="7.2" cy="15.6" r="0.75" fill="${this._active ? '#ff453a' : '#4a1c1a'}"/>
      <rect x="35.6" y="3.8" width="6.4" height="10.6" rx="0.4" fill="#2f8f4f"/>
      ${[0, 1, 2].map(i => `<circle cx="40.6" cy="${6.4 + i * P}" r="0.95" fill="#cfd3d8" stroke="#7d848e" stroke-width="0.2"/><path d="M ${40.0} ${6.4 + i * P} h 1.2" stroke="#6b7079" stroke-width="0.25"/>`).join('')}
      ${label('NO', 39.2, 6.4, 'end')}${label('COM', 39.2, 6.4 + P, 'end')}${label('NC', 39.2, 6.4 + 2 * P, 'end')}
      <g id="arm" transform="${this._active ? 'rotate(-14 31 12)' : ''}"><path d="M 28.5 12 L 33.2 12" stroke="#e8e8e8" stroke-width="0.45" stroke-linecap="round"/></g>`;
    return { width: 42, height: 18.6, body };
  }
}

/** Small brushed DC motor; `angle` turns the indicator on the shaft. */
export class DcMotorElement extends ImpulseElement {
  get pinInfo() {
    return ImpulseElement.pins([{ name: 'A', x: 11 - P / 2, y: 29.4 }, { name: 'B', x: 11 + P / 2, y: 29.4 }]);
  }

  set angle(v) {
    const g = this.shadowRoot?.querySelector('#rotor');
    if (g) g.setAttribute('transform', `rotate(${Number(v) || 0} 11 12.5)`);
  }

  set speed(v) {
    const t = this.shadowRoot?.querySelector('#rpm');
    if (t) t.textContent = Math.abs(v) >= 1 ? `${Math.round(Math.abs(v))} rpm` : '';
  }

  draw() {
    const body = `
      <defs>
        <linearGradient id="can" x1="0" x2="1"><stop offset="0" stop-color="#9aa0a8"/><stop offset="0.45" stop-color="#eef0f3"/><stop offset="1" stop-color="#8c929b"/></linearGradient>
      </defs>
      <path d="M ${11 - P / 2} 22 C ${11 - P / 2} 25, ${11 - P / 2} 26, ${11 - P / 2} 29.6" stroke="#d33a32" stroke-width="0.55" fill="none"/>
      <path d="M ${11 + P / 2} 22 C ${11 + P / 2} 25, ${11 + P / 2} 26, ${11 + P / 2} 29.6" stroke="#1f1f22" stroke-width="0.55" fill="none"/>
      <rect x="1" y="2" width="20" height="21" rx="3.2" fill="url(#can)" stroke="#7a8089" stroke-width="0.25"/>
      <circle cx="11" cy="12.5" r="7.2" fill="#d8dbe0" stroke="#8d939c" stroke-width="0.3"/>
      <g id="rotor">
        <path d="M 11 12.5 L 11 6.2" stroke="#f0a020" stroke-width="1.3" stroke-linecap="round"/>
        <path d="M 11 12.5 L 16.4 15.6" stroke="#f0a020" stroke-width="1.3" stroke-linecap="round"/>
        <path d="M 11 12.5 L 5.6 15.6" stroke="#f0a020" stroke-width="1.3" stroke-linecap="round"/>
      </g>
      <circle cx="11" cy="12.5" r="1.3" fill="#5c6169"/>
      <text id="rpm" x="11" y="27.3" font-size="1.4" fill="#8a8f98" text-anchor="middle"></text>`;
    return { width: 22, height: 30, body };
  }
}

const ICONS = {
  soil: '<path d="M2.2 1.2 v6.6 M5 1.2 v6.6" stroke="#d6b04c" stroke-width="1.1" stroke-linecap="round"/><path d="M1.6 1.2 h4" stroke="#d6b04c" stroke-width="1.1"/>',
  water: '<rect x="1" y="1" width="5.4" height="6.8" rx="0.4" fill="#c33"/><path d="M1.8 2.2 v4.6 M3 2.2 v4.6 M4.2 2.2 v4.6 M5.4 2.2 v4.6" stroke="#d6b04c" stroke-width="0.35"/>',
  rain: '<path d="M3.7 0.8 C2.4 3 1.8 4 1.8 5.1 a1.9 1.9 0 0 0 3.8 0 C5.6 4 5 3 3.7 0.8 Z" fill="#5ab0ff"/>',
  ir: '<circle cx="2.2" cy="4" r="1.6" fill="#dfe8f2" stroke="#9fb0c4" stroke-width="0.2"/><circle cx="5.4" cy="4" r="1.6" fill="#1b1b1d"/>',
  magnet: '<path d="M1.2 1 v3.6 a2.5 2.5 0 0 0 5 0 V1" fill="none" stroke="#d64541" stroke-width="1.4"/><path d="M1.2 1 v1.4 M6.2 1 v1.4" stroke="#cfd5dc" stroke-width="1.4"/>',
  touch: '<circle cx="3.7" cy="4" r="3" fill="#c9a43b"/><circle cx="3.7" cy="4" r="1.9" fill="none" stroke="#7a6220" stroke-width="0.3"/><circle cx="3.7" cy="4" r="0.9" fill="none" stroke="#7a6220" stroke-width="0.3"/>',
  vibration: '<path d="M0.8 4 l1 -2 l1 4 l1 -4 l1 4 l1 -4 l1 2" fill="none" stroke="#e8e8e8" stroke-width="0.45" stroke-linejoin="round"/>',
  wave: '<path d="M0.6 4 C1.6 0.8 2.6 0.8 3.6 4 S5.6 7.2 6.6 4" fill="none" stroke="#9fe0b0" stroke-width="0.55"/>',
  pulse: '<path d="M0.6 6 h1.6 v-4 h2.4 v4 h1.8" fill="none" stroke="#9fe0b0" stroke-width="0.55"/>',
};

/** Breakout board with a label, an icon and a single row of header pins. */
export class SensorModuleElement extends ImpulseElement {
  static get observedAttributes() { return ['label', 'pins', 'icon', 'color']; }

  get pinNames() {
    return String(this.getAttribute('pins') || 'VCC,GND,OUT').split(',').map(s => s.trim()).filter(Boolean);
  }

  get geometry() {
    const n = this.pinNames.length;
    const width = Math.max(24, n * P + 8);
    return { n, width, height: 17, x0: width / 2 - ((n - 1) * P) / 2 };
  }

  get pinInfo() {
    const g = this.geometry;
    return ImpulseElement.pins(this.pinNames.map((name, i) => ({ name, x: g.x0 + i * P, y: g.height - 1.3 })));
  }

  set active(v) {
    const led = this.shadowRoot?.querySelector('#sig');
    if (led) led.setAttribute('fill', v ? '#30d158' : '#173a22');
  }

  draw() {
    const g = this.geometry;
    const color = this.getAttribute('color') || '#1e4f8f';
    const icon = ICONS[this.getAttribute('icon')] || ICONS.wave;
    const label = escape(this.getAttribute('label') || 'SENSOR');
    let pins = '';
    this.pinNames.forEach((n, i) => {
      const x = g.x0 + i * P;
      pins += headerPin(x, g.height - 1.3);
      pins += `<text x="${x}" y="${g.height - 3.1}" font-size="0.95" fill="#e3ebf5" text-anchor="middle">${escape(n)}</text>`;
    });
    const body = `
      <rect x="0" y="0" width="${g.width}" height="${g.height}" rx="0.9" fill="${color}"/>
      <g transform="translate(2 2.2)">${icon}</g>
      <text x="${11.2}" y="4.3" font-size="1.55" fill="#f2f6fb" font-weight="600">${label}</text>
      <circle cx="12" cy="7.6" r="0.6" fill="#ff453a"/>
      <text x="13.1" y="8.0" font-size="0.95" fill="#cdd9e8">PWR</text>
      <circle id="sig" cx="18.4" cy="7.6" r="0.6" fill="#173a22"/>
      <text x="19.5" y="8.0" font-size="0.95" fill="#cdd9e8">OUT</text>
      ${pins}`;
    return { width: g.width, height: g.height, body };
  }
}

