// Simulator vs real board: run the sketch in the simulator and on the board
// for the same time, then diff the serial output line by line. A mismatch
// points at wiring, power or hardware differences, not code.

const MAX_LINES = 300;

/** Baud rate from the first `Serial.begin(N)`, defaulting to 9600. */
export function detectBaud(code) {
  const m = /\bSerial\s*\.\s*begin\s*\(\s*(\d{3,7})\s*[,)]/.exec(String(code || ''));
  return m ? Number(m[1]) : 9600;
}

export function toLines(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(0, MAX_LINES);
}

// Lines that differ only in their numbers (timings, sensor readings) are
// "values differ", not structural mismatches.
const shape = (line) => line.replace(/-?[\d.]+/g, '#').trim();

/**
 * Line diff (LCS) between simulator and board output.
 * @returns {{ rows: {type: 'same'|'values'|'sim-only'|'board-only', sim?: string, board?: string}[], same: number, values: number, simOnly: number, boardOnly: number }}
 */
export function diffSerial(simText, boardText) {
  const a = toLines(simText);
  const b = toLines(boardText);
  const eq = (x, y) => x === y || shape(x) === shape(y);
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = eq(a[i], b[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(a[i], b[j])) {
      rows.push({ type: a[i] === b[j] ? 'same' : 'values', sim: a[i], board: b[j] });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ type: 'sim-only', sim: a[i++] });
    } else {
      rows.push({ type: 'board-only', board: b[j++] });
    }
  }
  while (i < n) rows.push({ type: 'sim-only', sim: a[i++] });
  while (j < m) rows.push({ type: 'board-only', board: b[j++] });
  const count = (t) => rows.filter(r => r.type === t).length;
  return { rows, same: count('same'), values: count('values'), simOnly: count('sim-only'), boardOnly: count('board-only') };
}

/** Capture serial output from a real board for `seconds`. */
export async function captureBoardSerial(port, baud, seconds) {
  let text = '';
  const unsubscribe = window.electronAPI.serial.onData((payload) => {
    text += typeof payload === 'string' ? payload : (payload?.data ?? '');
  });
  try {
    const opened = await window.electronAPI.serial.connect(port, baud);
    if (opened && opened.success === false) throw new Error(opened.error || `Could not open ${port}`);
    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  } finally {
    unsubscribe?.();
    await window.electronAPI.serial.disconnect().catch(() => {});
  }
  return text;
}

/** Side-by-side report for the Tests tab. */
export function renderCompareReport(container, { diff, baud, seconds, port }) {
  container.innerHTML = '';
  const matched = diff.same + diff.values;
  const total = diff.rows.length;
  const ok = diff.simOnly === 0 && diff.boardOnly === 0;
  const head = document.createElement('div');
  head.className = `tests-head ${ok ? 'pass' : 'fail'}`;
  head.innerHTML = '<span class="tests-dot"></span><strong>Simulator vs board</strong><span class="tests-verdict"></span>';
  head.querySelector('.tests-verdict').textContent = total === 0
    ? `Neither printed anything in ${seconds} s at ${baud} baud.`
    : `${matched}/${total} lines match (${diff.values} differ only in values) · ${port} @ ${baud} baud, ${seconds} s`;
  container.appendChild(head);

  const table = document.createElement('div');
  table.className = 'compare-table';
  const headerRow = document.createElement('div');
  headerRow.className = 'compare-row compare-header';
  headerRow.innerHTML = '<span>Simulator</span><span>Board</span>';
  table.appendChild(headerRow);
  for (const row of diff.rows) {
    const el = document.createElement('div');
    el.className = `compare-row ${row.type}`;
    const sim = document.createElement('span');
    const board = document.createElement('span');
    sim.textContent = row.sim ?? '';
    board.textContent = row.board ?? '';
    el.append(sim, board);
    table.appendChild(el);
  }
  container.appendChild(table);
  if (!ok) {
    const hint = document.createElement('p');
    hint.className = 'tests-hint';
    hint.textContent = 'Lines only on one side usually mean a wiring, power or sensor difference on the real board, or output that depends on timing.';
    container.appendChild(hint);
  }
}
