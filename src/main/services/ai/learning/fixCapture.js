/**
 * Learning from fixes. When a compile or upload fails and the same sketch
 * then succeeds, the pair is a fix: the error's signature, the board and core,
 * the libraries in play, a redacted diff of what changed and who changed it
 * (the agent or the user). Fixes are kept locally and, for a signed-in user
 * who leaves sharing on, sent to Impulse Cloud, where they are aggregated so
 * the next person with the same error gets the fix before the model guesses.
 * No model is trained: the harness remembers what worked.
 *
 * Pure parts (signature, diff, redaction) are exported for tests; the
 * FixCapture class holds the per-sketch state machine and the local store.
 * @module main/services/ai/learning/fixCapture
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const MAX_EXCERPT = 600;
const MAX_DIFF = 6 * 1024;
const MAX_DIFF_LINES = 400;
const FIX_WINDOW_MS = 30 * 60 * 1000;
const MAX_LOCAL = 500;

/**
 * The stable part of a failure: the first error line with paths, line
 * numbers, ports and hex numbers taken out, so the same mistake on another
 * computer hashes the same.
 * @param {string} output  the build output (or the error message)
 * @param {'compile'|'upload'} kind
 * @param {string} [code]  the failure code (SKETCH_TOO_BIG, UPLOAD_SYNC…)
 * @returns {{ signature: string, hash: string }}
 */
function signatureOf(output, kind = 'compile', code = '') {
  const lines = String(output || '').split('\n').map((l) => l.trim()).filter(Boolean);
  let line = lines.find((l) => /:\d+:\d+: (?:fatal )?error:/.test(l))
    || lines.find((l) => /error:|Error during build|failed|fatal|not in sync|Failed to connect|No such file|Permission denied|too big|overflowed/i.test(l))
    || lines[lines.length - 1] || '';
  line = normalizeLine(line);
  const signature = `${kind}:${code ? `${code}:` : ''}${line}`.slice(0, 220);
  return { signature, hash: crypto.createHash('sha1').update(signature).digest('hex').slice(0, 16) };
}

function normalizeLine(line) {
  return String(line)
    // A path to a source file, even one with spaces in a folder name ("Impulse Projects/x/x.ino").
    .replace(/(?:[A-Za-z]:\\|\/)[^:\n]*?[\\/][^\\/:\n]+\.(?:ino|cpp|cc|c|h|hpp|pde)/g, '<file>')
    .replace(/(?:^|\s)[\w.-]+\.(?:ino|cpp|cc|c|h|hpp|pde):(\d+):/g, ' <file>:$1:')
    .replace(/<file>:\d+:\d+:/g, '<file>:<line>:')
    .replace(/<file>:\d+:/g, '<file>:<line>:')
    .replace(/\/dev\/(?:cu|tty)\.[\w.-]+|\/dev\/tty\w+|COM\d+/g, '<port>')
    .replace(/0x[0-9a-fA-F]+/g, '0x…')
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

// Things a diff must never carry: keys, passwords, SSIDs, emails, home paths.
const SECRET_LINE = /\b(ssid|pass(?:word|wd|phrase)?|secret|token|api[_-]?key|apikey|auth|bearer|private)\b/i;
const KEY_PATTERNS = [/sk-ant-[A-Za-z0-9_-]{8,}/g, /sk-[A-Za-z0-9_-]{16,}/g, /AIza[0-9A-Za-z_-]{20,}/g, /ghp_[A-Za-z0-9]{20,}/g, /xox[baprs]-[A-Za-z0-9-]{10,}/g];

/** Code or text with secrets and personal paths replaced. */
function redact(text) {
  let s = String(text || '');
  for (const re of KEY_PATTERNS) s = s.replace(re, '<key>');
  s = s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>');
  s = s.replace(/\/Users\/[^/\s"']+/g, '/Users/<user>').replace(/\/home\/[^/\s"']+/g, '/home/<user>').replace(/C:\\Users\\[^\\\s"']+/gi, 'C:\\Users\\<user>');
  // A string literal on a line that names a credential: the literal goes.
  s = s.split('\n').map((line) => (SECRET_LINE.test(line) ? line.replace(/"(?:[^"\\]|\\.)*"/g, '"<redacted>"').replace(/'(?:[^'\\]|\\.){2,}'/g, "'<redacted>'") : line)).join('\n');
  return s;
}

/** Library headers a sketch includes: #include <DHT.h> → DHT. */
function librariesOf(code) {
  const out = new Set();
  for (const m of String(code || '').matchAll(/^\s*#include\s*[<"]([^>"]+)[>"]/gm)) {
    const name = m[1].replace(/\.(h|hpp)$/, '').split('/')[0];
    if (!/^(Arduino|avr|stdint|stdio|stdlib|string|math|Wire|SPI|EEPROM|Serial)$/i.test(name)) out.add(name);
  }
  return [...out].slice(0, 20);
}

/**
 * A compact unified-style diff of two texts (line LCS), with 2 lines of
 * context per hunk, bounded in lines and bytes.
 * @returns {string}
 */
function diffText(before, after, { maxLines = MAX_DIFF_LINES, maxBytes = MAX_DIFF } = {}) {
  const a = String(before || '').split('\n').slice(0, maxLines);
  const b = String(after || '').split('\n').slice(0, maxLines);
  // LCS table (bounded sizes keep this cheap).
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const ops = []; // [' ' | '-' | '+', line, aIndex, bIndex]
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i], i, j]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', a[i], i, j]); i++; } else { ops.push(['+', b[j], i, j]); j++; }
  }
  while (i < n) { ops.push(['-', a[i], i, j]); i++; }
  while (j < m) { ops.push(['+', b[j], i, j]); j++; }
  // Hunks: changed runs with 2 lines of context.
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, k) => { if (op[0] !== ' ') for (let d = -2; d <= 2; d++) if (ops[k + d]) keep[k + d] = true; });
  const out = [];
  let open = false;
  ops.forEach((op, k) => {
    if (!keep[k]) { if (open) { out.push('@@'); open = false; } return; }
    if (!open) { out.push(`@@ -${op[2] + 1} +${op[3] + 1} @@`); open = true; }
    out.push(`${op[0]}${op[1]}`);
  });
  let text = out.join('\n');
  if (text.length > maxBytes) text = `${text.slice(0, maxBytes)}\n@@ … diff cut at ${maxBytes} bytes @@`;
  return text;
}

