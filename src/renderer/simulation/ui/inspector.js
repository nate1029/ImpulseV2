// Inspector: details and controls for the selected part or wire.
//
// Shows what the part is, its live state while the simulation runs, sliders
// and toggles for sensor values, editable properties, where each pin is
// connected, the libraries it needs (with one-click install) and actions.

import { partDef } from '../parts/catalog.js';
import { WIRE_COLORS, cssColor } from '../canvas.js';
import { h, icon, mod } from './dom.js';

const fmt = (v, step) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const decimals = step && step < 1 ? Math.min(3, String(step).split('.')[1]?.length || 1) : 0;
  return n.toFixed(decimals);
};

// Logarithmic sliders (light levels) map 0..1000 onto min..max.
const toLog = (v, min, max) => Math.round((Math.log(v / min) / Math.log(max / min)) * 1000);
const fromLog = (s, min, max) => min * Math.pow(max / min, s / 1000);

export class Inspector {
  /**
   * @param {HTMLElement} host
   * @param {{ canvas, getStatus: (part) => string|null, isRunning: () => boolean,
   *   onAttr: (part, key, value) => void, onControl: (part, key, value) => void,
   *   onAction: (name: string) => void, connectionsOf: (part, pin) => string[],
   *   libraries: () => Promise<Set<string>>, installLibrary: (name) => Promise<boolean> }} opts
   */
  constructor(host, opts) {
    this.opts = opts;
    this.el = h('aside', { class: 'sim-inspector', hidden: true, 'aria-label': 'Inspector' });
    host.appendChild(this.el);
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    this.target = null;
    this._statusEl = null;
  }

  show(selection) {
    const items = [...selection];
    this.target = items.length === 1 ? items[0] : items.length ? items : null;
    this.render();
  }

  render() {
    const t = this.target;
    this.el.innerHTML = '';
    this._statusEl = null;
    if (!t) { this.el.hidden = true; return; }
    this.el.hidden = false;
    if (Array.isArray(t)) this._renderMany(t);
    else if (t.el) this._renderPart(t);
    else this._renderWire(t);
  }

  /** Refresh the live readout (called a few times per second while running). */
  tick() {
    const t = this.target;
    if (!this._statusEl || !t?.el) return;
    const s = this.opts.getStatus(t);
    const running = this.opts.isRunning();
    this._statusEl.hidden = !running || !s;
    if (s) this._statusEl.querySelector('.sim-insp-status-text').textContent = s;
  }

  _header(title, sub, onClose = true) {
    const close = h('button', { type: 'button', class: 'sim-icon-btn', 'aria-label': 'Close inspector', title: 'Close (Esc)' }, icon('close', 14));
    close.addEventListener('click', () => this.opts.canvas.select([]));
    return h('header', { class: 'sim-insp-head' },
      h('div', { class: 'sim-insp-titles' }, h('div', { class: 'sim-insp-title' }, title), sub ? h('div', { class: 'sim-insp-sub' }, sub) : null),
      onClose ? close : null);
  }

