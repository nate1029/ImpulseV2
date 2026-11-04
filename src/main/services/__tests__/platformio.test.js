// PlatformIO projects: detection, environments, and (when `pio` is installed)
// real builds, simulation and a debug build stopped at a breakpoint.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PlatformIO, projectRoot, parseProjectConfig, flashUsage } = require('../platformio');

jest.mock('../../utils/errorHandler', () => ({ handle: jest.fn(), validateInput: jest.fn(() => ({ valid: true, errors: [] })), getFriendlyMessage: jest.fn() }));
jest.mock('../../utils/notifications', () => ({ progress: jest.fn(), updateProgress: jest.fn(), dismiss: jest.fn(), success: jest.fn(), error: jest.fn() }));
const ArduinoService = require('../arduinoService');

const FIXTURE = path.join(__dirname, '../../../../test/fixtures/platformio/blink_pio');

// What `pio project config --json-output` prints for the fixture.
const CONFIG = [
  ['platformio', [['default_envs', ['uno']]]],
  ['env', [['framework', ['arduino']]]],
  ['env:uno', [['platform', 'atmelavr'], ['board', 'uno'], ['framework', ['arduino']]]],
  ['env:mega', [['platform', 'atmelavr'], ['board', 'megaatmega2560'], ['framework', ['arduino']]]],
  ['env:s3', [['platform', 'espressif32'], ['board', 'esp32-s3-devkitc-1'], ['framework', ['arduino']]]],
];

