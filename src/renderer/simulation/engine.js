// Circuit engine: joins the AVR runner, the netlist and the part behaviors.
//
// It rebuilds nets whenever the wiring or a switch changes, resolves every
// Arduino input pin from the circuit (rails, outputs, pull-ups, resistors,
// sensor outputs), feeds ADC voltages, measures PWM duty per pin each frame
// and routes pin edges to the parts that decode them. Islands with capacitors
// are stepped in simulated time while they charge or discharge.

import { Circuit, solveIsland, logicLevel } from './netlist.js';
import { PinState, F_CPU } from './avr-runner.js';
import { boardByTag, boardPinNumber, boardPowerPin, pinLabel, BOARDS } from './boards.js';
import { PartContext, Behavior } from './parts/behavior.js';
import { partDef } from './parts/catalog.js';

const NEIGHBOR_HOPS = 2;

// RC stepping: each step aims at CAP_DV volts of change, within these bounds;
// an island whose capacitors move slower than CAP_SETTLED volts per second has settled.
const CAP_DV = 0.02;
const CAP_MIN_STEP = 20e-6;
const CAP_MAX_STEP = 20e-3;
const CAP_SETTLED = 1e-3;

/** Pin states that read the circuit (rather than drive it). */
const isInputState = (st) => st === PinState.Input || st === PinState.InputPullUp || st === PinState.InputPullDown;

export class CircuitEngine {
  /** @param {import('./avr-runner.js').AvrRunner} runner */
  constructor(runner) {
    this.runner = runner;
    this.board = BOARDS.uno;
    this.parts = [];
    this.wires = [];
    this.extraLinks = [];
    this.behaviors = new Map();
    this.contexts = new Map();
    this.drivers = new Map();     // node → { volts, ohms }
    this._capCharge = new Map();  // capacitor tag → volts, kept across rebuilds
    this.circuit = null;
    this.active = false;
    this._resetHeld = false;
    this._reported = new Set();

    // Hooks set by the UI
    this.log = null;              // (message) => void
    this.onShort = null;          // ({ tags, nodes }) => void
    this.onAttrChange = null;     // (part, key, value) => void
    this.onPartStatus = null;     // (part) => void
  }

  /**
   * @param {{ parts: {id, type, attrs, el}[], wires: {from:{partId,pin}, to:{partId,pin}}[], links?: [string,string][] }} model
   */
  setModel({ parts, wires, links = [] }) {
    this.parts = parts;
    this.wires = wires;
    this.extraLinks = links;
    const boardPart = this.boardPart;
    if (boardPart) this.board = boardByTag(partDef(boardPart.type).tag) || this.board;
    if (this.active) this.invalidate();
  }

  get boardPart() {
    return this.parts.find(p => partDef(p.type)?.board) || null;
  }

  // ── Topology ─────────────────────────────────────────────────────────────

  _pinNames(part) {
    const fromEl = part.el?.pinInfo;
    if (fromEl && fromEl.length) return fromEl.map(p => p.name);
    return partDef(part.type)?.pinNames?.(part.attrs || {}) || [];
  }

