// Impulse admin console: a small hash-routed page over /admin/api.
// Everything shown from the database is set with textContent.

import { bars, fillDays, lineChart } from './chart.js';

const $ = (sel, root = document) => root.querySelector(sel);

/** h('div', { class: 'x', onclick }, child, 'text', …) */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en');
const usd = (v) => {
  if (!v) return '$0';
  if (v < 0.01) return '<$0.01';
  if (v >= 1000) return `$${compact.format(v)}`;
  return `$${v.toFixed(2)}`;
};
const credits = (v) => (v === null || v === undefined ? '—' : whole.format(Math.round(v * 10) / 10));
const ago = (iso) => {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
};
const when = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const initials = (name, email) => (name || email || '?').trim().split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();

class ApiError extends Error {}

async function call(method, path, body) {
  const res = await fetch(`/admin/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-impulse-admin': '1' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch { /* no body */ }
  if (res.status === 401) {
    location.href = '/sign-in/?next=/admin/';
    throw new ApiError('Signed out');
  }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`);
  return data;
}
const get = (path) => call('GET', path);
const post = (path, body) => call('POST', path, body);

let toastTimer = null;
function toast(message, error = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast${error ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function avatar(user) {
  const box = h('span', { class: 'avatar', 'aria-hidden': 'true' });
  if (user.image && /^https:\/\//.test(user.image)) box.append(h('img', { src: user.image, alt: '', referrerpolicy: 'no-referrer' }));
  else box.textContent = initials(user.name, user.email);
  return box;
}

function person(user) {
  return h('div', { class: 'person' }, avatar(user), h('div', { class: 'person-text' }, h('strong', { text: user.name || '—' }), h('span', { text: user.email })));
}

function seg(options, current, onPick, label) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': label },
    options.map(([value, text]) => h('button', {
      type: 'button', 'aria-pressed': String(value === current), onclick: () => onPick(value),
    }, text)));
}

function statusOf(user) {
  if (user.banned) return ['red', 'Suspended'];
  if (!user.verified && user.verified !== undefined) return ['amber', 'Unverified'];
  if (user.role === 'admin') return ['green', 'Admin'];
  return ['', 'Active'];
}

function pageHead(title, text, ...controls) {
  return h('header', { class: 'page-head' },
    h('div', {}, h('h1', { text: title }), text ? h('p', { text }) : null),
    controls.length ? h('div', { class: 'controls' }, controls) : null);
}

/* ─────────────── Overview ─────────────── */

async function overview(main, query) {
  const days = [7, 30, 90].includes(Number(query.get('days'))) ? Number(query.get('days')) : 30;
  const data = await get(`/overview?days=${days}`);
  const t = data.totals;
  const spendPct = data.today.budgetUsd > 0 ? Math.min(100, (data.today.spentUsd / data.today.budgetUsd) * 100) : 0;
  const meterClass = spendPct >= 90 ? 'meter bad' : spendPct >= 70 ? 'meter warn' : 'meter';

  const tile = (label, value, hint, extra) => h('div', { class: 'tile' }, h('span', { class: 'label', text: label }), h('span', { class: 'value', text: value }), extra || null, hint ? h('span', { class: 'hint', text: hint }) : null);
  const tiles = h('section', { class: 'tiles', 'aria-label': 'Totals' },
    tile('Users', whole.format(t.users), `+${t.new7d} this week`),
    tile('Active this week', whole.format(t.active7d), `${t.active1d} today`),
    tile('Paid', whole.format(t.paid), `${data.plans.pro || 0} Pro · ${data.plans.max || 0} Max`),
    tile('Spent today', usd(data.today.spentUsd), data.today.budgetUsd > 0 ? `of the ${usd(data.today.budgetUsd)} daily cap` : 'no daily cap',
      data.today.budgetUsd > 0 ? h('div', { class: meterClass, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(spendPct)), 'aria-label': 'Share of the daily cap used' }, h('span', { style: `width:${spendPct}%` })) : null),
    tile('Open requests', whole.format(t.openRequests), t.openRequests ? 'waiting for you' : 'all handled'));

  const charts = h('section', { class: 'grid-2' });
  const panels = ['requests', 'cost', 'signups', 'models'].map(() => h('div', { class: 'panel' }));
  charts.append(...panels);
  const top = h('section', { class: 'panel' }, h('h2', { text: `Top users, last ${days} days` }));

  main.replaceChildren(
    pageHead('Overview', `Last ${days} days, UTC`, seg([[7, '7 days'], [30, '30 days'], [90, '90 days']], days, (d) => { location.hash = `#/overview?days=${d}`; }, 'Date range')),
    tiles, charts, top,
  );

  lineChart(panels[0], { title: 'Requests', points: fillDays(data.usage, days, 'requests'), format: (v) => whole.format(Math.round(v)), tick: (v) => compact.format(v), integer: true });
  lineChart(panels[1], { title: 'Upstream cost', points: fillDays(data.usage, days, 'costUsd'), format: usd, tick: (v) => (v ? `$${compact.format(v)}` : '$0') });
  lineChart(panels[2], { title: 'Sign-ups', points: fillDays(data.signups, days, 'n'), format: (v) => whole.format(Math.round(v)), tick: (v) => compact.format(v), integer: true });
  panels[3].append(h('h2', { text: 'Cost by model' }));
  const modelHost = h('div');
  panels[3].append(modelHost);
  bars(modelHost, data.byModel.map((m) => ({ label: m.model, value: m.costUsd, note: `${whole.format(m.requests)} requests` })), usd);

  if (!data.topUsers.length) {
    top.append(h('p', { class: 'empty', text: 'No AI usage in this period yet.' }));
  } else {
    top.append(h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: 'User' }), h('th', { class: 'num', text: 'Requests' }), h('th', { class: 'num', text: 'Cost' }))),
      h('tbody', {}, data.topUsers.map((u) => h('tr', { class: 'clickable', onclick: () => { location.hash = `#/users/${u.id}`; } },
        h('td', {}, person(u)), h('td', { class: 'num', text: whole.format(u.requests) }), h('td', { class: 'num', text: usd(u.costUsd) }))))));
  }
}

