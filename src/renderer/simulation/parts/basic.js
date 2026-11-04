// Basic parts: LEDs, buttons, switches, potentiometers, buzzer, board LEDs.

import { Behavior, clamp } from './behavior.js';
import { ToneVoice } from '../audio.js';

/** Fraction of time current flows from `hi` to `lo` (0..1). */
function forward(ctx, anode, cathode) {
  const a = ctx.fraction(anode);
  const c = ctx.fraction(cathode);
  if (a === null || c === null) return 0;
  return clamp(a * (1 - c), 0, 1);
}

export class LedBehavior extends Behavior {
  frame() {
    const b = forward(this.ctx, 'A', 'C');
    this.el.value = b > 0.004;
    this.el.brightness = b > 0.004 ? clamp(b, 0.08, 1) : 0;
    this._b = b;
  }

  stop() {
    this.el.value = false;
    this.el.brightness = 1;
  }

  status() {
    const b = this._b || 0;
    if (b <= 0.004) return 'Off';
    return b > 0.98 ? 'On' : `On · ${Math.round(b * 100)}% brightness (PWM)`;
  }
}

export class RgbLedBehavior extends Behavior {
  frame() {
    const ctx = this.ctx;
    const anode = ctx.attr('common', 'cathode') === 'anode';
    const ch = (pin) => (anode ? forward(ctx, 'COM', pin) : forward(ctx, pin, 'COM'));
    this.el.ledRed = ch('R');
    this.el.ledGreen = ch('G');
    this.el.ledBlue = ch('B');
  }

  stop() {
    this.el.ledRed = 0;
    this.el.ledGreen = 0;
    this.el.ledBlue = 0;
  }

  status() {
    const p = (v) => Math.round((v || 0) * 255);
    return `R ${p(this.el.ledRed)} · G ${p(this.el.ledGreen)} · B ${p(this.el.ledBlue)}`;
  }
}

export class BarGraphBehavior extends Behavior {
  frame() {
    const values = [];
    for (let i = 1; i <= 10; i++) values.push(forward(this.ctx, `A${i}`, `C${i}`) > 0.05 ? 1 : 0);
    if (values.join() !== (this.el.values || []).join()) this.el.values = values;
  }

  stop() {
    this.el.values = new Array(10).fill(0);
  }
}

export class BuzzerBehavior extends Behavior {
  start() {
    this.voice = new ToneVoice();
  }

  frame() {
    const ctx = this.ctx;
    const active = ctx.attr('mode', 'passive') === 'active';
    const freq = ctx.frequency('2') || ctx.frequency('1');
    const on = forward(ctx, '2', '1');
    let hz = 0;
    if (freq >= 20 && freq <= 20000) hz = freq;
    else if (active && on > 0.5) hz = 2400; // active buzzers have their own oscillator
    this.voice?.set(hz);
    this.el.hasSignal = hz > 0;
    this._hz = hz;
  }

  stop() {
    this.voice?.dispose();
    this.voice = null;
    this.el.hasSignal = false;
  }

  status() {
    return this._hz ? `Sounding · ${Math.round(this._hz)} Hz` : 'Silent';
  }
}

const MIN_PRESS_MS = 120;

export class PushbuttonBehavior extends Behavior {
  start() {
    this.pressed = false;
    this._down = () => this.press();
    this._up = () => this.release();
    this.el.addEventListener('button-press', this._down);
    this.el.addEventListener('button-release', this._up);
  }

  links() {
    return this.pressed ? [['1.l', '2.l']] : null;
  }

  set(pressed) {
    if (this.pressed === pressed) return;
    this.pressed = pressed;
    this.el.pressed = pressed;
    this.ctx.invalidate();
    this.ctx.changed();
  }

  press() {
    this._pressAt = performance.now();
    clearTimeout(this._timer);
    this.set(true);
  }

  release() {
    if (!this.pressed) return;
    // A fast click still lasts long enough to beat a typical debounce.
    const wait = Math.max(0, MIN_PRESS_MS - (performance.now() - (this._pressAt || 0)));
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.set(false), wait);
  }

  stop() {
    clearTimeout(this._timer);
    this.el.removeEventListener('button-press', this._down);
    this.el.removeEventListener('button-release', this._up);
    this.el.pressed = false;
  }

  status() {
    const key = this.ctx.attr('key', '');
    return `${this.pressed ? 'Pressed' : 'Released'}${key ? ` · key “${key}”` : ''}`;
  }
}