  _topology({ withBehaviors }) {
    const nodes = [];
    const links = [];
    const resistors = [];
    const capacitors = [];
    for (const w of this.wires) links.push([`${w.from.partId}:${w.from.pin}`, `${w.to.partId}:${w.to.pin}`]);
    for (const l of this.extraLinks) links.push(l);

    for (const part of this.parts) {
      const def = partDef(part.type);
      const names = this._pinNames(part);
      for (const n of names) nodes.push(`${part.id}:${n}`);
      const add = (list, into, withOhms) => {
        for (const item of list || []) {
          const [a, b, ohms] = item;
          if (withOhms) into.push([`${part.id}:${a}`, `${part.id}:${b}`, ohms, `${part.id}`]);
          else into.push([`${part.id}:${a}`, `${part.id}:${b}`]);
        }
      };
      add(def?.links?.(part.attrs || {}, names), links, false);
      add(def?.resistors?.(part.attrs || {}), resistors, true);
      for (const [a, b, farads] of def?.capacitors?.(part.attrs || {}) || []) {
        capacitors.push([`${part.id}:${a}`, `${part.id}:${b}`, farads, `${part.id}:${a}-${b}`]);
      }
      if (def?.board) {
        const board = boardByTag(def.tag);
        // Header pins that are the same copper on the board.
        const byNumber = new Map();
        const rails = { gnd: [], vcc5: [], vcc33: [] };
        for (const n of names) {
          const num = boardPinNumber(board, n);
          if (num !== null) {
            if (byNumber.has(num)) links.push([`${part.id}:${byNumber.get(num)}`, `${part.id}:${n}`]);
            else byNumber.set(num, n);
          }
          const pw = boardPowerPin(n);
          if (pw?.kind === 'gnd') rails.gnd.push(n);
          // VIN (and the Pico's VSYS, behind a diode) are supply inputs, not the 5 V rail.
          else if (pw?.kind === 'vcc' && pw.volts === 5 && !/^(VIN|VSYS)/.test(n)) rails.vcc5.push(n);
          else if (pw?.kind === 'vcc' && pw.volts === 3.3) rails.vcc33.push(n);
        }
        for (const group of Object.values(rails)) {
          for (let i = 1; i < group.length; i++) links.push([`${part.id}:${group[0]}`, `${part.id}:${group[i]}`]);
        }
      }
      if (withBehaviors) {
        const beh = this.behaviors.get(part.id);
        if (beh) {
          add(beh.links(), links, false);
          add(beh.resistors(), resistors, true);
        }
      }
    }
    return new Circuit({ nodes, links, resistors, capacitors });
  }

  /** Connectivity from wires and fixed part internals only (no running state). */
  staticCircuit() {
    return this._topology({ withBehaviors: false });
  }

  invalidate() {
    if (!this.active) return;
    this.rebuild();
  }

