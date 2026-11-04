// Part picker: search, category navigation and a grid of real part
// thumbnails. Click or Enter adds a part; dragging a tile drops it where you
// release. When nothing matches, it offers close matches, the generic
// stand-in sensors and the AI circuit builder.

import { PARTS, CATEGORY_ORDER, CATEGORY_HINTS } from '../parts/catalog.js';
import { searchParts, suggestParts } from '../search.js';
import { h, icon, partThumb } from './dom.js';

const POPULAR = [
  'wokwi-led', 'wokwi-resistor', 'wokwi-pushbutton', 'wokwi-potentiometer', 'impulse-breadboard-half', 'wokwi-lcd1602',
  'wokwi-ssd1306', 'wokwi-servo', 'wokwi-hc-sr04', 'wokwi-dht22', 'wokwi-led-ring', 'wokwi-buzzer',
];
const RECENT_KEY = 'impulse-sim-recent-parts';

export class PartPicker {
  /**
   * @param {HTMLElement} host stage element the popover lives in
   * @param {{ onAdd: (type: string, at?: {clientX, clientY}) => void, onAskAi?: (query: string) => void,
   *   canDropAt?: (clientX, clientY) => boolean, onRequestPart?: (query: string) => void }} opts
   */
  constructor(host, opts) {
    this.opts = opts;
    this.el = h('div', { class: 'sim-picker', role: 'dialog', 'aria-label': 'Add a part', hidden: true });
    // Combobox pattern: the search box announces the highlighted part.
    this.search = h('input', {
      type: 'search', class: 'sim-picker-input', placeholder: `Search ${Object.keys(PARTS).length} parts — try “distance”, “oled”, “motor”…`,
      'aria-label': 'Search parts', autocomplete: 'off', spellcheck: 'false',
      role: 'combobox', 'aria-expanded': 'true', 'aria-autocomplete': 'list', 'aria-controls': 'simPickerOptions',
    });
    this.nav = h('nav', { class: 'sim-picker-nav', 'aria-label': 'Categories' });
    this.list = h('div', { class: 'sim-picker-list', tabindex: '-1' });
    this.footer = h('div', { class: 'sim-picker-footer' });
    this.el.append(
      h('div', { class: 'sim-picker-head' }, icon('search', 16), this.search, h('kbd', { class: 'sim-kbd' }, 'Esc')),
      h('div', { class: 'sim-picker-body' }, this.nav, this.list),
      this.footer,
    );
    host.appendChild(this.el);
    this.items = [];
    this.focus = -1;
    this._thumbs = new Map();

    this.search.addEventListener('input', () => this.render());
    this.search.addEventListener('keydown', (e) => this._key(e));
    this.list.addEventListener('keydown', (e) => this._key(e));
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  get open() {
    return !this.el.hidden;
  }

  toggle(force) {
    const show = force ?? this.el.hidden;
    this.el.hidden = !show;
    if (show) {
      this.search.value = '';
      this.render();
      requestAnimationFrame(() => this.search.focus());
    }
  }

  _recent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter(t => PARTS[t]); } catch { return []; }
  }

  _remember(type) {
    try {
      const list = [type, ...this._recent().filter(t => t !== type)].slice(0, 6);
      localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch { /* storage unavailable */ }
  }

  _thumb(def, section) {
    // Thumbnails are live elements; build each once per section and reuse it.
    const key = `${section}|${def.type}`;
    if (!this._thumbs.has(key)) this._thumbs.set(key, section === 'results' ? partThumb(def, 54, 42) : partThumb(def, 92, 54));
    return this._thumbs.get(key);
  }

  _tile(def, { detail = false, section = 'list' } = {}) {
    const tile = h('button', {
      type: 'button', class: `sim-tile${detail ? ' detail' : ''}`, role: 'option', title: def.description,
      id: `sim-part-${String(section).replace(/[^a-z0-9]+/gi, '-')}-${def.type}`, 'aria-selected': 'false',
      dataset: { type: def.type },
    },
    this._thumb(def, section),
    h('span', { class: 'sim-tile-text' },
      h('span', { class: 'sim-tile-name' }, def.label),
      detail ? h('span', { class: 'sim-tile-desc' }, def.description) : null));
    tile.addEventListener('mouseenter', () => this._describe(def));
    tile.addEventListener('focus', () => this._describe(def));
    tile.addEventListener('pointerdown', (e) => this._dragStart(e, def, tile));
    this.items.push({ def, tile });
    return tile;
  }

  _section(title, defs, hint) {
    const sec = h('section', { class: 'sim-picker-section', role: 'group', 'aria-label': title, dataset: { cat: title } },
      h('header', {}, h('span', { class: 'sim-picker-cat' }, title), hint ? h('span', { class: 'sim-picker-hint' }, hint) : null),
      h('div', { class: 'sim-picker-grid' }, defs.map(d => this._tile(d, { section: title }))));
    return sec;
  }

  render() {
    const q = this.search.value.trim();
    this.items = [];
    this.focus = -1;
    this.list.innerHTML = '';
    this.nav.innerHTML = '';
    this.nav.hidden = !!q;
    this.search.removeAttribute('aria-activedescendant');
    // Parts go in one listbox; messages and action buttons sit outside it.
    const options = h('div', { class: 'sim-picker-options', role: 'listbox', id: 'simPickerOptions', 'aria-label': q ? `Parts matching ${q}` : 'Parts' });

    if (!q) {
      const recent = this._recent();
      const groups = [];
      if (recent.length) groups.push(['Recent', recent.map(t => PARTS[t])]);
      groups.push(['Popular', POPULAR.map(t => PARTS[t]).filter(Boolean)]);
      for (const cat of CATEGORY_ORDER) groups.push([cat, Object.values(PARTS).filter(p => p.category === cat)]);
      this.list.appendChild(options);
      for (const [title, defs] of groups) {
        const sec = this._section(title, defs, CATEGORY_HINTS[title]);
        options.appendChild(sec);
        const link = h('button', { type: 'button', class: 'sim-picker-navlink' }, title, h('span', { class: 'sim-picker-count' }, String(defs.length)));
        link.addEventListener('click', () => sec.scrollIntoView({ block: 'start', behavior: 'smooth' }));
        this.nav.appendChild(link);
      }
      this._describe(null);
      return;
    }

    const results = searchParts(q);
    if (results.length) {
      const grid = h('div', { class: 'sim-picker-results' }, results.map(r => this._tile(r.part, { detail: true, section: 'results' })));
      options.appendChild(grid);
      this.list.append(h('div', { class: 'sim-picker-cat result-count', role: 'status' }, `${results.length} part${results.length === 1 ? '' : 's'} match “${q}”`), options);
      this._setFocus(0);
      return;
    }

    const { similar, generic, advice } = suggestParts(q);
    const empty = h('div', { class: 'sim-picker-empty' },
      h('p', { class: 'sim-picker-empty-title' }, advice ? advice.title : `No part called “${q}” yet`),
      h('p', { class: 'sim-picker-empty-text' }, advice ? advice.text : 'Most sensors have a digital or analog output: the generic stand-ins below behave like them, so you can keep building and testing your code.'));
    this.list.append(empty, options);
    if (advice?.parts.length) options.appendChild(this._section('Try instead', advice.parts));
    if (generic.length && !advice) options.appendChild(this._section('Stand-ins', generic));
    if (similar.length) options.appendChild(this._section('Related parts', similar));
    if (this.opts.onAskAi) {
      const ai = h('button', { type: 'button', class: 'sim-btn ghost sim-picker-ai' }, icon('sparkle', 14), 'Build the circuit from my code with AI');
      ai.addEventListener('click', () => { this.toggle(false); this.opts.onAskAi(q); });
      this.list.appendChild(ai);
    }
    if (this.opts.onRequestPart) {
      const ask = h('button', { type: 'button', class: 'sim-btn ghost sim-picker-ai' }, icon('flag', 14), `Request “${q}” as a new part`);
      ask.addEventListener('click', () => { this.toggle(false); this.opts.onRequestPart(q); });
      this.list.appendChild(ask);
    }
    this._setFocus(0);
  }

  _describe(def) {
    this.footer.innerHTML = '';
    if (!def) {
      this.footer.append(h('span', { class: 'sim-picker-tip' }, 'Click a part to add it, or drag it onto the canvas. ', h('kbd', { class: 'sim-kbd' }, '↑↓'), ' to move, ', h('kbd', { class: 'sim-kbd' }, '↵'), ' to add.'));
      return;
    }
    this.footer.append(h('strong', {}, def.label), h('span', { class: 'sim-picker-desc' }, def.description));
    if (def.libraries?.length) this.footer.append(h('span', { class: 'sim-picker-libs' }, `Library: ${def.libraries.join(', ')}`));
  }

  _setFocus(i) {
    if (!this.items.length) return;
    this.focus = Math.max(0, Math.min(this.items.length - 1, i));
    this.items.forEach((it, j) => {
      it.tile.classList.toggle('focused', j === this.focus);
      it.tile.setAttribute('aria-selected', j === this.focus ? 'true' : 'false');
    });
    const it = this.items[this.focus];
    this.search.setAttribute('aria-activedescendant', it.tile.id);
    it.tile.scrollIntoView({ block: 'nearest' });
    this._describe(it.def);
  }

  _columns() {
    const tile = this.items[this.focus]?.tile;
    const grid = tile?.parentElement;
    if (!grid) return 1;
    const firstTop = grid.children[0]?.offsetTop;
    return [...grid.children].filter(c => c.offsetTop === firstTop).length || 1;
  }

  _key(e) {
    if (e.key === 'Escape') { e.preventDefault(); this.toggle(false); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const it = this.items[this.focus >= 0 ? this.focus : 0];
      if (it) this._add(it.def.type);
      return;
    }
    const cols = this._columns();
    const moves = { ArrowDown: cols, ArrowUp: -cols, ArrowRight: 1, ArrowLeft: -1 };
    if (e.key in moves && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.target !== this.search || this.search.value === '')) {
      e.preventDefault();
      this._setFocus((this.focus < 0 ? 0 : this.focus) + moves[e.key]);
    }
  }

  _add(type, at) {
    this._remember(type);
    this.toggle(false);
    this.opts.onAdd(type, at);
  }

  // Click adds near the center; dragging a tile drops the part at the pointer.
  _dragStart(e, def, tile) {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    let ghost = null;
    const move = (ev) => {
      if (!ghost && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 6) {
        ghost = partThumb(def, 90, 70);
        ghost.classList.add('sim-drag-ghost');
        document.body.appendChild(ghost);
        this.el.classList.add('dragging');
      }
      if (ghost) {
        ghost.style.left = `${ev.clientX}px`;
        ghost.style.top = `${ev.clientY}px`;
      }
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.el.classList.remove('dragging');
      if (ghost) {
        ghost.remove();
        if (this.opts.canDropAt?.(ev.clientX, ev.clientY)) this._add(def.type, { clientX: ev.clientX, clientY: ev.clientY });
      } else if (tile.matches(':hover')) {
        this._add(def.type);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
}
