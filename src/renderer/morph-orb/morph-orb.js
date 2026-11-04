// MorphOrb in the AI chat. The composer is a pill; on send it folds into a
// ball, flies up into the conversation and assembles into a dotted orb while
// the agent works, its label following the agent's real steps. When the
// answer is ready the orb turns green, condenses, and unfolds into the answer
// card, which stays in the chat as the message, and the pill comes back.
//
// Ported from the MorphOrb React component ("ai-thiking-orb-and-input") to
// plain DOM: the same choreography, timings, easing and orb renderer, laid out
// in the panel rather than the window. Errors resolve red instead of green.
// Reduced motion swaps every movement for cross-fades, as the original does.

/* ───────────────────────────── copy ───────────────────────────── */
export const COPY = {
  placeholder: 'Ask anything…',
  labels: ['Thinking', 'Searching', 'Analyzing', 'Composing'],
  done: 'Done',
  failed: 'Stopped',
  answerTitle: 'Answer',
  errorTitle: 'Couldn’t finish',
  send: 'Send',
};

/** The orb's label and light program (0-3) for each agent step. */
const TOOL_STEPS = {
  get_editor_code: ['Reading the sketch', 1],
  get_current_state: ['Reading the sketch', 1],
  get_current_sketch_path: ['Reading the sketch', 1],
  search_code: ['Searching', 1],
  search_memory: ['Searching past fixes', 1],
  list_boards: ['Checking boards', 1],
  list_ports: ['Checking ports', 1],
  analyze_error: ['Analyzing', 2],
  record_fix: ['Noting the fix', 2],
  read_serial: ['Reading Serial', 2],
  connect_serial: ['Opening Serial', 2],
  send_serial: ['Writing to Serial', 2],
  disconnect_serial: ['Closing Serial', 2],
  auto_detect_baud: ['Finding the baud rate', 2],
  set_baud_rate: ['Setting the baud rate', 2],
  get_baud_rate: ['Reading the baud rate', 2],
  get_available_baud_rates: ['Reading the baud rate', 2],
  edit_code: ['Writing code', 3],
  set_editor_code: ['Writing code', 3],
  replace_in_code: ['Writing code', 3],
  save_sketch: ['Saving', 3],
  compile_sketch: ['Compiling', 3],
  upload_sketch: ['Uploading', 3],
  update_playground: ['Composing', 3],
};

/** { type: 'thinking' } | { type: 'tool', name } → [label, program] */
export function stepLabel(step) {
  if (!step || step.type === 'thinking') return [COPY.labels[0], 0];
  return TOOL_STEPS[step.name] || ['Working', 3];
}

/* ─────────────────────────── geometry ─────────────────────────── */
const PILL_H = 60, BALL_SMALL = 60, ORB_D = 132, ORB_R = 66, CANVAS = 220;
const FLY_D = 138;
/** Room the orb and its label take in the conversation, and where its centre sits. */
export const STAGE_H = 236;
const STAGE_CY = 110;

/* ───────────────────────── math + easing ───────────────────────── */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const fmt = (v) => String(Math.round(v * 1e4) / 1e4);
const TAU = Math.PI * 2;

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  const solve = (x) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-6) return t;
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      const e = sx(t);
      if (Math.abs(e - x) < 1e-6) break;
      if (x > e) lo = t; else hi = t;
      t = (hi - lo) / 2 + lo;
    }
    return t;
  };
  return (x) => (x <= 0 ? 0 : x >= 1 ? 1 : sy(solve(x)));
}

const E = {
  out: cubicBezier(0.22, 1, 0.36, 1),
  io: cubicBezier(0.65, 0, 0.35, 1),
  in: cubicBezier(0.4, 0, 1, 1),
  fly: cubicBezier(0.5, 0, 0.1, 1),
  grow: cubicBezier(0.3, 0, 0.2, 1),
  vortex: cubicBezier(0.6, 0, 0.2, 1),
  spring: cubicBezier(0.34, 1.4, 0.64, 1),
  card: cubicBezier(0.65, 0, 0.2, 1),
  lin: (t) => t,
};

const bez = (t, p0, c, p2) => (1 - t) * (1 - t) * p0 + 2 * (1 - t) * t * c + t * t * p2;

/* ───────────────────────── timeline data ───────────────────────── */
const T = (ch, from, to, t0, t1, ease = E.io) => ({ ch, from, to, t0, t1, ease });

export const launchTracks = (g) => [
  T('w', g.pw, g.pw - 12, 0, 100, E.out),
  T('oInput', 1, 0, 0, 160, E.in),
  T('inScale', 1, 0.6, 0, 160, E.in),
  T('oGlow', 1, 0, 0, 300, E.out),
  T('oAur', 1, 0, 0, 300, E.out),
  T('w', g.pw - 12, BALL_SMALL, 100, 560, E.io),
  T('h', g.ph, g.ph + 6, 380, 500, E.out),
  T('h', g.ph + 6, BALL_SMALL, 500, 620, E.out),
  T('oPill', 1, 0, 300, 560, E.out),
  T('oBall', 0, 1, 300, 560, E.out),
  T('u', 0, 1, 620, 1500, E.fly),
  T('w', BALL_SMALL, FLY_D, 620, 1300, E.grow),
  T('h', BALL_SMALL, FLY_D, 620, 1300, E.grow),
  T('w', FLY_D, ORB_D, 1300, 1500, E.out),
  T('h', FLY_D, ORB_D, 1300, 1500, E.out),
  T('cHalo', 0, 0.6, 620, 1500, E.out),
  T('trail', 0, 1, 700, 800, E.out),
  T('trail', 1, 0, 1300, 1500, E.in),
];

