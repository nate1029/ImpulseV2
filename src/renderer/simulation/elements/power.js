// Power and passive parts drawn by Impulse: battery, diode, capacitor and an
// N-channel MOSFET in a TO-220 package.

import { ImpulseElement, P, lead, escape } from './base.js';

/** Battery with a red and a black lead ending in two pins 0.1" apart. */
export class BatteryElement extends ImpulseElement {
  static get observedAttributes() { return ['voltage']; }

  get pinInfo() {
    return ImpulseElement.pins([{ name: '+', x: 7.23, y: 1.27 }, { name: '-', x: 7.23 + P, y: 1.27 }]);
  }

  draw() {
    const volts = Number(this.getAttribute('voltage')) || 9;
    const label = `${volts}V`;
    const kind = volts === 9 ? '9V BATTERY' : volts === 3.7 ? 'Li-ion' : volts === 12 ? '12V PACK' : `${Math.round(volts / 1.5)}× AA`;
    const body = `
      <path d="M 7.23 1.27 C 7.23 4, 5.6 4.2, 5.6 7.2" fill="none" stroke="#d6453d" stroke-width="0.7" stroke-linecap="round"/>
      <path d="M ${7.23 + P} 1.27 C ${7.23 + P} 4, 11.3 4.2, 11.3 7.2" fill="none" stroke="#2b2b2b" stroke-width="0.7" stroke-linecap="round"/>
      <circle cx="7.23" cy="1.27" r="0.55" fill="#c9cbcf"/><circle cx="${7.23 + P}" cy="1.27" r="0.55" fill="#c9cbcf"/>
      <rect x="4.1" y="6.8" width="3" height="1.9" rx="0.4" fill="#9a9ea6"/>
      <rect x="9.8" y="6.8" width="3" height="1.9" rx="0.5" fill="#9a9ea6"/>
      <rect x="1" y="8.4" width="15" height="21.6" rx="1.2" fill="#24262b"/>
      <rect x="1" y="20.4" width="15" height="9.6" rx="1.2" fill="#c9962e"/>
      <rect x="1" y="20.4" width="15" height="1.4" fill="#c9962e"/>
      <text x="8.5" y="15.4" font-size="4" fill="#f2f3f5" text-anchor="middle" font-weight="700">${escape(label)}</text>
      <text x="8.5" y="18.4" font-size="1.35" fill="#a6abb3" text-anchor="middle" letter-spacing="0.08">${escape(kind)}</text>
      <text x="4.6" y="11.2" font-size="2" fill="#f2f3f5" text-anchor="middle">+</text>
      <text x="12.4" y="11.2" font-size="2" fill="#f2f3f5" text-anchor="middle">−</text>`;
    return { width: 17, height: 30.4, body };
  }
}

/** Axial diode, anode on the left; the band marks the cathode. */
export class DiodeElement extends ImpulseElement {
  static get observedAttributes() { return ['type']; }

  get pinInfo() {
    return ImpulseElement.pins([{ name: 'A', x: 0, y: 1.5 }, { name: 'C', x: 4 * P, y: 1.5 }]);
  }

  set conducting(v) {
    this._on = !!v;
    this.shadowRoot?.querySelector('#flow')?.setAttribute('opacity', this._on ? '1' : '0');
  }

  draw() {
    const glass = this.getAttribute('type') === '1N4148';
    const w = 4 * P;
    const bodyFill = glass ? 'rgba(232,140,60,0.85)' : '#1d1d1f';
    const band = glass ? '#202020' : '#c9cbcf';
    const body = `
      <rect x="0" y="1.25" width="${w}" height="0.5" fill="#c9cbcf" rx="0.12"/>
      <rect x="2.6" y="0.1" width="${w - 5.2}" height="2.8" rx="0.6" fill="${bodyFill}"/>
      <rect x="${w - 3.9}" y="0.1" width="0.75" height="2.8" fill="${band}"/>
      <path id="flow" d="M 4.3 1.5 h 1.6 m -0.6 -0.55 l 0.6 0.55 l -0.6 0.55" stroke="#30d158" stroke-width="0.3" fill="none" opacity="${this._on ? 1 : 0}"/>`;
    return { width: w, height: 3, body };
  }
}

