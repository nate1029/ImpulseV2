// ICs and small components: DIP chips (74HC595, L293D, ATtiny85), TO-92
// parts (LM35, NPN transistor), A4988 driver carrier, LDR, reed switch.

import { ImpulseElement, P, lead, headerPin, escape } from './base.js';

const DIP_PIN_X = (i) => 1.27 + i * P;
const DIP_TOP_Y = 1.0;
const DIP_BOTTOM_Y = DIP_TOP_Y + 3 * P;

/**
 * DIP chip drawn notch-left; `top` lists the upper row left to right (pins
 * 16→9 on a DIP-16), `bottom` the lower row from pin 1.
 */
class DipElement extends ImpulseElement {
  get chipName() { return ''; }
  get topPins() { return []; }
  get bottomPins() { return []; }

  get pinInfo() {
    return ImpulseElement.pins([
      ...this.topPins.map((name, i) => ({ name, x: DIP_PIN_X(i), y: DIP_TOP_Y })),
      ...this.bottomPins.map((name, i) => ({ name, x: DIP_PIN_X(i), y: DIP_BOTTOM_Y })),
    ]);
  }

  get nameSize() { return 1.55; }

  draw() {
    const n = this.bottomPins.length;
    const width = n * P;
    const height = DIP_BOTTOM_Y + 1.0;
    let leads = '';
    for (let i = 0; i < n; i++) {
      leads += lead(DIP_PIN_X(i), DIP_TOP_Y - 0.4, 2.7, 0.55);
      leads += lead(DIP_PIN_X(i), DIP_BOTTOM_Y + 0.4, DIP_BOTTOM_Y - 1.7, 0.55);
    }
    const label = (name, i, y, anchor) => `<text x="${DIP_PIN_X(i)}" y="${y}" font-size="0.82" fill="#9da3ab" text-anchor="middle" dominant-baseline="${anchor}">${escape(name.replace(/\.\d+$/, ''))}</text>`;
    let labels = '';
    this.topPins.forEach((n, i) => { labels += label(n, i, 3.35, 'hanging'); });
    this.bottomPins.forEach((n, i) => { labels += label(n, i, DIP_BOTTOM_Y - 2.35, 'auto'); });
    const body = `
      ${leads}
      <rect x="0.25" y="2.55" width="${width - 0.5}" height="${DIP_BOTTOM_Y - 2.55 - 1.55}" rx="0.5" fill="#232427"/>
      <path d="M 0.25 ${(DIP_TOP_Y + DIP_BOTTOM_Y) / 2 - 0.9} a 0.9 0.9 0 0 1 0 1.8" fill="#151517"/>
      <circle cx="1.4" cy="${DIP_BOTTOM_Y - 2.55}" r="0.35" fill="#151517"/>
      ${labels}
      <text x="${width / 2}" y="${(DIP_TOP_Y + DIP_BOTTOM_Y) / 2 + 0.55}" font-size="${this.nameSize}" fill="#e7e9ec" text-anchor="middle" font-weight="600" letter-spacing="0.05">${escape(this.chipName)}</text>`;
    return { width, height, body };
  }
}

export class HC595Element extends DipElement {
  get chipName() { return '74HC595'; }
  get topPins() { return ['VCC', 'Q0', 'DS', 'OE', 'STCP', 'SHCP', 'MR', 'Q7S']; }
  get bottomPins() { return ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'GND']; }
}

export class L293DElement extends DipElement {
  get chipName() { return 'L293D'; }
  get topPins() { return ['VSS', 'IN4', 'OUT4', 'GND.4', 'GND.3', 'OUT3', 'IN3', 'EN2']; }
  get bottomPins() { return ['EN1', 'IN1', 'OUT1', 'GND.1', 'GND.2', 'OUT2', 'IN2', 'VS']; }
}

/** ATtiny85 in DIP-8: pin 1 is PB5 (RESET), pin 4 GND, pin 8 VCC. */
export class Attiny85Element extends DipElement {
  get chipName() { return 'ATtiny85'; }
  get nameSize() { return 1.3; }
  get topPins() { return ['VCC', 'PB2', 'PB1', 'PB0']; }
  get bottomPins() { return ['PB5', 'PB3', 'PB4', 'GND']; }
}

