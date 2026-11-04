// Solderless breadboards: full (830), half (400) and mini (170) points.
// Pin names follow Wokwi: "12t.c" (column 12, top half, row c),
// "12b.h" (bottom half), rails "tn.1"/"tp.1"/"bp.1"/"bn.1".

import { ImpulseElement, px } from './base.js';
import { breadboardLayout } from '../parts/modules.js';

const TOP = ['a', 'b', 'c', 'd', 'e'];
const BOTTOM = ['f', 'g', 'h', 'i', 'j'];
const layout = breadboardLayout;

export class BreadboardElement extends ImpulseElement {
  static get observedAttributes() { return ['size']; }

  get size() { return this.getAttribute('size') || 'full'; }

  get pinInfo() {
    const L = layout(this.size);
    const out = [];
    for (let c = 1; c <= L.spec.cols; c++) {
      for (const r of TOP) out.push({ name: `${c}t.${r}`, x: px(L.colX(c)), y: px(L.rowY[r]), signals: [] });
      for (const r of BOTTOM) out.push({ name: `${c}b.${r}`, x: px(L.colX(c)), y: px(L.rowY[r]), signals: [] });
    }
    if (L.rails) {
      for (const rail of ['tn', 'tp', 'bp', 'bn']) {
        for (let k = 1; k <= L.spec.rail; k++) out.push({ name: `${rail}.${k}`, x: px(L.railX(k)), y: px(L.railY[rail]), signals: [] });
      }
    }
    return out;
  }

  draw() {
    const L = layout(this.size);
    const { width, height, rowY, railY } = L;
    const hole = (x, y) => `<rect x="${(x - 0.55).toFixed(2)}" y="${(y - 0.55).toFixed(2)}" width="1.1" height="1.1" rx="0.18"/>`;
    let holes = '';
    for (let c = 1; c <= L.spec.cols; c++) {
      const x = L.colX(c);
      for (const r of [...TOP, ...BOTTOM]) holes += hole(x, rowY[r]);
    }
    let rails = '';
    if (L.rails) {
      for (const rail of ['tn', 'tp', 'bp', 'bn']) for (let k = 1; k <= L.spec.rail; k++) holes += hole(L.railX(k), railY[rail]);
      const x1 = L.railX(1) - 1.4;
      const x2 = L.railX(L.spec.rail) + 1.4;
      const line = (y, color) => `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${color}" stroke-width="0.35" stroke-linecap="round"/>`;
      rails += line(railY.tn - 1.55, '#2f6fd6') + line(railY.tp + 1.55, '#d8413a');
      rails += line(railY.bp - 1.55, '#d8413a') + line(railY.bn + 1.55, '#2f6fd6');
      const sign = (x, y, s, color) => `<text x="${x}" y="${y + 0.62}" font-size="2" fill="${color}" text-anchor="middle" font-weight="600">${s}</text>`;
      for (const x of [1.6, width - 1.6]) {
        rails += sign(x, railY.tn, '−', '#2f6fd6') + sign(x, railY.tp, '+', '#d8413a');
        rails += sign(x, railY.bp, '+', '#d8413a') + sign(x, railY.bn, '−', '#2f6fd6');
      }
    }
    let labels = '';
    for (const r of [...TOP, ...BOTTOM]) {
      labels += `<text x="1.7" y="${rowY[r] + 0.55}" font-size="1.45" text-anchor="middle">${r}</text>`;
      labels += `<text x="${width - 1.7}" y="${rowY[r] + 0.55}" font-size="1.45" text-anchor="middle">${r}</text>`;
    }
    for (let c = 1; c <= L.spec.cols; c++) {
      if (c !== 1 && c % 5 !== 0) continue;
      labels += `<text x="${L.colX(c)}" y="${rowY.a - 1.45}" font-size="1.3" text-anchor="middle">${c}</text>`;
      labels += `<text x="${L.colX(c)}" y="${rowY.j + 2.5}" font-size="1.3" text-anchor="middle">${c}</text>`;
    }
    const channelTop = rowY.e + 1.6;
    const channelBottom = rowY.f - 1.6;
    const body = `
      <defs>
        <linearGradient id="bbBody" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#fbfaf7"/><stop offset="1" stop-color="#eeece6"/>
        </linearGradient>
      </defs>
      <rect x="0.15" y="0.15" width="${width - 0.3}" height="${height - 0.3}" rx="1.2" fill="url(#bbBody)" stroke="#d6d3cb" stroke-width="0.3"/>
      <rect x="0.8" y="${channelTop}" width="${width - 1.6}" height="${channelBottom - channelTop}" rx="0.4" fill="#e3e0d8"/>
      ${rails}
      <g fill="#3b3a37">${holes}</g>
      <g fill="#a29f96">${labels}</g>`;
    return { width: +width.toFixed(2), height: +height.toFixed(2), body };
  }
}
