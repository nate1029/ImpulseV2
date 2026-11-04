// In-app dialogs. Electron does not implement window.prompt(), and native
// confirm() boxes don't match the app, so every ask goes through here.

let open = null;

function close(result) {
  if (!open) return;
  const { overlay, resolve, previousFocus } = open;
  open = null;
  overlay.remove();
  previousFocus?.focus?.();
  resolve(result);
}

/**
 * Show a modal dialog.
 * @param {{
 *   title: string,
 *   message?: string,
 *   input?: { value?: string, placeholder?: string, validate?: (v: string) => string | null },
 *   options?: { value: string, label: string, hint?: string }[],
 *   confirmLabel?: string,
 *   cancelLabel?: string,
 *   danger?: boolean
 * }} spec
 * @returns {Promise<string|boolean|null>} input text, chosen option value,
 *   true for a plain confirm, or null when cancelled.
 */
export function askDialog(spec) {
  if (open) close(null);
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'impulse-dialog-overlay';
    overlay.innerHTML = `
      <div class="impulse-dialog" role="dialog" aria-modal="true" aria-labelledby="impulseDialogTitle">
        <h3 class="impulse-dialog-title" id="impulseDialogTitle"></h3>
        <p class="impulse-dialog-message"></p>
        <div class="impulse-dialog-body"></div>
        <p class="impulse-dialog-error" role="alert"></p>
        <div class="impulse-dialog-actions">
          <button type="button" class="impulse-dialog-btn secondary" data-act="cancel"></button>
          <button type="button" class="impulse-dialog-btn primary" data-act="ok"></button>
        </div>
      </div>`;
    const $ = (sel) => overlay.querySelector(sel);
    $('.impulse-dialog-title').textContent = spec.title;
    const msg = $('.impulse-dialog-message');
    if (spec.message) msg.textContent = spec.message; else msg.remove();
    $('[data-act="cancel"]').textContent = spec.cancelLabel || 'Cancel';
    const ok = $('[data-act="ok"]');
    ok.textContent = spec.confirmLabel || 'OK';
    if (spec.danger) ok.classList.add('danger');
    const errorEl = $('.impulse-dialog-error');
    const body = $('.impulse-dialog-body');

    let input = null;
    let selected = null;
    if (spec.input) {
      input = document.createElement('input');
      input.type = 'text';
      input.className = 'impulse-dialog-input';
      input.value = spec.input.value || '';
      input.placeholder = spec.input.placeholder || '';
      input.spellcheck = false;
      body.appendChild(input);
    } else if (Array.isArray(spec.options) && spec.options.length) {
      const list = document.createElement('div');
      list.className = 'impulse-dialog-options';
      list.setAttribute('role', 'listbox');
      spec.options.forEach((opt, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'impulse-dialog-option';
        btn.setAttribute('role', 'option');
        btn.dataset.value = opt.value;
        const label = document.createElement('span');
        label.textContent = opt.label;
        btn.appendChild(label);
        if (opt.hint) {
          const hint = document.createElement('span');
          hint.className = 'impulse-dialog-option-hint';
          hint.textContent = opt.hint;
          btn.appendChild(hint);
        }
        btn.addEventListener('click', () => {
          list.querySelectorAll('.impulse-dialog-option').forEach(b => b.setAttribute('aria-selected', 'false'));
          btn.setAttribute('aria-selected', 'true');
          selected = opt.value;
        });
        btn.addEventListener('dblclick', () => { selected = opt.value; submit(); });
        if (i === 0) { btn.setAttribute('aria-selected', 'true'); selected = opt.value; }
        list.appendChild(btn);
      });
      body.appendChild(list);
    } else {
      body.remove();
    }

    function submit() {
      if (input) {
        const value = input.value.trim();
        const problem = spec.input.validate ? spec.input.validate(value) : (value ? null : 'Enter a value.');
        if (problem) { errorEl.textContent = problem; input.focus(); return; }
        close(value);
      } else if (spec.options) {
        close(selected);
      } else {
        close(true);
      }
    }

    ok.addEventListener('click', submit);
    $('[data-act="cancel"]').addEventListener('click', () => close(null));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); submit(); }
      else if (e.key === 'Tab') {
        const focusables = [...overlay.querySelectorAll('button, input')].filter(el => !el.disabled);
        const first = focusables[0], last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    open = { overlay, resolve, previousFocus: document.activeElement };
    document.body.appendChild(overlay);
    (input || overlay.querySelector('.impulse-dialog-option[aria-selected="true"]') || ok).focus();
    if (input) input.select();
  });
}