  _renderPart(part) {
    const def = partDef(part.type);
    const el = this.el;
    el.append(this._header(def.label, h('span', {}, h('span', { class: 'sim-insp-id' }, part.id), ` · ${def.category}`)));

    const status = h('div', { class: 'sim-insp-status', hidden: true }, h('span', { class: 'sim-live-dot' }), h('span', { class: 'sim-insp-status-text' }));
    this._statusEl = status;
    el.append(status);
    el.append(h('p', { class: 'sim-insp-desc' }, def.description));

    const body = h('div', { class: 'sim-insp-body' });
    el.append(body);

    if (def.controls?.length) {
      body.append(h('div', { class: 'sim-insp-section' }, 'Simulation'));
      for (const c of def.controls) body.append(this._control(part, c, true));
    }
    if (def.props?.length) {
      body.append(h('div', { class: 'sim-insp-section' }, 'Properties'));
      for (const c of def.props) body.append(this._control(part, c, false));
    }

    const pinNames = (part.el.pinInfo || []).map(p => p.name);
    if (pinNames.length && !def.board && def.category !== 'Breadboards') {
      body.append(h('div', { class: 'sim-insp-section' }, 'Pins'));
      const table = h('div', { class: 'sim-insp-pins' });
      for (const pin of pinNames) {
        const conns = this.opts.connectionsOf(part, pin);
        table.append(h('div', { class: `sim-insp-pin${conns.length ? '' : ' open'}` },
          h('span', { class: 'sim-insp-pin-name' }, pin),
          h('span', { class: 'sim-insp-pin-doc' }, def.pins?.[pin] || ''),
          h('span', { class: 'sim-insp-pin-conn', title: conns.join(', ') }, conns.length ? conns.join(', ') : 'not connected')));
      }
      body.append(table);
    }

    if (def.libraries?.length) {
      body.append(h('div', { class: 'sim-insp-section' }, 'Libraries'));
      const libs = h('div', { class: 'sim-insp-libs' });
      body.append(libs);
      this._renderLibraries(def.libraries, libs);
    }

    const actions = h('footer', { class: 'sim-insp-actions' });
    const btn = (name, label, iconName, hint) => {
      const b = h('button', { type: 'button', class: `sim-btn ghost${name === 'delete' ? ' danger' : ''}`, title: hint }, icon(iconName, 14), label);
      b.addEventListener('click', () => this.opts.onAction(name));
      return b;
    };
    actions.append(btn('rotate', 'Rotate', 'rotate', 'Rotate 90° (R)'), btn('duplicate', 'Duplicate', 'duplicate', `Duplicate (${mod}D)`), btn('delete', 'Delete', 'trash', 'Delete (⌫)'));
    el.append(actions);
    this.tick();
  }

  async _renderLibraries(names, container) {
    let installed = new Set();
    try { installed = await this.opts.libraries(); } catch { /* list unavailable */ }
    container.innerHTML = '';
    for (const name of names) {
      const have = installed.has(name.toLowerCase());
      const row = h('div', { class: 'sim-insp-lib' }, h('span', {}, name));
      if (have) {
        row.append(h('span', { class: 'sim-insp-lib-ok' }, icon('check', 13), 'Installed'));
      } else {
        const b = h('button', { type: 'button', class: 'sim-btn small' }, icon('download', 13), 'Install');
        b.addEventListener('click', async () => {
          b.disabled = true;
          b.textContent = 'Installing…';
          const ok = await this.opts.installLibrary(name);
          b.replaceWith(ok ? h('span', { class: 'sim-insp-lib-ok' }, icon('check', 13), 'Installed') : h('span', { class: 'sim-insp-lib-err' }, 'Install failed'));
        });
        row.append(b);
      }
      container.append(row);
    }
  }

  _control(part, c, live) {
    const raw = part.attrs[c.key];
    const def = partDef(part.type);
    const fallback = def.attrs?.[c.key];
    const value = raw ?? fallback ?? (c.type === 'range' ? c.min : '');
    const commit = (v) => (live ? this.opts.onControl(part, c.key, v) : this.opts.onAttr(part, c.key, v));
    const row = h('label', { class: `sim-insp-row type-${c.type}` }, h('span', { class: 'sim-insp-label' }, c.label));

    if (c.type === 'range') {
      const out = h('output', { class: 'sim-insp-value' }, `${fmt(value, c.step)}${c.unit ? ` ${c.unit}` : ''}`);
      const input = h('input', { type: 'range', min: c.log ? 0 : c.min, max: c.log ? 1000 : c.max, step: c.log ? 1 : c.step, value: c.log ? toLog(Number(value), c.min, c.max) : value });
      const number = h('input', { type: 'number', class: 'sim-insp-number', min: c.min, max: c.max, step: c.step, value: fmt(value, c.step), 'aria-label': `${c.label} value` });
      const apply = (v, from) => {
        const n = Math.max(c.min, Math.min(c.max, Number(v)));
        if (!Number.isFinite(n)) return;
        const shown = c.log ? (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10) : n;
        out.textContent = `${fmt(shown, c.log ? 1 : c.step)}${c.unit ? ` ${c.unit}` : ''}`;
        if (from !== 'number') number.value = fmt(shown, c.step);
        if (from !== 'range') input.value = c.log ? toLog(n, c.min, c.max) : n;
        commit(String(shown));
      };
      input.addEventListener('input', () => apply(c.log ? fromLog(Number(input.value), c.min, c.max) : input.value, 'range'));
      number.addEventListener('change', () => apply(number.value, 'number'));
      row.append(out, h('div', { class: 'sim-insp-slider' }, input, number));
      return row;
    }
    if (c.type === 'select') {
      const select = h('select', { class: 'sim-select' });
      const options = [...c.options];
      if (c.allowCustom && value && !options.includes(String(value))) options.push(String(value));
      options.forEach((o, i) => select.append(h('option', { value: o }, c.labels?.[i] ?? formatOption(o, c.key))));
      select.value = String(value ?? '');
      select.addEventListener('change', () => commit(select.value));
      row.append(select);
      return row;
    }
    if (c.type === 'toggle') {
      const on = value === true || value === 'true' || value === '1';
      const sw = h('button', { type: 'button', role: 'switch', class: 'sim-switch', 'aria-checked': on ? 'true' : 'false' }, h('span', { class: 'sim-switch-knob' }));
      sw.addEventListener('click', (e) => {
        e.preventDefault();
        const next = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', next ? 'true' : 'false');
        commit(next ? 'true' : 'false');
      });
      row.append(sw);
      return row;
    }
    if (c.type === 'action') {
      const b = h('button', { type: 'button', class: 'sim-btn small' }, c.label);
      b.addEventListener('click', (e) => { e.preventDefault(); this.opts.onControl(part, c.key, true); });
      row.replaceChildren(b);
      row.classList.add('action');
      return row;
    }
    const input = h('input', { type: 'text', class: 'sim-input', value: value ?? '', placeholder: c.placeholder || '' });
    input.addEventListener('change', () => commit(input.value));
    input.addEventListener('keydown', (e) => e.stopPropagation());
    row.append(input);
    return row;
  }

