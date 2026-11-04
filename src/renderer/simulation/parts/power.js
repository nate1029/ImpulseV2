// Battery, diode and N-channel MOSFET.

import { Behavior } from './behavior.js';

/**
 * A battery holds + at its voltage above −. The − terminal is a weak 0 V
 * reference, so a battery-only circuit still has a ground; wired to the
 * Arduino's GND it simply sits at 0 V. With − unconnected there is no loop,
 * so + stays off.
 */
export class BatteryBehavior extends Behavior {
  get volts() {
    return this.ctx.attr('voltage', 9);
  }

  start() {
    const { engine } = this.ctx;
    const closed = this.ctx.connected('-');
    engine.setDriver(this.ctx.node('-'), closed ? { volts: 0, ohms: 1e6 } : null);
    engine.setDriver(this.ctx.node('+'), closed ? { volts: this.volts, ohms: 0 } : null);
  }

  status() {
    return this.ctx.connected('-') ? `${this.volts} V` : 'Wire − to close the circuit';
  }
}

/** Reports the voltage across a capacitor; the engine does the charging. */
export class CapacitorBehavior extends Behavior {
  status() {
    const v = this.ctx.engine.capacitorVolts(this.ctx.id);
    if (v === null) return null;
    const reversed = this.ctx.attr('type', 'ceramic') === 'electrolytic' && v < -0.5;
    return `${v.toFixed(2)} V across it${reversed ? ' · reversed: a real electrolytic capacitor can fail like this' : ''}`;
  }
}

/** Conducts from A to C once forward-biased past 0.6 V; blocks the other way. */
export class DiodeBehavior extends Behavior {
  start() {
    this.on = false;
    this.update();
  }

  stop() {
    this.el.conducting = false;
  }

  resistors() {
    return this.on ? [['A', 'C', 1]] : null;
  }

  update() {
    const va = this.ctx.volts('A');
    // A floating cathode side sits at 0 V until something pulls it up.
    const vc = this.ctx.volts('C') ?? 0;
    const on = va !== null && (this.on ? va >= vc - 0.05 : va - vc > 0.6);
    if (on === this.on) return;
    this.on = on;
    this.el.conducting = on;
    this.ctx.invalidate();
    this.ctx.changed();
  }

  onPin() { this.update(); }
  frame() { this.update(); }

  status() {
    return this.on ? 'Conducting A → C' : 'Blocking';
  }
}

const GATE_THRESHOLD = { IRLZ44N: 2.0, IRF520: 4.0, IRF540N: 4.0 };

/** N-channel MOSFET: D↔S conduct while the gate is above the threshold. */
export class MosfetBehavior extends Behavior {
  start() {
    this.on = false;
    this.update();
  }

  stop() {
    this.el.on = false;
  }

  links() {
    return this.on ? [['D', 'S']] : null;
  }

  update() {
    const vg = this.ctx.volts('G');
    const vs = this.ctx.volts('S') ?? 0;
    const threshold = GATE_THRESHOLD[this.ctx.attr('label', 'IRLZ44N')] ?? 2.0;
    const on = vg !== null && vg - vs > threshold;
    if (on === this.on) return;
    this.on = on;
    this.el.on = on;
    this.ctx.invalidate();
    this.ctx.changed();
  }

  onPin() { this.update(); }
  frame() { this.update(); }

  status() {
    return this.on ? 'On · D↔S conducting' : 'Off';
  }
}
