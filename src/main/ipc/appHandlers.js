/**
 * App-level IPC handlers (quit, clipboard, bundled documents).
 * @module main/ipc/appHandlers
 */

const fs = require('fs');
const path = require('path');
const { clipboard } = require('electron');
const logger = require('../utils/logger');

/**
 * Register app IPC handlers.
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ app: import('electron').App } } ctx
 */
function register(ipcMain, ctx) {
  const { app } = ctx;
  ipcMain.on('app:quit', () => app.quit());
  ipcMain.handle('app:get-version', () => app.getVersion());
  // Privacy policy and open-source notices shipped with the app (About dialog).
  const DOCS = { privacy: 'PRIVACY.md', licenses: 'THIRD_PARTY_NOTICES.md' };
  ipcMain.handle('app:read-doc', async (event, name) => {
    const file = Object.prototype.hasOwnProperty.call(DOCS, name) ? DOCS[name] : null;
    if (!file) return { success: false, error: 'Unknown document' };
    try {
      const text = await fs.promises.readFile(path.join(app.getAppPath(), file), 'utf8');
      return { success: true, text };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Could not read the document' };
    }
  });

  ipcMain.on('app:log-renderer-error', (event, entry) => {
    if (!entry || typeof entry !== 'object') return;
    const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
    logger.error('renderer', { message: clip(entry.message, 2000), source: clip(entry.source, 300), stack: clip(entry.stack, 4000) });
  });

  // Clipboard bridge — renderer text fields need real paste (execCommand('paste')
  // is a no-op in Electron renderers, and the Edit-menu accelerator swallows Cmd+V).
  ipcMain.handle('clipboard:read-text', () => clipboard.readText());
  ipcMain.handle('clipboard:write-text', (event, text) => {
    if (typeof text === 'string' && text.length <= 1_000_000) clipboard.writeText(text);
    return true;
  });
}

module.exports = { register };
