// Tiny DOM helpers for the simulator UI.

// Thumbnails are live part elements: register them.
import '@wokwi/elements';
import '../elements/index.js';

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICON_PATHS = {
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.5" y="5.5" width="3.6" height="13" rx="1" fill="currentColor" stroke="none"/><rect x="13.9" y="5.5" width="3.6" height="13" rx="1" fill="currentColor" stroke="none"/>',
  restart: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v5h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  agent: '<rect x="4" y="8" width="16" height="12" rx="2.5"/><path d="M12 8V4.5M9.5 4.5h5"/><circle cx="9" cy="14" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="14" r="1.2" fill="currentColor" stroke="none"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  rotate: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/>',
  duplicate: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2.5v3.5M15 2.5v3.5M9 18v3.5M15 18v3.5M2.5 9h3.5M2.5 15h3.5M18 9h3.5M18 15h3.5"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  minus: '<path d="M5 12h14"/>',
  sound: '<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
  mute: '<path d="M11 5L6 9H3v6h3l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/>',
  clock: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>',
  gauge: '<path d="M12 20a8 8 0 1 1 8-8"/><path d="M12 12l4-4"/>',
  warning: '<path d="M12 3L2 20h20z"/><path d="M12 10v4.5M12 17.5v.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 13.5l5-5 5 5M5 4h14"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  wire: '<path d="M4 18c4 0 4-12 8-12s4 12 8 12"/><circle cx="4" cy="18" r="1.6" fill="currentColor"/><circle cx="20" cy="18" r="1.6" fill="currentColor"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  bug: '<path d="M8 10a4 4 0 0 1 8 0v4a4 4 0 0 1-8 0z"/><path d="M12 10v8M4 13h4M16 13h4M5 7.5l3 2M19 7.5l-3 2M5 19.5l3-2M19 19.5l-3-2M9.5 6.5L8 4.5M14.5 6.5L16 4.5"/>',
  continue: '<path d="M6 5.5v13"/><path d="M10.5 5.5v13l9-6.5z" fill="currentColor" stroke="none"/>',
  stepOver: '<path d="M4.5 13.5a7.5 7.5 0 0 1 14.2-3.4"/><path d="M19.5 5v5.5H14"/><circle cx="12" cy="18.5" r="2" fill="currentColor" stroke="none"/>',
  stepInto: '<path d="M12 3.5v10"/><path d="M8 10l4 4 4-4"/><circle cx="12" cy="19.5" r="2" fill="currentColor" stroke="none"/>',
  stepOut: '<path d="M12 15V4.5"/><path d="M8 8.5l4-4 4 4"/><circle cx="12" cy="19.5" r="2" fill="currentColor" stroke="none"/>',
};

export function icon(name, size = 16) {
  const span = document.createElement('span');
  span.className = 'sim-icon';
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
  return span;
}

export function iconSvg(name, size = 16) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
}

export const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || navigator.userAgent);
export const mod = isMac ? '⌘' : 'Ctrl+';

/** Thumbnail of a part: the real element scaled into a box. */
export function partThumb(def, boxW = 56, boxH = 44) {
  const wrap = document.createElement('div');
  wrap.className = 'sim-thumb';
  // A picture of the part: its live controls (a pot's slider…) must not be
  // reachable by keyboard or screen readers.
  wrap.inert = true;
  wrap.setAttribute('aria-hidden', 'true');
  wrap.style.width = `${boxW}px`;
  wrap.style.height = `${boxH}px`;
  const el = document.createElement(def.tag);
  for (const [k, v] of Object.entries(def.attrs || {})) el.setAttribute(k, v);
  const w = def.size?.w || 60;
  const hgt = def.size?.h || 60;
  const scale = Math.min(boxW / w, boxH / hgt, 1.6);
  el.style.transform = `translate(-50%, -50%) scale(${scale})`;
  wrap.appendChild(el);
  return wrap;
}