  _renderWire(wire) {
    const el = this.el;
    el.append(this._header('Wire', `${wire.from.partId}:${wire.from.pin} → ${wire.to.partId}:${wire.to.pin}`));
    const body = h('div', { class: 'sim-insp-body' });
    body.append(h('div', { class: 'sim-insp-section' }, 'Color'));
    const swatches = h('div', { class: 'sim-swatches' });
    for (const c of WIRE_COLORS) {
      const s = h('button', { type: 'button', class: `sim-swatch${wire.color === c ? ' active' : ''}`, title: c, 'aria-label': `${c} wire`, style: { background: cssColor(c) } });
      s.addEventListener('click', () => {
        this.opts.canvas.setWireColor(wire.id, c);
        swatches.querySelectorAll('.sim-swatch').forEach(x => x.classList.toggle('active', x === s));
      });
      swatches.append(s);
    }
    body.append(swatches);
    body.append(h('p', { class: 'sim-insp-tip' }, 'Tip: while drawing a wire, click empty canvas to add bends. Double-click a wire to delete it.'));
    el.append(body);
    const actions = h('footer', { class: 'sim-insp-actions' });
    const del = h('button', { type: 'button', class: 'sim-btn ghost danger' }, icon('trash', 14), 'Delete wire');
    del.addEventListener('click', () => this.opts.onAction('delete'));
    actions.append(del);
    el.append(actions);
  }

  _renderMany(items) {
    const parts = items.filter(i => i.el).length;
    const wires = items.length - parts;
    const bits = [parts ? `${parts} part${parts === 1 ? '' : 's'}` : null, wires ? `${wires} wire${wires === 1 ? '' : 's'}` : null].filter(Boolean);
    this.el.append(this._header(`${bits.join(' and ')} selected`, 'Drag any of them to move the group'));
    const actions = h('footer', { class: 'sim-insp-actions' });
    for (const [name, label, ic] of [['rotate', 'Rotate', 'rotate'], ['duplicate', 'Duplicate', 'duplicate'], ['delete', 'Delete', 'trash']]) {
      const b = h('button', { type: 'button', class: `sim-btn ghost${name === 'delete' ? ' danger' : ''}` }, icon(ic, 14), label);
      b.addEventListener('click', () => this.opts.onAction(name));
      actions.append(b);
    }
    this.el.append(actions);
  }
}

function formatOption(o, key) {
  if (o === '') return 'Default';
  if (key === 'value' && /^\d+$/.test(o)) {
    const n = Number(o);
    return n >= 1e6 ? `${n / 1e6} MΩ` : n >= 1000 ? `${n / 1000} kΩ` : `${n} Ω`;
  }
  return o.charAt(0).toUpperCase() + o.slice(1);
}
