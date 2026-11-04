/**
 * Error memory IPC handlers.
 * @module main/ipc/errorsHandlers
 */

const { parseOrDefault, schemas } = require('./schemas');
const { withDebugLog } = require('../utils/logger');

const defaultFail = { success: false, error: 'Invalid input' };

/**
 * Register error memory IPC handlers.
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ errorMemory: import('../services/errorMemory') }} ctx
 */
function register(ipcMain, ctx) {
  const { errorMemory } = ctx;

  ipcMain.handle('errors:get-history', withDebugLog('errors:get-history', async () => {
    try {
      const history = await errorMemory.getHistory();
      return { success: true, data: history ?? [] };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Failed to get history' };
    }
  }));

  ipcMain.handle('errors:add-fix', withDebugLog('errors:add-fix', async (event, errorId, fix) => {
    const parsed = parseOrDefault(schemas.errorsAddFix, { errorId: errorId ?? null, fix }, defaultFail);
    if (!parsed.ok) return parsed.defaultResult;
    try {
      await errorMemory.addFix(parsed.data.errorId, parsed.data.fix);
      return { success: true };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Failed to add fix' };
    }
  }));
}

module.exports = { register };
