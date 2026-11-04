// Logic analyzer: records pin edges during a live simulation and draws the
// last few seconds as waveforms, one row per active pin.

import { pinLabel } from './headless.js';

const KEEP_SECONDS = 20;
const MAX_EVENTS_PER_PIN = 20000;
const ROW_HEIGHT = 26;
const LABEL_WIDTH = 46;
const STATS_WIDTH = 120;
const WINDOWS = [0.01, 0.05, 0.25, 1, 2, 5, 10];

export class LogicAnalyzer {
  /** @param {HTMLElement} host */
  constructor(host) {
    this.host = host;
    this.pins = new Map(); // pin -> [{ t, high }]
    this.now = 0;
    this.windowIndex = 4; // 2 s
    this.frozen = false;
    this.board = 'uno';

    host.innerHTML = `
      <div class="la-toolbar">
        <button type="button" class="la-btn" data-act="zoom-in" title="Shorter time window">−</button>
        <span class="la-window"></span>
        <button type="button" class="la-btn" data-act="zoom-out" title="Longer time window">+</button>
        <button type="button" class="la-btn la-freeze" data-act="freeze" title="Freeze the display">Freeze</button>
      </div>
      <div class="la-body"><canvas class="la-canvas"></canvas><p class="la-empty">Run the simulation to see pin activity.</p></div>`;
    this.canvas = host.querySelector('.la-canvas');
    this.empty = host.querySelector('.la-empty');
    this.windowLabel = host.querySelector('.la-window');
    host.querySelector('[data-act="zoom-in"]').addEventListener('click', () => this.setWindow(this.windowIndex - 1));
    host.querySelector('[data-act="zoom-out"]').addEventListener('click', () => this.setWindow(this.windowIndex + 1));
    const freeze = host.querySelector('[data-act="freeze"]');
    freeze.addEventListener('click', () => {
      this.frozen = !this.frozen;
      freeze.classList.toggle('active', this.frozen);
      freeze.textContent = this.frozen ? 'Live' : 'Freeze';
      this.render();
    });
    this.setWindow(this.windowIndex);
    // Redraw on width changes only, a frame later: drawing resizes the canvas,
    // and redrawing synchronously inside the observer would loop.
    let lastWidth = 0;
    new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      if (width === lastWidth) return;
      lastWidth = width;
      requestAnimationFrame(() => this.render());
    }).observe(host);
  }

  get windowSeconds() {
    return WINDOWS[this.windowIndex];
  }

  setWindow(index) {
    this.windowIndex = Math.max(0, Math.min(WINDOWS.length - 1, index));
    const s = this.windowSeconds;
    this.windowLabel.textContent = s < 1 ? `${Math.round(s * 1000)} ms` : `${s} s`;
    this.render();
  }

  /** Label pins for this board (uno, nano, mega). */
  setBoard(id) {
    this.board = id;
  }

  reset() {
    this.pins.clear();
    this.now = 0;
    this.render();
  }

  push(pin, high, t) {
    if (!this.pins.has(pin)) this.pins.set(pin, [{ t: 0, high: !high }]);
    const events = this.pins.get(pin);
    events.push({ t, high });
    // Trim in batches: shifting the array on every edge would be O(n) per edge
    // on fast signals like a NeoPixel data line.
    if (events.length > MAX_EVENTS_PER_PIN * 1.5) events.splice(0, events.length - MAX_EVENTS_PER_PIN);
    if (t > this.now) this.now = t;
  }

  /** Advance the time cursor even when no pin changes (e.g. long delays). */
  tick(t) {
    if (t > this.now) this.now = t;
    const cutoff = this.now - KEEP_SECONDS;
    for (const events of this.pins.values()) {
      let drop = 0;
      while (drop < events.length - 1 && events[drop + 1].t < cutoff) drop++;
      if (drop) events.splice(0, drop);
    }
  }

  static stats(events, from, to) {
    const rises = events.filter(e => e.high && e.t >= from && e.t <= to).map(e => e.t);
    let hz = null;
    if (rises.length >= 3) hz = (rises.length - 1) / (rises[rises.length - 1] - rises[0]);
    let highTime = 0;
    for (let i = 0; i < events.length; i++) {
      const start = Math.max(events[i].t, from);
      const end = Math.min(i + 1 < events.length ? events[i + 1].t : to, to);
      if (end > start && events[i].high) highTime += end - start;
    }
    const span = to - from;
    return { hz, duty: span > 0 ? highTime / span : 0 };
  }

  render() {
    if (this.frozen && this._drawnOnce) return;
    const rows = [...this.pins.keys()].sort((a, b) => a - b);
    this.empty.hidden = rows.length > 0;
    const body = this.canvas.parentElement;
    const width = body.clientWidth;
    const height = Math.max(rows.length * ROW_HEIGHT + 22, 40);
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, width * dpr);
    this.canvas.height = height * dpr;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!rows.length) return;
    this._drawnOnce = true;

    const styles = getComputedStyle(this.host);
    const color = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
    const ink = color('--ds-text-2', '#d0d6e0');
    const muted = color('--ds-text-4', '#62666d');
    const grid = color('--ds-line', '#23252a');
    const fill = color('--ds-active', 'rgba(255,255,255,0.075)');

    const to = this.now;
    const from = to - this.windowSeconds;
    const plotLeft = LABEL_WIDTH;
    const plotWidth = Math.max(10, width - LABEL_WIDTH - STATS_WIDTH);
    const x = (t) => plotLeft + ((t - from) / this.windowSeconds) * plotWidth;

    ctx.font = '11px "JetBrains Mono Variable", ui-monospace, monospace';
    ctx.textBaseline = 'middle';

    // Time grid
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const gx = Math.round(plotLeft + (plotWidth * i) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, height - 18);
      ctx.stroke();
      const label = this.windowSeconds * (i / 4 - 1);
      ctx.fillStyle = muted;
      ctx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
      ctx.fillText(i === 4 ? 'now' : `${label < -0.999 ? label.toFixed(1) + ' s' : Math.round(label * 1000) + ' ms'}`, gx, height - 8);
    }

    rows.forEach((pin, row) => {
      const events = this.pins.get(pin);
      const top = row * ROW_HEIGHT + 5;
      const lowY = top + ROW_HEIGHT - 9;
      const highY = top + 2;

      ctx.fillStyle = ink;
      ctx.textAlign = 'left';
      ctx.fillText(pinLabel(pin, this.board), 8, top + (ROW_HEIGHT - 6) / 2);

      ctx.beginPath();
      let started = false;
      for (let i = 0; i < events.length; i++) {
        const segStart = events[i].t;
        const segEnd = i + 1 < events.length ? events[i + 1].t : to;
        if (segEnd < from || segStart > to) continue;
        const x0 = Math.max(plotLeft, x(segStart));
        const x1 = Math.min(plotLeft + plotWidth, x(segEnd));
        const y = events[i].high ? highY : lowY;
        if (events[i].high) {
          ctx.save();
          ctx.fillStyle = fill;
          ctx.fillRect(x0, highY, Math.max(1, x1 - x0), lowY - highY);
          ctx.restore();
        }
        if (!started) { ctx.moveTo(x0, y); started = true; } else ctx.lineTo(x0, y);
        ctx.lineTo(x1, y);
      }
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.25;
      ctx.stroke();

      const { hz, duty } = LogicAnalyzer.stats(events, from, to);
      ctx.fillStyle = muted;
      ctx.textAlign = 'right';
      const freq = hz === null ? '' : hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${hz.toFixed(hz < 10 ? 2 : 1)} Hz`;
      ctx.fillText(`${freq}${freq ? '  ' : ''}${Math.round(duty * 100)}%`, width - 8, top + (ROW_HEIGHT - 6) / 2);
    });
  }
}
