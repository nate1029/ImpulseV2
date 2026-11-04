// npm run migrate — run against DATABASE_URL (use node --env-file=.env).
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const { config, missing } = loadConfig();
if (!config) {
  console.error(`Set ${missing.join(' and ')} first (see .env.example).`);
  process.exit(1);
}
const pool = createPool(config.databaseURL, { max: 1 });
try {
  const applied = await migrate({ config, pool, log: (m) => console.log(m) });
  console.log(applied.length ? `Done: ${applied.length} change(s).` : 'Already up to date.');
} catch (error) {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
