// Test harness: a scratch Postgres (TEST_DATABASE_URL), the app called in
// process through app.fetch, and fake Anthropic and OpenAI APIs on local ports.

import http from 'node:http';
import { createPool } from '../src/db.js';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';

export const BASE = 'http://localhost:8787';
const DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://impulse@127.0.0.1:55432/impulse_test';

/** A fake /v1/messages. `reply` decides each response from the request body. */
export async function startFakeAnthropic() {
  const calls = [];
  const fake = {
    calls,
    usage: { input_tokens: 1200, cache_read_input_tokens: 8000, cache_creation_input_tokens: 500, output_tokens: 300 },
    // Override per test: return { status, json } or { chunks: [...] } or undefined for the default.
    reply: null,
    url: '',
    close: () => {},
  };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    calls.push({ url: req.url, headers: req.headers, body });
    if (req.headers['x-api-key'] !== 'test-anthropic-key') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
      return;
    }
    const custom = fake.reply?.(body);
    if (custom?.status) {
      res.writeHead(custom.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(custom.json));
      return;
    }
    const usage = custom?.usage || fake.usage;
    const message = {
      id: 'msg_test', type: 'message', role: 'assistant', model: body.model, content: [],
      stop_reason: null, usage: { ...usage, output_tokens: 1 },
    };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_test' });
      res.end(JSON.stringify({ ...message, content: [{ type: 'text', text: 'Hello from the fake API.' }], stop_reason: 'end_turn', usage }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_test' });
    const events = custom?.events || [
      { type: 'message_start', message },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'from the fake API.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } },
      { type: 'message_stop' },
    ];
    for (const event of events) {
      if (event === 'hang') return; // leave the stream open (abort tests)
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      await new Promise((r) => setTimeout(r, 2));
    }
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${server.address().port}`;
  fake.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return fake;
}

/** A fake /v1/responses. `reply` decides each response from the request body. */
export async function startFakeOpenAI() {
  const calls = [];
  const fake = {
    calls,
    usage: { input_tokens: 10000, input_tokens_details: { cached_tokens: 8000 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 100 }, total_tokens: 10300 },
    // Override per test: return { status, json } or { events: [...] } or undefined for the default.
    reply: null,
    url: '',
    close: () => {},
  };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    calls.push({ url: req.url, headers: req.headers, body });
    if (req.headers.authorization !== 'Bearer test-openai-key') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }));
      return;
    }
    const custom = fake.reply?.(body);
    if (custom?.status) {
      res.writeHead(custom.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(custom.json));
      return;
    }
    const usage = custom?.usage || fake.usage;
    const served = `${body.model}-2026-03-05`;
    const message = { type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello from the fake API.', annotations: [] }] };
    const response = { id: 'resp_test', object: 'response', model: served, status: 'completed', output: [message], usage };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req_openai_test' });
      res.end(JSON.stringify(response));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req_openai_test' });
    const events = custom?.events || [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Hello ' },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'from the fake API.' },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response },
    ];
    for (const event of events) {
      if (event === 'hang') return; // leave the stream open (abort tests)
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      await new Promise((r) => setTimeout(r, 2));
    }
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fake.url = `http://127.0.0.1:${server.address().port}`;
  fake.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return fake;
}

export function testConfig(overrides = {}) {
  return {
    baseURL: BASE,
    production: false,
    secret: 'test-secret-that-is-long-enough-for-better-auth-0123456789',
    databaseURL: DATABASE_URL,
    anthropic: { apiKey: 'test-anthropic-key', baseURL: 'http://127.0.0.1:9' },
    openai: { apiKey: 'test-openai-key', baseURL: 'http://127.0.0.1:9' },
    google: null,
    github: null,
    email: { resendKey: '', from: 'Impulse <test@impulse.test>', enabled: true },
    adminEmails: ['owner@impulse.test'],
    trustedOrigins: [],
    websiteURL: 'https://impulse-ide.vercel.app',
    ...overrides,
  };
}

/** A fresh database and app for one test file. */
export async function setup({ fake, fakeOpenAI } = {}) {
  const pool = createPool(DATABASE_URL, { max: 4 });
  await pool.query('drop schema if exists public cascade');
  await pool.query('create schema public');
  const config = testConfig({
    ...(fake ? { anthropic: { apiKey: 'test-anthropic-key', baseURL: fake.url } } : {}),
    ...(fakeOpenAI ? { openai: { apiKey: 'test-openai-key', baseURL: fakeOpenAI.url } } : {}),
  });
  await migrate({ config, pool });
  const logs = [];
  const background = [];
  const { app, settings } = createApp({
    config, pool, log: (m) => logs.push(m), background: (p) => background.push(p.catch(() => {})),
  });
  // Each request comes from its own client address unless a test sets one, so
  // per-IP auth rate limits only apply where a test means to hit them.
  const randomIP = () => `10.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}.${(Math.random() * 254 + 1) | 0}`;
  const request = (path, init = {}) => {
    const headers = new Headers(init.headers || {});
    if (!headers.has('x-forwarded-for')) headers.set('x-forwarded-for', randomIP());
    return app.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
  };
  const t = {
    pool, config, app, settings, logs, request,
    /** Wait for work the app started in the background (e.g. charging an aborted stream). */
    settleBackground: () => Promise.all(background.splice(0)),
    async close() {
      await t.settleBackground();
      await pool.end();
    },
    /** The last email code sent to an address. */
    codeFor(email) {
      const line = [...logs].reverse().find((l) => l.includes(`code for ${email}:`));
      return line ? line.split(': ').pop().trim() : null;
    },
    json: (path, body, init = {}) => request(path, {
      method: 'POST',
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers || {}) },
      body: JSON.stringify(body),
    }),
    /** Sign up with email + password, verify the code, return { token, user }. */
    async signUp(email, { name = 'Test User', password = 'correct horse battery' } = {}) {
      const res = await t.json('/api/auth/sign-up/email', { name, email, password });
      if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
      // The code is sent in the background; let it run.
      await new Promise((r) => setTimeout(r, 5));
      const otp = t.codeFor(email);
      const verified = await t.json('/api/auth/email-otp/verify-email', { email, otp });
      if (!verified.ok) throw new Error(`verify failed: ${verified.status} ${await verified.text()}`);
      const data = await verified.json();
      return { token: data.token, user: data.user };
    },
    bearer: (token) => ({ authorization: `Bearer ${token}` }),
  };
  return t;
}

/** Read a streamed response to the end as text. */
export async function readAll(res) {
  return new TextDecoder().decode(await res.arrayBuffer());
}
