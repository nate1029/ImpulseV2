const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { CloudAccount } = require('../account');

const BASE = 'https://cloud.impulse.test';

/** A pretend keychain: "encrypts" by reversing, so tests can see it isn't plain. */
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from([...s].reverse().join('')),
  decryptString: (b) => [...b.toString()].reverse().join(''),
};

const ME = { user: { id: 'u1', name: 'Ada', email: 'ada@impulse.test', emailVerified: true, role: 'user' }, needsVerification: false, isAdmin: false, credits: { plan: 'free', remaining: 300 } };

function response(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body };
}

/** fetch stub: routes keyed by "METHOD /path". */
function fakeFetch(routes, calls = []) {
  return async (url, init) => {
    const { pathname, search } = new URL(url);
    calls.push({ method: init.method, path: pathname + search, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const route = routes[`${init.method} ${pathname}`];
    if (!route) return response(404, { error: 'not_found' });
    return typeof route === 'function' ? route(init) : route;
  };
}

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-account-'));
  return path.join(dir, 'impulse-account.json');
}

describe('CloudAccount', () => {
  test('email sign-in stores the token encrypted and never exposes it in status()', async () => {
    const file = tempFile();
    const calls = [];
    const account = new CloudAccount({
      baseURL: BASE, file, safeStorage, version: '2.1.0',
      fetch: fakeFetch({
        'POST /api/auth/sign-in/email': response(200, { token: 'raw-token-1234567890' }, { 'set-auth-token': 'signed-token-1234567890' }),
        'GET /v1/me': response(200, ME),
      }, calls),
    });
    const result = await account.signInEmail('ada@impulse.test', 'secret-pass');
    expect(result.ok).toBe(true);
    expect(account.sessionToken()).toBe('signed-token-1234567890');
    expect(JSON.stringify(account.status())).not.toContain('token-1234567890');
    expect(account.status()).toMatchObject({ signedIn: true, user: { email: 'ada@impulse.test' }, credits: { remaining: 300 } });
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.encrypted).toBe(true);
    expect(saved.token).not.toContain('signed-token');
    // The /v1/me call carried the bearer token and the client header.
    const me = calls.find((c) => c.path === '/v1/me');
    expect(me.headers.authorization).toBe('Bearer signed-token-1234567890');
    expect(me.headers['x-impulse-client']).toBe('Impulse IDE/2.1.0');
    // Every call names the cloud's own origin: Node's fetch sends Sec-Fetch-Mode,
    // and Better Auth's CSRF check rejects that without an Origin.
    expect(calls.every((c) => c.headers.origin === BASE)).toBe(true);
    // A new instance (next launch) reads it back.
    const again = new CloudAccount({ baseURL: BASE, file, safeStorage, fetch: fakeFetch({}) });
    expect(again.sessionToken()).toBe('signed-token-1234567890');
    expect(again.status().signedIn).toBe(true);
  });

  test('an unverified email asks for the code and sends a new one', async () => {
    const calls = [];
    const account = new CloudAccount({
      baseURL: BASE, file: tempFile(), safeStorage,
      fetch: fakeFetch({
        'POST /api/auth/sign-in/email': response(403, { code: 'EMAIL_NOT_VERIFIED', message: 'Email not verified' }),
        'POST /api/auth/email-otp/send-verification-otp': response(200, { success: true }),
      }, calls),
    });
    const result = await account.signInEmail('new@impulse.test', 'secret-pass');
    expect(result).toMatchObject({ ok: false, needsVerification: true, email: 'new@impulse.test' });
    expect(calls.at(-1)).toMatchObject({ path: '/api/auth/email-otp/send-verification-otp', body: { email: 'new@impulse.test', type: 'email-verification' } });
  });

  test('server errors become plain sentences', async () => {
    const account = new CloudAccount({
      baseURL: BASE, file: tempFile(), safeStorage,
      fetch: fakeFetch({ 'POST /api/auth/sign-in/email': response(401, { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' }) }),
    });
    expect((await account.signInEmail('a@b.co', 'x')).error).toBe('That email and password don\'t match.');
  });

  test('a session the server no longer knows signs out locally; offline keeps the cached account', async () => {
    const file = tempFile();
    const routes = { 'POST /api/auth/sign-in/email': response(200, { token: 'tok-abcdefghijklmnop' }), 'GET /v1/me': response(200, ME) };
    const account = new CloudAccount({ baseURL: BASE, file, safeStorage, fetch: fakeFetch(routes) });
    await account.signInEmail('ada@impulse.test', 'pw');

    account.fetch = async () => { throw new TypeError('fetch failed'); };
    await account.refresh();
    expect(account.status()).toMatchObject({ signedIn: true, offline: true });

    account.fetch = fakeFetch({ 'GET /v1/me': response(401, { error: 'unauthorized' }) });
    await account.refresh();
    expect(account.status().signedIn).toBe(false);
    expect(account.sessionToken()).toBeNull();
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).token).toBeNull();
  });

  test('Google sign-in goes through the browser and the loopback port', async () => {
    let browserLanding = null;
    const account = new CloudAccount({
      baseURL: BASE, file: tempFile(), safeStorage,
      fetch: fakeFetch({
        'POST /desktop/token': (init) => {
          const body = JSON.parse(init.body);
          return body.code === 'C'.repeat(43) && body.verifier ? response(200, { token: 'desktop-token-0123456789' }) : response(400, { error: 'invalid_grant' });
        },
        'GET /v1/me': response(200, ME),
      }),
      // Stand in for the browser: sign in "on the web", then come back to the app.
      openExternal: async (url) => {
        const target = new URL(url);
        expect(target.origin).toBe(BASE);
        expect(target.pathname).toBe('/sign-in/');
        expect(target.searchParams.get('provider')).toBe('google');
        expect(target.searchParams.get('challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const port = target.searchParams.get('port');
        const state = target.searchParams.get('state');
        http.get(`http://127.0.0.1:${port}/callback?code=${'C'.repeat(43)}&state=${state}`, (res) => {
          browserLanding = res.headers.location;
          res.resume();
        });
      },
    });
    const result = await account.signInWithProvider('google');
    expect(result.ok).toBe(true);
    expect(account.sessionToken()).toBe('desktop-token-0123456789');
    await new Promise((r) => setTimeout(r, 50));
    expect(browserLanding).toBe(`${BASE}/desktop/done/?status=ok`);
  });

  test('a callback with the wrong state is ignored, and cancelling ends the wait', async () => {
    let status = null;
    const account = new CloudAccount({
      baseURL: BASE, file: tempFile(), safeStorage, fetch: fakeFetch({}),
      openExternal: async (url) => {
        const port = new URL(url).searchParams.get('port');
        http.get(`http://127.0.0.1:${port}/callback?code=${'C'.repeat(43)}&state=not-the-state-at-all`, (res) => {
          status = res.statusCode;
          res.resume();
          setTimeout(() => account.cancelSignIn(), 10);
        });
      },
    });
    const result = await account.signInWithProvider('github');
    expect(status).toBe(400);
    expect(result).toEqual({ ok: false, cancelled: true });
  });

  test('without a cloud URL nothing is sent anywhere', async () => {
    const fetchSpy = jest.fn();
    const account = new CloudAccount({ baseURL: null, file: tempFile(), safeStorage, fetch: fetchSpy });
    expect(account.status().configured).toBe(false);
    expect((await account.signInEmail('a@b.co', 'pw')).ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
