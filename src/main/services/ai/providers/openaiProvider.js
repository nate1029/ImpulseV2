/**
 * OpenAI's Responses API, streamed and assembled into the one answer the agent
 * loop expects: text, tool calls with parsed arguments, the stop reason, usage
 * and the model that answered. Plain fetch, no SDK: the API is small, and the
 * Impulse lane only changes the address and the credential.
 *
 * The Responses API is the one that runs function tools together with
 * reasoning (Chat Completions refuses that pairing on the GPT-5 family). A
 * turn's reasoning survives its tool steps because the encrypted reasoning
 * items come back with the answer and are replayed with the function calls.
 * @module main/services/ai/providers/openaiProvider
 */
const BaseProvider = require('./baseProvider');
const { getAllTools } = require('../tools/toolSchema');

// Per-model request rules. The GPT-5 family reasons before it answers:
// `reasoning.effort` sets how much (its default is too little for an agent),
// temperature is not accepted while it reasons, and max_output_tokens caps
// reasoning and answer together.
const MODEL_RULES = {
  'gpt-5.4': { reasoning: true, maxOutput: 128000 },
  'gpt-5.5': { reasoning: true, maxOutput: 128000 },
  'gpt-5.4-mini': { reasoning: true, maxOutput: 128000 },
  'gpt-5.4-nano': { reasoning: true, maxOutput: 128000 },
};

const DEFAULT_MAX_TOKENS = 32000;
const EFFORT = { low: 'low', medium: 'medium', high: 'high' };
const RETRIES = 2;
const TERMINAL = new Set(['response.completed', 'response.incomplete', 'response.failed']);

class OpenAIProvider extends BaseProvider {
  static DEFAULT_MODEL = 'gpt-5.4';
  /** The pause between retries (tests make it instant). */
  static sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * @param {string} apiKey  the bearer credential (an API key, or a session token through Impulse)
   * @param {string|null} model
   * @param {{ baseURL?: string, headers?: Record<string, string>, fetch?: typeof fetch }} [options]
   */
  constructor(apiKey, model = null, { baseURL = 'https://api.openai.com', headers = {}, fetch: fetchImpl = null } = {}) {
    super(apiKey, model || OpenAIProvider.DEFAULT_MODEL);
    this.name = 'openai';
    this.baseURL = String(baseURL || '').replace(/\/+$/, '');
    this.headers = headers;
    this.fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  }

  getAvailableModels() {
    // Newest / recommended first: index 0 is what auto-upgrade picks.
    return Object.keys(MODEL_RULES);
  }

  rules() {
    return MODEL_RULES[this.model] || { reasoning: true, maxOutput: 128000 };
  }

