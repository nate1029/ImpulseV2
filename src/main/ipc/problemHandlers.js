/**
 * Problem reports and part requests: open a pre-filled GitHub issue after the
 * user has reviewed what it contains.
 * @module main/ipc/problemHandlers
 */

const { parseOrDefault, schemas } = require('./schemas');
const { withDebugLog } = require('../utils/logger');

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ shell: import('electron').Shell, problemReporter: import('../services/problemReporter').ProblemReporter }} ctx
 */
function register(ipcMain, ctx) {
  const { shell, problemReporter } = ctx;
  const fail = { success: false, error: 'Invalid input' };

  // The UI asks once it's ready (a push at load time would arrive too early).
  ipcMain.handle('problem:pending-crash', withDebugLog('problem:pending-crash', async () => {
    const crash = problemReporter.pendingCrash();
    return crash ? { id: crash.id, kind: crash.kind, at: crash.at, message: crash.message } : null;
  }));

  ipcMain.handle('problem:details', withDebugLog('problem:details', async (event, spec) => {
    const parsed = parseOrDefault(schemas.problemDetails, spec ?? {}, fail);
    if (!parsed.ok) return parsed.defaultResult;
    return { success: true, details: problemReporter.details({ crashId: parsed.data.crashId || null }) };
  }));

  ipcMain.handle('problem:report', withDebugLog('problem:report', async (event, spec) => {
    const parsed = parseOrDefault(schemas.problemReport, spec ?? {}, fail);
    if (!parsed.ok) return parsed.defaultResult;
    const { title, description, includeDetails, crashId } = parsed.data;
    try {
      await shell.openExternal(problemReporter.issueUrl({ title, description, includeDetails, crashId: crashId || null }));
      if (crashId) problemReporter.resolveCrash(crashId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Could not open the browser' };
    }
  }));

  ipcMain.handle('problem:dismiss-crash', withDebugLog('problem:dismiss-crash', async (event, spec) => {
    const parsed = parseOrDefault(schemas.problemDetails, spec ?? {}, fail);
    if (!parsed.ok || !parsed.data.crashId) return fail;
    return { success: problemReporter.resolveCrash(parsed.data.crashId) };
  }));

  ipcMain.handle('problem:request-part', withDebugLog('problem:request-part', async (event, spec) => {
    const parsed = parseOrDefault(schemas.partRequest, spec ?? {}, fail);
    if (!parsed.ok) return parsed.defaultResult;
    try {
      await shell.openExternal(problemReporter.partRequestUrl(parsed.data.query));
      return { success: true };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Could not open the browser' };
    }
  }));
}

module.exports = { register };
