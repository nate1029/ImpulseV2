/**
 * A compile that misses a library installs it and compiles again, for the
 * simulator's compiles and the board's builds alike (_withLibraries).
 */
jest.mock('child_process', () => ({ spawn: jest.fn(), execFile: jest.fn(), exec: jest.fn() }));
jest.mock('../../utils/errorHandler', () => ({
  handle: jest.fn((err) => ({ success: false, error: { message: err.message, code: err.code } })),
  validateInput: jest.fn(() => ({ valid: true, errors: [] })),
  getFriendlyMessage: jest.fn((err) => err.message),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const ArduinoService = require('../arduinoService');

function sketchWith(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-libtest-'));
  const file = path.join(dir, 'x.ino');
  fs.writeFileSync(file, code);
  return file;
}

/** A library service whose index knows two libraries. */
function fakeLibraries({ installed = [] } = {}) {
  const KNOWN = { 'DHT.h': { name: 'DHT sensor library', version: '1.4.6' }, 'Adafruit_SSD1306.h': { name: 'Adafruit SSD1306', version: '2.5.13' } };
  const have = new Set(installed);
  const calls = [];
  return {
    calls,
    has: (name) => have.has(name),
    async missingFor(code) {
      const out = [];
      for (const [header, lib] of Object.entries(KNOWN)) {
        if (code.includes(`<${header}>`) && !have.has(lib.name)) out.push({ header, suggestion: lib, alternatives: [] });
      }
      return out;
    },
    async install(name) {
      calls.push(`install ${name}`);
      if (name === 'Broken') throw new Error('no network');
      have.add(name);
      return { name };
    },
    async installForMissingHeaders(output) {
      const installed = [];
      for (const [header, lib] of Object.entries(KNOWN)) {
        if (output.includes(`${header}: No such file`) && !have.has(lib.name)) {
          calls.push(`install ${lib.name}`);
          have.add(lib.name);
          installed.push({ header, name: lib.name, version: lib.version });
        }
      }
      return { installed, unresolved: [] };
    },
  };
}

function service(libraries) {
  const s = new ArduinoService({ cliPath: '/usr/bin/false' });
  s.libraries = libraries;
  s.autoInstallLibraries = true;
  return s;
}

describe('compiles that need libraries', () => {
  it('installs what the sketch includes before compiling, and reports it', async () => {
    const libs = fakeLibraries();
    const s = service(libs);
    const sketch = sketchWith('#include <Wire.h>\n#include <DHT.h>\n#include <Adafruit_SSD1306.h>\nvoid setup(){} void loop(){}');
    let attempts = 0;
    const compile = async () => { attempts++; return { success: true, hex: ':00000001FF' }; };
    const result = await s._withLibraries(compile, { fqbn: 'arduino:avr:uno', sketchPath: sketch });
    expect(attempts).toBe(1);
    expect(libs.calls).toEqual(['install DHT sensor library', 'install Adafruit SSD1306']);
    expect(result.installedLibraries.map((l) => l.name)).toEqual(['DHT sensor library', 'Adafruit SSD1306']);
    expect(result.hex).toBe(':00000001FF');
  });

  it('installs a library once when the sketch includes several of its headers', async () => {
    const libs = fakeLibraries();
    const one = { name: 'OneWireNg', version: '0.14.1' };
    libs.missingFor = async () => [
      { header: 'OneWireNg_CurrentPlatform.h', suggestion: one, alternatives: [] },
      { header: 'drivers/DSTherm.h', suggestion: one, alternatives: [] },
    ];
    const s = service(libs);
    const sketch = sketchWith('#include <OneWireNg_CurrentPlatform.h>\n#include <drivers/DSTherm.h>\nvoid setup(){} void loop(){}');
    const result = await s._withLibraries(async () => ({ success: true }), { fqbn: 'esp32:esp32:esp32c6', sketchPath: sketch });
    expect(libs.calls).toEqual(['install OneWireNg']);
    expect(result.installedLibraries.map((l) => l.name)).toEqual(['OneWireNg']);
  });

  it('installs what the compiler misses in a secondary file and compiles again', async () => {
    const libs = fakeLibraries();
    const s = service(libs);
    const sketch = sketchWith('#include "sensors.h"\nvoid setup(){} void loop(){}');
    let attempts = 0;
    const compile = async () => {
      attempts++;
      return attempts === 1
        ? { success: false, error: 'sensors.h:2:10: fatal error: DHT.h: No such file or directory' }
        : { success: true, hex: ':00' };
    };
    const result = await s._withLibraries(compile, { fqbn: 'arduino:avr:uno', sketchPath: sketch });
    expect(attempts).toBe(2);
    expect(result.success).toBe(true);
    expect(result.installedLibraries).toEqual([{ header: 'DHT.h', name: 'DHT sensor library', version: '1.4.6' }]);
  });

  it('stops when nothing more can be installed and returns the compiler\'s error', async () => {
    const libs = fakeLibraries();
    const s = service(libs);
    const sketch = sketchWith('void setup(){} void loop(){}');
    let attempts = 0;
    const compile = async () => { attempts++; return { success: false, error: 'x.ino:1:10: fatal error: NothingKnown.h: No such file or directory' }; };
    const result = await s._withLibraries(compile, { fqbn: 'arduino:avr:uno', sketchPath: sketch });
    expect(attempts).toBe(1);
    expect(result.success).toBe(false);
    expect(result.installedLibraries).toBeUndefined();
  });

  it('does nothing when auto-install is off', async () => {
    const libs = fakeLibraries();
    const s = service(libs);
    s.autoInstallLibraries = false;
    const sketch = sketchWith('#include <DHT.h>\n');
    const compile = async () => ({ success: false, error: 'fatal error: DHT.h: No such file or directory' });
    const result = await s._withLibraries(compile, { fqbn: 'arduino:avr:uno', sketchPath: sketch });
    expect(libs.calls).toEqual([]);
    expect(result.success).toBe(false);
  });

  it('tells the build job what it installed, line by line', async () => {
    const libs = fakeLibraries();
    const s = service(libs);
    const sketch = sketchWith('#include <DHT.h>\n');
    const lines = [];
    await s._withLibraries(async () => ({ success: true }), { fqbn: 'arduino:avr:uno', sketchPath: sketch, onLine: (l) => lines.push(l) });
    expect(lines).toEqual(['Installing DHT sensor library for DHT.h…']);
  });
});
