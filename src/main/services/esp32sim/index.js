/**
 * The ESP32 simulator's main-process side: builds sketches for it, keeps the
 * emulator installed and runs sessions, streaming their output to the window
 * ('event' with { session, type: 'serial' | 'bridge' | 'exit', data }).
 * @module main/services/esp32sim
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Esp32Session } = require('./session');
const { Esp32SimBuilder } = require('./build');
const { QemuManager } = require('./qemu');

const MAX_SESSIONS = 4;

class Esp32Simulator extends EventEmitter {
  /**
   * @param {{ runCli: Function, dataDir: string, bundledDir?: string|null, workDir?: string }} opts
   */
  constructor({ runCli, dataDir, bundledDir = null, workDir }) {
    super();
    this.builder = new Esp32SimBuilder({ runCli, workDir });
    this.qemu = new QemuManager({ dataDir, bundledDir });
    this.qemu.on('progress', (p) => this.emit('progress', p));
    this.sessions = new Map();
    this._nextId = 1;
  }

  build(sketchDir, fqbn) {
    return this.builder.build(sketchDir, fqbn);
  }

  chipOf(fqbn) {
    return this.builder.chipOf(fqbn);
  }

  emulatorStatus(chip) {
    const arch = Esp32Session.archOf(chip);
    if (!arch) return { arch: null, installed: false, supported: false };
    return this.qemu.status(arch);
  }

  async installEmulator(chip) {
    const arch = Esp32Session.archOf(chip);
    if (!arch) throw new Error(`The ${chip} isn't emulated.`);
    await this.qemu.ensure(arch);
    const problem = this.qemu.check(arch);
    if (problem) throw new Error(problem);
    return this.qemu.status(arch);
  }

  /** Boot a built image; resolves with the session id once QEMU is connected. */
  async start(imageId) {
    const image = this.builder.imageForRun(imageId);
    if (!image) throw new Error('The compiled program is gone. Run the sketch again.');
    const arch = Esp32Session.archOf(image.chip);
    const qemu = this.qemu.binary(arch);
    if (!qemu) throw new Error('The ESP32 emulator isn\'t installed.');
    while (this.sessions.size >= MAX_SESSIONS) this.stop(this.sessions.keys().next().value);
    const id = this._nextId++;
    const session = new Esp32Session({ qemu, chip: image.chip, flashPath: image.runPath, psramMB: image.psramMB });
    this.sessions.set(id, session);
    session.on('serial', (data) => this.emit('event', { session: id, type: 'serial', data: data.toString('latin1') }));
    session.on('bridge', (lines) => this.emit('event', { session: id, type: 'bridge', data: lines }));
    session.on('exit', (why) => {
      this.sessions.delete(id);
      fs.rm(image.runPath, { force: true }, () => {});
      this.emit('event', { session: id, type: 'exit', data: why });
    });
    try {
      await session.start();
    } catch (err) {
      this.sessions.delete(id);
      fs.rm(image.runPath, { force: true }, () => {});
      throw err;
    }
    return id;
  }

  send(id, lines) {
    this.sessions.get(id)?.sendBridge(lines);
  }

  write(id, text) {
    this.sessions.get(id)?.writeSerial(Buffer.from(String(text), 'latin1'));
  }

  control(id, action) {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (action === 'pause') s.pause();
    else if (action === 'resume') s.resume();
    else if (action === 'reset') s.reset();
    else if (action === 'stop') s.stop();
    else return false;
    return true;
  }

  stop(id) {
    this.sessions.get(id)?.stop();
    this.sessions.delete(id);
  }

  stopAll() {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }
}

/**
 * The connection the renderer's Esp32Runner uses, for a simulator in the
 * same process (the command-line runner, tests): the shape of the preload's
 * electronAPI.esp32sim.
 */
function localBridge(sim) {
  return {
    start: async (imageId) => {
      try {
        return { success: true, session: await sim.start(imageId) };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
    send: (id, lines) => sim.send(id, lines),
    write: (id, text) => sim.write(id, text),
    control: async (id, action) => sim.control(id, action),
    onEvent: (callback) => {
      sim.on('event', callback);
      return () => sim.off('event', callback);
    },
  };
}

/** Emulators bundled with the app (macOS), or null. */
function bundledQemuDir(resourcesPath = process.resourcesPath) {
  const dir = resourcesPath && path.join(resourcesPath, 'qemu');
  return dir && fs.existsSync(dir) ? dir : null;
}

/** The emulators scripts/qemu-mac-pack.mjs bundled in a checkout (running from source), or null. */
function packedQemuDir(repoRoot = path.join(__dirname, '..', '..', '..', '..')) {
  const dir = path.join(repoRoot, 'build', `qemu-${process.arch === 'arm64' ? 'arm64' : 'x64'}`);
  return process.platform === 'darwin' && fs.existsSync(dir) ? dir : null;
}

module.exports = { Esp32Simulator, bundledQemuDir, packedQemuDir, localBridge };
