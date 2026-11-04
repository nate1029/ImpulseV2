// Boards drawn by Impulse: the Raspberry Pi Pico (not in @wokwi/elements).

import { ImpulseElement, P, escape } from './base.js';

// Physical pins 1–20 down the left edge and 21–40 up the right edge, USB at the top
// (Raspberry Pi Pico datasheet, "Pinout").
const LEFT = ['GP0', 'GP1', 'GND.1', 'GP2', 'GP3', 'GP4', 'GP5', 'GND.2', 'GP6', 'GP7',
  'GP8', 'GP9', 'GND.3', 'GP10', 'GP11', 'GP12', 'GP13', 'GND.4', 'GP14', 'GP15'];
const RIGHT = ['VBUS', 'VSYS', 'GND.8', '3V3_EN', '3V3', 'ADC_VREF', 'GP28', 'AGND', 'GP27', 'GP26',
  'RUN', 'GP22', 'GND.7', 'GP21', 'GP20', 'GP19', 'GP18', 'GND.6', 'GP17', 'GP16'];

const W = 21;
const H = 51;
const X_LEFT = (W - 7 * P) / 2; // the two rows are 0.7" apart
const X_RIGHT = W - X_LEFT;
const Y0 = (H - 19 * P) / 2;

/** Raspberry Pi Pico: RP2040, 26 GPIO on castellated pads, the LED on GP25. */
export class PiPicoElement extends ImpulseElement {
  static LEFT = LEFT;
  static RIGHT = RIGHT;

  get pinInfo() {
    return ImpulseElement.pins([
      ...LEFT.map((name, i) => ({ name, x: X_LEFT, y: Y0 + i * P })),
      ...RIGHT.map((name, i) => ({ name, x: X_RIGHT, y: Y0 + i * P })),
    ]);
  }

  /** The user LED on GP25 (the property name every board element uses). */
  set led13(on) {
    this._led = !!on;
    this._paintLed();
  }

  get led13() { return !!this._led; }

  set ledPower(_on) { /* the Pico has no power LED */ }

  afterRender() {
    this._ledEl = this.shadowRoot.querySelector('.led');
    this._paintLed();
  }

  _paintLed() {
    if (!this._ledEl) return;
    this._ledEl.setAttribute('fill', this._led ? '#7dff6a' : '#2f4a2c');
    this._ledEl.setAttribute('filter', this._led ? 'url(#picoGlow)' : '');
  }

  draw() {
    const pad = (x, y) => `<circle cx="${x}" cy="${y}" r="0.85" fill="#d9b54a"/><circle cx="${x}" cy="${y}" r="0.45" fill="#1b1b1b"/>`;
    const label = (name, x, y, anchor) => {
      const text = name.replace(/\.\d+$/, '');
      const ground = /GND/.test(text);
      return `<text x="${x}" y="${y + 0.32}" font-size="0.95" fill="${ground ? '#cfe8d6' : '#ffffff'}" text-anchor="${anchor}" class="mono">${escape(text)}</text>`;
    };
    let pins = '';
    LEFT.forEach((n, i) => { const y = Y0 + i * P; pins += pad(X_LEFT, y) + label(n, X_LEFT + 1.4, y, 'start'); });
    RIGHT.forEach((n, i) => { const y = Y0 + i * P; pins += pad(X_RIGHT, y) + label(n, X_RIGHT - 1.4, y, 'end'); });
    const body = `
      <defs><filter id="picoGlow" x="-2" y="-2" width="5" height="5"><feGaussianBlur stdDeviation="0.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
      <rect x="0" y="0" width="${W}" height="${H}" rx="1.1" fill="#0f7a3b"/>
      <rect x="0.35" y="0.35" width="${W - 0.7}" height="${H - 0.7}" rx="0.9" fill="none" stroke="#0b5c2c" stroke-width="0.3"/>
      <rect x="${W / 2 - 4}" y="-1.3" width="8" height="5.6" rx="0.6" fill="#c9cbcf" stroke="#8d9096" stroke-width="0.25"/>
      <rect x="${W / 2 - 3}" y="-0.6" width="6" height="1.4" rx="0.3" fill="#6f7277"/>
      <rect x="${W / 2 - 3.5}" y="19.5" width="7" height="7" rx="0.4" fill="#1d1d1f"/>
      <text x="${W / 2}" y="22.6" font-size="1.05" fill="#c8c8cc" text-anchor="middle">RP2040</text>
      <text x="${W / 2}" y="24.2" font-size="0.7" fill="#8a8a90" text-anchor="middle">Raspberry Pi</text>
      <rect x="${W / 2 - 2.6}" y="32" width="5.2" height="4.2" rx="0.3" fill="#1d1d1f"/>
      <rect x="${W / 2 - 1.9}" y="9.2" width="3.8" height="3.8" rx="0.4" fill="#f2f2f2" stroke="#bfbfbf" stroke-width="0.25"/>
      <circle cx="${W / 2}" cy="11.1" r="1.15" fill="#e4e4e4"/>
      <text x="${W / 2}" y="14.6" font-size="0.85" fill="#ffffff" text-anchor="middle">BOOTSEL</text>
      <rect class="led" x="${W / 2 + 3.4}" y="5.6" width="1.6" height="1.1" rx="0.2" fill="#2f4a2c"/>
      <text x="${W / 2 + 4.2}" y="8" font-size="0.7" fill="#ffffff" text-anchor="middle">LED</text>
      <text x="${W / 2}" y="${H - 2.6}" font-size="1.5" font-weight="700" fill="#ffffff" text-anchor="middle">Pico</text>
      ${pins}`;
    return { width: W, height: H, body };
  }
}
