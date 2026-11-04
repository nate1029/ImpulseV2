/**
 * Problem reports without a telemetry server: crashes are recorded on disk,
 * and the next launch offers to report them. Every report is a GitHub issue
 * pre-filled with details the user reviews first; nothing is sent silently.
 * @module main/services/problemReporter
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_CRASHES = 5;
const MAX_LOG_LINES = 40;
// GitHub rejects issue URLs much past 8 KB; keep a margin for encoding.
const MAX_URL = 7500;

// Things that must never leave the machine, even in a report the user reviews.
const KEY_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /gh[opsu]_[A-Za-z0-9]{20,}/g,
];
const ASSIGNMENT = /(api[_-]?key|token|password|secret)(["'\s:=]+)[^\s"',}]+/gi;

/** Replace the home folder with ~ and mask anything that looks like a key. */
function redact(text, home = os.homedir()) {
  let out = String(text ?? '');
  if (home && home.length > 1) out = out.split(home).join('~');
  for (const re of KEY_PATTERNS) out = out.replace(re, '[redacted]');
  return out.replace(ASSIGNMENT, (match, name, sep) => `${name}${sep}[redacted]`);
}

class ProblemReporter {
  /**
   * @param {{ userDataDir: string, logFile?: string|null, version: string, repo: string,
   *   electron?: string, platform?: string, arch?: string, osRelease?: string }} opts
   */
  constructor(opts) {
    this.dir = path.join(opts.userDataDir, 'crashes');
    this.logFile = opts.logFile || null;
    this.version = opts.version;
    this.repo = opts.repo;
    this.env = {
      electron: opts.electron || process.versions.electron || '',
      platform: opts.platform || process.platform,
      arch: opts.arch || process.arch,
      osRelease: opts.osRelease || os.release(),
    };
  }

  /** Remember a crash so the next launch can offer to report it. */
  recordCrash(kind, detail) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const at = new Date().toISOString();
      const id = `${at.replace(/[:.]/g, '-')}-${kind}`;
      const entry = { id, kind, at, version: this.version, message: String(detail?.message ?? detail ?? ''), stack: detail?.stack ? String(detail.stack) : '', reported: false };
      fs.writeFileSync(path.join(this.dir, `${id}.json`), JSON.stringify(entry, null, 2));
      const files = this._files();
      for (const old of files.slice(0, Math.max(0, files.length - MAX_CRASHES))) fs.rmSync(path.join(this.dir, old), { force: true });
      return id;
    } catch {
      return null; // reporting must never make things worse
    }
  }

  _files() {
    try {
      return fs.readdirSync(this.dir).filter(f => f.endsWith('.json')).sort();
    } catch {
      return [];
    }
  }

  _read(id) {
    if (!/^[\w-]+$/.test(String(id || ''))) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  /** The newest crash not yet reported or dismissed, or null. */
  pendingCrash() {
    const files = this._files().reverse();
    for (const f of files) {
      const entry = this._read(f.replace(/\.json$/, ''));
      if (entry && !entry.reported) return entry;
    }
    return null;
  }

  /** Mark a crash as handled (reported or dismissed). */
  resolveCrash(id) {
    const entry = this._read(id);
    if (!entry) return false;
    entry.reported = true;
    try {
      fs.writeFileSync(path.join(this.dir, `${id}.json`), JSON.stringify(entry, null, 2));
      return true;
    } catch {
      return false;
    }
  }

  _logTail() {
    if (!this.logFile) return '';
    try {
      const lines = fs.readFileSync(this.logFile, 'utf8').trim().split('\n');
      return lines.slice(-MAX_LOG_LINES).join('\n');
    } catch {
      return '';
    }
  }

  /** Technical details exactly as they would appear in the report. */
  details({ crashId = null } = {}) {
    const crash = crashId ? this._read(crashId) : null;
    const lines = [
      `Impulse ${this.version}`,
      `Electron ${this.env.electron} on ${this.env.platform} ${this.env.arch} (${this.env.osRelease})`,
    ];
    if (crash) {
      lines.push('', `Crash (${crash.kind}) at ${crash.at}: ${crash.message}`);
      if (crash.stack) lines.push(crash.stack.split('\n').slice(0, 12).join('\n'));
    }
    const log = this._logTail();
    if (log) lines.push('', 'Recent warnings and errors:', log);
    return redact(lines.join('\n'));
  }

  _url(params) {
    const q = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    return `https://github.com/${this.repo}/issues/new?${q}`;
  }

  /** GitHub "new issue" URL for a problem report, trimmed to fit. */
  issueUrl({ title, description = '', includeDetails = true, crashId = null }) {
    const desc = redact(description).trim() || '_No description._';
    let tech = includeDetails ? this.details({ crashId }) : '';
    const build = (t) => this._url({
      title: redact(title || 'Problem report').slice(0, 200),
      labels: crashId ? 'bug,crash' : 'bug',
      body: `### What happened\n\n${desc}\n${t ? `\n### Details\n\n\`\`\`\n${t}\n\`\`\`\n` : ''}`,
    });
    let url = build(tech);
    // Drop the oldest log lines first until the URL fits.
    while (url.length > MAX_URL && tech.includes('\n')) {
      const lines = tech.split('\n');
      const logStart = lines.indexOf('Recent warnings and errors:');
      if (logStart >= 0 && lines.length > logStart + 1) lines.splice(logStart + 1, 1);
      else lines.pop();
      tech = lines.join('\n');
      url = build(tech);
    }
    return url.length > MAX_URL ? build('') : url;
  }

  /** GitHub issue URL asking for a part the simulator doesn't have. */
  partRequestUrl(query) {
    const name = redact(String(query || '').trim()).slice(0, 80) || 'a part';
    return this._url({
      title: `Part request: ${name}`,
      labels: 'part request',
      body: `### Part\n\n${name}\n\n### What would you build with it?\n\n\n### Library or sketch you use with it (optional)\n\n`,
    });
  }
}

module.exports = { ProblemReporter, redact };
