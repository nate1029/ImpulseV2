import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { DEFAULTS } from '../src/settings.js';

describe('admin API', () => {
  let t;
  let owner;
  let member;
  const write = (token) => ({ ...t.bearer(token), 'x-impulse-admin': '1' });

  before(async () => {
    t = await setup();
    // owner@impulse.test is in ADMIN_EMAILS (test config).
    owner = await t.signUp('owner@impulse.test', { name: 'Owner' });
    member = await t.signUp('member@impulse.test', { name: 'Member' });
    // Credit accounts are created on first read.
    await t.request('/v1/me', { headers: t.bearer(member.token) });
  });
  after(async () => { await t.close(); });

  test('only admins get in; a verified ADMIN_EMAILS address is promoted', async () => {
    assert.equal((await t.request('/admin/api/me')).status, 401);
    assert.equal((await t.request('/admin/api/me', { headers: t.bearer(member.token) })).status, 403);
    const me = await t.request('/admin/api/me', { headers: t.bearer(owner.token) });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).admin.role, 'admin');
  });

  test('changes need the admin header and the right origin', async () => {
    const path = `/admin/api/users/${member.user.id}/credits`;
    const noHeader = await t.json(path, { credits: 10, note: 'x' }, { headers: t.bearer(owner.token) });
    assert.equal(noHeader.status, 403);
    const crossSite = await t.json(path, { credits: 10, note: 'x' }, { headers: { ...write(owner.token), origin: 'https://evil.example' } });
    assert.equal(crossSite.status, 403);
  });

  test('granting credits needs a note and lands in the ledger and audit log', async () => {
    const path = `/admin/api/users/${member.user.id}/credits`;
    assert.equal((await t.json(path, { credits: 50 }, { headers: write(owner.token) })).status, 400);
    const res = await t.json(path, { credits: 50, note: 'Hackathon prize' }, { headers: write(owner.token) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).credits.remaining, DEFAULTS.plans.free.monthlyCredits + DEFAULTS.signupBonusCredits + 50);
    const detail = await (await t.request(`/admin/api/users/${member.user.id}`, { headers: t.bearer(owner.token) })).json();
    assert.equal(detail.ledger[0].kind, 'admin_grant');
    assert.equal(detail.ledger[0].note, 'Hackathon prize');
    const log = await (await t.request('/admin/api/audit', { headers: t.bearer(owner.token) })).json();
    assert.equal(log.entries[0].action, 'credits.grant');
    assert.equal(log.entries[0].target, 'member@impulse.test');
  });

  test('removing credits never goes below zero', async () => {
    const res = await t.json(`/admin/api/users/${member.user.id}/credits`, { credits: -100000, note: 'cleanup' }, { headers: write(owner.token) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).credits.bonusCredits, 0);
  });

  test('upgrade requests: the user asks, the admin approves, the plan changes', async () => {
    const ask = await t.json('/v1/upgrade-request', { plan: 'pro', note: 'for my robotics club' }, { headers: t.bearer(member.token) });
    assert.equal(ask.status, 200);
    const plans = await (await t.request('/v1/plans', { headers: t.bearer(member.token) })).json();
    assert.equal(plans.pendingRequest.plan, 'pro');
    const open = await (await t.request('/admin/api/requests', { headers: t.bearer(owner.token) })).json();
    assert.equal(open.requests.length, 1);
    const decide = await t.json(`/admin/api/requests/${open.requests[0].id}`, { action: 'approve' }, { headers: write(owner.token) });
    assert.equal(decide.status, 200);
    const me = await (await t.request('/v1/me', { headers: t.bearer(member.token) })).json();
    assert.equal(me.credits.plan, 'pro');
    assert.equal(me.credits.planCredits, 1500);
  });

  test('suspending signs the user out everywhere and blocks AI', async () => {
    const res = await t.json(`/admin/api/users/${member.user.id}/suspend`, { reason: 'abuse' }, { headers: write(owner.token) });
    assert.equal(res.status, 200);
    assert.equal((await t.request('/v1/me', { headers: t.bearer(member.token) })).status, 401);
    const restore = await t.json(`/admin/api/users/${member.user.id}/restore`, {}, { headers: write(owner.token) });
    assert.equal(restore.status, 200);
    const signIn = await t.json('/api/auth/sign-in/email', { email: 'member@impulse.test', password: 'correct horse battery' });
    assert.equal(signIn.status, 200);
  });

  test('an admin cannot suspend or demote themselves', async () => {
    assert.equal((await t.json(`/admin/api/users/${owner.user.id}/suspend`, { reason: 'x' }, { headers: write(owner.token) })).status, 409);
    assert.equal((await t.json(`/admin/api/users/${owner.user.id}/role`, { role: 'user' }, { headers: write(owner.token) })).status, 409);
  });

  test('settings are validated before they are saved', async () => {
    const bad = await t.request('/admin/api/settings', { method: 'PUT', headers: { ...write(owner.token), 'content-type': 'application/json' }, body: JSON.stringify({ markup: 50 }) });
    assert.equal(bad.status, 400);
    const unknown = await t.request('/admin/api/settings', { method: 'PUT', headers: { ...write(owner.token), 'content-type': 'application/json' }, body: JSON.stringify({ freeMoney: true }) });
    assert.equal(unknown.status, 400);
    const ok = await t.request('/admin/api/settings', { method: 'PUT', headers: { ...write(owner.token), 'content-type': 'application/json' }, body: JSON.stringify({ signupBonusCredits: 300, announcement: 'Welcome!' }) });
    assert.equal(ok.status, 200);
    const me = await (await t.request('/v1/me', { headers: t.bearer(owner.token) })).json();
    assert.equal(me.announcement, 'Welcome!');
  });

  test('the overview and user list answer', async () => {
    const overview = await (await t.request('/admin/api/overview', { headers: t.bearer(owner.token) })).json();
    assert.equal(overview.totals.users, 2);
    assert.equal(typeof overview.today.spentUsd, 'number');
    const list = await (await t.request('/admin/api/users?q=member', { headers: t.bearer(owner.token) })).json();
    assert.equal(list.total, 1);
    assert.equal(list.users[0].email, 'member@impulse.test');
    const wildcard = await (await t.request('/admin/api/users?q=%25', { headers: t.bearer(owner.token) })).json();
    assert.equal(wildcard.total, 0, 'a % in the search is a literal character');
  });
});
