import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, setup } from './helpers.js';
import { DEFAULTS } from '../src/settings.js';

// What a fresh account holds: the Free plan's allowance plus the welcome bonus.
const NEW_ACCOUNT_CREDITS = DEFAULTS.plans.free.monthlyCredits + DEFAULTS.signupBonusCredits;

describe('accounts', () => {
  let t;
  before(async () => { t = await setup(); });
  after(async () => { await t.close(); });

  test('the public config lists the sign-in methods this server has', async () => {
    const res = await t.request('/v1/config');
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).auth, { google: false, github: false, email: true });
  });

  test('the desktop app passes the CSRF check by naming the cloud origin', async () => {
    // Node's fetch (the app's main process) sends Sec-Fetch-Mode, so Better Auth
    // wants an Origin; the app sends the cloud's own. Other origins stay blocked.
    const body = { name: 'Desk Top', email: 'desktop@impulse.test', password: 'correct horse battery' };
    const bare = await t.json('/api/auth/sign-up/email', body, { headers: { 'sec-fetch-mode': 'cors' } });
    assert.equal(bare.status, 403);
    const evil = await t.json('/api/auth/sign-up/email', body, { headers: { 'sec-fetch-mode': 'cors', origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    const ok = await t.json('/api/auth/sign-up/email', body, { headers: { 'sec-fetch-mode': 'cors', origin: BASE } });
    assert.equal(ok.status, 200);
  });

  test('email sign-up needs the emailed code before it can sign in', async () => {
    const email = 'new@impulse.test';
    const signUp = await t.json('/api/auth/sign-up/email', { name: 'New Maker', email, password: 'correct horse battery' });
    assert.equal(signUp.status, 200);
    await new Promise((r) => setTimeout(r, 5));
    assert.match(t.codeFor(email), /^\d{6}$/);

    const early = await t.json('/api/auth/sign-in/email', { email, password: 'correct horse battery' });
    assert.equal(early.status, 403, 'unverified accounts cannot sign in');

    const wrong = await t.json('/api/auth/email-otp/verify-email', { email, otp: '000000' === t.codeFor(email) ? '111111' : '000000' });
    assert.equal(wrong.status, 400);

    const ok = await t.json('/api/auth/email-otp/verify-email', { email, otp: t.codeFor(email) });
    assert.equal(ok.status, 200);
    const { token, user } = await ok.json();
    assert.ok(token, 'verifying signs the user in');
    await t.settleBackground();
    const opened = await t.pool.query('select bonus_credits from credit_account where user_id = $1', [user.id]);
    assert.equal(opened.rows[0]?.bonus_credits, 200_000, 'credits start as soon as the email is verified');

    const me = await t.request('/v1/me', { headers: t.bearer(token) });
    assert.equal(me.status, 200);
    const body = await me.json();
    assert.equal(body.user.email, email);
    assert.equal(body.needsVerification, false);
    // The Free plan's allowance plus the welcome bonus.
    assert.equal(body.credits.remaining, NEW_ACCOUNT_CREDITS);
    assert.equal(body.credits.plan, 'free');
  });

  test('password sign-in returns a bearer token; a wrong password does not', async () => {
    await t.signUp('pw@impulse.test');
    const bad = await t.json('/api/auth/sign-in/email', { email: 'pw@impulse.test', password: 'not the password' });
    assert.equal(bad.status, 401);
    const good = await t.json('/api/auth/sign-in/email', { email: 'pw@impulse.test', password: 'correct horse battery' });
    assert.equal(good.status, 200);
    const token = good.headers.get('set-auth-token') || (await good.json()).token;
    const me = await t.request('/v1/me', { headers: t.bearer(token) });
    assert.equal(me.status, 200);
  });

  test('the welcome bonus is granted once, however often /v1/me is read', async () => {
    const { token } = await t.signUp('once@impulse.test');
    const reads = await Promise.all([1, 2, 3, 4].map(() => t.request('/v1/me', { headers: t.bearer(token) })));
    for (const r of reads) assert.equal((await r.json()).credits.remaining, NEW_ACCOUNT_CREDITS);
    const { rows } = await t.pool.query(
      `select count(*)::int as n from credit_ledger l join "user" u on u.id = l.user_id where u.email = $1 and kind = 'signup_bonus'`,
      ['once@impulse.test'],
    );
    assert.equal(rows[0].n, 1);
  });

  test('without a session the account API answers 401', async () => {
    assert.equal((await t.request('/v1/me')).status, 401);
    assert.equal((await t.request('/v1/me', { headers: t.bearer('nonsense') })).status, 401);
  });

  test('password reset by emailed code signs other sessions out', async () => {
    const email = 'reset@impulse.test';
    const { token } = await t.signUp(email);
    const ask = await t.json('/api/auth/email-otp/request-password-reset', { email });
    assert.equal(ask.status, 200);
    await new Promise((r) => setTimeout(r, 5));
    const reset = await t.json('/api/auth/email-otp/reset-password', { email, otp: t.codeFor(email), password: 'a brand new password' });
    assert.equal(reset.status, 200);
    assert.equal((await t.request('/v1/me', { headers: t.bearer(token) })).status, 401, 'old session revoked');
    const signIn = await t.json('/api/auth/sign-in/email', { email, password: 'a brand new password' });
    assert.equal(signIn.status, 200);
  });
  test('sign-up limits cannot be dodged with made-up client addresses', async () => {
    // Five sign-ups a minute per address. A client that prepends its own
    // X-Forwarded-For (Cloud Run then appends the real address) and invents an
    // X-Real-IP per request must not get a fresh allowance per invented address.
    const tryOnce = (i, headers) => t.json('/api/auth/sign-up/email', { name: 'Spoof', email: `spoof-${i}-${Date.now()}@impulse.test`, password: 'correct horse battery' }, { headers });
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await tryOnce(i, { 'x-forwarded-for': `198.51.100.${i + 1}, 203.0.113.7`, 'x-real-ip': `192.0.2.${i + 1}` })).status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  });
});
