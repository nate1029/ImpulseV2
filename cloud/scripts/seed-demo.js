// Fills a LOCAL database with demo users and 30 days of AI usage so the admin
// console has something to show: node --env-file=.env scripts/seed-demo.js
// Refuses to run against anything but localhost.
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { DEFAULTS } from '../src/settings.js';
import { charge, getAccount, setPlan } from '../src/credits.js';
import { costMicros, toMillicredits } from '../src/pricing.js';

const { config, missing } = loadConfig();
if (!config) {
  console.error(`Set ${missing.join(' and ')} first.`);
  process.exit(1);
}
const host = new URL(config.databaseURL).hostname;
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  console.error(`Refusing to seed ${host}: demo data is for local databases only.`);
  process.exit(1);
}

const pool = createPool(config.databaseURL);
const names = ['Aarav Shah', 'Mia Chen', 'Lucas Silva', 'Zara Khan', 'Noah Becker', 'Isha Patel', 'Leo Rossi', 'Ana Costa', 'Kenji Ito', 'Sara Haddad', 'Omar Farouk', 'Emma Novak'];
const models = ['claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const day = 86400_000;

try {
  for (const [i, name] of names.entries()) {
    const id = randomUUID();
    const email = `${name.split(' ')[0].toLowerCase()}@demo.impulse.test`;
    const joined = new Date(Date.now() - (29 - i * 2) * day - Math.random() * day);
    await pool.query(
      `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role) values ($1, $2, $3, $4, $5, $5, 'user')
       on conflict (email) do nothing`,
      [id, name, email, i !== 11, joined],
    );
    if (i === 11) continue; // one unverified account
    await getAccount(pool, id, DEFAULTS, joined);
    if (i % 5 === 0) await setPlan(pool, id, 'pro', DEFAULTS, { note: 'Demo upgrade' });
    const requests = 6 + Math.floor(Math.random() * 40);
    for (let r = 0; r < requests; r++) {
      const at = new Date(joined.getTime() + Math.random() * (Date.now() - joined.getTime()));
      const model = models[(r + i) % models.length];
      const usage = { input_tokens: 800 + Math.floor(Math.random() * 3000), cache_read_input_tokens: 4000 + Math.floor(Math.random() * 20000), output_tokens: 150 + Math.floor(Math.random() * 1800) };
      const micros = costMicros(model, model, usage);
      const mc = toMillicredits(micros, DEFAULTS);
      const { rows } = await pool.query(
        `insert into usage_event (user_id, model, served_model, status, input_tokens, output_tokens, cache_read_tokens, cost_micros, credits_charged, http_status, duration_ms, client, created_at)
         values ($1, $2, $2, 'ok', $3, $4, $5, $6, $7, 200, $8, 'Impulse IDE/demo', $9) returning id`,
        [id, model, usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, micros, mc, 2000 + Math.floor(Math.random() * 9000), at],
      );
      await charge(pool, id, mc, { usageId: rows[0].id, note: 'demo' });
    }
    if (i === 3) await pool.query(`insert into upgrade_request (user_id, plan, note) values ($1, 'pro', 'Running a robotics workshop next week') on conflict do nothing`, [id]);
  }
  console.log(`Seeded ${names.length} demo users with usage.`);
} finally {
  await pool.end();
}
