// Per-user request rate (one counter row per user per minute) and the global
// daily spend cap that protects the API bill.

/** @returns {Promise<boolean>} false once the user is over the per-minute limit */
export async function allowRequest(pool, userId, perMinute, now = Date.now()) {
  const bucket = new Date(Math.floor(now / 60_000) * 60_000);
  const { rows } = await pool.query(
    `insert into rate_bucket (user_id, bucket, count) values ($1, $2, 1)
     on conflict (user_id, bucket) do update set count = rate_bucket.count + 1
     returning count`,
    [userId, bucket],
  );
  // Old buckets are only bookkeeping; sweep them now and then.
  if (Math.random() < 0.02) {
    pool.query(`delete from rate_bucket where bucket < now() - interval '1 hour'`).catch(() => {});
  }
  return rows[0].count <= perMinute;
}

export function createBudget(pool, { ttlMs = 30_000 } = {}) {
  let cached = { at: 0, micros: 0 };
  return {
    /** Upstream spend so far today (UTC), in micro-USD; cached briefly. */
    async spentToday() {
      if (Date.now() - cached.at > ttlMs) {
        const { rows } = await pool.query(
          `select coalesce(sum(cost_micros), 0)::bigint as micros from usage_event
           where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`,
        );
        cached = { at: Date.now(), micros: Number(rows[0].micros) };
      }
      return cached.micros;
    },
    /** Count a finished request now, so the cap holds between refreshes. */
    add(micros) {
      if (micros > 0 && cached.at) cached.micros += micros;
    },
    async exceeded(dailyBudgetUsd) {
      if (!(dailyBudgetUsd > 0)) return false;
      return (await this.spentToday()) >= dailyBudgetUsd * 1e6;
    },
  };
}