/** Ceramic disc or electrolytic capacitor on two legs 0.1" apart. */
export class CapacitorElement extends ImpulseElement {
  static get observedAttributes() { return ['type', 'value']; }

  get pinInfo() {
    return ImpulseElement.pins([{ name: '1', x: 1.27, y: 11.4 }, { name: '2', x: 1.27 + P, y: 11.4 }]);
  }

  draw() {
    const electrolytic = this.getAttribute('type') === 'electrolytic';
    const value = this.getAttribute('value') || (electrolytic ? '10µF' : '100nF');
    const w = 2 * 1.27 + P;
    const legs = `${lead(1.27, 5.6, 11.8, 0.42)}${lead(1.27 + P, 5.6, 11.8, 0.42)}`;
    if (electrolytic) {
      return {
        width: w, height: 12,
        body: `${legs}
          <rect x="-0.2" y="0" width="${w + 0.4}" height="6.6" rx="0.9" fill="#1f4f9c"/>
          <rect x="${w - 1.4}" y="0" width="1.2" height="6.6" fill="#9db8e6"/>
          <text x="${w - 0.8}" y="2.2" font-size="1.3" fill="#1f4f9c" text-anchor="middle" font-weight="700">−</text>
          <text x="${w / 2 - 0.4}" y="4.2" font-size="1.05" fill="#e8eefc" text-anchor="middle" transform="rotate(-90 ${w / 2 - 0.4} 3.8)">${escape(value)}</text>
          <text x="0.9" y="8.6" font-size="1.4" fill="#9da3ab" text-anchor="middle">+</text>`,
      };
    }
    return {
      width: w, height: 12,
      body: `${legs}
        <ellipse cx="${w / 2}" cy="3.2" rx="${w / 2 + 0.3}" ry="3" fill="#d08a3c"/>
        <ellipse cx="${w / 2 - 0.5}" cy="2.6" rx="1.2" ry="0.8" fill="#e6a65c" opacity="0.6"/>
        <text x="${w / 2}" y="3.8" font-size="1.15" fill="#3b2410" text-anchor="middle">${escape(value.replace(/nF$/, 'n').replace(/µF$/, 'µ'))}</text>`,
    };
  }
}

/** N-channel MOSFET in a TO-220 package: gate, drain, source. */
export class MosfetElement extends ImpulseElement {
  static get observedAttributes() { return ['label']; }

  get pinInfo() {
    return ImpulseElement.pins(['G', 'D', 'S'].map((name, i) => ({ name, x: 2.54 + i * P, y: 19 })));
  }

  set on(v) {
    this._on = !!v;
    this.shadowRoot?.querySelector('#state')?.setAttribute('fill', this._on ? '#30d158' : '#3a3d42');
  }

  draw() {
    const w = 10.16;
    const legs = [0, 1, 2].map(i => lead(2.54 + i * P, 12.4, 19.4, 0.7)).join('');
    const names = ['G', 'D', 'S'].map((n, i) => `<text x="${2.54 + i * P}" y="14.6" font-size="1" fill="#8a8f98" text-anchor="middle">${n}</text>`).join('');
    const body = `
      ${legs}
      <rect x="0" y="0" width="${w}" height="6.2" rx="0.4" fill="#c4c7cc"/>
      <circle cx="${w / 2}" cy="2.9" r="1.7" fill="#23252a"/>
      <rect x="0" y="5.6" width="${w}" height="7.4" rx="0.3" fill="#1f2023"/>
      <text x="${w / 2}" y="8.9" font-size="1.25" fill="#e7e9ec" text-anchor="middle" font-weight="600">${escape(this.getAttribute('label') || 'IRLZ44N')}</text>
      <circle id="state" cx="${w / 2}" cy="11.2" r="0.55" fill="${this._on ? '#30d158' : '#3a3d42'}"/>
      ${names}`;
    return { width: w, height: 19.6, body };
  }
}
