import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readAll, setup, startFakeAnthropic, startFakeOpenAI } from './helpers.js';

const MESSAGE = { model: 'claude-opus-5-5', max_tokens: 32000, messages: [{ role: 'user', content: 'Blink an LED' }] };

describe('AI gateway', () => {
  let t;
  let fake;
  let token;
  let userId;

  let fakeOpenAI;

  before(async () => {
    fake = await startFakeAnthropic();
    fakeOpenAI = await startFakeOpenAI();
    t = await setup({ fake, fakeOpenAI });
    ({ token, user: { id: userId } } = await t.signUp('maker@impulse.test'));
  });
  after(async () => {
    await t.close();
    await fake.close();
    await fakeOpenAI.close();
  });
  beforeEach(async () => {
    fake.reply = null;
    fake.calls.length = 0;
    fakeOpenAI.reply = null;
    fakeOpenAI.calls.length = 0;
    await t.pool.query(`delete from app_setting`);
    t.settings.invalidate();
    await t.pool.query(`update credit_account set plan = 'free', plan_credits = 100000, bonus_credits = 200000 where user_id = $1`, [userId]);
    await t.pool.query(`update "user" set banned = false where id = $1`, [userId]);
    await t.pool.query(`delete from rate_bucket`);
  });

  const send = (body = MESSAGE, headers = {}) => t.request('/ai/v1/messages?beta=true', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...t.bearer(token), ...headers },
    body: JSON.stringify(body),
  });
  const balance = async () => (await t.pool.query('select plan_credits, bonus_credits from credit_account where user_id = $1', [userId])).rows[0];
  const lastUsage = async () => (await t.pool.query('select * from usage_event where user_id = $1 order by id desc limit 1', [userId])).rows[0];

  test('streams the answer through unchanged and charges what it cost', async () => {
    const res = await send({ ...MESSAGE, stream: true }, { 'x-impulse-task': 't_abc123_xyz' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const text = await readAll(res);
    assert.match(text, /event: message_start/);
    assert.match(text, /from the fake API\./);
    assert.match(text, /event: message_stop/);

    // 1200 in x $4 + 8000 cached x $0.20 + 500 written x $5 + 300 out x $20 = $0.0149 = 1.49 credits.
    const usage = await lastUsage();
    assert.equal(usage.status, 'ok');
    assert.equal(usage.cost_micros, 14900);
    assert.equal(usage.credits_charged, 1490);
    assert.equal(usage.output_tokens, 300);
    assert.equal(usage.request_id, 'req_test');
    assert.equal(usage.task_id, 't_abc123_xyz', 'the app\'s task id is kept so cost per task is one query');
    const b = await balance();
    assert.equal(b.plan_credits, 100000 - 1490, 'plan credits are spent first');
    assert.equal(b.bonus_credits, 200000);
  });

  test('a non-streaming request is charged too', async () => {
    const res = await send(MESSAGE);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).content[0].text, 'Hello from the fake API.');
    assert.equal((await lastUsage()).credits_charged, 1490);
  });

  test('forwards only safe fields, with our key, an opaque user id and a capped max_tokens', async () => {
    await send({ ...MESSAGE, max_tokens: 500000, speed: 'fast', container: 'x', metadata: { user_id: 'spoofed' }, stream: true }, {
      'anthropic-beta': 'server-side-fallback-2026-07-01, fast-mode-2026-02-01',
    }).then(readAll);
    const call = fake.calls.at(-1);
    assert.equal(call.headers['x-api-key'], 'test-anthropic-key');
    assert.equal(call.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
    assert.equal(call.url, '/v1/messages?beta=true');
    assert.equal(call.body.max_tokens, 32000);
    assert.equal(call.body.speed, undefined);
    assert.equal(call.body.container, undefined);
    assert.match(call.body.metadata.user_id, /^[0-9a-f]{32}$/);
    assert.notEqual(call.body.metadata.user_id, userId);
  });

  test('server-side tools are refused', async () => {
    const res = await send({ ...MESSAGE, tools: [{ type: 'web_search_20260209', name: 'web_search' }] });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /isn't available/);
    assert.equal(fake.calls.length, 0);
  });

  test('models must be enabled and on the plan', async () => {
    const unknown = await send({ ...MESSAGE, model: 'gpt-5' });
    assert.equal(unknown.status, 400);
    const fable = await send({ ...MESSAGE, model: 'claude-fable-5-1' });
    assert.equal(fable.status, 403);
    assert.match((await fable.json()).error.message, /Pro plan/);
    assert.equal(fake.calls.length, 0);
  });

  test('out of credits answers 402 and does not call upstream', async () => {
    await t.pool.query('update credit_account set plan_credits = 0, bonus_credits = 500 where user_id = $1', [userId]);
    const res = await send();
    assert.equal(res.status, 402);
    assert.equal(res.headers.get('x-should-retry'), 'false');
    assert.equal((await res.json()).error.type, 'insufficient_credits');
    assert.equal(fake.calls.length, 0);
  });

  test('a request that costs more than is left runs the plan into debt, repaid next month', async () => {
    await t.pool.query('update credit_account set plan_credits = 1000, bonus_credits = 200 where user_id = $1', [userId]);
    await readAll(await send({ ...MESSAGE, stream: true }));
    const b = await balance();
    assert.equal(b.bonus_credits, 0);
    assert.equal(b.plan_credits, 1000 + 200 - 1490);
  });

  test('a low balance clamps max_tokens so one request cannot overdraft past a refill', async () => {
    // 1 credit left, nothing in bonus; the request asks for a full 32,000 tokens.
    await t.pool.query('update credit_account set plan_credits = 1000, bonus_credits = 0 where user_id = $1', [userId]);
    await readAll(await send({ ...MESSAGE, max_tokens: 32000, stream: true }));
    const call = fake.calls.at(-1);
    // Headroom = 1 credit + one free refill (25 credits) = 260,000 micro-USD.
    // The forwarded max_tokens, at Opus's $20/MTok output rate, must fit inside it.
    assert.ok(call.body.max_tokens < 32000, `the asked-for 32000 was not clamped (got ${call.body.max_tokens})`);
    assert.ok(call.body.max_tokens * 20 <= 260000, `the cap ${call.body.max_tokens} exceeds the one-refill budget`);
    assert.ok(call.body.max_tokens >= 1);
  });

  test('suspended accounts are refused', async () => {
    await t.pool.query('update "user" set banned = true where id = $1', [userId]);
    const res = await send();
    assert.equal(res.status, 403);
  });

  test('the per-minute rate limit applies', async () => {
    await t.settings.update({ rateLimitPerMinute: 2 }, null);
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    const third = await send();
    assert.equal(third.status, 429);
    assert.equal(third.headers.get('retry-after'), '20');
  });

  test('maintenance mode stops AI without calling upstream', async () => {
    await t.settings.update({ maintenance: true }, null);
    const res = await send();
    assert.equal(res.status, 503);
    assert.equal(fake.calls.length, 0);
  });

  test('our key being rejected upstream is not reported as the user\'s fault', async () => {
    fake.reply = () => ({ status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
    const res = await send();
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('x-should-retry'), 'false');
    assert.doesNotMatch((await res.json()).error.message, /key/i);
    const usage = await lastUsage();
    assert.equal(usage.status, 'error');
    assert.equal(usage.credits_charged, 0);
  });

  test('a stopped stream is charged for what it used, not left pending', async () => {
    fake.reply = () => ({
      events: [
        { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 1000, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x'.repeat(400) } },
        'hang',
      ],
    });
    const res = await send({ ...MESSAGE, stream: true });
    const reader = res.body.getReader();
    let seen = '';
    while (!seen.includes('content_block_delta')) {
      const { done, value } = await reader.read();
      assert.ok(!done, `the stream ended early: ${seen}`);
      seen += new TextDecoder().decode(value);
    }
    await reader.cancel();
    await t.settleBackground();
    const usage = await lastUsage();
    assert.equal(usage.status, 'aborted');
    // 1000 in x $4 + an estimated 100 out (400 characters / 4) x $20 = 6000 micro-USD.
    assert.equal(usage.cost_micros, 6000);
    assert.equal(usage.credits_charged, 600);
  });

  test('refusal fallbacks are billed per attempt at each model\'s rates', async () => {
    fake.reply = () => ({
      events: [
        { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 1000, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {
            output_tokens: 200,
            iterations: [
              { type: 'message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 50 },
              { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 1000, output_tokens: 200 },
            ],
          },
        },
        { type: 'message_stop' },
      ],
    });
    await readAll(await send({ ...MESSAGE, stream: true }));
    const usage = await lastUsage();
    // Opus 5.5: 1000 x 4 + 50 x 20 = 5000; Opus 5: 1000 x 5 + 200 x 25 = 10000.
    assert.equal(usage.cost_micros, 15000);
    assert.equal(usage.served_model, 'claude-opus-5');
    assert.equal(usage.input_tokens, 2000);
  });

  test('the daily budget stops AI once reached', async () => {
    await t.settings.update({ dailyBudgetUsd: 0.000001 }, null);
    // The budget reads a cached total; the earlier tests already spent more than this.
    const res = await send();
    assert.equal(res.status, 503);
    assert.match((await res.json()).error.message, /capacity/);
  });

  test('a model of the other vendor is refused on this lane, before anything is forwarded', async () => {
    const res = await send({ ...MESSAGE, model: 'gpt-5.4' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /not served on this endpoint/);
    assert.equal(fake.calls.length, 0);
  });

  test('the catalog lists the models this server can serve, with their vendor and the default', async () => {
    const res = await t.request('/v1/models', { headers: t.bearer(token) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.defaultModel, 'gpt-5.4');
    const gpt = body.models.find((m) => m.id === 'gpt-5.4');
    assert.deepEqual({ vendor: gpt.vendor, allowed: gpt.allowed, isDefault: gpt.isDefault, cost: gpt.cost }, { vendor: 'openai', allowed: true, isDefault: true, cost: 1 });
    assert.equal(body.models.find((m) => m.id === 'claude-opus-5-5').vendor, 'anthropic');
    assert.equal(body.models.find((m) => m.id === 'claude-fable-5-1').allowed, false, 'Fable is a Pro model');
  });

  test('a vendor without a key on this server is not offered, and its lane answers 503', async () => {
    const key = t.config.openai.apiKey;
    t.config.openai.apiKey = '';
    try {
      const body = await (await t.request('/v1/models', { headers: t.bearer(token) })).json();
      assert.ok(body.models.every((m) => m.vendor === 'anthropic'), 'no OpenAI model is listed');
      assert.equal(body.defaultModel, 'claude-opus-5-5', 'the default falls back to a model that can be served');
      const res = await t.request('/ai/openai/v1/responses', {
        method: 'POST', headers: { 'content-type': 'application/json', ...t.bearer(token) },
        body: JSON.stringify({ model: 'gpt-5.4', input: [{ role: 'user', content: 'hi' }] }),
      });
      assert.equal(res.status, 503);
      assert.equal(fakeOpenAI.calls.length, 0);
    } finally {
      t.config.openai.apiKey = key;
    }
  });

  test('without a session the gateway answers 401 in Anthropic\'s error shape', async () => {
    const res = await t.request('/ai/v1/messages', { method: 'POST', body: JSON.stringify(MESSAGE), headers: { 'content-type': 'application/json' } });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.type, 'error');
    assert.equal(body.error.type, 'authentication_error');
  });
});

describe('AI gateway: the OpenAI lane', () => {
  let t;
  let fake;
  let fakeOpenAI;
  let token;
  let userId;

  before(async () => {
    fake = await startFakeAnthropic();
    fakeOpenAI = await startFakeOpenAI();
    t = await setup({ fake, fakeOpenAI });
    ({ token, user: { id: userId } } = await t.signUp('builder@impulse.test'));
  });
  after(async () => {
    await t.close();
    await fake.close();
    await fakeOpenAI.close();
  });
  beforeEach(async () => {
    fakeOpenAI.reply = null;
    fakeOpenAI.calls.length = 0;
    await t.pool.query(`delete from app_setting`);
    t.settings.invalidate();
    await t.pool.query(`update credit_account set plan = 'free', plan_credits = 100000, bonus_credits = 200000 where user_id = $1`, [userId]);
    await t.pool.query(`delete from rate_bucket`);
  });

  const CHAT = { model: 'gpt-5.4', max_output_tokens: 32000, input: [{ role: 'user', content: 'Blink an LED' }], instructions: 'Be brief.' };
  const send = (body = CHAT, headers = {}) => t.request('/ai/openai/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...t.bearer(token), ...headers },
    body: JSON.stringify(body),
  });
  const balance = async () => (await t.pool.query('select plan_credits, bonus_credits from credit_account where user_id = $1', [userId])).rows[0];
  const lastUsage = async () => (await t.pool.query('select * from usage_event where user_id = $1 order by id desc limit 1', [userId])).rows[0];

  test('streams the answer through unchanged and charges what it cost', async () => {
    const res = await send({ ...CHAT, stream: true }, { 'x-impulse-task': 't_openai_1' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    assert.equal(res.headers.get('x-request-id'), 'req_openai_test');
    const text = await readAll(res);
    assert.match(text, /from the fake API\./);
    assert.match(text, /event: response\.completed/);

    // 10,000 input tokens of which 8,000 cached, 300 out (100 of them reasoning), on GPT-5.4:
    // 2,000 x $2.50 + 8,000 x $0.25 + 300 x $15 = $0.0115 = 1.15 credits.
    const usage = await lastUsage();
    assert.equal(usage.status, 'ok');
    assert.equal(usage.cost_micros, 11500);
    assert.equal(usage.credits_charged, 1150);
    assert.equal(usage.input_tokens, 2000);
    assert.equal(usage.cache_read_tokens, 8000);
    assert.equal(usage.output_tokens, 300);
    assert.equal(usage.served_model, 'gpt-5.4-2026-03-05');
    assert.equal(usage.request_id, 'req_openai_test');
    assert.equal(usage.task_id, 't_openai_1');
    const b = await balance();
    assert.equal(b.plan_credits, 100000 - 1150);
  });

  test('a non-streaming request is charged too', async () => {
    const res = await send(CHAT);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).output[0].content[0].text, 'Hello from the fake API.');
    assert.equal((await lastUsage()).credits_charged, 1150);
  });

  test('forwards only safe fields, with our key, our identifiers, and nothing kept or run upstream', async () => {
    await send({
      ...CHAT, stream: true, store: true, background: true, user: 'spoofed', safety_identifier: 'spoofed', prompt_cache_key: 'spoofed',
      max_output_tokens: 500000, service_tier: 'priority', include: ['reasoning.encrypted_content', 'file_search_call.results'],
      reasoning: { effort: 'high' }, tools: [{ type: 'function', name: 'compile_sketch', parameters: { type: 'object' } }],
    }).then(readAll);
    const call = fakeOpenAI.calls.at(-1);
    assert.equal(call.url, '/v1/responses');
    assert.equal(call.headers.authorization, 'Bearer test-openai-key');
    assert.equal(call.body.background, undefined);
    assert.equal(call.body.service_tier, undefined);
    assert.equal(call.body.user, undefined);
    assert.equal(call.body.store, false);
    assert.equal(call.body.max_output_tokens, 32000);
    assert.deepEqual(call.body.include, ['reasoning.encrypted_content']);
    assert.deepEqual(call.body.reasoning, { effort: 'high' });
    assert.equal(call.body.instructions, 'Be brief.');
    assert.match(call.body.safety_identifier, /^[0-9a-f]{32}$/);
    assert.notEqual(call.body.safety_identifier, userId);
    assert.equal(call.body.prompt_cache_key, call.body.safety_identifier);
  });

  test('tools other than functions, and server-side conversation state, are refused', async () => {
    const res = await send({ ...CHAT, tools: [{ type: 'web_search' }] });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /isn't available/);
    const previous = await send({ ...CHAT, previous_response_id: 'resp_123' });
    assert.equal(previous.status, 400);
    assert.match((await previous.json()).error.message, /no conversation state upstream/);
    assert.equal(fakeOpenAI.calls.length, 0);
  });

  test('a Claude model is refused on this lane', async () => {
    const res = await send({ ...CHAT, model: 'claude-opus-5-5' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'invalid_request_error');
    assert.match(body.error.message, /not served on this endpoint/);
  });

  test('errors come in OpenAI\'s shape, with Impulse\'s reason as the code', async () => {
    await t.pool.query('update credit_account set plan_credits = 0, bonus_credits = 500 where user_id = $1', [userId]);
    const res = await send();
    assert.equal(res.status, 402);
    assert.equal(res.headers.get('x-should-retry'), 'false');
    const body = await res.json();
    assert.equal(body.error.type, 'insufficient_quota');
    assert.equal(body.error.code, 'insufficient_credits');
    assert.equal(fakeOpenAI.calls.length, 0);
  });

  test('our key being rejected upstream is not reported as the user\'s fault', async () => {
    fakeOpenAI.reply = () => ({ status: 401, json: { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } } });
    const res = await send();
    assert.equal(res.status, 503);
    assert.doesNotMatch((await res.json()).error.message, /key/i);
    assert.equal((await lastUsage()).status, 'error');
  });

  test('OpenAI\'s own quota problem is ours, not the user\'s', async () => {
    fakeOpenAI.reply = () => ({ status: 429, json: { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } } });
    const res = await send();
    assert.equal(res.status, 503);
    assert.match(t.logs.at(-1), /quota or billing/);
  });

  test('a filtered answer is recorded as refused', async () => {
    fakeOpenAI.reply = () => ({
      events: [
        { type: 'response.created', response: { id: 'r', status: 'in_progress', model: 'gpt-5.4-2026-03-05', output: [] } },
        {
          type: 'response.incomplete',
          response: { id: 'r', status: 'incomplete', incomplete_details: { reason: 'content_filter' }, model: 'gpt-5.4-2026-03-05', output: [], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5 } },
        },
      ],
    });
    await readAll(await send({ ...CHAT, stream: true }));
    const usage = await lastUsage();
    assert.equal(usage.status, 'refused');
    assert.equal(usage.cost_micros, 100 * 2.5 + 5 * 15);
  });

  test('a stopped stream is charged from an estimate, not left pending', async () => {
    fakeOpenAI.reply = () => ({
      events: [
        { type: 'response.created', response: { id: 'r', status: 'in_progress', model: 'gpt-5.4-2026-03-05', output: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'x'.repeat(400) },
        'hang',
      ],
    });
    const res = await send({ ...CHAT, stream: true });
    const reader = res.body.getReader();
    let seen = '';
    while (!seen.includes('xxxx')) {
      const { done, value } = await reader.read();
      assert.ok(!done, `the stream ended early: ${seen}`);
      seen += new TextDecoder().decode(value);
    }
    await reader.cancel();
    await t.settleBackground();
    const usage = await lastUsage();
    assert.equal(usage.status, 'aborted');
    // The prompt as sent (JSON length / 4) at $2.50, plus 100 estimated output tokens at $15.
    const promptEstimate = Math.ceil(JSON.stringify({ instructions: CHAT.instructions, input: CHAT.input, tools: [] }).length / 4);
    assert.equal(usage.cost_micros, Math.ceil(promptEstimate * 2.5 + 100 * 15));
    assert.equal(usage.input_tokens, promptEstimate);
  });

  test('without a session the lane answers 401 in OpenAI\'s error shape', async () => {
    const res = await t.request('/ai/openai/v1/responses', { method: 'POST', body: JSON.stringify(CHAT), headers: { 'content-type': 'application/json' } });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.type, 'authentication_error');
    assert.equal(body.error.code, 'authentication_error');
  });
});

