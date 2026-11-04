const { FixCapture, signatureOf, redact, librariesOf, diffText } = require('../fixCapture');

const BEFORE = `#include <WiFi.h>
#include <DHT.h>
const char* ssid = "HomeWiFi";
const char* password = "hunter2hunter2";
void setup() {
  ledcSetup(0, 5000, 8);
  ledcAttachPin(2, 0);
}
void loop() {}
`;
const AFTER = BEFORE.replace('  ledcSetup(0, 5000, 8);\n  ledcAttachPin(2, 0);\n', '  ledcAttach(2, 5000, 8);\n');
const ERROR = `/Users/meet/Documents/Arduino/blink/blink.ino:6:3: error: 'ledcSetup' was not declared in this scope\n    6 |   ledcSetup(0, 5000, 8);\nexit status 1\nError during build: exit status 1`;

describe('fix signatures', () => {
  it('hash the same mistake the same on any computer', () => {
    const a = signatureOf(ERROR, 'compile', 'CODE_ERROR');
    const b = signatureOf(ERROR.replace('/Users/meet/Documents/Arduino/blink/blink.ino:6:3', 'C:\\Users\\Asha\\sketch\\x.ino:12:7'), 'compile', 'CODE_ERROR');
    expect(a.signature).toBe("compile:CODE_ERROR:<file>:<line>: error: 'ledcSetup' was not declared in this scope");
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toHaveLength(16);
  });

  it('drop a path with spaces in it, and a bare file name', () => {
    const spaced = signatureOf("/private/var/folders/x/T/sketchbook/Impulse Projects/learntest/learntest.ino:5:3: error: 'digitalWrit' was not declared in this scope", 'compile', 'CODE_ERROR');
    expect(spaced.signature).toBe("compile:CODE_ERROR:<file>:<line>: error: 'digitalWrit' was not declared in this scope");
    const bare = signatureOf("blink.ino:5:3: error: expected ';' before 'delay'", 'compile', 'CODE_ERROR');
    expect(bare.signature).toBe("compile:CODE_ERROR:<file>:<line>: error: expected ';' before 'delay'");
  });

  it('strip ports and hex numbers from upload failures', () => {
    const s = signatureOf("avrdude: ser_open(): can't open device \"/dev/cu.usbserial-0001\": Resource busy", 'upload', 'PORT_BUSY');
    expect(s.signature).toBe("upload:PORT_BUSY:avrdude: ser_open(): can't open device \"<port>\": Resource busy");
  });
});

describe('redaction', () => {
  it('takes out credentials, keys, emails and home folders', () => {
    const out = redact(`${BEFORE}// mail me@example.com\n// key sk-ant-abcdefghijklmnop\n// /Users/meet/x`);
    expect(out).toMatch(/const char\* ssid = "<redacted>";/);
    expect(out).toMatch(/const char\* password = "<redacted>";/);
    expect(out).toMatch(/<email>/);
    expect(out).toMatch(/<key>/);
    expect(out).toMatch(/\/Users\/<user>\/x/);
    expect(out).toMatch(/ledcSetup\(0, 5000, 8\)/);
  });
});

describe('diff and libraries', () => {
  it('lists the libraries a sketch includes', () => {
    expect(librariesOf(BEFORE)).toEqual(['WiFi', 'DHT']);
  });
  it('writes a short diff of what changed, with context', () => {
    const d = diffText(BEFORE, AFTER);
    expect(d).toMatch(/^@@ -4 \+4 @@/);
    expect(d).toMatch(/- {2}ledcSetup\(0, 5000, 8\);\n- {2}ledcAttachPin\(2, 0\);\n\+ {2}ledcAttach\(2, 5000, 8\);/);
    expect(d.split('\n').length).toBeLessThan(12);
    expect(diffText('a\nb', 'a\nb')).toBe('');
  });
});

describe('FixCapture', () => {
  it('records a fix when a failed compile is followed by a success with changed code', () => {
    let t = 1_000_000;
    const cap = new FixCapture({ now: () => t });
    const fixes = [];
    cap.on('fix', (f) => fixes.push(f));
    expect(cap.observeBuild({ kind: 'compile', ok: false, sketchPath: '/s/a.ino', fqbn: 'esp32:esp32:esp32doit-devkit-v1:FlashFreq=80', coreVersion: '3.3.12', output: ERROR, failureCode: 'CODE_ERROR', code: BEFORE })).toBeNull();
    t += 60_000;
    const fix = cap.observeBuild({ kind: 'compile', ok: true, sketchPath: '/s/a.ino', code: AFTER, editedBy: 'agent', model: 'claude-sonnet-5-5' });
    expect(fix).toMatchObject({ kind: 'compile', failureCode: 'CODE_ERROR', board: 'esp32:esp32:esp32doit-devkit-v1', core: 'esp32:esp32', coreVersion: '3.3.12', libraries: ['WiFi', 'DHT'], fixedBy: 'agent', model: 'claude-sonnet-5-5', shared: false });
    expect(fix.diff).toMatch(/\+ {2}ledcAttach\(2, 5000, 8\);/);
    expect(fix.diff).not.toMatch(/hunter2/);
    expect(fix.errorExcerpt).toMatch(/'ledcSetup' was not declared/);
    expect(fixes).toHaveLength(1);
    const found = cap.lookup(ERROR, 'compile', 'CODE_ERROR');
    expect(found.count).toBe(1);
    expect(found.fixes[0].id).toBe(fix.id);
    expect(cap.unshared()).toHaveLength(1);
    cap.markShared(fix.id);
    expect(cap.unshared()).toHaveLength(0);
  });

  it('keeps the first failure\'s code when the same error repeats, and ignores unchanged compiles', () => {
    const cap = new FixCapture({ now: () => 5 });
    cap.observeBuild({ kind: 'compile', ok: false, sketchPath: '/s/a.ino', output: ERROR, code: BEFORE });
    cap.observeBuild({ kind: 'compile', ok: false, sketchPath: '/s/a.ino', output: ERROR, code: `${BEFORE}// try 2\n` });
    expect(cap.lookup(ERROR).count).toBe(2);
    expect(cap.observeBuild({ kind: 'compile', ok: true, sketchPath: '/s/a.ino', code: BEFORE })).toBeNull();
  });

  it('records an upload fix without a diff (a port or wiring fix) and forgets stale failures', () => {
    let t = 0;
    const cap = new FixCapture({ now: () => t });
    cap.observeBuild({ kind: 'upload', ok: false, sketchPath: '/s/a.ino', fqbn: 'arduino:avr:nano', output: 'avrdude: stk500_getsync() attempt 1 of 10: not in sync: resp=0x00', failureCode: 'UPLOAD_SYNC', code: BEFORE });
    t = 10_000;
    const fix = cap.observeBuild({ kind: 'upload', ok: true, sketchPath: '/s/a.ino', code: BEFORE, editedBy: 'user' });
    expect(fix).toMatchObject({ kind: 'upload', failureCode: 'UPLOAD_SYNC', board: 'arduino:avr:nano', diff: '', fixedBy: 'user' });
    cap.observeBuild({ kind: 'compile', ok: false, sketchPath: '/s/b.ino', output: ERROR, code: BEFORE });
    t = 10_000 + 31 * 60 * 1000;
    expect(cap.observeBuild({ kind: 'compile', ok: true, sketchPath: '/s/b.ino', code: AFTER })).toBeNull();
    expect(cap.stats()).toEqual({ fixes: 1, shared: 0, errorsSeen: 2 });
  });
});
