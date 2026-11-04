// Learning from fixes: the apps send (error signature, board, core, a redacted
// diff, who fixed it) when a failed build is followed by a success; the cloud
// keeps the records, answers "known fixes for this error" and serves a small
// manifest of the most common errors and their fixes. No model is trained.

const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const fail = (status, error, message) => json({ error, message }, status);

const MAX_PER_HOUR = 60;
const LIMITS = { signature: 220, excerpt: 600, diff: 6 * 1024, board: 80, core: 60, version: 40, model: 80, library: 60, libraries: 20, appVersion: 40 };
const KINDS = new Set(['compile', 'upload']);
const FIXED_BY = new Set(['agent', 'user', 'unknown']);
const MANIFEST_TTL_MS = 5 * 60 * 1000;

/** What the apps' fix record must look like, bounded. Returns the cleaned record or an error message. */
export function validateFix(body) {
  if (!body || typeof body !== 'object') return { error: 'Send a fix record.' };
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const hash = str(body.hash, 32);
  const signature = str(body.signature, LIMITS.signature);
  if (!/^[a-f0-9]{8,32}$/.test(hash) || !signature) return { error: 'A fix needs a signature and its hash.' };
  if (!KINDS.has(body.kind)) return { error: 'kind must be compile or upload.' };
  const diff = str(body.diff, LIMITS.diff + 1);
  if (diff.length > LIMITS.diff) return { error: `The diff is too long (${LIMITS.diff} bytes at most).` };
  const excerpt = str(body.errorExcerpt, LIMITS.excerpt + 1);
  if (!excerpt) return { error: 'A fix needs the error excerpt.' };
  if (excerpt.length > LIMITS.excerpt) return { error: `The error excerpt is too long (${LIMITS.excerpt} characters at most).` };
  if (body.kind === 'compile' && !diff) return { error: 'A compile fix needs a diff.' };
  const libraries = Array.isArray(body.libraries) ? body.libraries.filter((l) => typeof l === 'string').slice(0, LIMITS.libraries).map((l) => l.slice(0, LIMITS.library)) : [];
  return {
    value: {
      hash, signature, kind: body.kind,
      failureCode: str(body.failureCode, 40) || null,
      board: str(body.board, LIMITS.board) || null,
      core: str(body.core, LIMITS.core) || null,
      coreVersion: str(body.coreVersion, LIMITS.version) || null,
      libraries, errorExcerpt: excerpt, diff,
      fixedBy: FIXED_BY.has(body.fixedBy) ? body.fixedBy : 'unknown',
      model: str(body.model, LIMITS.model) || null,
    },
  };
}

/** The most common errors over `days`, with how many people hit them and the latest fix. */
export async function topSignatures(pool, { days = 30, limit = 50 } = {}) {
  const { rows } = await pool.query(
    `with recent as (
       select * from fix_record where created_at > now() - ($1 || ' days')::interval
     ), agg as (
       select signature_hash, max(signature) as signature, max(kind) as kind, count(*)::int as fixes, count(distinct user_id)::int as users,
              count(*) filter (where fixed_by = 'agent')::int as by_agent, max(created_at) as last_at,
              (array_agg(board order by created_at desc) filter (where board is not null))[1] as board,
              (array_agg(core_version order by created_at desc) filter (where core_version is not null))[1] as core_version,
              (array_agg(diff order by created_at desc) filter (where diff <> ''))[1] as diff,
              (array_agg(error_excerpt order by created_at desc))[1] as excerpt
       from recent group by signature_hash
     )
     select * from agg order by fixes desc, last_at desc limit $2`,
    [String(Math.min(365, Math.max(1, Number(days) || 30))), Math.min(200, Math.max(1, Number(limit) || 50))],
  );
  return rows.map((r) => ({
    hash: r.signature_hash, signature: r.signature, kind: r.kind, fixes: r.fixes, users: r.users, byAgent: r.by_agent,
    lastAt: new Date(r.last_at).toISOString(), board: r.board, coreVersion: r.core_version,
    excerpt: r.excerpt, diff: r.diff ? String(r.diff).slice(0, 1200) : '',
  }));
}

