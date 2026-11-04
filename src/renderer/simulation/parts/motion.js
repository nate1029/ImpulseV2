// Motion and switching: servo, steppers (bipolar, 28BYJ-48), stepper driver,
// relay, DC motor, H-bridges (L293D, L298N), 74HC595 shift register.

import { Behavior, clamp } from './behavior.js';
import { HC595 } from '../devices/shift.js';

/** Hobby servo: 544-2400 µs pulses map to 0-180° (Arduino Servo defaults). */
export class ServoBehavior extends Behavior {
  start() {
    this._rise = -1;
    this.pulseUs = 0;
  }

  onPin(pin, high, cycles) {
    if (pin !== 'PWM') return;
    const t = this.ctx.now();
    if (this.ctx.level('PWM') === 1) {
      this._rise = t;
      return;
    }
    if (this._rise < 0) return;
    const us = (t - this._rise) * 1e6;
    this._rise = -1;
    void high; void cycles;
    if (us < 400 || us > 2700) return;
    this.pulseUs = us;
    const min = this.ctx.attr('minPulse', 544);
    const max = this.ctx.attr('maxPulse', 2400);
    this.el.angle = clamp(((us - min) / (max - min)) * 180, 0, 180);
  }

  stop() {
    this.el.angle = 0;
  }

  status() {
    return this.pulseUs ? `${Math.round(this.el.angle)}° · ${Math.round(this.pulseUs)} µs pulses` : 'Waiting for servo pulses';
  }
}

/** Electrical angle (multiples of 45°) from two coil currents, or null when off. */
function phaseAngle(ia, ib) {
  if (!ia && !ib) return null;
  return Math.round(Math.atan2(ib, ia) / (Math.PI / 4)) * 45;
}

/**
 * Bipolar stepper wired coil by coil (Stepper library, H-bridge outputs).
 * Coil states are counted once they hold for 20 µs, so the brief in-between
 * states while a sketch updates four pins one by one don't move the rotor,
 * just as its inertia ignores them on real hardware.
 */
export class StepperBehavior extends Behavior {
  start() {
    this.steps = 0;
    this.lastPhase = 45; // rotor resting at the A+B+ detent, step 0 of the Stepper sequence
    this.angle = 0;
    this.stepDeg = 360 / this.ctx.attr('stepsPerRev', 200);
    this.pending = null;
  }

  coil(plus, minus) {
    const p = this.ctx.level(plus) === 1 ? 1 : 0;
    const m = this.ctx.level(minus) === 1 ? 1 : 0;
    return p - m;
  }

  onPin() {
    this.ctx.cancel(this.pending);
    this.pending = this.ctx.schedule(20e-6, () => this.settle());
  }

  settle() {
    this.pending = null;
    const phase = phaseAngle(this.coil('A+', 'A-'), this.coil('B+', 'B-'));
    if (phase === null || phase === this.lastPhase) return;
    let delta = phase - this.lastPhase;
    if (delta > 180) delta -= 360;
    if (delta <= -180) delta += 360;
    this.lastPhase = phase;
    this.advance(delta / 90);
  }

  /** Move by a number of full steps (also used by stepper drivers). */
  advance(fullSteps) {
    this.steps += fullSteps;
    this.angle = (((this.angle + fullSteps * this.stepDeg) % 360) + 360) % 360;
    this.el.angle = this.angle;
    this.ctx.changed();
  }

  stop() {
    this.el.angle = 0;
  }

  status() {
    return `${this.steps >= 0 ? '+' : ''}${this.steps} steps · ${Math.round(this.angle)}°`;
  }
}

export class BiaxialStepperBehavior extends Behavior {
  start() {
    this.motors = [
      { a: ['A1+', 'A1-'], b: ['B1+', 'B1-'], last: null, angle: 0, prop: 'outerHandAngle' },
      { a: ['A2+', 'A2-'], b: ['B2+', 'B2-'], last: null, angle: 0, prop: 'innerHandAngle' },
    ];
  }