export function confirmDialog(title, message, { confirmLabel = 'OK', danger = false } = {}) {
  return askDialog({ title, message, confirmLabel, danger }).then(r => r === true);
}

/**
 * Editor preferences.
 * @param {{ theme: 'dark'|'light', fontSize: number, tabSize: number }} current
 * @returns {Promise<{ theme: 'dark'|'light', fontSize: number, tabSize: number } | null>}
 */
export function preferencesDialog(current) {
  if (open) close(null);
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'impulse-dialog-overlay';
    overlay.innerHTML = `
      <div class="impulse-dialog" role="dialog" aria-modal="true" aria-labelledby="impulsePrefsTitle"><form class="impulse-dialog-form">
        <h3 class="impulse-dialog-title" id="impulsePrefsTitle">Preferences</h3>
        <div class="impulse-dialog-fields">
          <label class="impulse-dialog-field">
            <span>Theme</span>
            <select name="theme" class="impulse-dialog-input">
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
          <label class="impulse-dialog-field">
            <span>Editor font size</span>
            <input name="fontSize" type="number" min="10" max="24" step="1" class="impulse-dialog-input">
          </label>
          <label class="impulse-dialog-field">
            <span>Indent width</span>
            <select name="tabSize" class="impulse-dialog-input">
              <option value="2">2 spaces</option>
              <option value="4">4 spaces</option>
            </select>
          </label>
        </div>
        <div class="impulse-dialog-actions">
          <button type="button" class="impulse-dialog-btn secondary" data-act="cancel">Cancel</button>
          <button type="submit" class="impulse-dialog-btn primary">Save</button>
        </div>
      </form></div>`;
    const form = overlay.querySelector('form');
    form.theme.value = current.theme;
    form.fontSize.value = String(current.fontSize);
    form.tabSize.value = String(current.tabSize === 4 ? 4 : 2);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fontSize = Math.max(10, Math.min(24, parseInt(form.fontSize.value, 10) || current.fontSize));
      close({ theme: form.theme.value === 'light' ? 'light' : 'dark', fontSize, tabSize: parseInt(form.tabSize.value, 10) });
    });
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } });
    open = { overlay, resolve, previousFocus: document.activeElement };
    document.body.appendChild(overlay);
    form.theme.focus();
  });
}

/**
 * Report a problem: the user writes what happened and sees exactly which
 * technical details go with it before anything leaves the app.
 * @param {{ details: string, crash?: { kind: string, at: string, message: string } | null }} spec
 * @returns {Promise<{ title: string, description: string, includeDetails: boolean } | null>}
 */
export function reportProblemDialog({ details, crash = null }) {
  if (open) close(null);
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'impulse-dialog-overlay';
    overlay.innerHTML = `
      <div class="impulse-dialog wide" role="dialog" aria-modal="true" aria-labelledby="impulseReportTitle"><form class="impulse-dialog-form">
        <h3 class="impulse-dialog-title" id="impulseReportTitle">Report a problem</h3>
        <p class="impulse-dialog-message">This opens a GitHub issue in your browser with what you write below. Nothing is sent until you submit it there.</p>
        <div class="impulse-dialog-fields stacked">
          <label class="impulse-dialog-field">
            <span>Title</span>
            <input name="title" class="impulse-dialog-input" maxlength="200" placeholder="Short summary, e.g. Upload fails on ESP32-S3" spellcheck="false">
          </label>
          <label class="impulse-dialog-field">
            <span>What happened?</span>
            <textarea name="description" class="impulse-dialog-input impulse-dialog-textarea" maxlength="5000" placeholder="What did you do, what did you expect, and what happened instead?"></textarea>
          </label>
          <label class="impulse-dialog-check">
            <input name="includeDetails" type="checkbox" checked>
            <span>Include technical details (shown below; your home folder and keys are removed)</span>
          </label>
          <pre class="impulse-dialog-details" tabindex="0" aria-label="Technical details"></pre>
        </div>
        <p class="impulse-dialog-error" role="alert"></p>
        <div class="impulse-dialog-actions">
          <button type="button" class="impulse-dialog-btn secondary" data-act="cancel">Cancel</button>
          <button type="submit" class="impulse-dialog-btn primary">Open GitHub issue</button>
        </div>
      </form></div>`;
    const form = overlay.querySelector('form');
    const pre = overlay.querySelector('.impulse-dialog-details');
    pre.textContent = details || 'No technical details available.';
    if (crash) {
      form.title.value = `Crash: ${crash.message}`.slice(0, 200);
      form.description.placeholder = 'What were you doing when it happened?';
    }
    form.includeDetails.addEventListener('change', () => { pre.hidden = !form.includeDetails.checked; });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = form.title.value.trim();
      if (!title) {
        overlay.querySelector('.impulse-dialog-error').textContent = 'Add a short title.';
        form.title.focus();
        return;
      }
      close({ title, description: form.description.value.trim(), includeDetails: form.includeDetails.checked });
    });
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } });
    open = { overlay, resolve, previousFocus: document.activeElement };
    document.body.appendChild(overlay);
    (crash ? form.description : form.title).focus();
  });
}

