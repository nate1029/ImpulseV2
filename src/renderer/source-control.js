// Source Control panel: the open folder's Git status, a commit box, the
// changed files (click one for its diff), recent history, push and pull.
// Git runs in the main process (main/services/git.js).

import { identityDialog, diffDialog } from './dialog.js';

const LETTER = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: 'U', conflicted: '!' };
const WORDS = { modified: 'Modified', added: 'Added', deleted: 'Deleted', renamed: 'Renamed', copied: 'Copied', untracked: 'New', conflicted: 'Conflict' };

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  node.append(...children.filter(c => c !== null && c !== undefined && c !== false));
  return node;
}

/** "5 min ago", "3 h ago", "2 d ago", or the date. */
export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}

/** The state a file shows: its working-tree change, else what is staged. */
const stateOf = (f) => f.unstaged || f.staged || 'modified';

/**
 * @param {{ getFolder: () => string|null, log?: (text: string, kind?: string) => void }} opts
 * @returns {{ refresh: () => Promise<void> }}
 */
export function setupSourceControl({ getFolder, log = () => {} }) {
  const container = document.getElementById('scmContent');
  const git = window.electronAPI?.git;
  let status = null;
  let history = [];
  let busy = null; // 'commit' | 'push' | 'pull' | 'init' | null
  let error = '';
  let message = '';
  let folder = null;

  async function refresh() {
    if (!container || !git) return;
    folder = getFolder();
    if (!folder) {
      status = null;
      render();
      return;
    }
    const res = await git.status(folder).catch(e => ({ success: false, error: e.message }));
    status = res.success ? res.data : { available: true, repo: false, error: res.error };
    history = [];
    if (status.repo && status.hasCommits) {
      const recent = await git.log(status.root, 15).catch(() => null);
      history = recent?.success ? recent.data : [];
    }
    render();
  }

  async function act(kind, fn) {
    if (busy) return;
    busy = kind;
    error = '';
    render();
    try {
      await fn();
    } catch (err) {
      error = err.message;
    } finally {
      busy = null;
      await refresh();
    }
  }

  const unwrap = (res, fallback) => {
    if (res?.success) return res.data;
    const err = new Error(res?.error || fallback);
    err.needsIdentity = !!res?.needsIdentity;
    throw err;
  };

  function commit() {
    const text = message.trim();
    if (!text || !status?.files?.length) return;
    return act('commit', async () => {
      let res = await git.commit(status.root, text);
      if (!res.success && res.needsIdentity) {
        const identity = await identityDialog();
        if (!identity) return;
        res = await git.commit(status.root, text, identity);
      }
      unwrap(res, 'Commit failed');
      message = '';
      log(`Committed: ${text.split('\n')[0]}`, 'success');
    });
  }

  const showDiff = async (file) => {
    const res = await git.diff(status.root, file.path).catch(e => ({ success: false, error: e.message }));
    if (!res.success) { error = res.error; render(); return; }
    await diffDialog({ title: `${file.path} · ${WORDS[stateOf(file)] || 'Changed'}`, diff: res.data });
  };

  function render() {
    if (!container) return;
    const keepFocus = document.activeElement?.id === 'scmMessage';
    container.replaceChildren();
    const section = (...children) => el('div', { class: 'sidebar-section' }, ...children);
    const note = (text) => el('p', { class: 'scm-note', text });

    if (!folder) {
      container.append(section(note('Open a sketch folder to track its changes with Git.')));
      return;
    }
    if (!status?.available) {
      container.append(section(note(status?.error || 'Git is not installed.')));
      return;
    }
    if (!status.repo) {
      container.append(section(
        note('This folder isn’t a Git repository yet. Start one to keep a history of your sketch and share it on GitHub.'),
        el('button', { type: 'button', class: 'btn-small scm-primary', disabled: !!busy, onclick: () => act('init', async () => unwrap(await git.init(folder), 'git init failed')) },
          busy === 'init' ? 'Initializing…' : 'Initialize repository'),
        status.error ? el('p', { class: 'scm-error', role: 'alert', text: status.error }) : null,
      ));
      return;
    }

    // Branch and sync.
    const sync = status.upstream ? `${status.ahead ? ` ↑${status.ahead}` : ''}${status.behind ? ` ↓${status.behind}` : ''}` : '';
    container.append(section(
      el('div', { class: 'scm-branch' },
        el('span', { class: 'scm-branch-name', title: status.upstream ? `Tracking ${status.upstream}` : 'Not tracking a remote branch yet' },
          status.branch || 'detached HEAD', sync ? el('span', { class: 'scm-sync', text: sync, 'aria-label': `${status.ahead} to push, ${status.behind} to pull` }) : null),
        el('span', { class: 'scm-actions' },
          el('button', { type: 'button', class: 'btn-small', disabled: !!busy || !status.upstream, title: status.upstream ? `Pull from ${status.upstream} (fast-forward only)` : 'No remote branch to pull from', onclick: () => act('pull', async () => { unwrap(await git.pull(status.root), 'Pull failed'); log('Pulled.', 'success'); }) },
            busy === 'pull' ? 'Pulling…' : 'Pull'),
          el('button', { type: 'button', class: 'btn-small', disabled: !!busy || !status.hasCommits, title: 'Push this branch', onclick: () => act('push', async () => { unwrap(await git.push(status.root), 'Push failed'); log('Pushed.', 'success'); }) },
            busy === 'push' ? 'Pushing…' : 'Push'))),
    ));

    // Commit box.
    const count = status.files.length;
    const textarea = el('textarea', { id: 'scmMessage', class: 'sidebar-input scm-message', rows: '3', placeholder: `Message (${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+'}Enter to commit)`, 'aria-label': 'Commit message', disabled: !!busy });
    textarea.value = message;
    const commitBtn = el('button', { type: 'button', class: 'btn-small scm-primary', disabled: !!busy || !count || !message.trim(), onclick: commit },
      busy === 'commit' ? 'Committing…' : `Commit all${count ? ` (${count})` : ''}`);
    textarea.addEventListener('input', () => {
      message = textarea.value;
      commitBtn.disabled = !!busy || !count || !message.trim();
    });
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
    });
    container.append(section(textarea, commitBtn, error ? el('p', { class: 'scm-error', role: 'alert', text: error }) : null));

    // Changes.
    const changes = count
      ? el('div', { class: 'scm-list', role: 'list' }, ...status.files.map((f) => {
        const st = stateOf(f);
        return el('div', { role: 'listitem' }, el('button', { type: 'button', class: `scm-file ${st}`, title: `${WORDS[st] || 'Changed'}: ${f.path}${f.from ? ` (from ${f.from})` : ''}`, onclick: () => showDiff(f) },
          el('span', { class: 'scm-letter', 'aria-hidden': 'true', text: LETTER[st] || 'M' }),
          el('span', { class: 'scm-path', text: f.path }),
          el('span', { class: 'sr-only', text: ` · ${WORDS[st] || 'Changed'}` })));
      }))
      : note(status.hasCommits ? 'No changes since the last commit.' : 'No files yet.');
    container.append(section(el('h2', { class: 'scm-heading', text: `Changes${count ? ` (${count})` : ''}` }), changes));

    // History.
    if (history.length) {
      container.append(section(el('h2', { class: 'scm-heading', text: 'History' }),
        el('div', { class: 'scm-list', role: 'list' }, ...history.map(c => el('div', { class: 'scm-commit', role: 'listitem', title: `${c.hash}\n${c.author}, ${new Date(c.date).toLocaleString()}` },
          el('span', { class: 'scm-hash', text: c.short }),
          el('span', { class: 'scm-subject', text: c.subject }),
          el('span', { class: 'scm-when', text: relativeTime(c.date) }))))));
    }
    if (keepFocus) textarea.focus();
  }

  window.addEventListener('focus', () => { if (container?.closest('.sidebar-panel')?.classList.contains('active')) refresh(); });
  return { refresh };
}
