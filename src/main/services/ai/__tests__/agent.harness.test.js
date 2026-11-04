/**
 * The harness around the model: tool packs loaded on demand, and the verify
 * guard that compiles an edited sketch before the model's "done" stands.
 */
const AIAgent = require('../agent');

function scripted(turns) {
  // Each call to chat() pops the next scripted response; records what it was asked with.
  const calls = [];
  return {
    calls,
    provider: {
      name: 'mock', model: 'mock-model',
      validateApiKey: () => true,
      getAvailableModels: () => ['mock-model'],
      async chat(messages, options) {
        calls.push({ messages, tools: (options.tools || []).map((t) => t.name), taskId: options.taskId });
        const next = turns.shift();
        return next || { content: 'done', toolCalls: [] };
      },
    },
  };
}

function agentWith(turns, executorResults = {}) {
  const agent = new AIAgent({}, {}, {});
  const { provider, calls } = scripted(turns);
  agent.providers.set('mock', function Mock() { return provider; });
  agent.setProvider('mock', 'key');
  agent.currentProvider = provider;
  const executed = [];
  agent.toolExecutor = {
    boardKnowledge: null,
    async execute(call) {
      executed.push(call.name);
      const r = executorResults[call.name];
      return typeof r === 'function' ? r(call) : (r || { success: true, tool: call.name });
    },
  };
  return { agent, calls, executed };
}

describe('tool packs', () => {
  it('starts agent mode with the standing set and adds a pack when the model loads it', async () => {
    const { agent, calls, executed } = agentWith([
      { content: null, toolCalls: [{ id: '1', name: 'load_tools', arguments: { pack: 'boards' } }] },
      { content: null, toolCalls: [{ id: '2', name: 'list_ports', arguments: {} }] },
      { content: 'Here are the ports.', toolCalls: [] },
    ]);
    const result = await agent.processQuery('which ports?', { hasFileOpen: true }, 'agent');
    expect(calls[0].tools).toEqual(expect.arrayContaining(['compile_sketch', 'serial', 'get_circuit', 'load_tools']));
    expect(calls[0].tools).not.toContain('list_ports');
    expect(calls[0].tools).not.toContain('connect_serial');
    expect(calls[1].tools).toEqual(expect.arrayContaining(['list_ports', 'list_boards', 'search_boards', 'get_mcu_guide']));
    expect(executed).toEqual(['list_ports']); // load_tools never reaches the executor
    expect(result.toolResults[0]).toMatchObject({ success: true, tool: 'load_tools', loaded: expect.arrayContaining(['list_ports']) });
    expect(result.response).toBe('Here are the ports.');
    expect(result.taskId).toMatch(/^t_/);
    expect(new Set(calls.map((c) => c.taskId)).size).toBe(1);
  });

  it('refuses an unknown pack without calling anything', async () => {
    const { agent, executed } = agentWith([
      { content: null, toolCalls: [{ id: '1', name: 'load_tools', arguments: '{"pack":"kitchen"}' }] },
      { content: 'ok', toolCalls: [] },
    ]);
    const result = await agent.processQuery('x', { hasFileOpen: true }, 'agent');
    expect(result.toolResults[0]).toMatchObject({ success: false, tool: 'load_tools' });
    expect(executed).toEqual([]);
  });

  it('debug mode can read, edit, compile and watch serial', () => {
    const names = new AIAgent({}, {}, {})._getToolsForMode('debug').map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['get_editor_code', 'edit_code', 'compile_sketch', 'serial', 'analyze_error', 'search_memory', 'record_fix']));
  });
});

