// The AI gateway: one gate, two lanes.
//
//   POST /ai/v1/messages          Anthropic-compatible; the app's Anthropic SDK points here
//   POST /ai/openai/v1/responses   OpenAI's Responses API; the app's OpenAI client points here
//
// Each request is checked (signed in, verified, not banned, model enabled and
// on the plan, its vendor set up on this server, credits left, rate and daily
// budget), forwarded with Impulse's own key for that vendor, streamed back
// unchanged, and charged from the usage the vendor reports.

import { createHmac } from 'node:crypto';
import { MODELS, costMicros, microsFor, toMillicredits, totalTokens } from './pricing.js';
import { MC, MIN_TO_START, charge, getAccount, spendable } from './credits.js';
import { allowRequest } from './limits.js';

const ANTHROPIC_VERSION = '2023-06-01';
const MAX_BODY_BYTES = 6 * 1024 * 1024;

/** Anthropic request fields passed through; anything else (server tools, fast mode, containers…) is dropped. */
const ANTHROPIC_FIELDS = new Set([
  'model', 'messages', 'system', 'max_tokens', 'tools', 'tool_choice', 'thinking', 'output_config',
  'stop_sequences', 'stream', 'cache_control', 'fallbacks', 'temperature', 'top_p', 'top_k',
  'context_management',
]);

const BETAS = new Set([
  'server-side-fallback-2026-07-01',
  'server-side-fallback-2026-06-01',
  'thinking-display-updates-2026-08-18',
  'mid-conversation-output-config-2026-07-01',
  'context-management-2025-06-27',
  'compact-2026-01-12',
]);

/**
 * OpenAI Responses fields passed through. `store`, `background`, server-side
 * conversations and the identifiers are ours to set or refuse.
 */
const OPENAI_FIELDS = new Set([
  'model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'max_output_tokens',
  'reasoning', 'text', 'stream', 'temperature', 'top_p', 'truncation', 'include', 'prompt_cache_retention',
]);
/** The only `include` worth passing: encrypted reasoning, so a turn's reasoning survives its tool steps. */
const OPENAI_INCLUDES = new Set(['reasoning.encrypted_content']);

// ── Errors in each vendor's own shape, so each client's SDK understands them ──

/** Impulse's reasons → the type OpenAI clients expect; `code` keeps Impulse's reason. */
const OPENAI_TYPES = {
  insufficient_credits: 'insufficient_quota',
  api_error: 'server_error',
  overloaded_error: 'server_error',
  request_too_large: 'invalid_request_error',
};

function errorBody(vendor, type, message) {
  if (vendor === 'openai') return { error: { message, type: OPENAI_TYPES[type] || type, code: type } };
  return { type: 'error', error: { type, message } };
}

export function apiError(status, type, message, headers = {}, vendor = 'anthropic') {
  return new Response(JSON.stringify(errorBody(vendor, type, message)), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** The two error makers of a lane: `final` ones the SDK must not retry (it honours x-should-retry). */
function errorsFor(vendor) {
  const error = (status, type, message, headers = {}) => apiError(status, type, message, headers, vendor);
  const final = (status, type, message) => error(status, type, message, { 'x-should-retry': 'false' });
  return { error, final };
}

async function readLimited(request, limit) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > limit) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function cheapestPlanWith(settings, model) {
  return ['free', 'pro', 'max'].find((id) => settings.plans[id]?.models.includes(model)) || null;
}

/** @returns {{ body: object } | { error: Response }} */
export function sanitize(body, settings, userKey) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: apiError(400, 'invalid_request_error', 'The request body must be a JSON object.') };
  }
  const out = {};
  for (const [key, value] of Object.entries(body)) if (ANTHROPIC_FIELDS.has(key)) out[key] = value;
  if (!Array.isArray(out.messages) || out.messages.length === 0) {
    return { error: apiError(400, 'invalid_request_error', 'messages must be a non-empty array.') };
  }
  if (out.tools !== undefined) {
    if (!Array.isArray(out.tools)) return { error: apiError(400, 'invalid_request_error', 'tools must be an array.') };
    const server = out.tools.find((t) => t && typeof t === 'object' && t.type && t.type !== 'custom');
    if (server) return { error: apiError(400, 'invalid_request_error', `The ${server.type} tool isn't available through Impulse.`) };
  }
  const asked = Number(out.max_tokens);
  out.max_tokens = Math.min(Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : 4096, settings.maxOutputTokens);
  out.metadata = { user_id: userKey };
  return { body: out };
}

