/**
 * File dialog IPC handlers (open file, open folder, save new sketch, save as).
 * @module main/ipc/dialogHandlers
 */

const path = require('path');
const { parseOrDefault, schemas } = require('./schemas');
const { withDebugLog } = require('../utils/logger');
const { approveDirectory } = require('../utils/pathValidator');

const DEFAULT_SKETCH_TEMPLATE = `void setup() {
  // put your setup code here, to run once:

}

void loop() {
  // put your loop code here, to run repeatedly:

}
`;

const defaultFail = { success: false, error: 'Invalid input' };

/**
 * Register dialog IPC handlers.
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ mainWindow: import('electron').BrowserWindow | null, dialog: import('electron').Dialog, fsp: import('fs').promises, path: typeof path }} ctx
 */
function register(ipcMain, ctx) {
  const { mainWindow, dialog, fsp, workspace } = ctx;
  const remember = (folder) => { if (workspace) workspace.addRecent(folder); };

  ipcMain.handle('workspace:migrate-legacy-session', withDebugLog('workspace:migrate-legacy-session', async (event, folderPaths) => {
    return { success: true, approved: workspace ? workspace.migrateLegacySession(folderPaths) : [] };
  }));

  ipcMain.handle('dialog:open-file', withDebugLog('dialog:open-file', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Arduino Sketch',
        filters: [
          { name: 'Arduino Sketches', extensions: ['ino'] },
          { name: 'All Files', extensions: ['*'] }
        ],
        properties: ['openFile']
      });
      if (result.canceled) return { success: false, canceled: true };
      const filePath = result.filePaths?.[0] ?? null;
      // Approve the parent directory of the opened file
      if (filePath) {
        approveDirectory(path.dirname(filePath));
        remember(path.dirname(filePath));
      }
      return { success: true, filePath };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Dialog failed' };
    }
  }));

  ipcMain.handle('dialog:open-folder', withDebugLog('dialog:open-folder', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Open Folder (Sketchbook or Project)',
        properties: ['openDirectory']
      });
      if (result.canceled) return { success: false, canceled: true };
      const folderPath = result.filePaths?.[0] ?? null;
      // Approve the opened folder for subsequent file operations
      if (folderPath) {
        approveDirectory(folderPath);
        remember(folderPath);
      }
      return { success: true, folderPath };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Dialog failed' };
    }
  }));

  ipcMain.handle('dialog:save-new-sketch', withDebugLog('dialog:save-new-sketch', async () => {
    try {
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
      const defaultName = `sketch_${dateStr}.ino`;
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'New Sketch - Choose location and name',
        defaultPath: defaultName,
        filters: [
          { name: 'Arduino Sketch', extensions: ['ino'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });
      if (result.canceled || !result.filePath) return { success: false, canceled: true };
      let filePath = result.filePath;
      if (!filePath.toLowerCase().endsWith('.ino')) filePath = filePath + '.ino';
      const sketchName = path.basename(filePath, '.ino');
      const folderPath = path.join(path.dirname(filePath), sketchName);
      await fsp.mkdir(folderPath, { recursive: true });
      const mainInoPath = path.join(folderPath, sketchName + '.ino');
      await fsp.writeFile(mainInoPath, DEFAULT_SKETCH_TEMPLATE, 'utf8');
      approveDirectory(folderPath);
      remember(folderPath);
      return { success: true, folderPath, filePath: mainInoPath, sketchName: sketchName + '.ino' };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Save failed' };
    }
  }));

  ipcMain.handle('dialog:save-as-sketch', withDebugLog('dialog:save-as-sketch', async (event, content) => {
    const parsed = parseOrDefault(schemas.saveAsSketch, { content: content ?? null }, defaultFail);
    if (!parsed.ok) return parsed.defaultResult;
    try {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Sketch As',
        defaultPath: 'sketch_save_as.ino',
        filters: [
          { name: 'Arduino Sketch', extensions: ['ino'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });
      if (result.canceled || !result.filePath) return { success: false, canceled: true };
      let filePath = result.filePath;
      if (!filePath.toLowerCase().endsWith('.ino')) filePath = filePath + '.ino';
      const sketchName = path.basename(filePath, '.ino');
      const folderPath = path.join(path.dirname(filePath), sketchName);
      await fsp.mkdir(folderPath, { recursive: true });
      const mainInoPath = path.join(folderPath, sketchName + '.ino');
      const text = typeof parsed.data.content === 'string' ? parsed.data.content : DEFAULT_SKETCH_TEMPLATE;
      await fsp.writeFile(mainInoPath, text, 'utf8');
      approveDirectory(folderPath);
      remember(folderPath);
      return { success: true, folderPath, filePath: mainInoPath, sketchName: sketchName + '.ino' };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Save failed' };
    }
  }));
}

module.exports = { register };
