// Arduino Leonardo: the Uno R3's shape and header, with the ATmega32U4 (a
// square QFN chip) instead of the Uno's DIP ATmega328P, and its own name.

import { ArduinoUnoElement } from '@wokwi/elements';

const SVG = 'http://www.w3.org/2000/svg';

export class LeonardoElement extends ArduinoUnoElement {
  updated(changed) {
    super.updated?.(changed);
    const root = this.shadowRoot;
    if (!root || root.querySelector('.leonardo-chip')) return;
    const label = [...root.querySelectorAll('text')].find(t => t.textContent.trim() === 'UNO');
    if (label) {
      label.textContent = 'LEONARDO';
      label.setAttribute('x', '45.7');
      label.setAttribute('y', '15.6');
      label.setAttribute('style', 'font-size:1.95px; font-weight:700');
    }
    // The DIP chip's outline path starts at m64.932 41.627 (see arduino-uno-element).
    const dip = [...root.querySelectorAll('path')].find(p => (p.getAttribute('d') || '').startsWith('m64.932 41.627'));
    const svg = root.querySelector('svg');
    if (dip?.parentNode && svg) {
      dip.parentNode.setAttribute('display', 'none');
      const g = document.createElementNS(SVG, 'g');
      g.setAttribute('class', 'leonardo-chip');
      g.innerHTML = `
        <rect x="43.2" y="32.4" width="8.6" height="8.6" rx="0.5" fill="#26292b" transform="rotate(45 47.5 36.7)"/>
        <rect x="44" y="33.2" width="7" height="7" rx="0.4" fill="#3c4042" transform="rotate(45 47.5 36.7)"/>
        <circle cx="47.5" cy="33.6" r="0.35" fill="#252728"/>
        <text x="47.5" y="37.2" text-anchor="middle" style="font-size:1.05px; fill:#c8c8cc; font-weight:600">32U4</text>`;
      svg.appendChild(g);
    }
  }
}
