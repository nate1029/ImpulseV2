/**
 * Build jobs: one compile or upload at a time, watched live.
 *
 * Arduino IDE shows every line a build prints and how far an upload has got;
 * Impulse used to show a fake percentage and announce the result at the end,
 * so a second click could start a second build while the first was still
 * running. A BuildJobs instance owns the lock (one job at a time; the same
 * job asked for twice is joined, a different one is refused with BUSY) and
 * emits events as a job runs:
 *
 *   { phase: 'start',    jobId, kind, sketchPath, fqbn, port, label, startedAt }
 *   { phase: 'stage',    jobId, stage, label }
 *   { phase: 'progress', jobId, percent }
 *   { phase: 'output',   jobId, lines: string[] }          (noteworthy lines, batched)
 *   { phase: 'done',     jobId, ok, ms, result | error, summary, stage }
 *
 * The main process forwards them to the renderer as 'build:event'.
 * @module main/services/buildJobs
 */
const { EventEmitter } = require('events');
const { STAGE_LABEL, stageOf, progressOf, isNoteworthy } = require('./buildOutput');

const BATCH_MS = 40;
const KEEP_LINES = 400;

class BuildBusyError extends Error {
  /** @param {object} job  the running job's summary */
  constructor(job) {
    const verb = job.kind === 'upload' ? 'An upload' : 'A compile';
    const secs = Math.round((Date.now() - job.startedAt) / 1000);
    super(`${verb} is already running (${STAGE_LABEL[job.stage] || job.stage}, ${secs}s in). Wait for it to finish; its result arrives on its own.`);
    this.name = 'BuildBusyError';
    this.code = 'BUSY';
    this.job = job;
  }
}

class BuildJobs extends EventEmitter {
  constructor() {
    super();
    this.current = null;
    this.seq = 0;
  }

  /** The running job's summary, or null. */
  status() {
    return this.current ? summarize(this.current) : null;
  }

  /**
   * Run a job. `work(handle)` does the actual compile/upload, reporting through
   * the handle: `line(text)` for every output line, `stage(name)`, `progress(pct)`,
   * `attach(childProcess)` so cancel can kill it, and `signal` to notice a cancel.
   * @template T
   * @param {{ kind: 'compile'|'upload', sketchPath: string, fqbn?: string, port?: string, label?: string }} spec
   * @param {(handle: object) => Promise<T>} work
   * @returns {Promise<T>}
   */
  run(spec, work) {
    if (this.current) {
      const c = this.current;
      const same = c.kind === spec.kind && c.sketchPath === spec.sketchPath && (c.port || '') === (spec.port || '') && (c.fqbn || '') === (spec.fqbn || '');
      if (same) return c.promise;
      throw new BuildBusyError(summarize(c));
    }
    const job = {
      id: `b${++this.seq}_${Date.now().toString(36)}`,
      kind: spec.kind,
      sketchPath: spec.sketchPath,
      fqbn: spec.fqbn || null,
      port: spec.port || null,
      label: spec.label || null,
      startedAt: Date.now(),
      stage: 'starting',
      progress: null,
      lines: [],
      pending: [],
      timer: null,
      process: null,
      controller: new AbortController(),
    };
    this.current = job;
    this.emit('event', { phase: 'start', jobId: job.id, kind: job.kind, sketchPath: job.sketchPath, fqbn: job.fqbn, port: job.port, label: job.label, startedAt: job.startedAt });

    const handle = {
      id: job.id,
      kind: job.kind,
      signal: job.controller.signal,
      attach: (child) => { job.process = child; },
      stage: (name) => this._stage(job, name),
      progress: (pct) => this._progress(job, pct),
      line: (text) => this._line(job, text),
    };

    job.promise = (async () => {
      const started = Date.now();
      try {
        const result = await work(handle);
        this._flush(job);
        this.emit('event', { phase: 'done', jobId: job.id, kind: job.kind, ok: true, ms: Date.now() - started, stage: job.stage, port: job.port, result: publicResult(result), summary: result?.summary || [] });
        // The full result, for the main process only (learning from fixes); never sent to the window.
        this.emit('result', { jobId: job.id, kind: job.kind, sketchPath: job.sketchPath, fqbn: job.fqbn, port: job.port, ok: true, result });
        return result;
      } catch (error) {
        this._flush(job);
        const cancelled = job.controller.signal.aborted;
        if (!cancelled) this.emit('result', { jobId: job.id, kind: job.kind, sketchPath: job.sketchPath, fqbn: job.fqbn, port: job.port, ok: false, error });
        this.emit('event', {
          phase: 'done', jobId: job.id, kind: job.kind, ok: false, ms: Date.now() - started, stage: job.stage, port: job.port,
          error: {
            code: cancelled ? 'CANCELLED' : error?.code || (job.kind === 'upload' ? 'UPLOAD_FAILED' : 'COMPILE_FAILED'),
            title: cancelled ? 'Stopped' : error?.title || error?.message || 'Failed',
            hint: cancelled ? '' : error?.hint || '',
            message: error?.message || 'Failed',
            excerpt: error?.excerpt || '',
            diagnostics: Array.isArray(error?.diagnostics) ? error.diagnostics.slice(0, 20) : [],
          },
          summary: Array.isArray(error?.summary) ? error.summary : [],
        });
        throw error;
      } finally {
        if (this.current === job) this.current = null;
      }
    })();
    return job.promise;
  }