/**
 * The OpenAI lane's request, with only the fields we pass, our own identifiers,
 * function tools only, and nothing stored or run in the background upstream.
 * @returns {{ body: object } | { error: Response }}
 */
export function sanitizeOpenAI(body, settings, userKey) {
  const { error } = errorsFor('openai');
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: error(400, 'invalid_request_error', 'The request body must be a JSON object.') };
  }
  const out = {};
  for (const [key, value] of Object.entries(body)) if (OPENAI_FIELDS.has(key)) out[key] = value;
  const hasInput = typeof out.input === 'string' ? out.input.length > 0 : Array.isArray(out.input) && out.input.length > 0;
  if (!hasInput) return { error: error(400, 'invalid_request_error', 'input must be a non-empty string or array.') };
  if (out.tools !== undefined) {
    if (!Array.isArray(out.tools)) return { error: error(400, 'invalid_request_error', 'tools must be an array.') };
    const other = out.tools.find((t) => !t || typeof t !== 'object' || t.type !== 'function');
    if (other) return { error: error(400, 'invalid_request_error', `The ${other?.type || 'unknown'} tool isn't available through Impulse.`) };
  }
  if (body.previous_response_id !== undefined || body.conversation !== undefined) {
    return { error: error(400, 'invalid_request_error', 'Impulse keeps no conversation state upstream: send the whole input each time.') };
  }
  if (out.include !== undefined) {
    out.include = Array.isArray(out.include) ? out.include.filter((i) => OPENAI_INCLUDES.has(i)) : [];
    if (!out.include.length) delete out.include;
  }
  const asked = Number(out.max_output_tokens);
  const fallback = Math.min(16000, settings.maxOutputTokens);
  out.max_output_tokens = Math.min(Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : fallback, settings.maxOutputTokens);
  out.safety_identifier = userKey;
  out.prompt_cache_key = userKey;
  out.store = false;
  return { body: out };
}

function filterBetas(header) {
  if (!header) return '';
  return header.split(',').map((b) => b.trim()).filter((b) => BETAS.has(b)).join(',');
}

function upstreamMessage(text) {
  try {
    return JSON.parse(text)?.error?.message || '';
  } catch {
    return '';
  }
}

/** Map an upstream failure to what the app should see. Our own key or billing problems never leak as "your" problem. */
function upstreamFailure(vendor, status, text, headers, log) {
  const { error, final } = errorsFor(vendor);
  const message = upstreamMessage(text);
  const name = vendor === 'openai' ? 'OpenAI' : 'Anthropic';
  if (status === 401 || status === 403) {
    log(`[gateway] ${name} rejected the server's API key (${status}): ${message}`);
    return final(503, 'api_error', 'Impulse AI is temporarily unavailable. Try again later.');
  }
  if (status === 429) {
    // OpenAI answers 429 for its own quota too: that is our account, not the user's.
    if (vendor === 'openai' && /insufficient_quota|billing|exceeded your current quota/i.test(`${text}`)) {
      log(`[gateway] OpenAI quota or billing problem on the server's account: ${message}`);
      return final(503, 'api_error', 'Impulse AI is temporarily unavailable. Try again later.');
    }
    const retry = headers.get('retry-after');
    return error(429, 'rate_limit_error', 'The AI service is busy right now. Trying again in a moment.', retry ? { 'retry-after': retry } : {});
  }
  if (status === 529) return error(529, 'overloaded_error', 'The AI service is overloaded. Trying again in a moment.');
  if (status >= 500) return error(502, 'api_error', 'The AI service had a problem. Try again.');
  return error(status, 'invalid_request_error', message || 'The AI service rejected the request.');
}

/** Reads usage out of an Anthropic event stream as it passes through. */
export class UsageMeter {
  constructor() {
    this.decoder = new TextDecoder();
    this.buffer = '';
    this.model = null;
    this.served = null;
    this.usage = {};
    this.stopReason = null;
    this.streamedChars = 0;
    this.sawDelta = false;
  }