export class SlideSwitchBehavior extends Behavior {
  start() {
    this._onInput = () => {
      this.ctx.setAttr('value', String(this.el.value));
      this.ctx.invalidate();
      this.ctx.changed();
    };
    this.el.addEventListener('input', this._onInput);
  }

  // Pin 2 is the common terminal: handle left joins 1-2, right joins 2-3.
  links() {
    return Number(this.el.value) ? [['2', '3']] : [['1', '2']];
  }

  press() {
    this.el.value = Number(this.el.value) ? 0 : 1;
    this._onInput();
  }

  stop() {
    this.el.removeEventListener('input', this._onInput);
  }

  status() {
    return Number(this.el.value) ? 'Right · 2↔3 connected' : 'Left · 1↔2 connected';
  }
}

export class DipSwitchBehavior extends Behavior {
  start() {
    if (!Array.isArray(this.el.values) || this.el.values.length !== 8) this.el.values = new Array(8).fill(0);
    this._onChange = () => {
      this.ctx.setAttr('values', this.el.values.join(''));
      this.ctx.invalidate();
      this.ctx.changed();
    };
    this.el.addEventListener('switch-change', this._onChange);
  }

  links() {
    const out = [];
    (this.el.values || []).forEach((v, i) => { if (v) out.push([`${i + 1}a`, `${i + 1}b`]); });
    return out;
  }

  stop() {
    this.el.removeEventListener('switch-change', this._onChange);
  }

  status() {
    return `Switches ${(this.el.values || []).map(v => (v ? 'ON' : '–')).join(' ')}`;
  }
}

export class PotentiometerBehavior extends Behavior {
  start() {
    this._onInput = () => {
      this.ctx.setAttr('value', String(this.el.value));
      this.ctx.invalidate();
      this.ctx.changed();
    };
    this.el.addEventListener('input', this._onInput);
  }

  position() {
    const min = Number(this.el.min ?? 0);
    const max = Number(this.el.max ?? 1023);
    return clamp((Number(this.el.value) - min) / ((max - min) || 1), 0, 1);
  }

  resistors() {
    const r = this.ctx.attr('resistance', 10000);
    const p = this.position();
    return [['VCC', 'SIG', Math.max(r * (1 - p), 0.5)], ['SIG', 'GND', Math.max(r * p, 0.5)]];
  }

  control(key, value) {
    if (key === 'value') {
      this.el.value = Number(value);
      this._onInput();
    }
  }

  stop() {
    this.el.removeEventListener('input', this._onInput);
  }

  status() {
    const v = this.ctx.volts('SIG');
    return `Wiper ${Math.round(this.position() * 100)}%${v !== null ? ` · ${v.toFixed(2)} V` : ''}`;
  }
}

/** The board itself: power, L (pin 13), TX/RX activity and the reset button. */
export class BoardBehavior extends Behavior {
  start() {
    this.el.ledPower = true;
    this._reset = () => this.ctx.engine.onBoardReset?.();
    this.el.addEventListener('button-press', this._reset);
  }

  frame() {
    const board = this.ctx.board;
    const runner = this.ctx.runner;
    // ESP32 DevKits: an RGB LED (WS2812) instead of a plain one.
    if (board.rgbLed !== undefined) {
      this.el.rgb = runner.rgbOf?.(board.rgbLed) || null;
      return;
    }
    const led = board.ledBuiltin;
    this.el[board.ledProp || 'led13'] = runner.isOutput(led) ? this.ctx.engine._duty[led] > 0.2 : false;
  }

  stop() {
    this.el.removeEventListener('button-press', this._reset);
    this.el[this.ctx.board.ledProp || 'led13'] = false;
    if (this.ctx.board.rgbLed !== undefined) this.el.rgb = null;
    this.el.ledPower = false;
    this.el.ledTX = false;
    this.el.ledRX = false;
  }
}
