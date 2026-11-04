/**
 * Zero-setup toolchain: find an existing arduino-cli (Homebrew, PATH, the one
 * inside Arduino IDE 2), or download the official release into the app's data
 * folder and check it against a pinned SHA-256. Then install the AVR core, and
 * on Apple silicon make sure Rosetta is there for the Intel-only AVR compiler.
 * @module main/services/toolchain
 */

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const CLI_VERSION = '1.5.1';
// From https://github.com/arduino/arduino-cli/releases/download/v1.5.1/1.5.1-checksums.txt
const CLI_ASSETS = {
  'darwin-arm64': { file: 'macOS_ARM64.tar.gz', sha256: 'cb952e8c1621c95ef5f1d17831c945e3d0ec5973f89c557a7ec8feb9c4f7d4c9' },
  'darwin-x64': { file: 'macOS_64bit.tar.gz', sha256: 'c982e940027996bea9901050e95fae99c59c1dcfee54beedecaf28141e7bf2e7' },
  'linux-x64': { file: 'Linux_64bit.tar.gz', sha256: '28a8e119c498a25607821c36cb2dc49e8463941b261a0d99091baa7bc692dd2b' },
  'linux-arm64': { file: 'Linux_ARM64.tar.gz', sha256: '1e69e077479f300614d4551334e0a33f08ee40b04315d83b8e7e0e94f0d0ee62' },
  'win32-x64': { file: 'Windows_64bit.zip', sha256: 'fabe42e0eb04d00e776a66178299ff95a46c623dbc260f997e58fd514853dd40' },
};
const AVR_CORE = 'arduino:avr';

/** The release asset for this machine, or null when there is no build for it. */
function cliAsset(platform = process.platform, arch = process.arch) {
  const asset = CLI_ASSETS[`${platform}-${arch}`];
  if (!asset) return null;
  const name = `arduino-cli_${CLI_VERSION}_${asset.file}`;
  return { ...asset, name, url: `https://github.com/arduino/arduino-cli/releases/download/v${CLI_VERSION}/${name}` };
}

/** Places arduino-cli is commonly installed, in the order to try them. */
function cliCandidates({ platform = process.platform, home = os.homedir(), env = process.env, managedDir } = {}) {
  // Path rules of the platform being described (not necessarily this machine's).
  const p = platform === 'win32' ? path.win32 : path.posix;
  const exe = platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli';
  const list = [];
  const add = (p, source) => { if (p) list.push({ path: p, source }); };
  if (platform === 'darwin') {
    add('/opt/homebrew/bin/arduino-cli', 'system');
    add('/usr/local/bin/arduino-cli', 'system');
  } else if (platform === 'linux') {
    add('/usr/local/bin/arduino-cli', 'system');
    add('/usr/bin/arduino-cli', 'system');
    add(p.join(home, '.local', 'bin', 'arduino-cli'), 'system');
    add('/snap/bin/arduino-cli', 'system');
  }
  add(p.join(home, 'bin', exe), 'system');
  for (const dir of String(env.PATH || '').split(p.delimiter).filter(Boolean)) add(p.join(dir, exe), 'system');
  // Arduino IDE 2 ships its own arduino-cli.
  const ideCli = ['lib', 'backend', 'resources', exe];
  if (platform === 'darwin') add(p.join('/Applications/Arduino IDE.app/Contents/Resources/app', ...ideCli), 'arduino-ide');
  if (platform === 'win32') {
    add(env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'Programs', 'Arduino IDE', 'resources', 'app', ...ideCli), 'arduino-ide');
    add(env.ProgramFiles && p.join(env.ProgramFiles, 'Arduino IDE', 'resources', 'app', ...ideCli), 'arduino-ide');
  }
  if (managedDir) add(p.join(managedDir, exe), 'impulse');
  const seen = new Set();
  return list.filter(c => !seen.has(c.path) && seen.add(c.path));
}

