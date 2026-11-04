/**
 * Source control IPC: status, init, diff, commit, history, push and pull for
 * a folder the user opened. Paths must be inside an approved folder.
 * @module main/ipc/gitHandlers
 */

const path = require('path');
const { GitService } = require('../services/git');
const { validatePath } = require('../utils/pathValidator');
const { withDebugLog } = require('../utils/logger');

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ git?: GitService }} ctx
 */
function register(ipcMain, ctx) {
  const git = ctx.git || new GitService();
  const allowed = (p) => typeof p === 'string' && p.length > 0 && validatePath(p).valid;
  const inside = (root, file) => {
    if (typeof file !== 'string' || !file) return false;
    const full = path.resolve(root, file);
    return full === root || full.startsWith(root + path.sep);
  };
  // Results as { success, data } or { success: false, error, needsIdentity }.
  const wrap = (channel, fn) => withDebugLog(channel, async (event, ...args) => {
    try {
      return { success: true, data: await fn(...args) };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Git failed', needsIdentity: !!error?.needsIdentity };
    }
  });
  const checked = (dir) => {
    if (!allowed(dir)) throw new Error('Open the folder in Impulse first.');
    return path.resolve(dir);
  };

  ipcMain.handle('git:status', wrap('git:status', (dir) => git.status(checked(dir))));
  ipcMain.handle('git:init', wrap('git:init', (dir) => git.init(checked(dir))));
  ipcMain.handle('git:diff', wrap('git:diff', (root, file) => {
    const r = checked(root);
    if (!inside(r, file)) throw new Error('That file is not in the repository.');
    return git.diff(r, file);
  }));
  ipcMain.handle('git:identity', wrap('git:identity', (root) => git.identity(checked(root))));
  ipcMain.handle('git:commit', wrap('git:commit', (root, message, identity) => git.commitAll(checked(root), String(message ?? ''),
    identity && typeof identity.name === 'string' && typeof identity.email === 'string' ? { name: identity.name.trim(), email: identity.email.trim() } : null)));
  ipcMain.handle('git:log', wrap('git:log', (root, count) => git.log(checked(root), Number(count) || 20)));
  ipcMain.handle('git:push', wrap('git:push', (root) => git.push(checked(root))));
  ipcMain.handle('git:pull', wrap('git:pull', (root) => git.pull(checked(root))));
}

module.exports = { register };
