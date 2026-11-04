const { Anthropic } = require('@anthropic-ai/sdk');
const BaseProvider = require('./baseProvider');
const { getAllTools } = require('../tools/toolSchema');

function getToolsForOptions(options) {
  if (options.tools !== undefined) return options.tools;
  return getAllTools();
}

// Per-model request rules. Current models reject `temperature` and
// `budget_tokens`; thinking is adaptive and depth is set with `effort`.
const MODEL_RULES = {
  'claude-opus-5-5': { effort: true, sampling: false, fallbacks: true },
  'claude-sonnet-5-5': { effort: true, sampling: false, fallbacks: true },
  'claude-fable-5-1': { effort: true, sampling: false, fallbacks: true },
  // No server-side refusal fallback exists for Haiku 5.5.
  'claude-haiku-5-5': { effort: true, sampling: false, fallbacks: false },
  'claude-haiku-4-5': { effort: false, sampling: true, fallbacks: false },
};

// Thinking tokens count against max_tokens, so small caller budgets would
// truncate the visible answer on thinking models.
const MIN_THINKING_MAX_TOKENS = 16000;
const DEFAULT_MAX_TOKENS = 32000;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

class ClaudeProvider extends BaseProvider {
  static DEFAULT_MODEL = 'claude-opus-5-5';

  constructor(apiKey, model = null) {
    const effectiveModel = model || ClaudeProvider.DEFAULT_MODEL;
    super(apiKey, effectiveModel);
    this.name = 'claude';
    this.client = new Anthropic({ apiKey: this.apiKey, maxRetries: 2 });
  }

  getAvailableModels() {
    // Newest / recommended first: index 0 is what auto-upgrade picks.
    return Object.keys(MODEL_RULES);
  }

  rules() {
    return MODEL_RULES[this.model] || { effort: false, sampling: true, fallbacks: false };
  }