  onPin() {
    const lv = (p) => (this.ctx.level(p) === 1 ? 1 : 0);
    for (const m of this.motors) {
      const phase = phaseAngle(lv(m.a[0]) - lv(m.a[1]), lv(m.b[0]) - lv(m.b[1]));
      if (phase === null) continue;
      if (m.last !== null && phase !== m.last) {
        let d = phase - m.last;
        if (d > 180) d -= 360;
        if (d <= -180) d += 360;
        m.angle = (m.angle + (d / 90) * 1.8 + 360) % 360;
        this.el[m.prop] = m.angle;
      }
      m.last = phase;
    }
  }

  stop() {
    this.el.outerHandAngle = 0;
    this.el.innerHandAngle = 0;
  }
}

/** A4988 / DRV8825 stepper driver: STEP pulses move the attached motor. */
export class StepperDriverBehavior extends Behavior {
  start() {
    this.position = 0;
    this._step = false;
  }

  microsteps() {
    const ms = (p) => (this.ctx.level(p) === 1 ? 1 : 0);
    return [1, 2, 4, 8, 16, 16, 16, 16][ms('MS1') | (ms('MS2') << 1) | (ms('MS3') << 2)] || 1;
  }

  onPin(pin) {
    if (pin !== 'STEP') return;
    const step = this.ctx.level('STEP') === 1;
    if (step && !this._step) {
      // Disabled when ENABLE is HIGH or SLEEP/RESET are LOW.
      const enabled = this.ctx.level('ENABLE') !== 1 && this.ctx.level('SLEEP') !== 0 && this.ctx.level('RESET') !== 0;
      if (enabled) {
        const dir = this.ctx.level('DIR') === 1 ? 1 : -1;
        this.position += dir / this.microsteps();
        for (const motor of this.motors()) motor.advance?.(dir / this.microsteps());
      }
    }
    this._step = step;
  }

  /** Motors whose coils are wired to this driver's outputs. */
  motors() {
    const out = [];
    for (const pin of ['1A', '1B', '2A', '2B']) {
      for (const b of this.ctx.engine.behaviorsOnNet(this.ctx.net(pin), null, this.ctx.id)) {
        if (b.advance && !out.includes(b)) out.push(b);
      }
    }
    return out;
  }

  status() {
    return `Position ${this.position.toFixed(this.microsteps() > 1 ? 2 : 0)} steps · 1/${this.microsteps()} stepping`;
  }
}

/** Relay: the coil switches P1/P2 from NC to NO contacts. */
export class RelayBehavior extends Behavior {
  start() {
    this.on = false;
  }

  links() {
    return this.on ? [['P1', 'NO1'], ['P2', 'NO2']] : [['P1', 'NC1'], ['P2', 'NC2']];
  }

  energized() {
    const a = this.ctx.fraction('COIL1');
    const b = this.ctx.fraction('COIL2');
    if (a === null || b === null) return false;
    return Math.abs(a - b) > 0.5;
  }

  update() {
    const on = this.energized();
    if (on === this.on) return;
    this.on = on;
    this.ctx.invalidate();
    this.ctx.changed();
  }

  onPin() { this.update(); }
  frame() { this.update(); }

  status() {
    return this.on ? 'Energized · P↔NO closed' : 'Released · P↔NC closed';
  }
}

/** Relay module (signal input, on-board transistor and LED). */
export class RelayModuleBehavior extends Behavior {
  start() {
    this.on = false;
  }

  links() {
    return this.on ? [['COM', 'NO']] : [['COM', 'NC']];
  }

  update() {
    const level = this.ctx.level('IN');
    const lowTrigger = this.ctx.attr('trigger', 'high') === 'low';
    const on = level === null ? false : lowTrigger ? level === 0 : level === 1;
    if (on === this.on) return;
    this.on = on;
    this.el.active = on;
    this.ctx.invalidate();
    this.ctx.changed();
  }