/* ─────────────── Users ─────────────── */

async function users(main, query) {
  const q = query.get('q') || '';
  const plan = query.get('plan') || '';
  const status = query.get('status') || '';
  const page = Math.max(0, Number(query.get('page')) || 0);
  const go = (changes) => {
    const next = new URLSearchParams({ q, plan, status, page: String(page), ...changes });
    for (const [k, v] of [...next]) if (!v || v === '0') next.delete(k);
    location.hash = `#/users${next.size ? `?${next}` : ''}`;
  };
  const params = new URLSearchParams({ q, plan, status, page: String(page) });
  const data = await get(`/users?${params}`);

  const search = h('input', { class: 'input search', type: 'search', placeholder: 'Search name or email', value: q, 'aria-label': 'Search users' });
  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => go({ q: search.value.trim(), page: '0' }), 300);
  });

  const table = h('table', {},
    h('thead', {}, h('tr', {}, ['User', 'Plan'].map((c) => h('th', { text: c })), h('th', { class: 'num', text: 'Credits' }), h('th', { class: 'num', text: '30-day cost' }), h('th', { text: 'Last active' }), h('th', { text: 'Status' }))),
    h('tbody', {}, data.users.map((u) => {
      const [led, label] = statusOf(u);
      return h('tr', { class: 'clickable', tabindex: '0', onclick: () => { location.hash = `#/users/${u.id}`; }, onkeydown: (e) => { if (e.key === 'Enter') location.hash = `#/users/${u.id}`; } },
        h('td', {}, person(u)),
        h('td', {}, h('span', { class: 'tag', text: u.plan })),
        h('td', { class: 'num', text: credits(u.credits) }),
        h('td', { class: 'num', text: usd(u.costUsd30d) }),
        h('td', { class: 'muted', text: ago(u.lastActive) }),
        h('td', {}, h('span', { class: 'person' }, h('span', { class: `led ${led}` }), label)));
    })));

  const from = data.total ? page * 50 + 1 : 0;
  const to = page * 50 + data.users.length;
  main.replaceChildren(
    pageHead('Users', `${whole.format(data.total)} ${data.total === 1 ? 'account' : 'accounts'}`,
      search,
      seg([['', 'All plans'], ['free', 'Free'], ['pro', 'Pro'], ['max', 'Max']], plan, (v) => go({ plan: v, page: '0' }), 'Plan'),
      seg([['', 'Everyone'], ['admin', 'Admins'], ['banned', 'Suspended'], ['unverified', 'Unverified']], status, (v) => go({ status: v, page: '0' }), 'Status')),
    h('section', { class: 'panel' }, data.users.length ? table : h('p', { class: 'empty', text: 'No users match.' }),
      h('div', { class: 'pager' }, h('span', { text: data.total ? `${from}–${to} of ${whole.format(data.total)}` : '' }),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn small', disabled: page === 0, onclick: () => go({ page: String(page - 1) }) }, 'Previous'),
          h('button', { type: 'button', class: 'btn small', disabled: to >= data.total, onclick: () => go({ page: String(page + 1) }) }, 'Next')))));
  if (q) {
    search.focus();
    search.setSelectionRange(q.length, q.length);
  }
}

