#!/usr/bin/env node
// Bundle Espressif's QEMU for macOS with the libraries it needs, so the ESP32
// simulator runs on any Mac (macOS 14 or later), Homebrew or not:
//   build/qemu-<arm64|x64>/{xtensa,riscv32}/qemu/{bin,lib,share}
// electron-builder copies the folder for each architecture into the app's
// Resources/qemu (package.json › build.mac.extraResources).
//
// Espressif's macOS builds link Homebrew's pixman, libgcrypt (with
// libgpg-error) and SDL2. pixman, libgcrypt and libgpg-error are built here
// from their release sources (checked against the published checksums) for
// macOS 14+. SDL2 is replaced by a stub: QEMU only calls it for an SDL window
// or SDL audio, and the simulator runs with -display none and no audio.
//
// Usage: node scripts/qemu-mac-pack.mjs [arm64|x64|all]   (default: this Mac's)

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { qemuAsset, QEMU_RELEASE } = require('../src/main/services/esp32sim/qemu.js');

if (process.platform !== 'darwin') {
  console.log('qemu-mac-pack: macOS only (Windows and Linux download Espressif\'s self-contained builds).');
  process.exit(0);
}

const MIN_MACOS = '14.0';
const CPUS = {
  arm64: { arch: 'arm64', host: 'aarch64-apple-darwin' },
  x64: { arch: 'x86_64', host: 'x86_64-apple-darwin' },
};
const SOURCES = {
  gpgError: {
    version: '1.61',
    url: 'https://gnupg.org/ftp/gcrypt/libgpg-error/libgpg-error-1.61.tar.bz2',
    sha256: '7a85413f2bc354f4f8aa832b718af122e48965e9e0eb9012ee659c13c6385c93', // SHA-1 ec35eea7… on gnupg.org/download/integrity_check.html
  },
  gcrypt: {
    version: '1.12.4',
    url: 'https://gnupg.org/ftp/gcrypt/libgcrypt/libgcrypt-1.12.4.tar.bz2',
    sha256: 'd77f68f48879510e79a2f65977ccc68981781ea0923e5bdffac2a193ea3d660e', // SHA-1 2907251e… on gnupg.org/download/integrity_check.html
  },
  pixman: {
    version: '0.46.4',
    url: 'https://www.cairographics.org/releases/pixman-0.46.4.tar.gz',
    sha256: 'd09c44ebc3bd5bee7021c79f922fe8fb2fb57f7320f55e97ff9914d2346a591c', // SHA-512 in pixman-0.46.4.tar.gz.sha512
  },
};
const EMULATORS = ['xtensa', 'riscv32'];
const STAMP = JSON.stringify({ QEMU_RELEASE, MIN_MACOS, ...Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, v.version])), layout: 1 });

const work = path.join(root, 'build', 'qemu-deps');
const downloads = path.join(work, 'downloads');
const jobs = String(os.availableParallelism?.() || os.cpus().length || 4);

const log = (msg) => console.log(`  • ${msg}`);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'], ...opts });

async function download(url, sha256, file = path.join(downloads, path.basename(url))) {
  const verify = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === sha256;
  if (fs.existsSync(file) && verify()) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  log(`downloading ${path.basename(url)}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) from ${url}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  if (!verify()) {
    fs.rmSync(file);
    throw new Error(`${path.basename(url)} doesn't match its published checksum`);
  }
  return file;
}

function unpack(archive, into) {
  fs.rmSync(into, { recursive: true, force: true });
  fs.mkdirSync(into, { recursive: true });
  run('tar', ['-xf', archive, '-C', into, '--strip-components', '1']);
  return into;
}

function toolchainEnv(cpu) {
  const flags = `-arch ${cpu.arch} -mmacosx-version-min=${MIN_MACOS}`;
  return { ...process.env, CC: `clang ${flags}`, CFLAGS: '-O2', LDFLAGS: flags, MACOSX_DEPLOYMENT_TARGET: MIN_MACOS };
}

/** configure && make && make install (autotools release tarballs). */
function autotools(src, cpu, prefix, extra) {
  const env = toolchainEnv(cpu);
  run('./configure', [`--host=${cpu.host}`, `--prefix=${prefix}`, '--enable-shared', '--disable-static', '--disable-doc', ...extra], { cwd: src, env });
  run('make', [`-j${jobs}`], { cwd: src, env });
  run('make', ['install'], { cwd: src, env });
}

async function buildGpgError(cpu, dir, prefix) {
  log(`libgpg-error ${SOURCES.gpgError.version} (${cpu.arch})`);
  const src = unpack(await download(SOURCES.gpgError.url, SOURCES.gpgError.sha256), path.join(dir, 'libgpg-error'));
  autotools(src, cpu, prefix, ['--disable-tests', '--disable-nls', '--disable-languages']);
}

