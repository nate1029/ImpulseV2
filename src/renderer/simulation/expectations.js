// Hardware tests written as comments in the sketch, checked against a
// simulator run:
//
//   // @expect serial contains "ready"
//   // @expect serial matches /temp=\d+/
//   // @expect pin 13 toggles
//   // @expect pin 13 frequency 1Hz ±10%
//   // @expect pin 9 high
//   // @expect no serial
//   // @run 5s

import { boardById, parseBoardPin, pinLabel as boardPinLabel } from './boards.js';

const DEFAULT_SECONDS = 3;
const MAX_SECONDS = 30;

/** "13", "D13", "A0", "LED_BUILTIN" → Arduino pin number for a board (Uno: A0 = 14). */
export function parsePinRef(ref, board = 'uno') {
  return parseBoardPin(boardById(board), ref);
}

const pinLabel = (pin, board) => boardPinLabel(boardById(board), pin);

function parseLine(body, board) {
  let m;
  if ((m = /^serial\s+(?:contains|prints)\s+"((?:[^"\\]|\\.)*)"$/i.exec(body))) {
    return { kind: 'serial-contains', text: m[1].replace(/\\(.)/g, '$1') };
  }
  if ((m = /^serial\s+matches\s+\/(.+)\/([gimsuy]*)$/i.exec(body))) {
    try {
      return { kind: 'serial-matches', regex: new RegExp(m[1], m[2].replace('g', '')) };
    } catch (err) {
      return { error: `Invalid regular expression: ${err.message}` };
    }
  }
  if (/^no\s+serial$/i.test(body)) return { kind: 'no-serial' };
  if ((m = /^pin\s+(\S+)\s+(toggles|high|low)$/i.exec(body))) {
    const pin = parsePinRef(m[1], board);
    if (pin === null) return { error: `Unknown pin "${m[1]}"` };
    return { kind: `pin-${m[2].toLowerCase()}`, pin };
  }
  if ((m = /^pin\s+(\S+)\s+(?:frequency|freq)\s+(.+)$/i.exec(body))) {
    const pin = parsePinRef(m[1], board);
    if (pin === null) return { error: `Unknown pin "${m[1]}"` };
    const spec = m[2].replace(/\s+/g, '');
    const freq = /^([\d.]+)hz(.*)$/i.exec(spec);
    const hz = freq ? Number(freq[1]) : NaN;
    if (!(hz > 0)) return { error: 'Frequency must look like "1Hz" and be greater than 0' };
    let tolerance = 0.1;
    if (freq[2]) {
      const tol = /^(?:±|\+-|\+\/-)([\d.]+)%$/.exec(freq[2]);
      if (!tol) return { error: `Tolerance must look like "±10%", got "${freq[2]}"` };
      tolerance = Number(tol[1]) / 100;
    }
    return { kind: 'pin-frequency', pin, hz, tolerance };
  }
  return { error: `Unrecognised expectation: "${body}"` };
}

/**
 * @returns {{ seconds: number, items: object[], errors: {line: number, message: string}[] }}
 */
export function parseExpectations(code, board = 'uno') {
  const items = [];
  const errors = [];
  let seconds = DEFAULT_SECONDS;
  const lines = String(code || '').split('\n');
  lines.forEach((line, index) => {
    const run = /\/\/\s*@run\s+([\d.]+)\s*(ms|s)\b/i.exec(line);
    if (run) {
      const value = Number(run[1]) / (run[2].toLowerCase() === 'ms' ? 1000 : 1);
      if (value > 0) seconds = Math.min(value, MAX_SECONDS);
      return;
    }
    const m = /\/\/\s*@expect\s+(.+?)\s*$/i.exec(line);
    if (!m) return;
    const parsed = parseLine(m[1], board);
    if (parsed.error) errors.push({ line: index + 1, message: parsed.error });
    else items.push({ ...parsed, raw: m[1], line: index + 1 });
  });
  return { seconds, items, errors };
}

function measuredHz(trace, pin) {
  const rises = trace.filter(e => e.pin === pin && e.high).map(e => e.t);
  if (rises.length < 3) return null;
  return (rises.length - 1) / (rises[rises.length - 1] - rises[0]);
}

/**
 * @param {object[]} items - from parseExpectations
 * @param {{ serial: string, trace: object[], finalStates: boolean[] }} run - from runHeadless
 * @returns {{ raw: string, line: number, pass: boolean, detail: string }[]}
 */
export function evaluateExpectations(items, run, board = run.board || 'uno') {
  const serial = run.serial || '';
  return items.map((item) => {
    const base = { raw: item.raw, line: item.line };
    switch (item.kind) {
      case 'serial-contains': {
        const pass = serial.includes(item.text);
        return { ...base, pass, detail: pass ? 'found in serial output' : `not found in ${serial.length} chars of serial output` };
      }
      case 'serial-matches': {
        const match = item.regex.exec(serial);
        return { ...base, pass: !!match, detail: match ? `matched "${match[0].slice(0, 60)}"` : 'no match in serial output' };
      }
      case 'no-serial':
        return { ...base, pass: serial.length === 0, detail: serial.length ? `printed ${serial.length} chars` : 'no output' };
      case 'pin-toggles': {
        const edges = run.trace.filter(e => e.pin === item.pin).length;
        return { ...base, pass: edges >= 2, detail: `${pinLabel(item.pin, board)} changed ${edges} time${edges === 1 ? '' : 's'}` };
      }
      case 'pin-high':
      case 'pin-low': {
        const high = !!run.finalStates[item.pin];
        const pass = item.kind === 'pin-high' ? high : !high;
        return { ...base, pass, detail: `${pinLabel(item.pin, board)} ended ${high ? 'HIGH' : 'LOW'}` };
      }
      case 'pin-frequency': {
        const hz = measuredHz(run.trace, item.pin);
        if (hz === null) return { ...base, pass: false, detail: `${pinLabel(item.pin, board)} did not oscillate long enough to measure` };
        const pass = Math.abs(hz - item.hz) <= item.hz * item.tolerance;
        return { ...base, pass, detail: `measured ${hz.toFixed(hz < 10 ? 2 : 1)} Hz` };
      }
      default:
        return { ...base, pass: false, detail: 'unsupported expectation' };
    }
  });
}
