const fs = require('fs');
const os = require('os');
const path = require('path');
const { simBuildPlan, copySketch, Esp32SimBuilder, WRAPPED, BRIDGE_FILE } = require('../build');
const { buildFlashImage, flashBytes } = require('../image');
const { qemuArgs, Esp32Session } = require('../session');
const { qemuAsset, QemuManager } = require('../qemu');
const { Esp32Simulator, localBridge } = require('..');

const props = (extra) => ({ 'runtime.platform.path': '/cores/esp32', 'build.flash_size': '4MB', ...extra });

describe('ESP32 simulator builds', () => {
  it('builds ESP32, S3 and C3 boards for themselves, with the settings QEMU needs', () => {
    const esp = simBuildPlan('esp32:esp32:esp32doit-devkit-v1', props({ 'build.mcu': 'esp32', 'build.bootloader_addr': '0x1000' }));
    expect(esp).toMatchObject({ chip: 'esp32', fqbn: 'esp32:esp32:esp32doit-devkit-v1', bootloaderAddr: 0x1000, psramMB: 0 });
    expect(esp.properties).toMatchObject({ 'build.boot': 'dio', 'build.flash_mode': 'dio', 'build.memory_type': 'dio_qspi', 'build.cdc_on_boot': '0' });
    for (const fn of ['initArduino', 'ledcWrite', 'i2cWrite', 'pulseIn', 'neopixelWrite']) {
      expect(esp.properties['compiler.c.elf.extra_flags']).toContain(`--wrap=${fn}`);
    }
    const c3 = simBuildPlan('esp32:esp32:esp32c3', props({ 'build.mcu': 'esp32c3', 'build.bootloader_addr': '0x0' }));
    expect(c3).toMatchObject({ chip: 'esp32c3', bootloaderAddr: 0 });
  });

  it('gives PSRAM to boards that have it, quad on the S3 (QEMU has no octal PSRAM)', () => {
    const s3 = simBuildPlan('esp32:esp32:esp32s3:PSRAM=opi', props({ 'build.mcu': 'esp32s3', 'build.bootloader_addr': '0x0', 'build.defines': '-DBOARD_HAS_PSRAM' }));
    expect(s3).toMatchObject({ chip: 'esp32s3', psramMB: 8 });
    expect(s3.properties['build.psram_type']).toBe('qspi');
    const esp = simBuildPlan('esp32:esp32:esp32', props({ 'build.mcu': 'esp32', 'build.defines': '-DBOARD_HAS_PSRAM -mfix-esp32-psram-cache-issue' }));
    expect(esp.psramMB).toBe(4);
  });

  it('runs ESP32-S2 boards on the S3 with their own pins', () => {
    const plan = simBuildPlan('esp32:esp32:lolin_s2_mini:CDCOnBoot=cdc', props({
      'build.mcu': 'esp32s2', 'build.bootloader_addr': '0x1000', 'build.variant': 'lolin_s2_mini', 'build.board': 'LOLIN_S2_MINI', 'build.defines': '-DBOARD_HAS_PSRAM',
    }));
    expect(plan).toMatchObject({ chip: 'esp32s3', mcu: 'esp32s2', fqbn: 'esp32:esp32:esp32s3', bootloaderAddr: 0, psramMB: 8 });
    expect(plan.properties).toMatchObject({ 'build.variant': 'lolin_s2_mini', 'build.board': 'LOLIN_S2_MINI', 'build.defines': '-DBOARD_HAS_PSRAM' });
    expect(plan.note).toMatch(/ESP32-S3/);
  });

  it('refuses chips QEMU doesn\'t emulate', () => {
    expect(simBuildPlan('esp32:esp32:esp32c6', props({ 'build.mcu': 'esp32c6' }))).toBeNull();
  });

  it('wraps every function the bridge replaces', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'impulse_sim.cpp'), 'utf8');
    for (const fn of WRAPPED) expect(source).toContain(`__wrap_${fn}(`);
  });

  it('copies a sketch, keeps unchanged files and drops deleted ones', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-esp-copy-'));
    try {
      const src = path.join(root, 'blink');
      const dst = path.join(root, 'copy', 'blink');
      fs.mkdirSync(path.join(src, 'src'), { recursive: true });
      fs.mkdirSync(path.join(src, '.git'), { recursive: true });
      fs.writeFileSync(path.join(src, 'blink.ino'), 'void setup() {}\nvoid loop() {}\n');
      fs.writeFileSync(path.join(src, 'src', 'helper.h'), 'int x;\n');
      fs.writeFileSync(path.join(src, 'old.h'), '\n');
      fs.writeFileSync(path.join(src, '.git', 'HEAD'), 'ref\n');
      copySketch(src, dst);
      fs.writeFileSync(path.join(dst, BRIDGE_FILE), '// bridge\n');
      expect(fs.readFileSync(path.join(dst, 'src', 'helper.h'), 'utf8')).toBe('int x;\n');
      expect(fs.existsSync(path.join(dst, '.git'))).toBe(false);
      const mtime = fs.statSync(path.join(dst, 'blink.ino')).mtimeMs;
      fs.rmSync(path.join(src, 'old.h'));
      copySketch(src, dst);
      expect(fs.existsSync(path.join(dst, 'old.h'))).toBe(false);
      expect(fs.existsSync(path.join(dst, BRIDGE_FILE))).toBe(true);
      expect(fs.statSync(path.join(dst, 'blink.ino')).mtimeMs).toBe(mtime);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a board whose core isn\'t installed', async () => {
    const builder = new Esp32SimBuilder({ runCli: async () => ({ success: false, stdout: '', stderr: 'Error: platform not installed' }) });
    const res = await builder.build('/tmp/blink', 'esp32:esp32:esp32');
    expect(res).toMatchObject({ success: false, missingCore: true });
  });
});