  rebuild() {
    const circuit = this._topology({ withBehaviors: true });
    this.circuit = circuit;
    const nets = circuit.netCount;
    const board = this.board;

    this._netRails = Array.from({ length: nets }, () => []);
    this._netMcu = Array.from({ length: nets }, () => []);
    this._netPullups = Array.from({ length: nets }, () => []);
    this._netDrivers = new Map();
    this._mcuNet = new Int32Array(board.pinCount).fill(-1);
    this._resetNet = -1;

    const boardPart = this.boardPart;
    if (boardPart) {
      for (const name of this._pinNames(boardPart)) {
        const node = `${boardPart.id}:${name}`;
        const net = circuit.netOf(node);
        if (net < 0) continue;
        const num = boardPinNumber(board, name);
        if (num !== null) {
          if (this._mcuNet[num] < 0) {
            this._mcuNet[num] = net;
            this._netMcu[net].push(num);
          }
          continue;
        }
        const pw = boardPowerPin(name);
        if (pw?.kind === 'gnd' || pw?.kind === 'vcc') {
          if (!this._netRails[net].some(r => r.volts === pw.volts)) this._netRails[net].push({ volts: pw.volts, tag: pw.kind === 'gnd' ? 'GND' : name.replace(/\.\d+$/, '') });
        } else if (pw?.kind === 'reset') {
          this._resetNet = net;
        }
      }
    }

    for (const [partId, beh] of this.behaviors) {
      for (const [pin, ohms] of beh.pullups() || []) {
        const net = circuit.netOf(`${partId}:${pin}`);
        if (net >= 0) this._netPullups[net].push({ volts: board.logicVolts, ohms, tag: `${partId}:${pin}` });
      }
    }
    for (const [node, src] of this.drivers) this._indexDriver(node, src);

    // Islands and their Arduino pins.
    const islands = circuit.islandNets.length;
    this._islandMcu = Array.from({ length: islands }, () => []);
    for (let p = 0; p < board.pinCount; p++) {
      const net = this._mcuNet[p];
      if (net >= 0) this._islandMcu[circuit.islandOf[net]].push(p);
    }
    this._dirty = new Uint8Array(islands).fill(1);
    this._volts = new Float64Array(nets).fill(NaN);

    // Capacitors keep their charge through a rebuild; stepping starts afresh.
    for (const h of this._capTimers || []) if (h) this.runner.cancel(h);
    this._capVolts = Float64Array.from(circuit.capacitors, c => this._capCharge.get(c.tag) || 0);
    this._capLast = new Float64Array(islands).fill(this.runner.time);
    this._capActive = new Uint8Array(islands);
    this._capStep = new Float64Array(islands).fill(CAP_MIN_STEP * 5);
    this._capTimers = new Array(islands).fill(null);
    this._capSources = new Array(islands).fill(null); // sources in effect since an island's last solve
    this._capPinVolts = new Map(); // net → volts at the last step, for input pins in RC islands
    this._floating = new Uint8Array(nets).fill(1);

    // Nearest Arduino pin for each net (direct, or through resistors).
    this._netMcuNear = new Int32Array(nets).fill(-1);
    for (let net = 0; net < nets; net++) {
      if (this._netMcu[net].length) { this._netMcuNear[net] = this._netMcu[net][0]; continue; }
      for (const nb of circuit.resistiveNeighbors(net, NEIGHBOR_HOPS)) {
        if (this._netMcu[nb.net].length) { this._netMcuNear[net] = this._netMcu[nb.net][0]; break; }
      }
    }

    // Edge watchers: behaviors with onPin, per Arduino pin.
    this._watchers = Array.from({ length: board.pinCount }, () => []);
    for (const part of this.parts) {
      const beh = this.behaviors.get(part.id);
      if (!beh || !beh.wantsEdges) continue;
      for (const name of this._pinNames(part)) {
        const net = circuit.netOf(`${part.id}:${name}`);
        if (net < 0) continue;
        const pins = new Set(this._netMcu[net]);
        for (const nb of circuit.resistiveNeighbors(net, NEIGHBOR_HOPS)) for (const p of this._netMcu[nb.net]) pins.add(p);
        for (const p of pins) this._watchers[p].push({ beh, pin: name });
      }
    }

    // Net watchers: behaviors with onNet hear every level change on their
    // pins' nets, whoever causes it (another chip, a switch, the Arduino).
    this._netWatch = new Map();
    this._islandWatch = new Uint8Array(islands);
    for (const part of this.parts) {
      const beh = this.behaviors.get(part.id);
      if (!beh?.wantsNets) continue;
      for (const name of this._pinNames(part)) {
        const node = `${part.id}:${name}`;
        const net = circuit.netOf(node);
        if (net < 0) continue;
        if (!this._netWatch.has(net)) this._netWatch.set(net, []);
        this._netWatch.get(net).push({ beh, pin: name, node });
        this._islandWatch[circuit.islandOf[net]] = 1;
      }
    }

    for (let i = 0; i < islands; i++) {
      if (this._islandMcu[i].length) this._settleIsland(i);
      else if (this._islandWatch[i] || circuit.islandCapacitors[i].length) this._solve(i);
    }
    this._checkReset();
  }

  _indexDriver(node, src) {
    const net = this.circuit?.netOf(node) ?? -1;
    if (net < 0) return;
    if (!this._netDrivers.has(net)) this._netDrivers.set(net, new Map());
    this._netDrivers.get(net).set(node, src);
  }

  // ── Solving ──────────────────────────────────────────────────────────────

  _sourcesOf = (net) => {
    const out = [];
    for (const r of this._netRails[net]) out.push(r);
    for (const p of this._netMcu[net]) {
      const st = this.runner.pinState(p);
      const board = this.board;
      if (st === PinState.High) out.push({ volts: board.logicVolts, tag: pinLabel(board, p) });
      else if (st === PinState.Low) out.push({ volts: 0, tag: pinLabel(board, p) });
      else if (st === PinState.InputPullUp) out.push({ volts: board.logicVolts, ohms: board.pullupOhms, tag: pinLabel(board, p) });
      else if (st === PinState.InputPullDown) out.push({ volts: 0, ohms: board.pulldownOhms, tag: pinLabel(board, p) });
    }
    const drivers = this._netDrivers.get(net);
    if (drivers) for (const [node, src] of drivers) out.push({ volts: src.volts, ohms: src.ohms, tag: node });
    for (const pu of this._netPullups[net]) out.push(pu);
    return out;
  };