/** Last percentage in arduino-cli's download progress output ("12.3 MiB / 40 MiB 30.75%"). */
function progressPercent(text) {
  const s = String(text);
  const end = s.lastIndexOf('%');
  if (end < 0) return null;
  let start = end;
  while (start > 0 && '0123456789.'.includes(s[start - 1])) start--;
  const pct = parseFloat(s.slice(start, end));
  return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : null;
}

const PACKAGE_NAMES = {
  avr: 'the Arduino AVR core', 'avr-gcc': 'the AVR compiler', avrdude: 'the uploader (avrdude)', arduinoOTA: 'arduinoOTA',
  rp2040: 'the Raspberry Pi Pico core', 'pqt-gcc': 'the ARM compiler', 'pqt-gcc-riscv': 'the RISC-V compiler',
  'pqt-python3': 'Python for the build', 'pqt-picotool': 'picotool', 'pqt-openocd': 'OpenOCD', 'pqt-pioasm': 'the PIO assembler',
  'pqt-mklittlefs': 'mklittlefs',
  ATTinyCore: 'ATTinyCore', micronucleus: 'the Digispark uploader (micronucleus)',
};

/**
 * Board cores the simulator can install on request (the AVR core is part of
 * first-run setup). Installed with --additional-urls, so arduino-cli's
 * configuration is left as it is.
 */
const EXTRA_CORES = {
  pico: {
    id: 'rp2040:rp2040',
    url: 'https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json',
    label: 'Raspberry Pi Pico boards (Arduino-Pico core)',
    size: 'about 450 MB',
    fqbn: /^rp2040:/,
  },
  attiny: {
    id: 'ATTinyCore:avr',
    url: 'https://drazzy.com/package_drazzy.com_index.json',
    label: 'ATtiny chips (ATTinyCore)',
    size: 'about 10 MB',
    fqbn: /^ATTinyCore:/,
  },
  esp32: {
    id: 'esp32:esp32',
    url: 'https://espressif.github.io/arduino-esp32/package_esp32_index.json',
    label: 'ESP32 boards (Espressif core)',
    size: 'about 650 MB',
    fqbn: /^esp32:esp32:/,
  },
  nanoesp32: {
    id: 'arduino:esp32',
    url: null, // in Arduino's own board index
    label: 'Arduino Nano ESP32 (Arduino ESP32 core)',
    size: 'about 450 MB',
    fqbn: /^arduino:esp32:/,
  },
  // Cores for the rest of the board catalog (knowledge/boards/catalog.json).
  esp8266: {
    id: 'esp8266:esp8266',
    url: 'https://arduino.esp8266.com/stable/package_esp8266com_index.json',
    label: 'ESP8266 boards (NodeMCU, D1 mini, ESP-01)',
    size: 'about 150 MB',
    fqbn: /^esp8266:esp8266:/,
  },
  stm32: {
    id: 'STMicroelectronics:stm32',
    url: 'https://github.com/stm32duino/BoardManagerFiles/raw/main/package_stmicroelectronics_index.json',
    label: 'STM32 boards (Blue Pill, Black Pill, Nucleo)',
    size: 'about 1 GB',
    fqbn: /^STMicroelectronics:stm32:/,
  },
  renesas: {
    id: 'arduino:renesas_uno',
    url: null,
    label: 'Arduino Uno R4 boards',
    size: 'about 200 MB',
    fqbn: /^arduino:renesas_uno:/,
  },
  megaavr: {
    id: 'arduino:megaavr',
    url: null,
    label: 'Arduino Nano Every and Uno WiFi Rev2',
    size: 'about 60 MB',
    fqbn: /^arduino:megaavr:/,
  },
  samd: {
    id: 'arduino:samd',
    url: null,
    label: 'Arduino SAMD boards (Nano 33 IoT, MKR, Zero)',
    size: 'about 200 MB',
    fqbn: /^arduino:samd:/,
  },
  mbednano: {
    id: 'arduino:mbed_nano',
    url: null,
    label: 'Arduino Nano 33 BLE and Nano RP2040 Connect',
    size: 'about 600 MB',
    fqbn: /^arduino:mbed_nano:/,
  },
  sam: {
    id: 'arduino:sam',
    url: null,
    label: 'Arduino Due',
    size: 'about 150 MB',
    fqbn: /^arduino:sam:/,
  },
  seeedsamd: {
    id: 'Seeeduino:samd',
    url: 'https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json',
    label: 'Seeed SAMD boards (XIAO SAMD21, Wio Terminal)',
    size: 'about 200 MB',
    fqbn: /^Seeeduino:samd:/,
  },
  seeednrf52: {
    id: 'Seeeduino:nrf52',
    url: 'https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json',
    label: 'Seeed nRF52 boards (XIAO nRF52840)',
    size: 'about 300 MB',
    fqbn: /^Seeeduino:nrf52:/,
  },
  adafruitnrf52: {
    id: 'adafruit:nrf52',
    url: 'https://adafruit.github.io/arduino-board-index/package_adafruit_index.json',
    label: 'Adafruit nRF52 boards (Feather nRF52840, nRF52840 DK)',
    size: 'about 300 MB',
    fqbn: /^adafruit:nrf52:/,
  },
  teensy: {
    id: 'teensy:avr',
    url: 'https://www.pjrc.com/teensy/package_teensy_index.json',
    label: 'Teensy boards',
    size: 'about 400 MB',
    fqbn: /^teensy:avr:/,
  },
  digistump: {
    id: 'digistump:avr',
    url: 'https://raw.githubusercontent.com/digistump/arduino-boards-index/master/package_digistump_index.json',
    label: 'Digispark (Digistump AVR)',
    size: 'about 10 MB',
    fqbn: /^digistump:avr:/,
  },
  megatiny: {
    id: 'megaTinyCore:megaavr',
    url: 'https://drazzy.com/package_drazzy.com_index.json',
    label: 'tinyAVR 0/1/2-series (megaTinyCore)',
    size: 'about 20 MB',
    fqbn: /^megaTinyCore:/,
  },
};