describe('ESP32 flash image', () => {
  it('puts each part where esptool writes it, in erased flash', () => {
    const image = buildFlashImage({
      bootloader: Buffer.from([1, 2]), bootloaderAddr: 0x1000,
      partitions: Buffer.from([3]), bootApp0: Buffer.from([4]), app: Buffer.from([5, 6]), flashSize: '4MB',
    });
    expect(image.length).toBe(4 * 1024 * 1024);
    expect([...image.subarray(0x1000, 0x1002)]).toEqual([1, 2]);
    expect(image[0x8000]).toBe(3);
    expect(image[0xe000]).toBe(4);
    expect([...image.subarray(0x10000, 0x10002)]).toEqual([5, 6]);
    expect(image[0]).toBe(0xff);
    expect(flashBytes('16MB')).toBe(16 * 1024 * 1024);
    expect(flashBytes('weird')).toBe(4 * 1024 * 1024);
  });

  it('refuses an app that doesn\'t fit', () => {
    expect(() => buildFlashImage({ bootloader: Buffer.alloc(1), bootloaderAddr: 0, partitions: Buffer.alloc(1), app: Buffer.alloc(3 * 1024 * 1024), flashSize: '2MB' }))
      .toThrow(/doesn't fit/);
  });
});

describe('ESP32 emulator', () => {
  it('runs each chip on its QEMU machine with the bridge on UART1', () => {
    const args = qemuArgs({ chip: 'esp32s3', flashPath: '/tmp/f.bin', ports: { uart0: 1, bridge: 2, monitor: 3 }, psramMB: 8 });
    const joined = args.join(' ');
    expect(joined).toContain('-machine esp32s3');
    expect(joined).toContain('file=/tmp/f.bin,if=mtd,format=raw');
    expect(joined).toContain('driver=timer.esp32s3.timg,property=wdt_disable,value=true');
    expect(joined).toContain('-m 8M');
    expect(args.indexOf('chardev:uart0')).toBeLessThan(args.indexOf('chardev:bridge'));
    expect(joined).toContain('port=3');
    expect(Esp32Session.archOf('esp32c3')).toBe('riscv32');
    expect(Esp32Session.archOf('esp32')).toBe('xtensa');
    expect(() => qemuArgs({ chip: 'esp32c6', flashPath: 'x', ports: {} })).toThrow(/doesn't emulate/);
  });

  it('downloads Espressif\'s builds with their published checksums', () => {
    expect(qemuAsset('xtensa', 'darwin', 'arm64').url).toMatch(/espressif\/qemu\/releases\/download\/.+aarch64-apple-darwin\.tar\.xz$/);
    expect(qemuAsset('riscv32', 'win32', 'x64').sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(qemuAsset('xtensa', 'linux', 'arm64').name).toContain('aarch64-linux-gnu');
    expect(qemuAsset('xtensa', 'win32', 'arm64')).toBeNull();
  });

  it('finds an emulator bundled with the app before a downloaded one', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-qemu-'));
    try {
      const exe = process.platform === 'win32' ? 'qemu-system-xtensa.exe' : 'qemu-system-xtensa';
      const bundled = path.join(root, 'bundled', 'xtensa', 'qemu', 'bin');
      fs.mkdirSync(bundled, { recursive: true });
      fs.writeFileSync(path.join(bundled, exe), '');
      const qemu = new QemuManager({ dataDir: path.join(root, 'data'), bundledDir: path.join(root, 'bundled') });
      expect(qemu.binary('xtensa')).toBe(path.join(bundled, exe));
      expect(qemu.binary('riscv32')).toBeNull();
      expect(qemu.status('xtensa').installed).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a download that doesn\'t match its checksum', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-qemu-'));
    try {
      const qemu = new QemuManager({ dataDir: root });
      if (!qemuAsset('xtensa')) return; // no build for this machine
      const fetchImpl = async () => new Response('not the archive', { status: 200, headers: { 'content-length': '15' } });
      await expect(qemu.ensure('xtensa', { fetchImpl })).rejects.toThrow(/checksum/);
      expect(qemu.binary('xtensa')).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('gives the renderer\'s runner the preload\'s shape in-process', async () => {
    const sim = new Esp32Simulator({ runCli: async () => ({ success: false, stdout: '', stderr: '' }), dataDir: os.tmpdir() });
    const bridge = localBridge(sim);
    expect(Object.keys(bridge).sort()).toEqual(['control', 'onEvent', 'send', 'start', 'write']);
    const res = await bridge.start('no-such-image');
    expect(res).toMatchObject({ success: false, error: expect.stringMatching(/Run the sketch again/) });
    const seen = [];
    const off = bridge.onEvent(e => seen.push(e));
    sim.emit('event', { session: 1, type: 'serial', data: 'hi' });
    off();
    sim.emit('event', { session: 1, type: 'serial', data: 'again' });
    expect(seen).toHaveLength(1);
  });
});
