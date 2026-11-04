const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProblemReporter, redact } = require('../problemReporter');

describe('ProblemReporter', () => {
  let dir;
  let logFile;
  let reporter;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-report-'));
    logFile = path.join(dir, 'impulse.log');
    reporter = new ProblemReporter({
      userDataDir: dir, logFile, version: '2.0.0-beta.1', repo: 'Meet-1010/Impulse-IDE-v2',
      electron: '44.5.1', platform: 'darwin', arch: 'arm64', osRelease: '27.0.0',
    });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('redacts the home folder and anything that looks like a key', () => {
    const home = os.homedir();
    const text = redact(`open ${home}/Documents/x.ino key sk-ant-api03-abcdefghijklmnop AIzaSyA1234567890abcdefghijklmn token=abc123 ghp_abcdefghijklmnopqrstuvwxyz0123456789`);
    expect(text).toContain('open ~/Documents/x.ino');
    expect(text).not.toMatch(/sk-ant-api03|AIzaSy|abc123|ghp_/);
    expect(text).toContain('token=[redacted]');
    expect(redact('sk-proj-abcdefghijklmnopqrstuv')).toBe('[redacted]');
  });

  it('records crashes, offers the newest unreported one, and keeps only five', () => {
    expect(reporter.pendingCrash()).toBeNull();
    const ids = [];
    for (let i = 0; i < 7; i++) {
      ids.push(reporter.recordCrash('renderer', { message: `boom ${i}`, stack: 'Error: boom\n    at x' }));
      // ids include the time; make them distinct and ordered
      fs.renameSync(path.join(dir, 'crashes', `${ids[i]}.json`), path.join(dir, 'crashes', `${String(i).padStart(2, '0')}-${ids[i]}.json`));
      const file = path.join(dir, 'crashes', `${String(i).padStart(2, '0')}-${ids[i]}.json`);
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      entry.id = `${String(i).padStart(2, '0')}-${ids[i]}`;
      fs.writeFileSync(file, JSON.stringify(entry));
    }
    reporter.recordCrash('main', { message: 'last' });
    expect(fs.readdirSync(path.join(dir, 'crashes'))).toHaveLength(5);
    const pending = reporter.pendingCrash();
    expect(pending.message).toBe('last');
    expect(reporter.resolveCrash(pending.id)).toBe(true);
    expect(reporter.pendingCrash().message).toBe('boom 6');
  });

  it('builds a reviewed issue URL that fits GitHub limits', () => {
    fs.writeFileSync(logFile, Array.from({ length: 400 }, (_, i) => `2026-10-10T00:00:00Z ERROR renderer {"message":"failure number ${i} ${'x'.repeat(40)}"}`).join('\n'));
    const id = reporter.recordCrash('renderer', { message: 'gone: crashed', stack: 'Error\n    at a\n    at b' });
    const url = reporter.issueUrl({ title: 'Simulator froze', description: `It froze at ${os.homedir()}/sketch`, crashId: id });
    expect(url.startsWith('https://github.com/Meet-1010/Impulse-IDE-v2/issues/new?')).toBe(true);
    expect(url.length).toBeLessThanOrEqual(7500);
    const body = decodeURIComponent(new URL(url).searchParams.get('body'));
    expect(body).toContain('It froze at ~/sketch');
    expect(body).toContain('Impulse 2.0.0-beta.1');
    expect(body).toContain('Crash (renderer)');
    expect(body).toContain('failure number 399'); // newest log lines are kept
    expect(new URL(url).searchParams.get('labels')).toBe('bug,crash');
  });

  it('leaves technical details out when asked', () => {
    const url = reporter.issueUrl({ title: 'Idea', description: 'Add dark mode', includeDetails: false });
    expect(new URL(url).searchParams.get('body')).not.toContain('Electron');
  });

  it('builds a part request', () => {
    const url = new URL(reporter.partRequestUrl('  BME280 sensor '));
    expect(url.searchParams.get('title')).toBe('Part request: BME280 sensor');
    expect(url.searchParams.get('labels')).toBe('part request');
  });

  it('ignores unsafe crash ids', () => {
    expect(reporter.resolveCrash('../../etc/passwd')).toBe(false);
    expect(reporter.details({ crashId: '../x' })).not.toContain('Crash');
  });
});