/**
 * Board options (Tools › Board Options): one select per menu option.
 * @param {{ boardName: string, options: { option: string, label: string, values: { value: string, label: string, isDefault: boolean }[] }[],
 *   choices: Record<string, string>, suggested?: Record<string, string> }} spec
 * @returns {Promise<Record<string, string> | null>} the chosen value for every option, or null when cancelled
 */
export function boardOptionsDialog({ boardName, options, choices, suggested = {} }) {
  if (open) close(null);
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'impulse-dialog-overlay';
    const box = document.createElement('div');
    box.className = 'impulse-dialog wide';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'impulseBoardOptsTitle');
    const form = document.createElement('form');
    form.className = 'impulse-dialog-form';
    box.appendChild(form);
    form.innerHTML = `
      <h3 class="impulse-dialog-title" id="impulseBoardOptsTitle"></h3>
      <p class="impulse-dialog-message">Used when you verify and upload, like Tools › Board options in the Arduino IDE.</p>
      <div class="impulse-dialog-fields board-options"></div>
      <div class="impulse-dialog-actions">
        <button type="button" class="impulse-dialog-btn secondary" data-act="reset">Defaults</button>
        <span class="impulse-dialog-spacer"></span>
        <button type="button" class="impulse-dialog-btn secondary" data-act="cancel">Cancel</button>
        <button type="submit" class="impulse-dialog-btn primary">Save</button>
      </div>`;
    form.querySelector('.impulse-dialog-title').textContent = `${boardName} options`;
    const fields = form.querySelector('.impulse-dialog-fields');
    const selects = [];
    for (const opt of options) {
      const field = document.createElement('label');
      field.className = 'impulse-dialog-field';
      const name = document.createElement('span');
      name.textContent = opt.label;
      const select = document.createElement('select');
      select.className = 'impulse-dialog-input';
      select.name = opt.option;
      const fallback = opt.values.find(v => v.isDefault)?.value ?? opt.values[0]?.value;
      for (const v of opt.values) {
        const o = document.createElement('option');
        o.value = v.value;
        o.textContent = suggested[opt.option] === v.value ? `${v.label} (recommended for this port)` : v.label;
        select.appendChild(o);
      }
      select.value = choices[opt.option] && opt.values.some(v => v.value === choices[opt.option]) ? choices[opt.option] : fallback;
      select.dataset.default = fallback;
      field.append(name, select);
      fields.appendChild(field);
      selects.push(select);
    }
    overlay.appendChild(box);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      close(Object.fromEntries(selects.map(s => [s.name, s.value])));
    });
    form.querySelector('[data-act="reset"]').addEventListener('click', () => {
      for (const s of selects) s.value = suggested[s.name] || s.dataset.default;
    });
    form.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } });
    open = { overlay, resolve, previousFocus: document.activeElement };
    document.body.appendChild(overlay);
    (selects[0] || form.querySelector('button[type="submit"]')).focus();
  });
}

/**
 * About Impulse, with the privacy policy and open-source notices one click away.
 * @param {{ version: string|null, readDoc: (name: 'privacy'|'licenses') => Promise<{ success: boolean, text?: string, error?: string }> }} spec
 */
