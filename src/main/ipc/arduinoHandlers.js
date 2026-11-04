/**
 * Arduino CLI IPC handlers (compile, upload, boards, ports).
 * @module main/ipc/arduinoHandlers
 */

const { parseOrDefault, schemas } = require('./schemas');
const { withDebugLog } = require('../utils/logger');
const path = require('path');
const { approveDirectory, validatePath } = require('../utils/pathValidator');

const defaultFail = { success: false, error: 'Invalid input' };

/**
 * Register Arduino CLI IPC handlers.
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ arduinoService: import('../services/arduinoService'), errorMemory: import('../services/errorMemory') }} ctx
 */
function register(ipcMain, ctx) {
  const { arduinoService, errorMemory, dialog, mainWindow } = ctx;
  const denied = (sketchPath) => {
    const check = validatePath(sketchPath || '');
    return check.valid ? null : { success: false, error: check.error };
  };

  /** A failed build job, with everything the window and the agent show: code, title, hint, diagnostics, memory, output. */
  const failed = (result, fallback) => ({
    success: false,
    error: result.title || result.error?.message || result.error || result.message || fallback,
    code: result.code || result.error?.code || null,
    title: result.title || null,
    hint: result.hint || '',
    excerpt: result.excerpt || '',
    errors: Array.isArray(result.errors) ? result.errors : undefined,
    diagnostics: Array.isArray(result.diagnostics) ? result.diagnostics : [],
    memory: result.memory || null,
    summary: Array.isArray(result.summary) ? result.summary : [],
    output: typeof result.output === 'string' ? result.output : undefined,
    busy: result.busy || null,
  });

  // The board catalog (knowledge/boards/catalog.json): the boards the picker shows first, each with the core it needs.
  ipcMain.handle('arduino:board-catalog', withDebugLog('arduino:board-catalog', async () => {
    const { popularBoards } = require('../services/ai/knowledge/boardRecords');
    const { extraCoreFor } = require('../services/toolchain');
    return { success: true, data: popularBoards().map((b) => ({ ...b, coreKey: extraCoreFor(b.fqbn) })) };
  }));

  ipcMain.handle('arduino:cancel-build', withDebugLog('arduino:cancel-build', async () => ({ success: true, cancelled: arduinoService.jobs.cancel() })));
  ipcMain.handle('arduino:build-status', withDebugLog('arduino:build-status', async () => ({ success: true, data: arduinoService.jobs.status() })));

  ipcMain.handle('arduino:compile', withDebugLog('arduino:compile', async (event, sketchPath, boardFQBN) => {
    const parsed = parseOrDefault(schemas.arduinoCompile, { sketchPath: sketchPath ?? '', boardFQBN: boardFQBN ?? '' }, defaultFail);
    if (!parsed.ok) return parsed.defaultResult;
    const blocked = denied(parsed.data.sketchPath);
    if (blocked) return blocked;
    try {
      const result = await arduinoService.compile(parsed.data.sketchPath, parsed.data.boardFQBN);
      if (result && result.success === false) return failed(result, 'Compile failed');
      return { success: true, data: result };
    } catch (error) {
      const analyzedError = await errorMemory.analyzeError(error).catch(() => null);
      return {
        success: false,
        error: error?.message ?? 'Compile failed',
        errors: Array.isArray(error?.errors) ? error.errors : undefined,
        output: typeof error?.output === 'string' ? error.output : undefined,
        analyzedError
      };
    }
  }));

  ipcMain.handle('arduino:compile-hex', withDebugLog('arduino:compile-hex', async (event, sketchPath, boardFQBN, options) => {
    const blocked = denied(sketchPath);
    if (blocked) return blocked;
    const properties = options && typeof options.properties === 'object' ? options.properties : undefined;
    return arduinoService.compileHex(sketchPath, boardFQBN || 'arduino:avr:uno', { properties });
  }));

  ipcMain.handle('arduino:compile-debug', withDebugLog('arduino:compile-debug', async (event, sketchPath, boardFQBN) => {
    const blocked = denied(sketchPath);
    if (blocked) return blocked;
    return arduinoService.compileDebug(sketchPath, boardFQBN || 'arduino:avr:uno');
  }));

  ipcMain.handle('arduino:export-binaries', withDebugLog('arduino:export-binaries', async (event, sketchPath, boardFQBN) => {
    const blocked = denied(sketchPath);
    if (blocked) return blocked;
    return arduinoService.exportBinaries(sketchPath, boardFQBN);
  }));

  ipcMain.handle('arduino:archive-sketch', withDebugLog('arduino:archive-sketch', async (event, sketchPath) => {
    const blocked = denied(sketchPath);
    if (blocked) return blocked;
    const dir = arduinoService.sketchDir(sketchPath);
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Archive Sketch',
      defaultPath: path.join(path.dirname(dir), `${path.basename(dir)}.zip`),
      filters: [{ name: 'Zip archive', extensions: ['zip'] }]
    });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };
    const dest = result.filePath.toLowerCase().endsWith('.zip') ? result.filePath : `${result.filePath}.zip`;
    return arduinoService.archiveSketch(sketchPath, dest);
  }));

  ipcMain.handle('arduino:list-programmers', withDebugLog('arduino:list-programmers', async (event, boardFQBN) => {
    return { success: true, data: await arduinoService.listProgrammers(typeof boardFQBN === 'string' ? boardFQBN : '') };
  }));

  ipcMain.handle('arduino:upload-programmer', withDebugLog('arduino:upload-programmer', async (event, sketchPath, boardFQBN, programmerId, port) => {
    const blocked = denied(sketchPath);
    if (blocked) return blocked;
    if (typeof programmerId !== 'string' || !/^[\w.-]+$/.test(programmerId)) return { success: false, error: 'Choose a programmer.' };
    return arduinoService.uploadWithProgrammer(sketchPath, boardFQBN, programmerId, typeof port === 'string' ? port : '');
  }));

  ipcMain.handle('arduino:board-info', withDebugLog('arduino:board-info', async (event, port) => {
    if (typeof port !== 'string' || !port) return { success: false, error: 'Select a port first.' };
    return arduinoService.boardInfo(port);
  }));

  ipcMain.handle('arduino:upload', withDebugLog('arduino:upload', async (event, sketchPath, boardFQBN, port) => {
    const parsed = parseOrDefault(schemas.arduinoUpload, { sketchPath: sketchPath ?? '', boardFQBN: boardFQBN ?? '', port: port ?? '' }, defaultFail);
    if (!parsed.ok) return parsed.defaultResult;
    const blocked = denied(parsed.data.sketchPath);
    if (blocked) return blocked;
    try {
      const result = await arduinoService.upload(parsed.data.sketchPath, parsed.data.boardFQBN, parsed.data.port);
      if (result && result.success === false) return failed(result, 'Upload failed');
      return { success: true, data: result };
    } catch (error) {
      const analyzedError = await errorMemory.analyzeError(error).catch(() => null);
      return { success: false, error: error?.message ?? 'Upload failed', analyzedError };
    }
  }));

  ipcMain.handle('arduino:list-boards', withDebugLog('arduino:list-boards', async () => {
    try {
      const boards = await arduinoService.listBoards();
      return { success: true, data: boards ?? [] };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Failed to list boards' };
    }
  }));

  ipcMain.handle('arduino:board-options', withDebugLog('arduino:board-options', async (event, boardFQBN) => {
    if (typeof boardFQBN !== 'string' || boardFQBN.length > 300) return { success: false, error: 'Invalid board' };
    return { success: true, data: await arduinoService.boardOptions(boardFQBN) };
  }));

  ipcMain.handle('arduino:list-ports', withDebugLog('arduino:list-ports', async () => {
    try {
      const ports = await arduinoService.listPorts();
      return { success: true, data: ports ?? [] };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Failed to list ports' };
    }
  }));

  ipcMain.handle('arduino:check-cli', withDebugLog('arduino:check-cli', async () => {
    try {
      const installed = await arduinoService.checkCLI();
      return { success: true, installed: !!installed };
    } catch (error) {
      return { success: false, error: error?.message ?? 'CLI check failed', installed: false };
    }
  }));

  // Board Manager: core search, list, install, uninstall
  ipcMain.handle('arduino:core-search', withDebugLog('arduino:core-search', async (event, keyword) => {
    try {
      const list = await arduinoService.coreSearch(keyword ?? '');
      return { success: true, data: Array.isArray(list) ? list : [] };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Core search failed', data: [] };
    }
  }));

  ipcMain.handle('arduino:core-list', withDebugLog('arduino:core-list', async () => {
    try {
      const list = await arduinoService.coreList();
      return { success: true, data: Array.isArray(list) ? list : [] };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Core list failed', data: [] };
    }
  }));

  ipcMain.handle('arduino:core-install', withDebugLog('arduino:core-install', async (event, coreId) => {
    const id = coreId ?? '';
    if (!id || typeof id !== 'string') return { success: false, error: 'Core ID required' };
    try {
      await arduinoService.coreInstall(id.trim());
      return { success: true };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Core install failed' };
    }
  }));

  ipcMain.handle('arduino:core-uninstall', withDebugLog('arduino:core-uninstall', async (event, coreId) => {
    const id = coreId ?? '';
    if (!id || typeof id !== 'string') return { success: false, error: 'Core ID required' };
    try {
      await arduinoService.coreUninstall(id.trim());
      return { success: true };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Core uninstall failed' };
    }
  }));

  // Examples (from installed libraries / cores)
  ipcMain.handle('arduino:lib-examples', withDebugLog('arduino:lib-examples', async (event, libraryName) => {
    try {
      const list = await arduinoService.libExamples(libraryName ?? '');
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && typeof item.path === 'string') approveDirectory(item.path, { readOnly: true });
        }
      }
      return { success: true, data: Array.isArray(list) ? list : [] };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Examples list failed', data: [] };
    }
  }));

  ipcMain.handle('arduino:lib-examples-with-paths', withDebugLog('arduino:lib-examples-with-paths', async (event, libraryFilter) => {
    try {
      const list = await arduinoService.libExamplesWithPaths(libraryFilter ?? '');
      // Examples live outside user-opened folders (in the libraries install dir).
      // Approve each example folder so folder:list / file:read can open them.
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item && typeof item.path === 'string') approveDirectory(item.path, { readOnly: true });
        }
      }
      return { success: true, data: Array.isArray(list) ? list : [] };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Examples list failed', data: [] };
    }
  }));
}

module.exports = { register };
