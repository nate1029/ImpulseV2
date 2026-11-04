/**
 * Espressif's QEMU, the emulator the ESP32 simulator runs on: one build for
 * the Xtensa chips (ESP32, ESP32-S3) and one for the RISC-V ESP32-C3. On
 * macOS it ships inside the app (Espressif's macOS builds need Homebrew
 * libraries, so scripts/qemu-mac-pack.mjs bundles them). On Windows and Linux
 * it's downloaded from Espressif's GitHub release on first use and checked
 * against the published SHA-256; the Linux build uses the system's pixman,
 * libgcrypt, SDL2 and libslirp.
 * @module main/services/esp32sim/qemu
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const QEMU_RELEASE = 'esp-develop-9.2.2-20260417';
const QEMU_FILE_VERSION = 'esp_develop_9.2.2_20260417';

const HOSTS = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-linux-gnu',
  'linux-arm64': 'aarch64-linux-gnu',
  'win32-x64': 'x86_64-w64-mingw32',
};

// From https://github.com/espressif/qemu/releases/download/esp-develop-9.2.2-20260417/qemu-esp_develop_9.2.2_20260417-checksum.sha256
const SHA256 = {
  'xtensa-aarch64-apple-darwin': 'bb8c15810565d3df1665dc34962430885e11bc95575b228fb44698146be1e9d6',
  'xtensa-x86_64-apple-darwin': 'ae8170fe46bcdfa54a7c0d7afcdb7a066711991be680f72ff7bbc6c4ae3ad88f',
  'xtensa-x86_64-linux-gnu': '0eecb2a34a5586c0e59110f77b9343b7b336e82fdb0e1a30e1dc1bab8a547e35',
  'xtensa-aarch64-linux-gnu': '00de5985094c14e47d1b38464a006b8ed64fd0fa7a289c56da24f3a329f65339',
  'xtensa-x86_64-w64-mingw32': '3c483d77f5350a568df1faf4d8dbc82c95d6bc2b826d0d4be910485e0a68ca2a',
  'riscv32-aarch64-apple-darwin': '67bff66ff7158f272ce167fc211c0f8f4c1a79b6f6174350678a6d5035644b30',
  'riscv32-x86_64-apple-darwin': 'a47c38c6e2eb9f5028eda9585dce999ce02b8983a2cdf71c48cfb10a14ae25fe',
  'riscv32-x86_64-linux-gnu': '547f03e04701a92cbb699f7f7d015adc1f5b5ef93cbb94c0dd9b7107e2d84e77',
  'riscv32-aarch64-linux-gnu': 'a9f7b98636008edcf7a11c96f10b3a3ec83c2a890fc54c3e3ceb3ec9edace427',
  'riscv32-x86_64-w64-mingw32': '697aa4800a1f52be0b1693b30e22a684f7ea93c46c489e619384cae7b0e9b87b',
};

const SIZE_MB = {
  'xtensa-x86_64-linux-gnu': 16, 'xtensa-aarch64-linux-gnu': 15, 'xtensa-x86_64-w64-mingw32': 36,
  'riscv32-x86_64-linux-gnu': 17, 'riscv32-aarch64-linux-gnu': 17, 'riscv32-x86_64-w64-mingw32': 39,
  'xtensa-aarch64-apple-darwin': 4, 'xtensa-x86_64-apple-darwin': 4, 'riscv32-aarch64-apple-darwin': 4, 'riscv32-x86_64-apple-darwin': 4,
};

/** The release asset for an emulator architecture on this computer, or null. */
function qemuAsset(arch, platform = process.platform, cpu = process.arch) {
  const host = HOSTS[`${platform}-${cpu}`];
  if (!host || !SHA256[`${arch}-${host}`]) return null;
  const name = `qemu-${arch}-softmmu-${QEMU_FILE_VERSION}-${host}.tar.xz`;
  return {
    name,
    url: `https://github.com/espressif/qemu/releases/download/${QEMU_RELEASE}/${name}`,
    sha256: SHA256[`${arch}-${host}`],
    sizeMB: SIZE_MB[`${arch}-${host}`] || 20,
  };
}

const exeName = (arch, platform = process.platform) => `qemu-system-${arch}${platform === 'win32' ? '.exe' : ''}`;

