// Impulse Cloud as one Hono app. Used by the Vercel entry (src/index.js) and
// the local server (scripts/serve.js).

import { Hono } from 'hono';
import { createAuth } from './auth.js';
import { createMailer } from './email.js';
import { createSettingsStore } from './settings.js';
import { createBudget } from './limits.js';
import { createGateway } from './gateway.js';
import { createAccountApi } from './account-api.js';
import { createAdminApi } from './admin-api.js';
import { createDesktopHandoff } from './desktop.js';
import { createLearningApi } from './learning.js';
import { getAccount } from './credits.js';

/**
 * @param {{
 *   config: object,
 *   pool: import('pg').Pool,
 *   background?: (p: Promise<unknown>) => void,
 *   log?: (msg: string) => void,
 *   fetch?: typeof fetch,
 *   staticFiles?: import('hono').MiddlewareHandler,
 * }} options
 */
export function createApp({ config, pool, background, log = (m) => console.log(m), fetch: fetchImpl, staticFiles }) {
  const runInBackground = background || ((p) => { p.catch((e) => log(`[background] ${e?.message || e}`)); });
  const settings = createSettingsStore(pool);
  const budget = createBudget(pool);
  // A verified address opens the credit account (welcome bonus included) right away.
  const onVerified = async (userId) => getAccount(pool, userId, await settings.get());
  const auth = createAuth({ config, pool, sendCode: createMailer(config.email, log), onVerified, background: runInBackground });
  const deps = { config, pool, auth, settings, budget, background: runInBackground, log, fetch: fetchImpl };
  const gateway = createGateway(deps);
  const account = createAccountApi(deps);
  const admin = createAdminApi(deps);
  const desktop = createDesktopHandoff(deps);
  const learning = createLearningApi(deps);

  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'strict-origin-when-cross-origin');
    c.header('x-frame-options', 'DENY');
  });

  app.get('/health', (c) => c.json({ ok: true }));
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

  // Two lanes, one gate: the model's vendor decides which the app uses.
  app.post('/ai/v1/messages', (c) => gateway.messages(c.req.raw));
  app.post('/ai/openai/v1/responses', (c) => gateway.responses(c.req.raw));

  app.get('/v1/config', () => account.config());
  app.get('/v1/me', (c) => account.me(c.req.raw));
  app.get('/v1/models', (c) => account.models(c.req.raw));
  app.post('/v1/route', (c) => account.route(c.req.raw));
  app.get('/v1/usage', (c) => account.usage(c.req.raw));
  app.get('/v1/plans', (c) => account.plans(c.req.raw));
  app.post('/v1/upgrade-request', (c) => account.requestUpgrade(c.req.raw));
  // Learning from fixes: the apps share (error, fix) records and ask for known fixes.
  app.post('/v1/learn/fixes', (c) => learning.share(c.req.raw));
  app.get('/v1/learn/fixes', (c) => learning.known(c.req.raw));
  app.get('/v1/knowledge/manifest', (c) => learning.manifest(c.req.raw));

  app.get('/desktop/complete', (c) => desktop.complete(c.req.raw));
  app.post('/desktop/token', (c) => desktop.token(c.req.raw));

  app.get('/admin/api/me', (c) => admin.whoami(c.req.raw));
  app.get('/admin/api/overview', (c) => admin.overview(c.req.raw));
  app.get('/admin/api/users', (c) => admin.users(c.req.raw));
  app.get('/admin/api/users/:id', (c) => admin.user(c.req.raw, c.req.param('id')));
  app.post('/admin/api/users/:id/credits', (c) => admin.grant(c.req.raw, c.req.param('id')));
  app.post('/admin/api/users/:id/plan', (c) => admin.plan(c.req.raw, c.req.param('id')));
  app.post('/admin/api/users/:id/role', (c) => admin.role(c.req.raw, c.req.param('id')));
  app.post('/admin/api/users/:id/suspend', (c) => admin.ban(c.req.raw, c.req.param('id'), true));
  app.post('/admin/api/users/:id/restore', (c) => admin.ban(c.req.raw, c.req.param('id'), false));
  app.post('/admin/api/users/:id/sign-out', (c) => admin.revokeSessions(c.req.raw, c.req.param('id')));
  app.get('/admin/api/settings', (c) => admin.getSettings(c.req.raw));
  app.put('/admin/api/settings', (c) => admin.putSettings(c.req.raw));
  app.get('/admin/api/requests', (c) => admin.requests(c.req.raw));
  app.post('/admin/api/requests/:id', (c) => admin.decide(c.req.raw, c.req.param('id')));
  app.get('/admin/api/audit', (c) => admin.audit(c.req.raw));
  app.get('/admin/api/learning', (c) => admin.learning(c.req.raw));

  app.get('/', (c) => c.redirect(config.websiteURL, 302));
  // Folder pages without the trailing slash (/admin → /admin/).
  for (const page of ['admin', 'sign-in', 'desktop/done']) app.get(`/${page}`, (c) => c.redirect(`/${page}/`, 301));

  if (staticFiles) app.use('*', staticFiles);

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((error, c) => {
    log(`[error] ${c.req.method} ${c.req.path}: ${error?.stack || error}`);
    return c.json({ error: 'server_error', message: 'Something went wrong on our side.' }, 500);
  });

  return { app, auth, settings };
}