async function userDetail(main, id, query) {
  const data = await get(`/users/${encodeURIComponent(id)}`);
  const u = data.user;
  const tab = ['ledger', 'usage', 'requests'].includes(query.get('tab')) ? query.get('tab') : 'ledger';
  const refresh = () => route();

  const act = async (fn, done) => {
    try {
      await fn();
      toast(done);
      refresh();
    } catch (error) {
      toast(error.message, true);
    }
  };

  const amount = h('input', { class: 'input', type: 'number', step: '1', placeholder: 'e.g. 100 or -50', 'aria-label': 'Credits' });
  const bucket = h('select', { class: 'input', 'aria-label': 'Bucket' }, h('option', { value: 'bonus' }, 'Bonus (never expires)'), h('option', { value: 'plan' }, 'This month only'));
  const note = h('input', { class: 'input', placeholder: 'Why (shown in the ledger)', maxlength: '200', 'aria-label': 'Note' });
  const planSelect = h('select', { class: 'input', 'aria-label': 'Plan' }, ['free', 'pro', 'max'].map((p) => h('option', { value: p, selected: data.credits?.plan === p }, p[0].toUpperCase() + p.slice(1))));
  const roleSelect = h('select', { class: 'input', 'aria-label': 'Role' }, ['user', 'admin'].map((r) => h('option', { value: r, selected: u.role === r }, r === 'admin' ? 'Admin' : 'User')));
  const reason = h('input', { class: 'input', placeholder: 'Reason', maxlength: '200', 'aria-label': 'Reason' });

  const actions = h('div', { class: 'panel actions' },
    h('div', { class: 'action' }, h('h3', { text: 'Give or remove credits' }), amount, bucket, note,
      h('button', {
        type: 'button', class: 'btn primary', disabled: !data.credits, onclick: () => act(
          () => post(`/users/${id}/credits`, { credits: Number(amount.value), bucket: bucket.value, note: note.value }),
          Number(amount.value) < 0 ? 'Credits removed' : 'Credits added'),
      }, 'Apply'),
      !data.credits ? h('span', { class: 'muted', text: 'Available once they verify their email.' }) : null),
    h('div', { class: 'action' }, h('h3', { text: 'Plan' }), h('div', { class: 'row' }, planSelect,
      h('button', { type: 'button', class: 'btn', disabled: !data.credits, onclick: () => act(() => post(`/users/${id}/plan`, { plan: planSelect.value }), 'Plan updated') }, 'Set'))),
    h('div', { class: 'action' }, h('h3', { text: 'Role' }), h('div', { class: 'row' }, roleSelect,
      h('button', { type: 'button', class: 'btn', onclick: () => act(() => post(`/users/${id}/role`, { role: roleSelect.value }), 'Role updated') }, 'Save'))),
    h('div', { class: 'action' }, h('h3', { text: u.banned ? 'Suspended' : 'Suspend' }),
      u.banned
        ? h('div', {}, h('p', { class: 'muted', text: u.banReason ? `Reason: ${u.banReason}` : '' }),
          h('button', { type: 'button', class: 'btn', onclick: () => act(() => post(`/users/${id}/restore`), 'Account restored') }, 'Restore account'))
        : h('div', { class: 'actions' }, reason,
          h('button', {
            type: 'button', class: 'btn danger', onclick: () => {
              if (!reason.value.trim()) return toast('Add a reason first.', true);
              if (confirm(`Suspend ${u.email}? They are signed out everywhere and can't use AI.`)) act(() => post(`/users/${id}/suspend`, { reason: reason.value }), 'Account suspended');
            },
          }, 'Suspend account'))),
    h('div', { class: 'action' }, h('h3', { text: 'Sessions' }), h('span', { class: 'muted', text: `${data.sessions.active} active · last seen ${ago(data.sessions.lastSeen)}` }),
      h('button', { type: 'button', class: 'btn', onclick: () => { if (confirm('Sign this user out on every device?')) act(() => post(`/users/${id}/sign-out`), 'Signed out everywhere'); } }, 'Sign out everywhere')));

  const c = data.credits;
  const summary = h('section', { class: 'panel' },
    h('div', { class: 'person' }, avatar(u), h('div', { class: 'person-text' }, h('strong', { text: u.name || '—' }), h('span', { text: u.email }))),
    h('dl', { class: 'facts', style: 'margin-top:16px' },
      h('dt', { text: 'Credits left' }), h('dd', { text: c ? `${credits(c.remaining)} (${credits(c.planCredits)} plan + ${credits(c.bonusCredits)} bonus)` : 'Not started (unverified)' }),
      h('dt', { text: 'Plan' }), h('dd', { text: c ? `${c.planName}, renews ${new Date(c.periodEnd).toLocaleDateString()}` : '—' }),
      h('dt', { text: 'Signs in with' }), h('dd', { text: data.providers.map((p) => (p === 'credential' ? 'email + password' : p)).join(', ') || '—' }),
      h('dt', { text: 'Joined' }), h('dd', { text: new Date(u.createdAt).toLocaleDateString() }),
      h('dt', { text: 'Status' }), h('dd', {}, h('span', { class: 'person' }, h('span', { class: `led ${u.banned ? 'red' : u.emailVerified ? 'green' : 'amber'}` }), u.banned ? 'Suspended' : u.emailVerified ? 'Verified' : 'Email not verified'))));

  const tabs = seg([['ledger', 'Ledger'], ['usage', 'AI requests'], ['requests', 'Upgrade requests']], tab, (v) => { location.hash = `#/users/${id}?tab=${v}`; }, 'History');
  let body;
  if (tab === 'ledger') {
    body = data.ledger.length ? h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: 'When' }), h('th', { text: 'What' }), h('th', { class: 'num', text: 'Change' }), h('th', { class: 'num', text: 'Plan' }), h('th', { class: 'num', text: 'Bonus' }), h('th', { text: 'Note' }))),
      h('tbody', {}, data.ledger.map((e) => h('tr', {},
        h('td', { class: 'muted nowrap', text: when(e.at) }), h('td', { text: e.kind.replace(/_/g, ' ') }),
        h('td', { class: 'num', text: `${e.delta > 0 ? '+' : ''}${credits(e.delta)}` }),
        h('td', { class: 'num', text: credits(e.planAfter) }), h('td', { class: 'num', text: credits(e.bonusAfter) }),
        h('td', { class: 'muted', text: `${e.note || ''}${e.byAdmin ? ' (admin)' : ''}` })))))
      : h('p', { class: 'empty', text: 'No credit activity yet.' });
  } else if (tab === 'usage') {
    body = data.usage.length ? h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: 'When' }), h('th', { text: 'Model' }), h('th', { text: 'Status' }), h('th', { class: 'num', text: 'In / out / cached' }), h('th', { class: 'num', text: 'Cost' }), h('th', { class: 'num', text: 'Credits' }))),
      h('tbody', {}, data.usage.map((e) => h('tr', {},
        h('td', { class: 'muted nowrap', text: when(e.at) }), h('td', { text: e.served && e.served !== e.model ? `${e.model} → ${e.served}` : e.model }),
        h('td', { text: e.status }),
        h('td', { class: 'num', text: `${compact.format(e.input)} / ${compact.format(e.output)} / ${compact.format(e.cached)}` }),
        h('td', { class: 'num', text: usd(e.costUsd) }), h('td', { class: 'num', text: credits(e.credits) })))))
      : h('p', { class: 'empty', text: 'No AI requests yet.' });
  } else {
    body = data.requests.length ? h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: 'When' }), h('th', { text: 'Plan' }), h('th', { text: 'Status' }), h('th', { text: 'Note' }))),
      h('tbody', {}, data.requests.map((r) => h('tr', {}, h('td', { class: 'muted nowrap', text: when(r.at) }), h('td', { text: r.plan }), h('td', { text: r.status }), h('td', { class: 'muted', text: r.note || '' })))))
      : h('p', { class: 'empty', text: 'No upgrade requests.' });
  }

  main.replaceChildren(
    h('a', { href: '#/users', class: 'muted', style: 'display:inline-block;margin-bottom:12px;font-size:13px' }, '← Users'),
    pageHead(u.name || u.email, u.email),
    h('div', { class: 'detail' }, h('div', { style: 'display:grid;gap:16px;min-width:0' }, summary, h('section', { class: 'panel' }, h('div', { class: 'tabs' }, tabs), body)), actions));
}

