// Vercel entry: the Hono app as the default export. Static pages in public/
// are served by Vercel's CDN before requests reach this function.
import { Hono } from 'hono';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createApp } from './app.js';

// Vercel's request context (what @vercel/functions' waitUntil reads): keeps the
// function alive until the promise settles, e.g. charging an aborted stream.
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
function waitUntil(promise) {
  const context = globalThis[REQUEST_CONTEXT]?.get?.();
  if (context?.waitUntil) context.waitUntil(promise);
  promise.catch((e) => console.error(`[background] ${e?.message || e}`));
}

function notConfigured(missing) {
  const app = new Hono();
  app.all('*', (c) => c.json({ error: 'not_configured', message: `Impulse Cloud is missing ${missing.join(', ')}.` }, 503));
  return app;
}

const { config, missing } = loadConfig();
const app = config
  ? createApp({ config, pool: createPool(config.databaseURL, { max: 3 }), background: waitUntil }).app
  : notConfigured(missing);

export default app;
