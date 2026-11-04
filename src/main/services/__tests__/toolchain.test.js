const fs = require('fs');
const os = require('os');
const path = require('path');
const { Toolchain, cliAsset, cliCandidates, progressPercent, coreProgress, CLI_VERSION } = require('../toolchain');

describe('toolchain', () => {
  it('maps every supported machine to an official release asset', () => {
    const mac = cliAsset('darwin', 'arm64');
    expect(mac.name).toBe(`arduino-cli_${CLI_VERSION}_macOS_ARM64.tar.gz`);
    expect(mac.url).toBe(`https://github.com/arduino/arduino-cli/releases/download/v${CLI_VERSION}/${mac.name}`);
    expect(mac.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(cliAsset('win32', 'x64').name.endsWith('_Windows_64bit.zip')).toBe(true);
    expect(cliAsset('linux', 'x64').name.endsWith('_Linux_64bit.tar.gz')).toBe(true);
    expect(cliAsset('freebsd', 'x64')).toBeNull();
  });

  it('looks at system installs and Arduino IDE before its own copy', () => {
    const mac = cliCandidates({ platform: 'darwin', home: '/Users/a', env: { PATH: '/usr/bin' }, managedDir: '/data/toolchain' });
    expect(mac[0]).toEqual({ path: '/opt/homebrew/bin/arduino-cli', source: 'system' });
    expect(mac.some(c => c.source === 'arduino-ide' && c.path.includes('Arduino IDE.app'))).toBe(true);
    expect(mac[mac.length - 1]).toEqual({ path: '/data/toolchain/arduino-cli', source: 'impulse' });
    const win = cliCandidates({ platform: 'win32', home: 'C:\\Users\\a', env: { PATH: '', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, managedDir: 'C:\\data' });
    expect(win.find(c => c.source === 'arduino-ide').path).toContain('arduino-cli.exe');
    expect(win[win.length - 1].path.endsWith('arduino-cli.exe')).toBe(true);
  });

  it('reads the latest percentage from arduino-cli progress output', () => {
    expect(progressPercent('arduino:avr-gcc@7.3.0 12.0 MiB / 54.4 MiB  22.05% 00m03s')).toBeCloseTo(22.05);
    expect(progressPercent('a 10% b 55%')).toBe(55);
    expect(progressPercent('Installing platform arduino:avr@1.8.6')).toBeNull();
  });

  it('turns real core-install output into named progress', () => {
    expect(coreProgress('arduino:avr-gcc@7.3.0-atmel3.6.1-arduino7 12.25 MiB / 34.99 MiB   35.01% 00m02s')).toEqual({ message: 'Downloading the AVR compiler…', percent: 35 });
    expect(coreProgress('Downloading packages...\narduino:avrdude@8.0.0-arduino1 0 B / 4.1 MiB    0.00%')).toEqual({ message: 'Downloading the uploader (avrdude)…', percent: 0 });
    expect(coreProgress('Installing arduino:avr@1.8.8...')).toEqual({ message: 'Installing the Arduino AVR core…', percent: null });
    expect(coreProgress('Skipping tool configuration....')).toBeNull();
  });

  it('discards a download whose checksum does not match', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-tc-'));
    const tc = new Toolchain({ managedDir: dir, ignoreSystem: true });
    const body = new Blob(['not the real arduino-cli']).stream();
    const fakeFetch = async () => ({ ok: true, status: 200, body, headers: new Map([['content-length', '24']]) });
    const progress = [];
    tc.on('progress', (p) => progress.push(p));
    await expect(tc.installCli({ fetchImpl: fakeFetch })).rejects.toThrow(/did not match its published checksum/);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(progress[0].step).toBe('cli');
    expect(tc.findCli()).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Real download; run with IMPULSE_NETWORK_TESTS=1.
  (process.env.IMPULSE_NETWORK_TESTS === '1' && cliAsset() ? it : it.skip)('downloads, verifies and runs the real arduino-cli', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-tc-'));
    const tc = new Toolchain({ managedDir: dir, ignoreSystem: true });
    const exe = await tc.installCli();
    expect(tc.findCli()).toEqual({ path: exe, source: 'impulse' });
    const res = await tc._run(exe, ['version', '--format', 'json'], { timeout: 30000 });
    expect(JSON.parse(res.stdout).VersionString).toBe(CLI_VERSION);
    expect(fs.existsSync(path.join(dir, 'LICENSE.txt'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 180000);
});