  feed(chunk) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (line.startsWith('data:')) this.line(line.slice(5).trim());
    }
    // A single line this long isn't usage; stop holding it.
    if (this.buffer.length > 2_000_000) this.buffer = '';
  }

  line(data) {
    if (!data.startsWith('{')) return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (event.type === 'message_start') {
      this.model = event.message?.model || this.model;
      Object.assign(this.usage, event.message?.usage || {});
    } else if (event.type === 'message_delta') {
      // message_delta usage is cumulative: later values replace earlier ones.
      if (event.usage) Object.assign(this.usage, event.usage);
      if (event.delta?.stop_reason) this.stopReason = event.delta.stop_reason;
      this.sawDelta = true;
    } else if (event.type === 'content_block_start' && event.content_block?.type === 'fallback') {
      this.served = event.content_block.to?.model || this.served;
    } else if (event.type === 'content_block_delta') {
      const d = event.delta || {};
      this.streamedChars += (d.text || d.partial_json || d.thinking || '').length;
    }
  }

  /** Usage to bill. Cut short before the final count: estimate output from what streamed. */
  final() {
    if (this.sawDelta) return this.usage;
    return { ...this.usage, output_tokens: Math.max(this.usage.output_tokens || 0, Math.ceil(this.streamedChars / 4)) };
  }

  refused() {
    return this.stopReason === 'refusal';
  }
}

/**
 * Reads usage out of an OpenAI Responses stream. The count comes once, in the
 * terminal event (response.completed, .incomplete or .failed), so a stream cut
 * short is billed from an estimate: the prompt as sent, the output as streamed.
 */
export class OpenAIUsageMeter {
  constructor({ promptEstimate = 0 } = {}) {
    this.decoder = new TextDecoder();
    this.buffer = '';
    this.model = null;
    this.usage = null;
    this.status = null;
    this.incompleteReason = null;
    this.streamedChars = 0;
    this.promptEstimate = promptEstimate;
  }

  feed(chunk) {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (line.startsWith('data:')) this.line(line.slice(5).trim());
    }
    if (this.buffer.length > 2_000_000) this.buffer = '';
  }

  line(data) {
    if (!data.startsWith('{')) return; // "[DONE]" and comments
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    const type = String(event.type || '');
    if (type === 'response.output_text.delta' || type === 'response.function_call_arguments.delta') {
      this.streamedChars += String(event.delta || '').length;
    } else if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      const r = event.response || {};
      if (r.usage) this.usage = r.usage;
      if (r.model) this.model = r.model;
      this.status = r.status || type.split('.').pop();
      this.incompleteReason = r.incomplete_details?.reason || null;
    }
  }

  final() {
    if (this.usage) return this.usage;
    return { input_tokens: this.promptEstimate, input_tokens_details: { cached_tokens: 0 }, output_tokens: Math.ceil(this.streamedChars / 4) };
  }

  refused() {
    return this.incompleteReason === 'content_filter';
  }
}

/** Roughly how many tokens a request's prompt is. Handles both lanes: Anthropic messages+system, OpenAI instructions+input. */
function estimatePromptTokens(body) {
  try {
    const parts = body.messages
      ? { messages: body.messages, system: body.system }
      : { instructions: body.instructions || '', input: body.input };
    return Math.ceil(JSON.stringify({ ...parts, tools: body.tools || [] }).length / 4);
  } catch {
    return 0;
  }
}

/**
 * The most output tokens this request may run with so its worst case (the
 * prompt plus that many output tokens, at this model's rates) costs no more
 * than the user's balance plus one period's allowance. This bounds a single
 * request's overdraft to one refill however large a max_tokens it asked for;
 * settle still charges the real, smaller usage. Returns a token count to cap
 * max_tokens with, never below 1.
 * ponytail: base output rate, no long-context or fallback premium — a cap, not
 * a charge, so a small over-estimate of headroom is fine; settle is exact.
 */
function affordableOutput(model, account, plan, settings, body) {
  const rate = MODELS[model]?.output || 0;
  if (rate <= 0) return settings.maxOutputTokens;
  const budgetMc = spendable(account) + (plan.monthlyCredits || 0) * MC;
  const promptMicros = costMicros(model, null, { input_tokens: estimatePromptTokens(body) });
  const outputMicros = Math.max(0, microsFor(budgetMc, settings) - promptMicros);
  return Math.max(1, Math.floor(outputMicros / rate));
}

/**
 * @param {{ pool, auth, settings, budget, config, background: (p: Promise<unknown>) => void, log?: Function, fetch?: typeof fetch }} deps
 * @returns {{ messages: (request: Request) => Promise<Response>, responses: (request: Request) => Promise<Response> }}
 */