  onPin() { this.update(); }
  frame() { this.update(); }

  stop() {
    this.el.active = false;
  }

  status() {
    return this.on ? 'Energized · COM↔NO' : 'Released · COM↔NC';
  }
}

/** DC motor: speed follows the voltage across its terminals. */
export class DcMotorBehavior extends Behavior {
  start() {
    this.angle = 0;
    this.rpm = 0;
  }

  frame(dt) {
    // Average voltage across the terminals: PWM pins report their duty,
    // H-bridge outputs report their averaged voltage.
    const side = (pin) => {
      const p = this.ctx.mcuPin(pin);
      if (p !== null && this.ctx.runner.isOutput(p)) return this.ctx.fraction(pin) ?? 0;
      return (this.ctx.volts(pin) ?? 0) / 5;
    };
    const drive = clamp(side('A') - side('B'), -1, 1);
    const target = drive * this.ctx.attr('maxRpm', 200);
    this.rpm += (target - this.rpm) * Math.min(1, (dt || 0.03) * 6); // spin-up inertia
    if (Math.abs(this.rpm) < 0.5) this.rpm = 0;
    this.angle = (this.angle + this.rpm * 6 * (dt || 0)) % 360;
    this.el.angle = this.angle;
    this.el.speed = this.rpm;
  }

  stop() {
    this.el.speed = 0;
  }

  status() {
    return this.rpm ? `${Math.round(Math.abs(this.rpm))} RPM ${this.rpm > 0 ? 'clockwise' : 'counter-clockwise'}` : 'Stopped';
  }
}

/** L293D / L298N style dual H-bridge: each output follows its input when enabled. */
export class HBridgeBehavior extends Behavior {
  /** [[enable, in, out], ...] — override per chip */
  get channels() {
    return [['EN1', 'IN1', 'OUT1'], ['EN1', 'IN2', 'OUT2'], ['EN2', 'IN3', 'OUT3'], ['EN2', 'IN4', 'OUT4']];
  }

  update() {
    for (const [en, input, out] of this.channels) {
      const enabled = this.ctx.connected(en) ? (this.ctx.fraction(en) ?? 0) : 1;
      const level = this.ctx.fraction(input);
      if (level === null || enabled < 0.01) { this.ctx.drive(out, null); continue; }
      // PWM on EN scales the output; outputs are driven like push-pull pins.
      this.ctx.driveVolts(out, 5 * level * Math.min(1, enabled));
    }
  }

  start() { this.update(); }
  onPin() { this.update(); }
  frame() { this.update(); }
}

/** L298N module: same logic as the L293D; the ENA/ENB jumpers enable full speed. */
export class L298nBehavior extends HBridgeBehavior {
  get channels() {
    return [['ENA', 'IN1', 'OUT1'], ['ENA', 'IN2', 'OUT2'], ['ENB', 'IN3', 'OUT3'], ['ENB', 'IN4', 'OUT4']];
  }
}

const STEPS_28BYJ = 2048; // full steps per output turn (32 steps × 64:1 gearbox)

/**
 * 28BYJ-48 unipolar stepper on a ULN2003 board. IN1-IN4 energize coils A-D,
 * a quarter turn of the magnetic field apart; the rotor follows the field
 * (full steps, half steps and wave drive all work).
 */
export class Stepper28byjBehavior extends Behavior {
  start() {
    this.steps = 0;
    this.field = 45; // rotor resting at the IN1+IN2 detent, step 0 of the Stepper sequence
    this.pending = null;
    this.rate = 0;
    this._window = { at: this.ctx.now(), steps: 0 };
    this.update();
  }

  stop() {
    this.el.angle = 0;
    this.el.coils = [0, 0, 0, 0];
  }

  // Wait for the sketch to finish writing all four pins before moving.
  onNet(pin) {
    if (!pin.startsWith('IN')) return;
    this.ctx.cancel(this.pending);
    this.pending = this.ctx.schedule(20e-6, () => { this.pending = null; this.update(); });
  }

