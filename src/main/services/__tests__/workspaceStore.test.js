const fs = require('fs');
const os = require('os');
const path = require('path');
const WorkspaceStore = require('../workspaceStore');
const { validatePath, getApprovedDirectories, revokeDirectory } = require('../../utils/pathValidator');

function memoryStore() {
  const data = {};
  return { get: (k, d) => (k in data ? data[k] : d), set: (k, v) => { data[k] = v; }, data };
}

describe('WorkspaceStore', () => {
  let base;
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-ws-'));
  });
  afterEach(() => {
    for (const dir of getApprovedDirectories()) revokeDirectory(dir);
  });

  it('migrates a legacy session exactly once', () => {
    const sketch = path.join(base, 'blink');
    fs.mkdirSync(sketch);
    const ws = new WorkspaceStore(memoryStore());

    expect(ws.migrateLegacySession([sketch, '/does/not/exist', 'relative/path'])).toEqual([sketch]);
    expect(validatePath(path.join(sketch, 'blink.ino'), { write: true }).valid).toBe(true);

    const other = path.join(base, 'other');
    fs.mkdirSync(other);
    expect(ws.migrateLegacySession([other])).toEqual([]);
    expect(validatePath(path.join(other, 'x.ino')).valid).toBe(false);
  });

  it('keeps a de-duplicated, most-recent-first list of existing folders', () => {
    const a = path.join(base, 'a');
    const b = path.join(base, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    const ws = new WorkspaceStore(memoryStore());
    ws.addRecent(a);
    ws.addRecent(b);
    ws.addRecent(a);
    expect(ws.getRecent()).toEqual([a, b]);
    fs.rmdirSync(b);
    expect(ws.getRecent()).toEqual([a]);
  });

  it('persists approvals and restores them on the next launch', () => {
    const store = memoryStore();
    const project = path.join(base, 'project');
    fs.mkdirSync(project);
    const ws = new WorkspaceStore(store);
    ws.restore();
    require('../../utils/pathValidator').approveDirectory(project);
    const saved = JSON.parse(JSON.stringify(store.data));

    // Simulate a restart: approvals in memory are gone, the saved store remains.
    for (const dir of getApprovedDirectories()) revokeDirectory(dir);
    expect(validatePath(path.join(project, 'p.ino')).valid).toBe(false);

    const nextLaunch = memoryStore();
    Object.assign(nextLaunch.data, saved);
    new WorkspaceStore(nextLaunch).restore();
    expect(validatePath(path.join(project, 'p.ino')).valid).toBe(true);
  });
});
