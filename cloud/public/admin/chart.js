// Small SVG charts for the admin console: one trace per line chart with a
// crosshair tooltip and a data table, and single-hue horizontal bars.
// Labels are set with textContent (they come from the database).

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Every day from `days` ago to today (UTC), with zeros where there's no row. */
export function fillDays(rows, days, key) {
  const byDay = new Map(rows.map((r) => [r.day, r[key]]));
  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const day = d.toISOString().slice(0, 10);
    out.push({ day, value: Number(byDay.get(day) || 0) });
  }
  return out;
}

/** Clean axis ticks from 0: at most 5 steps of 1, 2 or 5 x 10^n. */
export function niceTicks(max, { integer = false } = {}) {
  if (!(max > 0)) return [0, 1];
  const exp = 10 ** Math.floor(Math.log10(max / 5));
  // Counts never get fractional ticks.
  const step = Math.max(integer ? 1 : 0, [1, 2, 5, 10, 20, 50].map((m) => m * exp).find((s) => Math.ceil(max / s - 1e-9) <= 5));
  const count = Math.ceil(max / step - 1e-9);
  return Array.from({ length: count + 1 }, (_, i) => Number((i * step).toPrecision(12)));
}

const shortDate = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * @param {HTMLElement} host
 * @param {{ title: string, points: { day: string, value: number }[], format: (v: number) => string, tick?: (v: number) => string, integer?: boolean }} spec
 */
export function lineChart(host, spec) {
  host.replaceChildren();
  const figure = el('figure', 'chart');
  const head = el('figcaption', 'chart-head');
  const total = spec.points.reduce((s, p) => s + p.value, 0);
  head.append(el('span', 'chart-title', spec.title), el('span', 'chart-total', spec.format(total)));
  const plot = el('div', 'chart-plot');
  plot.tabIndex = 0;
  plot.setAttribute('role', 'img');
  const last = spec.points.at(-1);
  plot.setAttribute('aria-label', `${spec.title}: ${spec.format(total)} over ${spec.points.length} days, ${spec.format(last?.value || 0)} on the last day.`);
  const tip = el('div', 'chart-tip');
  tip.hidden = true;
  plot.append(tip);
  figure.append(head, plot);

  const details = el('details', 'chart-data');
  details.append(el('summary', null, 'View data'));
  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  hr.append(el('th', null, 'Day'), el('th', null, spec.title));
  thead.append(hr);
  const tbody = el('tbody');
  for (const p of [...spec.points].reverse()) {
    const tr = el('tr');
    tr.append(el('td', null, p.day), el('td', 'num', spec.format(p.value)));
    tbody.append(tr);
  }
  table.append(thead, tbody);
  details.append(table);
  figure.append(details);
  host.append(figure);

  const tick = spec.tick || spec.format;
  let active = spec.points.length - 1;

  function render() {
    const width = Math.max(240, plot.clientWidth);
    const height = 168;
    const pad = { top: 12, right: 14, bottom: 22, left: 44 };
    const w = width - pad.left - pad.right;
    const hgt = height - pad.top - pad.bottom;
    const ticks = niceTicks(Math.max(...spec.points.map((p) => p.value), 0), { integer: spec.integer });
    const max = ticks.at(-1);
    const n = spec.points.length;
    const x = (i) => pad.left + (n === 1 ? w / 2 : (i / (n - 1)) * w);
    const y = (v) => pad.top + hgt - (v / max) * hgt;

    const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true' });
    for (const [i, v] of ticks.entries()) {
      const gy = y(v);
      root.append(svg('line', { x1: pad.left, x2: width - pad.right, y1: gy, y2: gy, class: i === 0 ? 'axis' : 'grid' }));
      const label = svg('text', { x: pad.left - 8, y: gy + 3.5, class: 'tick', 'text-anchor': 'end' });
      label.textContent = tick(v);
      root.append(label);
    }
    for (const i of [0, Math.floor((n - 1) / 2), n - 1]) {
      const label = svg('text', { x: x(i), y: height - 6, class: 'tick', 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle' });
      label.textContent = shortDate(spec.points[i].day);
      root.append(label);
    }
    const line = spec.points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join('');
    root.append(svg('path', { d: `${line}L${x(n - 1)} ${y(0)}L${x(0)} ${y(0)}Z`, class: 'area' }));
    root.append(svg('path', { d: line, class: 'trace' }));
    const cross = svg('line', { y1: pad.top, y2: pad.top + hgt, class: 'cross' });
    const dot = svg('circle', { r: 4, class: 'dot' });
    root.append(cross, dot);
    const endLabel = svg('text', { class: 'end-label', 'text-anchor': 'end' });
    root.append(endLabel);

    function place(i, showTip) {
      active = i;
      const p = spec.points[i];
      const px = x(i);
      const py = y(p.value);
      dot.setAttribute('cx', px);
      dot.setAttribute('cy', py);
      cross.setAttribute('x1', px);
      cross.setAttribute('x2', px);
      cross.style.opacity = showTip ? 1 : 0;
      endLabel.textContent = showTip ? '' : spec.format(p.value);
      endLabel.setAttribute('x', px - 8);
      endLabel.setAttribute('y', Math.max(pad.top + 10, py - 8));
      tip.hidden = !showTip;
      if (showTip) {
        tip.replaceChildren(el('strong', null, spec.format(p.value)), el('span', null, shortDate(p.day)));
        const left = Math.min(Math.max(px - tip.offsetWidth / 2, 0), width - tip.offsetWidth);
        tip.style.left = `${left}px`;
        tip.style.top = `${Math.max(0, py - 52)}px`;
      }
    }

    plot.querySelector('svg')?.remove();
    plot.prepend(root);
    place(active, false);

    plot.onpointermove = (e) => {
      const rect = plot.getBoundingClientRect();
      const rel = e.clientX - rect.left - pad.left;
      place(Math.max(0, Math.min(n - 1, Math.round((rel / w) * (n - 1)))), true);
    };
    plot.onpointerleave = () => place(n - 1, false);
    plot.onfocus = () => place(active, true);
    plot.onblur = () => place(n - 1, false);
    plot.onkeydown = (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        place(Math.max(0, Math.min(n - 1, active + (e.key === 'ArrowLeft' ? -1 : 1))), true);
      }
    };
  }

  render();
  new ResizeObserver(() => render()).observe(plot);
}

/**
 * @param {HTMLElement} host
 * @param {{ label: string, value: number, note?: string }[]} rows
 * @param {(v: number) => string} format
 */
export function bars(host, rows, format) {
  host.replaceChildren();
  if (!rows.length) {
    host.append(el('p', 'empty', 'Nothing in this period yet.'));
    return;
  }
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  const list = el('ul', 'bars');
  for (const r of rows) {
    const li = el('li');
    const name = el('span', 'bar-label', r.label);
    const track = el('span', 'bar-track');
    const fill = el('span', 'bar-fill');
    fill.style.width = `${Math.max(1.5, (r.value / max) * 100)}%`;
    track.append(fill);
    const value = el('span', 'bar-value', format(r.value));
    li.append(name, track, value);
    if (r.note) li.title = r.note;
    list.append(li);
  }
  host.append(list);
}
