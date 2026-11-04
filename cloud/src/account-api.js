// What the desktop app reads about the signed-in user: profile, plan,
// credits, models, usage, plans, and upgrade requests.

import { MODELS, relativeCost, servableModels } from './pricing.js';
import { describe, getAccount } from './credits.js';
import { PLAN_IDS } from './settings.js';
import { ROUTE_KINDS, chooseModel } from './routing.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const fail = (status, error, message) => json({ error, message }, status);

export function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image || null,
    emailVerified: !!user.emailVerified,
    role: user.role || 'user',
    createdAt: new Date(user.createdAt).toISOString(),
  };
}

/**
 * @param {{ pool, auth, settings, config }} deps
 */
export function createAccountApi({ pool, auth, settings, config }) {
  async function signedIn(request) {
    const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
    if (!session?.user) return { error: fail(401, 'unauthorized', 'Sign in to continue.') };
    if (session.user.banned) return { error: fail(403, 'suspended', 'This account is suspended.') };
    return { user: session.user, session: session.session };
  }

  function planList(s) {
    const servable = servableModels(s, config);
    return PLAN_IDS.map((id) => ({
      id,
      name: s.plans[id].name,
      monthlyCredits: s.plans[id].monthlyCredits,
      periodHours: s.plans[id].periodHours || null,
      priceUsd: s.plans[id].priceUsd,
      models: s.plans[id].models.filter((m) => servable.includes(m)).map((m) => MODELS[m].name),
    }));
  }

  return {
    async config() {
      const s = await settings.get();
      return json({
        auth: { google: !!config.google, github: !!config.github, email: config.email.enabled, testLogin: !!config.testLogin },
        welcomeCredits: s.signupBonusCredits,
        freeMonthlyCredits: s.plans.free.monthlyCredits,
        freePeriodHours: s.plans.free.periodHours || null,
        website: config.websiteURL,
      });
    },

    async me(request) {
      const who = await signedIn(request);
      if (who.error) return who.error;
      const s = await settings.get();
      const base = {
        user: publicUser(who.user),
        isAdmin: who.user.role === 'admin',
        announcement: s.announcement || null,
        maintenance: !!s.maintenance,
      };
      // Credits start once the address is verified (a code, or Google/GitHub).
      if (!who.user.emailVerified) return json({ ...base, needsVerification: true, credits: null });
      const account = await getAccount(pool, who.user.id, s);
      return json({ ...base, needsVerification: false, credits: describe(account, s) });
    },

    async models(request) {
      const who = await signedIn(request);
      if (who.error) return who.error;
      const s = await settings.get();
      let planId = 'free';
      if (who.user.emailVerified) planId = (await getAccount(pool, who.user.id, s)).plan;
      const plan = s.plans[planId] || s.plans.free;
      // Only models this server can serve: enabled, and their vendor has a key here.
      const servable = servableModels(s, config);
      const defaultModel = servable.includes(s.defaultModel) ? s.defaultModel : servable[0] || null;
      const models = servable.map((id) => ({
        id,
        vendor: MODELS[id].vendor,
        name: MODELS[id].name,
        tagline: MODELS[id].tagline,
        allowed: plan.models.includes(id),
        cost: relativeCost(id, defaultModel || s.defaultModel),
        isDefault: id === defaultModel,
      }));
      return json({ models, defaultModel });
    },

    /**
     * Which model the app should use for a kind of work, right now, for this
     * account. The person sees "Impulse AI"; this is where the model behind it
     * is decided, from the admin's routing table, among models this server
     * can serve on the account's plan. `escalate` > 0 climbs the ladder.
     */
    async route(request) {
      const who = await signedIn(request);
      if (who.error) return who.error;
      let body = {};
      try {
        body = await request.json();
      } catch { /* an empty body means the default kind */ }
      const kind = ROUTE_KINDS.includes(body?.kind) ? body.kind : 'agent';
      const escalate = Math.max(0, Math.min(3, Math.floor(Number(body?.escalate) || 0)));
      const s = await settings.get();
      let planId = 'free';
      if (who.user.emailVerified) planId = (await getAccount(pool, who.user.id, s)).plan;
      const plan = s.plans[planId] || s.plans.free;
      const servable = servableModels(s, config).filter((id) => plan.models.includes(id));
      if (!servable.length) return fail(503, 'no_model', 'Impulse AI is not set up on this server yet.');
      const model = chooseModel({ routing: s.routing, kind, escalate, servable, fallback: s.defaultModel });
      return json({ model, vendor: MODELS[model].vendor, kind, escalate, ttlSeconds: 300 });
    },

    async usage(request) {
      const who = await signedIn(request);
      if (who.error) return who.error;
      const days = Math.min(90, Math.max(1, Number(new URL(request.url).searchParams.get('days')) || 30));
      const [daily, recent] = await Promise.all([
        pool.query(
          `select to_char(date_trunc('day', created_at at time zone 'utc'), 'YYYY-MM-DD') as day,
                  count(*)::int as requests, coalesce(sum(credits_charged), 0)::bigint as millicredits
           from usage_event where user_id = $1 and created_at > now() - make_interval(days => $2)
           group by 1 order by 1`,
          [who.user.id, days],
        ),
        pool.query(
          `select id, model, status, input_tokens, output_tokens, cache_read_tokens, credits_charged, created_at
           from usage_event where user_id = $1 order by created_at desc limit 20`,
          [who.user.id],
        ),
      ]);
      return json({
        days,
        daily: daily.rows.map((r) => ({ day: r.day, requests: r.requests, credits: r.millicredits / 1000 })),
        recent: recent.rows.map((r) => ({
          id: r.id,
          model: MODELS[r.model]?.name || r.model,
          status: r.status,
          tokens: r.input_tokens + r.output_tokens + r.cache_read_tokens,
          credits: r.credits_charged / 1000,
          at: new Date(r.created_at).toISOString(),
        })),
      });
    },

    async plans(request) {
      const who = await signedIn(request);
      if (who.error) return who.error;
      const s = await settings.get();
      let current = 'free';
      if (who.user.emailVerified) current = (await getAccount(pool, who.user.id, s)).plan;
      const { rows } = await pool.query(
        `select plan, created_at from upgrade_request where user_id = $1 and status = 'open' limit 1`,
        [who.user.id],
      );
      return json({
        current,
        plans: planList(s),
        // No payment provider is connected yet: upgrades are requests the team approves.
        checkout: false,
        pendingRequest: rows[0] ? { plan: rows[0].plan, at: new Date(rows[0].created_at).toISOString() } : null,
      });
    },

    async requestUpgrade(request) {
      const who = await signedIn(request);
      if (who.error) return who.error;
      if (!who.user.emailVerified) return fail(403, 'unverified', 'Verify your email first.');
      let body;
      try {
        body = await request.json();
      } catch {
        return fail(400, 'invalid_request', 'Send { plan }.');
      }
      const plan = body?.plan;
      if (!['pro', 'max'].includes(plan)) return fail(400, 'invalid_plan', 'Choose Pro or Max.');
      const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : null;
      const { rows } = await pool.query(
        `insert into upgrade_request (user_id, plan, note) values ($1, $2, $3)
         on conflict (user_id) where status = 'open' do update set plan = excluded.plan, note = excluded.note
         returning id, plan, created_at`,
        [who.user.id, plan, note],
      );
      return json({ ok: true, request: { id: rows[0].id, plan: rows[0].plan, at: new Date(rows[0].created_at).toISOString() } });
    },
  };
}
