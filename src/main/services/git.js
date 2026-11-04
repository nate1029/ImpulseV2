/**
 * Source control: status, diffs, commits, history, push and pull for the
 * open folder, through the system's git (as VS Code does). Every command runs
 * with an argument array, never through a shell, and never prompts: a push
 * that needs credentials fails with git's message instead of hanging.
 * @module main/services/git
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** What `git status --porcelain=v2` letters mean, for the UI. */
const STATUS = { M: 'modified', T: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflicted', '?': 'untracked' };

/** Ignore build output in a new repository (Arduino IDE exports and PlatformIO). */
const DEFAULT_GITIGNORE = 'build/\n.pio/\n.DS_Store\n';

/**
 * Parse `git status --porcelain=v2 --branch -z`.
 * @returns {{ branch: string|null, upstream: string|null, ahead: number, behind: number,
 *   files: { path: string, from?: string, staged: string|null, unstaged: string|null }[] }}
 */
function parseStatus(out) {
  const result = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const entries = out.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    if (e.startsWith('# branch.head ')) {
      const head = e.slice(14);
      result.branch = head === '(detached)' ? null : head;
    } else if (e.startsWith('# branch.upstream ')) {
      result.upstream = e.slice(18);
    } else if (e.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(e);
      if (m) { result.ahead = Number(m[1]); result.behind = Number(m[2]); }
    } else if (e[0] === '1') {
      // 1 XY sub mH mI mW hH hI path
      const parts = e.split(' ');
      result.files.push(fileEntry(parts[1], parts.slice(8).join(' ')));
    } else if (e[0] === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path, then the original path as the next entry
      const parts = e.split(' ');
      const entry = fileEntry(parts[1], parts.slice(9).join(' '));
      entry.from = entries[++i];
      result.files.push(entry);
    } else if (e[0] === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      result.files.push({ path: e.split(' ').slice(10).join(' '), staged: 'conflicted', unstaged: 'conflicted' });
    } else if (e[0] === '?') {
      result.files.push({ path: e.slice(2), staged: null, unstaged: 'untracked' });
    }
  }
  return result;
}

function fileEntry(xy, file) {
  return { path: file, staged: xy[0] === '.' ? null : STATUS[xy[0]] || 'modified', unstaged: xy[1] === '.' ? null : STATUS[xy[1]] || 'modified' };
}

class GitService {
  constructor({ env = process.env } = {}) {
    this.env = env;
    this._git = undefined;
  }

  /** The git executable, or null when it isn't installed. */
  findGit() {
    if (this._git !== undefined) return this._git;
    const win = process.platform === 'win32';
    const names = win ? ['git.exe'] : ['git'];
    const dirs = String(this.env.PATH || this.env.Path || '').split(path.delimiter).filter(Boolean);
    if (win) dirs.push(path.join(this.env.ProgramFiles || 'C:\\Program Files', 'Git', 'cmd'));
    else dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
    for (const dir of dirs) {
      for (const name of names) {
        const candidate = path.join(dir, name);
        if (isFile(candidate)) { this._git = candidate; return candidate; }
      }
    }
    this._git = null;
    return null;
  }

