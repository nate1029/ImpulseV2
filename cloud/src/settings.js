// Business settings the admin console can change without a deploy. Stored one
// key per row in app_setting; anything not stored uses the default below.

import { MODELS } from './pricing.js';
import { ROUTE_KINDS } from './routing.js';

const ALL_MODELS = Object.keys(MODELS);

export const DEFAULTS = Object.freeze({
  signupBonusCredits: 200,
  // 1 credit = 1 cent of upstream list price, before markup.
  creditsPerUsd: 100,
  markup: 1,
  defaultModel: 'gpt-5.4',
  enabledModels: ALL_MODELS,
  // One "Impulse AI" to the person; the model behind it is chosen here per
  // kind of work, cheapest first, and moves up the escalation ladder when a
  // turn has already failed (a compile that did not pass, a check that failed).
  routing: {
    agent: 'gpt-5.4', plan: 'gpt-5.4', debug: 'gpt-5.4', ask: 'gpt-5.4-mini', summary: 'gpt-5.4-nano',
    escalation: ['gpt-5.5'],
  },
  maxOutputTokens: 32_000,
  rateLimitPerMinute: 40,
  // Stop serving AI for the rest of the UTC day once upstream spend passes this.
  dailyBudgetUsd: 25,
  maintenance: false,
  announcement: '',
  // Accept fix records from the apps (learning from fixes); off stops intake, lookups still work.
  learningEnabled: true,
  // monthlyCredits is the allowance per period; periodHours null means a
  // calendar month. The free plan refills a small allowance every few hours,
  // so a student who runs out waits rather than paying; paid plans are monthly.
  plans: {
    free: {
      name: 'Free', monthlyCredits: 25, periodHours: 5, priceUsd: 0,
      models: ['gpt-5.4', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4-nano', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    },
    pro: { name: 'Pro', monthlyCredits: 1500, periodHours: null, priceUsd: 20, models: ALL_MODELS },
    max: { name: 'Max', monthlyCredits: 6000, periodHours: null, priceUsd: 60, models: ALL_MODELS },
  },
});

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** Validators per key: return an error message, or null when the value is fine. */
const RULES = {
  signupBonusCredits: (v) => (isInt(v, 0, 1_000_000) ? null : 'a whole number from 0 to 1,000,000'),
  creditsPerUsd: (v) => (isNum(v, 1, 100_000) ? null : 'a number from 1 to 100,000'),
  markup: (v) => (isNum(v, 0.1, 10) ? null : 'a number from 0.1 to 10'),
  defaultModel: (v) => (ALL_MODELS.includes(v) ? null : `one of ${ALL_MODELS.join(', ')}`),
  enabledModels: (v) => (Array.isArray(v) && v.length && v.every((m) => ALL_MODELS.includes(m)) ? null : 'a non-empty list of known models'),
  maxOutputTokens: (v) => (isInt(v, 1024, 128_000) ? null : 'a whole number from 1,024 to 128,000'),
  rateLimitPerMinute: (v) => (isInt(v, 1, 10_000) ? null : 'a whole number from 1 to 10,000'),
  dailyBudgetUsd: (v) => (isNum(v, 0, 1_000_000) ? null : 'a number from 0 to 1,000,000'),
  maintenance: (v) => (typeof v === 'boolean' ? null : 'true or false'),
  learningEnabled: (v) => (typeof v === 'boolean' ? null : 'true or false'),
  announcement: (v) => (typeof v === 'string' && v.length <= 280 ? null : 'text up to 280 characters'),
  routing: (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return 'an object with a model per kind of work';
    for (const kind of ROUTE_KINDS) if (!ALL_MODELS.includes(v[kind])) return `a known model for "${kind}"`;
    if (!Array.isArray(v.escalation) || v.escalation.length > 3 || !v.escalation.every((m) => ALL_MODELS.includes(m))) return 'an escalation list of up to three known models';
    return null;
  },
  plans: (v) => {
    if (!v || typeof v !== 'object') return 'an object of plans';
    for (const id of ['free', 'pro', 'max']) {
      const p = v[id];
      if (!p) return `plan "${id}" is required`;
      if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 40) return `plan "${id}" needs a name`;
      if (!isInt(p.monthlyCredits, 0, 10_000_000)) return `plan "${id}" credits per period must be a whole number`;
      if (p.periodHours !== null && p.periodHours !== undefined && !isInt(p.periodHours, 1, 720)) return `plan "${id}" refill period must be 1 to 720 hours, or empty for a month`;
      if (!isNum(p.priceUsd, 0, 100_000)) return `plan "${id}" price must be a number`;
      if (!Array.isArray(p.models) || !p.models.length || !p.models.every((m) => ALL_MODELS.includes(m))) return `plan "${id}" needs at least one known model`;
    }
    return null;
  },
};

export const PLAN_IDS = ['free', 'pro', 'max'];

/**
 * Validate a partial update.
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function validateSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'Send an object of settings.' };
  const value = {};
  for (const [key, v] of Object.entries(patch)) {
    const rule = RULES[key];
    if (!rule) return { ok: false, error: `Unknown setting "${key}".` };
    const problem = rule(v);
    if (problem) return { ok: false, error: `${key} must be ${problem}.` };
    if (key === 'plans') {
      value[key] = Object.fromEntries(PLAN_IDS.map((id) => [id, {
        name: v[id].name.trim(), monthlyCredits: v[id].monthlyCredits, periodHours: Number.isInteger(v[id].periodHours) ? v[id].periodHours : null,
        priceUsd: v[id].priceUsd, models: [...new Set(v[id].models)],
      }]));
    } else if (key === 'routing') {
      value[key] = { ...Object.fromEntries(ROUTE_KINDS.map((k) => [k, v[k]])), escalation: [...new Set(v.escalation)] };
    } else {
      value[key] = v;
    }
  }
  return { ok: true, value };
}

export function createSettingsStore(pool, { ttlMs = 15_000 } = {}) {
  let cached = null;
  let cachedAt = 0;

  async function load() {
    const { rows } = await pool.query('select key, value from app_setting');
    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const merged = { ...DEFAULTS };
    for (const key of Object.keys(RULES)) {
      if (key in stored && RULES[key](stored[key]) === null) merged[key] = stored[key];
    }
    return merged;
  }

  return {
    async get() {
      if (!cached || Date.now() - cachedAt > ttlMs) {
        cached = await load();
        cachedAt = Date.now();
      }
      return cached;
    },
    /** @param {object} value validated patch */
    async update(value, actorId) {
      for (const [key, v] of Object.entries(value)) {
        await pool.query(
          `insert into app_setting (key, value, updated_at, updated_by) values ($1, $2, now(), $3)
           on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
          [key, JSON.stringify(v), actorId],
        );
      }
      cached = null;
      return this.get();
    },
    invalidate() { cached = null; },
  };
}
