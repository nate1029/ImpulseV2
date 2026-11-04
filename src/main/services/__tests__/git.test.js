// Source control through the system's git, in a throwaway repository that
// ignores the machine's own git configuration.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GitService, parseStatus } = require('../git');

describe('git status parsing', () => {
  it('reads branch, tracking and file states from porcelain v2', () => {
    const out = [
      '# branch.oid 0123', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb sketch.ino',
      '1 A. N... 000000 100644 100644 000 ccc lib/new file.h',
      '2 R. N... 100644 100644 100644 ddd eee R100 renamed.cpp', 'old.cpp',
      'u UU N... 100644 100644 100644 100644 f1 f2 f3 conflict.ino',
      '? notes.txt', '',
    ].join('\0');
    expect(parseStatus(out)).toEqual({
      branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1,
      files: [
        { path: 'sketch.ino', staged: null, unstaged: 'modified' },
        { path: 'lib/new file.h', staged: 'added', unstaged: null },
        { path: 'renamed.cpp', from: 'old.cpp', staged: 'renamed', unstaged: null },
        { path: 'conflict.ino', staged: 'conflicted', unstaged: 'conflicted' },
        { path: 'notes.txt', staged: null, unstaged: 'untracked' },
      ],
    });
  });
});

const hasGit = !!new GitService().findGit();
(hasGit ? describe : describe.skip)('git repository', () => {
  let temp;
  let git;
  beforeEach(() => {
    // .native expands Windows 8.3 names (RUNNER~1), which git reports in full.
    temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-git-test-')));
    fs.mkdirSync(path.join(temp, 'home'));
    git = new GitService({ env: { ...process.env, HOME: path.join(temp, 'home'), XDG_CONFIG_HOME: path.join(temp, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(temp, 'home', '.gitconfig') } });
  });
  afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

  it('starts a repository, shows changes and diffs, and commits', async () => {
    const dir = path.join(temp, 'blink');
    fs.mkdirSync(dir);
    expect(await git.status(dir)).toEqual({ available: true, repo: false });

    let status = await git.init(dir);
    expect(status).toMatchObject({ repo: true, root: dir, hasCommits: false });
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('build/');

    fs.writeFileSync(path.join(dir, 'blink.ino'), 'void setup() {}\nvoid loop() {}\n');
    status = await git.status(dir);
    expect(status.files).toEqual(expect.arrayContaining([{ path: 'blink.ino', staged: null, unstaged: 'untracked' }]));
    expect(await git.diff(dir, 'blink.ino')).toMatch(/^\+void setup\(\) \{\}$/m);

    // Without a name and email, git refuses; the panel then asks for them.
    await expect(git.commitAll(dir, 'First')).rejects.toMatchObject({ needsIdentity: true });
    status = await git.commitAll(dir, 'First sketch\n\nBlinks nothing yet.', { name: 'Ada', email: 'ada@example.com' });
    expect(status.files).toEqual([]);
    expect(status.hasCommits).toBe(true);
    expect(await git.identity(dir)).toEqual({ name: 'Ada', email: 'ada@example.com' });

    fs.writeFileSync(path.join(dir, 'blink.ino'), 'void setup() { pinMode(13, OUTPUT); }\nvoid loop() {}\n');
    status = await git.status(dir);
    expect(status.files).toEqual([{ path: 'blink.ino', staged: null, unstaged: 'modified' }]);
    const diff = await git.diff(dir, 'blink.ino');
    expect(diff).toMatch(/^-void setup\(\) \{\}$/m);
    expect(diff).toMatch(/^\+void setup\(\) \{ pinMode\(13, OUTPUT\); \}$/m);

    await git.commitAll(dir, 'Set pin 13 to output');
    const log = await git.log(dir);
    expect(log.map(c => c.subject)).toEqual(['Set pin 13 to output', 'First sketch']);
    expect(log[0]).toMatchObject({ author: 'Ada', short: expect.stringMatching(/^[0-9a-f]{7,}$/) });
    await expect(git.commitAll(dir, '   ')).rejects.toThrow(/commit message/);
  }, 60000);

  it('push and pull fail with git\'s reason instead of waiting for a password', async () => {
    const dir = path.join(temp, 'repo');
    fs.mkdirSync(dir);
    await git.init(dir);
    fs.writeFileSync(path.join(dir, 'a.ino'), 'void setup() {}\nvoid loop() {}\n');
    await git.commitAll(dir, 'a', { name: 'Ada', email: 'ada@example.com' });
    await expect(git.push(dir)).rejects.toThrow(/push destination|remote/i);
    await expect(git.pull(dir)).rejects.toThrow(/tracking|remote|upstream/i);

    // A bare "remote" in another folder: push sets the upstream, pull is up to date.
    const remote = path.join(temp, 'remote.git');
    await git.run(temp, ['init', '--bare', remote]);
    await git.run(dir, ['remote', 'add', 'origin', remote]);
    const pushed = await git.push(dir);
    expect(pushed.upstream).toMatch(/^origin\//);
    expect(pushed.ahead).toBe(0);
    await expect(git.pull(dir)).resolves.toMatchObject({ behind: 0 });
  }, 60000);
});
