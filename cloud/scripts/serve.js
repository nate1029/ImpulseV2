// Local server: node --env-file=.env scripts/serve.js (npm run dev).
// Serves the API and public/ (on Vercel, public/ is served by the CDN).
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';

const { config, missing } = loadConfig();
if (!config) {
  console.error(`Set ${missing.join(' and ')} first (see .env.example).`);
  process.exit(1);
}
const pool = createPool(config.databaseURL);
if (process.env.MIGRATE_ON_START !== '0') await migrate({ config, pool, log: (m) => console.log(m) });

const { app } = createApp({ config, pool, staticFiles: serveStatic({ root: './public' }) });
const port = Number(process.env.PORT) || 8787;
// On this machine the server stays on localhost; in a container (Cloud Run,
// Render) HOST=0.0.0.0 lets the platform reach it.
const hostname = process.env.HOST || '127.0.0.1';
serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`Impulse Cloud on ${config.baseURL} (listening on ${hostname}:${port})`);
});
