// Libraries, inside chat mode: search the index, see what is installed, add
// what the open sketch needs. Nothing here sends you to the IDE.

import { openDialog } from './account.js';
import { add, fill, h, icon, led, toast } from './dom.js';
import { ICON } from './icons.js';

const api = () => window.electronAPI;

/**
 * The Libraries dialog.
 * @param {{ impulse: object, query?: string }} opts
 */
export function openLibraries({ impulse, query = '' } = {}) {
  let stopProgress = null;
  let timer = null;
  const dialog = openDialog({
    label: 'Libraries',
    wide: true,
    onClose: () => { stopProgress?.(); clearTimeout(timer); },
  });
  const board = impulse.board.current();
  const search = h('input', {
    type: 'search', class: 'v-input-line', placeholder: 'Search libraries: a name, or a header like DHT.h',
    'aria-label': 'Search libraries', spellcheck: 'false', value: query,
  });
  const results = h('div', { class: 'v-lib-list' });
  const status = h('p', { class: 'v-sub', text: 'What the sketch needs, and anything else you want to add.' });
  let installing = null;

  stopProgress = api().libraries.onProgress((p) => {
    if (!installing || p.name !== installing) return;
    if (p.state === 'installing') status.textContent = p.message ? `Installing ${p.name}: ${p.message}` : `Installing ${p.name}…`;
  });

  async function install(lib, button) {
    installing = lib.name;
    button.disabled = true;
    button.textContent = 'Installing…';
    const res = await api().libraries.add(lib.name, '').catch((e) => ({ success: false, error: e.message }));
    installing = null;
    if (res?.success) {
      toast(`${lib.name} installed`);
      status.textContent = `${lib.name} is installed. Compile again and it will be used.`;
      await render();
    } else {
      button.disabled = false;
      button.textContent = 'Install';
      status.textContent = res?.error || `Could not install ${lib.name}.`;
    }
  }

  async function remove(lib) {
    const res = await api().libraries.remove(lib.name).catch((e) => ({ success: false, error: e.message }));
    if (res?.success) {
      toast(`${lib.name} removed`);
      await render();
    } else {
      status.textContent = res?.error || `Could not remove ${lib.name}.`;
    }
  }

  function row(lib, { installed = false } = {}) {
    const actions = installed
      ? h('button', { type: 'button', class: 'v-btn', text: 'Remove', onclick: () => remove(lib) })
      : h('button', { type: 'button', class: 'v-btn primary', text: 'Install' });
    if (!installed) actions.addEventListener('click', () => install(lib, actions));
    return h('div', { class: 'v-lib' },
      h('div', { class: 'v-lib-text' },
        h('span', { class: 'v-lib-name' }, lib.name, lib.version ? h('span', { class: 'v-lib-ver', text: ` ${lib.version}` }) : null),
        lib.about || lib.sentence ? h('span', { class: 'v-lib-about', text: lib.about || lib.sentence }) : null,
        lib.fitsBoard === false ? h('span', { class: 'v-lib-warn' }, led('amber'), `Made for other boards than the ${board.name || 'selected one'}`) : null),
      actions);
  }

  async function render() {
    const q = search.value.trim();
    fill(results);
    results.append(h('p', { class: 'v-sub', text: q ? 'Searching…' : 'Loading…' }));
    // What the open sketch needs comes first: that is what the user is here for.
    const [missing, found, installed] = await Promise.all([
      q ? Promise.resolve([]) : api().libraries.missing(impulse.editor?.value?.() || '', board.fqbn || '').then((r) => (r?.success ? r.data : [])).catch(() => []),
      q ? api().libraries.find(q, board.fqbn || '').then((r) => (r?.success ? r.data : [])).catch(() => []) : Promise.resolve([]),
      api().libraries.installed().then((r) => (r?.success ? r.data : [])).catch(() => []),
    ]);
    fill(results);
    if (missing.length) {
      results.append(h('div', { class: 'v-lib-head' }, icon(ICON.library), `This sketch needs ${missing.length === 1 ? 'a library' : 'libraries'}`));
      for (const m of missing) results.append(row({ ...m.suggestion, about: `Provides ${m.header}. ${m.suggestion.sentence || ''}`.trim() }));
    }
    if (q) {
      results.append(h('div', { class: 'v-lib-head' }, `Search: ${q}`));
      if (!found.length) results.append(h('p', { class: 'v-sub', text: `Nothing in the Arduino library index matches "${q}".` }));
      for (const lib of found) results.append(row(lib, { installed: lib.installed }));
    } else {
      results.append(h('div', { class: 'v-lib-head' }, `Installed (${installed.length})`));
      if (!installed.length) results.append(h('p', { class: 'v-sub', text: 'No libraries yet. Search above, or just describe what you want to build: a build installs what it needs.' }));
      for (const lib of installed.slice(0, 60)) results.append(row(lib, { installed: true }));
    }
  }

  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(render, 220);
  });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); render(); } });

  add(dialog.body,
    h('h2', { text: 'Libraries' }),
    status,
    search,
    results);
  render();
  requestAnimationFrame(() => search.focus());
  return dialog;
}
