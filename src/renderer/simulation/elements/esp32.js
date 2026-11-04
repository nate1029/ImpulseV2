// ESP32 development boards drawn by Impulse: Espressif's ESP32-S3-DevKitC-1
// and ESP32-C3-DevKitM-1 (pin tables from their user guides), and the Arduino
// Nano ESP32 (the Nano drawing, with its own tag). The ESP32 DevKit V1 comes
// from @wokwi/elements.

import { ArduinoNanoElement } from '@wokwi/elements';
import { ImpulseElement, P, escape } from './base.js';

/**
 * A DevKit: two header rows 0.9" apart, the module (with its antenna) at the
 * top, USB at the bottom, power and RGB LEDs, BOOT and RST buttons.
 */
class DevKitElement extends ImpulseElement {
  /** @returns {{ left: string[], right: string[], module: string, title: string }} */
  get spec() { throw new Error('spec'); }

  /** Rows 0.9" apart with the labels outside them, the module between them. */
  get geometry() {
    const rows = this.spec.left.length;
    const W = 9 * P + 9.2;
    const y0 = 3.4;
    const last = y0 + (rows - 1) * P;
    return { W, H: last + 13.4, xl: 4.6, xr: W - 4.6, y0, last };
  }

  get pinInfo() {
    const { left, right } = this.spec;
    const { xl, xr, y0 } = this.geometry;
    return ImpulseElement.pins([
      ...left.map((name, i) => ({ name, x: xl, y: y0 + i * P })),
      ...right.map((name, i) => ({ name, x: xr, y: y0 + i * P })),
    ]);
  }

  /** The RGB LED's colour, [r, g, b] (0–255), or null when it's off. */
  set rgb(c) {
    this._rgb = Array.isArray(c) && c.some(v => v > 0) ? c.slice(0, 3) : null;
    this._paintLeds();
  }

  get rgb() { return this._rgb || null; }

  set ledPower(on) {
    this._power = !!on;
    this._paintLeds();
  }

  get ledPower() { return !!this._power; }

  // Board elements share these properties; these boards have no plain LED or TX/RX LEDs.
  set led13(_on) { /* none */ }
  set ledTX(_on) { /* none */ }
  set ledRX(_on) { /* none */ }

  afterRender() {
    this._rgbEl = this.shadowRoot.querySelector('.rgb');
    this._pwrEl = this.shadowRoot.querySelector('.pwr');
    this._paintLeds();
  }

  _paintLeds() {
    if (this._rgbEl) {
      const c = this._rgb;
      // Scale up so dim colours (a WS2812 at 10/255) still read as lit.
      const k = c ? 255 / Math.max(...c, 1) : 0;
      const fill = c ? `rgb(${c.map(v => Math.round(Math.min(255, v * k * 0.9 + (v > 0 ? 25 : 0)))).join(',')})` : '#e8e8e8';
      this._rgbEl.setAttribute('fill', fill);
      this._rgbEl.setAttribute('filter', c ? 'url(#espGlow)' : '');
    }
    if (this._pwrEl) {
      this._pwrEl.setAttribute('fill', this._power ? '#ff4d4d' : '#5a2a2a');
      this._pwrEl.setAttribute('filter', this._power ? 'url(#espGlow)' : '');
    }
  }