  _solve(island) {
    const caps = this.circuit.islandCapacitors[island];
    let sourcesOf = this._sourcesOf;
    let dt = 0;
    let maxDv = 0;
    if (caps.length) {
      // Every change of a source re-solves its island, so the sources of the
      // last solve held until now: step the capacitors over that interval with
      // them, then apply the present sources at this instant (capacitors hold
      // their voltage through it). A settled island needs no step.
      const now = this.runner.time;
      dt = this._capActive[island] ? Math.max(0, now - this._capLast[island]) : 0;
      this._capLast[island] = now;
      const before = this._capSources[island];
      if (dt > 0 && before) {
        ({ maxDv } = solveIsland(this.circuit, island, (net) => before.get(net) || [], { dt, capVolts: this._capVolts }));
      }
      const seen = new Map();
      this._capSources[island] = seen;
      sourcesOf = (net) => {
        const list = this._sourcesOf(net);
        seen.set(net, list);
        return list;
      };
    }
    const { volts, shorts } = solveIsland(this.circuit, island, sourcesOf, caps.length ? { dt: 0, capVolts: this._capVolts } : null);
    for (const net of this.circuit.islandNets[island]) {
      const v = volts.get(net);
      if (v === null || v === undefined) { this._volts[net] = NaN; this._floating[net] = 1; }
      else { this._volts[net] = v; this._floating[net] = 0; }
    }
    this._dirty[island] = 0;
    for (const s of shorts) this._reportShort(s);
    if (caps.length) this._stepCapacitors(island, dt, maxDv);
    if (this._islandWatch?.[island]) this._notifyNets(island);
  }

  /** Keep an island with capacitors stepping until they stop moving. */
  _stepCapacitors(island, dt, maxDv) {
    for (const ci of this.circuit.islandCapacitors[island]) this._capCharge.set(this.circuit.capacitors[ci].tag, this._capVolts[ci]);
    // Input pins: extrapolate toward the logic threshold so the edge lands on time.
    let crossing = Infinity;
    for (const p of this._islandMcu[island]) {
      const st = this.runner.pinState(p);
      if (!isInputState(st)) continue;
      const net = this._mcuNet[p];
      const v = this._volts[net];
      const prev = this._capPinVolts.get(net);
      this._capPinVolts.set(net, v);
      if (!(dt > 0) || prev === undefined || !Number.isFinite(v) || !Number.isFinite(prev) || v === prev) continue;
      const t = (this.board.threshold - v) / ((v - prev) / dt);
      if (t > 0) crossing = Math.min(crossing, t);
    }
    if (dt > 0) {
      if (maxDv / dt < CAP_SETTLED) {
        this._capActive[island] = 0;
        return;
      }
      // Step size for about CAP_DV of change, growing at most twofold per step.
      const ideal = (CAP_DV * dt) / Math.max(maxDv, 1e-12);
      this._capStep[island] = Math.min(CAP_MAX_STEP, Math.max(CAP_MIN_STEP, Math.min(ideal, this._capStep[island] * 2)));
    }
    this._capActive[island] = 1;
    if (this._capTimers[island] || !this.runner.schedule) return;
    const step = Math.min(this._capStep[island], crossing + 1e-6);
    this._capTimers[island] = this.runner.schedule(step * F_CPU, () => {
      this._capTimers[island] = null;
      if (!this.active || !this.circuit) return;
      this._dirty[island] = 1;
      if (this._islandMcu[island].length) this._settleIsland(island);
      else this._solve(island);
    });
  }

  /** Voltage across a capacitor part (lead 1 − lead 2), or null when it isn't in a running circuit. */
  capacitorVolts(partId) {
    if (!this.circuit) return null;
    const ci = this.circuit.capacitors.findIndex(c => c.tag.startsWith(`${partId}:`));
    if (ci < 0) return null;
    const island = this.circuit.islandOf[this.circuit.capacitors[ci].a];
    if (this._dirty[island]) this._solve(island);
    return this._capVolts[ci];
  }