const ASSEMBLE = [
  T('oRing', 1, 0, 0, 300, E.out),
  T('oBall', 1, 0, 0, 260, E.out),
  T('orb.k', 0, 1, 0, 800, E.out),
  T('orb.alpha', 0, 1, 0, 800, E.out),
  T('orb.spin', 0, 0.9, 0, 800, E.out),
  T('orb.pop', 1, 1.05, 0, 420, E.out),
  T('orb.pop', 1.05, 1, 420, 800, E.io),
  T('sOp', 0, 1, 300, 620, E.out),
  T('sTy', 6, 0, 300, 620, E.out),
];

const RESOLVE = [
  T('orb.sweep', 0, 1, 0, 700, E.io),
  T('orb.spin', 0.9, 0.3, 0, 700, E.out),
  T('orb.gain', 1, 0, 0, 700, E.out),
  T('orb.floor', 0, 0.95, 400, 900, E.out),
  T('orb.rad', 0, 0.15, 400, 900, E.out),
  T('orb.pop', 1, 1.04, 600, 800, E.out),
  T('orb.pop', 1.04, 1, 800, 900, E.out),
];

const CONDENSE = [
  T('orb.pop', 1, 1.06, 0, 120, E.out),
  T('sOp', 1, 0, 0, 160, E.in),
  T('sTy', 0, -6, 0, 160, E.in),
  T('orb.k', 1, 0, 120, 640, E.vortex),
  T('orb.vortex', 0, 1.6, 120, 640, E.vortex),
  T('oGreen', 0, 1, 260, 700, E.spring),
  T('gs', 0.55, 1, 260, 700, E.spring),
  T('pulse', 0, 1, 320, 760, E.out),
  T('oHalo', 0, 0.35, 380, 700, E.out),
  T('orb.alpha', 1, 0, 500, 800, E.out),
];

/**
 * The green disk opens into the card at the message's place (m moves it from
 * the orb's spot to the message's centre). At 700 ms the card has the
 * message's exact box and the message takes over ("dock"); its header and
 * words then come in as on the original card.
 */
export const unfoldTracks = (g, tw) => [
  T('w', ORB_D, 124, 0, 90, E.in),
  T('h', ORB_D, 124, 0, 90, E.in),
  T('w', 124, g.cw, 90, 700, E.card),
  T('h', 124, g.ch, 90, 700, E.out),
  T('r', ORB_D / 2, 20, 90, 700, E.io),
  T('m', 0, 1, 90, 700, E.card),
  T('oGreen', 1, 0, 200, 560, E.out),
  T('oCard', 0, 1, 200, 560, E.out),
  T('oHalo', 0.35, 0, 300, 700, E.out),
  T('cHalo', 0.6, 0, 300, 700, E.out),
  T('dock', 0, 1, 699, 700, E.lin),
  T('hOp', 0, 1, 720, 1040, E.out),
  T('dotS', 0, 1, 720, 1040, E.spring),
  T('wp', 0, 1, 780, 780 + tw, E.lin),
  T('bloom', 1, 0.625, 880, 1380, E.io),
];

/* reduced-motion: pure cross-fades */
const R_OUT = [
  T('oInput', 1, 0, 0, 140, E.out),
  T('oPill', 1, 0, 0, 200, E.out),
  T('oGlow', 1, 0, 0, 200, E.out),
  T('oAur', 1, 0, 0, 200, E.out),
  T('oRing', 1, 0, 0, 200, E.out),
];
const R_IN = [
  T('orb.alpha', 0, 1, 0, 200, E.out),
  T('sOp', 0, 1, 0, 200, E.out),
  T('cHalo', 0, 0.6, 0, 200, E.out),
];
const R_RESOLVE = [T('orb.sweep', 0, 1, 0, 250, E.io), T('orb.floor', 0, 0.95, 0, 250, E.out)];
const R_CONDENSE = [
  T('oGreen', 0, 1, 0, 250, E.out),
  T('orb.alpha', 1, 0, 0, 250, E.out),
  T('sOp', 1, 0, 0, 250, E.out),
];
const R_GREEN_OUT = [T('oGreen', 1, 0, 0, 120, E.out), T('cHalo', 0.6, 0, 0, 120, E.out)];
const rCardIn = (tw) => [
  T('hOp', 0, 1, 0, 250, E.out),
  T('wp', 0, 1, 0, tw, E.lin),
  T('bloom', 1, 0.625, 0, 250, E.out),
];

const INIT = {
  r: 999, oGlow: 1, oHalo: 0, oPill: 1, oBall: 0, oGreen: 0, oCard: 0, oRing: 1, oInput: 1, inScale: 1, oAur: 1,
  gs: 0.55, cs: 1, bloom: 1, u: 0, m: 0, yOff: 0, trail: 0, pulse: -1, sOp: 0, sTy: 6, cHalo: 0, dock: 0,
  'orb.k': 0, 'orb.alpha': 0, 'orb.spin': 0, 'orb.pop': 1, 'orb.sweep': 0, 'orb.vortex': 0, 'orb.gain': 1, 'orb.floor': 0, 'orb.rad': 0,
};

/* ─────────────────────────── async utils ─────────────────────────── */
const ABORT = Symbol('abort');

function sleep(ms, sig) {
  return new Promise((res) => {
    if (sig.aborted) return res();
    let id = 0;
    const onAbort = () => { window.clearTimeout(id); res(); };
    id = window.setTimeout(() => { sig.removeEventListener('abort', onAbort); res(); }, Math.max(0, ms));
    sig.addEventListener('abort', onAbort, { once: true });
  });
}