describe('the verify guard', () => {
  it('compiles an edited sketch before the answer stands, and reports the size', async () => {
    const { agent, executed } = agentWith([
      { content: null, toolCalls: [{ id: '1', name: 'set_editor_code', arguments: { code: 'void setup(){} void loop(){}' } }] },
      { content: 'Written.', toolCalls: [] },
    ], { compile_sketch: { success: true, tool: 'compile_sketch', summary: ['Sketch uses 444 bytes (1%) of program storage space. Maximum is 32,256 bytes.'] } });
    const result = await agent.processQuery('write blink', { hasFileOpen: true }, 'agent');
    expect(executed).toEqual(['set_editor_code', 'compile_sketch']);
    expect(result.response).toBe('Written.\n\nSketch uses 444 bytes (1%) of program storage space. Maximum is 32,256 bytes.');
    expect(result.toolResults.at(-1)).toMatchObject({ tool: 'compile_sketch', verify: true });
  });

  it('sends a failing verify back to the model, which fixes it, and compiles once more', async () => {
    let compiles = 0;
    const { agent, calls, executed } = agentWith([
      { content: null, toolCalls: [{ id: '1', name: 'edit_code', arguments: { operation: 'replace', startLine: 1, newCode: 'x' } }] },
      { content: 'Changed line 1.', toolCalls: [] },
      { content: null, toolCalls: [{ id: '2', name: 'edit_code', arguments: { operation: 'replace', startLine: 1, newCode: 'y' } }] },
      { content: 'Fixed the typo.', toolCalls: [] },
    ], {
      compile_sketch: () => (++compiles === 1
        ? { success: false, tool: 'compile_sketch', code: 'CODE_ERROR', error: 'The sketch has a compile error', excerpt: "x.ino:1:1: error: 'x' does not name a type", diagnostics: [{ file: '/s/x.ino', line: 1, level: 'error', message: "'x' does not name a type" }] }
        : { success: true, tool: 'compile_sketch', summary: ['Sketch uses 1,000 bytes (3%) of program storage space.'] }),
    });
    const result = await agent.processQuery('fix it', { hasFileOpen: true }, 'agent');
    expect(executed).toEqual(['edit_code', 'compile_sketch', 'edit_code', 'compile_sketch']);
    const verifyMessage = calls[2].messages.find((m) => m.role === 'user' && /\[VERIFY\]/.test(m.content));
    expect(verifyMessage.content).toMatch(/does not compile:\nThe sketch has a compile error\nx\.ino:1:1: error/);
    expect(result.response).toMatch(/^Fixed the typo\./);
    expect(result.response).toMatch(/Sketch uses 1,000 bytes/);
  });

  it('fixes an error with a proven rewrite without asking the model again', async () => {
    let compiles = 0;
    const { agent, calls, executed } = agentWith([
      { content: null, toolCalls: [{ id: '1', name: 'set_editor_code', arguments: { code: 'ledcSetup(0, 5000, 8);' } }] },
      { content: 'Dimmed the LED with LEDC.', toolCalls: [] },
    ], {
      compile_sketch: () => (++compiles === 1
        ? { success: false, tool: 'compile_sketch', code: 'CODE_ERROR', error: 'ESP32 core 3 removed ledcSetup and ledcAttachPin', diagnostics: [{ file: '/s/s.ino', line: 2, level: 'error', message: "'ledcSetup' was not declared in this scope" }] }
        : { success: true, tool: 'compile_sketch', summary: ['Sketch uses 290,000 bytes (22%) of program storage space.'] }),
    });
    const rewrites = [];
    agent.toolExecutor.applyKnownRewrite = async (check) => { rewrites.push(check.code); return { applied: ['esp32-ledc-core3'] }; };
    const result = await agent.processQuery('dim the led on 4', { hasFileOpen: true }, 'agent');
    expect(executed).toEqual(['set_editor_code', 'compile_sketch', 'compile_sketch']);
    expect(rewrites).toEqual(['CODE_ERROR']);
    expect(calls).toHaveLength(2); // no repair round: the rewrite fixed it
    expect(result.response).toMatch(/Sketch uses 290,000 bytes/);
    expect(result.response).toMatch(/Impulse fixed this automatically: ESP32 core 3 removed ledcSetup and ledcAttachPin\.$/);
    expect(result.toolResults.find((r) => r.autoFixed)).toMatchObject({ success: true, autoFixed: ['esp32-ledc-core3'] });
  });

  it('applies the linter\'s mechanical fixes without asking the model', async () => {
    const { agent, calls, executed } = agentWith([
      { content: null, toolCalls: [{ id: '1', name: 'set_editor_code', arguments: { code: 'a' } }] },
      { content: 'Prints the button state.', toolCalls: [] },
    ], { compile_sketch: { success: true, tool: 'compile_sketch', summary: ['Sketch uses 60,000 bytes (3%) of program storage space.'] } });
    let lints = 0;
    agent.toolExecutor.lintSketch = async () => (++lints === 1
      ? { findings: [{ id: 'native-usb-early-print', level: 'error', line: 3, canRewrite: true, message: "This board's Serial is its own USB: what setup() prints right after a reset is lost before the serial monitor reconnects.", fix: 'Wait for the monitor first.' }], report: 'Problem (line 3): …' }
      : { findings: [], report: '' });
    agent.toolExecutor.applyLintFixes = async () => ({ applied: ['native-usb-early-print'] });
    const result = await agent.processQuery('print the button state on the pico', { hasFileOpen: true }, 'agent');
    expect(executed).toEqual(['set_editor_code', 'compile_sketch', 'compile_sketch']);
    expect(calls).toHaveLength(2); // no repair round
    expect(result.response).toMatch(/Impulse fixed this automatically: This board's Serial is its own USB: what setup\(\) prints right after a reset is lost before the serial monitor reconnects\.$/);
  });

  it('sends what the hardware linter finds back to the model once the sketch compiles', async () => {
    const { agent, calls, executed } = agentWith([
      { content: null, toolCalls: [{ id: '1', name: 'set_editor_code', arguments: { code: 'a' } }] },
      { content: 'Written.', toolCalls: [] },
      { content: null, toolCalls: [{ id: '2', name: 'set_editor_code', arguments: { code: 'b' } }] },
      { content: 'Moved the sensor to GPIO 34.', toolCalls: [] },
    ], { compile_sketch: { success: true, tool: 'compile_sketch', summary: ['Sketch uses 900,000 bytes (68%) of program storage space.'] } });
    let lints = 0;
    agent.toolExecutor.lintSketch = async () => (++lints === 1
      ? { findings: [{ id: 'esp32-adc2-with-wifi', level: 'error', line: 9, message: 'GPIO 25 is an ADC2 pin, and ADC2 cannot read while Wi-Fi is on.', fix: 'Use an ADC1 pin.' }], report: 'Problem (line 9): GPIO 25 is an ADC2 pin, and ADC2 cannot read while Wi-Fi is on. Fix: Use an ADC1 pin.' }
      : { findings: [], report: '' });
    const result = await agent.processQuery('read the pot with wifi on', { hasFileOpen: true }, 'agent');
    expect(executed).toEqual(['set_editor_code', 'compile_sketch', 'set_editor_code', 'compile_sketch']);
    const lintMessage = calls[2].messages.find((m) => m.role === 'user' && /\[LINT\]/.test(m.content));
    expect(lintMessage.content).toMatch(/compiles, but Impulse's hardware linter found what will fail on this board:\nProblem \(line 9\): GPIO 25 is an ADC2 pin/);
    expect(result.toolResults.some((r) => r.tool === 'lint' && r.verify)).toBe(true);
    expect(result.response).toMatch(/^Moved the sensor to GPIO 34\./);
  });

  it('does not compile when nothing was edited, when the model compiled already, or outside agent mode', async () => {
    const a = agentWith([{ content: 'just talk', toolCalls: [] }]);
    await a.agent.processQuery('hi', { hasFileOpen: true }, 'agent');
    expect(a.executed).toEqual([]);
    const b = agentWith([
      { content: null, toolCalls: [{ id: '1', name: 'set_editor_code', arguments: { code: '' } }, { id: '2', name: 'compile_sketch', arguments: {} }] },
      { content: 'done', toolCalls: [] },
    ]);
    await b.agent.processQuery('go', { hasFileOpen: true }, 'agent');
    expect(b.executed).toEqual(['set_editor_code', 'compile_sketch']);
    const c = agentWith([
      { content: null, toolCalls: [{ id: '1', name: 'edit_code', arguments: { operation: 'delete', startLine: 1 } }] },
      { content: 'done', toolCalls: [] },
    ]);
    await c.agent.processQuery('go', { hasFileOpen: true }, 'debug');
    expect(c.executed).toEqual(['edit_code']);
  });
});