/* ─────────────── Upgrade requests ─────────────── */

async function requests(main, query) {
  const status = ['open', 'approved', 'declined'].includes(query.get('status')) ? query.get('status') : 'open';
  const data = await get(`/requests?status=${status}`);
  const decide = async (r, action) => {
    try {
      await post(`/requests/${r.id}`, { action });
      toast(action === 'approve' ? `${r.user.email} is now on ${r.plan}` : 'Request declined');
      route();
      refreshCount();
    } catch (error) {
      toast(error.message, true);
    }
  };
  main.replaceChildren(
    pageHead('Upgrade requests', 'Until a payment provider is connected, upgrades are requests you approve here.',
      seg([['open', 'Open'], ['approved', 'Approved'], ['declined', 'Declined']], status, (v) => { location.hash = `#/requests?status=${v}`; }, 'Status')),
    h('section', { class: 'panel' }, data.requests.length ? h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: 'User' }), h('th', { text: 'Wants' }), h('th', { text: 'Now on' }), h('th', { text: 'Note' }), h('th', { text: 'When' }), status === 'open' ? h('th', {}) : null)),
      h('tbody', {}, data.requests.map((r) => h('tr', {},
        h('td', {}, h('a', { href: `#/users/${r.user.id}` }, person(r.user))),
        h('td', {}, h('span', { class: 'tag', text: r.plan })),
        h('td', {}, h('span', { class: 'tag', text: r.user.plan })),
        h('td', { class: 'muted', text: r.note || '' }),
        h('td', { class: 'muted', text: ago(r.at) }),
        status === 'open' ? h('td', {}, h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn small primary', onclick: () => decide(r, 'approve') }, 'Approve'),
          h('button', { type: 'button', class: 'btn small', onclick: () => decide(r, 'decline') }, 'Decline'))) : null))))
      : h('p', { class: 'empty', text: status === 'open' ? 'No open requests.' : 'Nothing here.' })));
}

