/**
 * PlatformIO projects: a folder with platformio.ini is built and uploaded
 * with PlatformIO Core (`pio`) instead of arduino-cli. Environments using
 * the Arduino framework on an Uno, Nano or Mega 2560 can be simulated and
 * debugged like sketches.
 * @module main/services/platformio
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** PlatformIO board ids the simulator runs, by simulated board. */
const SIM_BOARDS = {
  uno: 'uno',
  nanoatmega328: 'nano',
  nanoatmega328new: 'nano',
  megaatmega2560: 'mega',
};

/** Simulated board → arduino-cli FQBN prefix it answers to. */
const SIM_FQBN = { uno: 'arduino:avr:uno', nano: 'arduino:avr:nano', mega: 'arduino:avr:mega' };

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** The folder holding platformio.ini at or above `p` (a file or folder), or null. */
function projectRoot(p) {
  if (!p) return null;
  let dir = path.resolve(p);
  try {
    if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  } catch {
    dir = path.dirname(dir);
  }
  for (let i = 0; i < 6; i++) {
    if (isFile(path.join(dir, 'platformio.ini'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * Environments from `pio project config --json-output`.
 * @returns {{ defaultEnvs: string[], envs: { name: string, platform: string, board: string, framework: string[], simBoard: string|null }[] }}
 */
function parseProjectConfig(json) {
  const sections = new Map(json.map(([name, options]) => [name, new Map(options)]));
  const platformio = sections.get('platformio') || new Map();
  const envs = [];
  for (const [name, options] of sections) {
    if (!name.startsWith('env:')) continue;
    const framework = [].concat(options.get('framework') || []);
    const platform = String(options.get('platform') || '');
    const board = String(options.get('board') || '');
    const simulated = /atmelavr/.test(platform) && framework.includes('arduino') ? SIM_BOARDS[board] || null : null;
    envs.push({ name: name.slice(4), platform, board, framework, simBoard: simulated });
  }
  return { defaultEnvs: [].concat(platformio.get('default_envs') || []).map(String), envs };
}

/** Program size from PlatformIO's "Flash: [=   ] 6.1% (used 1960 bytes from 32256 bytes)". */
function flashUsage(output) {
  const m = /Flash:.*?([\d.]+)% \(used (\d+) bytes from (\d+) bytes\)/.exec(output);
  return m ? { usagePercent: Number(m[1]), programSize: Number(m[2]), maxSize: Number(m[3]) } : {};
}

/** Compiler errors worth showing first. */
function errorLines(output) {
  return output.split('\n').map(l => l.trimEnd()).filter(l => /\berror\b|\*\*\* \[/i.test(l) && !/^Error: Process completed/i.test(l));
}

class PlatformIO {
  constructor({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
    this.env = env;
    this.home = home;
    this.platform = platform;
    this.selected = new Map(); // project root → environment chosen in the app
    this.configCache = new Map(); // project root → { mtime, config }
  }

  /** `pio` from PATH, PlatformIO's own virtualenv, or $PLATFORMIO_CORE_DIR. */
  findCli() {
    const win = this.platform === 'win32';
    const names = win ? ['pio.exe', 'platformio.exe'] : ['pio', 'platformio'];
    const dirs = String(this.env.PATH || this.env.Path || '').split(path.delimiter).filter(Boolean);
    const cores = [this.env.PLATFORMIO_CORE_DIR, path.join(this.home, '.platformio')].filter(Boolean);
    for (const core of cores) dirs.push(path.join(core, 'penv', win ? 'Scripts' : 'bin'));
    for (const dir of dirs) {
      for (const name of names) {
        const candidate = path.join(dir, name);
        if (isFile(candidate)) return candidate;
      }
    }
    return null;
  }

  _run(args, { cwd, env = {}, timeout = 20 * 60 * 1000 } = {}) {
    const cli = this.findCli();
    if (!cli) return Promise.resolve({ ok: false, missing: true, stdout: '', stderr: '' });
    return new Promise((resolve) => {
      const proc = spawn(cli, args, { cwd, env: { ...this.env, ...env, PLATFORMIO_NO_ANSI: 'true', PLATFORMIO_FORCE_ANSI: 'false' }, windowsHide: true });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => proc.kill(), timeout);
      proc.stdout.on('data', d => { stdout += d; });
      proc.stderr.on('data', d => { stderr += d; });
      proc.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, stdout, stderr: stderr || err.message }); });
      proc.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, stdout, stderr }); });
    });
  }

  static missingMessage() {
    return 'This is a PlatformIO project, and PlatformIO Core (the "pio" command) is not installed. Install it from https://platformio.org/install/cli, then try again.';
  }

  /** The project's environments, read by PlatformIO itself (cached until platformio.ini changes). */
  async config(root) {
    const ini = path.join(root, 'platformio.ini');
    const mtime = fs.statSync(ini).mtimeMs;
    const cached = this.configCache.get(root);
    if (cached && cached.mtime === mtime) return cached.config;
    const res = await this._run(['project', 'config', '-d', root, '--json-output'], { cwd: root, timeout: 120000 });
    if (res.missing) throw new Error(PlatformIO.missingMessage());
    if (!res.ok) throw new Error(`platformio.ini could not be read: ${(res.stderr || res.stdout).trim().split('\n').slice(-3).join(' ')}`);
    const config = parseProjectConfig(JSON.parse(res.stdout.slice(res.stdout.indexOf('['))));
    if (!config.envs.length) throw new Error('platformio.ini has no [env:…] sections.');
    this.configCache.set(root, { mtime, config });
    return config;
  }

  /** What the app shows for a project: environments and the one in use. */
  async info(root) {
    const cli = this.findCli();
    if (!cli) return { root, cli: null, envs: [], env: null, error: PlatformIO.missingMessage() };
    try {
      const config = await this.config(root);
      return { root, cli, envs: config.envs, env: this.envName(root, config), error: null };
    } catch (err) {
      return { root, cli, envs: [], env: null, error: err.message };
    }
  }

  envName(root, config) {
    const chosen = this.selected.get(root);
    if (chosen && config.envs.some(e => e.name === chosen)) return chosen;
    const preferred = config.defaultEnvs.find(d => config.envs.some(e => e.name === d));
    return preferred || config.envs[0].name;
  }

  select(root, env) {
    this.selected.set(root, env);
  }

  /**
   * The environment to build for: the chosen one, or for the simulator the
   * one targeting the simulated board (`fqbn` names it).
   */
  async envFor(root, fqbn = null) {
    const config = await this.config(root);
    const name = this.envName(root, config);
    const env = config.envs.find(e => e.name === name);
    if (!fqbn) return env;
    const want = Object.keys(SIM_FQBN).find(b => fqbn.startsWith(SIM_FQBN[b]));
    if (env.simBoard && (!want || env.simBoard === want)) return env;
    const match = config.envs.find(e => e.simBoard && (!want || e.simBoard === want));
    if (match) return match;
    const simulated = Object.keys(SIM_BOARDS).join(', ');
    throw new Error(`No environment in platformio.ini can be simulated${want ? ` as an Arduino ${want === 'mega' ? 'Mega 2560' : want[0].toUpperCase() + want.slice(1)}` : ''}. Add one with platform = atmelavr, framework = arduino and board = ${simulated}.`);
  }

  _buildDir(root, env, debug) {
    if (!debug) return null;
    const key = crypto.createHash('sha1').update(`${root}\n${env}`).digest('hex').slice(0, 16);
    return path.join(os.tmpdir(), 'impulse-pio-debug', key);
  }

  /**
   * Build an environment.
   * @param {{ debug?: boolean, fqbn?: string }} options - debug: -Og -g without LTO, in its own build folder
   * @returns {Promise<{ success: boolean, env?: string, simBoard?: string|null, hex?: string, elf?: Uint8Array,
   *   output: string, programSize?: number, usagePercent?: number, error?: string, errors?: string[] }>}
   */
  async build(root, { debug = false, fqbn = null, wantElf = false } = {}) {
    let env;
    try {
      env = await this.envFor(root, fqbn);
    } catch (err) {
      return { success: false, output: '', error: err.message };
    }
    const buildDir = this._buildDir(root, env.name, debug);
    const extra = debug ? { PLATFORMIO_BUILD_DIR: buildDir, PLATFORMIO_BUILD_UNFLAGS: '-Os -flto', PLATFORMIO_BUILD_FLAGS: '-Og -g' } : {};
    const res = await this._run(['run', '-d', root, '-e', env.name], { cwd: root, env: extra });
    const output = `${res.stdout}${res.stderr}`;
    if (res.missing) return { success: false, output, error: PlatformIO.missingMessage() };
    if (!res.ok) {
      const errors = errorLines(output);
      return { success: false, env: env.name, output, errors, error: errors.slice(0, 12).join('\n') || output.trim().split('\n').slice(-12).join('\n') || 'Build failed' };
    }
    const out = { success: true, env: env.name, simBoard: env.simBoard, output, ...flashUsage(output) };
    const dir = path.join(buildDir || await this._projectBuildDir(root, env.name), env.name);
    if (isFile(path.join(dir, 'firmware.hex'))) out.hex = fs.readFileSync(path.join(dir, 'firmware.hex'), 'utf8');
    if ((debug || wantElf) && isFile(path.join(dir, 'firmware.elf'))) out.elf = new Uint8Array(fs.readFileSync(path.join(dir, 'firmware.elf')));
    return out;
  }

  /** Where a normal build of an environment puts firmware.hex and firmware.elf. */
  async buildOutputDir(root, envName) {
    return path.join(await this._projectBuildDir(root, envName), envName);
  }

  /** build_dir from the project (".pio/build" unless platformio.ini moves it). */
  async _projectBuildDir(root, envName) {
    const res = await this._run(['project', 'metadata', '-d', root, '-e', envName, '--json-output'], { cwd: root, timeout: 120000 }).catch(() => null);
    try {
      const meta = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
      const first = Object.values(meta)[0];
      if (first?.prog_path) return path.dirname(path.dirname(first.prog_path));
    } catch { /* fall back to the default */ }
    return path.join(root, '.pio', 'build');
  }

  /** Build and upload the chosen environment to `port`. */
  async upload(root, port) {
    let env;
    try {
      env = await this.envFor(root);
    } catch (err) {
      return { success: false, error: err.message };
    }
    const args = ['run', '-d', root, '-e', env.name, '-t', 'upload'];
    if (port) args.push('--upload-port', port);
    const res = await this._run(args, { cwd: root });
    const output = `${res.stdout}${res.stderr}`;
    if (res.missing) return { success: false, error: PlatformIO.missingMessage() };
    if (!res.ok) {
      const errors = errorLines(output);
      return { success: false, env: env.name, output, error: errors.slice(0, 12).join('\n') || output.trim().split('\n').slice(-12).join('\n') || 'Upload failed' };
    }
    return { success: true, env: env.name, output };
  }
}

module.exports = { PlatformIO, projectRoot, parseProjectConfig, flashUsage, SIM_BOARDS };