/* ───────────────────────────── dotted orb ───────────────────────────── */
const RINGS = 16;
const DOT_LIST = (() => {
  const rand = mulberry32(7);
  const out = [];
  for (let k = 0; k < RINGS; k++) {
    const y = 1 - ((k + 0.5) / RINGS) * 2;
    const r = Math.sqrt(1 - y * y);
    const m = Math.max(4, Math.round(30 * r));
    for (let j = 0; j < m; j++) {
      const a = (j / m) * TAU + k * 0.35;
      out.push({ x: Math.cos(a) * r, y, z: Math.sin(a) * r, u: (1 - y) / 2, seed: rand() * 6.283 });
    }
  }
  return out;
})();
const N = DOT_LIST.length;
const DX = Float32Array.from(DOT_LIST, (d) => d.x);
const DY = Float32Array.from(DOT_LIST, (d) => d.y);
const DZ = Float32Array.from(DOT_LIST, (d) => d.z);
const DU = Float32Array.from(DOT_LIST, (d) => d.u);
const DS = Float32Array.from(DOT_LIST, (d) => d.seed);

const G_STEPS = 24, A_STEPS = 48;
/** Dot colours from `rest` to `done` (the sweep), at every alpha step. */
function palette(rest, done) {
  const out = [];
  for (let gi = 0; gi <= G_STEPS; gi++) {
    const g = gi / G_STEPS;
    const r = Math.round(lerp(rest[0], done[0], g)), gg = Math.round(lerp(rest[1], done[1], g)), b = Math.round(lerp(rest[2], done[2], g));
    for (let ai = 0; ai <= A_STEPS; ai++) out.push(`rgba(${r},${gg},${b},${(ai / A_STEPS).toFixed(3)})`);
  }
  return out;
}
/** The original's dark palette (light grey dots, emerald sweep), and the light theme's and errors' counterparts. */
export const PALETTES = {
  dark: palette([235, 235, 235], [52, 211, 153]),
  darkError: palette([235, 235, 235], [248, 113, 113]),
  light: palette([58, 60, 66], [5, 150, 105]),
  lightError: palette([58, 60, 66], [220, 38, 38]),
};

const ORB_KEYS = ['k', 'alpha', 'spin', 'sweep', 'pop', 'vortex', 'gain', 'floor', 'rad'];