  run(cwd, args, { timeout = 60000, input = null } = {}) {
    const git = this.findGit();
    if (!git) return Promise.resolve({ ok: false, code: -1, stdout: '', stderr: 'Git is not installed. Install it from https://git-scm.com, then try again.' });
    return new Promise((resolve) => {
      const proc = spawn(git, args, {
        cwd,
        windowsHide: true,
        env: { ...this.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never', LC_ALL: 'C' },
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => proc.kill(), timeout);
      proc.stdout.on('data', d => { stdout += d; });
      proc.stderr.on('data', d => { stderr += d; });
      proc.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, code: -1, stdout, stderr: err.message }); });
      proc.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, stdout, stderr }); });
      if (input !== null) proc.stdin.end(input);
    });
  }

  static message(res, fallback) {
    const text = `${res.stderr}\n${res.stdout}`.trim();
    const lines = text.split('\n').map(l => l.replace(/^(fatal|error|hint): /, '').trim()).filter(Boolean);
    return lines.slice(0, 6).join('\n') || fallback;
  }

  /** The repository a folder belongs to, or null. */
  async root(dir) {
    const res = await this.run(dir, ['rev-parse', '--show-toplevel'], { timeout: 15000 });
    return res.ok ? path.resolve(res.stdout.trim()) : null;
  }

  /**
   * Status of the repository a folder is in.
   * @returns {Promise<{ available: boolean, repo: boolean, root?: string, branch?: string|null, upstream?: string|null,
   *   ahead?: number, behind?: number, files?: object[], hasCommits?: boolean, error?: string }>}
   */
  async status(dir) {
    if (!this.findGit()) return { available: false, repo: false, error: 'Git is not installed. Install it from https://git-scm.com, then reopen this panel.' };
    const root = await this.root(dir);
    if (!root) return { available: true, repo: false };
    const res = await this.run(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { timeout: 30000 });
    if (!res.ok) return { available: true, repo: true, root, error: GitService.message(res, 'git status failed') };
    const head = await this.run(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeout: 15000 });
    return { available: true, repo: true, root, hasCommits: head.ok, ...parseStatus(res.stdout) };
  }

  /** Create a repository in `dir`, with a .gitignore for build output. */
  async init(dir) {
    const res = await this.run(dir, ['init']);
    if (!res.ok) throw new Error(GitService.message(res, 'git init failed'));
    const ignore = path.join(dir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, DEFAULT_GITIGNORE);
    return this.status(dir);
  }

  /**
   * A file's changes against the last commit (or its whole text when it is new).
   * @returns {Promise<string>} unified diff
   */
  async diff(root, file) {
    const tracked = await this.run(root, ['ls-files', '--error-unmatch', '--', file], { timeout: 15000 });
    const head = await this.run(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeout: 15000 });
    const args = tracked.ok && head.ok
      ? ['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', file]
      : ['diff', '--no-color', '--no-ext-diff', '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', file];
    const res = await this.run(root, args, { timeout: 30000 });
    // `diff --no-index` exits 1 when the files differ.
    if (!res.ok && !(args.includes('--no-index') && res.code === 1)) throw new Error(GitService.message(res, 'git diff failed'));
    return res.stdout;
  }

  /** Name and email git will sign commits with (null when unset). */
  async identity(root) {
    const name = await this.run(root, ['config', 'user.name'], { timeout: 15000 });
    const email = await this.run(root, ['config', 'user.email'], { timeout: 15000 });
    return { name: name.stdout.trim() || null, email: email.stdout.trim() || null };
  }

  /**
   * Commit every change (new files included). Without a configured name and
   * email git would invent one from the login and host name, so ask instead
   * (the error carries needsIdentity) unless `identity` supplies them.
   */
  async commitAll(root, message, identity = null) {
    if (!String(message || '').trim()) throw new Error('Write a commit message first.');
    if (!(identity?.name && identity?.email)) {
      const current = await this.identity(root);
      if (!current.name || !current.email) {
        const err = new Error('Git needs your name and email for the commit.');
        err.needsIdentity = true;
        throw err;
      }
    } else {
      // For this repository only, as the user entered them.
      for (const [key, value] of [['user.name', identity.name], ['user.email', identity.email]]) {
        const set = await this.run(root, ['config', key, value], { timeout: 15000 });
        if (!set.ok) throw new Error(GitService.message(set, `Could not set ${key}`));
      }
    }
    const add = await this.run(root, ['add', '--all']);
    if (!add.ok) throw new Error(GitService.message(add, 'git add failed'));
    const res = await this.run(root, ['commit', '--file', '-'], { input: message });
    if (!res.ok) {
      if (/Please tell me who you are|empty ident|user\.email/i.test(res.stderr)) {
        const err = new Error('Git needs your name and email for the commit.');
        err.needsIdentity = true;
        throw err;
      }
      throw new Error(GitService.message(res, 'git commit failed'));
    }
    return this.status(root);
  }

  /** Recent commits on the current branch. */
  async log(root, count = 20) {
    const res = await this.run(root, ['log', `-${Math.max(1, Math.min(200, count))}`, '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e'], { timeout: 30000 });
    if (!res.ok) return [];
    return res.stdout.split('\x1e').map(r => r.trim()).filter(Boolean).map((r) => {
      const [hash, short, author, date, subject] = r.split('\x1f');
      return { hash, short, author, date, subject };
    });
  }

  async push(root) {
    const res = await this.run(root, ['push'], { timeout: 120000 });
    if (!res.ok) {
      if (/no upstream branch|has no upstream/i.test(res.stderr)) {
        const status = await this.status(root);
        const up = await this.run(root, ['push', '--set-upstream', 'origin', status.branch || 'HEAD'], { timeout: 120000 });
        if (up.ok) return this.status(root);
        throw new Error(GitService.message(up, 'git push failed'));
      }
      throw new Error(GitService.message(res, 'git push failed'));
    }
    return this.status(root);
  }

  /** Pull without merging diverged history (fast-forward only). */
  async pull(root) {
    const res = await this.run(root, ['pull', '--ff-only'], { timeout: 120000 });
    if (!res.ok) throw new Error(GitService.message(res, 'git pull failed'));
    return this.status(root);
  }
}

module.exports = { GitService, parseStatus, DEFAULT_GITIGNORE };