  formatTools(tools) {
    return tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters }));
  }

  /**
   * The agent's provider-neutral messages → Responses input. System turns
   * become the instructions; an assistant turn this provider produced carries
   * `rawContent` (the exact output items, reasoning included) and is replayed
   * unchanged, so the tool loop stays append-only; each tool result is a
   * function_call_output item.
   * @returns {{ instructions: string|undefined, input: object[] }}
   */
  buildInput(messages) {
    const input = [];
    let instructions = '';
    for (const msg of messages) {
      if (msg.role === 'system') {
        instructions += `${msg.content}\n`;
        continue;
      }
      if (msg.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id,
          output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        });
        continue;
      }
      if (msg.role === 'assistant') {
        if (Array.isArray(msg.rawContent) && msg.rawContent.length) {
          input.push(...msg.rawContent);
          continue;
        }
        if (typeof msg.content === 'string' && msg.content) input.push({ role: 'assistant', content: msg.content });
        for (const tc of msg.tool_calls || []) {
          const raw = tc.function?.arguments ?? tc.arguments ?? {};
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function?.name || tc.name,
            arguments: typeof raw === 'string' ? raw : JSON.stringify(raw),
          });
        }
        continue;
      }
      input.push({ role: 'user', content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
    }
    return { instructions: instructions.trim() || undefined, input };
  }

  buildRequest(messages, options = {}) {
    const rules = this.rules();
    const tools = options.tools !== undefined ? options.tools : getAllTools();
    const requested = options.max_tokens || DEFAULT_MAX_TOKENS;
    const { instructions, input } = this.buildInput(messages);
    const request = {
      model: this.model,
      input,
      max_output_tokens: Math.min(requested, rules.maxOutput),
      stream: true,
      // Nothing is kept upstream; the reasoning comes back encrypted so the
      // next tool step can carry it.
      store: false,
      include: ['reasoning.encrypted_content'],
    };
    if (instructions) request.instructions = instructions;
    if (Array.isArray(tools) && tools.length) request.tools = this.formatTools(tools);
    if (rules.reasoning) request.reasoning = { effort: EFFORT[options.effort] || 'medium' };
    else if (typeof options.temperature === 'number') request.temperature = options.temperature;
    return request;
  }

  async chat(messages, options = {}) {
    const request = this.buildRequest(messages, options);
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}`, ...this.headers };
    // The task id lets the gateway add up what one user message cost across its model calls.
    if (options.taskId && /^[\w.-]{1,64}$/.test(options.taskId)) headers['x-impulse-task'] = options.taskId;
    const response = await this._send(request, headers, options.signal);
    const streamed = /text\/event-stream/i.test(response.headers.get('content-type') || '');
    const state = streamed ? await this._readStream(response) : { response: await response.json(), failed: null };
    return this._finish(state);
  }

  /** POST with a couple of retries on 429 and 5xx, unless the server says not to. */
  async _send(request, headers, signal) {
    let attempt = 0;
    for (;;) {
      let response;
      try {
        response = await this.fetch(`${this.baseURL}/v1/responses`, {
          method: 'POST', headers, body: JSON.stringify(request), signal,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (attempt < RETRIES) {
          attempt++;
          await OpenAIProvider.sleep(500 * attempt);
          continue;
        }
        throw Object.assign(new Error('Could not reach the AI service. Check your internet connection.'), { cause: { offline: true, error } });
      }
      if (response.ok) return response;
      const text = await response.text().catch(() => '');
      let body = null;
      try {
        body = JSON.parse(text);
      } catch { /* not JSON */ }
      const retryable = (response.status === 429 || response.status >= 500) && response.headers.get('x-should-retry') !== 'false';
      if (retryable && attempt < RETRIES && !signal?.aborted) {
        attempt++;
        const after = Number(response.headers.get('retry-after'));
        await OpenAIProvider.sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 20) * 1000 : 800 * attempt);
        continue;
      }
      const error = new Error(OpenAIProvider.describeError(response.status, body));
      error.cause = { status: response.status, error: body };
      throw error;
    }
  }

  /**
   * The stream's terminal event carries the whole response (output items,
   * usage, model), so that is what is kept; the deltas on the way are for
   * display, which the agent loop does not do yet.
   */
  async _readStream(response) {
    const state = { response: null, failed: null };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const takeLine = (line) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data.startsWith('{')) return;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        return;
      }
      const type = String(event.type || '');
      if (TERMINAL.has(type)) {
        state.response = event.response || null;
        if (type === 'response.failed') state.failed = event.response?.error || { message: 'The model could not answer.' };
      } else if (type === 'error') {
        state.failed = { message: event.message || event.error?.message || 'The model could not answer.', code: event.code || event.error?.code };
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        takeLine(buffer.slice(0, nl).replace(/\r$/, ''));
        buffer = buffer.slice(nl + 1);
      }
    }
    if (buffer.trim()) takeLine(buffer.trim());
    return state;
  }

  _finish(state) {
    if (state.failed) {
      const error = new Error(`The model could not answer: ${state.failed.message || 'unknown error'}`);
      error.cause = { status: 502, error: { error: state.failed } };
      throw error;
    }
    const r = state.response;
    if (!r || typeof r !== 'object') throw new Error('The answer ended before it was complete. Try again.');
    const output = Array.isArray(r.output) ? r.output : [];
    let text = output
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content || [])
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text || '')
      .join('');
    let toolCalls = this.parseToolCalls(output);
    const reason = r.status === 'completed' ? null : (r.incomplete_details?.reason || r.status || 'incomplete');
    let notice = null;
    if (reason === 'max_output_tokens') {
      // A tool call cut off mid-arguments would run with a partial argument.
      toolCalls = [];
      notice = 'The response hit the output limit and was cut off. Ask for a shorter or more focused answer.';
    } else if (reason === 'content_filter') {
      toolCalls = [];
      notice = 'The model declined this request. Try rephrasing it, or switch to another model.';
    } else if (reason) {
      toolCalls = [];
      notice = `The answer was cut short (${reason}). Try again.`;
    }
    if (notice) text = text ? `${text}\n\n${notice}` : notice;
    return {
      content: text,
      toolCalls,
      // Replayed as the assistant turn, reasoning included, so the next tool
      // step continues the same train of thought.
      rawContent: toolCalls.length ? output : null,
      stopReason: reason || (toolCalls.length ? 'tool_calls' : 'stop'),
      usage: {
        inputTokens: r.usage?.input_tokens ?? 0,
        outputTokens: r.usage?.output_tokens ?? 0,
      },
      model: r.model || null,
    };
  }

  parseToolCalls(output) {
    return output
      .filter((item) => item.type === 'function_call' && item.name)
      .map((item, i) => {
        let args = {};
        try {
          args = JSON.parse(item.arguments || '{}');
        } catch {
          args = {};
        }
        return { id: item.call_id || item.id || `call_${i}`, name: item.name, arguments: args && typeof args === 'object' ? args : {} };
      });
  }

  static describeError(status, body) {
    const message = body?.error?.message || '';
    if (status === 401) return 'The OpenAI API key was rejected.';
    if (status === 403) return 'This OpenAI account cannot use that model.';
    if (status === 404) return 'That OpenAI model is not available. Pick another model.';
    if (status === 429) return message || 'Rate limited by OpenAI. Wait a moment and try again.';
    if (status === 400) return `OpenAI rejected the request: ${message || 'bad request'}`;
    if (status >= 500) return 'OpenAI is having trouble right now. Try again shortly.';
    return message || `OpenAI API error ${status}`;
  }

  validateApiKey(apiKey) {
    return super.validateApiKey(apiKey) && /^sk-/.test(apiKey);
  }
}

module.exports = OpenAIProvider;
