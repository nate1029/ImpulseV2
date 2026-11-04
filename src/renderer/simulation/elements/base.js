// Base for parts drawn by Impulse. Geometry is in millimetres (like
// @wokwi/elements); pins sit on the 0.1" (2.54 mm) grid so parts plug into
// breadboards. pinInfo is reported in CSS pixels at 96 dpi.

export const MM = 96 / 25.4;
export const P = 2.54;
export const px = (mm) => Math.round(mm * MM * 100) / 100;

export class ImpulseElement extends HTMLElement {
  /** Attributes that trigger a redraw. */
  static get observedAttributes() { return []; }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback() {
    if (!this.isConnected) return;
    this.render();
    this.dispatchEvent(new Event('pininfo-change'));
  }

  /** Subclasses return { width, height (mm), body (svg markup) }. */
  draw() {
    return { width: 10, height: 10, body: '' };
  }

  render() {
    const { width, height, body } = this.draw();
    this.shadowRoot.innerHTML = `<style>
      :host { display: inline-block; line-height: 0; }
      svg { display: block; overflow: visible; }
      text { font-family: 'Inter', 'Helvetica Neue', Arial, sans-serif; user-select: none; }
      .mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
    </style><svg width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
    this.afterRender?.();
  }

  /** [{ name, x, y }] in mm → pinInfo in px. */
  static pins(list) {
    return list.map(p => ({ name: p.name, x: px(p.x), y: px(p.y), signals: p.signals || [] }));
  }
}

/** A silver lead from (x, y1) to (x, y2). */
export function lead(x, y1, y2, w = 0.5) {
  const top = Math.min(y1, y2);
  return `<rect x="${x - w / 2}" y="${top}" width="${w}" height="${Math.abs(y2 - y1)}" fill="#c9cbcf" rx="0.12"/>`;
}

/** A header pin (square gold pad) centered at (x, y). */
export function headerPin(x, y) {
  return `<rect x="${x - 0.75}" y="${y - 0.75}" width="1.5" height="1.5" rx="0.2" fill="#1e1e1e"/><rect x="${x - 0.32}" y="${y - 0.32}" width="0.64" height="0.64" fill="#d9b54a"/>`;
}

export const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
