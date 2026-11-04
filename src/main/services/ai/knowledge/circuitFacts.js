/**
 * The circuit on the simulator canvas, as the model should see it. The
 * renderer publishes what is wired (one line per board pin, the parts, the
 * wiring check's warnings, who changed it last) through ui:update-circuit;
 * this turns it into a compact [CIRCUIT] block for the system message, and
 * notes when it changed since earlier messages. Pure functions.
 * @module main/services/ai/knowledge/circuitFacts
 */

const MAX_PIN_LINES = 30;
const MAX_CHECKS = 5;
const MAX_PARTS = 40;

/** A small stable hash of what matters (pins and parts), for change detection. */
function circuitHash(circuit) {
  if (!circuit || !circuit.hasCircuit) return 'none';
  const text = [...(circuit.lines || []), '|', ...(circuit.parts || [])].join('\n');
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Clean and bound what the renderer sent, for uiState.
 * @param {unknown} raw
 * @returns {object|null}
 */
function normalizeCircuit(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const list = (v, n, len) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, n).map((x) => x.slice(0, len)) : []);
  const circuit = {
    hasCircuit: !!raw.hasCircuit,
    board: str(raw.board, 40),
    boardLabel: str(raw.boardLabel, 80),
    parts: list(raw.parts, MAX_PARTS, 80),
    lines: list(raw.lines, 80, 240),
    checks: Array.isArray(raw.checks)
      ? raw.checks.filter((c) => c && typeof c.text === 'string').slice(0, 20).map((c) => ({ level: c.level === 'error' ? 'error' : 'warn', text: c.text.slice(0, 240) }))
      : [],
    changedBy: ['user', 'ai', 'load'].includes(raw.changedBy) ? raw.changedBy : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt.slice(0, 40) : null,
    at: Date.now(),
  };
  circuit.hash = circuitHash(circuit);
  return circuit;
}

const when = (iso) => {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return ` at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};

/**
 * The [CIRCUIT] block for the system message, or null when nothing is wired.
 * @param {object|null} circuit  from normalizeCircuit
 * @param {{ changed?: boolean }} [opts]  the circuit differs from earlier messages' in this conversation
 */
function circuitBlock(circuit, { changed = false } = {}) {
  if (!circuit || !circuit.hasCircuit) return null;
  const by = circuit.changedBy === 'user' ? `, wired by the user${when(circuit.updatedAt)}`
    : circuit.changedBy === 'ai' ? `, placed by Impulse's circuit builder${when(circuit.updatedAt)}`
      : '';
  const out = [`[CIRCUIT] On the simulator canvas, saved as diagram.json next to the sketch${by}. These are the real connections: write for these pins and parts.`];
  if (circuit.parts.length) out.push(`Parts: ${circuit.parts.join(', ')}`);
  const lines = circuit.lines.slice(0, MAX_PIN_LINES);
  out.push(...lines);
  if (circuit.lines.length > lines.length) out.push(`… and ${circuit.lines.length - lines.length} more pins (get_circuit lists them all)`);
  if (!circuit.lines.length) out.push('No part is wired to a board pin yet.');
  if (circuit.checks.length) {
    const shown = circuit.checks.slice(0, MAX_CHECKS);
    const errors = circuit.checks.filter((c) => c.level === 'error').length;
    out.push(`Wiring check: ${circuit.checks.length} ${circuit.checks.length === 1 ? 'problem' : 'problems'}${errors ? ` (${errors} serious)` : ''}:`);
    out.push(...shown.map((c) => `- ${c.text}`));
    if (circuit.checks.length > shown.length) out.push(`- … and ${circuit.checks.length - shown.length} more`);
  }
  if (changed) out.push('[CIRCUIT CHANGED] The circuit changed since earlier messages in this conversation; use the wiring above, not what was said before.');
  return out.join('\n');
}

/** What get_circuit returns to the model. */
function circuitToolResult(circuit) {
  if (!circuit || !circuit.hasCircuit) {
    return {
      hasCircuit: false,
      note: 'No circuit is drawn on the simulator canvas. If you need to see the wiring, ask the user to draw it in the simulator (side panel › Simulator, or the circuit builder from the sketch) so you can check it.',
    };
  }
  return {
    hasCircuit: true,
    board: circuit.boardLabel || circuit.board,
    changedBy: circuit.changedBy,
    updatedAt: circuit.updatedAt,
    parts: circuit.parts,
    wiring: circuit.lines,
    checks: circuit.checks,
  };
}

module.exports = { circuitHash, normalizeCircuit, circuitBlock, circuitToolResult };
