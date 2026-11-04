// Headless test bench: a board plus parts with fake elements, wired like a
// diagram, running real firmware through the circuit engine.
import { F_CPU } from '../avr-runner.js';
import { createRunner } from '../runners.js';
import { CircuitEngine } from '../engine.js';
import { partDef } from '../parts/catalog.js';
import { BOARDS } from '../boards.js';
import { fakeElement } from '../headless.js';
import { plugLinks } from '../diagram.js';

export class Bench {
  constructor(board = 'uno', { addBoard = true } = {}) {
    this.boardId = board;
    this.runner = createRunner(board);
    this.engine = new CircuitEngine(this.runner);
    this.parts = [];
    this.wires = [];
    this.serial = '';
    this.logs = [];
    this.shorts = [];
    this.links = [];
    if (addBoard) this.add(BOARDS[board].tag, board);
  }

  /** Load a whole diagram model (parts with positions, wires). */
  addModel(model) {
    for (const p of model.parts) {
      const part = this.add(p.type, p.id, p.attrs || {});
      Object.assign(part, { x: p.x, y: p.y, rotate: p.rotate || 0 });
    }
    for (const w of model.wires) this.wires.push({ from: { ...w.from }, to: { ...w.to } });
    this.links = plugLinks(this.parts);
    return this;
  }

  add(type, id, attrs = {}) {
    const def = partDef(type);
    const part = { id, type, attrs: { ...def.attrs, ...attrs }, el: fakeElement(type, attrs) };
    this.parts.push(part);
    return part;
  }

  /** wire('uno:13', 'r1:1', ...more pairs) */
  wire(...ends) {
    for (let i = 0; i + 1 < ends.length; i += 2) {
      const [a, b] = [ends[i], ends[i + 1]].map(e => {
        const sep = e.indexOf(':');
        return { partId: e.slice(0, sep), pin: e.slice(sep + 1) };
      });
      this.wires.push({ from: a, to: b });
    }
    return this;
  }

  part(id) { return this.parts.find(p => p.id === id); }
  behavior(id) { return this.engine.behaviorOf(id); }

  load(hex) {
    this.runner.onSerial = (ch, port) => { if (!port) this.serial += ch; };
    this.engine.log = (m) => this.logs.push(m);
    this.engine.onShort = (s) => this.shorts.push(s);
    if (!this.runner.load(hex, this.boardId)) throw new Error('load failed');
    this.engine.setModel({ parts: this.parts, wires: this.wires, links: this.links });
    this.engine.start();
    return this;
  }

  /** Run for `seconds` of simulated time, calling frame() every 10 ms. Actions: [[t, fn], …] */
  run(seconds, actions = []) {
    const pending = [...actions].sort((a, b) => a[0] - b[0]);
    const end = this.runner.cycles + seconds * F_CPU;
    const slice = F_CPU / 100;
    while (this.runner.cycles < end) {
      while (pending.length && pending[0][0] * F_CPU <= this.runner.cycles) pending.shift()[1](this);
      this.runner.step(Math.min(slice, end - this.runner.cycles));
      this.engine.frame();
    }
    return this;
  }

  /** Serial lines printed so far. */
  lines() {
    return this.serial.split('\n').map(l => l.replace(/\r$/, '')).filter(Boolean);
  }
}

export { BOARDS, fakeElement };
