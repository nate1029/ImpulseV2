// The Impulse account in chat mode: sign-in dialog (Google, GitHub, email +
// password with an emailed code, password reset), the account menu, the
// credits popover and the plans dialog. The session itself lives in the main
// process; this only shows its status.

import { add, avatar, fill, fmtCredits, h, icon, led, toast } from './dom.js';
import { ICON } from './icons.js';
import { closePopover, menu, popover } from './menu.js';
import { periodNoun, periodWords, refillWhen } from './credits-text.js';

const TRACE = '<svg class="v-trace" viewBox="0 0 400 40" preserveAspectRatio="none" aria-hidden="true"><path class="grid" d="M0 20H400M50 0V40M100 0V40M150 0V40M200 0V40M250 0V40M300 0V40M350 0V40"/><path class="wave" d="M0 27H178L186 27L192 7L198 35L203 23L208 27H400"/></svg>';

/** A modal dialog with a focus trap. Returns { body, close }. */
export function openDialog({ label, wide = false, onClose } = {}) {
  const previous = document.activeElement;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', keys, true);
    onClose?.();
    if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
  };
  const body = h('div', { class: 'v-dialog-body' });
  const dialog = h('div', { class: `v-dialog${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': label },
    h('button', { type: 'button', class: 'v-icon-btn v-dialog-close', 'aria-label': 'Close', html: ICON.close, onclick: close }),
    h('div', { html: TRACE }),
    body);
  const overlay = h('div', { class: 'v-overlay' }, dialog);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
  const keys = (e) => {
    if (e.key === 'Escape' && !document.querySelector('.v-pop')) {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      const focusable = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select, textarea, a[href]')].filter((x) => x.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  document.addEventListener('keydown', keys, true);
  document.body.append(overlay);
  return { body, dialog, close };
}

function field(label, attrs) {
  const input = h('input', { class: `v-text${attrs.code ? ' code' : ''}`, ...attrs, code: null });
  return { row: h('label', { class: 'v-field-row' }, h('span', { text: label }), input), input };
}

function errorBox() {
  const box = h('div', { class: 'v-error', role: 'alert', hidden: true }, led('red'), h('span'));
  return {
    el: box,
    show(message) {
      box.lastChild.textContent = message || '';
      box.hidden = !message;
    },
  };
}

/**
 * @param {{ api: typeof window.electronAPI, onSignedIn?: (status: object) => void }} deps
 */
export function createAccount({ api, onSignedIn }) {
  let status = { configured: false, signedIn: false };
  const listeners = new Set();
  const set = (next) => {
    const wasSignedIn = status.signedIn;
    status = next || status;
    listeners.forEach((fn) => fn(status));
    if (!wasSignedIn && status.signedIn) onSignedIn?.(status);
  };

  api.cloud.onStatus((next) => set(next));

  async function load() {
    set(await api.cloud.status().catch(() => status));
    if (status.signedIn) api.cloud.refresh().then(set).catch(() => {});
    return status;
  }

  // ── Sign-in dialog ─────────────────────────────────────────────────────
  let dialog = null;

  function openSignIn({ pendingPrompt = null, start = 'choose' } = {}) {
    dialog?.close();
    let email = '';
    const d = openDialog({
      label: 'Sign in to Impulse',
      onClose: () => {
        if (status.signingIn) api.cloud.cancelSignIn().catch(() => {});
        dialog = null;
      },
    });
    dialog = d;
    const err = errorBox();

    const welcome = status.welcomeCredits
      ? `New accounts get ${status.welcomeCredits} free credits, then ${status.freeMonthlyCredits} more ${periodWords(status.freePeriodHours)}.`
      : 'Free to start. No card needed.';
    const note = pendingPrompt
      ? h('div', { class: 'v-pending-note' }, icon(ICON.checkSmall), h('span', {}, 'Your message is kept and sends as soon as you\'re in: ', h('q', { text: pendingPrompt.length > 90 ? `${pendingPrompt.slice(0, 88)}…` : pendingPrompt })))
      : null;

    const busy = (button, on, text) => {
      button.disabled = on;
      if (text) button.textContent = on ? text : button.dataset.label;
    };

    async function finished(result) {
      if (result?.ok) {
        d.close();
        toast(`Signed in as ${result.status?.user?.email || 'you'}`);
        return true;
      }
      return false;
    }

    function show(step) {
      fill(d.body);
      err.show('');
      const auth = status.auth || { google: true, github: true, email: true };

      if (!status.configured) {
        add(d.body,
          h('h2', { text: 'Impulse Cloud isn\'t connected' }),
          h('p', { class: 'v-sub', text: 'This build of Impulse has no cloud address, so accounts, credits and the AI are off. The simulator and the IDE still work. A build with a cloud address brings the AI back.' }));
        return;
      }

      if (step === 'choose') {
        const providers = [];
        if (auth.google) providers.push(h('button', { type: 'button', class: 'v-btn block', onclick: () => provider('google') }, icon(ICON.google), 'Continue with Google'));
        if (auth.github) providers.push(h('button', { type: 'button', class: 'v-btn block', onclick: () => provider('github') }, icon(ICON.github), 'Continue with GitHub'));
        // A server with no sign-in method switched on yet (a new deployment): say so instead of an empty dialog.
        if (!providers.length && !auth.email) {
          add(d.body,
            h('h2', { text: 'Sign-in isn\'t open yet' }),
            h('p', { class: 'v-sub', text: 'Impulse Cloud is running, but no way to sign in has been switched on yet. The simulator and the IDE work meanwhile; try again later.' }));
          return;
        }
        const mail = field('Email', { type: 'email', autocomplete: 'email', required: true, value: email });
        const pass = field('Password', { type: 'password', autocomplete: 'current-password', required: true });
        const submit = h('button', { type: 'submit', class: 'v-btn primary block', text: 'Sign in', dataset: { label: 'Sign in' } });
        const form = h('form', { class: 'v-form', novalidate: true }, mail.row, pass.row, submit);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          email = mail.input.value.trim();
          if (!email || !pass.input.value) return err.show('Enter your email and password.');
          busy(submit, true, 'Signing in…');
          const result = await api.cloud.signInEmail(email, pass.input.value);
          busy(submit, false, 'Signing in…');
          if (await finished(result)) return;
          if (result?.needsVerification) return show('verify');
          err.show(result?.error || 'Could not sign in.');
        });
        add(d.body, 
          h('h2', { text: pendingPrompt ? 'Sign in to send this' : 'Sign in to Impulse' }),
          h('p', { class: 'v-sub', text: welcome }),
          note,
          providers.length ? h('div', { class: 'v-form' }, providers) : null,
          providers.length && auth.email ? h('div', { class: 'v-or', text: 'or' }) : null,
          auth.email ? form : null,
          err.el,
          auth.email ? h('div', { class: 'v-links' },
            h('button', { type: 'button', class: 'v-link', text: 'Create an account', onclick: () => show('signup') }),
            h('button', { type: 'button', class: 'v-link', text: 'Forgot password?', onclick: () => show('forgot') })) : null);
        requestAnimationFrame(() => (auth.email ? mail.input : d.body.querySelector('button.v-btn'))?.focus());
        return;
      }

      if (step === 'signup') {
        const name = field('Name', { autocomplete: 'name', required: true, maxlength: '80' });
        const mail = field('Email', { type: 'email', autocomplete: 'email', required: true, value: email });
        const pass = field('Password', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8', maxlength: '128', placeholder: 'At least 8 characters' });
        const submit = h('button', { type: 'submit', class: 'v-btn primary block', text: 'Create account', dataset: { label: 'Create account' } });
        const form = h('form', { class: 'v-form', novalidate: true }, name.row, mail.row, pass.row, submit);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          email = mail.input.value.trim();
          if (!name.input.value.trim() || !email) return err.show('Enter your name and email.');
          if (pass.input.value.length < 8) return err.show('Use at least 8 characters for the password.');
          busy(submit, true, 'Creating…');
          const result = await api.cloud.signUpEmail(name.input.value.trim(), email, pass.input.value);
          busy(submit, false, 'Creating…');
          if (!result?.ok) return err.show(result?.error || 'Could not create the account.');
          show('verify');
        });
        add(d.body, 
          h('h2', { text: 'Create your account' }),
          h('p', { class: 'v-sub', text: welcome }),
          note, form, err.el,
          h('div', { class: 'v-links' }, h('span', { text: 'Have an account?' }), h('button', { type: 'button', class: 'v-link', text: 'Sign in', onclick: () => show('choose') })));
        requestAnimationFrame(() => name.input.focus());
        return;
      }

      if (step === 'verify') {
        const code = field('Code', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', code: true, 'aria-label': '6-digit code' });
        const submit = h('button', { type: 'submit', class: 'v-btn primary block', text: 'Verify', dataset: { label: 'Verify' } });
        const form = h('form', { class: 'v-form', novalidate: true }, code.row, submit);
        const verify = async () => {
          const otp = code.input.value.trim();
          if (!/^\d{6}$/.test(otp)) return err.show('Enter the 6-digit code from the email.');
          busy(submit, true, 'Checking…');
          const result = await api.cloud.verifyEmail(email, otp);
          busy(submit, false, 'Checking…');
          if (!(await finished(result))) err.show(result?.error || 'That code didn\'t work.');
        };
        form.addEventListener('submit', (e) => { e.preventDefault(); verify(); });
        code.input.addEventListener('input', () => {
          code.input.value = code.input.value.replace(/\D/g, '').slice(0, 6);
          if (code.input.value.length === 6) verify();
        });
        const resend = h('button', { type: 'button', class: 'v-link', text: 'Send a new code' });
        resend.addEventListener('click', async () => {
          resend.disabled = true;
          const result = await api.cloud.resendCode(email);
          if (!result?.ok) {
            resend.disabled = false;
            return err.show(result?.error || 'Could not send a new code.');
          }
          let left = 30;
          resend.textContent = `New code sent · ${left}s`;
          const tick = setInterval(() => {
            left -= 1;
            if (!document.contains(resend) || left <= 0) {
              clearInterval(tick);
              resend.disabled = false;
              resend.textContent = 'Send a new code';
              return;
            }
            resend.textContent = `New code sent · ${left}s`;
          }, 1000);
        });
        add(d.body, 
          h('h2', { text: 'Check your email' }),
          h('p', { class: 'v-sub' }, 'We sent a 6-digit code to ', h('strong', { text: email }), '. It expires in 10 minutes.'),
          form, err.el,
          h('div', { class: 'v-links' }, resend, h('button', { type: 'button', class: 'v-link', text: 'Use another email', onclick: () => show('choose') })));
        requestAnimationFrame(() => code.input.focus());
        return;
      }

      if (step === 'forgot') {
        const mail = field('Email', { type: 'email', autocomplete: 'email', required: true, value: email });
        const submit = h('button', { type: 'submit', class: 'v-btn primary block', text: 'Send code', dataset: { label: 'Send code' } });
        const form = h('form', { class: 'v-form', novalidate: true }, mail.row, submit);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          email = mail.input.value.trim();
          if (!email) return err.show('Enter your email.');
          busy(submit, true, 'Sending…');
          const result = await api.cloud.requestPasswordReset(email);
          busy(submit, false, 'Sending…');
          if (!result?.ok) return err.show(result?.error || 'Could not send the code.');
          show('reset');
        });
        add(d.body, h('h2', { text: 'Reset your password' }), h('p', { class: 'v-sub', text: 'We\'ll email you a code to choose a new one.' }), form, err.el,
          h('div', { class: 'v-links' }, h('button', { type: 'button', class: 'v-link', text: 'Back to sign in', onclick: () => show('choose') })));
        requestAnimationFrame(() => mail.input.focus());
        return;
      }

      if (step === 'reset') {
        const code = field('Code', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', code: true });
        const pass = field('New password', { type: 'password', autocomplete: 'new-password', minlength: '8', maxlength: '128', placeholder: 'At least 8 characters' });
        const submit = h('button', { type: 'submit', class: 'v-btn primary block', text: 'Set password and sign in', dataset: { label: 'Set password and sign in' } });
        const form = h('form', { class: 'v-form', novalidate: true }, code.row, pass.row, submit);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          if (!/^\d{6}$/.test(code.input.value.trim())) return err.show('Enter the 6-digit code from the email.');
          if (pass.input.value.length < 8) return err.show('Use at least 8 characters for the password.');
          busy(submit, true, 'Saving…');
          const result = await api.cloud.resetPassword(email, code.input.value.trim(), pass.input.value);
          busy(submit, false, 'Saving…');
          if (!(await finished(result))) err.show(result?.error || 'Could not reset the password.');
        });
        add(d.body, h('h2', { text: 'Choose a new password' }), h('p', { class: 'v-sub' }, 'Enter the code we sent to ', h('strong', { text: email }), '.'), form, err.el);
        requestAnimationFrame(() => code.input.focus());
        return;
      }

      if (step === 'browser') {
        const name = dialog.provider === 'github' ? 'GitHub' : 'Google';
        add(d.body, 
          h('div', { class: 'v-waiting' },
            led('amber', { pulse: true }),
            h('h2', { text: `Continue in your browser` }),
            h('p', { class: 'v-sub', text: `Finish signing in with ${name} in the browser window that just opened. Impulse comes back here on its own.` }),
            h('div', { class: 'v-answer-actions' },
              h('button', { type: 'button', class: 'v-btn', text: 'Open it again', onclick: () => provider(dialog.provider) }),
              h('button', { type: 'button', class: 'v-btn ghost', text: 'Use another way', onclick: () => { api.cloud.cancelSignIn(); show('choose'); } }))),
          err.el);
      }
    }

    async function provider(which) {
      dialog.provider = which;
      show('browser');
      const result = await api.cloud.signInWithProvider(which);
      if (dialog !== d) return;
      if (await finished(result)) return;
      if (result?.cancelled) return;
      show('choose');
      err.show(result?.error || 'The sign-in didn\'t finish.');
    }

    show(start);
    return d;
  }

  // ── Plans ──────────────────────────────────────────────────────────────
  async function openPlans() {
    const d = openDialog({ label: 'Plans', wide: true });
    add(d.body, h('div', { class: 'v-waiting' }, led('amber', { pulse: true }), h('p', { text: 'Loading plans…' })));
    const res = await api.cloud.plans();
    if (!res?.ok) {
      fill(d.body, h('h2', { text: 'Plans' }), h('div', { class: 'v-error' }, led('red'), h('span', { text: res?.error || 'Could not load the plans.' })));
      return;
    }
    const { plans, current, pendingRequest } = res.data;
    const render = (pending) => {
      fill(d.body, 
        h('h2', { text: 'Choose a plan' }),
        h('p', { class: 'v-sub', text: 'Credits pay for the AI. A short question uses little; building and fixing a project uses more. Each plan refills on its own schedule.' }),
        h('div', { class: 'v-plans' }, plans.map((p) => {
          const isCurrent = p.id === current;
          const requested = pending?.plan === p.id;
          const cta = isCurrent
            ? h('button', { type: 'button', class: 'v-btn block', disabled: true, text: 'Your plan' })
            : p.id === 'free'
              ? h('span', { class: 'v-label', text: 'Always available' })
              : requested
                ? h('button', { type: 'button', class: 'v-btn block', disabled: true, text: 'Requested' })
                : h('button', {
                  type: 'button', class: `v-btn block${p.id === 'pro' ? ' primary' : ''}`, text: `Get ${p.name}`,
                  onclick: async (e) => {
                    e.currentTarget.disabled = true;
                    const r = await api.cloud.requestUpgrade(p.id);
                    if (!r?.ok) {
                      e.currentTarget.disabled = false;
                      return toast(r?.error || 'Could not send the request.');
                    }
                    toast(`Request sent. You move to ${p.name} once the Impulse team approves it.`);
                    render({ plan: p.id });
                  },
                });
          return h('section', { class: 'v-plan', 'data-current': isCurrent || null },
            h('div', { class: 'v-readout' }, h('span', { class: 'v-label', text: p.name }), isCurrent ? led('green') : null),
            h('div', { class: 'v-plan-price' }, h('strong', { text: p.priceUsd ? `$${p.priceUsd}` : '$0' }), h('span', { text: p.priceUsd ? 'a month' : 'forever' })),
            h('ul', {},
              h('li', {}, icon(ICON.checkSmall), `${p.monthlyCredits.toLocaleString()} credits ${periodWords(p.periodHours)}`),
              h('li', {}, icon(ICON.checkSmall), p.models.join(', ')),
              h('li', {}, icon(ICON.checkSmall), 'Simulator, uploads and the IDE included')),
            cta);
        })),
        pending ? h('p', { class: 'v-sub', text: `Your ${pending.plan === 'max' ? 'Max' : 'Pro'} request is with the Impulse team. Online payment is coming; until then we upgrade accounts by hand.` }) : null);
    };
    render(pendingRequest);
  }

  // ── Credits popover ────────────────────────────────────────────────────
  function creditsPopover(anchor) {
    const c = status.credits;
    if (!status.signedIn || !c) {
      openSignIn();
      return;
    }
    const share = c.monthly > 0 ? Math.max(0, Math.min(1, c.planCredits / c.monthly)) : 0;
    const level = c.remaining <= 0 ? 'empty' : c.remaining < Math.max(10, c.monthly * 0.15) ? 'low' : '';
    const renews = refillWhen(c.periodEnd, c.periodHours);
    const body = h('div', { class: 'v-usage' },
      h('div', { class: 'v-usage-top' }, h('span', { class: 'v-label', text: 'Credits left' }), h('span', { class: 'v-label', text: `${c.planName} plan` })),
      h('div', { class: 'v-usage-num', text: fmtCredits(c.remaining) }),
      h('div', { class: 'v-meter', dataset: { level }, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(c.monthly), 'aria-valuenow': String(Math.max(0, c.planCredits)), 'aria-label': `Plan credits ${c.periodHours ? 'this period' : 'this month'}` },
        h('span', { style: `width:${share * 100}%` })),
      h('dl', {},
        h('dt', { text: periodNoun(c.periodHours) }), h('dd', { text: `${fmtCredits(Math.max(0, c.planCredits))} of ${c.monthly}` }),
        h('dt', { text: 'Bonus (never expire)' }), h('dd', { text: fmtCredits(c.bonusCredits) }),
        h('dt', { text: 'Refills' }), h('dd', { text: renews })),
      h('div', { class: 'v-answer-actions' },
        h('button', { type: 'button', class: `v-btn${c.plan === 'free' ? ' primary' : ''}`, text: c.plan === 'free' ? 'Upgrade' : 'Plans', onclick: () => { closePopover(); openPlans(); } })));
    popover(anchor, body, { align: 'end', label: 'Credits', className: 'v-usage-pop' });
  }

  // ── Account menu ───────────────────────────────────────────────────────
  let learning = { share: true, fixes: 0, shared: 0 };
  api.learning?.status?.().then((res) => { if (res?.success) learning = res.data; }).catch(() => {});
  function accountMenu(anchor, extra = []) {
    // Signed out: straight to sign-in (a one-item menu would only add a click).
    if (!status.signedIn && status.configured && !extra.length) {
      openSignIn();
      return;
    }
    if (!status.signedIn) {
      menu(anchor, [
        { label: 'Sign in or create an account', icon: ICON.user, onSelect: () => openSignIn() },
        ...extra,
      ], { label: 'Account', side: 'top' });
      return;
    }
    const u = status.user;
    const header = h('div', { class: 'v-item', style: 'cursor:default' }, avatar(u),
      h('span', { class: 'v-item-text' }, h('span', { class: 'v-item-title', text: u.name || u.email }), h('span', { class: 'v-item-sub', text: u.email })));
    menu(anchor, [
      { element: header },
      { separator: true },
      { label: 'Credits and plan', icon: ICON.bolt, meta: status.credits ? fmtCredits(status.credits.remaining) : null, onSelect: () => openPlans() },
      {
        label: learning.share ? 'Sharing fixes: on' : 'Sharing fixes: off',
        icon: ICON.checkSmall,
        sub: learning.share ? 'Each fix helps everyone. Your sketch stays private.' : 'Fixes stay on this computer',
        onSelect: async () => {
          const res = await api.learning?.setShare?.(!learning.share).catch(() => null);
          if (res?.success) { learning = res.data; toast(learning.share ? 'Sharing fixes is on' : 'Sharing fixes is off'); }
        },
      },
      status.isAdmin ? { label: 'Admin console', icon: ICON.shield, sub: 'Opens in your browser', onSelect: () => api.cloud.openAdmin() } : null,
      ...extra,
      { separator: true },
      { label: 'Sign out', icon: ICON.signOut, onSelect: async () => { await api.cloud.signOut(); toast('Signed out'); } },
    ], { label: 'Account', side: 'top' });
  }

  return {
    get status() { return status; },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    load,
    refresh: async () => set(await api.cloud.refresh().catch(() => status)),
    openSignIn,
    openPlans,
    creditsPopover,
    accountMenu,
  };
}
