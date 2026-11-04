// Popovers and menus for chat mode: one open at a time, placed against an
// anchor (above it when there's no room below), closed by Escape, a click
// outside or the window losing focus. Menus move with the arrow keys.

import { h, icon } from './dom.js';
import { ICON } from './icons.js';

let current = null;

export function closePopover() {
  const open = current;
  current = null;
  if (!open) return;
  open.el.remove();
  open.anchor?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', open.outside, true);
  document.removeEventListener('keydown', open.keys, true);
  window.removeEventListener('blur', closePopover);
  window.removeEventListener('resize', closePopover);
  open.onClose?.();
  if (open.restoreFocus && document.activeElement === document.body) open.anchor?.focus({ preventScroll: true });
}

function place(el, anchor, { align = 'start', side = 'auto' }) {
  const a = anchor.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const gap = 6;
  const below = window.innerHeight - a.bottom;
  const up = side === 'top' || (side === 'auto' && below < r.height + gap + 8 && a.top > below);
  let top = up ? a.top - r.height - gap : a.bottom + gap;
  let left = align === 'end' ? a.right - r.width : a.left;
  left = Math.min(Math.max(8, left), window.innerWidth - r.width - 8);
  top = Math.min(Math.max(8, top), window.innerHeight - r.height - 8);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.setProperty('--v-from', up ? '-4px' : '4px');
  el.style.setProperty('--v-origin', `${align === 'end' ? 'right' : 'left'} ${up ? 'bottom' : 'top'}`);
}

/**
 * Show `content` in a popover against `anchor`. Clicking the anchor again closes it.
 * @returns {{ el: HTMLElement, close: () => void } | null}
 */
export function popover(anchor, content, { align, side, label, onClose, className = '', focus = true } = {}) {
  if (current?.anchor === anchor) {
    closePopover();
    return null;
  }
  closePopover();
  const el = h('div', { class: `v-pop ${className}`.trim(), role: 'dialog', 'aria-label': label || null }, content);
  el.style.left = '-9999px';
  el.style.top = '0px';
  document.body.append(el);
  place(el, anchor, { align, side });
  anchor.setAttribute('aria-expanded', 'true');
  const open = {
    el,
    anchor,
    onClose,
    restoreFocus: true,
    outside: (e) => {
      if (!el.contains(e.target) && !anchor.contains(e.target)) {
        open.restoreFocus = false;
        closePopover();
      }
    },
    keys: (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closePopover();
      } else if (e.key === 'Tab' && !el.contains(document.activeElement)) {
        closePopover();
      }
    },
  };
  current = open;
  document.addEventListener('pointerdown', open.outside, true);
  document.addEventListener('keydown', open.keys, true);
  window.addEventListener('blur', closePopover);
  window.addEventListener('resize', closePopover);
  if (focus) requestAnimationFrame(() => el.querySelector('button:not(:disabled), input, [tabindex="0"]')?.focus({ preventScroll: true }));
  return { el, close: closePopover };
}

/**
 * A menu of items:
 *   { label, sub?, meta?, icon?, checked?, disabled?, danger?, onSelect }
 *   { heading: 'TEXT' } · { separator: true } · { element: Node }
 */
export function menu(anchor, items, opts = {}) {
  const list = h('div', { role: 'menu', 'aria-label': opts.label || null });
  for (const item of items) {
    if (!item) continue;
    if (item.separator) {
      list.append(h('div', { class: 'v-pop-sep', role: 'separator' }));
      continue;
    }
    if (item.heading) {
      list.append(h('div', { class: 'v-pop-label v-label', text: item.heading }));
      continue;
    }
    if (item.element) {
      list.append(item.element);
      continue;
    }
    const button = h('button', {
      type: 'button',
      class: `v-item${item.danger ? ' danger' : ''}`,
      role: item.checked === undefined ? 'menuitem' : 'menuitemradio',
      'aria-checked': item.checked === undefined ? null : String(!!item.checked),
      disabled: item.disabled || null,
      title: item.title || null,
    },
    item.icon ? icon(item.icon) : null,
    h('span', { class: 'v-item-text' },
      h('span', { class: 'v-item-title', text: item.label }),
      item.sub ? h('span', { class: 'v-item-sub', text: item.sub }) : null),
    item.meta ? h('span', { class: 'v-item-meta', text: item.meta }) : null,
    item.checked ? icon(ICON.check) : null);
    button.addEventListener('click', () => {
      closePopover();
      item.onSelect?.();
    });
    list.append(button);
  }
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const buttons = [...list.querySelectorAll('button.v-item:not(:disabled)')];
    if (!buttons.length) return;
    const at = buttons.indexOf(document.activeElement);
    let next;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    else next = (at + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  });
  const handle = popover(anchor, list, opts);
  // Start on the checked item when there is one.
  if (handle) requestAnimationFrame(() => (list.querySelector('[aria-checked="true"]') || list.querySelector('button.v-item:not(:disabled)'))?.focus({ preventScroll: true }));
  return handle;
}
