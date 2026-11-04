// The admin console's API, under /admin/api. Only users with role "admin"
// (or a verified address listed in ADMIN_EMAILS) get in. Changes need the
// x-impulse-admin header, which a cross-site form can't send, and every change
// is written to admin_audit.

import { MODELS } from './pricing.js';
import { MC, adjust, describe, getAccount, setPlan } from './credits.js';
import { PLAN_IDS, validateSettings } from './settings.js';
import { publicUser } from './account-api.js';
import { topSignatures } from './learning.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const fail = (status, message) => json({ error: message }, status);

/**
 * @param {{ pool, auth, settings, budget, config }} deps
 */
export function createAdminApi({ pool, auth, settings, budget, config }) {
  async function adminFrom(request, { write = false } = {}) {
    const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
    const user = session?.user;
    if (!user) return { error: fail(401, 'Sign in first.') };
    const listed = user.emailVerified && config.adminEmails.includes(String(user.email).toLowerCase());
    if (user.role !== 'admin' && !listed) return { error: fail(403, 'This account is not an admin.') };
    if (user.role !== 'admin') await pool.query(`update "user" set role = 'admin' where id = $1`, [user.id]);
    if (write) {
      if (request.headers.get('x-impulse-admin') !== '1') return { error: fail(403, 'Missing admin header.') };
      const origin = request.headers.get('origin');
      if (origin && origin !== config.baseURL) return { error: fail(403, 'Wrong origin.') };
    }
    return { admin: user };
  }

  const audit = (actorId, action, targetUserId, detail) => pool.query(
    `insert into admin_audit (actor_id, action, target_user_id, detail) values ($1, $2, $3, $4)`,
    [actorId, action, targetUserId, detail ? JSON.stringify(detail) : null],
  );

  async function body(request) {
    try {
      return await request.json();
    } catch {
      return null;
    }
  }

  async function findUser(id) {
    const { rows } = await pool.query(`select * from "user" where id = $1`, [id]);
    return rows[0] || null;
  }

  return {
    async whoami(request) {
      const who = await adminFrom(request);
      if (who.error) return who.error;
      return json({ admin: publicUser(who.admin) });
    },

    async overview(request) {
      const who = await adminFrom(request);
      if (who.error) return who.error;
      const days = Math.min(180, Math.max(7, Number(new URL(request.url).searchParams.get('days')) || 30));
      const s = await settings.get();
      const [totals, signups, usage, byModel, plans, top, openRequests] = await Promise.all([
        pool.query(`select
            (select count(*)::int from "user") as users,
            (select count(*)::int from "user" where "createdAt" > now() - interval '7 days') as new_7d,
            (select count(distinct user_id)::int from usage_event where created_at > now() - interval '7 days') as active_7d,
            (select count(distinct user_id)::int from usage_event where created_at > now() - interval '1 day') as active_1d,
            (select count(*)::int from credit_account where plan <> 'free') as paid`),
        pool.query(`select to_char(date_trunc('day', "createdAt" at time zone 'utc'), 'YYYY-MM-DD') as day, count(*)::int as n
          from "user" where "createdAt" > now() - make_interval(days => $1) group by 1 order by 1`, [days]),
        pool.query(`select to_char(date_trunc('day', created_at at time zone 'utc'), 'YYYY-MM-DD') as day,
            count(*)::int as requests, coalesce(sum(cost_micros), 0)::bigint as micros, coalesce(sum(credits_charged), 0)::bigint as mc,
            coalesce(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0)::bigint as tokens,
            count(*) filter (where status = 'error')::int as errors
          from usage_event where created_at > now() - make_interval(days => $1) group by 1 order by 1`, [days]),
        pool.query(`select model, count(*)::int as requests, coalesce(sum(cost_micros), 0)::bigint as micros
          from usage_event where created_at > now() - make_interval(days => $1) group by 1 order by micros desc`, [days]),
        pool.query(`select plan, count(*)::int as n from credit_account group by 1`),
        pool.query(`select u.id, u.name, u.email, coalesce(sum(e.cost_micros), 0)::bigint as micros, count(*)::int as requests
          from usage_event e join "user" u on u.id = e.user_id
          where e.created_at > now() - make_interval(days => $1)
          group by u.id, u.name, u.email order by micros desc limit 8`, [days]),
        pool.query(`select count(*)::int as n from upgrade_request where status = 'open'`),
      ]);
      const t = totals.rows[0];
      const spentToday = await budget.spentToday();
      return json({
        days,
        totals: {
          users: t.users, new7d: t.new_7d, active7d: t.active_7d, active1d: t.active_1d, paid: t.paid,
          openRequests: openRequests.rows[0].n,
        },
        today: { spentUsd: spentToday / 1e6, budgetUsd: s.dailyBudgetUsd },
        signups: signups.rows,
        usage: usage.rows.map((r) => ({
          day: r.day, requests: r.requests, costUsd: r.micros / 1e6, credits: r.mc / MC, tokens: r.tokens, errors: r.errors,
        })),
        byModel: byModel.rows.map((r) => ({ model: MODELS[r.model]?.name || r.model, requests: r.requests, costUsd: r.micros / 1e6 })),
        plans: Object.fromEntries(plans.rows.map((r) => [r.plan, r.n])),
        topUsers: top.rows.map((r) => ({ id: r.id, name: r.name, email: r.email, costUsd: r.micros / 1e6, requests: r.requests })),
      });
    },

    async users(request) {
      const who = await adminFrom(request);
      if (who.error) return who.error;
      const q = new URL(request.url).searchParams;
      const search = (q.get('q') || '').trim().slice(0, 100);
      const plan = PLAN_IDS.includes(q.get('plan')) ? q.get('plan') : null;
      const status = ['banned', 'admin', 'unverified'].includes(q.get('status')) ? q.get('status') : null;
      const page = Math.max(0, Number(q.get('page')) || 0);
      const where = [];
      const args = [];
      if (search) {
        args.push(`%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        where.push(`(u.email ilike $${args.length} or u.name ilike $${args.length})`);
      }
      if (plan) {
        args.push(plan);
        where.push(`coalesce(a.plan, 'free') = $${args.length}`);
      }
      if (status === 'banned') where.push('u.banned is true');
      if (status === 'admin') where.push(`u.role = 'admin'`);
      if (status === 'unverified') where.push(`u."emailVerified" is not true`);
      args.push(page * 50);
      const { rows } = await pool.query(
        `select u.id, u.name, u.email, u.image, u."emailVerified", u.role, u.banned, u."createdAt",
                a.plan, a.plan_credits, a.bonus_credits,
                (select max(created_at) from usage_event e where e.user_id = u.id) as last_active,
                (select coalesce(sum(cost_micros), 0)::bigint from usage_event e where e.user_id = u.id and e.created_at > now() - interval '30 days') as micros_30d,
                count(*) over () as total
         from "user" u left join credit_account a on a.user_id = u.id
         ${where.length ? `where ${where.join(' and ')}` : ''}
         order by u."createdAt" desc limit 50 offset $${args.length}`,
        args,
      );
      return json({
        page,
        total: rows[0]?.total || 0,
        users: rows.map((r) => ({
          id: r.id, name: r.name, email: r.email, image: r.image, verified: !!r.emailVerified,
          role: r.role || 'user', banned: !!r.banned, createdAt: new Date(r.createdAt).toISOString(),
          plan: r.plan || 'free',
          credits: r.plan_credits === null ? null : Math.max(0, r.plan_credits + r.bonus_credits) / MC,
          lastActive: r.last_active ? new Date(r.last_active).toISOString() : null,
          costUsd30d: r.micros_30d / 1e6,
        })),
      });
    },

    async user(request, id) {
      const who = await adminFrom(request);
      if (who.error) return who.error;
      const user = await findUser(id);
      if (!user) return fail(404, 'No such user.');
      const s = await settings.get();
      const [accounts, sessions, ledger, usage, requests] = await Promise.all([
        pool.query(`select "providerId", "createdAt" from account where "userId" = $1`, [id]),
        pool.query(`select count(*)::int as n, max("updatedAt") as last from session where "userId" = $1 and "expiresAt" > now()`, [id]),
        pool.query(`select kind, delta, plan_after, bonus_after, note, actor_id, created_at from credit_ledger where user_id = $1 order by id desc limit 50`, [id]),
        pool.query(`select model, served_model, status, input_tokens, output_tokens, cache_read_tokens, cost_micros, credits_charged, duration_ms, client, created_at
          from usage_event where user_id = $1 order by id desc limit 50`, [id]),
        pool.query(`select id, plan, status, note, created_at from upgrade_request where user_id = $1 order by id desc limit 10`, [id]),
      ]);
      const account = user.emailVerified ? await getAccount(pool, id, s) : null;
      return json({
        user: { ...publicUser(user), banned: !!user.banned, banReason: user.banReason || null },
        providers: accounts.rows.map((a) => a.providerId),
        sessions: { active: sessions.rows[0].n, lastSeen: sessions.rows[0].last ? new Date(sessions.rows[0].last).toISOString() : null },
        credits: account ? describe(account, s) : null,
        ledger: ledger.rows.map((r) => ({
          kind: r.kind, delta: r.delta / MC, planAfter: r.plan_after / MC, bonusAfter: r.bonus_after / MC,
          note: r.note, byAdmin: !!r.actor_id, at: new Date(r.created_at).toISOString(),
        })),
        usage: usage.rows.map((r) => ({
          model: MODELS[r.model]?.name || r.model, served: r.served_model, status: r.status,
          input: r.input_tokens, output: r.output_tokens, cached: r.cache_read_tokens,
          costUsd: r.cost_micros / 1e6, credits: r.credits_charged / MC, ms: r.duration_ms, client: r.client,
          at: new Date(r.created_at).toISOString(),
        })),
        requests: requests.rows.map((r) => ({ id: r.id, plan: r.plan, status: r.status, note: r.note, at: new Date(r.created_at).toISOString() })),
      });
    },

    async grant(request, id) {
      const who = await adminFrom(request, { write: true });
      if (who.error) return who.error;
      const b = await body(request);
      const amount = Number(b?.credits);
      const bucket = b?.bucket === 'plan' ? 'plan' : 'bonus';
      const note = typeof b?.note === 'string' ? b.note.trim().slice(0, 200) : '';
      if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1_000_000) return fail(400, 'Credits must be a non-zero number up to 1,000,000.');
      if (!note) return fail(400, 'Add a note saying why.');
      const user = await findUser(id);
      if (!user) return fail(404, 'No such user.');
      if (!user.emailVerified) return fail(409, 'This user has not verified their email yet.');
      const s = await settings.get();
      await getAccount(pool, id, s);
      const acct = await adjust(pool, id, Math.round(amount * MC), { bucket, note, actorId: who.admin.id });
      await audit(who.admin.id, amount > 0 ? 'credits.grant' : 'credits.remove', id, { credits: amount, bucket, note });
      return json({ ok: true, credits: describe(acct, s) });
    },

    async plan(request, id) {
      const who = await adminFrom(request, { write: true });
      if (who.error) return who.error;
      const b = await body(request);
      if (!PLAN_IDS.includes(b?.plan)) return fail(400, 'Choose free, pro or max.');
      const user = await findUser(id);
      if (!user) return fail(404, 'No such user.');
      if (!user.emailVerified) return fail(409, 'This user has not verified their email yet.');
      const s = await settings.get();
      const acct = await setPlan(pool, id, b.plan, s, { actorId: who.admin.id });
      await pool.query(
        `update upgrade_request set status = 'approved', handled_by = $2, handled_at = now() where user_id = $1 and status = 'open' and plan = $3`,
        [id, who.admin.id, b.plan],
      );
      await audit(who.admin.id, 'plan.set', id, { plan: b.plan });
      return json({ ok: true, credits: describe(acct, s) });
    },

    async role(request, id) {
      const who = await adminFrom(request, { write: true });
      if (who.error) return who.error;
      const b = await body(request);
      if (!['user', 'admin'].includes(b?.role)) return fail(400, 'Role must be user or admin.');
      if (id === who.admin.id && b.role !== 'admin') return fail(409, 'You cannot remove your own admin role.');
      const user = await findUser(id);
      if (!user) return fail(404, 'No such user.');
      await pool.query(`update "user" set role = $2, "updatedAt" = now() where id = $1`, [id, b.role]);
      await audit(who.admin.id, 'role.set', id, { role: b.role });
      return json({ ok: true });
    },

    async ban(request, id, banned) {
      const who = await adminFrom(request, { write: true });
      if (who.error) return who.error;
      if (id === who.admin.id) return fail(409, 'You cannot suspend yourself.');
      const user = await findUser(id);
      if (!user) return fail(404, 'No such user.');
      const b = (await body(request)) || {};
      const reason = typeof b.reason === 'string' ? b.reason.trim().slice(0, 200) : '';
      if (banned && !reason) return fail(400, 'Add a reason.');
      await pool.query(
        `update "user" set banned = $2, "banReason" = $3, "banExpires" = null, "updatedAt" = now() where id = $1`,
        [id, banned, banned ? reason : null],
      );
      // A suspended user is signed out everywhere.
      if (banned) await pool.query(`delete from session where "userId" = $1`, [id]);
      await audit(who.admin.id, banned ? 'user.suspend' : 'user.restore', id, banned ? { reason } : null);
      return json({ ok: true });
    },

    async revokeSessions(request, id) {
      const who = await adminFrom(request, { write: true });
      if (who.error) return who.error;
      const { rowCount } = await pool.query(`delete from session where "userId" = $1`, [id]);
      await audit(who.admin.id, 'sessions.revoke', id, { count: rowCount });
      return json({ ok: true, revoked: rowCount });
    },

    async getSettings(request) {
      const who = await adminFrom(request);
      if (who.error) return who.error;
      const s = await settings.get();
      return json({
        settings: s,
        models: Object.entries(MODELS).map(([id, m]) => ({ id, vendor: m.vendor, name: m.name, tagline: m.tagline, input: m.input, output: m.output, cacheRead: m.cacheRead })),
        server: {
          openai: !!config.openai?.apiKey,
          anthropic: !!config.anthropic.apiKey,
          google: !!config.google,
          github: !!config.github,
          email: config.email.resendKey ? 'resend' : config.email.enabled ? 'log' : 'off',
          baseURL: config.baseURL,
        },
      });
    },

    async putSettings(request) {
      const who = await adminFrom(request, { write: true });
      if (who.error) return who.error;
      const checked = validateSettings(await body(request));
      if (!checked.ok) return fail(400, checked.error);
      const merged = { ...(await settings.get()), ...checked.value };
      if (!merged.enabledModels.includes(merged.defaultModel)) return fail(400, 'The default model must be enabled.');
      if (!merged.plans.free.models.includes(merged.defaultModel)) return fail(400, 'The Free plan must include the default model.');
      const s = await settings.update(checked.value, who.admin.id);
      await audit(who.admin.id, 'settings.update', null, checked.value);
      return json({ ok: true, settings: s });
    },

    async requests(request) {
      const who = await adminFrom(request);
      if (who.error) return who.error;
      const status = ['open', 'approved', 'declined'].includes(new URL(request.url).searchParams.get('status'))
        ? new URL(request.url).searchParams.get('status') : 'open';
      const { rows } = await pool.query(
        `select r.id, r.plan, r.status, r.note, r.created_at, r.handled_at, u.id as user_id, u.name, u.email, coalesce(a.plan, 'free') as current
         from upgrade_request r join "user" u on u.id = r.user_id left join credit_account a on a.user_id = r.user_id
         where r.status = $1 order by r.created_at desc limit 200`,
        [status],
      );
      return json({
        requests: rows.map((r) => ({
          id: r.id, plan: r.plan, status: r.status, note: r.note, at: new Date(r.created_at).toISOString(),
          handledAt: r.handled_at ? new Date(r.handled_at).toISOString() : null,
          user: { id: r.user_id, name: r.name, email: r.email, plan: r.current },
        })),
      });
    },

    async decide(request, requestId) {
      const who = await adminFrom(request, { write: true });
      if (who.error) return who.error;
      const b = await body(request);
      if (!['approve', 'decline'].includes(b?.action)) return fail(400, 'Action must be approve or decline.');
      const { rows } = await pool.query(`select * from upgrade_request where id = $1 and status = 'open'`, [Number(requestId)]);
      const req = rows[0];
      if (!req) return fail(404, 'No open request with that id.');
      if (b.action === 'approve') {
        const s = await settings.get();
        await setPlan(pool, req.user_id, req.plan, s, { actorId: who.admin.id, note: 'Upgrade request approved' });
      }
      await pool.query(
        `update upgrade_request set status = $2, handled_by = $3, handled_at = now() where id = $1`,
        [req.id, b.action === 'approve' ? 'approved' : 'declined', who.admin.id],
      );
      await audit(who.admin.id, `upgrade.${b.action}`, req.user_id, { plan: req.plan, request: req.id });
      return json({ ok: true });
    },

    /** What people struggle with: the most common build errors and the fixes that worked. */
    async learning(request) {
      const who = await adminFrom(request);
      if (who.error) return who.error;
      const days = Math.min(365, Math.max(1, Number(new URL(request.url).searchParams.get('days')) || 30));
      const signatures = await topSignatures(pool, { days, limit: 100 });
      const { rows: [totals] } = await pool.query(
        `select count(*)::int as total, count(distinct user_id)::int as users, count(*) filter (where fixed_by = 'agent')::int as by_agent
         from fix_record where created_at > now() - ($1 || ' days')::interval`, [String(days)],
      );
      const s = await settings.get();
      return json({ days, total: totals.total, users: totals.users, byAgent: totals.by_agent, enabled: !!s.learningEnabled, signatures });
    },

    async audit(request) {
      const who = await adminFrom(request);
      if (who.error) return who.error;
      const before = Number(new URL(request.url).searchParams.get('before')) || null;
      const { rows } = await pool.query(
        `select a.id, a.action, a.detail, a.created_at, actor.email as actor_email, target.email as target_email, a.target_user_id
         from admin_audit a left join "user" actor on actor.id = a.actor_id left join "user" target on target.id = a.target_user_id
         ${before ? 'where a.id < $1' : ''} order by a.id desc limit 100`,
        before ? [before] : [],
      );
      return json({
        entries: rows.map((r) => ({
          id: r.id, action: r.action, detail: r.detail, at: new Date(r.created_at).toISOString(),
          actor: r.actor_email, target: r.target_email, targetId: r.target_user_id,
        })),
      });
    },
  };
}
