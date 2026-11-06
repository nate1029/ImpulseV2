// Learning from fixes: the apps send (error signature, board, core, a redacted
// diff, who fixed it) when a failed build is followed by a success; the cloud
// keeps the records, answers "known fixes for this error" and serves a small
// manifest of the most common errors and their fixes. No model is trained.
//
// The scalable loop on top of that (migration 004):
//   * embeddings on each fix, so a *similar* error (not just an identical one)
//     finds a known fix — when the database has pgvector and an OpenAI key;
//   * fix outcomes (did an applied fix work) that weight ranking by real success;
//   * a precomputed fix_playbook so reads never scan every raw row;
//   * opt-in working-sketch recipes that make first answers right, not just fixes.

import { toVector } from './embed.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const fail = (status, error, message) => json({ error, message }, status);

const MAX_PER_HOUR = 60;
const LIMITS = { signature: 220, excerpt: 600, diff: 6 * 1024, board: 80, core: 60, version: 40, model: 80, library: 60, libraries: 20, appVersion: 40, task: 400, sketch: 32 * 1024, proof: 20 };
const KINDS = new Set(['compile', 'upload']);
const FIXED_BY = new Set(['agent', 'user', 'unknown']);
const PROOFS = new Set(['compiled', 'simulated', 'hardware']);
const MANIFEST_TTL_MS = 5 * 60 * 1000;

