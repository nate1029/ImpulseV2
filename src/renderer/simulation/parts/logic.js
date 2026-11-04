// Logic gates and a D flip-flop. Outputs follow their inputs a couple of CPU
// cycles later, whatever drives the inputs: the Arduino, another gate, a
// switch. Floating inputs read LOW (the circuit check points them out).

import { Behavior } from './behavior.js';

const DELAY = 1e-7; // propagation delay, about two CPU cycles

class LogicBehavior extends Behavior {
  /** Output pin → level for the current inputs. */
  evaluate() { return {}; }

  show() {}

  start() {
    this.outputs = {};
    this._pending = null;
    this.apply();
  }

  stop() {
    this.el.value = null;
  }

  input(pin) {
    return this.ctx.level(pin) === 1 ? 1 : 0;
  }

  apply() {
    this._pending = null;
    for (const [pin, level] of Object.entries(this.evaluate())) {
      if (this.outputs[pin] === level) continue;
      this.outputs[pin] = level;
      this.ctx.drive(pin, level);
    }
    this.show();
  }

  later() {
    if (!this._pending) this._pending = this.ctx.schedule(DELAY, () => this.apply());
  }
}

class GateBehavior extends LogicBehavior {
  logic() { return 0; }

  evaluate() {
    return { Y: this.logic(this.input('A'), this.input('B')) ? 1 : 0 };
  }

  show() {
    this.el.value = !!this.outputs.Y;
  }

  onNet(pin) {
    if (pin !== 'Y') this.later();
  }

  status() {
    return `Y = ${this.outputs?.Y ? 'HIGH' : 'LOW'}`;
  }
}

export class AndGateBehavior extends GateBehavior { logic(a, b) { return a && b; } }
export class NandGateBehavior extends GateBehavior { logic(a, b) { return !(a && b); } }
export class OrGateBehavior extends GateBehavior { logic(a, b) { return a || b; } }
export class NorGateBehavior extends GateBehavior { logic(a, b) { return !(a || b); } }
export class XorGateBehavior extends GateBehavior { logic(a, b) { return a !== b; } }
export class NotGateBehavior extends GateBehavior { logic(a) { return !a; } }

/** Positive-edge D flip-flop: Q takes D's level on each rising CLK edge. */
export class FlipFlopDBehavior extends LogicBehavior {
  start() {
    this.q = 0;
    this.clk = this.ctx.level('CLK') === 1;
    super.start();
  }

  evaluate() {
    return { Q: this.q, QN: this.q ? 0 : 1 };
  }

  show() {
    this.el.value = !!this.q;
  }

  onNet(pin, level) {
    if (pin !== 'CLK') return;
    const rising = level === 1 && !this.clk;
    this.clk = level === 1;
    if (!rising) return;
    // Sample D at the edge; the outputs change after the propagation delay.
    this.q = this.input('D');
    this.later();
  }

  status() {
    return `Q = ${this.q ? 'HIGH' : 'LOW'}`;
  }
}