function createOrb(canvas, getSpeed, isReduced) {
  const P = { k: 0, alpha: 0, spin: 0, rot: 0, sweep: 0, pop: 1, vortex: 0, gain: 1, floor: 0, rad: 0, prog: 0 };
  const ctx = canvas.getContext('2d');
  const lit = new Float32Array(N);
  const SX = new Float32Array(N), SY = new Float32Array(N), SR = new Float32Array(N), SD = new Float32Array(N);
  const SC = new Int16Array(N);
  const pw = [1, 0, 0, 0];
  let colors = PALETTES.dark;
  let time = 0, raf = 0, last = 0, dead = false;

  const reset = () => {
    P.k = 0; P.alpha = 0; P.spin = 0; P.rot = 0; P.sweep = 0; P.pop = 1; P.vortex = 0; P.gain = 1; P.floor = 0; P.rad = 0; P.prog = 0;
    lit.fill(0);
    pw[0] = 1; pw[1] = 0; pw[2] = 0; pw[3] = 0;
    time = isReduced() ? 1.2 : 0;
  };
  reset();
  const setPalette = (p) => { colors = p; };

  if (!ctx) return { P, ensure() {}, reset, setPalette, destroy() {} };

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(CANVAS * dpr);
  canvas.height = Math.round(CANVAS * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const S = 0.6, CP = Math.cos(0.35), SP = Math.sin(0.35), C0 = CANVAS / 2;

  const draw = (dt) => {
    ctx.clearRect(0, 0, CANVAS, CANVAS);
    time += dt;
    P.rot += P.spin * dt;
    const yaw = P.rot + P.vortex, cyw = Math.cos(yaw), syw = Math.sin(yaw);
    const stepW = dt / 0.35;
    for (let q = 0; q < 4; q++) {
      const d = (q === P.prog ? 1 : 0) - pw[q];
      pw[q] += Math.abs(d) <= stepW ? d : d > 0 ? stepW : -stepW;
    }
    const decay = Math.exp(-dt / 0.5);
    const h0 = (time * 300) % N, h3 = (time * 480) % N;
    const a1 = time * 0.8, b1 = Math.sin(time * 0.5) * 0.9;
    const f1x = Math.cos(b1) * Math.cos(a1), f1y = Math.sin(b1), f1z = Math.cos(b1) * Math.sin(a1);
    const a2 = time * 0.55 + 2.1, b2 = Math.cos(time * 0.42) * 0.9;
    const f2x = Math.cos(b2) * Math.cos(a2), f2y = Math.sin(b2), f2z = Math.cos(b2) * Math.sin(a2);
    const lat = Math.sin(time * 2.2);
    const swirlK = P.vortex * 1.5;

    for (let n = 0; n < N; n++) {
      const dx = DX[n], dy = DY[n], dz = DZ[n], u = DU[n];

      /* light programs: dots are lit in turn */
      let pulse = 0;
      if (pw[0] > 0.001) {
        let dd = Math.abs(n - h0); if (dd > N - dd) dd = N - dd;
        const v = Math.max(0, 1 - dd / 16);
        pulse = Math.max(pulse, v * v * pw[0]);
      }
      if (pw[1] > 0.001) {
        const v1 = Math.max(0, (dx * f1x + dy * f1y + dz * f1z - 0.72) / 0.28);
        const v2 = Math.max(0, (dx * f2x + dy * f2y + dz * f2z - 0.72) / 0.28);
        const v = Math.max(v1, v2);
        pulse = Math.max(pulse, v * v * pw[1]);
      }
      if (pw[2] > 0.001) {
        const e = dy - lat;
        const v = Math.max(0, 1 - (e * e) / 0.02);
        pulse = Math.max(pulse, v * v * pw[2]);
      }
      if (pw[3] > 0.001) {
        let dd = Math.abs(n - h3); if (dd > N - dd) dd = N - dd;
        const v = Math.max(0, 1 - dd / 22);
        pulse = Math.max(pulse, v * v * pw[3]);
      }
      const l = Math.max(lit[n] * decay, pulse * P.gain);
      lit[n] = l;

      /* per-dot appearance: top dots first, bottom collapse first */
      const ki = clamp01(P.k * (1 + S) - S * u);
      if (ki <= 0.001) { SC[n] = -1; continue; }
      const eo = E.out(ki), kk = eo * P.pop;

      const x1 = dx * cyw + dz * syw, z1 = -dx * syw + dz * cyw;
      const y2 = dy * CP - z1 * SP, z2 = dy * SP + z1 * CP;
      const f = 2.8 / (2.8 - z2), depth = (z2 + 1) / 2;
      let ox = x1 * ORB_R * kk * f, oy = -y2 * ORB_R * kk * f;
      if (swirlK > 0.001) {
        const sw = (1 - ki) * swirlK, cc = Math.cos(sw), ss = Math.sin(sw);
        const tx = ox * cc - oy * ss;
        oy = ox * ss + oy * cc;
        ox = tx;
      }

      const g = clamp01((P.sweep * 1.4 - u) / 0.4);
      let a = 0.1 + 0.035 * Math.sin(DS[n] + time * 1.6) * (1 - g) + 0.32 * depth * depth + 0.75 * l * (1 - g) + g * (0.55 + 0.4 * depth) + 2 * g * (1 - g);
      a = Math.max(a, P.floor * (0.7 + 0.3 * depth));
      if (a > 1) a = 1;
      a *= eo * P.alpha;

      SX[n] = C0 + ox;
      SY[n] = C0 + oy;
      SD[n] = depth;
      SR[n] = (1.15 * (0.45 + 0.75 * depth) * f + 0.9 * l + g * 0.25) * (1 + P.rad) * (0.4 + 0.6 * eo);
      const ai = Math.round(a * A_STEPS), gi = Math.round(g * G_STEPS);
      SC[n] = ai <= 0 ? -1 : gi * (A_STEPS + 1) + ai;
    }

    /* two passes: back half first, then front half */
    for (let pass = 0; pass < 2; pass++) {
      for (let n = 0; n < N; n++) {
        const c = SC[n];
        if (c < 0) continue;
        if ((SD[n] >= 0.5) !== (pass === 1)) continue;
        ctx.fillStyle = colors[c];
        ctx.beginPath();
        ctx.arc(SX[n], SY[n], SR[n], 0, TAU);
        ctx.fill();
      }
    }
  };

  const frame = (now) => {
    raf = 0;
    if (dead) return;
    const dt = isReduced() ? 0 : Math.max(0, Math.min(0.05, (now - last) / 1000)) * getSpeed();
    last = now;
    draw(dt);
    if (P.alpha > 0.002) raf = requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, CANVAS, CANVAS);
  };

  const ensure = () => {
    if (raf || dead || P.alpha <= 0.002) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };

  const destroy = () => {
    dead = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  return { P, ensure, reset, setPalette, destroy };
}

/* ───────────────────────── answer words ───────────────────────── */

/**
 * Wrap the answer's words in .mo-w spans so they can come in one by one, as
 * on the original card. A code block or an inline code span comes in whole.
 * @returns {HTMLElement[]} the units, in reading order
 */
export function wrapWords(body) {
  const units = [];
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 1) {
        const el = child;
        if (el.matches('.code-block-wrapper, code, pre, img, svg, button')) {
          el.classList.add('mo-w');
          units.push(el);
        } else {
          walk(el);
        }
      } else if (child.nodeType === 3 && child.textContent.trim()) {
        const frag = document.createDocumentFragment();
        for (const part of child.textContent.split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) { frag.append(part); continue; }
          const w = document.createElement('span');
          w.className = 'mo-w';
          w.textContent = part;
          frag.append(w);
          units.push(w);
        }
        child.replaceWith(frag);
      }
    }
  };
  walk(body);
  return units;
}

/* ───────────────────────────── runtime ───────────────────────────── */

const CHANNELS_ON_ACTOR = ['oGlow', 'oHalo', 'oPill', 'oBall', 'oGreen', 'oCard', 'oRing', 'oInput', 'oAur', 'gs', 'cs'];
const CHANNELS_ON_MESSAGE = ['hOp', 'dotS', 'bloom'];

const sampleAt = (h, t, out) => {
  const n = h.length;
  const copy = (s) => { out.x = s.x; out.y = s.y; out.d = s.d; };
  if (n === 0) { out.x = 0; out.y = 0; out.d = 0; return; }
  if (t <= h[0].t) return copy(h[0]);
  for (let i = n - 1; i > 0; i--) {
    const a = h[i - 1], b = h[i];
    if (t >= a.t) {
      if (t >= b.t) return copy(b);
      const k = (t - a.t) / (b.t - a.t || 1);
      out.x = lerp(a.x, b.x, k); out.y = lerp(a.y, b.y, k); out.d = lerp(a.d, b.d, k);
      return;
    }
  }
  copy(h[n - 1]);
};

/**
 * Mount the orb in the AI panel.
 * @param {{ host: HTMLElement, list: HTMLElement, slot: HTMLElement, input: HTMLTextAreaElement,
 *   send: HTMLButtonElement, speed?: number, minThinkMs?: number, onBusy?: (busy: boolean) => void }} opts
 *   host: the panel (the orb's layer covers it); list: the conversation; slot:
 *   where the pill sits in the composer; input/send: the pill's field and button;
 *   onBusy: hears when an exchange starts and ends (the chat shows Stop meanwhile).
 */
