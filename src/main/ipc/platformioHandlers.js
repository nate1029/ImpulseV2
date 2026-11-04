/**
 * PlatformIO project IPC: which project a file belongs to, its environments,
 * and the environment to build. Building and uploading go through the
 * arduino:* channels, which hand PlatformIO projects to `pio`.
 * @module main/ipc/platformioHandlers
 */

const { projectRoot } = require('../services/platformio');
const { validatePath } = require('../utils/pathValidator');

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ arduinoService: import('../services/arduinoService') }} ctx
 */
function register(ipcMain, { arduinoService }) {
  const pio = arduinoService.platformio;
  const allowed = (p) => typeof p === 'string' && p.length > 0 && validatePath(p).valid;

  ipcMain.handle('platformio:project', async (event, filePath) => {
    if (!allowed(filePath)) return null;
    const root = projectRoot(filePath);
    if (!root || !allowed(root)) return null;
    return pio.info(root);
  });

  ipcMain.handle('platformio:select-env', async (event, root, env) => {
    if (!allowed(root) || projectRoot(root) !== root || typeof env !== 'string' || !env) return null;
    const info = await pio.info(root);
    if (!info.envs.some(e => e.name === env)) return info;
    pio.select(root, env);
    return pio.info(root);
  });
}

module.exports = { register };