  draw() {
    const { left, right, module, title } = this.spec;
    const { W, H, xl, xr, y0, last } = this.geometry;
    const pad = (x, y) => `<circle cx="${x}" cy="${y}" r="0.85" fill="#d9b54a"/><circle cx="${x}" cy="${y}" r="0.42" fill="#141414"/>`;
    const label = (name, x, y, anchor) => {
      const text = name.replace(/\.\d+$/, '');
      const muted = /^(GND|3V3|5V|RST)$/.test(text);
      return `<text x="${x}" y="${y + 0.33}" font-size="0.95" fill="${muted ? '#b9c4d0' : '#ffffff'}" text-anchor="${anchor}" class="mono">${escape(text)}</text>`;
    };
    let pins = '';
    left.forEach((n, i) => { const y = y0 + i * P; pins += pad(xl, y) + label(n, xl - 1.3, y, 'end'); });
    right.forEach((n, i) => { const y = y0 + i * P; pins += pad(xr, y) + label(n, xr + 1.3, y, 'start'); });
    const mw = 15.6;
    const mx = W / 2 - mw / 2;
    const antenna = Array.from({ length: 5 }, (_, i) => `<path d="M ${mx + 2 + i * 2.5} 1.6 v 2.6 h 1.2 v -2.6" fill="none" stroke="#c9a63a" stroke-width="0.3"/>`).join('');
    const yb = last + 2.6; // below the headers: LEDs, buttons, USB
    const usbY = H - 3.4;
    const body = `
      <defs><filter id="espGlow" x="-2" y="-2" width="5" height="5"><feGaussianBlur stdDeviation="0.45" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
      <rect x="0" y="0" width="${W}" height="${H}" rx="1.1" fill="#1c1d21"/>
      <rect x="0.35" y="0.35" width="${W - 0.7}" height="${H - 0.7}" rx="0.9" fill="none" stroke="#2c2e34" stroke-width="0.3"/>
      <rect x="${mx}" y="0.8" width="${mw}" height="21" rx="0.5" fill="#26282d" stroke="#3a3d44" stroke-width="0.25"/>
      ${antenna}
      <rect x="${mx + 0.8}" y="6" width="${mw - 1.6}" height="15" rx="0.4" fill="#b8bcc4" stroke="#8f949c" stroke-width="0.25"/>
      <text x="${W / 2}" y="12.6" font-size="1.2" font-weight="700" fill="#2d3036" text-anchor="middle">${escape(module)}</text>
      <text x="${W / 2}" y="14.5" font-size="0.75" fill="#4a4e56" text-anchor="middle">Espressif</text>
      <text x="${W / 2}" y="${(22 + last) / 2 + 0.6}" font-size="1.7" font-weight="700" fill="#ffffff" text-anchor="middle">${escape(title)}</text>
      <rect class="rgb" x="${W / 2 - 1.1}" y="${yb}" width="2.2" height="2.2" rx="0.35" fill="#e8e8e8" stroke="#9a9a9a" stroke-width="0.2"/>
      <text x="${W / 2}" y="${yb + 3.2}" font-size="0.7" fill="#b9c4d0" text-anchor="middle">RGB</text>
      <rect class="pwr" x="${W / 2 + 4}" y="${yb + 0.6}" width="1.4" height="1" rx="0.2" fill="#5a2a2a"/>
      <text x="${W / 2 + 4.7}" y="${yb + 3.2}" font-size="0.6" fill="#b9c4d0" text-anchor="middle">PWR</text>
      <rect x="${W / 2 - 9.6}" y="${yb + 4.2}" width="2.6" height="2" rx="0.3" fill="#d6d6d6"/><circle cx="${W / 2 - 8.3}" cy="${yb + 5.2}" r="0.6" fill="#3a3a3a"/>
      <text x="${W / 2 - 8.3}" y="${yb + 7.4}" font-size="0.6" fill="#b9c4d0" text-anchor="middle">BOOT</text>
      <rect x="${W / 2 + 7}" y="${yb + 4.2}" width="2.6" height="2" rx="0.3" fill="#d6d6d6"/><circle cx="${W / 2 + 8.3}" cy="${yb + 5.2}" r="0.6" fill="#3a3a3a"/>
      <text x="${W / 2 + 8.3}" y="${yb + 7.4}" font-size="0.6" fill="#b9c4d0" text-anchor="middle">RST</text>
      <rect x="${W / 2 - 2}" y="${usbY}" width="4" height="4.6" rx="0.8" fill="#c9cbcf" stroke="#8d9096" stroke-width="0.25"/>
      <rect x="${W / 2 - 1.3}" y="${usbY + 1.4}" width="2.6" height="1.2" rx="0.5" fill="#55585e"/>
      ${pins}`;
    return { width: W, height: H, body };
  }
}

// ESP32-S3-DevKitC-1 v1.0 user guide, "Header Block": J1 down the left, J3 down the right.
const S3_LEFT = ['3V3', '3V3.2', 'RST', '4', '5', '6', '7', '15', '16', '17', '18', '8', '3', '46', '9', '10', '11', '12', '13', '14', '5V', 'GND'];
const S3_RIGHT = ['GND.2', 'TX', 'RX', '1', '2', '42', '41', '40', '39', '38', '37', '36', '35', '0', '45', '48', '47', '21', '20', '19', 'GND.3', 'GND.4'];

export class Esp32S3DevKitElement extends DevKitElement {
  static LEFT = S3_LEFT;
  static RIGHT = S3_RIGHT;
  get spec() {
    return { left: S3_LEFT, right: S3_RIGHT, module: 'ESP32-S3-WROOM-1', title: 'ESP32-S3' };
  }
}

// ESP32-C3-DevKitM-1 user guide, "Header Block".
const C3_LEFT = ['GND', '3V3', '3V3.2', '2', '3', 'GND.2', 'RST', 'GND.3', '0', '1', '10', 'GND.4', '5V', '5V.2', 'GND.5'];
const C3_RIGHT = ['GND.6', 'TX', 'RX', 'GND.7', '9', '8', 'GND.8', '7', '6', '5', '4', 'GND.9', '18', '19', 'GND.10'];

export class Esp32C3DevKitElement extends DevKitElement {
  static LEFT = C3_LEFT;
  static RIGHT = C3_RIGHT;
  get spec() {
    return { left: C3_LEFT, right: C3_RIGHT, module: 'ESP32-C3-MINI-1', title: 'ESP32-C3' };
  }
}

/** Arduino Nano ESP32: the Nano's shape and header, an ESP32-S3 inside. */
export class NanoEsp32Element extends ArduinoNanoElement {}
