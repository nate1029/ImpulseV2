/**
 * Shell and external URL IPC handlers.
 * @module main/ipc/shellHandlers
 */

const { parseOrDefault, schemas } = require('./schemas');
const { withDebugLog } = require('../utils/logger');

/**
 * Register shell-related IPC handlers.
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ shell: import('electron').Shell }} ctx
 */
function register(ipcMain, ctx) {
  const { shell } = ctx;
  const defaultFail = { success: false };

  ipcMain.handle('shell:open-external', withDebugLog('shell:open-external', async (event, url) => {
    const parsed = parseOrDefault(schemas.shellOpenExternal, { url: url ?? '' }, defaultFail);
    if (!parsed.ok) return parsed.defaultResult;
    try {
      if (typeof parsed.data.url === 'string' && (parsed.data.url.startsWith('http://') || parsed.data.url.startsWith('https://'))) {
        await shell.openExternal(parsed.data.url);
        return { success: true };
      }
      return { success: false };
    } catch (e) {
      return { success: false, error: e?.message ?? 'Failed to open URL' };
    }
  }));

  ipcMain.handle('shell:show-item-in-folder', withDebugLog('shell:show-item-in-folder', async (event, fullPath) => {
    const parsed = parseOrDefault(schemas.shellShowItem, { fullPath: fullPath ?? '' }, defaultFail);
    if (!parsed.ok) return parsed.defaultResult;
    try {
      if (typeof parsed.data.fullPath === 'string' && parsed.data.fullPath.length > 0) {
        shell.showItemInFolder(parsed.data.fullPath);
        return { success: true };
      }
      return { success: false };
    } catch (e) {
      return { success: false, error: e?.message ?? 'Failed to show item' };
    }
  }));
}

module.exports = { register };
