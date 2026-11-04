// Base class for part behaviors and the context the engine hands to each one.
//
// A behavior owns one part on the canvas while the simulation runs. It sees
// the circuit through its context (levels, voltages, PWM duty of the nets its
// pins are on), drives its own output pins, talks on the I²C/SPI buses and
// schedules work in simulated time.

import { F_CPU, PinState } from '../avr-runner.js';

export { PinState };

export class PartContext {
  constructor(engine, part) {
    this.engine = engine;
    this.part = part;
    this.id = part.id;
    this.el = part.el;
    this._handles = new Set();
    this._i2c = [];
    this._spi = [];
  }

  get attrs() { return this.part.attrs || (this.part.attrs = {}); }
  get runner() { return this.engine.runner; }
  get board() { return this.engine.board; }

  /** Attribute value; numeric when `fallback` is a number. */
  attr(key, fallback) {
    const raw = this.attrs[key];
    if (raw === undefined || raw === null || raw === '') return fallback;
    if (typeof fallback === 'number') {
      const n = Number(raw);
      return Number.isFinite(n) ? n : fallback;
    }
    if (typeof fallback === 'boolean') return raw === true || raw === 'true' || raw === '1' || raw === 1;
    return raw;
  }

  /** Persist a value in the part's attrs (saved with the diagram). */
  setAttr(key, value) {
    this.attrs[key] = value;
    this.engine.onAttrChange?.(this.part, key, value);
  }

  node(pin) { return `${this.id}:${pin}`; }
  net(pin) { return this.engine.netOfNode(this.node(pin)); }

  /** True when the pin is wired to anything. */
  connected(pin) { return this.engine.nodeConnected(this.node(pin)); }

  /** Logic level of the pin's net: 1, 0, or null when floating. */
  level(pin) { return this.engine.levelOfNet(this.net(pin)); }

  /** Voltage of the pin's net, or null when floating. */
  volts(pin) { return this.engine.voltsOfNet(this.net(pin)); }

  /** Fraction of the last frame the net was HIGH (PWM duty), or null when floating. */
  fraction(pin) { return this.engine.highFractionOfNet(this.net(pin)); }

  /** Square-wave frequency on the net over the last frame (Hz), 0 when steady. */
  frequency(pin) { return this.engine.frequencyOfNet(this.net(pin)); }

  /** Arduino pin that reaches this part pin (directly or through resistors), or null. */
  mcuPin(pin) { return this.engine.mcuPinOfNet(this.net(pin)); }

  /** Pin mode/level of the Arduino pin wired to `pin`. */
  mcuState(pin) {
    const p = this.mcuPin(pin);
    return p === null ? null : this.runner.pinState(p);
  }

  /** True when the Arduino pin on this net is an output driven HIGH. */
  mcuHigh(pin) {
    const p = this.mcuPin(pin);
    return p !== null && this.runner.getPinState(p);
  }

  /** Drive a digital output pin of this part (null releases it). */
  drive(pin, level, ohms = 0) {
    this.engine.setDriver(this.node(pin), level === null || level === undefined ? null : { volts: level ? 5 : 0, ohms });
  }

  /** Drive an analog output pin (volts), or release it with null. */
  driveVolts(pin, volts, ohms = 0) {
    this.engine.setDriver(this.node(pin), volts === null || volts === undefined ? null : { volts: Math.max(0, Math.min(5, volts)), ohms });
  }

  /** Simulated time in seconds. */
  now() { return this.runner.cycles / F_CPU; }
  cycles() { return this.runner.cycles; }

  /** Run `fn` after `seconds` of simulated time. */
  schedule(seconds, fn) {
    let handle = null;
    const wrapped = () => { this._handles.delete(handle); fn(); };
    handle = this.runner.schedule(seconds * F_CPU, wrapped);
    if (handle) this._handles.add(handle);
    return handle;
  }

  cancel(handle) {
    if (!handle) return;
    this._handles.delete(handle);
    this.runner.cancel(handle);
  }

