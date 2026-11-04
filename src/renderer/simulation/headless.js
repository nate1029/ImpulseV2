// Run a compiled sketch without the canvas: same CPU loop as the live runner,
// stepped as fast as possible, yielding to the UI between slices. When a
// circuit is given, its parts are simulated too (with stand-in elements), so
// hardware tests and AI checks see sensors, buttons and displays.

import { F_CPU } from './avr-runner.js';
import { createRunner } from './runners.js';
import { boardById, pinLabel as boardPinLabel } from './boards.js';
import { CircuitEngine } from './engine.js';
import { partDef } from './parts/catalog.js';
import { plugLinks } from './diagram.js';

const SLICE_CYCLES = F_CPU / 50; // 20 ms of simulated time per slice
const MAX_TRACE = 200_000;
const MAX_SERIAL = 64 * 1024;

/**
 * Stand-in for a rendered part element: pin names, writable properties and
 * events, without a DOM.
 */
export function fakeElement(type, attrs = {}) {
  const def = partDef(type);
  if (!def) throw new Error(`Unknown part ${type}`);
  const merged = { ...def.attrs, ...attrs };
  const el = new EventTarget();
  el.tagName = def.tag.toUpperCase();
  el.pinInfo = def.pinNames(merged).map(name => ({ name, x: 0, y: 0 }));
  for (const [k, v] of Object.entries(merged)) el[k] = v;
  el.pixels = [];
  el.setPixel = (...args) => {
    if (args.length === 2) el.pixels[args[0]] = args[1];
    else el.pixels[args[0] * 100 + args[1]] = args[2];
  };
  el.imageData = { data: new Uint8ClampedArray(128 * 64 * 4), width: 128, height: 64 };
  el.redraw = () => {};
  return el;
}

/**
 * Engine + parts for a diagram model, without a canvas.
 * @param {AvrRunner} runner
 * @param {{ parts: {id, type, x?, y?, rotate?, attrs}[], wires: {from, to}[] }} model
 */
export function headlessCircuit(runner, model) {
  const parts = model.parts.filter(p => partDef(p.type)).map(p => ({
    id: p.id, type: p.type, attrs: { ...partDef(p.type).attrs, ...(p.attrs || {}) }, el: fakeElement(p.type, p.attrs),
  }));
  const engine = new CircuitEngine(runner);
  const hasPositions = model.parts.some(p => typeof p.x === 'number');
  engine.setModel({ parts, wires: model.wires, links: hasPositions ? plugLinks(model.parts) : [] });
  return { engine, parts };
}

/**
 * @param {string|Uint8Array|object} hex - the program: Intel HEX (AVR boards), UF2 (Raspberry Pi Pico) or an ESP32 flash image ({ image, chip })
 * @param {{ seconds?: number, board?: string, mcu?: string, signal?: AbortSignal, onProgress?: (simSeconds: number) => void,
 *   setup?: (runner: AvrRunner, engine: CircuitEngine|null) => void, beforeStop?: (runner, engine, sofar: { serial: string, trace: object[] }) => void, circuit?: object }} [options]
 * @returns {Promise<{ serial: string, trace: {pin: number, high: boolean, t: number}[], finalStates: boolean[],
 *   simSeconds: number, truncated: boolean, board: string, shorts: object[] }>}
 */
export async function runHeadless(hex, options = {}) {
  const seconds = Math.min(Math.max(options.seconds ?? 3, 0.05), 60);
  const runner = createRunner(options.board || 'uno');
  let serial = '';
  const trace = [];
  const shorts = [];
  let truncated = false;
  let loadError = null;

  runner.onSerial = (ch, port = 0) => {
    if (port !== 0) return;
    if (serial.length < MAX_SERIAL) serial += ch;
    else truncated = true;
  };
  runner.onPinChange = (pin, high, cycles) => {
    if (trace.length < MAX_TRACE) trace.push({ pin, high, t: cycles / F_CPU });
    else truncated = true;
  };
  runner.onError = (msg) => { loadError = msg; };

  if (!runner.load(hex, options.board || 'uno', options.mcu)) throw new Error(loadError || 'Could not load the compiled program');

  let engine = null;
  if (options.circuit?.parts?.length) {
    ({ engine } = headlessCircuit(runner, options.circuit));
    engine.onShort = (s) => shorts.push(s);
    engine.start();
  }
  options.setup?.(runner, engine);

  if (runner.realtime) {
    // ESP32 boards: the firmware runs in real time in its emulator.
    runner.start();
    const timer = setInterval(() => engine?.frame(), 10);
    try {
      await runner.waitUntil(seconds, { signal: options.signal });
      // The firmware's serial text and pin events travel through the emulator's
      // bridge a little behind its clock; give what is in flight a moment to land
      // before the run is read, or a check can miss the last line it printed.
      await new Promise((resolve) => setTimeout(resolve, 400));
      options.beforeStop?.(runner, engine, { serial, trace });
    } catch (err) {
      err.serial = serial; // what the firmware printed before it crashed or hung
      throw err;
    } finally {
      clearInterval(timer);
      runner.shutdown();
    }
    engine?.stop();
    const board = runner.board;
    const finalStates = Array.from({ length: board.pinCount }, (_, pin) => runner.getPinState(pin));
    return { serial, trace, finalStates, simSeconds: runner.sketchTime, truncated, board: board.id, shorts };
  }

  const target = Math.round(seconds * F_CPU);
  const frame = F_CPU / 100;
  while (runner.cycles < target) {
    if (options.signal?.aborted) throw new Error('Simulation cancelled');
    const sliceEnd = Math.min(target, runner.cycles + SLICE_CYCLES);
    while (runner.cycles < sliceEnd) {
      runner.step(Math.min(frame, sliceEnd - runner.cycles));
      engine?.frame();
    }
    options.onProgress?.(runner.cycles / F_CPU);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  options.beforeStop?.(runner, engine, { serial, trace });
  engine?.stop();

  const board = runner.board;
  const finalStates = Array.from({ length: board.pinCount }, (_, pin) => runner.getPinState(pin));
  return { serial, trace, finalStates, simSeconds: runner.cycles / F_CPU, truncated, board: board.id, shorts };
}

/** "D13" / "A0" for an Arduino pin on a board (Uno by default). */
export function pinLabel(pin, board = 'uno') {
  return boardPinLabel(boardById(board), pin);
}

/**
 * Per-pin activity: edge count and, for periodic signals, frequency.
 * @returns {{ pin: number, label: string, edges: number, hz: number|null, high: boolean }[]}
 */
export function summarizeTrace(trace, finalStates = [], board = 'uno') {
  const byPin = new Map();
  for (const ev of trace) {
    if (!byPin.has(ev.pin)) byPin.set(ev.pin, []);
    byPin.get(ev.pin).push(ev);
  }
  const out = [];
  for (const [pin, events] of byPin) {
    const rises = events.filter(e => e.high).map(e => e.t);
    let hz = null;
    if (rises.length >= 3) {
      const period = (rises[rises.length - 1] - rises[0]) / (rises.length - 1);
      if (period > 0) hz = 1 / period;
    }
    out.push({ pin, label: pinLabel(pin, board), edges: events.length, hz, high: !!finalStates[pin] });
  }
  return out.sort((a, b) => a.pin - b.pin);
}