/** The EXTRA_CORES key that provides a board, or null. */
function extraCoreFor(fqbn) {
  return Object.keys(EXTRA_CORES).find(key => EXTRA_CORES[key].fqbn.test(String(fqbn || ''))) || null;
}

/**
 * A progress update from a chunk of `arduino-cli core install` output, e.g.
 * "arduino:avr-gcc@7.3.0-atmel3.6.1-arduino7 12 MiB / 34.99 MiB  35.20%" or
 * "Installing arduino:avrdude@8.0.0-arduino1...". Null when there's nothing new.
 */
function coreProgress(text) {
  const lines = String(text).split(/[\r\n]/).map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const pkg = /^(?:Installing )?[\w.-]+:([\w.+-]+)@/.exec(lines[i])?.[1];
    if (!pkg) continue;
    const name = PACKAGE_NAMES[pkg] || pkg;
    if (lines[i].startsWith('Installing ')) return { message: `Installing ${name}…`, percent: null };
    const pct = progressPercent(lines[i]);
    if (pct !== null) return { message: `Downloading ${name}…`, percent: Math.round(pct) };
  }
  return null;
}

class Toolchain extends EventEmitter {
  /**
   * @param {{ managedDir: string, ignoreSystem?: boolean }} opts
   *   managedDir: where Impulse keeps its own arduino-cli;
   *   ignoreSystem: only consider the managed copy (tests of first-run setup).
   */
  constructor({ managedDir, ignoreSystem = false }) {
    super();
    this.managedDir = managedDir;
    this.ignoreSystem = ignoreSystem;
  }

  /** The arduino-cli to use: { path, source } or null. */
  findCli() {
    const candidates = cliCandidates({ managedDir: this.managedDir }).filter(c => !this.ignoreSystem || c.source === 'impulse');
    return candidates.find(c => { try { return fs.statSync(c.path).isFile(); } catch { return false; } }) || null;
  }

  /** On Apple silicon the AVR compiler is an Intel binary and needs Rosetta. */
  rosettaStatus() {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') return 'not-needed';
    const res = spawnSync('/usr/bin/arch', ['-x86_64', '/usr/bin/true'], { timeout: 10000 });
    return res.status === 0 ? 'ok' : 'missing';
  }

