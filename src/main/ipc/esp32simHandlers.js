/**
 * The ESP32 simulator: emulator install, sessions, and their I/O. Session
 * output streams to the window on 'esp32sim:event'; install progress on
 * 'esp32sim:progress'.
 * @module main/ipc/esp32simHandlers
 */

const { withDebugLog } = require('../utils/logger');

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ esp32sim: import('../services/esp32sim').Esp32Simulator, mainWindow: import('electron').BrowserWindow|null }} ctx
 */
function register(ipcMain, ctx) {
  const sim = ctx.esp32sim;
  if (!sim) return;
  const toWindow = (channel, payload) => {
    const win = ctx.mainWindow;
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  sim.on('event', (e) => toWindow('esp32sim:event', e));
  sim.on('progress', (p) => toWindow('esp32sim:progress', p));

  const chip = (v) => String(v || '').replace(/[^a-z0-9]/gi, '').slice(0, 16);
  const sessionId = (v) => (Number.isInteger(v) && v > 0 ? v : -1);

  ipcMain.handle('esp32sim:chip-of', withDebugLog('esp32sim:chip-of', async (event, fqbn) => {
    if (typeof fqbn !== 'string' || fqbn.length > 300) return null;
    return sim.chipOf(fqbn);
  }));

  ipcMain.handle('esp32sim:status', withDebugLog('esp32sim:status', async (event, c) => {
    try {
      return { success: true, data: sim.emulatorStatus(chip(c)) };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Could not check the emulator' };
    }
  }));

  ipcMain.handle('esp32sim:install', withDebugLog('esp32sim:install', async (event, c) => {
    try {
      return { success: true, data: await sim.installEmulator(chip(c)) };
    } catch (error) {
      return { success: false, error: error?.message ?? 'Could not install the emulator' };
    }
  }));

  ipcMain.handle('esp32sim:start', withDebugLog('esp32sim:start', async (event, imageId) => {
    if (typeof imageId !== 'string' || imageId.length > 80) return { success: false, error: 'Invalid program' };
    try {
      return { success: true, session: await sim.start(imageId) };
    } catch (error) {
      return { success: false, error: error?.message ?? 'The emulator didn\'t start' };
    }
  }));

  ipcMain.on('esp32sim:send', (event, id, lines) => {
    if (!Array.isArray(lines) || lines.length > 4096) return;
    sim.send(sessionId(id), lines.filter(l => typeof l === 'string' && l.length < 1024 && !l.includes('\n')));
  });

  ipcMain.on('esp32sim:write', (event, id, text) => {
    if (typeof text !== 'string' || text.length > 65536) return;
    sim.write(sessionId(id), text);
  });

  ipcMain.handle('esp32sim:control', withDebugLog('esp32sim:control', async (event, id, action) => {
    return sim.control(sessionId(id), String(action));
  }));
}

module.exports = { register };
