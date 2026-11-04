/**
 * Registers all IPC handlers with the main process. Call after services and mainWindow are ready.
 * @module main/ipc
 */

const shellHandlers = require('./shellHandlers');
const uiHandlers = require('./uiHandlers');
const arduinoHandlers = require('./arduinoHandlers');
const serialHandlers = require('./serialHandlers');
const dialogHandlers = require('./dialogHandlers');
const fileHandlers = require('./fileHandlers');
const libHandlers = require('./libHandlers');
const errorsHandlers = require('./errorsHandlers');
const aiHandlers = require('./aiHandlers');
const cloudHandlers = require('./cloudHandlers');
const learningHandlers = require('./learningHandlers');
const chatHandlers = require('./chatHandlers');
const appHandlers = require('./appHandlers');
const sketchHandlers = require('./sketchHandlers');
const problemHandlers = require('./problemHandlers');
const toolchainHandlers = require('./toolchainHandlers');
const platformioHandlers = require('./platformioHandlers');
const gitHandlers = require('./gitHandlers');
const esp32simHandlers = require('./esp32simHandlers');

/**
 * Register all IPC handlers. Requires ipcMain and a context object with services and state.
 * @param {import('electron').IpcMain} ipcMain
 * @param {{
 *   mainWindow: import('electron').BrowserWindow | null;
 *   arduinoService: import('../services/arduinoService');
 *   serialMonitor: import('../services/serialMonitor');
 *   errorMemory: import('../services/errorMemory');
 *   aiAgent: import('../services/ai/agent');
 *   cloudAccount: import('../services/cloud/account').CloudAccount;
 *   chatStore: import('../services/chatStore');
 *   uiState: Record<string, unknown>;
 *   fsp: import('fs').promises;
 *   dialog: import('electron').Dialog;
 *   shell: import('electron').Shell;
 *   app: import('electron').App;
 * }} ctx
 */
function registerAllIpc(ipcMain, ctx) {
  appHandlers.register(ipcMain, ctx);
  shellHandlers.register(ipcMain, ctx);
  uiHandlers.register(ipcMain, ctx);
  arduinoHandlers.register(ipcMain, ctx);
  serialHandlers.register(ipcMain, ctx);
  dialogHandlers.register(ipcMain, ctx);
  fileHandlers.register(ipcMain, ctx);
  libHandlers.register(ipcMain, ctx);
  errorsHandlers.register(ipcMain, ctx);
  aiHandlers.register(ipcMain, ctx);
  cloudHandlers.register(ipcMain, ctx);
  learningHandlers.register(ipcMain, ctx);
  chatHandlers.register(ipcMain, ctx);
  sketchHandlers.register(ipcMain, ctx);
  problemHandlers.register(ipcMain, ctx);
  toolchainHandlers.register(ipcMain, ctx);
  platformioHandlers.register(ipcMain, ctx);
  gitHandlers.register(ipcMain, ctx);
  esp32simHandlers.register(ipcMain, ctx);
}

module.exports = { registerAllIpc };
