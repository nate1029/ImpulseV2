const { getSystemPrompt } = require('./prompts/systemPrompt');
const { circuitBlock } = require('./knowledge/circuitFacts');
const { componentFacts } = require('./knowledge/components');
const { namedBoardFacts } = require('./knowledge/boardRecords');
const ToolExecutor = require('./tools/toolExecutor');
const SimpleMemory = require('./memory/simpleMemory');
const { getCoreTools, getDebugTools, getPlanTools, getPackTools } = require('./tools/toolSchema');
const ImpulseProvider = require('./providers/impulseProvider');
const ImpulseOpenAIProvider = require('./providers/impulseOpenAIProvider');
const cloudModels = require('./providers/cloudModels');

/** Providers that run locally and need no API key. */

/**
 * AI Agent
 * Main orchestrator for AI-powered Arduino development assistance
 */
/** Tools that change the sketch: after one of them the sketch must compile before the turn ends. */
const CODE_EDIT_TOOLS = new Set(['set_editor_code', 'edit_code', 'replace_in_code']);

/** What a failed verify compile tells the model: the error, the first diagnostic, known fixes. */
function verifySummary(check) {
  const lines = [check.error || 'Compilation failed'];
  if (check.excerpt) lines.push(check.excerpt);
  for (const d of (check.diagnostics || []).slice(0, 5)) lines.push(`${String(d.file || '').split(/[\\/]/).pop()}:${d.line}: ${d.level}: ${d.message}`);
  if (check.knownFixes?.local?.length || check.knownFixes?.shared?.length) lines.push(`knownFixes: ${JSON.stringify(check.knownFixes).slice(0, 1500)}`);
  return lines.join('\n');
}

/** Titles of the error decoder's rules that were applied, for the answer. */
function autoFixTitles(ids) {
  const { RULES } = require('./knowledge/errorDecoder');
  const { RULES: LINT } = require('./knowledge/linter');
  return [...new Set(ids)].map((id) => {
    const rule = RULES.find((r) => r.id === id);
    if (typeof rule?.title === 'string') return rule.title;
    const lintRule = LINT.find((r) => r.id === id);
    return lintRule ? lintRule.message.replace(/\.$/, '') : id;
  }).join('; ');
}

function safeJson(text) {
  try { return JSON.parse(text) || {}; } catch { return {}; }
}

class AIAgent {
  constructor(arduinoService, serialMonitor, errorMemory, config = {}) {
    this.arduinoService = arduinoService;
    this.serialMonitor = serialMonitor;
    this.errorMemory = errorMemory;
    
    // Initialize simple JSON-based memory (no SQLite dependency)
    this.memory = new SimpleMemory();

    // Initialize tool executor
    this.toolExecutor = new ToolExecutor(
      arduinoService,
      serialMonitor,
      errorMemory,
      this.memory
    );
    
    // Provider management
    this.providers = new Map();
    this.currentProvider = null;
    /** Extra constructor options per provider, e.g. { impulse: { version } }. */
    this.providerOptions = {};
    /** Set by the main process: asks Impulse Cloud which model answers a kind of work. */
    this.router = null;
    /** Set by the main process: the account's session token, or null when signed out. */
    this.credential = null;
    this._routeCache = new Map();
    this.config = {
      // Model calls per turn. A build-and-upload job takes 8–12 (write, compile,
      // simulator check, upload, read the board…); the cap only stops runaways.
      maxIterations: config.maxIterations || 24,
      temperature: config.temperature || 0.7,
      ...config
    };
    
    // Conversation history with sliding window to prevent unbounded growth
    this.conversationHistory = [];
    this.maxHistoryMessages = 40; // ~20 user + 20 assistant turns
  }

  /**
   * Register a provider
   */
  registerProvider(name, provider) {
    this.providers.set(name, provider);
  }

