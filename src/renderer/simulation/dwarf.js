// Debug information from an AVR ELF file (DWARF 2–4, as avr-gcc writes it):
// the line table, functions with their parameters and locals, global
// variables and their types. Read straight from the file, so the debugger
// needs no binutils.

const TAG = {
  array_type: 0x01, class_type: 0x02, enumeration_type: 0x04, formal_parameter: 0x05, lexical_block: 0x0b,
  member: 0x0d, pointer_type: 0x0f, reference_type: 0x10, compile_unit: 0x11, structure_type: 0x13,
  subroutine_type: 0x15, typedef: 0x16, union_type: 0x17, inlined_subroutine: 0x1d, subrange_type: 0x21,
  base_type: 0x24, const_type: 0x26, enumerator: 0x28, subprogram: 0x2e, variable: 0x34, volatile_type: 0x35,
  rvalue_reference_type: 0x42,
};

const AT = {
  sibling: 0x01, location: 0x02, name: 0x03, byte_size: 0x0b, stmt_list: 0x10, low_pc: 0x11, high_pc: 0x12,
  comp_dir: 0x1b, const_value: 0x1c, upper_bound: 0x2f, abstract_origin: 0x31, count: 0x37,
  data_member_location: 0x38, decl_file: 0x3a, decl_line: 0x3b, declaration: 0x3c, encoding: 0x3e,
  frame_base: 0x40, specification: 0x47, type: 0x49, ranges: 0x55, call_file: 0x58, call_line: 0x59,
};

export const ENCODING = { address: 1, boolean: 2, float: 4, signed: 5, signed_char: 6, unsigned: 7, unsigned_char: 8 };

/** Data-space addresses in AVR ELF files are offset by this. */
export const DATA_OFFSET = 0x800000;

class Reader {
  constructor(bytes, offset = 0) {
    this.b = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = offset;
  }

  u8() { return this.b[this.pos++]; }
  i8() { const v = this.view.getInt8(this.pos); this.pos += 1; return v; }
  u16() { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  i32() { const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  u64() { const lo = this.u32(); const hi = this.u32(); return hi * 2 ** 32 + lo; }
  addr(size) { return size === 2 ? this.u16() : size === 8 ? this.u64() : this.u32(); }

  uleb() {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.b[this.pos++];
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) return result;
    }
  }

  sleb() {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = this.b[this.pos++];
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    if (byte & 0x40) result -= 2 ** shift;
    return result;
  }

  cstr() {
    const start = this.pos;
    while (this.pos < this.b.length && this.b[this.pos] !== 0) this.pos++;
    const s = new TextDecoder().decode(this.b.subarray(start, this.pos));
    this.pos++;
    return s;
  }

