// Hands a browser sign-in (Google, GitHub) to the desktop app. The app opens
//   /sign-in/?desktop=1&provider=google&port=P&state=S&challenge=C
// and listens on http://127.0.0.1:P/callback. After the provider signs the
// browser in, /desktop/complete issues a one-time code bound to the PKCE
// challenge and redirects to the app's loopback port; the app trades the code
// and its verifier for a session of its own at POST /desktop/token.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const CODE_TTL_MS = 2 * 60 * 1000;

const sha256 = (value) => createHash('sha256').update(value).digest();
const b64url = (buf) => buf.toString('base64url');

export function parseDesktopParams(query) {
  const port = Number(query.port);
  const state = String(query.state || '');
  const challenge = String(query.challenge || '');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(state)) return null;
  // base64url(sha256(verifier)) is always 43 characters.
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return null;
  return { port, state, challenge };
}

export function challengeOf(verifier) {
  return b64url(sha256(verifier));
}

/**
 * @param {{ pool, auth, config }} deps
 */
export function createDesktopHandoff({ pool, auth, config }) {
  async function issueCode(userId, challenge) {
    const code = b64url(randomBytes(32));
    await pool.query(
      `insert into desktop_code (code_hash, user_id, challenge, expires_at) values ($1, $2, $3, $4)`,
      [b64url(sha256(code)), userId, challenge, new Date(Date.now() + CODE_TTL_MS)],
    );
    if (Math.random() < 0.05) pool.query(`delete from desktop_code where expires_at < now() - interval '1 day'`).catch(() => {});
    return code;
  }

  return {
    /** GET /desktop/complete — the browser is signed in; send a code to the app. */
    async complete(request) {
      const url = new URL(request.url);
      const params = parseDesktopParams(Object.fromEntries(url.searchParams));
      if (!params) return Response.redirect(`${config.baseURL}/desktop/done/?status=invalid`, 302);
      const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
      if (!session?.user) {
        const back = new URLSearchParams({ desktop: '1', port: String(params.port), state: params.state, challenge: params.challenge, error: 'not_signed_in' });
        return Response.redirect(`${config.baseURL}/sign-in/?${back}`, 302);
      }
      if (session.user.banned) return Response.redirect(`${config.baseURL}/desktop/done/?status=suspended`, 302);
      const code = await issueCode(session.user.id, params.challenge);
      const target = new URL(`http://127.0.0.1:${params.port}/callback`);
      target.searchParams.set('code', code);
      target.searchParams.set('state', params.state);
      return new Response(null, { status: 302, headers: { location: target.toString(), 'cache-control': 'no-store' } });
    },

    /** POST /desktop/token { code, verifier } → { token, user } */
    async token(request) {
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: 'invalid_request' }, { status: 400 });
      }
      const code = typeof body?.code === 'string' ? body.code : '';
      const verifier = typeof body?.verifier === 'string' ? body.verifier : '';
      if (!/^[A-Za-z0-9_-]{43}$/.test(code) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
        return Response.json({ error: 'invalid_request' }, { status: 400 });
      }
      // Single use: the row is claimed atomically.
      const { rows } = await pool.query(
        `update desktop_code set used_at = now()
         where code_hash = $1 and used_at is null and expires_at > now()
         returning user_id, challenge`,
        [b64url(sha256(code))],
      );
      const row = rows[0];
      const expected = row ? Buffer.from(row.challenge) : null;
      const actual = Buffer.from(challengeOf(verifier));
      if (!row || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      const ctx = await auth.$context;
      const user = await ctx.internalAdapter.findUserById(row.user_id);
      if (!user || user.banned) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const forwarded = request.headers.get('x-forwarded-for');
      const details = { userAgent: (request.headers.get('user-agent') || 'Impulse IDE').slice(0, 200) };
      // Recorded only when it is a single address (a list's first entry is the client's own claim).
      if (forwarded && !forwarded.includes(',')) details.ipAddress = forwarded.trim();
      const session = await ctx.internalAdapter.createSession(user.id, false, details);
      return Response.json({
        token: session.token,
        expiresAt: new Date(session.expiresAt).toISOString(),
        user: { id: user.id, name: user.name, email: user.email, image: user.image || null },
      }, { headers: { 'cache-control': 'no-store' } });
    },
  };
}