let temp;
beforeEach(() => { temp = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-pio-test-')); });
afterEach(() => { fs.rmSync(temp, { recursive: true, force: true }); });

/** A PlatformIO service whose `pio` answers with canned output. */
function stubbed(answers = {}) {
  const pio = new PlatformIO({ env: { PATH: '' }, home: temp });
  pio.findCli = () => '/usr/bin/pio';
  pio.calls = [];
  pio._run = async (args, opts) => {
    pio.calls.push({ args, env: opts?.env || {} });
    if (args[0] === 'project' && args[1] === 'config') return { ok: true, stdout: JSON.stringify(answers.config || CONFIG), stderr: '' };
    return answers.run ? answers.run(args, opts) : { ok: true, stdout: '', stderr: '' };
  };
  return pio;
}

describe('PlatformIO projects', () => {
  test('a file anywhere in the project finds its root', () => {
    fs.mkdirSync(path.join(temp, 'proj', 'src', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'proj', 'platformio.ini'), '[env:uno]\n');
    fs.writeFileSync(path.join(temp, 'proj', 'src', 'deep', 'a.cpp'), '');
    expect(projectRoot(path.join(temp, 'proj', 'src', 'deep', 'a.cpp'))).toBe(path.join(temp, 'proj'));
    expect(projectRoot(path.join(temp, 'proj'))).toBe(path.join(temp, 'proj'));
    expect(projectRoot(path.join(temp, 'elsewhere', 'x.ino'))).toBeNull();
  });

  test('environments and which of them the simulator runs', () => {
    const { defaultEnvs, envs } = parseProjectConfig(CONFIG);
    expect(defaultEnvs).toEqual(['uno']);
    expect(envs.map(e => [e.name, e.simBoard])).toEqual([['uno', 'uno'], ['mega', 'mega'], ['s3', null]]);
  });

  test('flash usage from the build summary', () => {
    expect(flashUsage('RAM:   [=   ]   9.8% (used 200 bytes from 2048 bytes)\nFlash: [=   ]   6.1% (used 1960 bytes from 32256 bytes)'))
      .toEqual({ usagePercent: 6.1, programSize: 1960, maxSize: 32256 });
    expect(flashUsage('nothing')).toEqual({});
  });

  test('the chosen environment, and the simulated board picks its own', async () => {
    const pio = stubbed();
    const root = FIXTURE;
    expect((await pio.info(root)).env).toBe('uno');
    pio.select(root, 's3');
    expect((await pio.envFor(root)).name).toBe('s3');
    // The simulator asks for an Uno or a Mega: s3 can't run, so it takes the matching AVR environment.
    expect((await pio.envFor(root, 'arduino:avr:mega:cpu=atmega2560')).name).toBe('mega');
    expect((await pio.envFor(root, 'arduino:avr:uno')).name).toBe('uno');
    await expect(pio.envFor(root, 'arduino:avr:nano')).rejects.toThrow(/No environment in platformio.ini can be simulated as an Arduino Nano/);
  });

  test('debug builds strip -Os and LTO, in a folder of their own', async () => {
    const pio = stubbed({ run: async () => ({ ok: false, stdout: 'src/main.cpp:3:1: error: expected unqualified-id\n*** [.pio/build/uno/src/main.cpp.o] Error 1', stderr: '' }) });
    const res = await pio.build(FIXTURE, { debug: true, fqbn: 'arduino:avr:uno' });
    const run = pio.calls.find(c => c.args[0] === 'run');
    expect(run.args).toEqual(['run', '-d', FIXTURE, '-e', 'uno']);
    expect(run.env).toMatchObject({ PLATFORMIO_BUILD_UNFLAGS: '-Os -flto', PLATFORMIO_BUILD_FLAGS: '-Og -g' });
    expect(run.env.PLATFORMIO_BUILD_DIR).toContain('impulse-pio-debug');
    expect(res).toMatchObject({ success: false, error: expect.stringContaining('error: expected unqualified-id') });
  });

  test('without pio, the message says how to get it', async () => {
    const pio = new PlatformIO({ env: { PATH: '' }, home: temp });
    expect(pio.findCli()).toBeNull();
    const info = await pio.info(FIXTURE);
    expect(info).toMatchObject({ cli: null, envs: [] });
    expect(info.error).toMatch(/platformio\.org\/install/);
    expect((await pio.build(FIXTURE)).error).toMatch(/PlatformIO Core/);
  });

  test('pio is found in PlatformIO\'s own virtualenv', () => {
    const bin = path.join(temp, '.platformio', 'penv', process.platform === 'win32' ? 'Scripts' : 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const exe = path.join(bin, process.platform === 'win32' ? 'pio.exe' : 'pio');
    fs.writeFileSync(exe, '');
    expect(new PlatformIO({ env: { PATH: '' }, home: temp }).findCli()).toBe(exe);
  });

  test('sketch paths inside a project go to PlatformIO, others to arduino-cli', () => {
    const service = new ArduinoService({ cliPath: '/nonexistent/arduino-cli', platformio: stubbed() });
    expect(service.platformioRoot(path.join(FIXTURE, 'src', 'main.cpp'))).toBe(FIXTURE);
    expect(service.platformioRoot(path.join(temp, 'blink', 'blink.ino'))).toBeNull();
  });
});

// Real builds need PlatformIO Core with the atmelavr platform (several minutes the first time).
const PIO = new PlatformIO().findCli();
const describeWithPio = PIO && process.env.IMPULSE_PIO_TESTS === '1' ? describe : describe.skip;

describeWithPio('PlatformIO builds', () => {
  test('verify, simulate and debug a project', async () => {
    const root = path.join(temp, 'blink_pio');
    fs.cpSync(FIXTURE, root, { recursive: true });
    const service = new ArduinoService({ cliPath: '/nonexistent/arduino-cli' });
    const main = path.join(root, 'src', 'main.cpp');

    const verify = await service.compile(main, 'platformio:project');
    expect(verify).toMatchObject({ success: true, message: 'Built PlatformIO environment uno' });
    expect(verify.programSize).toBeGreaterThan(1000);

    const sim = await service.compileHex(main, 'arduino:avr:uno');
    expect(sim.success).toBe(true);
    const { runHeadless } = await import('../../../renderer/simulation/headless.js');
    const run = await runHeadless(sim.hex, { seconds: 0.2, board: 'uno' });
    expect(run.serial).toContain('pio ready');

    const debug = await service.compileDebug(main, 'arduino:avr:uno');
    expect(debug.success).toBe(true);
    const { readDebugInfo } = await import('../../../renderer/simulation/dwarf.js');
    const { Debugger } = await import('../../../renderer/simulation/debugger.js');
    const { AvrRunner } = await import('../../../renderer/simulation/avr-runner.js');
    const runner = new AvrRunner();
    runner.load(debug.hex, 'uno');
    const dbg = new Debugger(runner, readDebugInfo(debug.elf), { sketchDirs: debug.sketchDirs, live: false });
    dbg.onStop = () => {};
    const line = fs.readFileSync(main, 'utf8').split('\n').findIndex(l => l.includes('int y = x * 2')) + 1;
    expect(dbg.setBreakpoints(main, [line]).get(line)).not.toBeNull();
    dbg.continue();
    expect(runner.runUntilStop(16e6)).toBe(true);
    expect(dbg.location()).toMatchObject({ function: 'twice', inSketch: true });
    expect(dbg.callStack().map(f => f.function)).toEqual(['twice', 'loop', 'main']);
    expect(dbg.globals().find(g => g.name === 'counter').value).toBe('0');
  }, 900000);
});
