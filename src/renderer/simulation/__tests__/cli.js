// Shared helper for end-to-end tests that need a real arduino-cli build.
// Tests using it are skipped when arduino-cli or the AVR core isn't installed.
import { execFile, execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import process from 'process';

function findCliWithAvrCore() {
  for (const candidate of ['/opt/homebrew/bin/arduino-cli', '/usr/local/bin/arduino-cli', 'arduino-cli']) {
    try {
      const cores = execFileSync(candidate, ['core', 'list'], { stdio: 'pipe' }).toString();
      if (cores.includes('arduino:avr')) return candidate;
    } catch { /* not installed at this path */ }
  }
  return null;
}

export const CLI = findCliWithAvrCore();

// Raspberry Pi Pico and ATtiny85 tests need the Arduino-Pico core and
// ATTinyCore. IMPULSE_EXTRA_CORES_CONFIG (or the older IMPULSE_PICO_CLI_CONFIG)
// points arduino-cli at a configuration that has them, so they needn't be
// installed globally; otherwise arduino-cli's own configuration is used.
export const EXTRA_CONFIG_FILE = process.env.IMPULSE_EXTRA_CORES_CONFIG || process.env.IMPULSE_PICO_CLI_CONFIG || null;
const EXTRA_CONFIG = EXTRA_CONFIG_FILE ? ['--config-file', EXTRA_CONFIG_FILE] : [];
const isExtraCore = (fqbn) => /^(rp2040|ATTinyCore):/.test(fqbn);
const isPico = (fqbn) => fqbn.startsWith('rp2040:');

const extraCores = (() => {
  if (!CLI) return '';
  try {
    return execFileSync(CLI, [...EXTRA_CONFIG, 'core', 'list'], { stdio: 'pipe' }).toString();
  } catch {
    return '';
  }
})();

// Builds through that configuration still see the libraries of arduino-cli's
// own sketchbook, which installedLibraries() lists (read, never installed to).
const SKETCHBOOK_LIBS = (() => {
  if (!CLI || !EXTRA_CONFIG.length) return [];
  try {
    const dir = execFileSync(CLI, ['config', 'get', 'directories.user'], { stdio: 'pipe' }).toString().trim();
    return dir && fs.existsSync(path.join(dir, 'libraries')) ? [path.join(dir, 'libraries')] : [];
  } catch {
    return [];
  }
})();

export const PICO = extraCores.includes('rp2040:rp2040');
export const ATTINY = extraCores.includes('ATTinyCore:avr');

const cache = new Map();

// Extra library folders (path-separated) for libraries that aren't installed
// globally, e.g. IMPULSE_TEST_LIBRARIES=/tmp/libs npm test.
const EXTRA_LIBS = (process.env.IMPULSE_TEST_LIBRARIES || '').split(path.delimiter).filter(Boolean);

const CACHE_DIR = path.join(os.tmpdir(), 'impulse-test-hex-cache');

/**
 * Compile `code` for `fqbn` (cached on disk by content): the application HEX
 * text for AVR chips, the UF2 bytes for the Raspberry Pi Pico.
 */
export function compileSketch(code, fqbn = 'arduino:avr:uno', name = 'sketch', properties = {}) {
  const props = Object.entries(properties).flatMap(([k, v]) => ['--build-property', `${k}=${v}`]);
  const key = `${fqbn}\n${props.join(' ')}\n${EXTRA_LIBS.join(path.delimiter)}\n${code}`;
  if (cache.has(key)) return cache.get(key);
  const digest = crypto.createHash('sha1').update(key).digest('hex');
  const cached = path.join(CACHE_DIR, `${digest}.${isPico(fqbn) ? 'uf2' : 'hex'}`);
  if (fs.existsSync(cached)) {
    const program = isPico(fqbn) ? new Uint8Array(fs.readFileSync(cached)) : fs.readFileSync(cached, 'utf8');
    cache.set(key, program);
    return program;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-compile-'));
  const sketchDir = path.join(dir, name);
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(sketchDir);
  fs.writeFileSync(path.join(sketchDir, `${name}.ino`), code);
  let hex;
  try {
    const libs = [...EXTRA_LIBS, ...(isExtraCore(fqbn) ? SKETCHBOOK_LIBS : [])].flatMap(lib => ['--libraries', lib]);
    execFileSync(CLI, [...(isExtraCore(fqbn) ? EXTRA_CONFIG : []), 'compile', '--fqbn', fqbn, ...props, ...libs, '--output-dir', outDir, sketchDir], { stdio: 'pipe' });
    hex = isPico(fqbn)
      ? new Uint8Array(fs.readFileSync(path.join(outDir, `${name}.ino.uf2`)))
      : fs.readFileSync(path.join(outDir, `${name}.ino.hex`), 'utf8');
  } catch (err) {
    throw new Error(`Compile failed for ${fqbn}:\n${err.stderr?.toString() || err.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cached, hex);
  cache.set(key, hex);
  return hex;
}

/** Libraries installed for arduino-cli (lower-case names). */
export function installedLibraries() {
  if (!CLI) return new Set();
  try {
    const list = JSON.parse(execFileSync(CLI, ['lib', 'list', '--format', 'json'], { stdio: 'pipe' }).toString());
    const libs = list.installed_libraries || list;
    const names = new Set(libs.map(l => (l.library?.name || l.name || '').toLowerCase()));
    for (const dir of EXTRA_LIBS) {
      for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        const props = path.join(dir, entry, 'library.properties');
        const name = fs.existsSync(props) && /^name=(.+)$/m.exec(fs.readFileSync(props, 'utf8'))?.[1];
        if (name) names.add(name.trim().toLowerCase());
      }
    }
    return names;
  } catch {
    return new Set();
  }
}

export const describeWithCli = CLI ? describe : describe.skip;

// ESP32 boards run in Espressif's QEMU. Their tests are opt-in
// (IMPULSE_ESP32_TESTS=1): they need the ESP32 core (in arduino-cli's own
// configuration, or IMPULSE_ESP32_CLI_CONFIG) and the emulator, which comes
// from a checkout's build/qemu-<arch> (scripts/qemu-mac-pack.mjs) or is
// downloaded into IMPULSE_EMULATOR_DIR (default: a temporary folder).
const ESP32_CONFIG = process.env.IMPULSE_ESP32_CLI_CONFIG ? ['--config-file', process.env.IMPULSE_ESP32_CLI_CONFIG] : [];
let esp32Cores = '';
const ESP32_CLI = process.env.IMPULSE_ESP32_TESTS !== '1' ? null
  : ['/opt/homebrew/bin/arduino-cli', '/usr/local/bin/arduino-cli', 'arduino-cli'].find((candidate) => {
    try {
      esp32Cores = execFileSync(candidate, [...ESP32_CONFIG, 'core', 'list'], { stdio: 'pipe' }).toString();
      return esp32Cores.includes('esp32:esp32');
    } catch {
      return false;
    }
  }) || null;
export const ESP32 = !!ESP32_CLI;

/** Whether the core an ESP32-family FQBN needs is installed (the Nano ESP32's is Arduino's). */
export const hasEsp32Core = (fqbn) => esp32Cores.includes(String(fqbn).split(':').slice(0, 2).join(':'));

let esp32 = null;

/** Build `code` for the ESP32 simulator; resolves to the program ({ image, chip }) for runHeadless. */
export async function compileEsp32(code, fqbn, name) {
  const { Esp32Simulator, localBridge, packedQemuDir } = (await import('../../../main/services/esp32sim/index.js')).default;
  const { setEsp32Bridge } = await import('../esp32-runner.js');
  if (!esp32) {
    esp32 = new Esp32Simulator({
      runCli: (args, o = {}) => new Promise((resolve) => {
        execFile(ESP32_CLI, [...ESP32_CONFIG, ...args], { cwd: o.cwd, timeout: o.timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
          resolve({ success: !err, stdout: String(stdout), stderr: String(stderr) });
        });
      }),
      dataDir: process.env.IMPULSE_EMULATOR_DIR || path.join(os.tmpdir(), 'impulse-test-emulators'),
      bundledDir: packedQemuDir(),
    });
    setEsp32Bridge(() => localBridge(esp32));
  }
  // One folder per sketch, so rebuilds are incremental.
  const dir = path.join(os.tmpdir(), 'impulse-esp32-examples', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.ino`), code);
  const res = await esp32.build(dir, fqbn);
  if (!res.success) throw new Error(`Compile failed for ${fqbn}:\n${res.error}`);
  await esp32.installEmulator(res.esp32.chip);
  return res.esp32;
}

/** Stop the emulators the ESP32 tests started. */
export function stopEsp32() {
  esp32?.stopAll();
}
export const describeWithPico = PICO ? describe : describe.skip;
export const describeWithAttiny = ATTINY ? describe : describe.skip;
