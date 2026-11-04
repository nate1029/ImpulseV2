// Examples gallery: browse ready-made projects by category, search them and
// open one as a new sketch with its circuit.

import { EXAMPLES, EXAMPLE_CATEGORIES } from '../examples.js';
import { PARTS } from '../parts/catalog.js';
import { BOARDS } from '../boards.js';
import { h, icon, partThumb } from './dom.js';
import { normalize } from '../search.js';

export class ExamplesGallery {
  /** @param {{ onOpen: (example) => void }} opts */
  constructor(opts) {
    this.opts = opts;
    this.category = 'All';
    this.el = null;
  }

  open() {
    if (this.el) { this.el.remove(); this.el = null; }
    const search = h('input', { type: 'search', class: 'sim-gallery-search', placeholder: 'Search examples — try “lcd”, “servo”, “game”…', 'aria-label': 'Search examples', autocomplete: 'off' });
    const nav = h('nav', { class: 'sim-gallery-nav', 'aria-label': 'Example categories' });
    const list = h('div', { class: 'sim-gallery-list', role: 'listbox', 'aria-label': 'Examples' });
    const openBtn = h('button', { type: 'button', class: 'sim-btn primary', disabled: true }, 'Open example', h('kbd', { class: 'sim-kbd on-primary' }, '↵'));
    const scratch = h('button', { type: 'button', class: 'sim-btn ghost' }, 'Start from scratch');
    const close = h('button', { type: 'button', class: 'sim-icon-btn', 'aria-label': 'Close' }, icon('close', 16));
    const dialog = h('div', { class: 'sim-gallery', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Examples' },
      h('div', { class: 'sim-gallery-head' },
        h('div', {}, h('h2', {}, 'Examples'), h('p', {}, `${EXAMPLES.length} projects that run in the simulator — open one to get its sketch and its wired circuit.`)),
        close),
      h('div', { class: 'sim-gallery-body' },
        nav,
        h('div', { class: 'sim-gallery-main' }, h('div', { class: 'sim-gallery-searchrow' }, icon('search', 15), search), list)),
      h('div', { class: 'sim-gallery-foot' }, h('span', { class: 'sim-gallery-hint' }, h('kbd', { class: 'sim-kbd' }, '↑↓'), ' to choose'), h('div', { class: 'sim-gallery-actions' }, scratch, openBtn)));
    const overlay = h('div', { class: 'sim-overlay' }, dialog);
    document.body.appendChild(overlay);
    this.el = overlay;

    let selected = null;
    let cards = [];
    const choose = (ex, card) => {
      selected = ex;
      cards.forEach(c => c.classList.toggle('selected', c === card));
      openBtn.disabled = !ex;
      card?.scrollIntoView({ block: 'nearest' });
    };
    const render = () => {
      const q = normalize(search.value);
      const words = q.split(' ').filter(Boolean);
      list.innerHTML = '';
      cards = [];
      const items = EXAMPLES.filter(ex => (this.category === 'All' || ex.category === this.category) &&
        (!words.length || words.every(w => normalize([ex.title, ex.summary, ex.tags.join(' '), ex.category, BOARDS[ex.board].label, ...(ex.libraries || [])].join(' ')).includes(w))));
      if (!items.length) {
        list.append(h('div', { class: 'sim-gallery-empty' }, h('strong', {}, 'No examples match.'), h('span', {}, 'Try a part name like “oled” or “keypad”, or browse a category.')));
      }
      for (const ex of items) {
        const card = this._card(ex);
        card.addEventListener('click', () => choose(ex, card));
        card.addEventListener('dblclick', () => this._open(ex));
        cards.push(card);
        list.append(card);
      }
      choose(items[0] || null, cards[0]);
    };
    for (const cat of ['All', ...EXAMPLE_CATEGORIES]) {
      const count = cat === 'All' ? EXAMPLES.length : EXAMPLES.filter(e => e.category === cat).length;
      const b = h('button', { type: 'button', class: `sim-gallery-cat${cat === this.category ? ' active' : ''}` }, cat, h('span', { class: 'sim-picker-count' }, String(count)));
      b.addEventListener('click', () => {
        this.category = cat;
        nav.querySelectorAll('.sim-gallery-cat').forEach(x => x.classList.toggle('active', x === b));
        render();
      });
      nav.append(b);
    }
    search.addEventListener('input', render);
    const dismiss = () => { overlay.remove(); this.el = null; document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); dismiss(); }
      else if (e.key === 'Enter' && selected) { e.preventDefault(); this._open(selected); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const i = cards.findIndex(c => c.classList.contains('selected'));
        const next = Math.max(0, Math.min(cards.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
        cards[next]?.click();
      }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) dismiss(); });
    close.addEventListener('click', dismiss);
    scratch.addEventListener('click', dismiss);
    openBtn.addEventListener('click', () => selected && this._open(selected));
    this._dismiss = dismiss;
    render();
    requestAnimationFrame(() => search.focus());
  }

  close() {
    this._dismiss?.();
  }

  _open(example) {
    this.close();
    this.opts.onOpen(example);
  }

  _card(ex) {
    const { parts } = ex.circuit();
    const shown = [];
    for (const p of parts) {
      const def = PARTS[p.type];
      if (!def || def.board || def.category === 'Breadboards' || shown.some(s => s.type === p.type)) continue;
      shown.push(def);
      if (shown.length === 3) break;
    }
    const board = BOARDS[ex.board];
    return h('button', { type: 'button', class: 'sim-gallery-card', role: 'option' },
      h('div', { class: 'sim-gallery-thumbs' }, shown.length ? shown.map(d => partThumb(d, 44, 34)) : partThumb(PARTS[board.tag], 58, 40)),
      h('div', { class: 'sim-gallery-text' },
        h('div', { class: 'sim-gallery-title' }, ex.title),
        h('div', { class: 'sim-gallery-summary' }, ex.summary),
        h('div', { class: 'sim-gallery-tags' },
          h('span', { class: 'sim-tag board' }, board.short),
          h('span', { class: `sim-tag level-${ex.level.toLowerCase()}` }, ex.level),
          ...ex.tags.slice(0, 3).map(t => h('span', { class: 'sim-tag' }, t)))));
  }
}
