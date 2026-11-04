// Source-level debugger for the simulated board: breakpoints, stepping by
// sketch line, and the values of locals, globals and registers. Works from
// the DWARF information of a debug build (see dwarf.js) and stops the CPU
// between instructions through AvrRunner.stopCheck.

import { DATA_OFFSET, ENCODING, frameRules } from './dwarf.js';

const KEY_STRIDE = 1_000_000; // line key = file index * stride + line
const MAX_FRAMES = 32;
// Registers a called function must preserve (avr-gcc ABI); r1 is always zero in C code.
const CALL_SAVED = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 28, 29]);
const MAX_CHILDREN = 256;
const MAX_STRING = 200;

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');

/** Whether `file` lies inside one of `dirs` (paths compared case-insensitively). */
export function inDirs(file, dirs) {
  const f = norm(file).toLowerCase();
  return dirs.some(d => d && f.startsWith(`${norm(d).toLowerCase()}/`));
}

export class Debugger {
  /**
   * @param {import('./avr-runner.js').AvrRunner} runner - with the debug build loaded
   * @param {ReturnType<import('./dwarf.js').readDebugInfo>} info
   * @param {{ sketchDirs: string[], live?: boolean, remap?: [string, string][] }} options -
   *   sketchDirs: folders whose files are "the sketch";
   *   live: false leaves running to the caller (runner.runUntilStop) instead of the animation loop;
   *   remap: path prefixes to rewrite ([build copy of the sketch, sketch folder])
   */
  constructor(runner, info, { sketchDirs, live = true, remap = [] }) {
    this.runner = runner;
    this.live = live;
    // Sketch files get one spelling, the app's (sketchDirs[0]): the compiler may
    // record real paths, or the build folder's copy of a sketch's .cpp files.
    const rules = [...remap, ...sketchDirs.map(d => [d, sketchDirs[0]])]
      .map(([from, to]) => [`${norm(from)}/`, `${norm(to)}/`])
      .sort((a, b) => b[0].length - a[0].length);
    this._canonical = (f) => {
      const n = norm(f);
      const rule = rules.find(([from]) => n.toLowerCase().startsWith(from.toLowerCase()));
      return rule ? rule[1] + n.slice(rule[0].length) : n;
    };
    info = { ...info, files: info.files.map(this._canonical) };
    this.info = info;
    this.functionStarts = new Set(info.functions.map(fn => fn.low));
    this.sketchDirs = sketchDirs;
    // A PlatformIO project's downloaded libraries (.pio/libdeps) aren't the user's code.
    this.sketchFiles = new Set(info.files.map((f, i) => (inDirs(f, sketchDirs) && !/\/\.pio\//.test(f) ? i : -1)).filter(i => i >= 0));
    const words = runner.cpu.progMem.length;
    this.lineKey = new Int32Array(words).fill(-1);
    this.stmtStart = new Uint8Array(words);
    this.breakWords = new Uint8Array(words);
    this.tempWords = new Uint8Array(words);
    this.breakpoints = new Map(); // file index → Map(requested line → { line, words })
    this.onStop = null; // ({ reason, location }) => void
    this.stopReason = null;
    this._mode = null;
    this._buildLineMap();
  }

  _buildLineMap() {
    const { rows, inlined } = this.info;
    for (let i = 0; i < rows.length - 1; i++) {
      const row = rows[i];
      if (row.end) continue;
      const next = rows[i + 1];
      if (next.address <= row.address) continue;
      const from = row.address >> 1;
      const to = Math.min(next.address >> 1, this.lineKey.length);
      const key = this.sketchFiles.has(row.file) ? row.file * KEY_STRIDE + row.line : -1;
      for (let w = from; w < to; w++) this.lineKey[w] = key;
      if (key >= 0 && row.stmt) this.stmtStart[from] = 1;
    }
    // Core code inlined into the sketch (Serial.begin…) belongs to the line that calls it.
    for (const inl of inlined) {
      if (!this.sketchFiles.has(inl.file)) continue;
      const key = inl.file * KEY_STRIDE + inl.line;
      const from = inl.low >> 1;
      if (this.lineKey[from] < 0) this.stmtStart[from] = 1;
      for (let w = from; w < Math.min(inl.high >> 1, this.lineKey.length); w++) if (this.lineKey[w] < 0) this.lineKey[w] = key;
    }
  }

  // ── Source positions ──────────────────────────────────────────────────────

  fileIndex(path) {
    const want = this._canonical(path).toLowerCase();
    return this.info.files.findIndex((f, i) => this.sketchFiles.has(i) && norm(f).toLowerCase() === want);
  }

  /** Sketch file and line at a word address, or null outside the sketch. */
  lineAt(word) {
    const key = this.lineKey[word];
    if (key === undefined || key < 0) return null;
    const file = Math.floor(key / KEY_STRIDE);
    return { file: this.info.files[file], line: key % KEY_STRIDE };
  }

  functionAt(byteAddress) {
    let best = null;
    for (const fn of this.info.functions) {
      if (byteAddress >= fn.low && byteAddress < fn.high && (!best || fn.high - fn.low < best.high - best.low)) best = fn;
    }
    return best;
  }

  /** Where the CPU is stopped: function, and sketch file/line when it has one. */
  location() {
    const pc = this.runner.cpu.pc;
    const fn = this.functionAt(pc * 2);
    const at = this.lineAt(pc);
    return {
      pc: pc * 2,
      function: fn ? displayName(fn.name) : null,
      file: at?.file || null,
      line: at?.line || null,
      inSketch: !!at,
      functionFile: fn && fn.file >= 0 ? this.info.files[fn.file] : null,
    };
  }

  /**
   * Word addresses where execution of `line` starts: the first address of the
   * line in each function (or inlined call). Lines without code move to the
   * next line that has some, like most debuggers.
   * @returns {{ line: number, words: number[] } | null}
   */
  resolveLine(file, line) {
    const fi = typeof file === 'number' ? file : this.fileIndex(file);
    if (fi < 0) return null;
    const { rows, inlined } = this.info;
    for (let l = line; l < line + 50; l++) {
      const starts = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r.end || r.file !== fi || r.line !== l || !r.stmt) continue;
        const next = rows[i + 1];
        // An empty row, unless it is a function's entry (a breakpoint on its signature line).
        if (next && next.address === r.address && !this.functionStarts.has(r.address)) continue;
        starts.push(r.address);
      }
      for (const inl of inlined) if (inl.file === fi && inl.line === l) starts.push(inl.low);
      if (!starts.length) continue;
      const byFunction = new Map();
      for (const a of starts) {
        const fn = this.functionAt(a);
        const k = fn ? fn.low : a;
        if (!byFunction.has(k) || a < byFunction.get(k)) byFunction.set(k, a);
      }
      return { line: l, words: [...byFunction.values()].map(a => a >> 1).sort((x, y) => x - y) };
    }
    return null;
  }

  /**
   * Replace the breakpoints of one file.
   * @returns {Map<number, number|null>} requested line → line it landed on (null: no code there)
   */
  setBreakpoints(file, lines) {
    const fi = this.fileIndex(file);
    const result = new Map();
    if (fi >= 0) this.breakpoints.set(fi, new Map());
    for (const line of lines) {
      const resolved = fi >= 0 ? this.resolveLine(fi, line) : null;
      result.set(line, resolved ? resolved.line : null);
      if (resolved) this.breakpoints.get(fi).set(line, resolved);
    }
    this.breakWords.fill(0);
    for (const perFile of this.breakpoints.values()) {
      for (const bp of perFile.values()) for (const w of bp.words) this.breakWords[w] = 1;
    }
    return result;
  }

  clearBreakpoints() {
    this.breakpoints.clear();
    this.breakWords.fill(0);
  }

  /** A function defined in the sketch, by name. */
  sketchFunction(name) {
    return this.info.functions.find(fn => fn.name === name && this.sketchFiles.has(fn.file)) || null;
  }

  // ── Run control ───────────────────────────────────────────────────────────

  /** Install the stop check and let the runner go. */
  _go(mode) {
    this._mode = mode;
    this.stopReason = null;
    this.runner.stopCheck = (cpu) => this._check(cpu);
    this.runner.onBreak = () => this._stopped();
    if (this.live) this.runner.start();
  }

  _check(cpu) {
    const pc = cpu.pc;
    if (this.breakWords[pc]) { this.stopReason = 'breakpoint'; return true; }
    if (this.tempWords[pc]) { this.stopReason = 'cursor'; return true; }
    if (this._mode && this._mode(cpu, pc)) { this.stopReason = 'step'; return true; }
    return false;
  }

  _stopped() {
    this._mode = null;
    this.tempWords.fill(0);
    this.onStop?.({ reason: this.stopReason, location: this.location() });
  }

  continue() {
    this._go(null);
  }

  /** Stop at the first sketch line reached (start of debugging with no breakpoints). */
  runToSketch() {
    this._go((cpu, pc) => this.lineKey[pc] >= 0);
  }

  runToLine(file, line) {
    const resolved = this.resolveLine(file, line);
    if (!resolved) return false;
    for (const w of resolved.words) this.tempWords[w] = 1;
    this._go(null);
    return true;
  }

  _stepper(over) {
    const cpu = this.runner.cpu;
    let startKey = this.lineKey[cpu.pc];
    let startSp = cpu.SP;
    let lastPc = cpu.pc;
    return (c, pc) => {
      const key = this.lineKey[pc];
      const prev = lastPc;
      lastPc = pc;
      if (key < 0) return false;
      const sp = c.SP;
      if (over && sp < startSp) return false; // inside a call (or an interrupt)
      if (sp > startSp && !this.stmtStart[pc]) {
        // Returned into the middle of the caller's line: finish that line first.
        startKey = key;
        startSp = sp;
        return false;
      }
      if (key !== startKey) return true;
      return !!this.stmtStart[pc] && pc <= prev; // the same line again: a loop
    };
  }

  stepInto() { this._go(this._stepper(false)); }

  stepOver() { this._go(this._stepper(true)); }

  stepOut() {
    const startSp = this.runner.cpu.SP;
    let returned = false;
    this._go((cpu, pc) => {
      if (cpu.SP > startSp) returned = true;
      return returned && this.lineKey[pc] >= 0;
    });
  }

  pause() {
    if (!this.runner.running) return;
    this.runner.stop();
    this.stopReason = 'pause';
    this._stopped();
  }

  /** Remove the hooks from the runner. */
  detach() {
    this.runner.stopCheck = null;
    this.runner.onBreak = null;
    this._mode = null;
  }

  // ── Call stack ────────────────────────────────────────────────────────────

  _topFrame() {
    const cpu = this.runner.cpu;
    return { pc: cpu.pc * 2, lookupPc: cpu.pc * 2, sp: cpu.SP, regs: Array.from(cpu.data.subarray(0, 32)) };
  }

  _fdeAt(pc) {
    return this.info.frames?.find(f => pc >= f.low && pc < f.high) || null;
  }

  /** The calling frame, from the frame description of the function `frame` is in. */
  _caller(frame) {
    const fde = this._fdeAt(frame.lookupPc);
    const rules = fde && frameRules(fde, frame.lookupPc);
    if (!rules) return null;
    const base = rules.cfaReg === 32 ? frame.sp : pair(frame.regs, rules.cfaReg);
    if (base === null) return null;
    const cfa = base + rules.cfaOffset;
    const ra = rules.rules.get(fde.cie.raReg);
    if (!ra || ra[0] !== 'offset') return null;
    const data = this.runner.cpu.data;
    const pcBytes = this.runner.cpu.pc22Bits ? 3 : 2;
    let word = 0;
    for (let i = 0; i < pcBytes; i++) word = word * 256 + (data[cfa + ra[1] + i] ?? 0);
    if (!word || word >= this.lineKey.length) return null;
    const regs = frame.regs.map((v, n) => (n === 1 ? 0 : CALL_SAVED.has(n) ? v : null));
    for (const [reg, rule] of rules.rules) {
      if (reg >= 32) continue;
      if (rule[0] === 'offset') regs[reg] = data[cfa + rule[1]] ?? null;
      else if (rule[0] === 'undefined') regs[reg] = null;
      else if (rule[0] === 'register') regs[reg] = frame.regs[rule[1]] ?? null;
    }
    // A return address points after the call; its line is the call's.
    return { pc: word * 2, lookupPc: word * 2 - 2, sp: cfa, regs };
  }

  /**
   * Frames from the current one outwards, to main().
   * @returns {{ index: number, function: string|null, file: string|null, line: number|null, inSketch: boolean, pc: number }[]}
   */
  callStack() {
    const out = [];
    let frame = this._topFrame();
    for (let i = 0; frame && i < MAX_FRAMES; i++) {
      const fn = this.functionAt(frame.lookupPc);
      const at = this.lineAt(frame.lookupPc >> 1);
      out.push({ index: i, function: fn ? displayName(fn.name) : null, file: at?.file || null, line: at?.line || null, inSketch: !!at, pc: frame.pc, frame });
      if (!fn || fn.name === 'main') break;
      frame = this._caller(frame);
    }
    return out;
  }

  // ── Values ────────────────────────────────────────────────────────────────

  registers() {
    const cpu = this.runner.cpu;
    const sreg = cpu.data[95];
    return {
      r: Array.from(cpu.data.subarray(0, 32)),
      sreg,
      flags: 'ITHSVNZC'.split('').map((f, i) => ((sreg >> (7 - i)) & 1 ? f : f.toLowerCase())).join(''),
      sp: cpu.SP,
      pc: cpu.pc * 2,
      cycles: cpu.cycles,
    };
  }

  /** Sketch globals with their current values. */
  globals() {
    const seen = new Set();
    return this.info.globals
      .filter(g => this.sketchFiles.has(g.file))
      .filter(g => !seen.has(g.name) && seen.add(g.name))
      .sort((a, b) => a.line - b.line)
      .map(g => (g.address === 0
        ? { name: g.name, type: this.typeName(g.type), value: 'optimized out (never used)', unavailable: true }
        : this._variable(g, null)));
  }

  /** Parameters and locals of a frame's function (0: where the CPU is). */
  locals(frameIndex = 0) {
    const frame = frameIndex === 0 ? this._topFrame() : this.callStack()[frameIndex]?.frame;
    if (!frame) return [];
    const pcByte = frame.lookupPc;
    const fn = this.functionAt(pcByte);
    if (!fn) return [];
    const vars = [...fn.vars];
    for (const b of fn.blocks) if (pcByte >= b.low && pcByte < b.high) vars.push(...b.vars);
    this._frame = frame;
    try {
      const frameBase = fn.frameBase ? this._evalAddress(fn.frameBase, pcByte) : null;
      return vars.map(v => this._variable(v, frameBase, pcByte));
    } finally {
      this._frame = null;
    }
  }

  _variable(v, frameBase, pcByte = this.runner.cpu.pc * 2) {
    const typeName = this.typeName(v.type);
    const size = this.sizeOf(v.type);
    let bytes = null;
    if (v.constValue !== null && v.constValue !== undefined) {
      bytes = Array.isArray(v.constValue) ? Uint8Array.from(v.constValue) : intBytes(v.constValue, size || 2);
    } else {
      const expr = pickExpr(v.loc, pcByte);
      if (!expr) return { name: v.name, type: typeName, value: 'optimized out here', unavailable: true, param: v.param };
      const r = this._evaluate(expr, size || 1, frameBase);
      if (r.error || !r.bytes) return { name: v.name, type: typeName, value: r.error || 'not available in this frame', unavailable: true, param: v.param };
      bytes = r.bytes;
    }
    return { name: v.name, type: typeName, param: v.param, ...this.format(v.type, bytes, 0) };
  }

  _evalAddress(loc, pcByte) {
    const expr = pickExpr(loc, pcByte);
    if (!expr) return null;
    const r = this._run(expr, null);
    if (r.error) return null;
    if (r.loc?.kind === 'reg') {
      try {
        return this._regValue(r.loc.reg);
      } catch {
        return null;
      }
    }
    return r.stack.length ? r.stack[r.stack.length - 1] : null;
  }

  /** Registers of the frame being evaluated (the CPU's own unless a caller's frame is selected). */
  _regs() {
    return this._frame || { sp: this.runner.cpu.SP, regs: Array.from(this.runner.cpu.data.subarray(0, 32)) };
  }

  /** A register as an address-sized value (a pair from rN); throws when a caller's register is unknown. */
  _regValue(n) {
    const f = this._regs();
    if (n === 32) return f.sp;
    const v = n === 31 ? f.regs[31] : pair(f.regs, n);
    if (v === null || v === undefined) throw new Error('unavailable');
    return v;
  }

  /** Run a DWARF expression: the final stack, pieces and pending location. */
  _run(expr, frameBase) {
    const cpu = this.runner.cpu;
    const stack = [];
    const pieces = [];
    let loc = null;
    const pop = () => {
      if (!stack.length) throw new Error('unavailable');
      return stack.pop();
    };
    const binary = (fn) => { const b = pop(); const a = pop(); stack.push(fn(a, b)); };
    try {
      for (const [op, a, b] of expr) {
        switch (op) {
          case 'addr': stack.push(a); break;
          case 'lit': case 'const': stack.push(a); break;
          case 'reg': loc = { kind: 'reg', reg: a }; break;
          case 'breg': stack.push(this._regValue(a) + b); break;
          case 'fbreg':
            if (frameBase === null) throw new Error('unavailable');
            stack.push(frameBase + a);
            break;
          case 'deref': { const addr = dataAddr(pop()); stack.push(cpu.data[addr] | (cpu.data[addr + 1] << 8)); break; }
          case 'deref_size': {
            const addr = dataAddr(pop());
            let v = 0;
            for (let i = a - 1; i >= 0; i--) v = v * 256 + (cpu.data[addr + i] ?? 0);
            stack.push(v);
            break;
          }
          case 'dup': stack.push(stack[stack.length - 1]); break;
          case 'drop': pop(); break;
          case 'over': stack.push(stack[stack.length - 2]); break;
          case 'pick': stack.push(stack[stack.length - 1 - a]); break;
          case 'swap': { const x = pop(); const y = pop(); stack.push(x, y); break; }
          case 'abs': stack.push(Math.abs(pop())); break;
          case 'neg': stack.push(-pop()); break;
          case 'not': stack.push(~pop()); break;
          case 'plus_uconst': stack.push(pop() + a); break;
          case 'plus': binary((x, y) => x + y); break;
          case 'minus': binary((x, y) => x - y); break;
          case 'mul': binary((x, y) => x * y); break;
          case 'div': binary((x, y) => (y ? Math.trunc(x / y) : 0)); break;
          case 'mod': binary((x, y) => (y ? x % y : 0)); break;
          case 'and': binary((x, y) => Number(BigInt.asUintN(64, BigInt(x)) & BigInt.asUintN(64, BigInt(y)))); break;
          case 'or': binary((x, y) => Number(BigInt.asUintN(64, BigInt(x)) | BigInt.asUintN(64, BigInt(y)))); break;
          case 'xor': binary((x, y) => Number(BigInt.asUintN(64, BigInt(x)) ^ BigInt.asUintN(64, BigInt(y)))); break;
          case 'shl': binary((x, y) => x * 2 ** y); break;
          case 'shr': binary((x, y) => Math.floor(Math.max(x, 0) / 2 ** y)); break;
          case 'shra': binary((x, y) => Math.floor(x / 2 ** y)); break;
          case 'stack_value': loc = { kind: 'value', value: pop() }; break;
          case 'implicit_value': loc = { kind: 'bytes', bytes: Uint8Array.from(a) }; break;
          case 'piece': {
            const piece = loc || (stack.length ? { kind: 'mem', addr: pop() } : null);
            pieces.push({ loc: piece, size: a });
            loc = null;
            break;
          }
          default: throw new Error('unavailable');
        }
      }
    } catch {
      return { error: 'not available here' };
    }
    return { stack, pieces, loc };
  }

  /** Bytes of a value `size` long, from a location expression. */
  _evaluate(expr, size, frameBase) {
    const r = this._run(expr, frameBase);
    if (r.error) return r;
    const readLoc = (loc, n) => {
      if (!loc) return null;
      if (loc.kind === 'reg') {
        const f = this._regs();
        if (loc.reg === 32) return intBytes(f.sp, n);
        const bytes = Array.from({ length: n }, (_, i) => f.regs[loc.reg + i]);
        return bytes.some(b => b === null || b === undefined) ? null : Uint8Array.from(bytes);
      }
      if (loc.kind === 'value') return intBytes(loc.value, n);
      if (loc.kind === 'bytes') return Uint8Array.from({ length: n }, (_, i) => loc.bytes[i] ?? 0);
      if (loc.kind === 'mem') return this._read(loc.addr, n, loc.flash);
      return null;
    };
    if (r.pieces.length) {
      const out = new Uint8Array(Math.max(size, r.pieces.reduce((t, p) => t + p.size, 0)));
      let at = 0;
      for (const p of r.pieces) {
        const bytes = readLoc(p.loc, p.size);
        if (!bytes) return { error: 'partly optimized out' };
        out.set(bytes.subarray(0, p.size), at);
        at += p.size;
      }
      return { bytes: out.subarray(0, size) };
    }
    if (r.loc) return { bytes: readLoc(r.loc, size) };
    if (r.stack.length) {
      const flash = expr[0]?.[0] === 'addr' && expr[0][1] < DATA_OFFSET;
      return { bytes: readLoc({ kind: 'mem', addr: r.stack[r.stack.length - 1], flash }, size) };
    }
    return { error: 'not available here' };
  }

  _read(addr, n, flash = false) {
    const cpu = this.runner.cpu;
    if (flash) return Uint8Array.from({ length: n }, (_, i) => cpu.progBytes[addr + i] ?? 0);
    const a = dataAddr(addr);
    return Uint8Array.from({ length: n }, (_, i) => cpu.data[a + i] ?? 0);
  }

  // ── Types ─────────────────────────────────────────────────────────────────

  /** A type by DIE offset; type objects pass through (array rows are built on the fly). */
  _type(id) {
    if (id && typeof id === 'object') return id;
    return id === null || id === undefined ? null : this.info.types.get(id) || null;
  }

  /** The type with typedefs, const and volatile removed. */
  _strip(id) {
    let t = this._type(id);
    for (let i = 0; t && i < 16 && (t.kind === 'typedef' || t.kind === 'const' || t.kind === 'volatile'); i++) t = this._type(t.target);
    return t;
  }

  typeName(id, depth = 0) {
    const t = this._type(id);
    if (!t) return 'void';
    if (depth > 8) return '…';
    switch (t.kind) {
      case 'pointer': return `${this.typeName(t.target, depth + 1)}*`;
      case 'reference': return `${this.typeName(t.target, depth + 1)}&`;
      case 'const': return `const ${this.typeName(t.target, depth + 1)}`;
      case 'volatile': return `volatile ${this.typeName(t.target, depth + 1)}`;
      case 'array': return `${this.typeName(t.target, depth + 1)}${t.dims.map(d => `[${d}]`).join('')}`;
      case 'function': return 'function';
      default: return t.name || `(${t.kind})`;
    }
  }

  sizeOf(id, depth = 0) {
    const t = this._type(id);
    if (!t || depth > 16) return 0;
    if (t.size !== null && t.size !== undefined) return t.size;
    if (t.kind === 'array') return this.sizeOf(t.target, depth + 1) * t.dims.reduce((a, b) => a * b, 1);
    if (t.kind === 'typedef' || t.kind === 'const' || t.kind === 'volatile') return this.sizeOf(t.target, depth + 1);
    return 0;
  }

  /**
   * Display value of `bytes` as type `id`.
   * @returns {{ value: string, children?: { name: string, type: string, value: string, children? }[] }}
   */
  format(id, bytes, depth) {
    const t = this._strip(id);
    if (!t) return { value: hex(bytes) };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = Math.min(bytes.length, this.sizeOf(id) || bytes.length);
    switch (t.kind) {
      case 'base': return { value: formatBase(t, view, size) };
      case 'enum': {
        const v = readInt(view, size, true);
        const e = t.enumerators.find(x => x.value === v);
        return { value: e ? `${e.name} (${v})` : String(v) };
      }
      case 'pointer':
      case 'reference': {
        const addr = size >= 2 ? view.getUint16(0, true) : bytes[0];
        const target = this._strip(t.target);
        if (target?.kind === 'base' && (target.encoding === ENCODING.signed_char || target.encoding === ENCODING.unsigned_char) && addr) {
          return { value: `0x${addr.toString(16).padStart(4, '0')} ${quote(this._cString(addr))}` };
        }
        if (t.kind === 'reference' && target && depth < 3) {
          const inner = this.format(t.target, this._read(addr, this.sizeOf(t.target) || 1), depth + 1);
          return { ...inner, value: `${inner.value}` };
        }
        return { value: addr ? `0x${addr.toString(16).padStart(4, '0')}` : 'nullptr' };
      }
      case 'array': {
        const elem = this._strip(t.target);
        const elemSize = this.sizeOf(t.target) || 1;
        const count = t.dims.length > 1 ? t.dims[0] : Math.floor(size / elemSize) || t.dims[0];
        const rowSize = t.dims.length > 1 ? elemSize * t.dims.slice(1).reduce((a, b) => a * b, 1) : elemSize;
        if (t.dims.length === 1 && elem?.kind === 'base' && (elem.encoding === ENCODING.signed_char || elem.encoding === ENCODING.unsigned_char) && elemSize === 1 && elem.name.includes('char')) {
          const end = bytes.indexOf(0);
          const text = decodeChars(bytes.subarray(0, end < 0 ? Math.min(bytes.length, MAX_STRING) : end));
          return { value: quote(text) };
        }
        const children = [];
        const sub = t.dims.length > 1 ? { ...t, dims: t.dims.slice(1) } : null;
        for (let i = 0; i < Math.min(count, MAX_CHILDREN); i++) {
          const slice = bytes.subarray(i * rowSize, (i + 1) * rowSize);
          children.push({ name: `[${i}]`, type: this.typeName(sub || t.target), ...this.format(sub || t.target, slice, depth + 1) });
        }
        const preview = children.slice(0, 8).map(c => c.value).join(', ');
        return { value: `[${preview}${count > 8 ? ', …' : ''}]`, children: depth < 3 ? children : undefined };
      }
      case 'struct':
      case 'class':
      case 'union': {
        if (t.name === 'String') return { value: this._arduinoString(t, view) };
        if (depth >= 3) return { value: '{…}' };
        const children = t.members.map(m => {
          const msize = this.sizeOf(m.type) || 1;
          return { name: m.name, type: this.typeName(m.type), ...this.format(m.type, bytes.subarray(m.offset, m.offset + msize), depth + 1) };
        });
        return { value: `{${children.slice(0, 4).map(c => `${c.name}: ${c.value}`).join(', ')}${children.length > 4 ? ', …' : ''}}`, children };
      }
      default: return { value: hex(bytes) };
    }
  }

  _cString(addr) {
    const cpu = this.runner.cpu;
    const out = [];
    for (let i = 0; i < MAX_STRING; i++) {
      const c = cpu.data[addr + i];
      if (!c) break;
      out.push(c);
    }
    return decodeChars(Uint8Array.from(out));
  }

  _arduinoString(t, view) {
    const member = (name) => t.members.find(m => m.name === name);
    const buffer = member('buffer');
    const len = member('len');
    if (!buffer || !len) return '{…}';
    const addr = view.getUint16(buffer.offset, true);
    const n = view.getUint16(len.offset, true);
    if (!addr) return '""';
    return quote(decodeChars(this._read(addr, Math.min(n, MAX_STRING))));
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** A little-endian register pair rN:rN+1, or null when either is unknown. */
function pair(regs, n) {
  const lo = regs[n];
  const hi = regs[n + 1];
  return lo === null || lo === undefined || hi === null || hi === undefined ? null : lo | (hi << 8);
}

/** Compiler-generated function names, readable. */
function displayName(name) {
  if (/^__static_initialization_and_destruction|^_GLOBAL__sub_I/.test(name)) return 'global constructors';
  return name;
}

function pickExpr(loc, pcByte) {
  if (!loc) return null;
  if (loc.expr) return loc.expr;
  const entry = loc.list?.find(e => pcByte >= e.begin && pcByte < e.end);
  return entry ? entry.expr : null;
}

const dataAddr = (a) => (a >= DATA_OFFSET ? a - DATA_OFFSET : a);

function intBytes(value, n) {
  const out = new Uint8Array(n);
  let v = BigInt.asUintN(64, BigInt(Math.trunc(value)));
  for (let i = 0; i < n; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

function readInt(view, size, signed) {
  switch (size) {
    case 1: return signed ? view.getInt8(0) : view.getUint8(0);
    case 2: return signed ? view.getInt16(0, true) : view.getUint16(0, true);
    case 4: return signed ? view.getInt32(0, true) : view.getUint32(0, true);
    case 8: return signed ? view.getBigInt64(0, true) : view.getBigUint64(0, true);
    default: return 0;
  }
}

function formatBase(t, view, size) {
  if (size === 0 || view.byteLength < size) return '?';
  switch (t.encoding) {
    case ENCODING.boolean: return view.getUint8(0) ? 'true' : 'false';
    case ENCODING.float:
      if (size === 4) return formatFloat(view.getFloat32(0, true));
      if (size === 8) return formatFloat(view.getFloat64(0, true));
      return '?';
    case ENCODING.signed_char:
    case ENCODING.unsigned_char: {
      const v = readInt(view, 1, t.encoding === ENCODING.signed_char);
      const c = view.getUint8(0);
      return c >= 32 && c < 127 ? `${v} '${String.fromCharCode(c)}'` : String(v);
    }
    case ENCODING.signed: return String(readInt(view, size, true));
    case ENCODING.address:
    case ENCODING.unsigned:
    default: return String(readInt(view, size, false));
  }
}

function formatFloat(v) {
  if (!Number.isFinite(v)) return String(v);
  return String(Number(v.toPrecision(7)));
}

const hex = (bytes) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ');

function decodeChars(bytes) {
  return Array.from(bytes, c => (c >= 32 && c < 127 ? String.fromCharCode(c) : c === 10 ? '\\n' : c === 13 ? '\\r' : c === 9 ? '\\t' : `\\x${c.toString(16).padStart(2, '0')}`)).join('');
}

const quote = (s) => `"${s.replace(/"/g, '\\"')}"`;
