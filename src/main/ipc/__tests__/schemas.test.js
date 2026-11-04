/**
 * Jest tests for IPC validation schemas. Focus on edge cases and error scenarios.
 */

const { schemas, parseOrDefault } = require('../schemas');

describe('parseOrDefault', () => {
  it('returns ok: true and data when value is valid', () => {
    const result = parseOrDefault(schemas.arduinoCompile, { sketchPath: '/a/b.ino', boardFQBN: 'arduino:avr:uno' });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ sketchPath: '/a/b.ino', boardFQBN: 'arduino:avr:uno' });
  });

  it('returns defaultResult when value is invalid', () => {
    const defaultResult = { success: false, error: 'Bad input' };
    const result = parseOrDefault(schemas.arduinoCompile, { sketchPath: '', boardFQBN: 'x' }, defaultResult);
    expect(result.ok).toBe(false);
    expect(result.defaultResult).toBe(defaultResult);
    expect(result.error).toBeDefined();
  });

  it('returns defaultResult when value is null/undefined', () => {
    const defaultResult = { success: false };
    expect(parseOrDefault(schemas.arduinoCompile, null, defaultResult).ok).toBe(false);
    expect(parseOrDefault(schemas.arduinoCompile, undefined, defaultResult).ok).toBe(false);
  });

  it('serial:connect defaults baudRate to 115200', () => {
    const result = parseOrDefault(schemas.serialConnect, { port: 'COM3' });
    expect(result.ok).toBe(true);
    expect(result.data.baudRate).toBe(115200);
  });

  it('serial:connect accepts numeric baudRate', () => {
    const result = parseOrDefault(schemas.serialConnect, { port: 'COM3', baudRate: 9600 });
    expect(result.ok).toBe(true);
    expect(result.data.baudRate).toBe(9600);
  });

  it('rejects path with null byte', () => {
    const result = parseOrDefault(schemas.fileRead, { filePath: '/tmp/foo\x00bar.txt' }, { success: false });
    expect(result.ok).toBe(false);
  });

  it('rejects URL without http(s) for shell:open-external', () => {
    const result = parseOrDefault(schemas.shellOpenExternal, { url: 'ftp://x.com' }, { success: false });
    expect(result.ok).toBe(false);
  });

  it('accepts https URL for shell:open-external', () => {
    const result = parseOrDefault(schemas.shellOpenExternal, { url: 'https://arduino.cc' });
    expect(result.ok).toBe(true);
    expect(result.data.url).toBe('https://arduino.cc');
  });

  it('file:save rejects content over 2MB', () => {
    const big = 'x'.repeat(2 * 1024 * 1024 + 1);
    const result = parseOrDefault(schemas.fileSave, { filePath: '/a.ino', content: big }, { success: false });
    expect(result.ok).toBe(false);
  });

  it('ai:process-query defaults mode to agent', () => {
    const result = parseOrDefault(schemas.aiProcessQuery, { query: 'hello' });
    expect(result.ok).toBe(true);
    expect(result.data.mode).toBe('agent');
  });

  it('ai:process-query accepts ask and debug modes', () => {
    expect(parseOrDefault(schemas.aiProcessQuery, { query: 'q', mode: 'ask' }).data.mode).toBe('ask');
    expect(parseOrDefault(schemas.aiProcessQuery, { query: 'q', mode: 'debug' }).data.mode).toBe('debug');
  });
});
