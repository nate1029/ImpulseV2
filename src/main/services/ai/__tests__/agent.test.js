/**
 * Tests for AIAgent
 * Focuses on: provider management, conversation history, error handling
 */

jest.mock('../prompts/systemPrompt', () => ({
  getSystemPrompt: jest.fn(() => 'You are a helpful assistant.')
}));

const AIAgent = require('../agent');

// Minimal mock classes
class MockProvider {
  constructor() { this.name = 'mock'; }
  validateApiKey() { return true; }
  getAvailableModels() { return ['mock-model']; }
  async chat() {
    return {
      content: 'Mock response',
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 20 },
      model: 'mock-model'
    };
  }
}

function createAgent() {
  const agent = new AIAgent({}, {}, {});
  return agent;
}

describe('AIAgent', () => {
  describe('provider management', () => {
    it('should register and list providers', () => {
      const agent = createAgent();
      agent.registerProvider('mock', MockProvider);
      expect([...agent.providers.keys()]).toContain('mock');
    });

    it('should set current provider with valid API key', () => {
      const agent = createAgent();
      agent.registerProvider('mock', MockProvider);
      const provider = agent.setProvider('mock', 'valid-key');
      expect(provider).toBeDefined();
      expect(agent.currentProvider).toBe(provider);
    });

    it('should throw when setting unregistered provider', () => {
      const agent = createAgent();
      expect(() => agent.setProvider('nonexistent', 'key')).toThrow('not registered');
    });
  });

  describe('getProviderFromModel (static)', () => {
    it('should detect Impulse Cloud models', () => {
      expect(AIAgent.getProviderFromModel('impulse:claude-opus-5-5')).toBe('impulse');
    });

    it('should detect the OpenAI lane of Impulse Cloud', () => {
      expect(AIAgent.getProviderFromModel('impulse:gpt-5.4')).toBe('impulse-openai');
      expect(AIAgent.getProviderFromModel('impulse:gpt-5.4-nano')).toBe('impulse-openai');
    });

    it('should not take bare provider model ids (no API keys of your own), nor local models', () => {
      expect(AIAgent.getProviderFromModel('claude-opus-5-5')).toBeNull();
      expect(AIAgent.getProviderFromModel('gpt-5.4')).toBeNull();
      expect(AIAgent.getProviderFromModel('ollama:qwen2.5-coder:7b')).toBeNull();
    });

    it('registers both cloud lanes and nothing that runs on this computer', () => {
      const agent = createAgent();
      agent.initializeProviders();
      expect([...agent.providers.keys()]).toEqual(['impulse-openai', 'impulse']);
    });

    it('asks the server which model answers, caches it, and points at that lane', async () => {
      const agent = createAgent();
      agent.initializeProviders();
      agent.credential = () => 'session-token-0123456789';
      const router = jest.fn(async ({ kind, escalate }) => ({ ok: true, data: { model: escalate ? 'gpt-5.5' : kind === 'ask' ? 'gpt-5.4-mini' : 'gpt-5.4', ttlSeconds: 300 } }));
      agent.router = router;
      expect(await agent.chooseModel('agent')).toBe('impulse:gpt-5.4');
      expect(await agent.chooseModel('agent')).toBe('impulse:gpt-5.4');
      expect(router).toHaveBeenCalledTimes(1); // cached
      expect(await agent.chooseModel('ask')).toBe('impulse:gpt-5.4-mini');
      expect(await agent.chooseModel('agent', { escalate: 1 })).toBe('impulse:gpt-5.5');
      const provider = agent.useModel('impulse:gpt-5.5');
      expect(provider.name).toBe('impulse-openai');
      expect(provider.appModel).toBe('impulse:gpt-5.5');
      expect(agent.useModel('impulse:gpt-5.5')).toBe(provider); // the same lane and model: nothing rebuilt
      agent.forgetRoutes();
      await agent.chooseModel('agent');
      expect(router).toHaveBeenCalledTimes(4);
    });

    it('refuses to pick a model without a session, and falls back when the server is silent', async () => {
      const agent = createAgent();
      agent.initializeProviders();
      agent.credential = () => null;
      expect(() => agent.useModel('impulse:gpt-5.4')).toThrow(expect.objectContaining({ code: 'signed_out' }));
      agent.credential = () => 'session-token-0123456789';
      agent.router = async () => ({ ok: false, error: 'offline' });
      expect(await agent.chooseModel('agent')).toBeNull();
      const provider = await agent.ready();
      expect(provider.appModel).toBe('impulse:gpt-5.4'); // the default when the server cannot be asked
    });

    it('should return null for unknown models', () => {
      expect(AIAgent.getProviderFromModel('unknown-model')).toBeNull();
      expect(AIAgent.getProviderFromModel(null)).toBeNull();
      expect(AIAgent.getProviderFromModel('')).toBeNull();
    });
  });

  describe('conversation history', () => {
    it('should start with empty history', () => {
      const agent = createAgent();
      expect(agent.getHistory()).toEqual([]);
    });

    it('should clear history', () => {
      const agent = createAgent();
      agent.conversationHistory = [{ role: 'user', content: 'hello' }];
      agent.clearHistory();
      expect(agent.getHistory()).toEqual([]);
    });

    it('should trim history when exceeding max', () => {
      const agent = createAgent();
      agent.maxHistoryMessages = 4;

      // Add 6 messages
      for (let i = 0; i < 6; i++) {
        agent.conversationHistory.push({ role: 'user', content: `msg ${i}` });
      }

      agent._trimHistory();
      expect(agent.conversationHistory.length).toBeLessThanOrEqual(4);
    });

    it('should not trim when within limit', () => {
      const agent = createAgent();
      agent.maxHistoryMessages = 40;
      agent.conversationHistory = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' }
      ];

      agent._trimHistory();
      expect(agent.conversationHistory.length).toBe(2);
    });
  });

  describe('processQuery', () => {
    it('should throw when no provider is set', async () => {
      const agent = createAgent();
      await expect(agent.processQuery('hello')).rejects.toThrow('No provider selected');
    });

    it('should return response from provider', async () => {
      const agent = createAgent();
      agent.registerProvider('mock', MockProvider);
      agent.setProvider('mock', 'key');

      const result = await agent.processQuery('hello', {}, 'ask');
      expect(result.response).toBe('Mock response');
      expect(result.toolResults).toEqual([]);
    });

    it('should add context to user messages', async () => {
      const agent = createAgent();
      agent.registerProvider('mock', MockProvider);
      agent.setProvider('mock', 'key');

      await agent.processQuery('test', {
        selectedBoard: 'arduino:avr:uno',
        selectedPort: 'COM3'
      }, 'ask');

      const lastUserMsg = agent.conversationHistory.find(m => m.role === 'user');
      expect(lastUserMsg.content).toContain('board=arduino:avr:uno');
      expect(lastUserMsg.content).toContain('port=COM3');
    });
  });

  describe('steps reported while a query runs', () => {
    it('reports each model call and each tool before it runs', async () => {
      const agent = createAgent();
      agent.registerProvider('mock', MockProvider);
      agent.setProvider('mock', 'key');
      let call = 0;
      agent.currentProvider.chat = async () => (++call === 1
        ? { content: null, toolCalls: [{ id: 't1', name: 'compile_sketch', arguments: {} }] }
        : { content: 'Compiled.', toolCalls: [] });
      agent.toolExecutor = { execute: async () => ({ success: true, tool: 'compile_sketch' }) };
      const steps = [];
      const result = await agent.processQuery('compile it', {}, 'agent', { onStep: (s) => steps.push(s) });
      expect(result.response).toBe('Compiled.');
      expect(steps).toEqual([{ type: 'thinking' }, { type: 'tool', name: 'compile_sketch' }, { type: 'thinking' }]);
    });

    it('a listener that throws does not break the query', async () => {
      const agent = createAgent();
      agent.registerProvider('mock', MockProvider);
      agent.setProvider('mock', 'key');
      const result = await agent.processQuery('hi', {}, 'ask', { onStep: () => { throw new Error('ui gone'); } });
      expect(result.response).toBe('Mock response');
    });
  });

  describe('board facts with every request', () => {
    it('puts the selected board\'s facts in the system message, not in the history', async () => {
      const agent = createAgent();
      agent.registerProvider('mock', MockProvider);
      agent.setProvider('mock', 'key');
      agent.toolExecutor.boardKnowledge = { summary: async (fqbn) => `[BOARD FACTS] ${fqbn}: LED_BUILTIN = RGB LED on GPIO48.` };
      let system = '';
      agent.currentProvider.chat = async (msgs) => { system = msgs[0].content; return { content: 'ok', toolCalls: [] }; };
      await agent.processQuery('blink the LED', { selectedBoard: 'esp32:esp32:esp32s3' }, 'ask');
      expect(system).toMatch(/\[BOARD FACTS\] esp32:esp32:esp32s3: LED_BUILTIN = RGB LED on GPIO48\./);
      expect(JSON.stringify(agent.conversationHistory)).not.toMatch(/BOARD FACTS/);
    });

    it('says when the board changed since earlier messages', async () => {
      const agent = createAgent();
      agent.registerProvider('mock', MockProvider);
      agent.setProvider('mock', 'key');
      agent.toolExecutor.boardKnowledge = { summary: async (fqbn) => `[BOARD FACTS] ${fqbn}` };
      const systems = [];
      agent.currentProvider.chat = async (msgs) => { systems.push(msgs[0].content); return { content: 'ok', toolCalls: [] }; };
      await agent.processQuery('blink', { selectedBoard: 'esp32:esp32:esp32s3' }, 'ask');
      await agent.processQuery('again', { selectedBoard: 'esp32:esp32:esp32s3' }, 'ask');
      await agent.processQuery('and now?', { selectedBoard: 'esp32:esp32:esp32' }, 'ask');
      expect(systems[1]).not.toMatch(/BOARD CHANGED/);
      expect(systems[2]).toMatch(/\[BOARD CHANGED\] The selected board is now esp32:esp32:esp32; earlier messages .* esp32:esp32:esp32s3/);
    });

    it('puts the circuit on the canvas in the system message, and says when it changed', async () => {
      const agent = createAgent();
      agent.registerProvider('mock', MockProvider);
      agent.setProvider('mock', 'key');
      agent.toolExecutor.boardKnowledge = { summary: async () => null };
      const systems = [];
      agent.currentProvider.chat = async (msgs) => { systems.push(msgs[0].content); return { content: 'ok', toolCalls: [] }; };
      const circuit = { hasCircuit: true, hash: 'a1', board: 'uno', boardLabel: 'Arduino Uno', parts: ['LED led1'], lines: ['D13 → LED led1:A'], checks: [], changedBy: 'user', updatedAt: null };
      await agent.processQuery('blink it', { circuit }, 'ask');
      await agent.processQuery('faster', { circuit }, 'ask');
      await agent.processQuery('and the button?', { circuit: { ...circuit, hash: 'b2', parts: ['LED led1', 'Pushbutton btn1'], lines: ['D13 → LED led1:A', 'D2 → Pushbutton btn1:1.l'] } }, 'ask');
      expect(systems[0]).toMatch(/\[CIRCUIT\] On the simulator canvas.*wired by the user/);
      expect(systems[0]).toMatch(/D13 → LED led1:A/);
      expect(systems[0]).not.toMatch(/CIRCUIT CHANGED/);
      expect(systems[1]).not.toMatch(/CIRCUIT CHANGED/);
      expect(systems[2]).toMatch(/D2 → Pushbutton btn1:1\.l/);
      expect(systems[2]).toMatch(/\[CIRCUIT CHANGED\]/);
      expect(JSON.stringify(agent.conversationHistory)).not.toMatch(/CIRCUIT/);
    });

    it('goes on without them when there is no board or arduino-cli is slow', async () => {
      const agent = createAgent();
      agent.registerProvider('mock', MockProvider);
      agent.setProvider('mock', 'key');
      agent.toolExecutor.boardKnowledge = { summary: () => new Promise(() => {}) };
      jest.useFakeTimers();
      const pending = agent.processQuery('hi', { selectedBoard: 'arduino:avr:uno' }, 'ask');
      await jest.advanceTimersByTimeAsync(8100);
      jest.useRealTimers();
      expect((await pending).response).toBe('Mock response');
      expect(await agent.boardFacts('')).toBeNull();
    });
  });

  describe('when a turn runs out of steps', () => {
    const buildAgent = () => {
      const agent = createAgent();
      agent.config.maxIterations = 2;
      agent.registerProvider('mock', MockProvider);
      agent.setProvider('mock', 'key');
      agent.toolExecutor = { execute: async () => ({ success: true, tool: 'compile_sketch' }) };
      return agent;
    };

    it('answers with a tool-less summary instead of an error line', async () => {
      const agent = buildAgent();
      const calls = [];
      agent.currentProvider.chat = async (msgs, opts) => {
        calls.push({ tools: opts.tools, last: msgs[msgs.length - 1] });
        if (Array.isArray(opts.tools) && opts.tools.length === 0) return { content: 'Compiled and uploaded; the board prints "hi". Nothing is left.', toolCalls: [], model: 'mock-model' };
        return { content: null, toolCalls: [{ id: `t${calls.length}`, name: 'compile_sketch', arguments: {} }] };
      };
      const steps = [];
      const result = await agent.processQuery('build it', {}, 'agent', { onStep: (s) => steps.push(s.type) });
      expect(result.warning).toBe('max_iterations_reached');
      expect(result.response).toMatch(/Compiled and uploaded/);
      expect(result.toolResults).toHaveLength(2);
      expect(calls).toHaveLength(3);
      expect(calls[2].tools).toEqual([]);
      expect(calls[2].last).toMatchObject({ role: 'user' });
      expect(calls[2].last.content).toMatch(/used all of its tool steps/);
      expect(steps.filter((s) => s === 'thinking')).toHaveLength(3);
    });

    it('falls back to a plain sentence when the summary call fails', async () => {
      const agent = buildAgent();
      let n = 0;
      agent.currentProvider.chat = async (msgs, opts) => {
        if (Array.isArray(opts.tools) && opts.tools.length === 0) throw new Error('upstream down');
        return { content: null, toolCalls: [{ id: `t${++n}`, name: 'compile_sketch', arguments: {} }] };
      };
      const result = await agent.processQuery('build it', {}, 'agent');
      expect(result.warning).toBe('max_iterations_reached');
      expect(result.response).toBe('I ran out of steps for this turn after 2 tool calls (2 succeeded). Send "continue" and I will pick up where I stopped.');
    });

    it('still stops when the person presses Stop during the summary', async () => {
      const agent = buildAgent();
      const turn = new AbortController();
      let n = 0;
      agent.currentProvider.chat = async (msgs, opts) => {
        if (Array.isArray(opts.tools) && opts.tools.length === 0) { turn.abort(); throw new Error('Request was aborted.'); }
        return { content: null, toolCalls: [{ id: `t${++n}`, name: 'compile_sketch', arguments: {} }] };
      };
      await expect(agent.processQuery('build it', {}, 'agent', { signal: turn.signal })).rejects.toMatchObject({ stopped: true });
    });
  });

  describe('component facts with a request', () => {
    it('puts the wiring and sketch of a named part in the system message, not in the history', async () => {
      const agent = createAgent();
      agent.registerProvider('mock', MockProvider);
      agent.setProvider('mock', 'key');
      let seen = null;
      agent.currentProvider.chat = async (msgs) => { seen = msgs; return { content: 'ok', toolCalls: [] }; };
      await agent.processQuery('Read a DHT22 and print it', { selectedBoard: 'esp32:esp32:esp32s3' }, 'agent');
      expect(seen[0].role).toBe('system');
      expect(seen[0].content).toMatch(/\[COMPONENT FACTS\] The message names DHT11/);
      expect(seen[0].content).toMatch(/Known-good sketch for the ESP32-S3/);
      expect(agent.conversationHistory.some((m) => /COMPONENT FACTS/.test(String(m.content)))).toBe(false);
      await agent.processQuery('make it print twice a second', { selectedBoard: 'esp32:esp32:esp32s3' }, 'agent');
      expect(seen[0].content).not.toMatch(/COMPONENT FACTS/); // nothing named this time
    });

    it('leaves them out of ask mode (a question, not a build)', async () => {
      const agent = createAgent();
      agent.registerProvider('mock', MockProvider);
      agent.setProvider('mock', 'key');
      let seen = null;
      agent.currentProvider.chat = async (msgs) => { seen = msgs; return { content: 'ok', toolCalls: [] }; };
      await agent.processQuery('What is a DHT22?', { selectedBoard: 'arduino:avr:uno' }, 'ask');
      expect(seen[0].content).not.toMatch(/COMPONENT FACTS/);
    });
  });

  describe('stopping a turn (the chat\'s Stop)', () => {
    it('cancels the model call in flight and drops the turn from the history', async () => {
      const agent = createAgent();
      agent.registerProvider('mock', MockProvider);
      agent.setProvider('mock', 'key');
      agent.conversationHistory = [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'ok' }];
      const turn = new AbortController();
      let seen = null;
      agent.currentProvider.chat = (msgs, opts) => new Promise((resolve, reject) => {
        seen = opts.signal;
        opts.signal.addEventListener('abort', () => reject(new Error('Request was aborted.')));
      });
      const pending = agent.processQuery('count to a million', {}, 'agent', { signal: turn.signal });
      await new Promise((r) => setTimeout(r, 10));
      turn.abort();
      await expect(pending).rejects.toMatchObject({ stopped: true, message: 'Stopped' });
      expect(seen).toBe(turn.signal);
      expect(agent.conversationHistory).toEqual([{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'ok' }]);
    });

    it('runs no more tools once stopped', async () => {
      const agent = createAgent();
      agent.registerProvider('mock', MockProvider);
      agent.setProvider('mock', 'key');
      const turn = new AbortController();
      agent.currentProvider.chat = async () => ({ content: null, toolCalls: [{ id: 'a', name: 'compile_sketch', arguments: {} }, { id: 'b', name: 'upload_sketch', arguments: {} }] });
      const ran = [];
      agent.toolExecutor = { execute: async (call) => { ran.push(call.name); turn.abort(); return { success: true }; } };
      await expect(agent.processQuery('compile then upload', {}, 'agent', { signal: turn.signal })).rejects.toMatchObject({ stopped: true });
      expect(ran).toEqual(['compile_sketch']);
    });
  });

  describe('_getToolsForMode', () => {
    it('should return empty array for ask mode', () => {
      const agent = createAgent();
      expect(agent._getToolsForMode('ask')).toEqual([]);
    });

    it('should return tools for agent mode', () => {
      const agent = createAgent();
      const tools = agent._getToolsForMode('agent');
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
    });

    it('should return debug tools for debug mode', () => {
      const agent = createAgent();
      const tools = agent._getToolsForMode('debug');
      expect(Array.isArray(tools)).toBe(true);
    });
  });

  describe('analyzeError', () => {
    it('should return memory results when no provider is set', async () => {
      const agent = createAgent();
      // SimpleMemory returns empty results
      const result = await agent.analyzeError('test error');
      expect(result.source).toBe('memory');
    });
  });
});
