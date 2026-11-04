/**
 * Learning from fixes, as the window sees it: whether fixes are shared with
 * Impulse Cloud (an account-menu switch) and what is kept on this computer.
 * @module main/ipc/learningHandlers
 */
const { withDebugLog } = require('../utils/logger');

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ learning: { status: () => object, setShare: (on: boolean) => Promise<object> } | null }} ctx
 */
function register(ipcMain, ctx) {
  ipcMain.handle('learning:status', withDebugLog('learning:status', async () => {
    if (!ctx.learning) return { success: false, error: 'Learning is not set up.' };
    return { success: true, data: ctx.learning.status() };
  }));
  ipcMain.handle('learning:set-share', withDebugLog('learning:set-share', async (event, share) => {
    if (!ctx.learning) return { success: false, error: 'Learning is not set up.' };
    return { success: true, data: await ctx.learning.setShare(share === true) };
  }));
}

module.exports = { register };