  update() {
    const coils = ['IN1', 'IN2', 'IN3', 'IN4'].map(p => (this.ctx.level(p) === 1 ? 1 : 0));
    this.el.coils = coils;
    let x = 0;
    let y = 0;
    coils.forEach((on, i) => { if (on) { x += Math.cos((i * Math.PI) / 2); y += Math.sin((i * Math.PI) / 2); } });
    if (Math.hypot(x, y) < 0.5) return; // no net field: the rotor stays put
    const field = (Math.atan2(y, x) * 180) / Math.PI;
    let delta = field - this.field;
    if (delta > 180) delta -= 360;
    if (delta <= -180) delta += 360;
    if (Math.abs(delta) > 135) return; // too big a jump for the rotor to follow
    this.field = field;
    if (!delta) return;
    this.steps += delta / 90;
    this.el.angle = (this.steps * 360) / STEPS_28BYJ;
    this.ctx.changed();
  }

  frame() {
    const now = this.ctx.now();
    const dt = now - this._window.at;
    if (dt < 0.25) return;
    this.rate = (this.steps - this._window.steps) / dt;
    this._window = { at: now, steps: this.steps };
  }

  status() {
    const rpm = Math.abs((this.rate * 60) / STEPS_28BYJ);
    const turns = this.steps / STEPS_28BYJ;
    const fast = rpm > 17 ? ' · faster than a real 28BYJ-48 can turn (~15 RPM)' : '';
    return `${Math.round(this.steps)} steps · ${(turns * 360).toFixed(1)}° · ${rpm.toFixed(1)} RPM${fast}`;
  }
}

/** 74HC595 shift register; Q7S feeds the next chip in a chain. */
export class ShiftRegisterBehavior extends Behavior {
  start() {
    this.reg = new HC595();
    this._sh = this.ctx.level('SHCP') === 1;
    this._st = this.ctx.level('STCP') === 1;
    this.pending = null;
    this.outputs();
    this.ctx.drive('Q7S', 0);
    this.ctx.spi({
      selected: () => this.ctx.onSpiPin('SHCP', 'sck') && this.ctx.onSpiPin('DS', 'mosi'),
      transfer: (byte) => { this.spiIn(byte); return 0xff; },
    });
  }

  // Hardware SPI: a whole byte shifts in and the old contents move down the chain.
  spiIn(byte) {
    const out = this.reg.shift;
    this.reg.byte(byte);
    for (const next of this.ctx.engine.behaviorsOnNet(this.ctx.net('Q7S'), 'DS', this.ctx.id)) next.spiIn?.(out);
  }

  outputs() {
    const enabled = this.ctx.level('OE') !== 1;
    for (let i = 0; i < 8; i++) this.ctx.drive(`Q${i}`, enabled ? (this.reg.latched >> i) & 1 : null);
  }

  onPin(pin) {
    const ctx = this.ctx;
    if (pin === 'MR') {
      if (ctx.level('MR') === 0) this.reg.clear();
    } else if (pin === 'SHCP') {
      const sh = ctx.level('SHCP') === 1;
      if (sh && !this._sh && ctx.level('MR') !== 0) {
        this.reg.clock(ctx.level('DS') === 1);
        this.pending = this.reg.q7s;
      }
      this._sh = sh;
    } else if (pin === 'STCP') {
      const st = ctx.level('STCP') === 1;
      if (st && !this._st) {
        this.reg.latch();
        this.outputs();
        ctx.changed();
      }
      this._st = st;
    } else if (pin === 'OE') {
      this.outputs();
    }
  }

  // After every chip on the clock line has sampled DS, update Q7S.
  commit() {
    if (this.pending === null) return;
    this.ctx.drive('Q7S', this.pending);
    this.pending = null;
  }

  status() {
    const v = this.reg?.latched ?? 0;
    return `Outputs Q7…Q0 = ${v.toString(2).padStart(8, '0')}`;
  }
}