export function aboutDialog({ version, readDoc }) {
  if (open) close(null);
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'impulse-dialog-overlay';
    overlay.innerHTML = `
      <div class="impulse-dialog wide" role="dialog" aria-modal="true" aria-labelledby="impulseAboutTitle">
        <h3 class="impulse-dialog-title" id="impulseAboutTitle">Impulse</h3>
        <p class="impulse-dialog-message"></p>
        <pre class="impulse-dialog-details doc" hidden tabindex="0"></pre>
        <div class="impulse-dialog-actions">
          <button type="button" class="impulse-dialog-btn secondary" data-doc="privacy">Privacy</button>
          <button type="button" class="impulse-dialog-btn secondary" data-doc="licenses">Open-source licenses</button>
          <span class="impulse-dialog-spacer"></span>
          <button type="button" class="impulse-dialog-btn primary" data-act="done">Done</button>
        </div>
      </div>`;
    const $ = (sel) => overlay.querySelector(sel);
    const intro = `${version ? `Version ${version}\n` : ''}Write it, wire it, simulate it, ship it to the board.\nAI-assisted Arduino development with a built-in circuit simulator.`;
    $('.impulse-dialog-message').textContent = intro;
    const pre = $('.impulse-dialog-details');
    for (const btn of overlay.querySelectorAll('[data-doc]')) {
      btn.addEventListener('click', async () => {
        const res = await readDoc(btn.dataset.doc).catch((e) => ({ success: false, error: e.message }));
        pre.hidden = false;
        pre.textContent = res?.success ? res.text : `Could not open it: ${res?.error || 'unknown error'}`;
        pre.scrollTop = 0;
        pre.focus();
      });
    }
    $('[data-act="done"]').addEventListener('click', () => close(true));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(true); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(true); } });
    open = { overlay, resolve, previousFocus: document.activeElement };
    document.body.appendChild(overlay);
    $('[data-act="done"]').focus();
  });
}

/**
 * Name and email for commits, saved in this repository's git config.
 * @returns {Promise<{ name: string, email: string } | null>}
 */
export function identityDialog() {
  if (open) close(null);
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'impulse-dialog-overlay';
    overlay.innerHTML = `
      <div class="impulse-dialog" role="dialog" aria-modal="true" aria-labelledby="impulseIdentityTitle"><form class="impulse-dialog-form">
        <h3 class="impulse-dialog-title" id="impulseIdentityTitle">Who's committing?</h3>
        <p class="impulse-dialog-message">Git records a name and email with every commit. They're saved for this repository only.</p>
        <div class="impulse-dialog-fields">
          <label class="impulse-dialog-field">
            <span>Name</span>
            <input name="name" type="text" autocomplete="name" required class="impulse-dialog-input">
          </label>
          <label class="impulse-dialog-field">
            <span>Email</span>
            <input name="email" type="email" autocomplete="email" required class="impulse-dialog-input">
          </label>
        </div>
        <p class="impulse-dialog-error" role="alert"></p>
        <div class="impulse-dialog-actions">
          <button type="button" class="impulse-dialog-btn secondary" data-act="cancel">Cancel</button>
          <button type="submit" class="impulse-dialog-btn primary">Commit</button>
        </div>
      </form></div>`;
    const form = overlay.querySelector('form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = form.name.value.trim();
      const email = form.email.value.trim();
      if (!name || !/^[^\s@]+@[^\s@]+$/.test(email)) {
        overlay.querySelector('.impulse-dialog-error').textContent = 'Enter a name and an email address.';
        return;
      }
      close({ name, email });
    });
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } });
    open = { overlay, resolve, previousFocus: document.activeElement };
    document.body.appendChild(overlay);
    form.name.focus();
  });
}

/** A file's changes as a unified diff, added and removed lines colored. */
export function diffDialog({ title, diff }) {
  if (open) close(null);
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'impulse-dialog-overlay';
    const box = document.createElement('div');
    box.className = 'impulse-dialog wide diff-dialog';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'impulseDiffTitle');
    box.innerHTML = `
      <h3 class="impulse-dialog-title" id="impulseDiffTitle"></h3>
      <pre class="diff-view" tabindex="0" aria-label="Changes"></pre>
      <div class="impulse-dialog-actions">
        <button type="button" class="impulse-dialog-btn primary" data-act="done">Close</button>
      </div>`;
    box.querySelector('.impulse-dialog-title').textContent = title;
    const view = box.querySelector('.diff-view');
    const lines = String(diff || '').replace(/\n$/, '').split('\n');
    if (!diff) view.textContent = 'No changes.';
    for (const line of diff ? lines : []) {
      const el = document.createElement('span');
      el.className = /^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line) ? 'diff-meta'
        : line.startsWith('@@') ? 'diff-hunk'
          : line.startsWith('+') ? 'diff-add'
            : line.startsWith('-') ? 'diff-del' : 'diff-ctx';
      el.textContent = `${line}\n`;
      view.appendChild(el);
    }
    overlay.appendChild(box);
    box.querySelector('[data-act="done"]').addEventListener('click', () => close(true));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(true); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(true); } });
    open = { overlay, resolve, previousFocus: document.activeElement };
    document.body.appendChild(overlay);
    view.focus();
  });
}