/* ─────────────── Settings ─────────────── */

async function settings(main) {
  const data = await get('/settings');
  const original = data.settings;
  const s = structuredClone(original);
  const models = data.models;

  const savebar = h('div', { class: 'savebar', hidden: true },
    h('span', { text: 'Unsaved changes' }),
    h('button', { type: 'button', class: 'btn', onclick: () => route() }, 'Discard'),
    h('button', { type: 'button', class: 'btn primary', onclick: save }, 'Save changes'));
  const dirty = () => { savebar.hidden = JSON.stringify(s) === JSON.stringify(original); };

  function numberField(label, key, { step = '1', min, max, hint } = {}) {
    const input = h('input', { class: 'input', type: 'number', step, min, max, value: String(s[key]) });
    input.addEventListener('input', () => { s[key] = step === '1' ? Math.round(Number(input.value)) : Number(input.value); dirty(); example(); });
    return h('label', { class: 'field' }, h('span', { text: label }), input, hint ? h('span', { class: 'muted', style: 'font-size:12px', text: hint }) : null);
  }

  const exampleLine = h('p', { class: 'muted', style: 'margin:0;font-size:12.5px' });
  function example() {
    const used = 0.1 * s.creditsPerUsd * s.markup;
    const every = s.plans.free.periodHours ? `every ${s.plans.free.periodHours} hour${s.plans.free.periodHours === 1 ? '' : 's'}` : 'a month';
    exampleLine.textContent = `A request that costs us $0.10 uses ${Math.round(used * 10) / 10} credits. Free users get ${whole.format(s.signupBonusCredits)} welcome credits plus ${whole.format(s.plans.free.monthlyCredits)} ${every}.`;
  }

  const planCols = ['free', 'pro', 'max'].map((id) => {
    const p = s.plans[id];
    const name = h('input', { class: 'input', value: p.name, maxlength: '40', 'aria-label': `${id} plan name` });
    name.addEventListener('input', () => { p.name = name.value; dirty(); });
    const monthly = h('input', { class: 'input', type: 'number', step: '1', min: '0', value: String(p.monthlyCredits), 'aria-label': `${id} monthly credits` });
    monthly.addEventListener('input', () => { p.monthlyCredits = Math.round(Number(monthly.value)); dirty(); example(); });
    const price = h('input', { class: 'input', type: 'number', step: '1', min: '0', value: String(p.priceUsd), 'aria-label': `${id} price` });
    price.addEventListener('input', () => { p.priceUsd = Number(price.value); dirty(); });
    const period = h('input', { class: 'input', type: 'number', step: '1', min: '0', max: '720', value: String(p.periodHours || 0), 'aria-label': `${id} refill period in hours` });
    period.addEventListener('input', () => { p.periodHours = Math.round(Number(period.value)) || null; dirty(); example(); });
    const checks = h('div', { class: 'checks' }, models.map((m) => {
      const box = h('input', { type: 'checkbox', checked: p.models.includes(m.id) });
      box.addEventListener('change', () => {
        p.models = box.checked ? [...p.models, m.id] : p.models.filter((x) => x !== m.id);
        dirty();
      });
      return h('label', {}, box, m.name);
    }));
    return h('div', { class: 'plan-col' }, h('span', { class: 'label', text: id }),
      h('label', { class: 'field' }, h('span', { text: 'Name' }), name),
      h('label', { class: 'field' }, h('span', { text: 'Credits each period' }), monthly),
      h('label', { class: 'field' }, h('span', { text: 'Refills every (hours; 0 = calendar month)' }), period),
      h('label', { class: 'field' }, h('span', { text: 'Price (USD a month)' }), price),
      h('div', { class: 'field' }, h('span', { text: 'Models' }), checks));
  });

  const enabled = h('div', { class: 'checks' }, models.map((m) => {
    const box = h('input', { type: 'checkbox', checked: s.enabledModels.includes(m.id) });
    box.addEventListener('change', () => {
      s.enabledModels = box.checked ? [...s.enabledModels, m.id] : s.enabledModels.filter((x) => x !== m.id);
      dirty();
    });
    const noKey = data.server && m.vendor && data.server[m.vendor] === false;
    return h('label', {}, box, `${m.name}`, h('span', { class: 'muted', text: ` · $${m.input} in / $${m.output} out per million tokens${noKey ? ` · no ${m.vendor === 'openai' ? 'OpenAI' : 'Anthropic'} key on this server, so it is not offered` : ''}` }));
  }));
  const defaultModel = h('select', { class: 'input' }, models.map((m) => h('option', { value: m.id, selected: s.defaultModel === m.id }, m.name)));
  defaultModel.addEventListener('change', () => { s.defaultModel = defaultModel.value; dirty(); });

  // Routing: which model answers which kind of work, and where to escalate.
  const KINDS = [['agent', 'Agent (builds and edits code)'], ['plan', 'Plan'], ['debug', 'Debug'], ['ask', 'Ask (explanations, no tools)'], ['summary', 'Summaries of long chats']];
  const modelSelect = (value, onChange, { allowNone = false } = {}) => {
    const sel = h('select', { class: 'input' },
      allowNone ? h('option', { value: '', selected: !value }, 'none') : null,
      ...models.map((m) => h('option', { value: m.id, selected: value === m.id }, `${m.name} · $${m.input}/$${m.output} per M tokens`)));
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  };
  const routingRows = KINDS.map(([kind, label]) => h('label', { class: 'field' }, h('span', { text: label }), modelSelect(s.routing[kind], (v) => { s.routing[kind] = v; dirty(); })));
  const ladder = [0, 1].map((i) => h('label', { class: 'field' }, h('span', { text: i === 0 ? 'When a turn fails once, escalate to' : 'and if it fails again, to' }),
    modelSelect(s.routing.escalation[i] || '', (v) => {
      const next = [...s.routing.escalation];
      if (v) next[i] = v; else next.splice(i);
      s.routing.escalation = next.filter(Boolean).slice(0, 3);
      dirty();
    }, { allowNone: true })));

  const maintenance = h('input', { type: 'checkbox', checked: s.maintenance });
  maintenance.addEventListener('change', () => { s.maintenance = maintenance.checked; dirty(); });
  const announcement = h('textarea', { class: 'input', rows: '2', maxlength: '280', style: 'height:auto;padding:8px 12px;resize:vertical' });
  announcement.value = s.announcement;
  announcement.addEventListener('input', () => { s.announcement = announcement.value; dirty(); });

  const srv = data.server;
  const check = (ok, text) => h('li', {}, h('span', { class: `led ${ok ? 'green' : 'red'}` }), text);

  async function save() {
    const patch = {};
    for (const key of Object.keys(s)) if (JSON.stringify(s[key]) !== JSON.stringify(original[key])) patch[key] = s[key];
    try {
      await call('PUT', '/settings', patch);
      toast('Settings saved');
      route();
    } catch (error) {
      toast(error.message, true);
    }
  }

  example();
  main.replaceChildren(
    pageHead('Settings', 'Changes apply to every user within about 15 seconds.'),
    h('div', { class: 'settings' },
      h('section', { class: 'panel' }, h('h2', { text: 'Credits' }),
        h('div', { class: 'fields' },
          numberField('Welcome credits', 'signupBonusCredits', { min: '0' }),
          numberField('Credits per US dollar of API cost', 'creditsPerUsd', { step: 'any', min: '1' }),
          numberField('Markup', 'markup', { step: 'any', min: '0.1', max: '10', hint: '1 = cost price; 1.25 = 25% more credits per request.' })),
        exampleLine),
      h('section', { class: 'panel' }, h('h2', { text: 'Plans' }), h('div', { class: 'plans' }, planCols)),
      h('section', { class: 'panel' }, h('h2', { text: 'Models' }),
        h('div', { class: 'field' }, h('span', { text: 'Available' }), enabled),
        h('label', { class: 'field', style: 'max-width:320px' }, h('span', { text: 'Fallback model' }), defaultModel)),
      h('section', { class: 'panel' }, h('h2', { text: 'Routing' }),
        h('p', { class: 'muted', style: 'margin:0 0 10px;font-size:12.5px', text: 'People see one Impulse AI. These decide which model answers each kind of work, cheapest first; a turn that already failed climbs the escalation list.' }),
        h('div', { class: 'fields' }, ...routingRows),
        h('div', { class: 'fields' }, ...ladder)),
      h('section', { class: 'panel' }, h('h2', { text: 'Limits' }),
        h('div', { class: 'fields' },
          numberField('Requests per minute, per user', 'rateLimitPerMinute', { min: '1' }),
          numberField('Daily spend cap (USD, 0 = none)', 'dailyBudgetUsd', { step: 'any', min: '0', hint: 'AI pauses for everyone once today\'s API cost reaches this.' }),
          numberField('Longest answer (output tokens)', 'maxOutputTokens', { min: '1024', max: '128000' }))),
      h('section', { class: 'panel' }, h('h2', { text: 'In the app' }),
        h('label', { class: 'switch' }, maintenance, 'Maintenance mode: pause AI for everyone'),
        h('label', { class: 'field' }, h('span', { text: 'Announcement (shown under the chat box, up to 280 characters)' }), announcement)),
      h('section', { class: 'panel' }, h('h2', { text: 'This server' }),
        h('ul', { class: 'status-list' },
          check(srv.openai, srv.openai ? 'OpenAI API key is set' : 'No OpenAI API key: GPT models are not offered'),
          check(srv.anthropic, srv.anthropic ? 'Anthropic API key is set' : 'No Anthropic API key: Claude models are not offered'),
          check(srv.google, srv.google ? 'Google sign-in is on' : 'Google sign-in is off (no client id)'),
          check(srv.github, srv.github ? 'GitHub sign-in is on' : 'GitHub sign-in is off (no client id)'),
          check(srv.email === 'resend', srv.email === 'resend' ? 'Email codes go out through Resend' : srv.email === 'log' ? 'Email codes are only printed to the server log' : 'Email sign-up is off'),
          h('li', { class: 'muted', text: `Public address: ${srv.baseURL}` }))),
      savebar));
}