/** TO-92 package seen from the flat face, legs down. */
class To92Element extends ImpulseElement {
  static get observedAttributes() { return ['label']; }
  get partName() { return ''; }
  get legNames() { return []; }

  get pinInfo() {
    return ImpulseElement.pins(this.legNames.map((name, i) => ({ name, x: 1.27 + i * P, y: 11.4 })));
  }

  draw() {
    const width = 3 * P;
    const legs = [0, 1, 2].map(i => lead(1.27 + i * P, 5.4, 11.8, 0.45)).join('');
    const names = this.legNames.map((n, i) => `<text x="${1.27 + i * P}" y="7.4" font-size="0.9" fill="#8a8f98" text-anchor="middle">${escape(n)}</text>`).join('');
    const body = `
      ${legs}
      <path d="M 0.4 5.6 L 0.4 2.4 A 3.41 3.0 0 0 1 7.22 2.4 L 7.22 5.6 Z" fill="#202124"/>
      <rect x="0.4" y="4.9" width="6.82" height="0.7" fill="#2c2d31"/>
      <text x="${width / 2}" y="3.9" font-size="1.12" fill="#e7e9ec" text-anchor="middle" font-weight="600">${escape(this.getAttribute('label') || this.partName)}</text>
      ${names}`;
    return { width, height: 12, body };
  }
}

export class Lm35Element extends To92Element {
  get partName() { return 'LM35'; }
  get legNames() { return ['VS', 'VOUT', 'GND']; }
}

export class Ds18b20Element extends To92Element {
  get partName() { return 'DS18B20'; }
  get legNames() { return ['GND', 'DQ', 'VCC']; }
}

export class NpnElement extends To92Element {
  get partName() { return '2N2222'; }
  get legNames() { return ['E', 'B', 'C']; }
}

/** Pololu-style A4988 carrier, pins in two rows five pitches apart. */
export class A4988Element extends ImpulseElement {
  static TOP = ['ENABLE', 'MS1', 'MS2', 'MS3', 'RESET', 'SLEEP', 'STEP', 'DIR'];
  static BOTTOM = ['VMOT', 'GND', '2B', '2A', '1A', '1B', 'VDD', 'GND.2'];

  get pinInfo() {
    return ImpulseElement.pins([
      ...A4988Element.TOP.map((name, i) => ({ name, x: 1.27 + i * P, y: 1.27 })),
      ...A4988Element.BOTTOM.map((name, i) => ({ name, x: 1.27 + i * P, y: 1.27 + 5 * P })),
    ]);
  }

  draw() {
    const width = 8 * P;
    const height = 2.54 + 5 * P;
    let pins = '';
    const label = (n, i, y) => `<text x="${1.27 + i * P}" y="${y}" font-size="0.78" fill="#d9f2e3" text-anchor="middle">${escape(n.replace(/\.\d+$/, ''))}</text>`;
    A4988Element.TOP.forEach((n, i) => { pins += headerPin(1.27 + i * P, 1.27) + label(n, i, 3.15); });
    A4988Element.BOTTOM.forEach((n, i) => { pins += headerPin(1.27 + i * P, 1.27 + 5 * P) + label(n, i, 1.27 + 5 * P - 1.35); });
    const body = `
      <rect x="0" y="0" width="${width}" height="${height}" rx="0.6" fill="#1d6b45"/>
      <rect x="6.6" y="5.0" width="5.4" height="5.4" rx="0.3" fill="#1b1b1d"/>
      <text x="9.3" y="8.0" font-size="1.0" fill="#cfd3d8" text-anchor="middle" class="mono">A4988</text>
      <circle cx="15.6" cy="7.7" r="1.35" fill="#d7d7d7" stroke="#9a9a9a" stroke-width="0.2"/>
      <path d="M 15.0 7.7 h 1.2" stroke="#6b6b6b" stroke-width="0.3"/>
      <rect x="2.2" y="5.6" width="2.6" height="1.4" rx="0.2" fill="#c8a24a"/>
      <rect x="2.2" y="8.4" width="2.6" height="1.4" rx="0.2" fill="#c8a24a"/>
      ${pins}`;
    return { width, height, body };
  }
}