  /** Stop the running job (kills its process). True when there was one. */
  cancel() {
    const job = this.current;
    if (!job) return false;
    job.controller.abort();
    try { job.process?.kill(); } catch { /* already gone */ }
    return true;
  }

  _stage(job, name) {
    if (!name || name === job.stage) return;
    job.stage = name;
    job.progress = null;
    this._flush(job);
    this.emit('event', { phase: 'stage', jobId: job.id, kind: job.kind, stage: name, label: STAGE_LABEL[name] || name });
  }

  _progress(job, pct) {
    if (typeof pct !== 'number' || Number.isNaN(pct) || pct === job.progress) return;
    job.progress = pct;
    this.emit('event', { phase: 'progress', jobId: job.id, kind: job.kind, percent: pct });
  }

  _line(job, text) {
    const line = String(text ?? '').replace(/\r$/, '');
    // A tool's own stage or progress words count even when the line is long.
    const stage = stageOf(line);
    if (stage) this._stage(job, stage);
    const pct = progressOf(line);
    if (pct !== null) this._progress(job, pct);
    if (!isNoteworthy(line)) return;
    job.lines.push(line);
    if (job.lines.length > KEEP_LINES) job.lines.splice(0, job.lines.length - KEEP_LINES);
    job.pending.push(line);
    if (!job.timer) job.timer = setTimeout(() => this._flush(job), BATCH_MS);
  }

  _flush(job) {
    if (job.timer) { clearTimeout(job.timer); job.timer = null; }
    if (!job.pending.length) return;
    const lines = job.pending;
    job.pending = [];
    this.emit('event', { phase: 'output', jobId: job.id, kind: job.kind, lines });
  }
}

function summarize(job) {
  return { id: job.id, kind: job.kind, sketchPath: job.sketchPath, fqbn: job.fqbn, port: job.port, stage: job.stage, progress: job.progress, startedAt: job.startedAt };
}

/** What of a result travels to the renderer: facts, not the whole log. */
function publicResult(result) {
  if (!result || typeof result !== 'object') return null;
  const { memory = null, summary = [], warnings = [], diagnostics = [], message = '', port = null,
    pinIssues = [], pinReport = null, installedLibraries = [] } = result;
  return {
    memory, summary, warnings: warnings.slice(0, 20), diagnostics: diagnostics.slice(0, 20), message, port,
    pinIssues: pinIssues.slice(0, 10), pinReport, installedLibraries,
  };
}

module.exports = { BuildJobs, BuildBusyError };