  _notifyNets(island) {
    const changes = [];
    for (const net of this.circuit.islandNets[island]) {
      const list = this._netWatch.get(net);
      if (!list) continue;
      const level = this._floating[net] ? null : logicLevel(this._volts[net]);
      for (const w of list) {
        if (this._netLevels.get(w.node) === level) continue;
        this._netLevels.set(w.node, level);
        changes.push([w, level]);
      }
    }
    // Levels are recorded silently until every part has started; a runaway
    // chain (a chip driving its own input synchronously) stops at a fixed depth.
    if (!this._notifyReady || !changes.length || this._notifyDepth > 32) return;
    this._notifyDepth++;
    try {
      for (const [w, level] of changes) {
        try { w.beh.onNet(w.pin, level); } catch (err) { this.log?.(`[sim] ${err.message}`); }
      }
    } finally {
      this._notifyDepth--;
    }
  }

  _settleIsland(island) {
    this._solve(island);
    const runner = this.runner;
    for (const p of this._islandMcu[island]) {
      const st = runner.pinState(p);
      const net = this._mcuNet[p];
      const entry = this.board.byPin.get(p);
      const floating = this._floating[net];
      const v = this._volts[net];
      if (isInputState(st)) {
        if (entry.port) {
          if (floating) runner.setPinFloating(p);
          else runner.setInputPin(p, v >= this.board.threshold);
        }
      }
      if (entry.adc !== undefined) runner.setAnalogVoltage(entry.adc, floating ? 0 : v);
    }
    if (this._resetNet >= 0 && this.circuit.islandOf[this._resetNet] === island) this._checkReset();
  }

  _reportShort(short) {
    const key = short.tags.slice().sort().join('|');
    if (this._reported.has(key)) return;
    this._reported.add(key);
    const nodes = this.circuit.nodesOf(short.net);
    this.onShort?.({ tags: short.tags, nodes });
  }

  _checkReset() {
    if (this._resetNet < 0) return;
    const island = this.circuit.islandOf[this._resetNet];
    if (this._dirty[island]) this._solve(island);
    const held = !this._floating[this._resetNet] && this._volts[this._resetNet] < 1.5;
    if (held === this._resetHeld) return;
    this._resetHeld = held;
    this.onResetPin?.(held);
  }

  netOfNode(node) {
    return this.circuit ? this.circuit.netOf(node) : -1;
  }

  nodeConnected(node) {
    const c = this.circuit || this.staticCircuit();
    const net = c.netOf(node);
    return net >= 0 && (c.nodesOf(net).length > 1 || c.resistiveNeighbors(net, 1).length > 0);
  }

  _ensure(net) {
    const island = this.circuit.islandOf[net];
    if (this._dirty[island]) this._solve(island);
  }

  levelOfNet(net) {
    if (!this.circuit || net < 0) return null;
    const rails = this._netRails[net];
    if (rails.length === 1 && !this._netMcu[net].length) return rails[0].volts >= 2.5 ? 1 : 0;
    this._ensure(net);
    return this._floating[net] ? null : logicLevel(this._volts[net]);
  }

  voltsOfNet(net) {
    if (!this.circuit || net < 0) return null;
    this._ensure(net);
    return this._floating[net] ? null : this._volts[net];
  }

  mcuPinOfNet(net) {
    if (!this.circuit || net < 0) return null;
    const p = this._netMcuNear[net];
    return p >= 0 ? p : null;
  }

  /** PWM-aware HIGH fraction of a net over the last frame (null = floating). */
  highFractionOfNet(net) {
    if (!this.circuit || net < 0) return null;
    const rails = this._netRails[net];
    if (rails.length) return rails[0].volts >= 2.5 ? 1 : 0;
    const p = this._netMcuNear[net];
    if (p >= 0 && this.runner.isOutput(p)) {
      // Only trust the pin's duty if nothing stronger sits on this net.
      if (!this._netDrivers.has(net) || this._netMcu[net].includes(p)) return this._duty[p];
    }
    return this.levelOfNet(net);
  }

  frequencyOfNet(net) {
    const p = this.mcuPinOfNet(net);
    return p === null ? 0 : this._freq[p];
  }

