// Two small questions chat mode needs without leaving chat mode: type a name,
// or confirm something that cannot be undone with one click.

import { openDialog } from './account.js';
import { add, h } from './dom.js';

/**
 * Ask for a line of text. Resolves with the trimmed text, or null if cancelled.
 * @param {{ title: string, label?: string, value?: string, placeholder?: string, confirmLabel?: string }} opts
 */
export function askText({ title, label = 'Name', value = '', placeholder = '', confirmLabel = 'OK' }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    const dialog = openDialog({ label: title, onClose: () => finish(null) });
    const input = h('input', { class: 'v-text', type: 'text', value, placeholder, spellcheck: 'false', 'aria-label': label });
    const error = h('p', { class: 'v-sub', hidden: true });
    const form = h('form', { class: 'v-column', novalidate: true },
      h('label', { class: 'v-field-row' }, h('span', { text: label }), input),
      error,
      h('div', { class: 'v-answer-actions' },
        h('button', { type: 'submit', class: 'v-btn primary', text: confirmLabel }),
        h('button', { type: 'button', class: 'v-btn', text: 'Cancel', onclick: () => dialog.close() })));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) {
        error.textContent = 'Type a name first.';
        error.hidden = false;
        input.focus();
        return;
      }
      finish(text);
      dialog.close();
    });
    add(dialog.body, h('h2', { text: title }), form);
    requestAnimationFrame(() => {
      input.focus();
      // Select the name without its extension, the way a rename should.
      const dot = input.value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    });
  });
}

/**
 * Confirm an action. Resolves true only when the button is pressed.
 * @param {{ title: string, text?: string, confirmLabel?: string, danger?: boolean }} opts
 */
export function confirmAsk({ title, text = '', confirmLabel = 'OK', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    const dialog = openDialog({ label: title, onClose: () => finish(false) });
    const confirm = h('button', { type: 'button', class: `v-btn ${danger ? 'danger' : 'primary'}`, text: confirmLabel });
    confirm.addEventListener('click', () => {
      finish(true);
      dialog.close();
    });
    add(dialog.body,
      h('h2', { text: title }),
      text ? h('p', { class: 'v-sub', text }) : null,
      h('div', { class: 'v-answer-actions' }, confirm, h('button', { type: 'button', class: 'v-btn', text: 'Cancel', onclick: () => dialog.close() })));
    requestAnimationFrame(() => confirm.focus());
  });
}