export function createChatOrb({ host, list, slot, input, send, speed = 1, minThinkMs = 1500, onBusy }) {
  const root = host.querySelector('.mo-root');
  const mover = root.querySelector('.mo-mover');
  const actor = root.querySelector('.mo-actor');
  const form = root.querySelector('.mo-input');
  const canvas = root.querySelector('.mo-orb');
  const pulse = root.querySelector('.mo-pulse');
  const status = root.querySelector('.mo-status');
  const live = root.querySelector('.mo-live');
  const ghosts = [...root.querySelectorAll('.mo-trail')];

  const life = new AbortController();
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = mq.matches;
  mq.addEventListener('change', (e) => { reduced = e.matches; }, { signal: life.signal });
  const isReduced = () => reduced;
  const getSpeed = () => Math.max(0.05, speed);

  const orb = createOrb(canvas, getSpeed, isReduced);
  const theme = () => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  let kind = 'answer';
  const applyPalette = () => orb.setPalette(PALETTES[theme() + (kind === 'error' ? 'Error' : '')]);
  applyPalette();
  const themeWatch = new MutationObserver(applyPalette);
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  /* ── geometry: points in the layer's own pixels ── */
  const geo = { pw: 0, ph: PILL_H, cw: 0, ch: 0, dir: -1, home: { x: 0, y: 0 }, stage: { x: 0, y: 0 }, target: { x: 0, y: 0 } };
  let spacer = null;
  let followStage = false;

  const rel = (el) => {
    const r = el.getBoundingClientRect(), o = root.getBoundingClientRect();
    return { x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height };
  };
  const measureHome = () => {
    const s = rel(slot);
    geo.pw = s.w;
    geo.ph = s.h;
    geo.home.x = s.x + s.w / 2;
    geo.home.y = s.y + s.h / 2;
  };
  const measureStage = () => {
    if (spacer?.isConnected) {
      const s = rel(spacer);
      geo.stage.x = s.x + s.w / 2;
      geo.stage.y = s.y + STAGE_CY;
    } else {
      const l = rel(list);
      geo.stage.x = l.x + l.w / 2;
      geo.stage.y = l.y + l.h / 2;
    }
    root.style.setProperty('--sx', `${fmt(geo.stage.x)}px`);
    root.style.setProperty('--sy', `${fmt(geo.stage.y)}px`);
  };
  /** Keep the orb and its label inside the conversation while they're there. */
  const clipToList = (on) => {
    if (!on) { root.style.clipPath = ''; return; }
    const l = rel(list), o = root.getBoundingClientRect();
    root.style.clipPath = `inset(${fmt(l.y)}px 0 ${fmt(o.height - l.y - l.h)}px 0)`;
  };

  /* ── state ── */
  const vals = {};
  const dirty = new Set();
  const CH = {};
  let msg = null;      // the answer message being unfolded
  let units = [];      // its words
  let curX = 0, curY = 0, curD = BALL_SMALL, trailVis = 0, ghostsShown = false;
  let wStagger = 45, wDur = 320;
  let busy = false;
  let phase = 'idle';
  const hist = [];
  const tmp = { t: 0, x: 0, y: 0, d: 0 };

  const setPhase = (p) => { phase = p; root.dataset.phase = p; };

  /* ── flight path + comet trail ── */
  const renderTrail = () => {
    if (trailVis <= 0.001) {
      if (ghostsShown) { ghosts.forEach((g) => (g.style.opacity = '0')); ghostsShown = false; }
      return;
    }
    ghostsShown = true;
    const now = performance.now();
    for (let i = 0; i < ghosts.length; i++) {
      sampleAt(hist, now - (i + 1) * 45, tmp);
      const k = (tmp.d * (1 - 0.08 * (i + 1))) / 100;
      const g = ghosts[i];
      g.style.transform = `translate3d(${(tmp.x - curX).toFixed(2)}px,${(tmp.y - curY).toFixed(2)}px,0) translate(-50%,-50%) scale(${k.toFixed(3)})`;
      g.style.opacity = (0.28 * Math.pow(1 - i / 6, 1.5) * trailVis).toFixed(3);
    }
  };

  // From the pill (home) along the original's arc to the orb's spot (stage),
  // then (m) to the answer's place in the conversation.
  const applyPath = () => {
    const u = vals.u ?? 0, m = vals.m ?? 0;
    const dx = geo.home.x - geo.stage.x, dy = geo.home.y - geo.stage.y;
    const sx = lerp(geo.stage.x, geo.target.x, m), sy = lerp(geo.stage.y, geo.target.y, m);
    curX = sx + bez(u, dx, geo.dir * 0.3 * dy, 0);
    curY = sy + bez(u, dy, 0.6 * dy, 0) + (vals.yOff ?? 0);
    mover.style.transform = `translate3d(${curX.toFixed(2)}px,${curY.toFixed(2)}px,0)`;
    const now = performance.now();
    hist.push({ t: now, x: curX, y: curY, d: curD });
    while (hist.length > 2 && hist[0].t < now - 500) hist.shift();
    renderTrail();
  };

  const applyWords = (v) => {
    if (!units.length) return;
    const total = (units.length - 1) * wStagger + wDur;
    const time = v * total;
    units.forEach((el, i) => {
      const p = E.out(clamp01((time - i * wStagger) / wDur));
      el.style.opacity = fmt(p);
      el.style.transform = p >= 0.999 || reduced ? 'none' : `translateY(${fmt((1 - p) * 4)}px)`;
      el.style.filter = p >= 0.999 || reduced ? 'none' : `blur(${fmt((1 - p) * 4)}px)`;
    });
  };

  /* ── channels ── */
  CHANNELS_ON_ACTOR.forEach((n) => { CH[n] = (v) => actor.style.setProperty('--' + n, fmt(v)); });
  CHANNELS_ON_MESSAGE.forEach((n) => { CH[n] = (v) => msg?.style.setProperty('--' + n, fmt(v)); });
  ['w', 'h', 'r'].forEach((n) => {
    CH[n] = (v) => {
      actor.style.setProperty('--' + n, fmt(v) + 'px');
      if (n === 'w') curD = v;
    };
  });
  CH.inScale = (v) => {
    actor.style.setProperty('--inScale', fmt(v));
    form.style.filter = v >= 0.999 ? 'none' : `blur(${fmt((1 - v) * 15)}px)`;
  };
  CH.sOp = (v) => status.style.setProperty('--sOp', fmt(v));
  CH.sTy = (v) => status.style.setProperty('--sTy', fmt(v));
  CH.cHalo = (v) => root.style.setProperty('--oCenter', fmt(v));
  CH.u = () => applyPath();
  CH.m = () => applyPath();
  CH.yOff = () => applyPath();
  CH.trail = (v) => { trailVis = v; renderTrail(); };
  CH.pulse = (v) => {
    if (v < 0) { pulse.style.opacity = '0'; return; }
    pulse.style.opacity = fmt(0.5 * (1 - v));
    pulse.style.transform = `translate(-50%,-50%) scale(${fmt(1 + v)})`;
  };
  CH.wp = applyWords;
  // The card has reached the message's box: the message shows instead.
  CH.dock = (v) => {
    if (v < 1 || !msg || !msg.classList.contains('mo-pending')) return;
    msg.classList.remove('mo-pending');
    vals.oCard = 0;
    actor.style.setProperty('--oCard', '0');
  };
  ORB_KEYS.forEach((name) => {
    CH['orb.' + name] = (v) => {
      orb.P[name] = v;
      if (name === 'alpha') orb.ensure();
    };
  });

  const set = (ch, v) => { vals[ch] = v; dirty.add(ch); };
  const flush = () => { dirty.forEach((ch) => CH[ch]?.(vals[ch])); dirty.clear(); };
  const setNow = (ch, v) => { vals[ch] = v; CH[ch]?.(v); };
  const resetChannels = () => {
    measureHome();
    setNow('w', geo.pw);
    setNow('h', geo.ph);
    for (const ch of Object.keys(INIT)) setNow(ch, INIT[ch]);
  };

  /* ── timeline engine ── */
  const play = (tracks, sig) =>
    new Promise((res) => {
      if (sig.aborted) return res();
      const end = tracks.reduce((m, k) => Math.max(m, k.t1), 0);
      const done = new Set();
      let raf = 0, t = 0, last = performance.now();
      const onAbort = () => { cancelAnimationFrame(raf); res(); };
      const finish = () => { sig.removeEventListener('abort', onAbort); res(); };
      const step = (now) => {
        const dt = Math.max(0, Math.min(100, now - last));
        last = now;
        t += dt * getSpeed();
        for (const k of tracks) {
          if (done.has(k) || t < k.t0) continue;
          const p = Math.min(1, (t - k.t0) / Math.max(1, k.t1 - k.t0));
          set(k.ch, k.from + (k.to - k.from) * (k.ease ?? E.io)(p));
          if (p === 1) done.add(k);
        }
        flush(); // one DOM write pass per frame
        if (t >= end) finish(); else raf = requestAnimationFrame(step);
      };
      sig.addEventListener('abort', onAbort, { once: true });
      raf = requestAnimationFrame(step);
    });

  /* ── label ── */
  let lbl = { cur: COPY.labels[0], n: 0 };
  const labelHtml = (name) => {
    const done = name === COPY.done || name === COPY.failed;
    const s = document.createElement('span');
    s.className = 'mo-lab mo-in';
    if (done) {
      const d = document.createElement('span');
      d.className = 'mo-lab-done';
      d.textContent = name;
      s.append(d);
    } else {
      const t = document.createElement('span');
      t.className = 'mo-lab-t';
      t.textContent = name;
      const dots = document.createElement('span');
      dots.className = 'mo-dots';
      dots.setAttribute('aria-hidden', 'true');
      dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
      s.append(t, dots);
    }
    return s;
  };
  const showLabel = (name, { reset = false } = {}) => {
    if (!reset && lbl.cur === name) return;
    lbl = { cur: name, n: lbl.n + 1 };
    for (const old of status.querySelectorAll('.mo-lab')) {
      if (old.classList.contains('mo-out') || reset) { old.remove(); continue; }
      old.classList.replace('mo-in', 'mo-out');
      old.addEventListener('animationend', () => old.remove(), { once: true });
    }
    status.append(labelHtml(name));
    if (!reset) say(name);
  };
  let lastSaid = '';
  const say = (text) => {
    if (text === lastSaid) return;
    lastSaid = text;
    live.textContent = text;
  };

  // Steps can come faster than a label can be read: show each for at least 600 ms.
  let pendingStep = null, stepTimer = 0, lastSwap = 0;
  const showStep = (step) => {
    if (phase !== 'think' && phase !== 'assemble' && phase !== 'launch') return;
    pendingStep = step;
    const wait = 600 - (performance.now() - lastSwap);
    if (wait > 0) {
      if (!stepTimer) stepTimer = window.setTimeout(() => { stepTimer = 0; showStep(pendingStep); }, wait);
      return;
    }
    const [label, prog] = stepLabel(step);
    orb.P.prog = prog;
    lastSwap = performance.now();
    showLabel(label);
  };

  /* ── the conversation side ── */
  const placeSpacer = () => {
    spacer = document.createElement('div');
    spacer.className = 'mo-stage-slot';
    spacer.setAttribute('aria-hidden', 'true');
    list.append(spacer);
    list.scrollTop = list.scrollHeight;
  };

  /**
   * Put the message where the orb's room was, hidden, and work out the box
   * the card unfolds into. A tall answer shows from its top.
   */
  const placeMessage = (el) => {
    el.classList.add('mo-pending');
    if (spacer?.isConnected) spacer.replaceWith(el); else list.append(el);
    spacer = null;
    const body = el.querySelector('.mo-a-body') || el;
    units = wrapWords(body);
    const lr = list.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    if (er.height > lr.height - 24) list.scrollTop += er.top - lr.top - 12;
    else list.scrollTop = list.scrollHeight;
    const r = rel(el);
    geo.cw = r.w;
    geo.ch = r.h;
    geo.target.x = r.x + r.w / 2;
    geo.target.y = r.y + r.h / 2;
  };

  // The question stays in the pill while it blurs away, as in the original.
  const clearInput = () => { input.value = ''; ready(); };

  /** The pill comes back to the composer. */
  const pillBack = async (sig) => {
    clipToList(false);
    setNow('pulse', -1);
    orb.reset();
    hist.length = 0;
    refit();
    const pillCh = ['oPill', 'oInput', 'oGlow', 'oAur', 'oRing'];
    pillCh.forEach((ch) => setNow(ch, 0));
    setNow('yOff', 8);
    setPhase('reset');
    const inn = pillCh.map((ch) => T(ch, 0, 1, 0, reduced ? 200 : 420, E.out));
    if (!reduced) inn.push(T('yOff', 8, 0, 0, 420, E.out));
    await play(inn, sig);
    resetChannels();
  };

  const idle = () => {
    const was = busy;
    busy = false;
    activeJob = null;
    msg = null;
    units = [];
    kind = 'answer';
    root.dataset.kind = 'answer';
    applyPalette();
    form.removeAttribute('inert');
    setPhase('idle');
    input.focus({ preventScroll: true });
    if (was) onBusy?.(false);
  };

  /** The whole exchange, from the pill to the answer and back. */
  const run = async (job, sig) => {
    const go = async (tracks) => {
      await play(tracks, sig);
      if (sig.aborted) throw ABORT;
    };
    let result = null;
    try {
      placeSpacer();
      measureStage();
      followStage = true;
      setPhase('launch');
      hist.length = 0;
      showLabel(COPY.labels[0], { reset: true });
      if (!reduced) {
        await go(launchTracks(geo));
        clearInput();
        setNow('r', ORB_D / 2);
        clipToList(true);
        setPhase('assemble');
        await go(ASSEMBLE);
      } else {
        await go(R_OUT);
        clearInput();
        setNow('u', 1); setNow('w', ORB_D); setNow('h', ORB_D); setNow('r', ORB_D / 2);
        setNow('sTy', 0); setNow('orb.k', 1); setNow('orb.spin', 0);
        clipToList(true);
        setPhase('assemble');
        await go(R_IN);
      }
      setPhase('think');
      say(lbl.cur);
      if (pendingStep) showStep(pendingStep);
      const t0 = performance.now();
      result = await work;
      if (sig.aborted) throw ABORT;
      await sleep(minThinkMs / getSpeed() - (performance.now() - t0), sig);
      if (sig.aborted) throw ABORT;
      window.clearTimeout(stepTimer);
      stepTimer = 0;
      pendingStep = null;

      kind = result.ok ? 'answer' : 'error';
      root.dataset.kind = kind;
      applyPalette();
      setPhase('resolve');
      showLabel(result.ok ? COPY.done : COPY.failed);
      await go(reduced ? R_RESOLVE : RESOLVE);
      if (reduced) await sleep(350 / getSpeed(), sig);

      setPhase('condense');
      if (reduced) { setNow('gs', 1); await go(R_CONDENSE); } else await go(CONDENSE);

      setPhase('unfold');
      followStage = false;
      msg = job.render(result);
      msg.dataset.kind = kind;
      CHANNELS_ON_MESSAGE.forEach((ch) => setNow(ch, ch === 'bloom' ? 1 : 0));
      placeMessage(msg);
      applyWords(0);
      const n = Math.max(1, units.length);
      if (!reduced) {
        wDur = 320;
        wStagger = n > 1 ? Math.min(45, 900 / (n - 1)) : 0;
        await go(unfoldTracks(geo, (n - 1) * wStagger + wDur));
      } else {
        wDur = 250;
        wStagger = 0;
        await go(R_GREEN_OUT);
        setNow('m', 1); setNow('dock', 1); setNow('dotS', 1);
        await go(rCardIn(wDur));
      }
      setPhase('answered');
      say(result.ok ? 'Answer ready' : 'The assistant couldn’t finish');
      finishMessage();
      await pillBack(sig);
      idle();
      job.after?.(result);
    } catch (e) {
      if (e !== ABORT) console.error('[MorphOrb]', e);
      // Stopped: stop() already finished this exchange, and a late result is dropped.
      if (activeJob !== job) return;
      hard(job, result);
    }
  };

  // Words back to the formatted answer, so it reads and selects like any message.
  let messageHtml = '';
  const finishMessage = () => {
    if (!msg) return;
    msg.classList.remove('mo-pending');
    for (const ch of CHANNELS_ON_MESSAGE) msg.style.removeProperty('--' + ch);
    const body = msg.querySelector('.mo-a-body');
    if (body && messageHtml) body.innerHTML = messageHtml;
  };

  let work = null;
  let current = null;
  let activeJob = null;

  /** Skip to the end: the answer (if any) in the conversation, the pill in place. */
  function hard(job, result) {
    current?.abort();
    current = null;
    window.clearTimeout(stepTimer);
    stepTimer = 0;
    pendingStep = null;
    spacer?.remove();
    spacer = null;
    orb.reset();
    hist.length = 0;
    clipToList(false);
    if (result && job && !msg) {
      msg = job.render(result);
      msg.dataset.kind = result.stopped ? 'stopped' : result.ok ? 'answer' : 'error';
      list.append(msg);
      messageHtml = msg.querySelector('.mo-a-body')?.innerHTML || '';
    }
    finishMessage();
    clearInput();
    refit();
    setNow('pulse', -1);
    idle();
    if (result && job) job.after?.(result);
  }

  /* ── keep the layout in step ── */
  const onScroll = () => { if (followStage) { measureStage(); applyPath(); } };
  list.addEventListener('scroll', onScroll, { passive: true, signal: life.signal });
  const resize = new ResizeObserver(() => {
    if (phase === 'idle') { resetChannels(); return; }
    if (followStage) { measureStage(); applyPath(); clipToList(phase !== 'launch'); }
  });
  resize.observe(host);
  resize.observe(slot);

  /* ── the pill ── */
  const ready = () => send.toggleAttribute('data-ready', input.value.trim().length > 0);
  const fit = () => {
    const lineH = parseFloat(getComputedStyle(input).lineHeight) || 20;
    let h = lineH;
    if (input.value) {
      input.style.height = 'auto';
      h = Math.min(input.scrollHeight, lineH * 6);
    }
    input.style.height = `${h}px`;
    const pill = Math.max(PILL_H, Math.round(h + 40));
    if (Math.abs(slot.offsetHeight - pill) > 0.5) slot.style.height = `${pill}px`;
  };
  // The field measures its lines at the pill's width, so the pill goes back to it first.
  const refit = () => {
    resetChannels();
    fit();
    resetChannels();
  };
  const timers = {};
  input.addEventListener('input', () => {
    ready();
    fit();
    actor.setAttribute('data-typing', '');
    window.clearTimeout(timers.typing);
    timers.typing = window.setTimeout(() => actor.removeAttribute('data-typing'), 300);
  }, { signal: life.signal });
  input.setAttribute('placeholder', COPY.placeholder);
  // The field is one line in a 60 px pill: a click anywhere on the pill types into it.
  form.addEventListener('pointerdown', (e) => {
    if (busy || e.button !== 0 || e.target === input || send.contains(e.target)) return;
    e.preventDefault();
    input.focus({ preventScroll: true });
  }, { signal: life.signal });

  resetChannels();
  ready();
  setPhase('idle');

  return {
    /**
     * Run one exchange. `work(step)` asks the agent and reports its steps;
     * `render(result)` builds the answer message (an element with .mo-a-body);
     * `after(result)` runs once the pill is back.
     * @param {{ work: (step: Function) => Promise<{ ok: boolean, content: string }>,
     *   render: (result: object) => HTMLElement, after?: (result: object) => void }} job
     * @returns {boolean} false while an exchange is running
     */
    run(job) {
      if (busy) return false;
      busy = true;
      geo.dir = -geo.dir;
      orb.reset();
      measureHome(); // the pill as it is now, however many lines it holds
      setNow('u', 0);
      setNow('m', 0);
      form.setAttribute('inert', '');
      const ac = new AbortController();
      life.signal.addEventListener('abort', () => ac.abort(), { once: true });
      current = ac;
      messageHtml = '';
      work = Promise.resolve()
        .then(() => job.work(showStep))
        .then((r) => ({ ...r, ok: r?.ok !== false, content: String(r?.content ?? '') }),
          (err) => ({ ok: false, content: `Error: ${err?.message || err}` }));
      const render = job.render;
      job = {
        ...job,
        render: (r) => {
          const el = render(r);
          messageHtml = el.querySelector('.mo-a-body')?.innerHTML || '';
          return el;
        },
      };
      activeJob = job;
      onBusy?.(true);
      // A hidden panel can't animate: answer straight into the conversation.
      if (host.getBoundingClientRect().width < 160) {
        work.then((r) => { if (activeJob === job) hard(job, r); });
        return true;
      }
      void run(job, ac.signal);
      return true;
    },
    busy: () => busy,
    /**
     * Stop the exchange in progress: `result` (e.g. { ok: false, stopped: true,
     * content }) goes into the conversation now, the pill comes back, and the
     * work's own result, whenever it arrives, is dropped.
     * @returns {boolean} false when nothing was running
     */
    stop(result) {
      // Once the answer is in, it finishes unfolding: there's nothing left to stop.
      if (!busy || !activeJob || !['launch', 'assemble', 'think'].includes(phase)) return false;
      const job = activeJob;
      activeJob = null;
      hard(job, result);
      return true;
    },
    /** The original's nudge for an empty question. */
    shake() {
      actor.removeAttribute('data-shake');
      void actor.offsetWidth;
      actor.setAttribute('data-shake', '');
      actor.setAttribute('data-flash', '');
      window.clearTimeout(timers.shake);
      window.clearTimeout(timers.flash);
      timers.shake = window.setTimeout(() => actor.removeAttribute('data-shake'), 260);
      timers.flash = window.setTimeout(() => actor.removeAttribute('data-flash'), 200);
    },
    /** Re-measure after the panel opens or the composer changes. */
    refresh() { if (phase === 'idle') refit(); },
    get phase() { return phase; },
    destroy() {
      life.abort();
      themeWatch.disconnect();
      resize.disconnect();
      orb.destroy();
    },
  };
}
