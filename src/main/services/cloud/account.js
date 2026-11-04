/**
 * The signed-in Impulse account on this computer: sign-in (email + password
 * with an emailed code, or Google/GitHub through the browser), the session
 * token (encrypted with the OS keychain via safeStorage), and the account's
 * plan and credits from Impulse Cloud. The renderer only ever sees status(),
 * never the token.
 * @module main/services/cloud/account
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { pkcePair, listenForCode } = require('./loopback');

const TIMEOUT_MS = 15000;

/** Better Auth error codes → what to tell the person. */
function friendly(code, status, message) {
  if (status === 429) return 'Too many tries. Wait a minute and try again.';
  switch (code) {
    case 'INVALID_EMAIL_OR_PASSWORD': return 'That email and password don\'t match.';
    case 'EMAIL_NOT_VERIFIED': return 'Verify your email first. We sent you a code.';
    case 'USER_ALREADY_EXISTS':
    case 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL': return 'An account with this email already exists. Sign in instead.';
    case 'PASSWORD_TOO_SHORT': return 'Use at least 8 characters for the password.';
    case 'PASSWORD_TOO_LONG': return 'That password is too long.';
    case 'INVALID_EMAIL': return 'That doesn\'t look like an email address.';
    case 'INVALID_OTP': return 'That code isn\'t right.';
    case 'OTP_EXPIRED': return 'That code expired. Send a new one.';
    case 'TOO_MANY_ATTEMPTS': return 'Too many wrong codes. Send a new one.';
    case 'BANNED_USER': return 'This account is suspended.';
    default: return message || 'Something went wrong. Try again.';
  }
}

class CloudAccount extends EventEmitter {
  /**
   * @param {{
   *   baseURL: string | null,
   *   file: string,
   *   safeStorage?: { isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string },
   *   openExternal?: (url: string) => Promise<void>,
   *   fetch?: typeof fetch,
   *   version?: string,
   * }} opts
   */
  constructor({ baseURL, file, safeStorage = null, openExternal = async () => {}, fetch: fetchImpl = fetch, version = '0.0.0' }) {
    super();
    this.baseURL = baseURL;
    this.file = file;
    this.safeStorage = safeStorage;
    this.openExternal = openExternal;
    this.fetch = fetchImpl;
    this.version = version;
    this.token = null;
    this.me = null;
    this.serverConfig = null;
    this.offline = false;
    this.pendingSignIn = null;
    this.refreshing = null;
    this.load();
  }