  setDriver(node, src) {
    if (src) this.drivers.set(node, src);
    else this.drivers.delete(node);
    if (!this.circuit) return;
    const net = this.circuit.netOf(node);
    if (net < 0) return;
    if (src) this._indexDriver(node, src);
    else this._netDrivers.get(net)?.delete(node);
    const island = this.circuit.islandOf[net];
    this._dirty[island] = 1;
    if (this._islandMcu[island].length) this._settleIsland(island);
    else if (this._islandWatch[island] || this.circuit.islandCapacitors[island].length) this._solve(island);
  }

  // ── Runner events ────────────────────────────────────────────────────────

  _onPinState(p, state, cycles) {
    if (!this.active || !this.circuit) return;
    const high = state === PinState.High;
    // PWM bookkeeping (output level only).
    if (this._lastHigh[p] !== high) {
      const t = cycles / F_CPU;
      if (this._lastHigh[p]) {
        this._highAcc[p] += t - this._segStart[p];
      } else {
        if (this._lastRise[p] > 0) this._period[p] = t - this._lastRise[p];
        this._lastRise[p] = t;
        this._rises[p]++;
      }
      this._segStart[p] = t;
      this._lastHigh[p] = high;
      this._edges[p]++;
    }
    const net = this._mcuNet[p];
    if (!(net >= 0)) return; // not a pin of this board
    const island = this.circuit.islandOf[net];
    this._dirty[island] = 1;
    if (this._islandMcu[island].length > 1 || isInputState(state) || this._islandWatch[island]
      || this.circuit.islandCapacitors[island].length) {
      this._settleIsland(island);
    } else if (this._resetNet >= 0 && island === this.circuit.islandOf[this._resetNet]) {
      this._checkReset();
    }
    const watchers = this._watchers[p];
    if (!watchers.length) return;
    for (let i = 0; i < watchers.length; i++) watchers[i].beh.onPin(watchers[i].pin, high, cycles);
    // Two-phase clocking: chips sample on the edge, then update their outputs,
    // so a cascade (74HC595 Q7S → DS) shifts like real hardware.
    for (let i = 0; i < watchers.length; i++) watchers[i].beh.commit?.();
  }

  /** Behaviors with a pin on `net` (optionally a specific pin name), excluding one part. */
  behaviorsOnNet(net, pinName = null, excludeId = null) {
    if (!this.circuit || net < 0) return [];
    const out = [];
    for (const node of this.circuit.nodesOf(net)) {
      const sep = node.lastIndexOf(':');
      const partId = node.slice(0, sep);
      if (partId === excludeId) continue;
      if (pinName && node.slice(sep + 1) !== pinName) continue;
      const beh = this.behaviors.get(partId);
      if (beh && !out.includes(beh)) out.push(beh);
    }
    return out;
  }