// A short, stable hash for a diff/task (dedup key), without pulling in crypto ceremony.
function shortHash(text) {
  let h = 0x811c9dc5;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

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

/** What an outcome report ("I applied this fix; it worked / it didn't") must look like. */
export function validateOutcome(body) {
  if (!body || typeof body !== 'object') return { error: 'Send an outcome.' };
  const hash = typeof body.hash === 'string' ? body.hash.slice(0, 32) : '';
  if (!/^[a-f0-9]{8,32}$/.test(hash)) return { error: 'An outcome needs the error hash.' };
  if (typeof body.worked !== 'boolean') return { error: 'worked must be true or false.' };
  const diff = typeof body.diff === 'string' ? body.diff.slice(0, LIMITS.diff) : '';
  const diffHash = typeof body.diffHash === 'string' && body.diffHash ? body.diffHash.slice(0, 16) : (diff ? shortHash(diff) : '');
  if (!diffHash) return { error: 'An outcome needs the fix it is about (diff or diffHash).' };
  return { value: { hash, diffHash, worked: body.worked, board: typeof body.board === 'string' ? body.board.slice(0, LIMITS.board) || null : null } };
}

/** What an opt-in recipe (a working, verified sketch) must look like. */
export function validateRecipe(body) {
  if (!body || typeof body !== 'object') return { error: 'Send a recipe.' };
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const task = str(body.task, LIMITS.task).trim();
  const sketch = str(body.sketch, LIMITS.sketch + 1);
  if (!task) return { error: 'A recipe needs the task it solves.' };
  if (!sketch) return { error: 'A recipe needs its sketch.' };
  if (sketch.length > LIMITS.sketch) return { error: `The sketch is too long (${LIMITS.sketch} bytes at most).` };
  const libraries = Array.isArray(body.libraries) ? body.libraries.filter((l) => typeof l === 'string').slice(0, LIMITS.libraries).map((l) => l.slice(0, LIMITS.library)) : [];
  return {
    value: {
      task, sketch, libraries,
      board: str(body.board, LIMITS.board) || null,
      core: str(body.core, LIMITS.core) || null,
      coreVersion: str(body.coreVersion, LIMITS.version) || null,
      proof: PROOFS.has(body.proof) ? body.proof : 'compiled',
      taskHash: shortHash(`${str(body.board, LIMITS.board)}|${task.toLowerCase()}`),
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
 * Rebuild fix_playbook from fix_record + fix_outcome. Ranked by proven success
 * first, then how many people it helped, then recency. Reads use this instead
 * of scanning every raw fix row. Safe to call on a schedule.
 */
export async function refreshPlaybooks(pool) {
  await pool.query(
    `with f as (
       select signature_hash, coalesce(board, '') as board, md5(diff) as diff_hash,
              (array_agg(diff order by created_at desc))[1] as diff, max(kind) as kind,
              (array_agg(core_version order by created_at desc) filter (where core_version is not null))[1] as core_version,
              count(*)::int as fixes, count(distinct user_id)::int as users,
              count(*) filter (where fixed_by = 'agent')::int as by_agent, max(created_at) as last_at
       from fix_record where diff <> ''
       group by signature_hash, coalesce(board, ''), md5(diff)
     ), o as (
       select signature_hash, diff_hash,
              count(*) filter (where worked)::int as worked,
              count(*) filter (where not worked)::int as failed
       from fix_outcome group by signature_hash, diff_hash
     )
     insert into fix_playbook (signature_hash, board, diff_hash, diff, kind, core_version, fixes, users, by_agent, worked, failed, score, last_at)
     select f.signature_hash, f.board, f.diff_hash, f.diff, f.kind, f.core_version, f.fixes, f.users, f.by_agent,
            coalesce(o.worked, 0), coalesce(o.failed, 0),
            (coalesce(o.worked, 0) * 3.0 + f.users + f.by_agent * 0.5) / (1 + coalesce(o.failed, 0))
              + extract(epoch from f.last_at) / 1e12,
            f.last_at
     from f left join o on o.signature_hash = f.signature_hash and o.diff_hash = f.diff_hash
     on conflict (signature_hash, board, diff_hash) do update set
       diff = excluded.diff, kind = excluded.kind, core_version = excluded.core_version,
       fixes = excluded.fixes, users = excluded.users, by_agent = excluded.by_agent,
       worked = excluded.worked, failed = excluded.failed, score = excluded.score, last_at = excluded.last_at`,
  );
  // Drop playbook rows whose raw fixes are gone (a user deleted their data).
  await pool.query(
    `delete from fix_playbook p where not exists (
       select 1 from fix_record r where r.signature_hash = p.signature_hash and md5(r.diff) = p.diff_hash)`,
  );
}

/** Refresh the single served manifest row from the current top signatures. */
export async function refreshManifest(pool) {
  const top = await topSignatures(pool, { days: 30, limit: 50 });
  const data = { version: 1, generatedAt: new Date().toISOString(), days: 30, signatures: top };
  await pool.query(
    `insert into knowledge_manifest (id, data, generated_at) values (1, $1, now())
     on conflict (id) do update set data = excluded.data, generated_at = now()`,
    [JSON.stringify(data)],
  );
  return data;
}

/**
 * @param {{ pool, auth, settings, config, embed?: Function, background?: Function, log?: Function }} deps
 */
export function createLearningApi({ pool, auth, settings, embed = null, background = (p) => { p?.catch?.(() => {}); }, log = () => {} }) {
  async function signedIn(request) {
    const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
    if (!session?.user) return { error: fail(401, 'unauthorized', 'Sign in to continue.') };
    if (session.user.banned) return { error: fail(403, 'suspended', 'This account is suspended.') };
    if (!session.user.emailVerified) return { error: fail(403, 'unverified', 'Verify your email first.') };
    return { user: session.user };
  }

  // Does this database have the pgvector columns (migration 004 adds them only
  // where pgvector is available)? Checked once, then cached.
  let vectorReady = null;
  async function hasVector() {
    if (vectorReady !== null) return vectorReady;
    try {
      const { rowCount } = await pool.query(
        `select 1 from information_schema.columns where table_name = 'fix_record' and column_name = 'embedding'`,
      );
      vectorReady = rowCount > 0;
    } catch { vectorReady = false; }
    return vectorReady;
  }

  const canEmbed = () => Boolean(embed && embed.enabled);

  // Embed a fix's error text and store it, in the background (never blocks the response).
  function embedFix(id, text) {
    if (!canEmbed()) return;
    background((async () => {
      if (!(await hasVector())) return;
      const vec = toVector(await embed(text));
      if (vec) await pool.query(`update fix_record set embedding = $1::vector where id = $2`, [vec, id]);
    })());
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
      embedFix(rows[0].id, `${f.signature}\n${f.errorExcerpt}`);
      log(`[learning] fix ${f.hash} (${f.kind}, ${f.board || 'no board'}) from ${who.user.id}`);
      return json({ ok: true, stored: true, id: rows[0].id });
    },

    /**
     * GET /v1/learn/fixes?hash=…&board=…&excerpt=…: known fixes for an error.
     * Exact signature first (precomputed playbook when it is warm, else live),
     * same board first; if that is thin and the text is given, similar errors
     * found semantically fill the rest.
     */
    async known(request) {
      const who = await signedIn(request);
      if (who.error) return who.error;
      const url = new URL(request.url);
      const hash = String(url.searchParams.get('hash') || '').slice(0, 32);
      if (!/^[a-f0-9]{8,32}$/.test(hash)) return fail(400, 'invalid_request', 'Send the error hash.');
      const board = String(url.searchParams.get('board') || '').slice(0, 80) || null;
      const excerpt = String(url.searchParams.get('excerpt') || '').slice(0, LIMITS.excerpt);

      const { rows: [stats] } = await pool.query(
        `select count(*)::int as fixes, count(distinct user_id)::int as users from fix_record where signature_hash = $1`, [hash],
      );

      // Ranked exact-signature fixes: the warm playbook, else a live scan.
      const play = await pool.query(
        `select diff, nullif(board, '') as board, core_version, by_agent, worked, failed, last_at
         from fix_playbook where signature_hash = $1
         order by (board = coalesce($2, '')) desc, score desc limit 3`,
        [hash, board],
      );
      let known;
      if (play.rows.length) {
        known = play.rows.map((r) => ({
          diff: r.diff, board: r.board, coreVersion: r.core_version,
          fixedBy: r.by_agent > 0 ? 'agent' : 'user', failureCode: null,
          worked: r.worked, failed: r.failed, at: new Date(r.last_at).toISOString(),
        }));
      } else {
        const { rows } = await pool.query(
          `select distinct on (diff) diff, board, core_version, fixed_by, failure_code, error_excerpt, created_at
           from fix_record where signature_hash = $1 and diff <> ''
           order by diff, (board = $2) desc nulls last, created_at desc`,
          [hash, board],
        );
        known = rows
          .sort((a, b) => Number(b.board === board) - Number(a.board === board) || new Date(b.created_at) - new Date(a.created_at))
          .slice(0, 3)
          .map((r) => ({ diff: r.diff, board: r.board, coreVersion: r.core_version, fixedBy: r.fixed_by, failureCode: r.failure_code, at: new Date(r.created_at).toISOString() }));
      }

      // Thin exact result and we have the text: fill with semantically similar errors.
      let similar = [];
      if (known.length < 3 && excerpt && canEmbed() && (await hasVector())) {
        const vec = toVector(await embed(excerpt));
        if (vec) {
          const { rows } = await pool.query(
            `select distinct on (diff) diff, board, core_version, fixed_by, signature, created_at,
                    (embedding <=> $1::vector) as distance
             from fix_record
             where embedding is not null and diff <> '' and signature_hash <> $2
             order by diff, distance asc
             limit 20`,
            [vec, hash],
          );
          similar = rows
            .filter((r) => r.distance < 0.35) // cosine distance; closer is more alike
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 3)
            .map((r) => ({ diff: r.diff, board: r.board, coreVersion: r.core_version, fixedBy: r.fixed_by, signature: r.signature, similarity: Number((1 - r.distance).toFixed(3)), similar: true }));
        }
      }

      // Keep the shape stable when there's nothing extra (older apps + exact-match tests).
      return json({ hash, fixes: stats.fixes, users: stats.users, known, ...(similar.length ? { similar } : {}) });
    },

    /** POST /v1/learn/outcome: "I applied this known fix; it worked / it didn't." Weights ranking. */
    async outcome(request) {
      const who = await signedIn(request);
      if (who.error) return who.error;
      const s = await settings.get();
      if (!s.learningEnabled) return json({ ok: true, stored: false, reason: 'learning_off' });
      let body = null;
      try { body = await request.json(); } catch { body = null; }
      const checked = validateOutcome(body);
      if (checked.error) return fail(400, 'invalid_outcome', checked.error);
      const o = checked.value;
      await pool.query(
        `insert into fix_outcome (user_id, signature_hash, diff_hash, worked, board) values ($1, $2, $3, $4, $5)`,
        [who.user.id, o.hash, o.diffHash, o.worked, o.board],
      );
      return json({ ok: true, stored: true });
    },

    /** POST /v1/learn/recipes: an opt-in working, verified sketch (off unless the owner enables it). */
    async shareRecipe(request) {
      const who = await signedIn(request);
      if (who.error) return who.error;
      const s = await settings.get();
      if (!s.recipeSharingEnabled) return json({ ok: true, stored: false, reason: 'recipes_off' });
      let body = null;
      try { body = await request.json(); } catch { body = null; }
      const checked = validateRecipe(body);
      if (checked.error) return fail(400, 'invalid_recipe', checked.error);
      const { rows: [{ n }] } = await pool.query(`select count(*)::int as n from recipe_record where user_id = $1 and created_at > now() - interval '1 hour'`, [who.user.id]);
      if (n >= MAX_PER_HOUR) return fail(429, 'rate_limited', 'Too many recipes this hour; try again later.');
      const r = checked.value;
      const { rows } = await pool.query(
        `insert into recipe_record (user_id, board, core, core_version, task, task_hash, sketch, libraries, proof)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [who.user.id, r.board, r.core, r.coreVersion, r.task, r.taskHash, r.sketch, r.libraries, r.proof],
      );
      if (canEmbed()) {
        const id = rows[0].id;
        background((async () => {
          if (!(await hasVector())) return;
          const vec = toVector(await embed(`${r.board || ''} ${r.task}`));
          if (vec) await pool.query(`update recipe_record set embedding = $1::vector where id = $2`, [vec, id]);
        })());
      }
      return json({ ok: true, stored: true, id: rows[0].id });
    },

    /** GET /v1/learn/recipes?task=…&board=…: proven sketches for a similar task, same board first. */
    async recipes(request) {
      const who = await signedIn(request);
      if (who.error) return who.error;
      const url = new URL(request.url);
      const task = String(url.searchParams.get('task') || '').slice(0, LIMITS.task).trim();
      if (!task) return fail(400, 'invalid_request', 'Send the task.');
      const board = String(url.searchParams.get('board') || '').slice(0, 80) || null;

      // Semantic match when we can; fall back to exact task+board when it is
      // unavailable or finds nothing (e.g. a recipe not embedded yet).
      if (canEmbed() && (await hasVector())) {
        const vec = toVector(await embed(`${board || ''} ${task}`));
        if (vec) {
          const { rows } = await pool.query(
            `select board, core, core_version, task, sketch, libraries, proof, created_at,
                    (embedding <=> $1::vector) as distance
             from recipe_record where embedding is not null
             order by (board = $2) desc, distance asc limit 5`,
            [vec, board],
          );
          const recipes = rows.filter((r) => r.distance < 0.4).slice(0, 3).map((r) => ({
            board: r.board, core: r.core, coreVersion: r.core_version, task: r.task, sketch: r.sketch,
            libraries: r.libraries, proof: r.proof, similarity: Number((1 - r.distance).toFixed(3)), at: new Date(r.created_at).toISOString(),
          }));
          if (recipes.length) return json({ task, board, recipes });
        }
      }
      const taskHash = shortHash(`${board || ''}|${task.toLowerCase()}`);
      const { rows } = await pool.query(
        `select board, core, core_version, task, sketch, libraries, proof, created_at
         from recipe_record where task_hash = $1 order by created_at desc limit 3`,
        [taskHash],
      );
      return json({ task, board, recipes: rows.map((r) => ({ board: r.board, core: r.core, coreVersion: r.core_version, task: r.task, sketch: r.sketch, libraries: r.libraries, proof: r.proof, at: new Date(r.created_at).toISOString() })) });
    },

    /** GET /v1/knowledge/manifest: the most common errors and their fixes, for the app's cache. */
    async manifest(request) {
      const who = await signedIn(request);
      if (who.error) return who.error;
      if (!manifestCache.value || Date.now() - manifestCache.at > MANIFEST_TTL_MS) {
        // Serve the precomputed row if it exists; otherwise compute live (first run / tests).
        const { rows } = await pool.query(`select data from knowledge_manifest where id = 1`);
        const value = rows[0]?.data || { version: 1, generatedAt: new Date().toISOString(), days: 30, signatures: await topSignatures(pool, { days: 30, limit: 50 }) };
        manifestCache = { at: Date.now(), value };
      }
      return json(manifestCache.value);
    },

    invalidate() { manifestCache = { at: 0, value: null }; },
  };
}