async function buildGcrypt(cpu, dir, prefix) {
  log(`libgcrypt ${SOURCES.gcrypt.version} (${cpu.arch})`);
  const src = unpack(await download(SOURCES.gcrypt.url, SOURCES.gcrypt.sha256), path.join(dir, 'libgcrypt'));
  autotools(src, cpu, prefix, [`--with-libgpg-error-prefix=${prefix}`, '--disable-asm', '--disable-padlock-support']);
}

/** pixman's portable C (no SIMD paths), compiled directly: no meson needed. */
async function buildPixman(cpu, dir, prefix) {
  log(`pixman ${SOURCES.pixman.version} (${cpu.arch})`);
  const src = unpack(await download(SOURCES.pixman.url, SOURCES.pixman.sha256), path.join(dir, 'pixman'));
  const p = path.join(src, 'pixman');
  const [major, minor, micro] = SOURCES.pixman.version.split('.');
  fs.writeFileSync(path.join(p, 'pixman-version.h'), fs.readFileSync(path.join(p, 'pixman-version.h.in'), 'utf8')
    .replaceAll('@PIXMAN_VERSION_MAJOR@', major).replaceAll('@PIXMAN_VERSION_MINOR@', minor).replaceAll('@PIXMAN_VERSION_MICRO@', micro));
  fs.writeFileSync(path.join(p, 'pixman-config.h'), [
    '#define PACKAGE "pixman"', '#define HAVE_PTHREADS 1', '#define HAVE_SIGACTION 1', '#define HAVE_ALARM 1',
    '#define HAVE_MPROTECT 1', '#define HAVE_GETPAGESIZE 1', '#define HAVE_MMAP 1', '#define HAVE_GETTIMEOFDAY 1',
    '#define HAVE_POSIX_MEMALIGN 1', '#define HAVE_SYS_MMAN_H 1', '#define HAVE_FENV_H 1', '#define HAVE_UNISTD_H 1',
    '#define TLS __thread', '#define TOOLCHAIN_SUPPORTS_ATTRIBUTE_CONSTRUCTOR 1', '#define TOOLCHAIN_SUPPORTS_ATTRIBUTE_DESTRUCTOR 1',
    '#define HAVE_BUILTIN_CLZ 1', '#define HAVE_GCC_VECTOR_EXTENSIONS 1', '#define SIZEOF_LONG 8', '',
  ].join('\n'));
  // The core list from pixman/meson.build (pixman_files); SIMD files aren't built.
  const meson = fs.readFileSync(path.join(p, 'meson.build'), 'utf8');
  const list = /pixman_files = files\(([\s\S]*?)\)/.exec(meson)?.[1];
  const files = [...String(list).matchAll(/'([^']+\.c)'/g)].map(m => path.join(p, m[1]));
  if (files.length < 20) throw new Error('pixman/meson.build changed: no source list found');
  fs.mkdirSync(path.join(prefix, 'lib'), { recursive: true });
  run('clang', [
    '-arch', cpu.arch, `-mmacosx-version-min=${MIN_MACOS}`, '-O2', '-dynamiclib', '-DHAVE_CONFIG_H', `-I${p}`,
    '-fvisibility=hidden', '-Wno-everything',
    '-install_name', '@loader_path/libpixman-1.0.dylib', '-compatibility_version', '1.0.0', '-current_version', `1.${minor}.${micro}`,
    '-o', path.join(prefix, 'lib', 'libpixman-1.0.dylib'), ...files,
  ]);
}

/** libSDL2 with every function QEMU imports, doing nothing. */
function buildSdlStub(cpu, binaries, out) {
  const names = new Set();
  for (const bin of binaries) {
    for (const line of execFileSync('nm', ['-u', bin], { encoding: 'utf8' }).split('\n')) {
      if (/^_SDL_\w+$/.test(line.trim())) names.add(line.trim().slice(1));
    }
  }
  const c = path.join(path.dirname(out), 'sdl2-stub.c');
  fs.writeFileSync(c, `// Stand-in for SDL2: QEMU links it for an SDL window and SDL audio, which the
// ESP32 simulator never uses (-display none). Every function returns 0.
${[...names].sort().map(n => `__attribute__((visibility("default"))) long ${n}(void) { return 0; }`).join('\n')}
`);
  run('clang', [
    '-arch', cpu.arch, `-mmacosx-version-min=${MIN_MACOS}`, '-dynamiclib', '-Wno-everything',
    '-install_name', '@loader_path/libSDL2-2.0.0.dylib', '-compatibility_version', '3201.0.0', '-current_version', '3201.10.0',
    '-o', out, c,
  ]);
  fs.rmSync(c);
}

const deps = (file) => execFileSync('otool', ['-L', file], { encoding: 'utf8' }).split('\n').slice(1)
  .map(l => l.trim().split(' (')[0]).filter(Boolean);
const isSystem = (lib) => /^(\/usr\/lib\/|\/System\/)/.test(lib) || lib.startsWith('@');

