const OpenAIProvider = require('../openaiProvider');

const TOOLS = [{ name: 'compile_sketch', description: 'Compile', parameters: { type: 'object', properties: {} } }];

/** A fake Responses API: one answer per call, an event stream unless told otherwise. */
function fakeFetch(answers) {
  const calls = [];
  const fetchImpl = jest.fn(async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer.status && answer.status !== 200) {
      return new Response(JSON.stringify(answer.json || { error: { message: answer.message || 'nope' } }), {
        status: answer.status, headers: { 'content-type': 'application/json', ...(answer.headers || {}) },
      });
    }
    if (answer.json) return new Response(JSON.stringify(answer.json), { status: 200, headers: { 'content-type': 'application/json' } });
    const text = answer.events.map((e) => (typeof e === 'string' ? `${e}\n\n` : `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)).join('');
    return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  return { fetchImpl, calls };
}

const message = (text) => ({ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAA…' };
const call = (callId, name, args) => ({ type: 'function_call', id: 'fc_1', call_id: callId, name, arguments: args, status: 'completed' });
const completed = (output, usage = { input_tokens: 1200, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 80, output_tokens_details: { reasoning_tokens: 30 } }) => ({
  type: 'response.completed', response: { id: 'resp_1', object: 'response', model: 'gpt-5.4-2026-03-05', status: 'completed', output, usage },
});

beforeAll(() => { OpenAIProvider.sleep = async () => {}; });

describe('building a request', () => {
  const provider = new OpenAIProvider('sk-test', 'gpt-5.4');

  it('turns system turns into instructions, replays its own output items, and makes tool results outputs', () => {
    const { instructions, input } = provider.buildInput([
      { role: 'system', content: 'Rules.' },
      { role: 'system', content: '[BOARD FACTS] pins 0–21.' },
      { role: 'user', content: 'Blink' },
      { role: 'assistant', content: null, rawContent: [reasoning, call('call_1', 'edit_code', '{"a":1}')], tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'edit_code', arguments: '{"a":1}' } }] },
      { role: 'tool', tool_call_id: 'call_1', name: 'edit_code', is_error: false, content: '{"ok":true}' },
      { role: 'assistant', content: 'Done.' },
    ]);
    expect(instructions).toBe('Rules.\n[BOARD FACTS] pins 0–21.');
    expect(input).toEqual([
      { role: 'user', content: 'Blink' },
      reasoning,
      call('call_1', 'edit_code', '{"a":1}'),
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
      { role: 'assistant', content: 'Done.' },
    ]);
  });

  it('rebuilds function calls from a turn that has no raw items (another provider\'s turn)', () => {
    const { input } = provider.buildInput([
      { role: 'assistant', content: 'Compiling.', tool_calls: [{ id: 'c9', type: 'function', function: { name: 'compile_sketch', arguments: { board: 'uno' } } }] },
    ]);
    expect(input).toEqual([
      { role: 'assistant', content: 'Compiling.' },
      { type: 'function_call', call_id: 'c9', name: 'compile_sketch', arguments: '{"board":"uno"}' },
    ]);
  });

  it('asks for reasoning, caps the output, keeps nothing upstream, and never sends temperature to a reasoning model', () => {
    const request = provider.buildRequest([{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }], { tools: TOOLS, effort: 'high', max_tokens: 200000, temperature: 0.7 });
    expect(request).toMatchObject({
      model: 'gpt-5.4', instructions: 'Be brief.', max_output_tokens: 128000, stream: true, store: false,
      include: ['reasoning.encrypted_content'], reasoning: { effort: 'high' },
    });
    expect(request.temperature).toBeUndefined();
    expect(request.tools).toEqual([{ type: 'function', name: 'compile_sketch', description: 'Compile', parameters: TOOLS[0].parameters }]);
    expect(provider.buildRequest([{ role: 'user', content: 'hi' }], { tools: [] }).tools).toBeUndefined();
    expect(provider.buildRequest([{ role: 'user', content: 'hi' }], { tools: [] }).reasoning).toEqual({ effort: 'medium' });
  });

  it('knows an API key when it sees one', () => {
    expect(provider.validateApiKey('sk-proj-abc')).toBe(true);
    expect(provider.validateApiKey('nope')).toBe(false);
    expect(provider.getAvailableModels()[0]).toBe('gpt-5.4');
  });
});

describe('a streamed answer', () => {
  it('is assembled from the terminal event: text, tool calls, usage, model, and the items to replay', async () => {
    const output = [reasoning, message('Compiling now.'), call('call_9', 'compile_sketch', '{"board":"uno"}')];
    const { fetchImpl, calls } = fakeFetch([{
      events: [
        { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } },
        { type: 'response.output_text.delta', output_index: 1, delta: 'Compiling ' },
        { type: 'response.output_text.delta', output_index: 1, delta: 'now.' },
        { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"board":' },
        completed(output),
      ],
    }]);
    const provider = new OpenAIProvider('sk-test', 'gpt-5.4', { fetch: fetchImpl, headers: { 'x-impulse-client': 'Impulse IDE/2.0' } });
    const result = await provider.chat([{ role: 'user', content: 'Compile it' }], { tools: TOOLS, taskId: 't_abc' });
    expect(result).toEqual({
      content: 'Compiling now.',
      toolCalls: [{ id: 'call_9', name: 'compile_sketch', arguments: { board: 'uno' } }],
      rawContent: output,
      stopReason: 'tool_calls',
      usage: { inputTokens: 1200, outputTokens: 80 },
      model: 'gpt-5.4-2026-03-05',
    });
    expect(calls[0].url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0].init.headers).toMatchObject({ authorization: 'Bearer sk-test', 'x-impulse-task': 't_abc', 'x-impulse-client': 'Impulse IDE/2.0' });
  });

  it('keeps no raw items for a plain answer, so the history stays small', async () => {
    const { fetchImpl } = fakeFetch([{ events: [completed([message('Done.')])] }]);
    const provider = new OpenAIProvider('sk-test', 'gpt-5.4', { fetch: fetchImpl });
    const result = await provider.chat([{ role: 'user', content: 'x' }], { tools: [] });
    expect(result).toMatchObject({ content: 'Done.', toolCalls: [], rawContent: null, stopReason: 'stop' });
  });

  it('drops a tool call that was cut off by the output limit and says so', async () => {
    const { fetchImpl } = fakeFetch([{
      events: [{
        type: 'response.incomplete',
        response: { id: 'r', model: 'gpt-5.4-2026-03-05', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [message('Let me '), call('c1', 'edit_code', '{"code":"void lo')], usage: { input_tokens: 10, output_tokens: 5 } },
      }],
    }]);
    const provider = new OpenAIProvider('sk-test', 'gpt-5.4', { fetch: fetchImpl });
    const result = await provider.chat([{ role: 'user', content: 'x' }], { tools: TOOLS });
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe('max_output_tokens');
    expect(result.content).toMatch(/^Let me \n\nThe response hit the output limit/);
  });

  it('reads a plain JSON response too', async () => {
    const { fetchImpl } = fakeFetch([{ json: { id: 'r', model: 'gpt-5.4-2026-03-05', status: 'completed', output: [message('Done.')], usage: { input_tokens: 10, output_tokens: 2 } } }]);
    const provider = new OpenAIProvider('sk-test', 'gpt-5.4', { fetch: fetchImpl });
    const result = await provider.chat([{ role: 'user', content: 'x' }], { tools: [] });
    expect(result).toMatchObject({ content: 'Done.', toolCalls: [], stopReason: 'stop', usage: { inputTokens: 10, outputTokens: 2 } });
  });

  it('turns a failed response into an error the person can read', async () => {
    const { fetchImpl } = fakeFetch([{ events: [{ type: 'response.failed', response: { id: 'r', status: 'failed', error: { code: 'server_error', message: 'The model had a problem.' } } }] }]);
    const provider = new OpenAIProvider('sk-test', 'gpt-5.4', { fetch: fetchImpl });
    await expect(provider.chat([{ role: 'user', content: 'x' }], { tools: [] })).rejects.toThrow(/The model could not answer: The model had a problem\./);
  });

  it('says when the stream ended without an answer', async () => {
    const { fetchImpl } = fakeFetch([{ events: [{ type: 'response.created', response: { id: 'r', status: 'in_progress', output: [] } }] }]);
    const provider = new OpenAIProvider('sk-test', 'gpt-5.4', { fetch: fetchImpl });
    await expect(provider.chat([{ role: 'user', content: 'x' }], { tools: [] })).rejects.toThrow(/ended before it was complete/);
  });
});

describe('errors', () => {
  it('names a rejected key and does not retry it', async () => {
    const { fetchImpl } = fakeFetch([{ status: 401, json: { error: { message: 'Incorrect API key provided' } } }]);
    const provider = new OpenAIProvider('sk-test', 'gpt-5.4', { fetch: fetchImpl });
    await expect(provider.chat([{ role: 'user', content: 'x' }], { tools: [] })).rejects.toMatchObject({
      message: 'The OpenAI API key was rejected.', cause: { status: 401, error: { error: { message: 'Incorrect API key provided' } } },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a 500 once and then succeeds', async () => {
    const { fetchImpl } = fakeFetch([
      { status: 500, json: { error: { message: 'boom' } } },
      { events: [completed([message('ok')])] },
    ]);
    const provider = new OpenAIProvider('sk-test', 'gpt-5.4', { fetch: fetchImpl });
    const result = await provider.chat([{ role: 'user', content: 'x' }], { tools: [] });
    expect(result.content).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('honours x-should-retry: false', async () => {
    const { fetchImpl } = fakeFetch([{ status: 503, headers: { 'x-should-retry': 'false' }, json: { error: { message: 'Impulse AI is down for maintenance.' } } }]);
    const provider = new OpenAIProvider('sk-test', 'gpt-5.4', { fetch: fetchImpl });
    await expect(provider.chat([{ role: 'user', content: 'x' }], { tools: [] })).rejects.toMatchObject({ cause: { status: 503 } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('says the service could not be reached after the retries', async () => {
    const fetchImpl = jest.fn(async () => { throw new TypeError('fetch failed'); });
    const provider = new OpenAIProvider('sk-test', 'gpt-5.4', { fetch: fetchImpl });
    await expect(provider.chat([{ role: 'user', content: 'x' }], { tools: [] })).rejects.toMatchObject({ cause: { offline: true } });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
