/**
 * Library manager IPC handlers (search, install, list, uninstall, update index).
 * @module main/ipc/libHandlers
 */

const { parseOrDefault, schemas } = require('./schemas');
const { withDebugLog } = require('../utils/logger');

const defaultFail = { success: false, error: 'Invalid input' };

/**
 * Register library IPC handlers.
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ arduinoService: import('../services/arduinoService') }} ctx
 */
function register(ipcMain, ctx) {
  const { arduinoService } = ctx;

  ipcMain.handle('lib:search', withDebugLog('lib:search', async (event, query) => {
    const parsed = parseOrDefault(schemas.libSearch, { query: query ?? '' }, defaultFail);
    if (!parsed.ok) return parsed.defaultResult;
    try {
      const data = await arduinoService.libSearch(parsed.data.query ?? '');
      return { success: true, data: data ?? {} };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Search failed' };
    }
  }));

  ipcMain.handle('lib:install', withDebugLog('lib:install', async (event, libSpec) => {
    const parsed = parseOrDefault(schemas.libInstall, { libSpec: libSpec ?? '' }, defaultFail);
    if (!parsed.ok) return parsed.defaultResult;
    try {
      await arduinoService.libInstall(parsed.data.libSpec);
      return { success: true };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Install failed' };
    }
  }));

  ipcMain.handle('lib:list', withDebugLog('lib:list', async () => {
    try {
      const data = await arduinoService.libList();
      return { success: true, data: data ?? {} };
    } catch (error) {
      return { success: false, error: error?.message ?? 'List failed' };
    }
  }));

  ipcMain.handle('lib:update-index', withDebugLog('lib:update-index', async () => {
    try {
      await arduinoService.libUpdateIndex();
      return { success: true };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Update index failed' };
    }
  }));

  // The richer library surface both views use: the index with what each library
  // provides, what a sketch is missing, and installs with progress.
  ipcMain.handle('lib:find', withDebugLog('lib:find', async (event, query, fqbn) => {
    const parsed = parseOrDefault(schemas.libFind, { query: query ?? '', fqbn: fqbn ?? '' }, defaultFail);
    if (!parsed.ok) return parsed.defaultResult;
    try {
      return { success: true, data: await arduinoService.libraries.search(parsed.data.query, { fqbn: parsed.data.fqbn }) };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Search failed' };
    }
  }));

  ipcMain.handle('lib:installed', withDebugLog('lib:installed', async () => {
    try {
      return { success: true, data: await arduinoService.libraries.installed({ refresh: true }) };
    } catch (error) {
      return { success: false, error: error?.message ?? 'List failed' };
    }
  }));

  ipcMain.handle('lib:missing', withDebugLog('lib:missing', async (event, code, fqbn) => {
    const parsed = parseOrDefault(schemas.libMissing, { code: code ?? '', fqbn: fqbn ?? '' }, defaultFail);
    if (!parsed.ok) return parsed.defaultResult;
    try {
      return { success: true, data: await arduinoService.libraries.missingFor(parsed.data.code, { fqbn: parsed.data.fqbn }) };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Could not check the libraries' };
    }
  }));

  ipcMain.handle('lib:add', withDebugLog('lib:add', async (event, name, version) => {
    const parsed = parseOrDefault(schemas.libAdd, { name: name ?? '', version: version ?? '' }, defaultFail);
    if (!parsed.ok) return parsed.defaultResult;
    const send = (progress) => { if (!event.sender.isDestroyed()) event.sender.send('lib:progress', progress); };
    try {
      send({ name: parsed.data.name, state: 'installing' });
      const res = await arduinoService.libraries.install(parsed.data.name, {
        version: parsed.data.version,
        onOutput: (text) => send({ name: parsed.data.name, state: 'installing', message: String(text).trim().split('\n').pop() }),
      });
      send({ name: parsed.data.name, state: 'done' });
      return { success: true, data: res };
    } catch (error) {
      send({ name: parsed.data.name, state: 'failed', message: error?.message });
      return { success: false, error: error?.message ?? 'Install failed' };
    }
  }));

  ipcMain.handle('lib:remove', withDebugLog('lib:remove', async (event, name) => {
    const parsed = parseOrDefault(schemas.libUninstall, { libName: name ?? '' }, defaultFail);
    if (!parsed.ok) return parsed.defaultResult;
    try {
      return { success: true, data: await arduinoService.libraries.uninstall(parsed.data.libName) };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Uninstall failed' };
    }
  }));

  ipcMain.handle('lib:uninstall', withDebugLog('lib:uninstall', async (event, libName) => {
    const parsed = parseOrDefault(schemas.libUninstall, { libName: libName ?? '' }, defaultFail);
    if (!parsed.ok) return parsed.defaultResult;
    try {
      await arduinoService.libUninstall(parsed.data.libName);
      return { success: true };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Uninstall failed' };
    }
  }));
}

module.exports = { register };
