const { BuildJobs, BuildBusyError } = require('../buildJobs');

const tick = () => new Promise((r) => setTimeout(r, 60));

describe('BuildJobs', () => {
  it('runs a job and emits start, stage, progress, output and done in order', async () => {
    const jobs = new BuildJobs();
    const events = [];
    jobs.on('event', (e) => events.push(e));
    const result = await jobs.run({ kind: 'upload', sketchPath: '/s/a.ino', fqbn: 'arduino:avr:uno', port: '/dev/x' }, async (h) => {
      h.line('Compiling sketch...');
      h.line('Sketch uses 924 bytes (2%) of program storage space. Maximum is 32256 bytes.');
      h.stage('uploading');
      h.line('avrdude: writing flash (924 bytes):');
      h.line('Writing | ######                                             | 12% 0.01s');
      h.line('Writing | ################################################## | 100% 0.15s');
      return { success: true, memory: { flash: { used: 924, max: 32256, percent: 2 } }, summary: ['Sketch uses 924 bytes'], output: 'x'.repeat(5000) };
    });
    expect(result.success).toBe(true);
    const phases = events.map((e) => e.phase);
    expect(phases[0]).toBe('start');
    expect(phases[phases.length - 1]).toBe('done');
    expect(events.filter((e) => e.phase === 'stage').map((e) => e.stage)).toEqual(['compiling-sketch', 'sizing', 'uploading', 'writing']);
    expect(events.filter((e) => e.phase === 'progress').map((e) => e.percent)).toEqual([12, 100]);
    const done = events[events.length - 1];
    expect(done.ok).toBe(true);
    expect(done.result.memory.flash.used).toBe(924);
    expect(done.result.output).toBeUndefined(); // the log stays in the main process
    expect(done.summary).toEqual(['Sketch uses 924 bytes']);
    expect(jobs.status()).toBeNull();
  });

  it('batches output lines and keeps every noteworthy one', async () => {
    const jobs = new BuildJobs();
    const batches = [];
    jobs.on('event', (e) => { if (e.phase === 'output') batches.push(e.lines); });
    await jobs.run({ kind: 'compile', sketchPath: '/s/a.ino' }, async (h) => {
      for (let i = 0; i < 10; i++) h.line(`line ${i}`);
      await tick();
      h.line('late line');
      return { success: true };
    });
    expect(batches.flat()).toEqual([...Array.from({ length: 10 }, (_, i) => `line ${i}`), 'late line']);
    expect(batches.length).toBeLessThan(11);
  });

  it('joins a repeated request for the same job instead of starting another', async () => {
    const jobs = new BuildJobs();
    let starts = 0;
    jobs.on('event', (e) => { if (e.phase === 'start') starts++; });
    let release;
    const gate = new Promise((r) => { release = r; });
    const spec = { kind: 'compile', sketchPath: '/s/a.ino', fqbn: 'arduino:avr:uno' };
    const first = jobs.run(spec, async () => { await gate; return { success: true, id: 1 }; });
    const second = jobs.run(spec, async () => ({ success: true, id: 2 }));
    expect(jobs.status()).toMatchObject({ kind: 'compile', stage: 'starting' });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(a.id).toBe(1);
    expect(starts).toBe(1);
  });

  it('refuses a different job while one runs, naming its stage', async () => {
    const jobs = new BuildJobs();
    let release;
    const gate = new Promise((r) => { release = r; });
    const running = jobs.run({ kind: 'compile', sketchPath: '/s/a.ino' }, async (h) => { h.stage('linking'); await gate; return { success: true }; });
    let error = null;
    try {
      jobs.run({ kind: 'upload', sketchPath: '/s/a.ino', port: '/dev/x' }, async () => ({ success: true }));
    } catch (e) { error = e; }
    expect(error).toBeInstanceOf(BuildBusyError);
    expect(error.code).toBe('BUSY');
    expect(error.message).toMatch(/A compile is already running \(Linking/);
    release();
    await running;
    // Free again afterwards.
    await expect(jobs.run({ kind: 'upload', sketchPath: '/s/a.ino', port: '/dev/x' }, async () => ({ success: true, ok: 1 }))).resolves.toMatchObject({ ok: 1 });
  });

  it('reports a failure with its code and frees the lock', async () => {
    const jobs = new BuildJobs();
    const events = [];
    jobs.on('event', (e) => events.push(e));
    const err = Object.assign(new Error('The sketch is too big'), { code: 'SKETCH_TOO_BIG', hint: 'Shrink it', diagnostics: [{ line: 1 }], summary: ['Sketch uses 40,102 bytes'] });
    await expect(jobs.run({ kind: 'compile', sketchPath: '/s/a.ino' }, async () => { throw err; })).rejects.toBe(err);
    const done = events[events.length - 1];
    expect(done).toMatchObject({ phase: 'done', ok: false, error: { code: 'SKETCH_TOO_BIG', title: 'The sketch is too big', hint: 'Shrink it' }, summary: ['Sketch uses 40,102 bytes'] });
    expect(jobs.status()).toBeNull();
  });

  it('cancels the running job and kills its process', async () => {
    const jobs = new BuildJobs();
    const events = [];
    jobs.on('event', (e) => events.push(e));
    const child = { kill: jest.fn() };
    const p = jobs.run({ kind: 'upload', sketchPath: '/s/a.ino', port: '/dev/x' }, async (h) => {
      h.attach(child);
      await new Promise((resolve, reject) => h.signal.addEventListener('abort', () => reject(Object.assign(new Error('killed'), { code: 'CANCELLED' }))));
    });
    expect(jobs.cancel()).toBe(true);
    await expect(p).rejects.toThrow('killed');
    expect(child.kill).toHaveBeenCalled();
    expect(events[events.length - 1]).toMatchObject({ phase: 'done', ok: false, error: { code: 'CANCELLED', title: 'Stopped' } });
    expect(jobs.cancel()).toBe(false);
  });
});
