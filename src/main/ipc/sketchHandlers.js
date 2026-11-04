/**
 * Simulator project IPC handlers: create an example sketch (sketch + diagram.json)
 * in the sketchbook, and import/export diagram.json files.
 * @module main/ipc/sketchHandlers
 */

const path = require('path');
const { parseOrDefault, schemas } = require('./schemas');
const { withDebugLog } = require('../utils/logger');
const { approveDirectory } = require('../utils/pathValidator');

const defaultFail = { success: false, error: 'Invalid input' };
const MAX_DIAGRAM_BYTES = 4 * 1024 * 1024;

/**
 * Register sketch/diagram IPC handlers.
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ mainWindow, dialog, fsp, app, arduinoService, workspace }} ctx
 */
function register(ipcMain, ctx) {
  const { dialog, fsp, app, arduinoService, workspace } = ctx;
  const win = () => ctx.mainWindow || null;

  async function sketchbookDir() {
    try {
      const res = await arduinoService?.runCommand?.(['config', 'get', 'directories.user'], { timeout: 10000 });
      const dir = res?.success ? String(res.stdout || '').trim() : '';
      if (dir && path.isAbsolute(dir)) return dir;
    } catch { /* fall back to the default sketchbook */ }
    return path.join(app.getPath('documents'), 'Arduino');
  }

  async function freeFolder(base, name) {
    for (let n = 1; n < 1000; n++) {
      const folder = path.join(base, n === 1 ? name : `${name}_${n}`);
      try {
        await fsp.access(folder);
      } catch {
        return folder;
      }
    }
    throw new Error('Too many copies of this example already exist.');
  }

  ipcMain.handle('sketch:create-example', withDebugLog('sketch:create-example', async (event, spec) => {
    const parsed = parseOrDefault(schemas.exampleCreate, spec ?? {}, defaultFail);
    if (!parsed.ok) return { success: false, error: parsed.error };
    const { name, code, diagram } = parsed.data;
    try {
      const base = path.join(await sketchbookDir(), 'Impulse Examples');
      await fsp.mkdir(base, { recursive: true });
      const folder = await freeFolder(base, name.replace(/-/g, '_'));
      await fsp.mkdir(folder, { recursive: true });
      // Arduino requires the main .ino to be named after its folder.
      const filePath = path.join(folder, `${path.basename(folder)}.ino`);
      await fsp.writeFile(filePath, code, 'utf8');
      await fsp.writeFile(path.join(folder, 'diagram.json'), diagram, 'utf8');
      approveDirectory(folder);
      if (workspace) workspace.addRecent(folder);
      return { success: true, folderPath: folder, filePath };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Could not create the example' };
    }
  }));

  // Chat mode: a new chat's project, in the sketchbook's "Impulse Projects".
  ipcMain.handle('sketch:create-project', withDebugLog('sketch:create-project', async (event, spec) => {
    const parsed = parseOrDefault(schemas.projectCreate, spec ?? {}, defaultFail);
    if (!parsed.ok) return { success: false, error: parsed.error };
    try {
      const base = path.join(await sketchbookDir(), 'Impulse Projects');
      await fsp.mkdir(base, { recursive: true });
      const folder = await freeFolder(base, parsed.data.name);
      await fsp.mkdir(folder, { recursive: true });
      const filePath = path.join(folder, `${path.basename(folder)}.ino`);
      await fsp.writeFile(filePath, 'void setup() {\n}\n\nvoid loop() {\n}\n', 'utf8');
      approveDirectory(folder);
      if (workspace) workspace.addRecent(folder);
      return { success: true, folderPath: folder, filePath, name: path.basename(folder) };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Could not create the project' };
    }
  }));

  ipcMain.handle('dialog:open-diagram', withDebugLog('dialog:open-diagram', async () => {
    try {
      const result = await dialog.showOpenDialog(win(), {
        title: 'Import circuit (diagram.json)',
        filters: [{ name: 'Wokwi / Impulse diagram', extensions: ['json'] }],
        properties: ['openFile'],
      });
      if (result.canceled || !result.filePaths?.[0]) return { success: false, canceled: true };
      const filePath = result.filePaths[0];
      const stat = await fsp.stat(filePath);
      if (stat.size > MAX_DIAGRAM_BYTES) return { success: false, error: 'That file is too large to be a diagram.' };
      const content = await fsp.readFile(filePath, 'utf8');
      return { success: true, filePath, content };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Could not open the file' };
    }
  }));

  ipcMain.handle('dialog:save-diagram', withDebugLog('dialog:save-diagram', async (event, content, suggestedName) => {
    const parsed = parseOrDefault(schemas.diagramSave, { content: content ?? '', suggestedName: suggestedName ?? 'diagram.json' }, defaultFail);
    if (!parsed.ok) return { success: false, error: parsed.error };
    try {
      const result = await dialog.showSaveDialog(win(), {
        title: 'Export circuit',
        defaultPath: parsed.data.suggestedName,
        filters: [{ name: 'Wokwi / Impulse diagram', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return { success: false, canceled: true };
      const filePath = result.filePath.toLowerCase().endsWith('.json') ? result.filePath : `${result.filePath}.json`;
      await fsp.writeFile(filePath, parsed.data.content, 'utf8');
      return { success: true, filePath };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Could not save the file' };
    }
  }));
}

module.exports = { register };