/** Point a binary or library at the copies in qemu/lib, then sign it ad hoc again. */
function relink(file, libs, fromBinary) {
  const args = [];
  for (const dep of deps(file)) {
    if (isSystem(dep)) continue;
    const name = path.basename(dep);
    if (!libs.has(name)) throw new Error(`${path.basename(file)} needs ${dep}, which isn't bundled`);
    args.push('-change', dep, `${fromBinary ? '@executable_path/../lib' : '@loader_path'}/${name}`);
  }
  if (!fromBinary) args.push('-id', `@loader_path/${path.basename(file)}`);
  if (args.length) run('install_name_tool', [...args, file], { stdio: ['ignore', 'ignore', 'ignore'] });
  run('codesign', ['--force', '--sign', '-', file]);
}

async function pack(cpuName) {
  const cpu = CPUS[cpuName];
  const out = path.join(root, 'build', `qemu-${cpuName}`);
  const stamp = path.join(out, '.stamp');
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === STAMP) {
    console.log(`qemu-mac-pack: build/qemu-${cpuName} is up to date`);
    return out;
  }
  console.log(`qemu-mac-pack: Espressif QEMU ${QEMU_RELEASE} for ${cpuName} Macs`);
  const dir = path.join(work, cpuName);
  const prefix = path.join(dir, 'prefix');
  fs.rmSync(prefix, { recursive: true, force: true });
  await buildGpgError(cpu, dir, prefix);
  await buildGcrypt(cpu, dir, prefix);
  await buildPixman(cpu, dir, prefix);

  fs.rmSync(out, { recursive: true, force: true });
  const binaries = [];
  for (const emu of EMULATORS) {
    const asset = qemuAsset(emu, 'darwin', cpuName);
    const archive = await download(asset.url, asset.sha256);
    const dest = path.join(out, emu);
    fs.mkdirSync(dest, { recursive: true });
    run('tar', ['-xf', archive, '-C', dest]);
    const q = path.join(dest, 'qemu');
    // Headers, static libraries and pkg-config files aren't needed to run.
    fs.rmSync(path.join(q, 'include'), { recursive: true, force: true });
    fs.rmSync(path.join(q, 'lib'), { recursive: true, force: true });
    fs.mkdirSync(path.join(q, 'lib'));
    binaries.push(path.join(q, 'bin', `qemu-system-${emu}`));
  }

  const libDir = path.join(dir, 'lib');
  fs.rmSync(libDir, { recursive: true, force: true });
  fs.mkdirSync(libDir, { recursive: true });
  for (const name of ['libgpg-error.0.dylib', 'libgcrypt.20.dylib', 'libpixman-1.0.dylib']) {
    fs.copyFileSync(path.join(prefix, 'lib', name), path.join(libDir, name));
  }
  buildSdlStub(cpu, binaries, path.join(libDir, 'libSDL2-2.0.0.dylib'));
  const libs = new Set(fs.readdirSync(libDir));
  for (const name of libs) relink(path.join(libDir, name), libs, false);

  for (const bin of binaries) {
    const q = path.dirname(path.dirname(bin));
    for (const name of libs) fs.copyFileSync(path.join(libDir, name), path.join(q, 'lib', name));
    // Drop the other tools in the archive (qemu-img and friends): only the emulator runs.
    for (const f of fs.readdirSync(path.dirname(bin))) if (path.join(path.dirname(bin), f) !== bin) fs.rmSync(path.join(path.dirname(bin), f), { recursive: true });
    relink(bin, libs, true);
  }

  // It must start with nothing from Homebrew or /usr/local in reach.
  if (cpuName === (process.arch === 'arm64' ? 'arm64' : 'x64')) {
    const sandbox = '(version 1)(allow default)(deny file-read* (subpath "/opt/homebrew") (subpath "/usr/local"))';
    for (const bin of binaries) {
      const r = spawnSync('sandbox-exec', ['-p', sandbox, bin, '--version'], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`${path.basename(bin)} didn't start on its own: ${(r.stderr || r.error?.message || '').trim()}`);
      log(`${path.basename(bin)}: ${r.stdout.split('\n')[0]}`);
    }
  }
  fs.writeFileSync(path.join(out, '.stamp'), STAMP);
  const size = execFileSync('du', ['-sh', out], { encoding: 'utf8' }).split('\t')[0];
  console.log(`qemu-mac-pack: build/qemu-${cpuName} ready (${size})`);
  return out;
}

const want = process.argv[2] || (process.arch === 'arm64' ? 'arm64' : 'x64');
const targets = want === 'all' ? Object.keys(CPUS) : [want];
if (!targets.every(t => CPUS[t])) {
  console.error('Usage: node scripts/qemu-mac-pack.mjs [arm64|x64|all]');
  process.exit(2);
}
try {
  for (const t of targets) await pack(t);
} catch (err) {
  console.error(`qemu-mac-pack: ${err.message}`);
  process.exit(1);
}