  // ── token storage ────────────────────────────────────────────────────────

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved?.token) {
        this.token = saved.encrypted
          ? this.safeStorage.decryptString(Buffer.from(saved.token, 'base64'))
          : saved.token;
      }
      // Shown until the first refresh, so the app opens signed in while offline.
      this.me = saved?.me || null;
    } catch {
      this.token = null;
      this.me = null;
    }
  }

  persist() {
    const encrypt = !!this.token && !!this.safeStorage?.isEncryptionAvailable?.();
    const data = {
      v: 1,
      encrypted: encrypt,
      token: this.token ? (encrypt ? this.safeStorage.encryptString(this.token).toString('base64') : this.token) : null,
      me: this.token ? this.me : null,
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data), { mode: 0o600 });
  }

  setToken(token) {
    this.token = token || null;
    if (!token) this.me = null;
    this.persist();
  }

  /** The session token, for the AI provider. */
  sessionToken() {
    return this.token;
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────

  async request(method, pathname, { body, auth = true } = {}) {
    if (!this.baseURL) return { ok: false, status: 0, data: null, error: 'Impulse Cloud isn\'t set up in this build.' };
    const headers = {
      accept: 'application/json',
      // Node's fetch sends Sec-Fetch-Mode, so Better Auth's CSRF check wants an
      // Origin. The app is a first-party client (bearer tokens, no cookies).
      origin: new URL(this.baseURL).origin,
      'user-agent': `Impulse IDE/${this.version} (${process.platform})`,
      'x-impulse-client': `Impulse IDE/${this.version}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth && this.token) headers.authorization = `Bearer ${this.token}`;
    let res;
    try {
      res = await this.fetch(`${this.baseURL}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { ok: false, status: 0, data: null, offline: true, error: 'Can\'t reach Impulse. Check your internet connection.' };
    }
    let data = null;
    try {
      data = await res.json();
    } catch { /* empty body */ }
    const error = res.ok ? null : friendly(data?.code, res.status, data?.message || data?.error?.message);
    return { ok: res.ok, status: res.status, data, headers: res.headers, error };
  }

  // ── learning from fixes ──────────────────────────────────────────────────

  /** Send one fix record (already redacted by FixCapture). */
  async shareFix(fix) {
    if (!this.token) return { ok: false, error: 'Not signed in.' };
    const body = {
      hash: fix.hash, signature: fix.signature, kind: fix.kind, failureCode: fix.failureCode, board: fix.board, core: fix.core,
      coreVersion: fix.coreVersion, libraries: fix.libraries, errorExcerpt: fix.errorExcerpt, diff: fix.diff, fixedBy: fix.fixedBy, model: fix.model,
    };
    return this.request('POST', '/v1/learn/fixes', { body });
  }

  /** Fixes other people found for this error (same board first). */
  async knownFixes(hash, board = null) {
    if (!this.token || !/^[a-f0-9]{8,32}$/.test(String(hash || ''))) return { ok: false, data: null };
    const q = new URLSearchParams({ hash });
    if (board) q.set('board', board);
    return this.request('GET', `/v1/learn/fixes?${q}`);
  }

  /** The most common errors and their fixes (cached an hour). */
  async learningManifest() {
    if (!this.token) return null;
    if (this.manifest && Date.now() - this.manifest.at < 60 * 60 * 1000) return this.manifest.value;
    const res = await this.request('GET', '/v1/knowledge/manifest');
    if (res.ok) this.manifest = { at: Date.now(), value: res.data };
    return res.ok ? res.data : this.manifest?.value || null;
  }

  // ── state ────────────────────────────────────────────────────────────────

  status() {
    const me = this.me;
    return {
      configured: !!this.baseURL,
      signedIn: !!this.token && !!me,
      offline: this.offline,
      user: me?.user || null,
      credits: me?.credits || null,
      needsVerification: !!me?.needsVerification,
      isAdmin: !!me?.isAdmin,
      announcement: me?.announcement || null,
      maintenance: !!me?.maintenance,
      auth: this.serverConfig?.auth || null,
      welcomeCredits: this.serverConfig?.welcomeCredits ?? null,
      freeMonthlyCredits: this.serverConfig?.freeMonthlyCredits ?? null,
      freePeriodHours: this.serverConfig?.freePeriodHours ?? null,
      adminURL: this.baseURL ? `${this.baseURL}/admin/` : null,
      signingIn: this.pendingSignIn ? this.pendingSignIn.provider : null,
    };
  }

  changed() {
    this.emit('change', this.status());
  }

  /** Sign-in methods the server offers (cached). */
  async config() {
    if (this.serverConfig) return this.serverConfig;
    const res = await this.request('GET', '/v1/config', { auth: false });
    if (res.ok) {
      this.serverConfig = res.data;
      this.changed();
    }
    return this.serverConfig;
  }

  /** Re-read the account (plan, credits). Signs out locally when the session is gone. */
  async refresh() {
    if (!this.token) return this.status();
    this.refreshing ??= (async () => {
      const res = await this.request('GET', '/v1/me');
      if (res.ok) {
        this.me = res.data;
        this.offline = false;
        this.persist();
      } else if (res.status === 401 || res.status === 403) {
        this.setToken(null);
        this.offline = false;
      } else if (res.offline) {
        this.offline = true;
      }
      this.changed();
      return this.status();
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async adopt(token) {
    this.setToken(token);
    await this.refresh();
    if (!this.me) return { ok: false, error: 'Signed in, but your account could not be loaded. Try again.' };
    return { ok: true, status: this.status() };
  }

  // ── email + password ─────────────────────────────────────────────────────

  async signInEmail(email, password) {
    const res = await this.request('POST', '/api/auth/sign-in/email', { body: { email, password }, auth: false });
    if (res.ok) return this.adopt(res.headers.get('set-auth-token') || res.data?.token);
    if (res.status === 403 && res.data?.code === 'EMAIL_NOT_VERIFIED') {
      await this.resendCode(email);
      return { ok: false, needsVerification: true, email, error: null };
    }
    return { ok: false, error: res.error };
  }

  async signUpEmail(name, email, password) {
    const res = await this.request('POST', '/api/auth/sign-up/email', { body: { name, email, password }, auth: false });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, needsVerification: true, email };
  }

  async verifyEmail(email, otp) {
    const res = await this.request('POST', '/api/auth/email-otp/verify-email', { body: { email, otp }, auth: false });
    if (!res.ok) return { ok: false, error: res.error };
    return this.adopt(res.headers.get('set-auth-token') || res.data?.token);
  }

  async resendCode(email) {
    const res = await this.request('POST', '/api/auth/email-otp/send-verification-otp', { body: { email, type: 'email-verification' }, auth: false });
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }

  async requestPasswordReset(email) {
    const res = await this.request('POST', '/api/auth/email-otp/request-password-reset', { body: { email }, auth: false });
    return res.ok ? { ok: true } : { ok: false, error: res.error };
  }

  async resetPassword(email, otp, password) {
    const res = await this.request('POST', '/api/auth/email-otp/reset-password', { body: { email, otp, password }, auth: false });
    if (!res.ok) return { ok: false, error: res.error };
    return this.signInEmail(email, password);
  }

  // ── Google / GitHub through the browser ──────────────────────────────────

  async signInWithProvider(provider) {
    if (!['google', 'github'].includes(provider)) return { ok: false, error: 'Unknown sign-in method.' };
    if (!this.baseURL) return { ok: false, error: 'Impulse Cloud isn\'t set up in this build.' };
    this.cancelSignIn();
    const { verifier, challenge, state } = pkcePair();
    let listener;
    try {
      listener = await listenForCode({ state });
    } catch {
      return { ok: false, error: 'Impulse couldn\'t open a local port for the sign-in. Try again.' };
    }
    const pending = { provider, listener };
    this.pendingSignIn = pending;
    this.changed();
    const done = (status) => `${this.baseURL}/desktop/done/?status=${status}`;
    try {
      await this.openExternal(`${this.baseURL}/sign-in/?${new URLSearchParams({ desktop: '1', provider, port: String(listener.port), state, challenge })}`);
      const { code, finish } = await listener.code;
      const res = await this.request('POST', '/desktop/token', { body: { code, verifier }, auth: false });
      if (!res.ok || !res.data?.token) {
        finish(done('error'));
        return { ok: false, error: res.error || 'The sign-in couldn\'t be completed. Try again.' };
      }
      const result = await this.adopt(res.data.token);
      finish(done(result.ok ? 'ok' : 'error'));
      return result;
    } catch (error) {
      if (error?.code === 'cancelled') return { ok: false, cancelled: true };
      return { ok: false, error: error?.message || 'The sign-in didn\'t finish.' };
    } finally {
      if (this.pendingSignIn === pending) this.pendingSignIn = null;
      listener.close();
      this.changed();
    }
  }

  cancelSignIn() {
    const pending = this.pendingSignIn;
    this.pendingSignIn = null;
    pending?.listener.cancel();
  }

  async signOut() {
    this.cancelSignIn();
    if (this.token) await this.request('POST', '/api/auth/sign-out', { body: {} }).catch(() => {});
    this.setToken(null);
    this.offline = false;
    this.changed();
    return { ok: true, status: this.status() };
  }

  // ── account data ─────────────────────────────────────────────────────────

  async usage(days = 30) {
    const res = await this.request('GET', `/v1/usage?days=${Math.max(1, Math.min(90, Number(days) || 30))}`);
    return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error };
  }

  async plans() {
    const res = await this.request('GET', '/v1/plans');
    return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error };
  }

  async models() {
    const res = await this.request('GET', '/v1/models');
    return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error };
  }

  /** Which model answers a kind of work now: the server decides, the person sees "Impulse AI". */
  async route(kind = 'agent', escalate = 0) {
    const res = await this.request('POST', '/v1/route', { body: { kind, escalate } });
    return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error, status: res.status };
  }

  async requestUpgrade(plan, note) {
    const res = await this.request('POST', '/v1/upgrade-request', { body: { plan, note } });
    return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error };
  }
}

module.exports = { CloudAccount, friendly };
