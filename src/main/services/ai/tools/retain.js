/**
 * Bounded text for the model. A compiler log can run to hundreds of
 * kilobytes; the model needs the part that matters and an exact note of what
 * it did not see. Pure functions, no I/O.
 * @module main/services/ai/tools/retain
 */

/**
 * Keep the head and the tail of a text within a budget.
 * @param {string} text
 * @param {{ max?: number, headShare?: number }} [opts]  max characters kept; share of them from the head
 * @returns {{ text: string, truncated: boolean, omitted: number }}
 */
function retainText(text, { max = 2500, headShare = 0.35 } = {}) {
  const s = String(text ?? '');
  if (s.length <= max) return { text: s, truncated: false, omitted: 0 };
  const head = Math.max(0, Math.floor(max * headShare));
  const tail = Math.max(0, max - head);
  const omitted = s.length - head - tail;
  const cutHead = s.slice(0, head).replace(/[^\n]*$/, '');
  const cutTail = s.slice(s.length - tail).replace(/^[^\n]*\n?/, '');
  return {
    text: `${cutHead}\n[… ${omitted.toLocaleString('en-US')} characters omitted …]\n${cutTail}`,
    truncated: true,
    omitted,
  };
}

/** The retained text alone (what a tool result carries). */
function boundedOutput(text, max = 2500) {
  return retainText(text, { max }).text;
}

/** The last `n` lines of a text (serial, upload tails). */
function lastLines(text, n = 40) {
  const lines = String(text ?? '').split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

module.exports = { retainText, boundedOutput, lastLines };