  /**
   * Set current provider
   */
  setProvider(providerName, apiKey, model = null) {
    if (!this.providers.has(providerName)) {
      throw new Error(`Provider ${providerName} not registered`);
    }

    const ProviderClass = this.providers.get(providerName);
    const provider = new ProviderClass(apiKey, model, this.providerOptions[providerName]);
    
    if (!provider.validateApiKey(apiKey)) {
      throw new Error(`Invalid API key for provider ${providerName}`);
    }

    this.currentProvider = provider;
    return provider;
  }

  /**
   * The agent runs through Impulse Cloud (the account's credits), on one of
   * two lanes: OpenAI models and Claude models. Both take the session token.
   */
  initializeProviders() {
    this.providers.set('impulse-openai', ImpulseOpenAIProvider);
    this.providers.set('impulse', ImpulseProvider);
  }

  /** The providers that run through Impulse Cloud on the account's credits. */
  static CLOUD_PROVIDERS = ['impulse-openai', 'impulse'];

  /**
   * Model ID to provider name (for API key lookup and setProvider)
   */
  static getProviderFromModel(modelId) {
    if (!modelId || typeof modelId !== 'string') return null;
    const id = modelId.toLowerCase();
    if (ImpulseOpenAIProvider.isModelId(id)) return 'impulse-openai';
    if (ImpulseProvider.isModelId(id)) return 'impulse';
    return null;
  }

  /**
   * Which model answers this kind of work. The person sees one Impulse AI;
   * the server picks the cheapest model that does the job, and climbs its
   * escalation ladder when a turn has already failed. Cached per kind for the
   * time the server allows; null when the server cannot be asked.
   * @param {'agent'|'plan'|'debug'|'ask'|'summary'} kind
   * @param {{ escalate?: number }} [opts]
   * @returns {Promise<string|null>} an impulse: model id
   */
  async chooseModel(kind, { escalate = 0 } = {}) {
    const key = `${kind}:${escalate}`;
    const cached = this._routeCache.get(key);
    if (cached && cached.until > Date.now()) return cached.model;
    if (!this.router) return null;
    const res = await this.router({ kind, escalate }).catch(() => null);
    const bare = res?.ok ? res.data?.model : null;
    if (!bare) return null;
    const model = `${cloudModels.PREFIX}${bare}`;
    const ttl = Math.max(30, Number(res.data.ttlSeconds) || 300) * 1000;
    this._routeCache.set(key, { model, until: Date.now() + ttl });
    return model;
  }

  /** Forget what the server said (the account changed). */
  forgetRoutes() {
    this._routeCache.clear();
  }

  /**
   * Point the agent at a cloud model; its lane follows from the id. Throws
   * with code 'signed_out' when there is no session.
   */
  useModel(modelId) {
    const token = this.credential?.();
    if (!token) throw Object.assign(new Error('Sign in to Impulse to use AI.'), { code: 'signed_out' });
    const lane = AIAgent.getProviderFromModel(modelId);
    if (!lane) throw new Error(`Unknown model ${modelId}`);
    const current = this.currentProvider;
    if (current && current.name === lane && current.appModel === modelId && current.apiKey === token) return current;
    return this.setProvider(lane, token, modelId);
  }

  /**
   * Make sure a model can answer: the server's choice for agent work, or the
   * default lane when the server cannot be asked. Throws 'signed_out'.
   */
  async ready() {
    const model = (await this.chooseModel('agent')) || this.currentProvider?.appModel || cloudModels.DEFAULT_MODEL;
    return this.useModel(model);
  }

  /**
   * Get tools array for the given mode
   * @param {string} mode - 'agent' | 'plan' | 'ask' | 'debug'
   */
  _getToolsForMode(mode) {
    if (mode === 'ask') return [];
    if (mode === 'plan') return getPlanTools();
    if (mode === 'debug') return getDebugTools();
    // Agent mode starts with the standing set; load_tools adds a pack for the rest of the turn.
    return getCoreTools();
  }

