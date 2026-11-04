// Input parts: joystick, rotary encoder, keypad, IR remote + receiver,
// rotary dialer, tilt switch.

import { Behavior, playWaveform } from './behavior.js';
import { necFrame, necRepeat } from '../devices/nec.js';

export class JoystickBehavior extends Behavior {
  start() {
    this._input = () => { this.apply(); this.ctx.changed(); };
    this._press = () => { this.pressed = true; this.apply(); this.ctx.changed(); };
    this._release = () => { this.pressed = false; this.apply(); this.ctx.changed(); };
    this.el.addEventListener('input', this._input);
    this.el.addEventListener('button-press', this._press);
    this.el.addEventListener('button-release', this._release);
    this.pressed = false;
    this.apply();
  }

  // Up raises VERT, left raises HORZ (512 at rest), like the KY-023 module.
  apply() {
    const x = Number(this.el.xValue) || 0;
    const y = Number(this.el.yValue) || 0;
    this.ctx.driveVolts('VERT', 2.5 * (1 + y), 100);
    this.ctx.driveVolts('HORZ', 2.5 * (1 + x), 100);
    this.ctx.drive('SEL', this.pressed ? 0 : null);
  }

  control(key, value) {
    if (key === 'x') this.el.xValue = Number(value);
    if (key === 'y') this.el.yValue = Number(value);
    this.apply();
  }

  stop() {
    this.el.removeEventListener('input', this._input);
    this.el.removeEventListener('button-press', this._press);
    this.el.removeEventListener('button-release', this._release);
    this.el.xValue = 0;
    this.el.yValue = 0;
  }

  status() {
    const v = (pin) => Math.round(((this.ctx.volts(pin) ?? 2.5) / 5) * 1023);
    return `VERT ≈ ${v('VERT')} · HORZ ≈ ${v('HORZ')}${this.pressed ? ' · pressed' : ''}`;
  }
}

const ENCODER_PHASE_S = 0.001;

export class RotaryEncoderBehavior extends Behavior {
  start() {
    this.position = 0;
    this.queue = [];
    this.busy = false;
    this._cw = () => this.turn(1);
    this._ccw = () => this.turn(-1);
    this._press = () => { this.ctx.drive('SW', 0); this.pressed = true; this.ctx.changed(); };
    this._release = () => { this.ctx.drive('SW', null); this.pressed = false; this.ctx.changed(); };
    this.el.addEventListener('rotate-cw', this._cw);
    this.el.addEventListener('rotate-ccw', this._ccw);
    this.el.addEventListener('button-press', this._press);
    this.el.addEventListener('button-release', this._release);
  }

  pullups() {
    return [['CLK', 10000], ['DT', 10000], ['SW', 10000]];
  }

  turn(dir) {
    this.position += dir;
    this.queue.push(dir);
    this.ctx.changed();
    if (!this.busy) this._next();
  }

  // One detent = one full quadrature cycle. Clockwise: CLK falls while DT is HIGH.
  _next() {
    const dir = this.queue.shift();
    if (dir === undefined) { this.busy = false; return; }
    this.busy = true;
    const [first, second] = dir > 0 ? ['CLK', 'DT'] : ['DT', 'CLK'];
    const steps = [[first, 0], [second, 0], [first, null], [second, null]];
    let i = 0;
    const run = () => {
      if (i >= steps.length) { this._next(); return; }
      const [pin, level] = steps[i++];
      this.ctx.drive(pin, level);
      this.ctx.schedule(ENCODER_PHASE_S, run);
    };
    run();
  }

  control(key) {
    if (key === 'cw') { this.el.angle = (this.el.angle + 18) % 360; this.turn(1); }
    if (key === 'ccw') { this.el.angle = (this.el.angle + 342) % 360; this.turn(-1); }
  }

  stop() {
    this.el.removeEventListener('rotate-cw', this._cw);
    this.el.removeEventListener('rotate-ccw', this._ccw);
    this.el.removeEventListener('button-press', this._press);
    this.el.removeEventListener('button-release', this._release);
  }

  status() {
    return `Turned ${this.position >= 0 ? '+' : ''}${this.position} detents${this.pressed ? ' · pressed' : ''}`;
  }
}

export class KeypadBehavior extends Behavior {
  start() {
    this.pressed = new Map(); // key → [row, col]
    this._press = (e) => {
      const { key, row, column } = e.detail || {};
      this.pressed.set(key, [row, column]);
      this.ctx.invalidate();
      this.ctx.changed();
    };
    this._release = (e) => {
      this.pressed.delete(e.detail?.key);
      this.ctx.invalidate();
      this.ctx.changed();
    };
    this.el.addEventListener('button-press', this._press);
    this.el.addEventListener('button-release', this._release);
  }