  formatTools(tools) {
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
      // Streamed so large inputs (whole sketches) arrive progressively; the
      // tool executor validates every input against its schema before running.
      eager_input_streaming: true
    }));
  }

  /**
   * Convert the agent's provider-neutral messages into Claude messages.
   * Assistant turns produced by this provider carry `rawContent` (the exact
   * blocks Claude returned, including thinking) and are replayed unchanged so
   * the tool loop stays append-only.
   */
  buildMessages(messages) {
    let systemMessage = '';
    const out = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessage += msg.content + '\n';
        continue;
      }

      if (msg.role === 'tool') {
        const block = {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        };
        if (msg.is_error) block.is_error = true;
        // All results for one assistant turn go in a single user message.
        const prev = out[out.length - 1];
        if (prev && prev.role === 'user' && Array.isArray(prev.content) && prev.content.every(b => b.type === 'tool_result')) {
          prev.content.push(block);
        } else {
          out.push({ role: 'user', content: [block] });
        }
        continue;
      }

      if (msg.role === 'assistant') {
        if (Array.isArray(msg.rawContent) && msg.rawContent.length > 0) {
          out.push({ role: 'assistant', content: msg.rawContent });
          continue;
        }
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const blocks = [];
          if (msg.content) blocks.push({ type: 'text', text: msg.content });
          for (const tc of msg.tool_calls) {
            const raw = tc.function?.arguments ?? tc.arguments;
            let input = {};
            if (typeof raw === 'string') {
              try { input = JSON.parse(raw || '{}'); } catch { input = {}; }
            } else if (raw && typeof raw === 'object') {
              input = raw;
            }
            blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name || tc.name, input });
          }
          out.push({ role: 'assistant', content: blocks });
        } else if (msg.content) {
          out.push({ role: 'assistant', content: msg.content });
        }
        continue;
      }

      out.push({ role: 'user', content: msg.content });
    }

    return { system: systemMessage.trim() || undefined, messages: out };
  }

  /**
   * After a mid-output fallback, blocks before the last `fallback` marker that
   * belong to the declined model must not be echoed back (only text survives).
   */
  static replayableContent(content) {
    const lastFallback = content.map(b => b.type).lastIndexOf('fallback');
    if (lastFallback === -1) return content;
    return content.filter((b, i) => i > lastFallback || b.type === 'text');
  }

  buildRequest(messages, options) {
    const rules = this.rules();
    const tools = getToolsForOptions(options);
    const useTools = Array.isArray(tools) && tools.length > 0;
    const { system, messages: claudeMessages } = this.buildMessages(messages);

    const requested = options.max_tokens || DEFAULT_MAX_TOKENS;
    const request = {
      model: this.model,
      max_tokens: rules.effort ? Math.max(requested, MIN_THINKING_MAX_TOKENS) : Math.min(requested, 64000),
      messages: claudeMessages,
      // The agent resends the whole conversation on every tool step: cache it
      // (reads cost a tenth or less of fresh input).
      cache_control: { type: 'ephemeral' }
    };
    if (system) request.system = system;
    if (useTools) request.tools = this.formatTools(tools);
    if (rules.sampling && typeof options.temperature === 'number') request.temperature = options.temperature;
    if (rules.effort) request.output_config = { effort: options.effort || 'high' };
    if (rules.fallbacks) {
      request.betas = [FALLBACK_BETA];
      request.fallbacks = 'default';
    }
    return request;
  }

  async chat(messages, options = {}) {
    const request = this.buildRequest(messages, options);
    let response;
    try {
      // The task id lets the gateway add up what one user message cost across its model calls.
      const requestOptions = {};
      if (options.signal) requestOptions.signal = options.signal;
      if (options.taskId && /^[\w.-]{1,64}$/.test(options.taskId)) requestOptions.headers = { 'x-impulse-task': options.taskId };
      const stream = request.betas
        ? this.client.beta.messages.stream(request, requestOptions)
        : this.client.messages.stream(request, requestOptions);
      response = await stream.finalMessage();
    } catch (error) {
      throw new Error(ClaudeProvider.describeError(error), { cause: error });
    }

    let text = '';
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
    }

    let toolCalls = this.parseToolCalls(response);
    let notice = null;

    if (response.stop_reason === 'refusal') {
      toolCalls = [];
      const category = response.stop_details?.category;
      notice = `The model declined this request${category ? ` (${category})` : ''}. Try rephrasing it, or switch to another model.`;
    } else if (response.stop_reason === 'max_tokens') {
      // A tool_use block cut off mid-input would run with a partial argument.
      toolCalls = [];
      notice = 'The response hit the output limit and was cut off. Ask for a shorter or more focused answer.';
    }

    if (notice) text = text ? `${text}\n\n${notice}` : notice;

    return {
      content: text,
      toolCalls,
      rawContent: ClaudeProvider.replayableContent(response.content),
      stopReason: response.stop_reason,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0
      },
      model: response.model
    };
  }

  parseToolCalls(response) {
    return response.content
      .filter(block => block.type === 'tool_use')
      .map(block => ({ id: block.id, name: block.name, arguments: block.input }));
  }

  static describeError(error) {
    if (error instanceof Anthropic.AuthenticationError) return 'Your Anthropic API key was rejected. Check it in API Keys.';
    if (error instanceof Anthropic.PermissionDeniedError) return 'Your Anthropic account does not have access to this model.';
    if (error instanceof Anthropic.NotFoundError) return 'This Claude model is not available on your account. Pick another model.';
    if (error instanceof Anthropic.RateLimitError) return 'Rate limited by Anthropic. Wait a moment and try again.';
    if (error instanceof Anthropic.BadRequestError) return `Claude rejected the request: ${error.message}`;
    if (error instanceof Anthropic.InternalServerError) return 'Anthropic is having trouble right now (server error). Try again shortly.';
    if (error instanceof Anthropic.APIConnectionError) return 'Could not reach Anthropic. Check your internet connection.';
    if (error instanceof Anthropic.APIError) return `Claude API error ${error.status ?? ''}: ${error.message}`.trim();
    return error?.message || 'Unknown error calling Claude';
  }

  validateApiKey(apiKey) {
    return super.validateApiKey(apiKey) && apiKey.startsWith('sk-ant-');
  }
}

module.exports = ClaudeProvider;