  /**
   * Process a user query with optional tool use (mode-dependent)
   * @param {string} userQuery - User message
   * @param {Object} context - IDE context
   * @param {string} mode - 'agent' | 'ask' | 'debug'
   */
  /**
   * @param {{ onStep?: (step: { type: 'thinking' } | { type: 'tool', name: string }) => void, signal?: AbortSignal }} [hooks]
   *   onStep hears each model call and each tool before it runs (the chat shows them).
   *   signal stops the turn (the chat's Stop): the model call in flight is cancelled,
   *   no further tool runs, and the turn is dropped from the history.
   */
  async processQuery(userQuery, context = {}, mode = 'agent', { onStep, signal } = {}) {
    const step = (s) => { try { onStep?.(s); } catch { /* the UI's problem, not the query's */ } };
    // The model for this turn: the server's choice for this kind of work, a
    // step up the ladder when the caller says the previous try failed
    // (context.escalate), or whatever answered last time when offline.
    let escalation = Math.max(0, Math.min(3, Math.floor(Number(context.escalate) || 0)));
    const kind = ['plan', 'debug', 'ask'].includes(mode) ? mode : 'agent';
    if (this.router) {
      const routed = await this.chooseModel(kind, { escalate: escalation });
      if (routed) this.useModel(routed);
      else if (!this.currentProvider) this.useModel(cloudModels.DEFAULT_MODEL);
    } else if (!this.currentProvider) {
      // No cloud to ask (tests, tools): whatever provider was set answers.
      throw new Error('No provider selected. Please set a provider first.');
    }
    const climb = async () => {
      if (!this.router || escalation >= 3) return;
      escalation++;
      const up = await this.chooseModel(kind, { escalate: escalation });
      if (up) this.useModel(up);
    };
    const historyLength = this.conversationHistory.length;
    const stopIfAsked = () => {
      if (!signal?.aborted) return;
      this.conversationHistory.length = Math.min(this.conversationHistory.length, historyLength);
      const stopped = new Error('Stopped');
      stopped.stopped = true;
      throw stopped;
    };
    const ask = async (msgs, opts) => {
      stopIfAsked();
      try {
        return await this.currentProvider.chat(msgs, { ...opts, signal });
      } catch (error) {
        stopIfAsked();
        throw error;
      }
    };

    const toolsForMode = [...this._getToolsForMode(mode)];
    const useTools = Array.isArray(toolsForMode) && toolsForMode.length > 0;
    // One id per user message: every model call of this turn carries it, so the
    // gateway can add up what a task cost.
    const taskId = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    // Build user content: prepend IDE context when available
    const ctx = [];
    if (!context.hasFileOpen) {
      ctx.push('NO_FILE_OPEN');
    } else if (context.currentSketchPath) {
      ctx.push(`sketch=${context.currentSketchPath}`);
    }
    if (context.selectedBoard) ctx.push(`board=${context.selectedBoard}`);
    if (context.selectedPort) ctx.push(`port=${context.selectedPort}`);

    // Surface the most recent compilation result so the agent can see and act
    // on compile errors the user hit via the Verify button (not just via tools).
    let compileBlock = '';
    const lcr = context.lastCompileResult;
    if (lcr && typeof lcr === 'object') {
      if (lcr.success === false) {
        const details = (lcr.output && lcr.output.trim())
          || (Array.isArray(lcr.errors) && lcr.errors.join('\n'))
          || lcr.message
          || 'Compilation failed.';
        compileBlock = `\n\n[LAST COMPILE FAILED]\n${String(details).slice(0, 3000)}`;
      } else if (lcr.success === true) {
        ctx.push('lastCompile=success');
      }
    }

    const userContent = (ctx.length > 0
      ? `[IDE: ${ctx.join(', ')}]\n\n${userQuery}`
      : userQuery) + compileBlock;

    this.conversationHistory.push({
      role: 'user',
      content: userContent
    });

    // Trim history to sliding window to prevent unbounded token growth
    this._trimHistory();

    // The selected board's real facts go with every request (not into the
    // history), so even a model that never calls a tool writes for the right pins.
    let boardFacts = await this.boardFacts(context.selectedBoard);
    // Answers earlier in the conversation may be for another board.
    if (context.selectedBoard && this.lastBoard && this.lastBoard !== context.selectedBoard && this.conversationHistory.length > 1) {
      boardFacts = `${boardFacts || ''}\n[BOARD CHANGED] The selected board is now ${context.selectedBoard}; earlier messages in this conversation were about ${this.lastBoard}. Use the facts for the current board, not earlier answers.`.trim();
    }
    if (context.selectedBoard) this.lastBoard = context.selectedBoard;
    // The circuit on the simulator canvas goes with every request too, and a
    // note when it changed since earlier messages.
    const circuitHash = context.circuit?.hash ?? null;
    const circuitChanged = this.lastCircuitHash !== undefined && circuitHash !== this.lastCircuitHash && this.conversationHistory.length > 1;
    const circuitFacts = circuitBlock(context.circuit, { changed: circuitChanged });
    this.lastCircuitHash = circuitHash;
    // Parts the message names come with their wiring and a compiled sketch, so
    // the first answer is right without a tool round trip.
    const partFacts = mode === 'ask' ? null : componentFacts(userQuery, { fqbn: context.selectedBoard || '' });
    // A board the message names that is not the selected one ("my SuperMini" with the generic C3 selected).
    const namedBoard = namedBoardFacts(userQuery, { fqbn: context.selectedBoard || '' });
    const standing = [boardFacts, namedBoard, circuitFacts, partFacts].filter(Boolean).join('\n\n');
    const messages = [
      {
        role: 'system',
        content: standing ? `${getSystemPrompt(mode)}\n\n${standing}` : getSystemPrompt(mode)
      },
      ...this.conversationHistory
    ];

    const chatOptions = {
      temperature: this.config.temperature,
      max_tokens: this.config.max_tokens,
      effort: mode === 'ask' || mode === 'plan' ? 'medium' : 'high',
      tools: toolsForMode,
      taskId,
    };

    // Ask mode: single turn, no tools
    if (!useTools) {
      step({ type: 'thinking' });
      const response = await ask(messages, chatOptions);
      if (response.content) {
        this.conversationHistory.push({
          role: 'assistant',
          content: response.content
        });
      }
      return {
        response: response.content,
        toolResults: [],
        usage: response.usage,
        model: response.model
      };
    }

    let iteration = 0;
    const maxIterations = this.config.maxIterations;
    const toolResults = [];
    // The verify guard: code edited this turn must compile before the answer stands.
    let editedSinceCompile = false;
    let verifyRounds = 0;
    const autoFixed = []; // decoder rewrites applied without a model call

    while (iteration < maxIterations) {
      step({ type: 'thinking' });
      const response = await ask(messages, chatOptions);

      if (!response.toolCalls || response.toolCalls.length === 0) {
        // Before the model's "done" stands: an edited sketch that was not compiled since gets compiled now.
        if (mode === 'agent' && editedSinceCompile && verifyRounds < 2 && context.hasFileOpen !== false) {
          verifyRounds++;
          editedSinceCompile = false;
          step({ type: 'tool', name: 'compile_sketch' });
          let check = await this.toolExecutor.execute({ name: 'compile_sketch', arguments: {} });
          toolResults.push({ ...check, tool: 'compile_sketch', verify: true });
          // Errors with a proven mechanical fix are fixed without a model call, then compiled again.
          if (check && check.success === false && check.code !== 'BUSY') {
            const auto = await this.toolExecutor.applyKnownRewrite?.(check).catch(() => null);
            if (auto?.applied?.length) {
              step({ type: 'tool', name: 'compile_sketch' });
              check = await this.toolExecutor.execute({ name: 'compile_sketch', arguments: {} });
              toolResults.push({ ...check, tool: 'compile_sketch', verify: true, autoFixed: auto.applied });
              autoFixed.push(...auto.applied);
            }
          }
          if (check && check.success === false && check.code !== 'BUSY') {
            messages.push({ role: 'assistant', content: response.content || '' });
            messages.push({ role: 'user', content: `[VERIFY] The sketch you edited does not compile:\n${verifySummary(check)}\nFix it (knownFixes, if present, says what fixed this before), then tell the user what you changed.` });
            // The cheaper model did not get it right: the retry gets a stronger one.
            await climb();
            iteration++;
            continue;
          }
          // It compiles, which says nothing about whether the pins exist on
          // this board: a wrong GPIO compiles happily and fails on the bench.
          const pins = await this.toolExecutor.checkPins?.().catch(() => null);
          const pinErrors = (pins?.issues || []).filter((i) => i.level === 'error');
          if (pinErrors.length) {
            toolResults.push({ success: false, tool: 'check_pins', verify: true, issues: pins.issues });
            messages.push({ role: 'assistant', content: response.content || '' });
            messages.push({ role: 'user', content: `${pins.report}\nChange those pins to ones the board has, then tell the user what you changed and why.` });
            await climb();
            iteration++;
            continue;
          }
          if (pins?.issues?.length) response.content = `${response.content || ''}\n\n${pins.report}`.trim();
          // It compiles and the pins exist; the hardware linter knows what still fails on the bench.
          let linted = await this.toolExecutor.lintSketch?.(null, { built: true }).catch(() => null);
          let lintErrors = (linted?.findings || []).filter((f) => f.level === 'error');
          // Mechanical fixes first (a wait for a native-USB monitor…), then a fresh build and a fresh look.
          if (lintErrors.some((f) => f.canRewrite)) {
            const auto = await this.toolExecutor.applyLintFixes?.().catch(() => null);
            if (auto?.applied?.length) {
              step({ type: 'tool', name: 'compile_sketch' });
              const again = await this.toolExecutor.execute({ name: 'compile_sketch', arguments: {} });
              toolResults.push({ ...again, tool: 'compile_sketch', verify: true, autoFixed: auto.applied });
              if (again?.success) {
                autoFixed.push(...auto.applied);
                linted = await this.toolExecutor.lintSketch?.(null, { built: true }).catch(() => null);
                lintErrors = (linted?.findings || []).filter((f) => f.level === 'error');
              }
            }
          }
          if (lintErrors.length) {
            toolResults.push({ success: false, tool: 'lint', verify: true, findings: linted.findings });
            messages.push({ role: 'assistant', content: response.content || '' });
            messages.push({ role: 'user', content: `[LINT] The sketch compiles, but Impulse's hardware linter found what will fail on this board:\n${linted.report}\nFix these, then tell the user what you changed and why.` });
            await climb();
            iteration++;
            continue;
          }
          if (check && check.success && Array.isArray(check.summary) && check.summary.length) {
            response.content = `${response.content || ''}\n\n${check.summary[0]}`.trim();
          }
          if (autoFixed.length && check?.success) {
            response.content = `${response.content || ''}\n\nImpulse fixed this automatically: ${autoFixTitles(autoFixed)}.`.trim();
          }
        }
        if (response.content) {
          this.conversationHistory.push({
            role: 'assistant',
            content: response.content
          });
        }
        return {
          response: response.content,
          toolResults: toolResults,
          usage: response.usage,
          model: response.model,
          taskId,
        };
      }

      const assistantMsg = {
        role: 'assistant',
        content: response.content || null,
        rawContent: response.rawContent,
        tool_calls: response.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: typeof tc.arguments === 'string'
              ? tc.arguments
              : JSON.stringify(tc.arguments || {})
          }
        }))
      };
      messages.push(assistantMsg);

      for (const toolCall of response.toolCalls) {
        stopIfAsked();
        step({ type: 'tool', name: String(toolCall.name || '') });
        const startTime = Date.now();
        let result;
        if (toolCall.name === 'load_tools') {
          // A pack joins the request's tools for the rest of the turn.
          const args = typeof toolCall.arguments === 'string' ? safeJson(toolCall.arguments) : (toolCall.arguments || {});
          const pack = String(args.pack || '');
          const extra = getPackTools(pack).filter((t) => !chatOptions.tools.some((x) => x.name === t.name));
          chatOptions.tools = [...chatOptions.tools, ...extra];
          result = extra.length
            ? { success: true, tool: 'load_tools', loaded: extra.map((t) => t.name), note: 'These tools are available now; call them directly.' }
            : { success: false, tool: 'load_tools', error: `Unknown or already loaded pack "${pack}". Packs: boards, memory, project, playground.` };
        } else {
          result = await this.toolExecutor.execute(toolCall);
        }
        const executionTime = Date.now() - startTime;
        if (typeof result === 'object' && result !== null) {
          result.executionTime = executionTime;
        }
        toolResults.push(result);
        if (result && result.success !== false && CODE_EDIT_TOOLS.has(toolCall.name)) editedSinceCompile = true;
        if (toolCall.name === 'compile_sketch' && result && result.success !== false) editedSinceCompile = false;

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.name,
          is_error: !!(result && typeof result === 'object' && result.success === false),
          content: typeof result === 'string' ? result : JSON.stringify(result)
        });
      }

      iteration++;
    }

    // Out of steps: the person still gets a real answer. One last call, with
    // no tools, says what was done, what works now and what is left.
    return this._wrapUpAfterCap({ messages, chatOptions, toolResults, ask, step });
  }

  /**
   * The answer when a turn used every model call: a tool-less summary of what
   * happened, or a plain sentence when even that call fails.
   * @private
   */
  async _wrapUpAfterCap({ messages, chatOptions, toolResults, ask, step }) {
    const nudge = {
      role: 'user',
      content: '[Impulse] This turn has used all of its tool steps. Without calling any tool, tell me in a few short sentences what you did, what works now (did it compile, was it uploaded, what does the board print), and what is still left to do and how to continue. Do not apologise.'
    };
    try {
      step({ type: 'thinking' });
      const final = await ask([...messages, nudge], { ...chatOptions, tools: [] });
      const text = typeof final?.content === 'string' ? final.content.trim() : '';
      if (text) return { response: text, toolResults, usage: final.usage, model: final.model, warning: 'max_iterations_reached' };
    } catch (error) {
      if (error?.stopped) throw error;
    }
    const done = toolResults.filter((r) => r && r.success !== false).length;
    return {
      response: `I ran out of steps for this turn after ${toolResults.length} tool call${toolResults.length === 1 ? '' : 's'} (${done} succeeded). Send "continue" and I will pick up where I stopped.`,
      toolResults,
      warning: 'max_iterations_reached'
    };
  }

  /** [BOARD FACTS] for the selected board, or null (no board, no core, or arduino-cli too slow). */
  async boardFacts(fqbn) {
    const knowledge = this.toolExecutor?.boardKnowledge;
    if (!fqbn || !knowledge) return null;
    try {
      return await Promise.race([knowledge.summary(fqbn), new Promise((resolve) => setTimeout(() => resolve(null), 8000))]);
    } catch {
      return null;
    }
  }

  /**
   * Analyze error with AI assistance
   */
  async analyzeError(errorMessage, context = {}) {
    // First, check memory
    const memoryResults = await this.memory.searchSimilarErrors(errorMessage, 5);
    
    if (memoryResults.match && memoryResults.fixes.length > 0) {
      // Found exact match with fixes
      return {
        source: 'memory',
        error: memoryResults.match,
        fixes: memoryResults.fixes,
        confidence: 1.0
      };
    }

    // If no provider set, return memory results only
    if (!this.currentProvider) {
      return {
        source: 'memory',
        matches: memoryResults.matches || [],
        message: 'No AI provider configured. Showing memory results only.'
      };
    }

    // Use AI to analyze
    let query = `Analyze this Arduino error and suggest fixes: ${errorMessage}\n\nContext: ${JSON.stringify(context, null, 2)}`;
    
    if (memoryResults.matches && memoryResults.matches.length > 0) {
      query += `\n\nSimilar past errors found: ${JSON.stringify(memoryResults.matches, null, 2)}`;
    }

    const result = await this.processQuery(query, context);
    
    return {
      source: 'ai',
      analysis: result.response,
      memoryResults: memoryResults,
      toolResults: result.toolResults
    };
  }

  /**
   * Analyze serial output
   */
  async analyzeSerialOutput(serialOutput, _lines = 50) {
    if (!this.currentProvider) {
      return {
        source: 'local',
        message: 'No AI provider configured. Serial output logged but not analyzed.'
      };
    }

    const query = `Analyze this serial monitor output from an Arduino board:\n\n${serialOutput}\n\nWhat is the board doing? Are there any issues?`;
    
    return await this.processQuery(query, { type: 'serial_analysis' });
  }

  /**
   * Clear conversation history
   */
  clearHistory() {
    this.conversationHistory = [];
    this.lastBoard = null;
  }

  /**
   * Summarise the current conversation with the AI, then replace history with
   * a single seeded system-style user message containing the summary.
   * Returns the summary text so the UI can display a divider card.
   *
   * @returns {Promise<string>} summary text
   */
  async summarizeAndCompact() {
    if (this.conversationHistory.length === 0) return '';
    // Summaries are routine work: the cheapest model the server offers for them.
    if (this.router) {
      const model = await this.chooseModel('summary');
      if (model) this.useModel(model);
    }
    if (!this.currentProvider) throw new Error('No provider configured');

    // Ask the model to produce a concise summary of what happened so far.
    const summarisePrompt = [
      {
        role: 'system',
        content:
          'You are a technical assistant. Produce a concise but complete summary of the ' +
          'conversation below. Keep all important decisions, code changes, errors encountered, ' +
          'and next steps. Write in the third person. Max 400 words.'
      },
      ...this.conversationHistory,
      {
        role: 'user',
        content:
          'Please summarise the conversation above so it can be used as context going forward.'
      }
    ];

    const response = await this.currentProvider.chat(summarisePrompt, {
      temperature: 0.3,
      max_tokens: 1500,
      effort: 'low',
      tools: [] // no tools during summarisation
    });

    const summary = (response.content || '').trim() || 'Conversation summarised (no content returned).';

    // Replace history with a single seeded context message so the next query
    // has a compact starting point without losing important context.
    this.conversationHistory = [
      {
        role: 'user',
        content: `[CONVERSATION SUMMARY]\n${summary}`
      },
      {
        role: 'assistant',
        content: 'Understood. I have the context from the previous conversation. How can I help?'
      }
    ];

    return summary;
  }

  /**
   * Get conversation history
   */
  getHistory() {
    return this.conversationHistory;
  }

  /**
   * Trim conversation history to stay within the sliding window.
   * Preserves the most recent messages and never cuts in the middle
   * of a tool-call/tool-result pair.
   */
  _trimHistory() {
    if (this.conversationHistory.length <= this.maxHistoryMessages) return;

    // Keep the most recent messages within budget
    const excess = this.conversationHistory.length - this.maxHistoryMessages;
    // Don't cut in the middle of a tool exchange — find safe cut point
    let cutAt = excess;
    while (cutAt < this.conversationHistory.length) {
      const msg = this.conversationHistory[cutAt];
      // Safe to cut before a user message (not a tool result)
      if (msg.role === 'user' && !msg.tool_call_id) break;
      cutAt++;
    }
    if (cutAt > 0 && cutAt < this.conversationHistory.length) {
      this.conversationHistory = this.conversationHistory.slice(cutAt);
    }
  }

  /**
   * Close and cleanup
   */
  close() {
    if (this.memory) {
      this.memory.close();
    }
  }
}

module.exports = AIAgent;