  _run(cli, args, { timeout = 15 * 60 * 1000, onOutput } = {}) {
    return new Promise((resolve) => {
      const proc = spawn(cli, args, { windowsHide: true });
      let out = '';
      let err = '';
      const timer = setTimeout(() => { proc.kill(); resolve({ success: false, stdout: out, stderr: `${err}\nTimed out` }); }, timeout);
      proc.stdout.on('data', (d) => { out += d; onOutput?.(String(d)); });
      proc.stderr.on('data', (d) => { err += d; onOutput?.(String(d)); });
      proc.on('error', (e) => { clearTimeout(timer); resolve({ success: false, stdout: out, stderr: e.message }); });
      proc.on('close', (code) => { clearTimeout(timer); resolve({ success: code === 0, stdout: out, stderr: err }); });
    });
  }

  async hasAvrCore(cli) {
    return this.hasCore(cli, AVR_CORE);
  }

  async hasCore(cli, coreId) {
    const res = await this._run(cli, ['core', 'list', '--format', 'json'], { timeout: 30000 });
    if (!res.success) return false;
    try {
      const data = JSON.parse(res.stdout);
      const platforms = data.platforms || data;
      return (Array.isArray(platforms) ? platforms : []).some(p => (p.id || p.ID) === coreId && (p.installed_version || p.installed || p.Installed));
    } catch {
      return false;
    }
  }

  /** Whether an extra core (EXTRA_CORES key) is installed, and what installing it means. */
  async extraCore(key) {
    const core = EXTRA_CORES[key];
    if (!core) throw new Error(`Unknown core "${key}"`);
    const cli = this.findCli();
    return { key, label: core.label, size: core.size, installed: !!cli && await this.hasCore(cli.path, core.id) };
  }

  /** Install an extra core (EXTRA_CORES key) with progress events ('core' step). */
  async installExtraCore(key) {
    const core = EXTRA_CORES[key];
    if (!core) throw new Error(`Unknown core "${key}"`);
    const cli = this.findCli();
    if (!cli) throw new Error('arduino-cli is not installed. Run Tools › Set Up Arduino Tools first.');
    const urls = core.url ? ['--additional-urls', core.url] : [];
    this._progress('core', 'Updating the board list…', null);
    const index = await this._run(cli.path, ['core', 'update-index', ...urls]);
    if (!index.success) throw new Error(`Could not update the board list: ${(index.stderr || index.stdout).trim().split('\n').pop()}`);
    this._progress('core', `Installing ${core.label}…`, 0);
    const res = await this._run(cli.path, ['core', 'install', core.id, ...urls], {
      onOutput: (text) => {
        const p = coreProgress(text);
        if (p) this._progress('core', p.message, p.percent);
      },
    });
    if (!res.success) throw new Error(`Could not install ${core.label}: ${(res.stderr || res.stdout).trim().split('\n').pop()}`);
    this._progress('core', `${core.label} installed.`, 100);
    return this.extraCore(key);
  }

  /** What's present and what's missing. */
  async status() {
    const cli = this.findCli();
    let version = null;
    let avrCore = false;
    if (cli) {
      const v = await this._run(cli.path, ['version', '--format', 'json'], { timeout: 15000 });
      try { version = JSON.parse(v.stdout).VersionString || null; } catch { version = null; }
      avrCore = await this.hasAvrCore(cli.path);
    }
    const rosetta = this.rosettaStatus();
    return {
      cli: cli ? { path: cli.path, source: cli.source, version } : null,
      avrCore,
      rosetta,
      supported: !!cliAsset(),
      ready: !!cli && avrCore && rosetta !== 'missing',
    };
  }

  _progress(step, message, percent = null) {
    this.emit('progress', { step, message, percent });
  }