/* ─────────────── Audit log ─────────────── */

async function audit(main) {
  const data = await get('/audit');
  const tbody = h('tbody');
  const add = (entries) => tbody.append(...entries.map((e) => h('tr', {},
    h('td', { class: 'muted nowrap', text: when(e.at) }), h('td', { text: e.actor || '—' }), h('td', { text: e.action }),
    h('td', {}, e.targetId ? h('a', { href: `#/users/${e.targetId}`, text: e.target || e.targetId }) : '—'),
    h('td', { class: 'muted', text: e.detail ? JSON.stringify(e.detail) : '' }))));
  add(data.entries);
  let oldest = data.entries.at(-1)?.id;
  const more = h('button', {
    type: 'button', class: 'btn small', hidden: data.entries.length < 100, onclick: async () => {
      const page = await get(`/audit?before=${oldest}`);
      add(page.entries);
      oldest = page.entries.at(-1)?.id;
      more.hidden = page.entries.length < 100;
    },
  }, 'Load older');
  main.replaceChildren(pageHead('Audit log', 'Every change made in this console.'),
    h('section', { class: 'panel' }, data.entries.length
      ? h('div', {}, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Who', 'What', 'User', 'Details'].map((c) => h('th', { text: c })))), tbody), h('div', { class: 'pager' }, h('span'), more))
      : h('p', { class: 'empty', text: 'Nothing has been changed yet.' })));
}

/* ─────────────── Learning ─────────────── */

async function learning(main, query) {
  const days = [7, 30, 90].includes(Number(query.get('days'))) ? Number(query.get('days')) : 30;
  const data = await get(`/learning?days=${days}`);
  const rows = data.signatures.map((s) => {
    const details = h('tr', { class: 'details', hidden: true }, h('td', { colspan: '6' },
      h('p', { class: 'muted', style: 'margin:0 0 8px;font-size:12.5px', text: s.excerpt }),
      s.diff ? h('pre', { class: 'code', text: s.diff }) : h('p', { class: 'muted', text: 'Fixed without a code change (port, wiring or board setting).' })));
    const row = h('tr', { class: 'clickable', onclick: () => { details.hidden = !details.hidden; } },
      h('td', {}, h('span', { class: 'tag', text: s.kind }), ' ', h('span', { text: s.signature.replace(/^(?:compile|upload):/, '').replace(/^[A-Z_]+:/, '') })),
      h('td', { class: 'nowrap', text: `${s.fixes}` }), h('td', { class: 'nowrap', text: `${s.users}` }),
      h('td', { class: 'nowrap', text: s.fixes ? `${Math.round((s.byAgent / s.fixes) * 100)}%` : '—' }),
      h('td', { class: 'muted', text: [s.board, s.coreVersion].filter(Boolean).join(' · ') }),
      h('td', { class: 'muted nowrap', text: ago(s.lastAt) }));
    return [row, details];
  }).flat();
  main.replaceChildren(
    pageHead('Learning from fixes', `What people struggled with and what fixed it, last ${days} days. ${data.enabled ? 'Intake is on.' : 'Intake is off (Settings).'}`,
      seg([[7, '7 days'], [30, '30 days'], [90, '90 days']], days, (d) => { location.hash = `#/learning?days=${d}`; }, 'Date range')),
    h('section', { class: 'tiles', 'aria-label': 'Totals' },
      h('div', { class: 'tile' }, h('span', { class: 'label', text: 'Fixes shared' }), h('span', { class: 'value', text: `${data.total}` }), h('span', { class: 'hint', text: `last ${days} days` })),
      h('div', { class: 'tile' }, h('span', { class: 'label', text: 'People' }), h('span', { class: 'value', text: `${data.users}` }), h('span', { class: 'hint', text: 'who shared a fix' })),
      h('div', { class: 'tile' }, h('span', { class: 'label', text: 'Fixed by the agent' }), h('span', { class: 'value', text: data.total ? `${Math.round((data.byAgent / data.total) * 100)}%` : '—' }), h('span', { class: 'hint', text: 'the rest by hand' }))),
    h('section', { class: 'panel' }, rows.length
      ? h('table', {}, h('thead', {}, h('tr', {}, ['Error', 'Fixes', 'People', 'By agent', 'Board · core', 'Last'].map((c) => h('th', { text: c })))), h('tbody', {}, rows))
      : h('p', { class: 'empty', text: 'No fixes shared yet. They arrive when a failed build is followed by a success in an app with sharing on.' })));
}

/* ─────────────── Router ─────────────── */

async function refreshCount() {
  try {
    const { requests: open } = await get('/requests?status=open');
    const el = $('#requestCount');
    el.textContent = String(open.length);
    el.hidden = open.length === 0;
  } catch { /* the badge is optional */ }
}

async function route() {
  const [path, qs] = (location.hash.slice(1) || '/overview').split('?');
  const query = new URLSearchParams(qs || '');
  const parts = path.split('/').filter(Boolean);
  const section = parts[0] || 'overview';
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === section) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const main = $('#main');
  main.classList.add('loading');
  try {
    if (section === 'users' && parts[1]) await userDetail(main, parts[1], query);
    else if (section === 'users') await users(main, query);
    else if (section === 'requests') await requests(main, query);
    else if (section === 'settings') await settings(main);
    else if (section === 'audit') await audit(main);
    else if (section === 'learning') await learning(main, query);
    else await overview(main, query);
    document.title = `${main.querySelector('h1')?.textContent || 'Admin'} · Impulse admin`;
  } catch (error) {
    if (!(error instanceof ApiError && error.message === 'Signed out')) {
      main.replaceChildren(h('div', { class: 'notice error' }, h('span', { class: 'led red' }), error.message));
    }
  } finally {
    main.classList.remove('loading');
  }
}

