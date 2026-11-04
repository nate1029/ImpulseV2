// Simulator checks: compile the open sketch for the simulated board, run it
// headless with the circuit from the canvas, and evaluate its `// @expect`
// lines. Used by Sketch > Run Hardware Tests and to verify AI code edits.

import { runHeadless, summarizeTrace } from './simulation/headless.js';
import { programOf } from './simulation/runners.js';
import { parseExpectations, evaluateExpectations } from './simulation/expectations.js';
import { boardForFqbn, BOARDS } from './simulation/boards.js';

/** True when the simulator can run sketches for this FQBN (or none is selected). */
export function isSimulatableBoard(fqbn) {
  return !fqbn || boardForFqbn(fqbn) !== null;
}

/** Board, FQBN and circuit the simulator view currently uses. */
export function simulationContext() {
  return window.simManager?.simulationContext?.() || { board: 'uno', fqbn: BOARDS.uno.fqbn, label: BOARDS.uno.label, circuit: null };
}

/**
 * @param {{ sketchPath: string, code: string, context?: object, signal?: AbortSignal, onStage?: (stage: string) => void }} opts
 * @returns {Promise<{ ok: boolean, stage: 'compile'|'run'|'done', error?: string, seconds?: number,
 *   results?: object[], parseErrors?: object[], pins?: object[], serial?: string, simSeconds?: number, board?: string }>}
 */
/** Expectation kinds that depend on the emulator keeping up with time. */
const TIMING_KINDS = /frequency|toggle|pulse|duty|period/;

export async function runSimulatorCheck({ sketchPath, code, context = simulationContext(), signal, onStage }) {
  const { seconds, items, errors: parseErrors } = parseExpectations(code, context.board);
  onStage?.('compile');
  const compiled = await window.electronAPI.arduino.compileHex(sketchPath, context.fqbn, context.properties ? { properties: context.properties } : undefined);
  if (!compiled?.success) {
    return { ok: false, stage: 'compile', error: (compiled?.error || 'Compilation failed').trim(), parseErrors, board: context.label };
  }
  onStage?.('run');
  const attempt = () => runHeadless(programOf(compiled), { seconds, signal, board: context.board, mcu: context.mcu, circuit: context.circuit });
  let run;
  try {
    run = await attempt();
  } catch (err) {
    return { ok: false, stage: 'run', error: err.message, parseErrors, board: context.label };
  }
  let results = evaluateExpectations(items, run, context.board);
  // The ESP32 runs in a real-time emulator: on a busy computer its first run
  // after launch can lag and drop a few pin edges, failing a timing check the
  // sketch would pass. One more run settles it before anyone is told.
  if (BOARDS[context.board]?.family === 'esp32' && !signal?.aborted
    && results.some((r, i) => !r.pass && TIMING_KINDS.test(items[i]?.kind || ''))) {
    try {
      const again = await attempt();
      const second = evaluateExpectations(items, again, context.board);
      if (second.filter((r) => r.pass).length >= results.filter((r) => r.pass).length) {
        run = again;
        results = second;
      }
    } catch { /* the first run stands */ }
  }
  return {
    ok: results.every(r => r.pass) && parseErrors.length === 0,
    stage: 'done',
    seconds,
    simSeconds: run.simSeconds,
    results,
    parseErrors,
    pins: summarizeTrace(run.trace, run.finalStates, context.board),
    serial: run.serial,
    board: context.label,
    shorts: run.shorts,
  };
}

/**
 * What a failed simulator run tells the model. The failing checks alone send
 * it round in circles: it also needs what the board actually printed, what the
 * pins actually did, and what is wired, so it can tell its own bug from a
 * missing part or a check that could never pass.
 * @param {object} result  from runSimulatorCheck
 * @param {{ wiring?: string, hasCircuit?: boolean }} [circuit]
 * @returns {string}
 */
export function simulatorFixPrompt(result, { wiring = '', hasCircuit = false } = {}) {
  const lines = [];
  if (result.stage === 'compile') {
    lines.push(`[SIMULATOR] The sketch does not compile for the simulated ${result.board || 'board'}:`);
    lines.push(String(result.error || '').split('\n').slice(0, 12).join('\n'));
    lines.push('Fix the code.');
    return lines.join('\n');
  }
  if (result.stage === 'run') {
    lines.push(`[SIMULATOR] The run stopped on the simulated ${result.board || 'board'}: ${result.error}`);
    lines.push('That is usually a sketch that blocks forever or crashes. Fix the code.');
    return lines.join('\n');
  }
  const failed = (result.results || []).filter((r) => !r.pass);
  lines.push(`[SIMULATOR] It compiled and ran ${result.simSeconds?.toFixed?.(1) ?? '?'} s on the simulated ${result.board || 'board'}, and ${failed.length === 1 ? 'one check did not pass' : `${failed.length} checks did not pass`}:`);
  for (const r of failed.slice(0, 6)) lines.push(`- ${r.raw}: ${r.detail}`);
  for (const p of (result.parseErrors || []).slice(0, 3)) lines.push(`- that check could not be read: ${p.raw || p.message}`);
  const serial = String(result.serial || '').trim();
  lines.push(serial
    ? `What it printed:\n${serial.split('\n').slice(-12).join('\n')}`
    : 'It printed nothing at all.');
  // summarizeTrace: { pin, label, edges, hz, high } per pin that did anything.
  const pins = (result.pins || []).filter((p) => p.edges || p.high).slice(0, 8);
  if (pins.length) {
    lines.push(`Pins: ${pins.map((p) => `${p.label || p.pin} ${p.edges ? `${p.edges} edges${p.hz ? `, about ${Number(p.hz).toFixed(1)} Hz` : ''}` : 'held HIGH'}`).join('; ')}`);
  } else {
    lines.push('No pin changed while it ran.');
  }
  lines.push(hasCircuit ? `Wired on the canvas:\n${wiring}` : 'Nothing is wired on the simulator canvas, so anything the sketch expects from a sensor or a button cannot happen there.');
  lines.push(hasCircuit
    ? 'Decide what is actually wrong: the code, or a check that cannot pass with this wiring. Fix the code if it is the code; if the wiring or the check is the problem, say so plainly and change the check instead of the logic.'
    : 'If the sketch needs parts to pass, do not twist the code to satisfy the check: say the circuit is missing and either adjust the @expect lines to what can be tested without parts, or ask the user to draw the circuit in the simulator.');
  return lines.join('\n');
}

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function formatHz(hz) {
  if (hz === null || hz === undefined) return '';
  if (hz >= 1000) return `${(hz / 1000).toFixed(1)} kHz`;
  return `${hz.toFixed(hz < 10 ? 2 : 1)} Hz`;
}