class QemuManager extends EventEmitter {
  /**
   * @param {{ dataDir: string, bundledDir?: string|null }} opts
   *   dataDir: where downloaded emulators go (the app's data folder)
   *   bundledDir: emulators that ship with the app (macOS), laid out as <arch>/qemu/bin/…
   */
  constructor({ dataDir, bundledDir = null }) {
    super();
    this.dataDir = dataDir;
    this.bundledDir = bundledDir;
    this._installing = new Map();
  }

  _dir(arch) {
    return path.join(this.dataDir, QEMU_RELEASE, arch);
  }

  /** The emulator binary for 'xtensa' or 'riscv32', or null when it isn't installed. */
  binary(arch) {
    for (const root of [this.bundledDir && path.join(this.bundledDir, arch), this._dir(arch)]) {
      if (!root) continue;
      const exe = path.join(root, 'qemu', 'bin', exeName(arch));
      if (fs.existsSync(exe)) return exe;
    }
    return null;
  }

  /** What installing an emulator means: { installed, sizeMB, supported }. */
  status(arch) {
    const asset = qemuAsset(arch);
    return { arch, installed: !!this.binary(arch), supported: !!asset || !!this.binary(arch), sizeMB: asset?.sizeMB || null, release: QEMU_RELEASE };
  }

  _progress(message, percent = null) {
    this.emit('progress', { step: 'emulator', message, percent });
  }

  /** The emulator binary, downloading it first if needed. */
  async ensure(arch, { fetchImpl = globalThis.fetch } = {}) {
    const have = this.binary(arch);
    if (have) return have;
    if (!this._installing.has(arch)) {
      const job = this._install(arch, fetchImpl).finally(() => this._installing.delete(arch));
      this._installing.set(arch, job);
    }
    return this._installing.get(arch);
  }

  async _install(arch, fetchImpl) {
    const asset = qemuAsset(arch);
    if (!asset) throw new Error(`There's no ESP32 emulator build for ${process.platform} ${process.arch}.`);
    const label = arch === 'riscv32' ? 'the ESP32-C3 emulator' : 'the ESP32 emulator';
    const dir = this._dir(arch);
    const staging = `${dir}.partial`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    const archive = path.join(staging, asset.name);
    this._progress(`Downloading ${label}…`, 0);
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
        if (pct !== null && pct !== lastPct) { lastPct = pct; this._progress(`Downloading ${label}…`, pct); }
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(archive));
    if (hash.digest('hex') !== asset.sha256) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new Error(`The downloaded ${label} didn't match its published checksum, so it was discarded. Try again later.`);
    }
    this._progress(`Unpacking ${label}…`, 100);
    // bsdtar (macOS, Windows 10+) and GNU tar with xz both read .tar.xz.
    const untar = spawnSync('tar', ['-xf', archive, '-C', staging], { windowsHide: true });
    fs.rmSync(archive, { force: true });
    if (untar.status !== 0) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new Error(`Could not unpack ${label}: ${String(untar.stderr || '').trim() || 'tar failed (is xz installed?)'}`);
    }
    const exe = path.join(staging, 'qemu', 'bin', exeName(arch));
    if (!fs.existsSync(exe)) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new Error(`${label} wasn't in the downloaded archive.`);
    }
    if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
    return this.binary(arch);
  }

  /** Null when the emulator starts, else why it doesn't (e.g. missing libraries on macOS). */
  check(arch) {
    const exe = this.binary(arch);
    if (!exe) return 'not installed';
    const run = spawnSync(exe, ['--version'], { windowsHide: true, timeout: 15000, encoding: 'utf8' });
    if (run.status === 0) return null;
    const err = `${run.stderr || ''}${run.error?.message || ''}`.trim();
    const so = /error while loading shared libraries: ([^:\s]+)/.exec(err)?.[1];
    if (so) {
      return `The ESP32 emulator needs ${so}, which isn't installed. On Ubuntu or Debian: sudo apt install libpixman-1-0 libgcrypt20 libsdl2-2.0-0 libslirp0 — on Fedora: sudo dnf install pixman libgcrypt SDL2 libslirp.`;
    }
    if (/Library not loaded/i.test(err)) {
      const lib = /Library not loaded: (\S+)/.exec(err)?.[1] || 'a library';
      return `The ESP32 emulator needs ${path.basename(lib)}, which isn't on this Mac. Install Homebrew's pixman, libgcrypt and sdl2 (brew install pixman libgcrypt sdl2), or use an Impulse build that bundles them.`;
    }
    return err.split('\n')[0] || `exited with ${run.status}`;
  }
}

module.exports = { QemuManager, qemuAsset, QEMU_RELEASE, HOSTS };