  // A pressed key shorts its row line to its column line.
  links() {
    return [...(this.pressed?.values() || [])].map(([r, c]) => [`R${r + 1}`, `C${c + 1}`]);
  }

  stop() {
    this.el.removeEventListener('button-press', this._press);
    this.el.removeEventListener('button-release', this._release);
  }

  status() {
    return this.pressed?.size ? `Holding ${[...this.pressed.keys()].join(' ')}` : 'Click keys or type on the keyboard';
  }
}

/** IR receiver (VS1838B-style): DAT idles HIGH and pulses LOW for each IR burst. */
export class IrReceiverBehavior extends Behavior {
  start() {
    this.ctx.drive('DAT', 1);
    this.playing = null;
    this.last = null;
  }

  send(address, command, repeat = false) {
    this.playing?.cancel();
    this.last = { address, command, repeat };
    this.playing = playWaveform(this.ctx, 'DAT', repeat ? necRepeat() : necFrame(address, command), { idle: 1 });
    this.ctx.changed();
  }

  stop() {
    this.playing?.cancel();
  }

  status() {
    if (!this.last) return 'Idle · press a button on an IR remote';
    return `Last code 0x${this.last.command.toString(16).toUpperCase().padStart(2, '0')} (NEC, address 0x${this.last.address.toString(16).padStart(2, '0')})`;
  }
}

/** IR remote: broadcasts NEC codes to every IR receiver on the canvas. */
export class IrRemoteBehavior extends Behavior {
  start() {
    this._press = (e) => this.press(e.detail?.irCode);
    this._release = () => this.release();
    this.el.addEventListener('button-press', this._press);
    this.el.addEventListener('button-release', this._release);
  }

  receivers() {
    return this.ctx.engine.behaviorsOfType('wokwi-ir-receiver');
  }

  press(code) {
    if (code === undefined) return;
    this.code = code;
    const address = this.ctx.attr('address', 0);
    for (const rx of this.receivers()) rx.send(address, code);
    // Held buttons repeat every 108 ms.
    const repeat = () => {
      if (this.code === undefined) return;
      for (const rx of this.receivers()) rx.send(address, code, true);
      this.timer = this.ctx.schedule(0.108, repeat);
    };
    this.ctx.cancel(this.timer);
    this.timer = this.ctx.schedule(0.108, repeat);
  }

  release() {
    this.code = undefined;
    this.ctx.cancel(this.timer);
  }

  stop() {
    this.el.removeEventListener('button-press', this._press);
    this.el.removeEventListener('button-release', this._release);
  }
}

/** Rotary phone dialer: DIAL is grounded while dialing, PULSE opens n times. */
export class RotaryDialerBehavior extends Behavior {
  start() {
    this._start = () => this.ctx.drive('DIAL', 0);
    this._dial = (e) => this.pulse(e.detail?.digit);
    this.el.addEventListener('dial-start', this._start);
    this.el.addEventListener('dial', this._dial);
  }

  pulse(digit) {
    const n = digit === 0 ? 10 : digit;
    if (!n) { this.ctx.drive('DIAL', null); return; }
    const seg = [];
    for (let i = 0; i < n; i++) seg.push([0, 40000], [1, 60000]);
    this.last = digit;
    playWaveform(this.ctx, 'PULSE', seg, { openDrain: true, idle: null, onDone: () => { this.ctx.drive('DIAL', null); this.ctx.changed(); } });
  }

  stop() {
    this.el.removeEventListener('dial-start', this._start);
    this.el.removeEventListener('dial', this._dial);
  }

  status() {
    return this.last === undefined ? 'Drag a digit to the stop to dial' : `Last digit dialled: ${this.last}`;
  }
}

/** Tilt switch module: OUT goes HIGH while tilted. */
export class TiltBehavior extends Behavior {
  start() { this.apply(); }

  apply() {
    this.ctx.drive('OUT', this.ctx.attr('tilted', false) ? 1 : 0);
    this.ctx.changed();
  }

  press() {
    this.ctx.setAttr('tilted', !this.ctx.attr('tilted', false));
    this.apply();
  }

  control() { this.apply(); }

  status() {
    return this.ctx.attr('tilted', false) ? 'Tilted · OUT HIGH' : 'Upright · OUT LOW';
  }
}