class FixCapture extends EventEmitter {
  /**
   * @param {{ file?: string|null, now?: () => number }} [opts]  file: where local fixes are kept (null = memory only)
   */
  constructor({ file = null, now = Date.now } = {}) {
    super();
    this.file = file;
    this.now = now;
    this.pending = new Map(); // sketchPath → the last failure
    this.fixes = [];
    this.counts = new Map(); // hash → times seen
    this._load();
  }

  _load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.fixes = Array.isArray(data.fixes) ? data.fixes : [];
      for (const [k, v] of Object.entries(data.counts || {})) this.counts.set(k, Number(v) || 0);
    } catch { /* first run */ }
  }

  _save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ fixes: this.fixes.slice(-MAX_LOCAL), counts: Object.fromEntries(this.counts) }), 'utf8');
    } catch (error) {
      this.emit('error', error);
    }
  }

  /**
   * A build finished. `code` is the sketch's text at that moment.
   * @param {{ kind: 'compile'|'upload', ok: boolean, sketchPath: string, fqbn?: string, coreVersion?: string,
   *   output?: string, failureCode?: string, excerpt?: string, code?: string, editedBy?: 'agent'|'user'|null, model?: string|null }} build
   * @returns {object|null} the fix recorded, if this success closed a failure
   */
  observeBuild(build) {
    const key = build.sketchPath || '*';
    if (!build.ok) {
      const sig = signatureOf(build.output || build.excerpt || '', build.kind, build.failureCode || '');
      this.counts.set(sig.hash, (this.counts.get(sig.hash) || 0) + 1);
      const previous = this.pending.get(key);
      // Keep the first failure's code: it is what the fix started from.
      this.pending.set(key, {
        ...sig, kind: build.kind, failureCode: build.failureCode || null, fqbn: build.fqbn || null, coreVersion: build.coreVersion || '',
        excerpt: redact(String(build.excerpt || firstErrorLine(build.output)).slice(0, MAX_EXCERPT)),
        codeBefore: previous && previous.hash === sig.hash ? previous.codeBefore : String(build.code || ''),
        at: this.now(),
      });
      this._save();
      return null;
    }
    const failure = this.pending.get(key);
    if (!failure) return null;
    this.pending.delete(key);
    if (this.now() - failure.at > FIX_WINDOW_MS) return null;
    // An upload that fails and then succeeds with the same code is a hardware or
    // port fix (nothing to diff); a compile fix needs a change in the sketch.
    const after = String(build.code || '');
    const diff = failure.codeBefore === after ? '' : diffText(failure.codeBefore, after);
    if (failure.kind === 'compile' && !diff) return null;
    const fix = {
      id: `f_${this.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      hash: failure.hash,
      signature: failure.signature,
      kind: failure.kind,
      failureCode: failure.failureCode,
      board: failure.fqbn ? failure.fqbn.split(':').slice(0, 3).join(':') : null,
      core: failure.fqbn ? failure.fqbn.split(':').slice(0, 2).join(':') : null,
      coreVersion: failure.coreVersion || '',
      libraries: librariesOf(after),
      errorExcerpt: failure.excerpt,
      diff: redact(diff),
      fixedBy: build.editedBy || 'unknown',
      model: build.model || null,
      at: new Date(this.now()).toISOString(),
      shared: false,
    };
    this.fixes.push(fix);
    if (this.fixes.length > MAX_LOCAL) this.fixes.splice(0, this.fixes.length - MAX_LOCAL);
    this._save();
    this.emit('fix', fix);
    return fix;
  }

  /** Local fixes for a failure, newest first; `count` says how often the error was seen here. */
  lookup(outputOrSignature, kind = 'compile', failureCode = '') {
    const { hash } = typeof outputOrSignature === 'object' && outputOrSignature?.hash ? outputOrSignature : signatureOf(outputOrSignature, kind, failureCode);
    return {
      hash,
      count: this.counts.get(hash) || 0,
      fixes: this.fixes.filter((f) => f.hash === hash).slice(-3).reverse(),
    };
  }

  markShared(id) {
    const fix = this.fixes.find((f) => f.id === id);
    if (fix) { fix.shared = true; this._save(); }
  }

  /** Fixes not yet sent to the cloud. */
  unshared() {
    return this.fixes.filter((f) => !f.shared);
  }

  stats() {
    return { fixes: this.fixes.length, shared: this.fixes.filter((f) => f.shared).length, errorsSeen: [...this.counts.values()].reduce((a, b) => a + b, 0) };
  }
}

function firstErrorLine(output) {
  const lines = String(output || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /error/i.test(l)) || lines[lines.length - 1] || '';
}

module.exports = { FixCapture, signatureOf, normalizeLine, redact, librariesOf, diffText, FIX_WINDOW_MS };