function gate(text, led, actions = []) {
  $('#shell').hidden = true;
  $('#gate').hidden = false;
  $('#gateText').textContent = text;
  $('#gateLed').className = `led ${led}`;
  $('#gateActions').replaceChildren(...actions);
}

async function signOut() {
  await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
  location.href = '/sign-in/?next=/admin/';
}

async function start() {
  gate('Checking your session…', 'amber pulse');
  const res = await fetch('/admin/api/me', { credentials: 'same-origin' });
  if (res.status === 401) {
    location.replace('/sign-in/?next=/admin/');
    return;
  }
  if (res.status === 403) {
    gate('This account isn\'t an Impulse admin.', 'red', [h('button', { type: 'button', class: 'btn', onclick: signOut }, 'Use another account')]);
    return;
  }
  if (!res.ok) {
    gate('The admin API isn\'t answering. Try again in a moment.', 'red', [h('button', { type: 'button', class: 'btn', onclick: () => location.reload() }, 'Retry')]);
    return;
  }
  const { admin } = await res.json();
  $('#who').textContent = admin.email;
  $('#signOut').addEventListener('click', signOut);
  $('#gate').hidden = true;
  $('#shell').hidden = false;
  window.addEventListener('hashchange', () => {
    route();
    $('#main').focus({ preventScroll: true });
  });
  route();
  refreshCount();
}

start();