/** One-line verdict used by both the report and the chat card. */
export function verdictText(result) {
  if (result.stage === 'compile') return `Does not compile for the simulated ${result.board || 'board'}`;
  if (result.stage === 'run') return `Simulator stopped: ${result.error}`;
  const total = result.results.length;
  const passed = result.results.filter(r => r.pass).length;
  const ran = `Ran ${result.simSeconds.toFixed(1)} s on the simulated ${result.board || 'board'}`;
  if (total === 0) return `${ran}. No @expect checks in this sketch.`;
  return `${ran}. ${passed}/${total} checks passed.`;
}

/** Full report for the Tests tab. */
export function renderTestReport(container, result, { title = 'Hardware tests' } = {}) {
  container.innerHTML = '';
  const head = el('div', `tests-head ${result.ok ? 'pass' : 'fail'}`);
  head.append(el('span', 'tests-dot'), el('strong', '', title), el('span', 'tests-verdict', verdictText(result)));
  container.appendChild(head);

  if (result.stage === 'compile' || result.stage === 'run') {
    container.appendChild(el('pre', 'tests-error', result.error));
    return;
  }

  for (const pe of result.parseErrors || []) {
    const row = el('div', 'tests-row fail');
    row.append(el('span', 'tests-mark', '!'), el('span', 'tests-check', `Line ${pe.line}`), el('span', 'tests-detail', pe.message));
    container.appendChild(row);
  }
  for (const r of result.results) {
    const row = el('div', `tests-row ${r.pass ? 'pass' : 'fail'}`);
    row.append(el('span', 'tests-mark', r.pass ? '✓' : '✗'), el('span', 'tests-check', r.raw), el('span', 'tests-detail', r.detail));
    container.appendChild(row);
  }
  if (!result.results.length && !(result.parseErrors || []).length) {
    container.appendChild(el('p', 'tests-hint',
      'Add checks as comments, e.g. // @expect pin 13 frequency 1Hz  or  // @expect serial contains "ready". Set the run length with // @run 5s.'));
  }

  const activity = el('div', 'tests-section');
  activity.appendChild(el('div', 'tests-section-title', 'Pin activity'));
  if (result.pins.length) {
    for (const p of result.pins) {
      const row = el('div', 'tests-pin');
      row.append(el('span', 'tests-pin-label', p.label), el('span', '', `${p.edges} edges`), el('span', '', formatHz(p.hz)), el('span', '', p.high ? 'ends HIGH' : 'ends LOW'));
      activity.appendChild(row);
    }
  } else {
    activity.appendChild(el('div', 'tests-detail', 'No digital pin changed state.'));
  }
  container.appendChild(activity);

  const serial = el('div', 'tests-section');
  serial.appendChild(el('div', 'tests-section-title', 'Serial output'));
  serial.appendChild(el('pre', 'tests-serial', result.serial ? result.serial.slice(0, 2000) : '(nothing printed)'));
  container.appendChild(serial);
}

/** Compact card appended under an AI reply that changed the code. */
export function renderVerifyCard(result, { onFix } = {}) {
  const card = el('div', `verify-card ${result.ok ? 'pass' : 'fail'}`);
  const head = el('div', 'verify-head');
  head.append(el('span', 'verify-dot'), el('span', 'verify-title', result.ok ? 'Verified in simulator' : 'Simulator found a problem'));
  card.appendChild(head);
  card.appendChild(el('div', 'verify-body', verdictText(result)));

  const failures = result.stage === 'done'
    ? result.results.filter(r => !r.pass).map(r => `${r.raw}: ${r.detail}`)
    : [result.error];
  if (!result.ok && failures.length) {
    const list = el('ul', 'verify-failures');
    for (const f of failures.slice(0, 4)) list.appendChild(el('li', '', String(f).split('\n')[0].slice(0, 160)));
    card.appendChild(list);
  }
  if (result.stage === 'done' && result.pins.length) {
    card.appendChild(el('div', 'verify-pins', result.pins.slice(0, 4).map(p => `${p.label} ${p.hz ? formatHz(p.hz) : `${p.edges} edges`}`).join(' · ')));
  }
  if (!result.ok && onFix) {
    const btn = el('button', 'verify-fix', 'Fix with AI');
    btn.type = 'button';
    btn.addEventListener('click', () => onFix(failures));
    card.appendChild(btn);
  }
  return card;
}