describe('routing: one Impulse AI, the server picks the model', () => {
  let t;
  let fake;
  let fakeOpenAI;
  let token;
  let userId;

  before(async () => {
    fake = await startFakeAnthropic();
    fakeOpenAI = await startFakeOpenAI();
    t = await setup({ fake, fakeOpenAI });
    ({ token, user: { id: userId } } = await t.signUp('router@impulse.test'));
  });
  after(async () => {
    await t.close();
    await fake.close();
    await fakeOpenAI.close();
  });
  beforeEach(async () => {
    await t.pool.query(`delete from app_setting`);
    t.settings.invalidate();
    await t.pool.query(`update credit_account set plan = 'free' where user_id = $1`, [userId]);
  });

  const route = (body) => t.request('/v1/route', { method: 'POST', headers: { 'content-type': 'application/json', ...t.bearer(token) }, body: JSON.stringify(body) }).then((r) => r.json());

  test('each kind of work gets its model, cheapest where it can be', async () => {
    assert.equal((await route({ kind: 'agent' })).model, 'gpt-5.4');
    assert.equal((await route({ kind: 'ask' })).model, 'gpt-5.4-mini');
    assert.equal((await route({ kind: 'summary' })).model, 'gpt-5.4-nano');
    const r = await route({});
    assert.deepEqual({ model: r.model, vendor: r.vendor, kind: r.kind }, { model: 'gpt-5.4', vendor: 'openai', kind: 'agent' });
    assert.ok(r.ttlSeconds >= 60);
  });

  test('a turn that already failed climbs the escalation ladder, and stays at the top', async () => {
    assert.equal((await route({ kind: 'agent', escalate: 1 })).model, 'gpt-5.5');
    assert.equal((await route({ kind: 'agent', escalate: 3 })).model, 'gpt-5.5');
  });

  test('a model the plan does not allow is never chosen', async () => {
    await t.settings.update({ plans: { ...t.settings.cached?.plans || (await t.settings.get()).plans, free: { ...(await t.settings.get()).plans.free, models: ['gpt-5.4-mini', 'gpt-5.4-nano'] } } }, null);
    assert.equal((await route({ kind: 'agent' })).model, 'gpt-5.4-mini', 'falls to the first model the plan allows');
    assert.equal((await route({ kind: 'agent', escalate: 1 })).model, 'gpt-5.4-mini', 'no ladder step is allowed either');
  });

  test('the admin can change the table, within known models', async () => {
    const res = await t.request('/admin/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json', ...t.bearer(token) }, body: JSON.stringify({ routing: { agent: 'gpt-5.5', plan: 'gpt-5.4', debug: 'gpt-5.4', ask: 'gpt-5.4-nano', summary: 'gpt-5.4-nano', escalation: [] } }) });
    // Not an admin: refused; the validation itself is checked through the store.
    assert.equal(res.status, 403);
    const bad = await import('../src/settings.js').then((m) => m.validateSettings({ routing: { agent: 'nope', plan: 'gpt-5.4', debug: 'gpt-5.4', ask: 'gpt-5.4', summary: 'gpt-5.4', escalation: [] } }));
    assert.equal(bad.ok, false);
    const good = await import('../src/settings.js').then((m) => m.validateSettings({ routing: { agent: 'gpt-5.5', plan: 'gpt-5.4', debug: 'gpt-5.4', ask: 'gpt-5.4-nano', summary: 'gpt-5.4-nano', escalation: ['gpt-5.5', 'gpt-5.5'] } }));
    assert.equal(good.ok, true);
    assert.deepEqual(good.value.routing.escalation, ['gpt-5.5']);
  });

  test('without a vendor key for the chosen models, the next servable one answers', async () => {
    const key = t.config.openai.apiKey;
    t.config.openai.apiKey = '';
    try {
      const r = await route({ kind: 'agent' });
      assert.equal(r.vendor, 'anthropic');
      assert.equal(r.model, 'claude-opus-5-5');
    } finally {
      t.config.openai.apiKey = key;
    }
  });
});
