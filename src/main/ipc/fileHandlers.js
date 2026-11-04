/**
 * File and folder IPC handlers (read, save, list directory).
 * All paths are validated against user-approved directories.
 * @module main/ipc/fileHandlers
 */

const path = require('path');
const { parseOrDefault, schemas } = require('./schemas');
const { withDebugLog } = require('../utils/logger');
const { validatePath } = require('../utils/pathValidator');

const defaultFail = { success: false, error: 'Invalid input' };

/** Sketch sources and the files that belong with them. */
const EDITABLE = /\.(ino|pde|cpp|c|h|hpp|txt|md|json|csv|properties)$/i;

/**
 * Register file/folder IPC handlers.
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ fsp: import('fs').promises, path: typeof path, shell: import('electron').Shell }} ctx
 */
function register(ipcMain, ctx) {
  const { fsp, shell } = ctx;

  ipcMain.handle('folder:list', withDebugLog('folder:list', async (event, dirPath) => {
    const parsed = parseOrDefault(schemas.folderList, { dirPath: dirPath ?? '' }, defaultFail);
    if (!parsed.ok) return parsed.defaultResult;

    const pathCheck = validatePath(parsed.data.dirPath);
    if (!pathCheck.valid) return { success: false, error: pathCheck.error };

    try {
      const entries = await fsp.readdir(pathCheck.resolved, { withFileTypes: true });
      const list = entries
        .filter(e => !e.name.startsWith('.'))
        .map(e => ({
          name: e.name,
          path: path.join(pathCheck.resolved, e.name),
          isDirectory: e.isDirectory()
        }))
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        });
      return { success: true, entries: list };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Failed to list folder' };
    }
  }));

  // New file in a folder the user opened. The folder decides where it can go.
  ipcMain.handle('file:new', withDebugLog('file:new', async (event, dirPath, name) => {
    const parsed = parseOrDefault(schemas.fileNew, { dirPath: dirPath ?? '', name: name ?? '' }, defaultFail);
    if (!parsed.ok) return parsed.defaultResult;
    const dir = validatePath(parsed.data.dirPath, { write: true });
    if (!dir.valid) return { success: false, error: dir.error };
    const target = path.join(dir.resolved, parsed.data.name);
    const check = validatePath(target, { write: true });
    if (!check.valid) return { success: false, error: check.error };
    if (!EDITABLE.test(target)) return { success: false, error: 'Impulse makes sketch files: .ino, .cpp, .h, .txt, .md, .json.' };
    try {
      // 'wx' fails when the file is already there, so nothing is overwritten.
      await fsp.writeFile(check.resolved, '', { encoding: 'utf8', flag: 'wx' });
      return { success: true, path: check.resolved, name: parsed.data.name };
    } catch (error) {
      if (error?.code === 'EEXIST') return { success: false, error: `${parsed.data.name} already exists in this folder.` };
      return { success: false, error: error?.message ?? 'Could not make the file' };
    }
  }));

  ipcMain.handle('file:rename', withDebugLog('file:rename', async (event, filePath, name) => {
    const parsed = parseOrDefault(schemas.fileRename, { filePath: filePath ?? '', name: name ?? '' }, defaultFail);
    if (!parsed.ok) return parsed.defaultResult;
    const from = validatePath(parsed.data.filePath, { write: true });
    if (!from.valid) return { success: false, error: from.error };
    const target = path.join(path.dirname(from.resolved), parsed.data.name);
    const to = validatePath(target, { write: true });
    if (!to.valid) return { success: false, error: to.error };
    if (!EDITABLE.test(target)) return { success: false, error: 'Keep a sketch file\'s extension (.ino, .cpp, .h…).' };
    try {
      await fsp.access(to.resolved);
      return { success: false, error: `${parsed.data.name} already exists in this folder.` };
    } catch { /* free */ }
    try {
      await fsp.rename(from.resolved, to.resolved);
      return { success: true, path: to.resolved, name: parsed.data.name, from: from.resolved };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Could not rename the file' };
    }
  }));

  // Deleting moves the file to the Trash: it can always be put back.
  ipcMain.handle('file:delete', withDebugLog('file:delete', async (event, filePath) => {
    const parsed = parseOrDefault(schemas.fileDelete, { filePath: filePath ?? '' }, defaultFail);
    if (!parsed.ok) return parsed.defaultResult;
    const check = validatePath(parsed.data.filePath, { write: true });
    if (!check.valid) return { success: false, error: check.error };
    try {
      const stat = await fsp.stat(check.resolved);
      if (stat.isDirectory()) return { success: false, error: 'This deletes files, not folders.' };
      await shell.trashItem(check.resolved);
      return { success: true, path: check.resolved, trashed: true };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Could not delete the file' };
    }
  }));

  ipcMain.handle('file:read', withDebugLog('file:read', async (event, filePath) => {
    const parsed = parseOrDefault(schemas.fileRead, { filePath: filePath ?? '' }, defaultFail);
    if (!parsed.ok) return parsed.defaultResult;

    const pathCheck = validatePath(parsed.data.filePath);
    if (!pathCheck.valid) return { success: false, error: pathCheck.error };

    try {
      const content = await fsp.readFile(pathCheck.resolved, 'utf8');
      return { success: true, content };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Failed to read file' };
    }
  }));

  ipcMain.handle('file:save', withDebugLog('file:save', async (event, filePath, content) => {
    const parsed = parseOrDefault(schemas.fileSave, { filePath: filePath ?? '', content: content ?? '' }, defaultFail);
    if (!parsed.ok) return parsed.defaultResult;

    const pathCheck = validatePath(parsed.data.filePath, { write: true });
    if (!pathCheck.valid) return { success: false, error: pathCheck.error };

    try {
      await fsp.writeFile(pathCheck.resolved, parsed.data.content, 'utf8');
      return { success: true };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Failed to save file' };
    }
  }));
}

module.exports = { register };