export function createGateway(deps) {
  const { pool, auth, settings, budget, config } = deps;
  const log = deps.log || ((m) => console.error(m));
  const upstreamFetch = deps.fetch || fetch;
  const userKey = (id) => createHmac('sha256', config.secret).update(`anthropic-user:${id}`).digest('hex').slice(0, 32);

  async function insertPending(userId, model, client, taskId = null) {
    const { rows } = await pool.query(
      `insert into usage_event (user_id, model, status, client, task_id) values ($1, $2, 'pending', $3, $4) returning id`,
      [userId, model, client, taskId],
    );
    return rows[0].id;
  }

  async function settle({ usageId, userId, model, served, usage, status, httpStatus, started, requestId }) {
    try {
      const s = await settings.get();
      const micros = usage ? costMicros(model, served, usage) : 0;
      budget.add(micros);
      const mc = toMillicredits(micros, s);
      const t = totalTokens(usage || {});
      await pool.query(
        `update usage_event set status = $2, served_model = $3, input_tokens = $4, output_tokens = $5,
           cache_read_tokens = $6, cache_write_tokens = $7, cost_micros = $8, credits_charged = $9,
           http_status = $10, duration_ms = $11, request_id = $12
         where id = $1`,
        [usageId, status, served || null, t.input, t.output, t.cacheRead, t.cacheWrite, micros, mc, httpStatus,
          Date.now() - started, requestId || null],
      );
      if (mc > 0) await charge(pool, userId, mc, { usageId, note: MODELS[model]?.name || model });
    } catch (error) {
      log(`[gateway] could not record usage ${usageId}: ${error?.message || error}`);
    }
  }

  /**
   * Everything a request must pass before anything is forwarded. The same for
   * both lanes; only the error shape differs.
   * @returns {Promise<{ error: Response } | { user, s, body, model, started, taskId, client }>}
   */
  async function admit(request, vendor) {
    const { error, final } = errorsFor(vendor);
    const started = Date.now();
    const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
    if (!session?.user) return { error: final(401, 'authentication_error', 'Sign in to Impulse to use AI.') };
    const user = session.user;
    if (user.banned) return { error: final(403, 'permission_error', 'This account is suspended. Contact Impulse support if you think this is a mistake.') };
    if (!user.emailVerified) return { error: final(403, 'permission_error', 'Verify your email address to start using your credits.') };

    const s = await settings.get();
    if (s.maintenance) return { error: final(503, 'overloaded_error', 'Impulse AI is down for maintenance. Try again soon.') };

    const raw = await readLimited(request, MAX_BODY_BYTES);
    if (raw === null) return { error: final(413, 'request_too_large', 'This conversation is too long to send. Start a new chat.') };
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return { error: final(400, 'invalid_request_error', 'The request body is not valid JSON.') };
    }
    const model = body?.model;
    if (!MODELS[model] || !s.enabledModels.includes(model)) {
      return { error: final(400, 'invalid_request_error', 'That model is not available on Impulse. Pick another in the model menu.') };
    }
    if (MODELS[model].vendor !== vendor) {
      return { error: final(400, 'invalid_request_error', `${MODELS[model].name} is not served on this endpoint.`) };
    }
    if (!config[vendor]?.apiKey) return { error: final(503, 'api_error', 'Impulse AI is not set up for this model on this server yet.') };

    const account = await getAccount(pool, user.id, s);
    const plan = s.plans[account.plan] || s.plans.free;
    if (!plan.models.includes(model)) {
      const needed = cheapestPlanWith(s, model);
      return { error: final(403, 'permission_error', `${MODELS[model].name} is part of the ${s.plans[needed]?.name || 'Pro'} plan. Upgrade, or pick another model.`) };
    }
    if (spendable(account) < MIN_TO_START) {
      return { error: final(402, 'insufficient_credits', 'You are out of credits for this month. Upgrade for more, or wait for your monthly refill.') };
    }
    if (!(await allowRequest(pool, user.id, s.rateLimitPerMinute))) {
      return { error: error(429, 'rate_limit_error', 'Too many requests at once. Trying again in a moment.', { 'retry-after': '20' }) };
    }
    if (await budget.exceeded(s.dailyBudgetUsd)) {
      log('[gateway] daily budget reached; refusing AI requests until tomorrow (UTC)');
      return { error: final(503, 'overloaded_error', 'Impulse AI is at capacity for today. Try again tomorrow.') };
    }
    const taskId = (request.headers.get('x-impulse-task') || '').slice(0, 64) || null;
    return {
      user, s, body, model, started,
      maxOutputCap: affordableOutput(model, account, plan, s, body),
      taskId: /^[\w.-]+$/.test(taskId || '') ? taskId : null,
      client: (request.headers.get('x-impulse-client') || '').slice(0, 80) || null,
    };
  }

  /**
   * Forward a sanitised request and stream it back, charging from the meter.
   * @param {{ vendor, admitted, out, url, headers, meter, usageId, requestIdHeader }} lane
   */
  async function forward({ vendor, admitted, out, url, headers, meter, usageId, requestIdHeader }) {
    const { error } = errorsFor(vendor);
    const { user, model, started } = admitted;
    const abort = new AbortController();
    let upstream;
    try {
      upstream = await upstreamFetch(url, { method: 'POST', headers, body: JSON.stringify(out), signal: abort.signal });
    } catch (err) {
      log(`[gateway] could not reach ${vendor}: ${err?.message || err}`);
      await settle({ usageId, userId: user.id, model, status: 'error', httpStatus: 502, started });
      return error(502, 'api_error', 'Could not reach the AI service. Try again.');
    }
    const requestId = upstream.headers.get(requestIdHeader);

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      await settle({ usageId, userId: user.id, model, status: 'error', httpStatus: upstream.status, started, requestId });
      return upstreamFailure(vendor, upstream.status, text, upstream.headers, log);
    }

    if (!out.stream) {
      const json = await upstream.json();
      const refused = vendor === 'openai' ? json.incomplete_details?.reason === 'content_filter' : json.stop_reason === 'refusal';
      await settle({
        usageId, userId: user.id, model, served: json.model, usage: json.usage,
        status: refused ? 'refused' : 'ok', httpStatus: 200, started, requestId,
      });
      return Response.json(json, { headers: requestId ? { [requestIdHeader]: requestId } : {} });
    }

    const reader = upstream.body.getReader();
    let settled = null;
    const settleOnce = (status) => {
      settled ??= settle({
        usageId, userId: user.id, model, served: meter.served || meter.model, usage: meter.final(),
        status: status === 'ok' && meter.refused() ? 'refused' : status,
        httpStatus: 200, started, requestId,
      });
      return settled;
    };

    const stream = new ReadableStream({
      async pull(controller) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (err) {
          await settleOnce('error');
          controller.error(err);
          return;
        }
        if (chunk.done) {
          // Charge before the last byte, so serverless hosts don't freeze us mid-write.
          await settleOnce('ok');
          controller.close();
          return;
        }
        meter.feed(chunk.value);
        controller.enqueue(chunk.value);
      },
      cancel() {
        // The app stopped (Stop button, closed window): stop paying for output.
        abort.abort();
        reader.cancel().catch(() => {});
        deps.background(settleOnce('aborted'));
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        ...(requestId ? { [requestIdHeader]: requestId } : {}),
      },
    });
  }

  /** The Anthropic lane. @param {Request} request */
  async function messages(request) {
    const admitted = await admit(request, 'anthropic');
    if (admitted.error) return admitted.error;
    const { user, s, body, model, taskId, client } = admitted;
    const clean = sanitize(body, s, userKey(user.id));
    if (clean.error) return clean.error;
    const out = clean.body;
    // Cap output to what the balance (plus one refill) can afford, so one request
    // can't overdraft past a period whatever max_tokens it asked for.
    out.max_tokens = Math.min(out.max_tokens, admitted.maxOutputCap);
    const beta = new URL(request.url).searchParams.get('beta') === 'true';
    const betas = filterBetas(request.headers.get('anthropic-beta'));
    const usageId = await insertPending(user.id, model, client, taskId);
    return forward({
      vendor: 'anthropic', admitted, out, usageId,
      url: `${config.anthropic.baseURL}/v1/messages${beta ? '?beta=true' : ''}`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.anthropic.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        ...(betas ? { 'anthropic-beta': betas } : {}),
      },
      meter: new UsageMeter(),
      requestIdHeader: 'request-id',
    });
  }

  /** The OpenAI lane (the Responses API). @param {Request} request */
  async function responses(request) {
    const admitted = await admit(request, 'openai');
    if (admitted.error) return admitted.error;
    const { user, s, body, model, taskId, client } = admitted;
    const clean = sanitizeOpenAI(body, s, userKey(user.id));
    if (clean.error) return clean.error;
    const out = clean.body;
    out.max_output_tokens = Math.min(out.max_output_tokens, admitted.maxOutputCap);
    const usageId = await insertPending(user.id, model, client, taskId);
    return forward({
      vendor: 'openai', admitted, out, usageId,
      url: `${config.openai.baseURL}/v1/responses`,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.openai.apiKey}`,
      },
      meter: new OpenAIUsageMeter({ promptEstimate: estimatePromptTokens(out) }),
      requestIdHeader: 'x-request-id',
    });
  }

  return { messages, responses };
}