/** Bare photoresistor (CdS cell) with two legs 0.2" apart. */
export class LdrElement extends ImpulseElement {
  get pinInfo() {
    return ImpulseElement.pins([{ name: '1', x: 1.27, y: 11.4 }, { name: '2', x: 1.27 + 2 * P, y: 11.4 }]);
  }

  draw() {
    const track = 'M 1.9 2.1 h 3.8 v 0.75 h -3.8 v 0.75 h 3.8 v 0.75 h -3.8 v 0.75 h 3.8';
    const body = `
      ${lead(1.27, 5.0, 11.8, 0.45)}${lead(1.27 + 2 * P, 5.0, 11.8, 0.45)}
      <ellipse cx="3.81" cy="3.25" rx="3.35" ry="3.0" fill="#e8dcc0" stroke="#b9a678" stroke-width="0.25"/>
      <path d="${track}" fill="none" stroke="#c4572f" stroke-width="0.42" stroke-linejoin="round"/>`;
    return { width: 7.62, height: 12, body };
  }
}

/** Glass reed switch; blades meet when `closed` is set. */
export class ReedSwitchElement extends ImpulseElement {
  get pinInfo() {
    return ImpulseElement.pins([{ name: '1', x: 1.27, y: 2.54 }, { name: '2', x: 1.27 + 5 * P, y: 2.54 }]);
  }

  set closed(v) {
    this._closed = !!v;
    const blade = this.shadowRoot?.querySelector('#blade2');
    if (blade) blade.setAttribute('transform', this._closed ? 'rotate(0 11.4 2.54)' : 'rotate(-6 11.4 2.54)');
  }

  get closed() { return !!this._closed; }

  draw() {
    const w = 1.27 * 2 + 5 * P;
    const body = `
      <rect x="0.9" y="2.32" width="${w - 1.8}" height="0.44" fill="#c9cbcf"/>
      <rect x="3.0" y="1.1" width="${w - 6}" height="2.9" rx="1.45" fill="rgba(200,225,240,0.55)" stroke="#9fb6c6" stroke-width="0.2"/>
      <rect x="3.6" y="2.36" width="4.6" height="0.36" fill="#8a8f98"/>
      <rect id="blade2" x="6.8" y="2.36" width="4.6" height="0.36" fill="#8a8f98" transform="${this._closed ? 'rotate(0 11.4 2.54)' : 'rotate(-6 11.4 2.54)'}"/>`;
    return { width: w, height: 5.08, body };
  }
}

/** DHT11: the blue sibling of the DHT22, same pinout (VCC, SDA, NC, GND). */
export class Dht11Element extends ImpulseElement {
  get pinInfo() {
    return ImpulseElement.pins(['VCC', 'SDA', 'NC', 'GND'].map((name, i) => ({ name, x: 3.97 + i * P, y: 30.4 })));
  }

  draw() {
    const width = 15.08;
    let grille = '';
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 4; c++) grille += `<rect x="${2.6 + c * 2.6}" y="${3.0 + r * 2.35}" width="1.7" height="1.2" rx="0.25" fill="#1f4f8f"/>`;
    }
    const legs = [0, 1, 2, 3].map(i => lead(3.97 + i * P, 20.6, 31.0, 0.5)).join('');
    const body = `
      ${legs}
      <rect x="0.6" y="0.4" width="${width - 1.2}" height="20.6" rx="1.2" fill="#3a7bd5"/>
      <rect x="1.6" y="1.6" width="${width - 3.2}" height="15.2" rx="0.8" fill="#4d8be0"/>
      ${grille}
      <text x="${width / 2}" y="19.4" font-size="1.9" fill="#eaf2ff" text-anchor="middle" font-weight="600">DHT11</text>`;
    return { width, height: 32.28, body };
  }
}
