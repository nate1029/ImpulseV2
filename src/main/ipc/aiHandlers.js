/**
 * AI agent IPC handlers.
 * @module main/ipc/aiHandlers
 */

const AIAgent = require('../services/ai/agent');
const { generateCircuit } = require('../services/ai/circuitGenerator');
const { verifyExecution } = require('../services/ai/agentVerify');
const { parseOrDefault, schemas } = require('./schemas');
const { withDebugLog } = require('../utils/logger');

const defaultFail = { success: false, error: 'Invalid input' };

/**
 * Register AI agent IPC handlers.
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ aiAgent: import('../services/ai/agent'), cloudAccount: import('../services/cloud/account').CloudAccount, uiState: Record<string, unknown> }} ctx
 */
function register(ipcMain, ctx) {
  const { aiAgent, cloudAccount, uiState } = ctx;

  // Signing in, out or into another account: the model the server chose for
  // the old account no longer applies, and the lane needs the new token.
  cloudAccount.on('change', () => {
    aiAgent.forgetRoutes();
    const current = aiAgent.currentProvider;
    const token = cloudAccount.sessionToken();
    if (!token) {
      aiAgent.currentProvider = null;
      return;
    }
    if (current && AIAgent.CLOUD_PROVIDERS.includes(current.name)) aiAgent.setProvider(current.name, token, current.appModel);
  });

  /** Whether Impulse AI can answer: signed in, and a model routed. */
  ipcMain.handle('ai:ready', withDebugLog('ai:ready', async () => {
    if (!cloudAccount.sessionToken()) return { success: false, needsSignIn: true, error: 'Sign in to Impulse to use AI.' };
    try {
      await aiAgent.ready();
      return { success: true };
    } catch (error) {
      if (error?.code === 'signed_out') return { success: false, needsSignIn: true, error: error.message };
      return { success: false, error: error?.message ?? 'Impulse AI is not available right now.' };
    }
  }));

  ipcMain.handle('ai:generate-circuit', withDebugLog('ai:generate-circuit', async (event, sketchCode, options) => {
    const parsed = parseOrDefault(schemas.aiGenerateCircuit, {
      code: typeof sketchCode === 'string' ? sketchCode : '',
      board: options?.board,
      catalog: options?.catalog,
    }, { success: false, error: 'Invalid sketch code' });
    if (!parsed.ok) return parsed.defaultResult;
    try {
      return await generateCircuit(aiAgent, parsed.data.code, { board: parsed.data.board, catalog: parsed.data.catalog });
    } catch (error) {
      return { success: false, error: error?.message ?? 'Circuit generation failed' };
    }
  }));

  ipcMain.handle('ai:verify-execution', withDebugLog('ai:verify-execution', async (event, obs) => {
    if (!obs || typeof obs !== 'object' || typeof obs.code !== 'string' || obs.code.length > 200000) {
      return { success: false, error: 'Invalid observation payload' };
    }
    try {
      return await verifyExecution(aiAgent, obs);
    } catch (error) {
      return { success: false, error: error?.message ?? 'Verify failed' };
    }
  }));

  // The turn in progress, so the chat's Stop can cancel it.
  let running = null;

  ipcMain.handle('ai:process-query', withDebugLog('ai:process-query', async (event, query, context, mode) => {
    const parsed = parseOrDefault(schemas.aiProcessQuery, { query: query ?? '', context: context ?? {}, mode: mode ?? 'agent' }, defaultFail);
    if (!parsed.ok) return parsed.defaultResult;
    const turn = new AbortController();
    running?.abort();
    running = turn;
    try {
      const ctx = parsed.data.context || {};
      const enrichedContext = {
        ...parsed.data.context,
        currentBaudRate: uiState.currentBaudRate,
        currentSketchPath: uiState.currentSketchPath,
        selectedBoard: uiState.selectedBoard ?? ctx.board ?? null,
        selectedPort: uiState.selectedPort ?? ctx.port ?? null,
        hasFileOpen: ctx.hasFileOpen ?? false,
        lastCompileResult: uiState.lastCompileResult ?? null,
        circuit: uiState.circuit ?? null,
        escalate: ctx.escalate ?? 0,
      };
      const effectiveMode = ['plan', 'ask', 'debug'].includes(parsed.data.mode) ? parsed.data.mode : 'agent';
      // Each step goes to the chat as it happens (the orb's label).
      const onStep = (step) => { if (!event.sender.isDestroyed()) event.sender.send('ai:step', step); };
      const result = await aiAgent.processQuery(parsed.data.query, enrichedContext, effectiveMode, { onStep, signal: turn.signal });
      return { success: true, data: result };
    } catch (error) {
      if (error?.stopped) return { success: false, stopped: true, error: 'Stopped' };
      if (error?.code === 'signed_out' || !cloudAccount.sessionToken()) return { success: false, code: 'signed_out', error: 'Sign in to Impulse to use AI.' };
      return { success: false, code: error?.code, error: error?.message ?? 'Process query failed' };
    } finally {
      if (running === turn) running = null;
    }
  }));

  ipcMain.handle('ai:cancel', withDebugLog('ai:cancel', async () => {
    const wasRunning = !!running;
    running?.abort();
    running = null;
    return { success: true, cancelled: wasRunning };
  }));

  ipcMain.handle('ai:analyze-error', withDebugLog('ai:analyze-error', async (event, errorMessage, context) => {
    const parsed = parseOrDefault(schemas.aiAnalyzeError, { errorMessage: errorMessage ?? '', context }, defaultFail);
    if (!parsed.ok) return parsed.defaultResult;
    try {
      const result = await aiAgent.analyzeError(parsed.data.errorMessage, parsed.data.context);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Analyze failed' };
    }
  }));

  ipcMain.handle('ai:analyze-serial', withDebugLog('ai:analyze-serial', async (event, serialOutput, lines) => {
    const parsed = parseOrDefault(schemas.aiAnalyzeSerial, { serialOutput: serialOutput ?? '', lines: lines ?? [] }, defaultFail);
    if (!parsed.ok) return parsed.defaultResult;
    try {
      const result = await aiAgent.analyzeSerialOutput(parsed.data.serialOutput, parsed.data.lines);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Analyze failed' };
    }
  }));

  ipcMain.handle('ai:summarize-history', withDebugLog('ai:summarize-history', async () => {
    try {
      const summary = await aiAgent.summarizeAndCompact();
      return { success: true, summary };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Summarise failed' };
    }
  }));

  ipcMain.handle('ai:clear-history', withDebugLog('ai:clear-history', async () => {
    try {
      aiAgent.clearHistory();
      return { success: true };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Clear failed' };
    }
  }));

  ipcMain.handle('ai:get-memory-stats', withDebugLog('ai:get-memory-stats', async () => {
    try {
      const stats = await aiAgent.memory.getStats();
      return { success: true, data: stats ?? {} };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Get stats failed' };
    }
  }));

  ipcMain.handle('ai:execute-tool', withDebugLog('ai:execute-tool', async (event, toolName, args) => {
    const parsed = parseOrDefault(schemas.aiExecuteTool, { toolName: toolName ?? '', args: args ?? {} }, defaultFail);
    if (!parsed.ok) return parsed.defaultResult;
    try {
      if (!aiAgent.toolExecutor) return { success: false, error: 'Tool executor not initialized' };
      const result = await aiAgent.toolExecutor.execute({
        name: parsed.data.toolName,
        arguments: parsed.data.args
      });
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Execute tool failed' };
    }
  }));
}

module.exports = { register };
