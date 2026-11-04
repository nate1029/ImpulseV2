// Buzzer audio: one square-wave voice per sounding buzzer, shared context,
// global mute remembered between sessions.

const MUTE_KEY = 'impulse-sim-muted';
let ctx = null;
let master = null;
// Through window: Node (headless runs, impulse-test) has a localStorage that warns when touched.
const storage = () => globalThis.window?.localStorage;
let muted = (() => {
  try { return storage()?.getItem(MUTE_KEY) === '1'; } catch { return false; }
})();
const listeners = new Set();

function context() {
  if (ctx) return ctx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.06;
  master.connect(ctx.destination);
  return ctx;
}

export function isMuted() {
  return muted;
}

export function setMuted(value) {
  muted = !!value;
  try { storage()?.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* storage unavailable */ }
  if (master) master.gain.setTargetAtTime(muted ? 0 : 0.06, ctx.currentTime, 0.01);
  listeners.forEach(fn => fn(muted));
}

export function onMuteChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export class ToneVoice {
  constructor() {
    this.osc = null;
    this.gain = null;
    this.freq = 0;
  }

  /** Play `hz` (0 = silence). */
  set(hz) {
    if (!hz || hz < 20 || hz > 20000) {
      this.silence();
      return;
    }
    const ac = context();
    if (!ac) return;
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    if (!this.osc) {
      this.osc = ac.createOscillator();
      this.osc.type = 'square';
      this.gain = ac.createGain();
      this.gain.gain.value = 0;
      this.osc.connect(this.gain);
      this.gain.connect(master);
      this.osc.start();
    }
    if (Math.abs(this.freq - hz) > 0.5) {
      this.osc.frequency.setTargetAtTime(hz, ac.currentTime, 0.002);
      this.freq = hz;
    }
    this.gain.gain.setTargetAtTime(1, ac.currentTime, 0.003);
  }

  silence() {
    if (this.gain && ctx) this.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.005);
    this.freq = 0;
  }

  dispose() {
    if (!this.osc) return;
    try {
      this.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.005);
      const osc = this.osc;
      setTimeout(() => { try { osc.stop(); osc.disconnect(); } catch { /* already stopped */ } }, 60);
    } catch { /* context closed */ }
    this.osc = null;
    this.gain = null;
  }
}
