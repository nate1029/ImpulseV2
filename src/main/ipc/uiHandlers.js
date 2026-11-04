/**
 * UI state update IPC handlers (sync from renderer to main).
 * @module main/ipc/uiHandlers
 */

const { normalizeCircuit } = require('../services/ai/knowledge/circuitFacts');

const UI_STATE_KEYS = ['currentBaudRate', 'currentSketchPath', 'selectedBoard', 'selectedPort', 'editorCode'];

/**
 * Register UI state IPC handlers.
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ uiState: Record<string, unknown> }} ctx
 */
function register(ipcMain, ctx) {
  const { uiState } = ctx;

  ipcMain.on('ui:update-state', (event, key, value) => {
    if (key && UI_STATE_KEYS.includes(key)) {
      uiState[key] = value;
    }
  });

  ipcMain.on('ui:update-editor-code', (event, code) => {
    // The window's editor changed: unless the agent just wrote it, that is the user's edit.
    const next = typeof code === 'string' ? code : String(code ?? '');
    const changed = uiState.editorCode !== next;
    if (changed && uiState.lastEditBy !== 'agent-pending') uiState.lastEditBy = 'user';
    if (uiState.lastEditBy === 'agent-pending') uiState.lastEditBy = 'agent';
    uiState.editorCode = next;
    // Rev is the lost-update guard: tools that read before writing capture
    // this rev and pass it as expectedRev; the write is rejected if a user
    // edit landed in between.
    if (changed) uiState.editorRev = (uiState.editorRev || 0) + 1;
  });

  ipcMain.on('ui:update-sketch-path', (event, path) => {
    uiState.currentSketchPath = typeof path === 'string' ? path : null;
  });

  ipcMain.on('ui:update-baud-rate', (event, baudRate) => {
    const n = Number(baudRate);
    uiState.currentBaudRate = Number.isInteger(n) && n >= 300 && n <= 2000000 ? n : 115200;
  });

  ipcMain.on('ui:update-board', (event, board) => {
    uiState.selectedBoard = board != null ? String(board) : null;
  });

  ipcMain.on('ui:update-port', (event, port) => {
    uiState.selectedPort = port != null ? String(port) : null;
  });

  // The circuit on the simulator canvas (so the agent writes for the real wiring).
  ipcMain.on('ui:update-circuit', (event, facts) => {
    uiState.circuit = normalizeCircuit(facts);
  });

  // Last compile result (so the AI agent can see compilation errors).
  ipcMain.on('ui:update-compile-result', (event, result) => {
    if (result && typeof result === 'object') {
      const output = typeof result.output === 'string' ? result.output.slice(-4000) : '';
      uiState.lastCompileResult = {
        success: !!result.success,
        message: typeof result.message === 'string' ? result.message.slice(0, 1000) : '',
        errors: Array.isArray(result.errors) ? result.errors.slice(0, 50).map(String) : [],
        output,
        at: Date.now()
      };
    } else {
      uiState.lastCompileResult = null;
    }
  });
}

module.exports = { register };
