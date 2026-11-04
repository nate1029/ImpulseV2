import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setup } from './helpers.js';
import { challengeOf } from '../src/desktop.js';

describe('desktop sign-in handoff', () => {
  let t;
  let cookie;
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('base64url');
  const query = (extra = {}) => new URLSearchParams({ port: '51234', state, challenge: challengeOf(verifier), ...extra });

  before(async () => {
    t = await setup();
    await t.signUp('browser@impulse.test');
    // The browser's session: what Google/GitHub sign-in leaves behind.
    const res = await t.json('/api/auth/sign-in/email', { email: 'browser@impulse.test', password: 'correct horse battery' });
    cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  });
  after(async () => { await t.close(); });

  async function codeFromRedirect() {
    const res = await t.request(`/desktop/complete?${query()}`, { headers: { cookie } });
    assert.equal(res.status, 302);
    const target = new URL(res.headers.get('location'));
    assert.equal(target.origin, 'http://127.0.0.1:51234');
    assert.equal(target.pathname, '/callback');
    assert.equal(target.searchParams.get('state'), state);
    return target.searchParams.get('code');
  }

  test('a signed-in browser is sent to the app\'s loopback port with a code', async () => {
    assert.match(await codeFromRedirect(), /^[A-Za-z0-9_-]{43}$/);
  });

  test('without a browser session it goes back to sign-in, keeping the desktop parameters', async () => {
    const res = await t.request(`/desktop/complete?${query()}`);
    assert.equal(res.status, 302);
    const back = new URL(res.headers.get('location'));
    assert.equal(back.pathname, '/sign-in/');
    assert.equal(back.searchParams.get('port'), '51234');
    assert.equal(back.searchParams.get('error'), 'not_signed_in');
  });

  test('bad parameters never redirect off this machine', async () => {
    for (const bad of [{ port: '80' }, { port: 'evil.com' }, { state: 'x' }, { challenge: 'short' }]) {
      const res = await t.request(`/desktop/complete?${query(bad)}`, { headers: { cookie } });
      assert.equal(res.status, 302);
      assert.match(res.headers.get('location'), /\/desktop\/done\/\?status=invalid$/);
    }
  });

  test('the code plus the verifier buys a new session, once', async () => {
    const code = await codeFromRedirect();
    const wrong = await t.json('/desktop/token', { code, verifier: randomBytes(32).toString('base64url') });
    assert.equal(wrong.status, 400);

    const fresh = await codeFromRedirect();
    const ok = await t.json('/desktop/token', { code: fresh, verifier });
    assert.equal(ok.status, 200);
    const { token, user } = await ok.json();
    assert.equal(user.email, 'browser@impulse.test');
    const me = await t.request('/v1/me', { headers: t.bearer(token) });
    assert.equal(me.status, 200);

    const again = await t.json('/desktop/token', { code: fresh, verifier });
    assert.equal(again.status, 400, 'codes are single use');
  });

  test('a wrong verifier burns the code', async () => {
    const code = await codeFromRedirect();
    await t.json('/desktop/token', { code, verifier: randomBytes(32).toString('base64url') });
    const retry = await t.json('/desktop/token', { code, verifier });
    assert.equal(retry.status, 400);
  });

  test('expired codes are refused', async () => {
    const code = await codeFromRedirect();
    await t.pool.query(`update desktop_code set expires_at = now() - interval '1 second'`);
    const res = await t.json('/desktop/token', { code, verifier });
    assert.equal(res.status, 400);
  });
});