  /** Register an I²C device at a 7-bit address for this run. */
  i2c(address, device) {
    this.runner.i2c.add(address, device);
    this._i2c.push([address, device]);
  }

  /** Register an SPI device for this run. */
  spi(device) {
    this.runner.spiBus.add(device);
    this._spi.push(device);
  }

  /** True when this part pin shares a net with the board's hardware SPI pin. */
  onSpiPin(pin, role) {
    if (this.board.spiByPins) return false;
    const p = this.mcuPin(pin);
    return p !== null && p === this.board.spi[role];
  }

  log(message) { this.engine.log?.(`[${this.id}] ${message}`); }

  /** The circuit topology changed (a switch moved, a relay clicked). */
  invalidate() { this.engine.invalidate(); }

  /** Ask the inspector to refresh this part's live readout. */
  changed() { this.engine.onPartStatus?.(this.part); }

  dispose() {
    for (const h of this._handles) this.runner.cancel(h);
    this._handles.clear();
    for (const [addr, dev] of this._i2c) this.runner.i2c.remove(addr, dev);
    for (const dev of this._spi) this.runner.spiBus.remove(dev);
    this._i2c = [];
    this._spi = [];
  }
}

export class Behavior {
  /** @param {PartContext} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    this.el = ctx.el;
  }

  /** Zero-ohm connections inside the part right now, e.g. a pressed button. */
  links() { return null; }

  /** Resistances inside the part right now: [[pinA, pinB, ohms]]. */
  resistors() { return null; }

  /** On-board pull-up resistors: [[pin, ohms]]. */
  pullups() { return null; }

  /** The simulation started (program loaded, nets built). */
  start() {}

  /** The simulation stopped: put the part back in its idle look. */
  stop() {}

  /**
   * An Arduino pin on one of this part's nets changed level or mode.
   * Only called when a subclass overrides it.
   * @param {string} pin part pin
   * @param {boolean} high the Arduino pin's output level
   * @param {number} cycles CPU cycle of the change
   */
  onPin(pin, high, cycles) { void pin; void high; void cycles; }

  /**
   * The logic level of the net on one of this part's pins changed, whatever
   * caused it (an Arduino pin, another part's output, a switch). Only called
   * when a subclass overrides it. Drive outputs through `ctx.schedule` so a
   * chain of chips settles in simulated time rather than recursively.
   * @param {string} pin part pin
   * @param {0|1|null} level new level (null = floating)
   */
  onNet(pin, level) { void pin; void level; }

  /** Called ~30 times a second while running, after PWM duty is measured. */
  frame() {}

  /** Pointer pressed/released on the part while the simulation runs. */
  press() {}
  release() {}

  /** A live control in the inspector changed. */
  control(key, value) { void key; void value; }

  /** One-line live readout for the inspector. */
  status() { return null; }
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Drive `pin` through a timed waveform in simulated time.
 * @param {PartContext} ctx
 * @param {string} pin
 * @param {[number, number][]} segments [level, microseconds]
 * @param {{ openDrain?: boolean, idle?: number|null, onDone?: () => void }} [options]
 *   openDrain: HIGH segments release the line (a pull-up makes it HIGH);
 *   idle: level to leave the pin at afterwards (null = released).
 * @returns {{ cancel(): void }}
 */
export function playWaveform(ctx, pin, segments, { openDrain = false, idle = null, onDone } = {}) {
  let i = 0;
  let handle = null;
  let cancelled = false;
  const step = () => {
    if (cancelled) return;
    if (i >= segments.length) {
      ctx.drive(pin, idle);
      onDone?.();
      return;
    }
    const [level, us] = segments[i++];
    ctx.drive(pin, level ? (openDrain ? null : 1) : 0);
    handle = ctx.schedule(us / 1e6, step);
  };
  step();
  return {
    cancel() {
      cancelled = true;
      ctx.cancel(handle);
    },
  };
}
