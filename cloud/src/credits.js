// Credit accounts and the append-only ledger. Two buckets per user:
// plan credits (the allowance per period, refilled each period; unused ones
// don't roll over, a small overdraft does) and bonus credits (welcome, granted
// and bought credits that never expire). Spending takes plan credits first.
// A period is a calendar month, or `periodHours` for plans that refill every
// few hours (the free plan). Every change is one row in credit_ledger with the
// balances after it.

import { tx } from './db.js';

/** Millicredits per credit. */
export const MC = 1000;

/** Minimum balance to start an AI request, in millicredits. */
export const MIN_TO_START = MC;

export function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  // Jan 31 + 1 month is the last day of February, not March 3.
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d;
}

/** When a period that starts at `start` ends for `plan`. */
export function periodEnd(start, plan) {
  const hours = Number(plan?.periodHours);
  if (Number.isInteger(hours) && hours > 0) return new Date(new Date(start).getTime() + hours * 3_600_000);
  return addMonths(start, 1);
}

async function ledger(client, e) {
  await client.query(
    `insert into credit_ledger (user_id, kind, delta, plan_after, bonus_after, usage_id, note, actor_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.userId, e.kind, e.delta, e.planAfter, e.bonusAfter, e.usageId ?? null, e.note ?? null, e.actorId ?? null],
  );
}

async function lock(client, userId) {
  const { rows } = await client.query('select * from credit_account where user_id = $1 for update', [userId]);
  return rows[0] || null;
}

async function create(client, userId, settings, now) {
  const plan = settings.plans.free;
  const monthly = plan.monthlyCredits * MC;
  const bonus = settings.signupBonusCredits * MC;
  const { rows } = await client.query(
    `insert into credit_account (user_id, plan, plan_credits, bonus_credits, period_start, period_end)
     values ($1, 'free', $2, $3, $4, $5) on conflict (user_id) do nothing returning *`,
    [userId, monthly, bonus, now, periodEnd(now, plan)],
  );
  // Another request created it first: use that one.
  if (!rows[0]) return lock(client, userId);
  await ledger(client, { userId, kind: 'monthly_grant', delta: monthly, planAfter: monthly, bonusAfter: 0, note: `${plan.name} plan` });
  if (bonus) await ledger(client, { userId, kind: 'signup_bonus', delta: bonus, planAfter: monthly, bonusAfter: bonus, note: 'Welcome credits' });
  return rows[0];
}

async function refill(client, acct, settings, now) {
  if (now < new Date(acct.period_end)) return acct;
  const plan = settings.plans[acct.plan] || settings.plans.free;
  let start = new Date(acct.period_start);
  let end = new Date(acct.period_end);
  if (plan.periodHours) {
    // Hourly plans restart from now: the clock runs from the first request after the refill.
    start = now;
    end = periodEnd(now, plan);
  } else {
    while (end <= now) {
      start = end;
      end = addMonths(start, 1);
    }
  }
  const planCredits = plan.monthlyCredits * MC + Math.min(0, acct.plan_credits);
  const { rows } = await client.query(
    `update credit_account set plan_credits = $2, period_start = $3, period_end = $4, updated_at = now()
     where user_id = $1 returning *`,
    [acct.user_id, planCredits, start, end],
  );
  await ledger(client, {
    userId: acct.user_id, kind: 'monthly_grant', delta: planCredits - acct.plan_credits,
    planAfter: planCredits, bonusAfter: acct.bonus_credits, note: `${plan.name} plan, new ${plan.periodHours ? 'period' : 'month'}`,
  });
  return rows[0];
}

/**
 * The user's account, created on first use (with the welcome bonus) and
 * refilled when a period has ended. Call only for verified users.
 */
export async function getAccount(pool, userId, settings, now = new Date()) {
  return tx(pool, async (client) => {
    let acct = await lock(client, userId);
    if (!acct) acct = await create(client, userId, settings, now);
    return refill(client, acct, settings, now);
  });
}

/** Spend `mc` millicredits for a finished request. */
export async function charge(pool, userId, mc, { usageId = null, note = null } = {}) {
  if (!(mc > 0)) return null;
  return tx(pool, async (client) => {
    const acct = await lock(client, userId);
    if (!acct) return null;
    let plan = acct.plan_credits;
    let bonus = acct.bonus_credits;
    let left = mc;
    const fromPlan = Math.min(left, Math.max(0, plan));
    plan -= fromPlan;
    left -= fromPlan;
    const fromBonus = Math.min(left, Math.max(0, bonus));
    bonus -= fromBonus;
    left -= fromBonus;
    // A request that cost more than was left: the rest is owed from the next refill.
    plan -= left;
    const { rows } = await client.query(
      `update credit_account set plan_credits = $2, bonus_credits = $3, updated_at = now() where user_id = $1 returning *`,
      [userId, plan, bonus],
    );
    await ledger(client, { userId, kind: 'usage', delta: -mc, planAfter: plan, bonusAfter: bonus, usageId, note });
    return rows[0];
  });
}

/**
 * Add (or with a negative amount, remove) credits by hand.
 * Removing never takes a bucket below zero.
 */
export async function adjust(pool, userId, mc, { bucket = 'bonus', note = null, actorId = null, kind } = {}) {
  return tx(pool, async (client) => {
    const acct = await lock(client, userId);
    if (!acct) return null;
    let plan = acct.plan_credits;
    let bonus = acct.bonus_credits;
    if (bucket === 'plan') plan = mc >= 0 ? plan + mc : Math.max(0, plan + mc);
    else bonus = mc >= 0 ? bonus + mc : Math.max(0, bonus + mc);
    const delta = plan - acct.plan_credits + (bonus - acct.bonus_credits);
    const { rows } = await client.query(
      `update credit_account set plan_credits = $2, bonus_credits = $3, updated_at = now() where user_id = $1 returning *`,
      [userId, plan, bonus],
    );
    await ledger(client, {
      userId, kind: kind || (mc >= 0 ? 'admin_grant' : 'admin_debit'), delta, planAfter: plan, bonusAfter: bonus, note, actorId,
    });
    return rows[0];
  });
}

/** Move a user to a plan: a new period starts now with that plan's full allowance. */
export async function setPlan(pool, userId, planId, settings, { actorId = null, note = null, now = new Date() } = {}) {
  const plan = settings.plans[planId];
  if (!plan) throw new Error(`Unknown plan "${planId}"`);
  return tx(pool, async (client) => {
    let acct = await lock(client, userId);
    if (!acct) acct = await create(client, userId, settings, now);
    const planCredits = plan.monthlyCredits * MC + Math.min(0, acct.plan_credits);
    const { rows } = await client.query(
      `update credit_account set plan = $2, plan_credits = $3, period_start = $4, period_end = $5, updated_at = now()
       where user_id = $1 returning *`,
      [userId, planId, planCredits, now, periodEnd(now, plan)],
    );
    await ledger(client, {
      userId, kind: 'plan_change', delta: planCredits - acct.plan_credits, planAfter: planCredits,
      bonusAfter: acct.bonus_credits, note: note || `Plan set to ${plan.name}`, actorId,
    });
    return rows[0];
  });
}

/** Spendable millicredits (plan debt counts against bonus credits). */
export const spendable = (acct) => acct.plan_credits + acct.bonus_credits;

/** The account as the app shows it, in credits. */
export function describe(acct, settings) {
  const plan = settings.plans[acct.plan] || settings.plans.free;
  const round = (mc) => Math.round(mc / 100) / 10;
  return {
    plan: acct.plan,
    planName: plan.name,
    monthly: plan.monthlyCredits,
    refillCredits: plan.monthlyCredits,
    periodHours: plan.periodHours || null,
    planCredits: round(acct.plan_credits),
    bonusCredits: round(acct.bonus_credits),
    remaining: round(Math.max(0, spendable(acct))),
    periodStart: new Date(acct.period_start).toISOString(),
    periodEnd: new Date(acct.period_end).toISOString(),
  };
}