  bytes(n) {
    const out = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/** Sections of a 32-bit little-endian ELF file, by name. */
export function elfSections(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) throw new Error('Not an ELF file');
  if (bytes[4] !== 1 || bytes[5] !== 1) throw new Error('Only 32-bit little-endian ELF files are supported');
  const r = new Reader(bytes);
  r.pos = 0x20;
  const shoff = r.u32();
  r.pos = 0x2e;
  const shentsize = r.u16();
  const shnum = r.u16();
  const shstrndx = r.u16();
  const headers = [];
  for (let i = 0; i < shnum; i++) {
    r.pos = shoff + i * shentsize;
    headers.push({ name: r.u32(), type: r.u32(), flags: r.u32(), addr: r.u32(), offset: r.u32(), size: r.u32() });
  }
  const names = headers[shstrndx];
  const sections = new Map();
  for (const h of headers) {
    r.pos = names.offset + h.name;
    const name = r.cstr();
    if (name) sections.set(name, { addr: h.addr, offset: h.offset, size: h.size, data: bytes.subarray(h.offset, h.offset + h.size) });
  }
  return sections;
}

// ── Line table ──────────────────────────────────────────────────────────────

const joinPath = (dir, name) => {
  if (!dir || /^([a-zA-Z]:)?[\\/]/.test(name)) return name;
  return `${dir.replace(/[\\/]+$/, '')}/${name}`;
};

/**
 * Parse the line program at `offset` of .debug_line.
 * @returns {{ files: string[], rows: { address: number, file: number, line: number, stmt: boolean, end: boolean }[] }}
 *   `file` indexes `files`, which holds full paths (index 0 unused, as in DWARF 2–4).
 */
export function parseLineProgram(data, offset, compDir = '') {
  const r = new Reader(data, offset);
  const unitLength = r.u32();
  if (unitLength === 0xffffffff) throw new Error('64-bit DWARF is not supported');
  const end = r.pos + unitLength;
  const version = r.u16();
  if (version > 4) throw new Error(`DWARF ${version} line tables are not supported`);
  const headerLength = r.u32();
  const programStart = r.pos + headerLength;
  const minInst = r.u8();
  if (version >= 4) r.u8(); // maximum_operations_per_instruction
  const defaultStmt = r.u8() !== 0;
  const lineBase = r.i8();
  const lineRange = r.u8();
  const opcodeBase = r.u8();
  const opLengths = [0];
  for (let i = 1; i < opcodeBase; i++) opLengths.push(r.u8());
  const dirs = [compDir];
  for (let d = r.cstr(); d; d = r.cstr()) dirs.push(joinPath(compDir, d));
  const files = [null];
  for (let f = r.cstr(); f; f = r.cstr()) {
    const dir = r.uleb();
    r.uleb();
    r.uleb();
    files.push(joinPath(dirs[dir] ?? compDir, f));
  }

  const rows = [];
  r.pos = programStart;
  let s;
  const reset = () => { s = { address: 0, file: 1, line: 1, stmt: defaultStmt }; };
  const emit = (endSeq = false) => rows.push({ address: s.address, file: s.file, line: s.line, stmt: s.stmt, end: endSeq });
  reset();
  while (r.pos < end) {
    const op = r.u8();
    if (op >= opcodeBase) {
      const adjusted = op - opcodeBase;
      s.address += Math.floor(adjusted / lineRange) * minInst;
      s.line += lineBase + (adjusted % lineRange);
      emit();
      continue;
    }
    switch (op) {
      case 0: {
        const len = r.uleb();
        const next = r.pos + len;
        const sub = r.u8();
        if (sub === 1) { emit(true); reset(); }
        else if (sub === 2) s.address = r.addr(len - 1);
        else if (sub === 3) { const name = r.cstr(); const dir = r.uleb(); files.push(joinPath(dirs[dir] ?? compDir, name)); }
        r.pos = next;
        break;
      }
      case 1: emit(); break;
      case 2: s.address += r.uleb() * minInst; break;
      case 3: s.line += r.sleb(); break;
      case 4: s.file = r.uleb(); break;
      case 5: r.uleb(); break;
      case 6: s.stmt = !s.stmt; break;
      case 7: break;
      case 8: s.address += Math.floor((255 - opcodeBase) / lineRange) * minInst; break;
      case 9: s.address += r.u16(); break;
      case 10: case 11: break;
      case 12: r.uleb(); break;
      default:
        for (let i = 0; i < (opLengths[op] || 0); i++) r.uleb();
    }
  }
  return { files, rows };
}

// ── Debugging information entries ──────────────────────────────────────────

function parseAbbrevs(data, offset) {
  const r = new Reader(data, offset);
  const table = new Map();
  for (;;) {
    const code = r.uleb();
    if (!code) break;
    const tag = r.uleb();
    const children = r.u8() !== 0;
    const attrs = [];
    for (;;) {
      const name = r.uleb();
      const form = r.uleb();
      if (!name && !form) break;
      attrs.push([name, form]);
    }
    table.set(code, { tag, children, attrs });
  }
  return table;
}

/** One attribute value. Blocks come back as Uint8Array; references as absolute .debug_info offsets. */
function readForm(r, form, cu, strings) {
  switch (form) {
    case 0x01: return r.addr(cu.addressSize);
    case 0x03: return r.bytes(r.u16());
    case 0x04: return r.bytes(r.u32());
    case 0x05: return r.u16();
    case 0x06: return r.u32();
    case 0x07: return r.u64();
    case 0x08: return r.cstr();
    case 0x09: return r.bytes(r.uleb());
    case 0x0a: return r.bytes(r.u8());
    case 0x0b: return r.u8();
    case 0x0c: return r.u8() !== 0;
    case 0x0d: return r.sleb();
    case 0x0e: { const off = r.u32(); return strings ? new Reader(strings, off).cstr() : ''; }
    case 0x0f: return r.uleb();
    case 0x10: return { ref: cu.version <= 2 ? r.addr(cu.addressSize) : r.u32() };
    case 0x11: return { ref: cu.offset + r.u8() };
    case 0x12: return { ref: cu.offset + r.u16() };
    case 0x13: return { ref: cu.offset + r.u32() };
    case 0x14: return { ref: cu.offset + r.u64() };
    case 0x15: return { ref: cu.offset + r.uleb() };
    case 0x16: return readForm(r, r.uleb(), cu, strings);
    case 0x17: return r.u32();
    case 0x18: return r.bytes(r.uleb());
    case 0x19: return true;
    case 0x20: r.pos += 8; return null;
    case 0x1f20: case 0x1f21: r.u32(); return null; // GNU alternate (dwz) references
    default: throw new Error(`Unsupported DWARF form 0x${form.toString(16)}`);
  }
}

function parseUnits(sections) {
  const info = sections.get('.debug_info')?.data;
  const abbrev = sections.get('.debug_abbrev')?.data;
  if (!info || !abbrev) return [];
  const strings = sections.get('.debug_str')?.data || null;
  const units = [];
  const r = new Reader(info);
  while (r.pos < info.length) {
    const offset = r.pos;
    const unitLength = r.u32();
    if (unitLength === 0xffffffff) throw new Error('64-bit DWARF is not supported');
    const end = r.pos + unitLength;
    const version = r.u16();
    let abbrevOffset;
    let addressSize;
    if (version >= 5) {
      r.u8();
      addressSize = r.u8();
      abbrevOffset = r.u32();
    } else {
      abbrevOffset = r.u32();
      addressSize = r.u8();
    }
    const cu = { offset, version, addressSize, dies: new Map(), root: null };
    const table = parseAbbrevs(abbrev, abbrevOffset);
    const stack = [];
    while (r.pos < end) {
      const dieOffset = r.pos;
      const code = r.uleb();
      if (!code) { stack.pop(); continue; }
      const ab = table.get(code);
      if (!ab) throw new Error(`Unknown abbreviation ${code} at 0x${dieOffset.toString(16)}`);
      const die = { offset: dieOffset, tag: ab.tag, attrs: {}, children: [], parent: stack[stack.length - 1] || null };
      for (const [name, form] of ab.attrs) {
        die.attrs[name] = readForm(r, form, cu, strings);
        if (form === 0x01 || form === 0x10) die.attrs[`${name}:addr`] = true;
      }
      cu.dies.set(dieOffset, die);
      if (die.parent) die.parent.children.push(die);
      else cu.root = die;
      if (ab.children) stack.push(die);
    }
    r.pos = end;
    units.push(cu);
  }
  return units;
}

// ── Location expressions ────────────────────────────────────────────────────

/**
 * Decode a DWARF expression into operations: [op, ...operands].
 * Unsupported operations decode as ['unsupported', name].
 */
export function decodeExpression(bytes, addressSize = 4) {
  const r = new Reader(bytes);
  const ops = [];
  while (r.pos < bytes.length) {
    const op = r.u8();
    if (op >= 0x30 && op <= 0x4f) ops.push(['lit', op - 0x30]);
    else if (op >= 0x50 && op <= 0x6f) ops.push(['reg', op - 0x50]);
    else if (op >= 0x70 && op <= 0x8f) ops.push(['breg', op - 0x70, r.sleb()]);
    else {
      switch (op) {
        case 0x03: ops.push(['addr', r.addr(addressSize)]); break;
        case 0x06: ops.push(['deref']); break;
        case 0x08: ops.push(['const', r.u8()]); break;
        case 0x09: ops.push(['const', r.i8()]); break;
        case 0x0a: ops.push(['const', r.u16()]); break;
        case 0x0b: ops.push(['const', r.i16()]); break;
        case 0x0c: ops.push(['const', r.u32()]); break;
        case 0x0d: ops.push(['const', r.i32()]); break;
        case 0x0e: ops.push(['const', r.u64()]); break;
        case 0x0f: ops.push(['const', r.u64()]); break;
        case 0x10: ops.push(['const', r.uleb()]); break;
        case 0x11: ops.push(['const', r.sleb()]); break;
        case 0x12: ops.push(['dup']); break;
        case 0x13: ops.push(['drop']); break;
        case 0x14: ops.push(['over']); break;
        case 0x15: ops.push(['pick', r.u8()]); break;
        case 0x16: ops.push(['swap']); break;
        case 0x19: ops.push(['abs']); break;
        case 0x1a: ops.push(['and']); break;
        case 0x1b: ops.push(['div']); break;
        case 0x1c: ops.push(['minus']); break;
        case 0x1d: ops.push(['mod']); break;
        case 0x1e: ops.push(['mul']); break;
        case 0x1f: ops.push(['neg']); break;
        case 0x20: ops.push(['not']); break;
        case 0x21: ops.push(['or']); break;
        case 0x22: ops.push(['plus']); break;
        case 0x23: ops.push(['plus_uconst', r.uleb()]); break;
        case 0x24: ops.push(['shl']); break;
        case 0x25: ops.push(['shr']); break;
        case 0x26: ops.push(['shra']); break;
        case 0x27: ops.push(['xor']); break;
        case 0x90: ops.push(['reg', r.uleb()]); break;
        case 0x91: ops.push(['fbreg', r.sleb()]); break;
        case 0x92: { const reg = r.uleb(); ops.push(['breg', reg, r.sleb()]); break; }
        case 0x93: ops.push(['piece', r.uleb()]); break;
        case 0x94: ops.push(['deref_size', r.u8()]); break;
        case 0x96: break;
        case 0x9c: ops.push(['call_frame_cfa']); break;
        case 0x9e: { const n = r.uleb(); ops.push(['implicit_value', Array.from(r.bytes(n))]); break; }
        case 0x9f: ops.push(['stack_value']); break;
        case 0xf3: case 0xa3: { r.bytes(r.uleb()); ops.push(['unsupported', 'entry value']); break; }
        default:
          ops.push(['unsupported', `0x${op.toString(16)}`]);
          return ops; // operand sizes unknown: stop here
      }
    }
  }
  return ops;
}

function parseLocList(data, offset, addressSize, base) {
  const r = new Reader(data, offset);
  const maxAddr = addressSize === 2 ? 0xffff : 0xffffffff;
  const list = [];
  for (;;) {
    const begin = r.addr(addressSize);
    const end = r.addr(addressSize);
    if (begin === 0 && end === 0) break;
    if (begin === maxAddr) { base = end; continue; }
    const len = r.u16();
    list.push({ begin: base + begin, end: base + end, expr: decodeExpression(r.bytes(len), addressSize) });
  }
  return list;
}

// ── Model ───────────────────────────────────────────────────────────────────

const isLocList = (v) => typeof v === 'number';

/**
 * Everything the debugger needs from an ELF file.
 * @returns {{
 *   files: string[],
 *   rows: { address: number, file: number, line: number, stmt: boolean, end: boolean }[],
 *   functions: object[], globals: object[], types: Map<number, object>, inlined: object[], frames: object[]
 * }}
 *   Paths use forward slashes. Addresses are byte addresses in flash.
 */
export function readDebugInfo(elfBytes) {
  const sections = elfSections(elfBytes);
  const units = parseUnits(sections);
  const lineData = sections.get('.debug_line')?.data;
  const locData = sections.get('.debug_loc')?.data;

  const files = [];
  const fileIndex = new Map();
  const fileId = (p) => {
    const norm = String(p).replace(/\\/g, '/');
    if (!fileIndex.has(norm)) { fileIndex.set(norm, files.length); files.push(norm); }
    return fileIndex.get(norm);
  };
  const rows = [];
  const functions = [];
  const globals = [];
  const inlined = [];
  const types = new Map();

  for (const cu of units) {
    const root = cu.root;
    if (!root || root.tag !== TAG.compile_unit) continue;
    const compDir = root.attrs[AT.comp_dir] || '';
    let cuFiles = [];
    if (lineData && typeof root.attrs[AT.stmt_list] === 'number') {
      const program = parseLineProgram(lineData, root.attrs[AT.stmt_list], compDir);
      cuFiles = program.files.map(f => (f == null ? -1 : fileId(f)));
      for (const row of program.rows) rows.push({ ...row, file: cuFiles[row.file] ?? -1 });
    }
    const base = typeof root.attrs[AT.low_pc] === 'number' ? root.attrs[AT.low_pc] : 0;
    const fileOf = (die) => {
      const n = die.attrs[AT.decl_file];
      return typeof n === 'number' && cuFiles[n] !== undefined ? cuFiles[n] : -1;
    };
    const origin = (die) => {
      let d = die;
      for (let i = 0; i < 4 && d; i++) {
        const ref = d.attrs[AT.abstract_origin] || d.attrs[AT.specification];
        if (!ref) break;
        d = cu.dies.get(ref.ref) || null;
      }
      return d || die;
    };
    const attr = (die, at) => die.attrs[at] ?? origin(die).attrs[at];
    const highPc = (die) => {
      const low = die.attrs[AT.low_pc];
      const high = die.attrs[AT.high_pc];
      if (typeof low !== 'number' || typeof high !== 'number') return null;
      // DWARF 4 may store high_pc as a length.
      return die.attrs[`${AT.high_pc}:addr`] ? high : low + high;
    };
    const location = (die) => {
      const loc = die.attrs[AT.location];
      if (loc instanceof Uint8Array) return { expr: decodeExpression(loc, cu.addressSize) };
      if (isLocList(loc) && locData) return { list: parseLocList(locData, loc, cu.addressSize, base) };
      return null;
    };
    const typeRef = (die) => {
      const t = attr(die, AT.type);
      return t ? t.ref : null;
    };
    const variable = (die) => {
      const constValue = die.attrs[AT.const_value];
      return {
        name: attr(die, AT.name) || '',
        type: typeRef(die),
        loc: location(die),
        constValue: typeof constValue === 'number' ? constValue : constValue instanceof Uint8Array ? Array.from(constValue) : null,
        param: die.tag === TAG.formal_parameter,
        file: fileOf(origin(die)),
        line: attr(die, AT.decl_line) || 0,
      };
    };

    for (const die of cu.dies.values()) {
      switch (die.tag) {
        case TAG.base_type:
        case TAG.typedef:
        case TAG.pointer_type:
        case TAG.reference_type:
        case TAG.rvalue_reference_type:
        case TAG.const_type:
        case TAG.volatile_type:
        case TAG.array_type:
        case TAG.structure_type:
        case TAG.class_type:
        case TAG.union_type:
        case TAG.enumeration_type:
        case TAG.subroutine_type:
          types.set(die.offset, typeOf(die, cu));
          break;
        default:
      }
    }

    const collect = (die, fn, block) => {
      for (const child of die.children) {
        if (child.tag === TAG.formal_parameter || child.tag === TAG.variable) {
          const v = variable(child);
          if (v.name && (v.loc || v.constValue !== null)) (block || fn).vars.push(v);
        } else if (child.tag === TAG.lexical_block) {
          const low = child.attrs[AT.low_pc];
          const high = highPc(child);
          if (typeof low === 'number' && high !== null) {
            const b = { low, high, vars: [] };
            fn.blocks.push(b);
            collect(child, fn, b);
          } else {
            collect(child, fn, block);
          }
        } else if (child.tag === TAG.inlined_subroutine) {
          const low = child.attrs[AT.low_pc];
          const high = highPc(child);
          const callFile = child.attrs[AT.call_file];
          if (typeof low === 'number' && high !== null && typeof callFile === 'number') {
            inlined.push({ low, high, file: cuFiles[callFile] ?? -1, line: child.attrs[AT.call_line] || 0, name: attr(child, AT.name) || '' });
          }
        }
      }
    };

    for (const die of root.children) {
      if (die.tag === TAG.variable && !die.attrs[AT.declaration]) {
        const v = variable(die);
        const op = v.loc?.expr?.[0];
        if (v.name && op && op[0] === 'addr') globals.push({ ...v, address: op[1] });
      }
    }
    for (const die of cu.dies.values()) {
      if (die.tag !== TAG.subprogram) continue;
      const low = die.attrs[AT.low_pc];
      const high = highPc(die);
      if (typeof low !== 'number' || high === null || high <= low) continue;
      const fb = die.attrs[AT.frame_base];
      const fn = {
        name: attr(die, AT.name) || '?',
        low, high,
        file: fileOf(origin(die)),
        line: attr(die, AT.decl_line) || 0,
        frameBase: fb instanceof Uint8Array ? { expr: decodeExpression(fb, cu.addressSize) } : isLocList(fb) && locData ? { list: parseLocList(locData, fb, cu.addressSize, base) } : null,
        vars: [],
        blocks: [],
      };
      collect(die, fn, null);
      functions.push(fn);
    }
  }
  functions.sort((a, b) => a.low - b.low);
  let frames = [];
  try {
    frames = readFrames(elfBytes, units[0]?.addressSize || 4);
  } catch {
    frames = []; // no call stack, everything else still works
  }
  return { files, rows, functions, globals, types, inlined, frames };
}

function typeOf(die, cu) {
  const a = die.attrs;
  const ref = a[AT.type] ? a[AT.type].ref : null;
  const base = { name: a[AT.name] || '', size: typeof a[AT.byte_size] === 'number' ? a[AT.byte_size] : null, target: ref };
  switch (die.tag) {
    case TAG.base_type: return { ...base, kind: 'base', encoding: a[AT.encoding] || 0 };
    case TAG.typedef: return { ...base, kind: 'typedef' };
    case TAG.pointer_type: return { ...base, kind: 'pointer', size: base.size ?? cu.addressSize };
    case TAG.reference_type:
    case TAG.rvalue_reference_type: return { ...base, kind: 'reference', size: base.size ?? cu.addressSize };
    case TAG.const_type: return { ...base, kind: 'const' };
    case TAG.volatile_type: return { ...base, kind: 'volatile' };
    case TAG.subroutine_type: return { ...base, kind: 'function' };
    case TAG.array_type: {
      const dims = die.children.filter(c => c.tag === TAG.subrange_type).map(c => {
        if (typeof c.attrs[AT.count] === 'number') return c.attrs[AT.count];
        if (typeof c.attrs[AT.upper_bound] === 'number') return c.attrs[AT.upper_bound] + 1;
        return 0;
      });
      return { ...base, kind: 'array', dims: dims.length ? dims : [0] };
    }
    case TAG.enumeration_type:
      return { ...base, kind: 'enum', enumerators: die.children.filter(c => c.tag === TAG.enumerator).map(c => ({ name: c.attrs[AT.name], value: c.attrs[AT.const_value] })) };
    default: {
      const members = die.children.filter(c => c.tag === TAG.member && !c.attrs[AT.declaration]).map(c => {
        const loc = c.attrs[AT.data_member_location];
        let offset = 0;
        if (typeof loc === 'number') offset = loc;
        else if (loc instanceof Uint8Array) {
          const ops = decodeExpression(loc, cu.addressSize);
          if (ops[0]?.[0] === 'plus_uconst') offset = ops[0][1];
        }
        return { name: c.attrs[AT.name] || '', type: c.attrs[AT.type]?.ref ?? null, offset };
      }).filter(m => m.name);
      const kind = die.tag === TAG.union_type ? 'union' : die.tag === TAG.class_type ? 'class' : 'struct';
      return { ...base, kind, members, declaration: !!a[AT.declaration] };
    }
  }
}

// ── Call frame information (.debug_frame) ──────────────────────────────────

/**
 * Decode call frame instructions into [op, ...operands] (addresses scaled by
 * the code alignment factor, offsets by the data alignment factor).
 */
function decodeCfa(bytes, cie, addressSize) {
  const r = new Reader(bytes);
  const out = [];
  while (r.pos < bytes.length) {
    const op = r.u8();
    const high = op & 0xc0;
    const low = op & 0x3f;
    if (high === 0x40) { out.push(['advance', low * cie.codeAlign]); continue; }
    if (high === 0x80) { out.push(['offset', low, r.uleb() * cie.dataAlign]); continue; }
    if (high === 0xc0) { out.push(['restore', low]); continue; }
    switch (op) {
      case 0x00: break;
      case 0x01: out.push(['set_loc', r.addr(addressSize)]); break;
      case 0x02: out.push(['advance', r.u8() * cie.codeAlign]); break;
      case 0x03: out.push(['advance', r.u16() * cie.codeAlign]); break;
      case 0x04: out.push(['advance', r.u32() * cie.codeAlign]); break;
      case 0x05: out.push(['offset', r.uleb(), r.uleb() * cie.dataAlign]); break;
      case 0x06: out.push(['restore', r.uleb()]); break;
      case 0x07: out.push(['undefined', r.uleb()]); break;
      case 0x08: out.push(['same', r.uleb()]); break;
      case 0x09: out.push(['register', r.uleb(), r.uleb()]); break;
      case 0x0a: out.push(['remember']); break;
      case 0x0b: out.push(['restore_state']); break;
      case 0x0c: out.push(['def_cfa', r.uleb(), r.uleb()]); break;
      case 0x0d: out.push(['def_cfa_register', r.uleb()]); break;
      case 0x0e: out.push(['def_cfa_offset', r.uleb()]); break;
      case 0x11: out.push(['offset', r.uleb(), r.sleb() * cie.dataAlign]); break;
      case 0x12: out.push(['def_cfa', r.uleb(), r.sleb() * cie.dataAlign]); break;
      case 0x13: out.push(['def_cfa_offset', r.sleb() * cie.dataAlign]); break;
      case 0x2e: r.uleb(); break; // GNU_args_size
      default:
        out.push(['unsupported', op]);
        return out;
    }
  }
  return out;
}

/**
 * Frame descriptions from .debug_frame.
 * @returns {{ low: number, high: number, cie: object, instructions: any[][] }[]} sorted by address
 */
export function readFrames(elfBytes, addressSize = 4) {
  const sections = elfSections(elfBytes);
  const data = sections.get('.debug_frame')?.data;
  if (!data) return [];
  const cies = new Map();
  const fdes = [];
  const r = new Reader(data);
  while (r.pos + 4 <= data.length) {
    const start = r.pos;
    const length = r.u32();
    if (length === 0) continue;
    if (length === 0xffffffff) throw new Error('64-bit DWARF is not supported');
    const end = r.pos + length;
    const id = r.u32();
    if (id === 0xffffffff) {
      const version = r.u8();
      const augmentation = r.cstr();
      if (version >= 4) { r.u8(); r.u8(); }
      const cie = { codeAlign: r.uleb(), dataAlign: r.sleb(), raReg: version === 1 ? r.u8() : r.uleb() };
      if (augmentation) { r.pos = end; continue; } // augmented CIEs are not produced by avr-gcc for .debug_frame
      cie.initial = decodeCfa(data.subarray(r.pos, end), cie, addressSize);
      cies.set(start, cie);
    } else {
      const cie = cies.get(id);
      const low = r.addr(addressSize);
      const range = r.addr(addressSize);
      if (cie) fdes.push({ low, high: low + range, cie, instructions: decodeCfa(data.subarray(r.pos, end), cie, addressSize) });
    }
    r.pos = end;
  }
  return fdes.sort((a, b) => a.low - b.low);
}

/**
 * The unwind rules in effect at byte address `pc` of a frame description.
 * @returns {{ cfaReg: number, cfaOffset: number, rules: Map<number, ['offset', number] | ['same'] | ['undefined'] | ['register', number]> } | null}
 */
export function frameRules(fde, pc) {
  let cfaReg = 0;
  let cfaOffset = 0;
  let rules = new Map();
  let initialRules = null;
  const stack = [];
  let loc = fde.low;
  const run = (ops, limited) => {
    for (const [op, a, b] of ops) {
      if (limited && (op === 'advance' || op === 'set_loc')) {
        const next = op === 'advance' ? loc + a : a;
        if (next > pc) return false;
        loc = next;
        continue;
      }
      switch (op) {
        case 'def_cfa': cfaReg = a; cfaOffset = b; break;
        case 'def_cfa_register': cfaReg = a; break;
        case 'def_cfa_offset': cfaOffset = a; break;
        case 'offset': rules.set(a, ['offset', b]); break;
        case 'restore': if (initialRules?.has(a)) rules.set(a, initialRules.get(a)); else rules.delete(a); break;
        case 'undefined': rules.set(a, ['undefined']); break;
        case 'same': rules.set(a, ['same']); break;
        case 'register': rules.set(a, ['register', b]); break;
        case 'remember': stack.push({ cfaReg, cfaOffset, rules: new Map(rules) }); break;
        case 'restore_state': { const s = stack.pop(); if (s) ({ cfaReg, cfaOffset, rules } = s); break; }
        case 'unsupported': return null;
        default:
      }
    }
    return true;
  };
  if (run(fde.cie.initial, false) === null) return null;
  initialRules = new Map(rules);
  if (run(fde.instructions, true) === null) return null;
  return { cfaReg, cfaOffset, rules };
}
