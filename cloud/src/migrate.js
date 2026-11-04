// Brings a database up to date: Better Auth's tables first (the app tables
// reference "user"), then each migrations/*.sql file once, in name order.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMigrations } from 'better-auth/db/migration';
import { authOptions } from './auth.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** @returns {Promise<string[]>} what was applied */
export async function migrate({ config, pool, log = () => {} }) {
  const applied = [];
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(authOptions({ config, pool, sendCode: async () => {} }));
  if (toBeCreated.length || toBeAdded.length) {
    await runMigrations();
    const tables = [...toBeCreated.map((t) => t.table), ...toBeAdded.map((t) => `${t.table} (columns)`)];
    applied.push(...tables.map((t) => `auth: ${t}`));
    log(`Better Auth tables: ${tables.join(', ')}`);
  }

  await pool.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const files = (await fs.readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const { rowCount } = await pool.query('select 1 from schema_migrations where name = $1', [file]);
    if (rowCount) continue;
    const sql = await fs.readFile(path.join(MIGRATIONS, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1)', [file]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw new Error(`${file}: ${error.message}`);
    } finally {
      client.release();
    }
    applied.push(file);
    log(`Applied ${file}`);
  }
  return applied;
}