  /** Download, verify and unpack arduino-cli into the managed folder. */
  async installCli({ fetchImpl = globalThis.fetch } = {}) {
    const asset = cliAsset();
    if (!asset) throw new Error(`There is no arduino-cli build for ${process.platform} ${process.arch}. Install it yourself from arduino.cc.`);
    fs.mkdirSync(this.managedDir, { recursive: true });
    const archive = path.join(this.managedDir, asset.name);
    this._progress('cli', `Downloading arduino-cli ${CLI_VERSION}…`, 0);
    const res = await fetchImpl(asset.url);
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) from ${asset.url}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha256');
    let received = 0;
    let lastPct = -1;
    const counter = new Transform({
      transform: (chunk, enc, done) => {
        hash.update(chunk);
        received += chunk.length;
        const pct = total ? Math.floor((received / total) * 100) : null;
        if (pct !== null && pct !== lastPct) { lastPct = pct; this._progress('cli', `Downloading arduino-cli ${CLI_VERSION}…`, pct); }
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(archive));
    const digest = hash.digest('hex');
    if (digest !== asset.sha256) {
      fs.rmSync(archive, { force: true });
      throw new Error('The downloaded arduino-cli did not match its published checksum, so it was discarded. Try again later.');
    }
    this._progress('cli', 'Unpacking arduino-cli…', 100);
    // tar handles .tar.gz everywhere and .zip on Windows 10+ (bsdtar).
    const untar = spawnSync('tar', ['-xf', archive, '-C', this.managedDir], { windowsHide: true });
    fs.rmSync(archive, { force: true });
    if (untar.status !== 0) throw new Error(`Could not unpack arduino-cli: ${String(untar.stderr || '').trim()}`);
    const exe = path.join(this.managedDir, process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli');
    if (!fs.existsSync(exe)) throw new Error('arduino-cli was not found in the downloaded archive.');
    if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
    return exe; // LICENSE.txt (GPL-3.0) stays next to it
  }

  /** Install the Arduino AVR core (Uno, Nano, Mega…) with progress. */
  async installAvrCore(cli) {
    this._progress('core', 'Updating the board list…', null);
    const index = await this._run(cli, ['core', 'update-index']);
    if (!index.success) throw new Error(`Could not update the board list: ${(index.stderr || index.stdout).trim().split('\n').pop()}`);
    this._progress('core', 'Installing Arduino AVR boards (compiler and uploader)…', 0);
    const res = await this._run(cli, ['core', 'install', AVR_CORE], {
      onOutput: (text) => {
        // Each package downloads with its own percentage, so name the package.
        const p = coreProgress(text);
        if (p) this._progress('core', p.message, p.percent);
      },
    });
    if (!res.success) throw new Error(`Could not install the AVR core: ${(res.stderr || res.stdout).trim().split('\n').pop()}`);
    this._progress('core', 'Arduino AVR boards installed.', 100);
  }

  /** Ask macOS to install Rosetta; the system shows its own password prompt. */
  installRosetta() {
    return new Promise((resolve) => {
      this._progress('rosetta', 'Installing Rosetta (macOS asks for your password)…', null);
      const script = 'do shell script "/usr/sbin/softwareupdate --install-rosetta --agree-to-license" with administrator privileges';
      const proc = spawn('/usr/bin/osascript', ['-e', script]);
      let err = '';
      proc.stderr.on('data', (d) => { err += d; });
      proc.on('close', (code) => resolve(code === 0 ? { success: true } : { success: false, error: /cancel/i.test(err) ? 'Cancelled' : err.trim() || 'Rosetta install failed' }));
      proc.on('error', (e) => resolve({ success: false, error: e.message }));
    });
  }

  /** Run whatever is missing, in order. Returns the final status. */
  async setup() {
    let cli = this.findCli();
    if (!cli) {
      const exe = await this.installCli();
      cli = { path: exe, source: 'impulse' };
    }
    if (this.rosettaStatus() === 'missing') {
      const r = await this.installRosetta();
      if (!r.success) throw new Error(r.error === 'Cancelled' ? 'Rosetta is needed to compile for AVR boards on Apple silicon. Run setup again to install it.' : `Rosetta: ${r.error}`);
    }
    if (!(await this.hasAvrCore(cli.path))) await this.installAvrCore(cli.path);
    return this.status();
  }
}

module.exports = { Toolchain, cliAsset, cliCandidates, progressPercent, coreProgress, CLI_VERSION, EXTRA_CORES, extraCoreFor };