/**
 * @param {{ pool, auth, settings, config, log?: Function }} deps
 */
export function createLearningApi({ pool, auth, settings, log = () => {} }) {
  async function signedIn(request) {
    const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
    if (!session?.user) return { error: fail(401, 'unauthorized', 'Sign in to continue.') };
    if (session.user.banned) return { error: fail(403, 'suspended', 'This account is suspended.') };
    if (!session.user.emailVerified) return { error: fail(403, 'unverified', 'Verify your email first.') };
    return { user: session.user };
  }

  let manifestCache = { at: 0, value: null };

  return {
    /** POST /v1/learn/fixes: one fix record from the app. */
    async share(request) {
      const who = await signedIn(request);
      if (who.error) return who.error;
      const s = await settings.get();
      if (!s.learningEnabled) return json({ ok: true, stored: false, reason: 'learning_off' });
      let body = null;
      try { body = await request.json(); } catch { body = null; }
      const checked = validateFix(body);
      if (checked.error) return fail(400, 'invalid_fix', checked.error);
      const { rows: [{ n }] } = await pool.query(`select count(*)::int as n from fix_record where user_id = $1 and created_at > now() - interval '1 hour'`, [who.user.id]);
      if (n >= MAX_PER_HOUR) return fail(429, 'rate_limited', 'Too many fixes this hour; the app will try again later.');
      const f = checked.value;
      const appVersion = (request.headers.get('x-impulse-client') || '').slice(0, LIMITS.appVersion) || null;
      const { rows } = await pool.query(
        `insert into fix_record (user_id, signature_hash, signature, kind, failure_code, board, core, core_version, libraries, error_excerpt, diff, fixed_by, model, app_version)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
        [who.user.id, f.hash, f.signature, f.kind, f.failureCode, f.board, f.core, f.coreVersion, f.libraries, f.errorExcerpt, f.diff, f.fixedBy, f.model, appVersion],
      );
      log(`[learning] fix ${f.hash} (${f.kind}, ${f.board || 'no board'}) from ${who.user.id}`);
      return json({ ok: true, stored: true, id: rows[0].id });
    },

    /** GET /v1/learn/fixes?hash=…&board=…: known fixes for an error, same board first. */
    async known(request) {
      const who = await signedIn(request);
      if (who.error) return who.error;
      const url = new URL(request.url);
      const hash = String(url.searchParams.get('hash') || '').slice(0, 32);
      if (!/^[a-f0-9]{8,32}$/.test(hash)) return fail(400, 'invalid_request', 'Send the error hash.');
      const board = String(url.searchParams.get('board') || '').slice(0, 80) || null;
      const { rows: [stats] } = await pool.query(
        `select count(*)::int as fixes, count(distinct user_id)::int as users from fix_record where signature_hash = $1`, [hash],
      );
      const { rows } = await pool.query(
        `select distinct on (diff) diff, board, core_version, fixed_by, failure_code, error_excerpt, created_at
         from fix_record where signature_hash = $1 and diff <> ''
         order by diff, (board = $2) desc nulls last, created_at desc`,
        [hash, board],
      );
      const fixes = rows
        .sort((a, b) => Number(b.board === board) - Number(a.board === board) || new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 3)
        .map((r) => ({ diff: r.diff, board: r.board, coreVersion: r.core_version, fixedBy: r.fixed_by, failureCode: r.failure_code, at: new Date(r.created_at).toISOString() }));
      return json({ hash, fixes: stats.fixes, users: stats.users, known: fixes });
    },

    /** GET /v1/knowledge/manifest: the most common errors and their fixes, for the app's cache. */
    async manifest(request) {
      const who = await signedIn(request);
      if (who.error) return who.error;
      if (!manifestCache.value || Date.now() - manifestCache.at > MANIFEST_TTL_MS) {
        const top = await topSignatures(pool, { days: 30, limit: 50 });
        manifestCache = { at: Date.now(), value: { version: 1, generatedAt: new Date().toISOString(), days: 30, signatures: top } };
      }
      return json(manifestCache.value);
    },

    invalidate() { manifestCache = { at: 0, value: null }; },
  };
}