  /** Behaviors of every part of a catalog type (e.g. all IR receivers). */
  behaviorsOfType(type) {
    const out = [];
    for (const part of this.parts) {
      if (part.type !== type) continue;
      const beh = this.behaviors.get(part.id);
      if (beh) out.push(beh);
    }
    return out;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Create behaviors and start routing runner events. Call after runner.load(). */
  start() {
    this.stop();
    const boardPart = this.boardPart;
    if (boardPart) this.board = boardByTag(partDef(boardPart.type).tag) || this.board;
    const n = this.board.pinCount;
    this._duty = new Float64Array(n);
    this._freq = new Float64Array(n);
    this._highAcc = new Float64Array(n);
    this._segStart = new Float64Array(n);
    this._frameStart = 0;
    this._lastHigh = new Array(n).fill(false);
    this._rises = new Uint32Array(n);
    this._period = new Float64Array(n);
    this._lastRise = new Float64Array(n);
    this._edges = new Uint32Array(n);
    this._reported.clear();
    this._resetHeld = false;
    this._netLevels = new Map();
    this._notifyReady = false;
    this._notifyDepth = 0;
    this._capCharge = new Map(); // every capacitor starts discharged

    for (const part of this.parts) {
      const def = partDef(part.type);
      if (!def?.behavior) continue;
      const ctx = new PartContext(this, part);
      const beh = new def.behavior(ctx);
      beh.wantsEdges = beh.onPin !== Behavior.prototype.onPin;
      beh.wantsNets = beh.onNet !== Behavior.prototype.onNet;
      this.contexts.set(part.id, ctx);
      this.behaviors.set(part.id, beh);
    }

    const prevState = this.runner.onPinState;
    this._prevOnPinState = prevState;
    this.runner.onPinState = (p, st, cycles) => {
      prevState?.(p, st, cycles);
      this._onPinState(p, st, cycles);
    };
    this.active = true;
    this.rebuild();
    for (const beh of this.behaviors.values()) {
      try { beh.start(); } catch (err) { this.log?.(`[sim] ${err.message}`); }
    }
    // Parts may have set switch positions or outputs while starting.
    this._notifyReady = true;
    this.rebuild();
  }

  stop() {
    if (this.active) this.runner.onPinState = this._prevOnPinState || null;
    this.active = false;
    for (const h of this._capTimers || []) if (h) this.runner.cancel(h);
    this._capTimers = [];
    for (const [id, beh] of this.behaviors) {
      try { beh.stop(); } catch { /* visuals only */ }
      this.contexts.get(id)?.dispose();
    }
    this.behaviors.clear();
    this.contexts.clear();
    this.drivers.clear();
    this.runner.i2c.clear();
    this.runner.spiBus.clear();
    this.circuit = null;
  }

  /** The runner rebuilt its CPU (restart, watchdog, RESET): restart behaviors. */
  restartParts() {
    if (!this.active) return;
    const board = this.board;
    for (const [id, beh] of this.behaviors) {
      try { beh.stop(); } catch { /* ignore */ }
      this.contexts.get(id)?.dispose();
    }
    this.drivers.clear();
    const n = board.pinCount;
    this._lastHigh = new Array(n).fill(false);
    this._highAcc.fill(0);
    this._segStart.fill(this.runner.time);
    this._lastRise.fill(0);
    this._period.fill(0);
    this._rises.fill(0);
    this._edges.fill(0);
    this._duty.fill(0);
    this._freq.fill(0);
    this._frameStart = this.runner.time;
    this._resetHeld = false;
    this._netLevels = new Map();
    this._notifyReady = false;
    this.rebuild();
    for (const beh of this.behaviors.values()) {
      try { beh.start(); } catch (err) { this.log?.(`[sim] ${err.message}`); }
    }
    this._notifyReady = true;
    this.rebuild();
  }

  /** Per-frame update: measure PWM, refresh ADC, let parts redraw. */
  frame() {
    if (!this.active || !this.circuit) return;
    const now = this.runner.time;
    const dt = now - this._frameStart;
    if (dt > 0) {
      const n = this.board.pinCount;
      for (let p = 0; p < n; p++) {
        // ESP32 boards report their PWM (LEDC) as duty and frequency, not edges.
        const hw = this.runner.pwmOf?.(p);
        if (hw) {
          this._duty[p] = hw.duty;
          this._freq[p] = hw.freq;
        } else if (this._edges[p]) {
          let acc = this._highAcc[p];
          if (this._lastHigh[p]) acc += now - this._segStart[p];
          this._duty[p] = Math.max(0, Math.min(1, acc / dt));
          this._freq[p] = this._rises[p] && this._period[p] > 0 ? 1 / this._period[p] : 0;
        } else {
          this._duty[p] = this.runner.getPinState(p) ? 1 : 0;
          this._freq[p] = 0;
        }
        this._highAcc[p] = 0;
        this._segStart[p] = now;
        this._edges[p] = 0;
        this._rises[p] = 0;
      }
      this._frameStart = now;
    }
    for (let i = 0; i < this._dirty.length; i++) {
      if (!this._dirty[i]) continue;
      if (this._islandMcu[i].length) this._settleIsland(i);
      else if (this._islandWatch[i] || this.circuit.islandCapacitors[i].length) this._solve(i);
    }
    for (const beh of this.behaviors.values()) {
      try { beh.frame(dt); } catch (err) { this.log?.(`[sim] ${err.message}`); }
    }
  }

  behaviorOf(partId) {
    return this.behaviors.get(partId) || null;
  }
}


/** Connectivity of a diagram model (wires, part internals, plugged pins) without a running engine. */
export function staticTopology(model) {
  const engine = new CircuitEngine(null);
  engine.setModel(model);
  return engine.staticCircuit();
}
