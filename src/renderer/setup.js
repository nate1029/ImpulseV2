// First-run setup: when arduino-cli, the AVR core or (on Apple silicon)
// Rosetta is missing, explain what's needed and install it with progress.

const STEPS = [
  { id: 'cli', label: 'Arduino command-line tools', done: (s) => !!s.cli },
  { id: 'rosetta', label: 'Rosetta (Apple silicon)', done: (s) => s.rosetta !== 'missing', only: (s) => s.rosetta !== 'not-needed' },
  { id: 'core', label: 'Arduino AVR boards (Uno, Nano, Mega)', done: (s) => s.avrCore },
];

function describe(status) {
  if (status.ready) return 'Everything Impulse needs to compile and upload is installed.';
  if (!status.supported && !status.cli) return 'Impulse can\'t download the Arduino tools for this computer. Install arduino-cli from arduino.cc, then restart Impulse.';
  return 'Impulse compiles and uploads with the official Arduino tools. A few pieces are missing; Impulse can download and install them for you (about 200 MB).';
}

/**
 * Show the setup dialog. Resolves true once everything is installed, false
 * if the user chose to do it later.
 * @param {object} status from window.electronAPI.toolchain.status()
 */
export function showSetupDialog(status) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'impulse-dialog-overlay';
    overlay.innerHTML = `
      <div class="impulse-dialog wide setup-dialog" role="dialog" aria-modal="true" aria-labelledby="impulseSetupTitle">
        <h3 class="impulse-dialog-title" id="impulseSetupTitle">Finish setting up Impulse</h3>
        <p class="impulse-dialog-message"></p>
        <ol class="setup-steps"></ol>
        <div class="setup-progress" hidden>
          <div class="setup-progress-label" aria-live="polite"></div>
          <div class="setup-progress-track"><div class="setup-progress-bar"></div></div>
        </div>
        <p class="impulse-dialog-error" role="alert"></p>
        <div class="impulse-dialog-actions">
          <button type="button" class="impulse-dialog-btn secondary" data-act="later">Later</button>
          <button type="button" class="impulse-dialog-btn primary" data-act="setup">Set up now</button>
        </div>
      </div>`;
    const $ = (sel) => overlay.querySelector(sel);
    $('.impulse-dialog-message').textContent = describe(status);
    const list = $('.setup-steps');
    const render = (s, activeStep = null) => {
      list.innerHTML = '';
      for (const step of STEPS) {
        if (step.only && !step.only(s)) continue;
        const li = document.createElement('li');
        const done = step.done(s);
        li.className = `setup-step ${done ? 'done' : step.id === activeStep ? 'active' : 'todo'}`;
        li.innerHTML = '<span class="setup-step-mark" aria-hidden="true"></span><span class="setup-step-label"></span><span class="setup-step-state"></span>';
        li.querySelector('.setup-step-label').textContent = step.label;
        li.querySelector('.setup-step-state').textContent = done
          ? (step.id === 'cli' && s.cli ? `found${s.cli.version ? ` · ${s.cli.version}` : ''}` : 'ready')
          : step.id === activeStep ? 'installing…' : 'will be installed';
        list.appendChild(li);
      }
    };
    render(status);

    const setupBtn = $('[data-act="setup"]');
    const laterBtn = $('[data-act="later"]');
    const progress = $('.setup-progress');
    const bar = $('.setup-progress-bar');
    const label = $('.setup-progress-label');
    if (status.ready || (!status.supported && !status.cli)) setupBtn.hidden = true;
    if (status.ready) laterBtn.textContent = 'Done';

    let stop = null;
    const finish = (value) => {
      stop?.();
      overlay.remove();
      resolve(value);
    };

    laterBtn.addEventListener('click', () => finish(false));
    setupBtn.addEventListener('click', async () => {
      setupBtn.disabled = true;
      laterBtn.disabled = true;
      $('.impulse-dialog-error').textContent = '';
      progress.hidden = false;
      let active = null;
      stop = window.electronAPI.toolchain.onProgress((p) => {
        if (p.step !== active) { active = p.step; render(status, active); }
        label.textContent = p.percent === null ? p.message : `${p.message} ${p.percent}%`;
        bar.style.width = p.percent === null ? '100%' : `${p.percent}%`;
        bar.classList.toggle('indeterminate', p.percent === null);
      });
      const res = await window.electronAPI.toolchain.setup().catch((e) => ({ success: false, error: e.message }));
      stop?.();
      stop = null;
      if (res?.success && res.data?.ready) {
        render(res.data);
        label.textContent = 'All set.';
        bar.style.width = '100%';
        bar.classList.remove('indeterminate');
        setTimeout(() => finish(true), 600);
        return;
      }
      if (res?.data) status = res.data;
      render(status);
      $('.impulse-dialog-error').textContent = res?.error || 'Setup didn\'t finish. Check your internet connection and try again.';
      setupBtn.textContent = 'Try again';
      setupBtn.disabled = false;
      laterBtn.disabled = false;
    });
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !laterBtn.disabled) { e.preventDefault(); finish(false); }
    });
    document.body.appendChild(overlay);
    setupBtn.hidden ? laterBtn.focus() : setupBtn.focus();
  });
}

/** Check the toolchain; ask to install what's missing. Resolves true when ready. */
export async function ensureToolchain({ force = false } = {}) {
  const res = await window.electronAPI?.toolchain?.status?.().catch(() => null);
  if (!res?.success) return false;
  if (res.data.ready && !force) return true;
  return showSetupDialog(res.data);
}
