// Timer/Counter4 of the ATmega16U4/32U4 (datasheet section 15), the 10-bit
// high-speed timer behind analogWrite() on the Leonardo's pins 13 (OC4A) and
// 6 (OC4D), and OC4B on pin 10. avr8js has no model of it. The Arduino core
// runs it in phase-and-frequency-correct PWM from the CPU clock / 64 with
// OCR4C (TOP) at 0xFF; fast PWM is modelled too. The outputs are driven edge
// by edge at the right times, so parts see the real duty cycle and frequency.
// Timer4's interrupts aren't modelled: the Arduino core doesn't use them.

const PinOverrideMode = { None: 0, Enable: 1, Set: 2, Clear: 3 };

export const timer4Config = {
  TC4H: 0xbf, TCCR4A: 0xc0, TCCR4B: 0xc1, TCCR4C: 0xc2, TCCR4D: 0xc3,
  OCR4A: 0xcf, OCR4B: 0xd0, OCR4C: 0xd1, OCR4D: 0xd2,
  // Output pins: OC4x and its complement (~OC4x, driven with COM4x = 01).
  channels: {
    A: { ocr: 0xcf, port: 0x28, out: 7, inverse: 6 },  // PC7 (13), ~PC6 (5)
    B: { ocr: 0xd0, port: 0x25, out: 6, inverse: 5 },  // PB6 (10), ~PB5 (9)
    D: { ocr: 0xd2, port: 0x2b, out: 7, inverse: 6 },  // PD7 (6), ~PD6 (12)
  },
};

export class Timer4 {
  /** @param {import('avr8js').CPU} cpu */
  constructor(cpu, cfg = timer4Config) {
    this.cpu = cpu;
    this.cfg = cfg;
    this.ocr = { A: 0, B: 0, C: 0x3ff, D: 0 };
    this.tc4h = 0;
    this.start = 0;
    this.events = {};
    this.owned = new Map(); // pin key → { port, bit }
    cpu.data[cfg.OCR4C] = 0xff;
    this.ocr.C = 0xff;

    const hooks = cpu.writeHooks;
    const hook = (addr, fn) => { hooks[addr] = (value) => { cpu.data[addr] = value; fn(value); this.update(); return true; }; };
    hook(cfg.TC4H, (v) => { this.tc4h = v & 0x07; });
    for (const [key, addr] of [['A', cfg.OCR4A], ['B', cfg.OCR4B], ['C', cfg.OCR4C], ['D', cfg.OCR4D]]) {
      hook(addr, (v) => { this.ocr[key] = (this.tc4h & 3) << 8 | v; });
    }
    hook(cfg.TCCR4A, () => {});
    hook(cfg.TCCR4B, () => { this.start = cpu.cycles; });
    hook(cfg.TCCR4C, () => {});
    hook(cfg.TCCR4D, () => {});
  }

  get divider() {
    const cs = this.cpu.data[this.cfg.TCCR4B] & 0x0f;
    return cs ? 2 ** (cs - 1) : 0;
  }

  /** WGM41:40: 00 fast PWM, 01 phase and frequency correct. */
  get phaseCorrect() {
    return (this.cpu.data[this.cfg.TCCR4D] & 0x03) === 1;
  }

  _channel(key) {
    const d = this.cpu.data;
    const { TCCR4A, TCCR4C } = this.cfg;
    if (key === 'A') return { pwm: !!(d[TCCR4A] & 0x02), com: (d[TCCR4A] >> 6) & 3 };
    if (key === 'B') return { pwm: !!(d[TCCR4A] & 0x01), com: (d[TCCR4A] >> 4) & 3 };
    return { pwm: !!(d[TCCR4C] & 0x01), com: (d[TCCR4C] >> 2) & 3 };
  }

  update() {
    for (const key of ['A', 'B', 'D']) this._schedule(key);
  }

  _setPin(port, bit, mode) {
    this.cpu.gpioByPort[port]?.timerOverridePin(bit, mode);
  }

  _own(key, pins) {
    const prev = this.owned.get(key) || [];
    for (const [port, bit] of prev) if (!pins.some(p => p[0] === port && p[1] === bit)) this._setPin(port, bit, PinOverrideMode.None);
    for (const [port, bit] of pins) if (!prev.some(p => p[0] === port && p[1] === bit)) this._setPin(port, bit, PinOverrideMode.Enable);
    this.owned.set(key, pins);
  }

  /** Drive a channel's outputs: the next edges, one clock event at a time. */
  _schedule(key) {
    const { cpu } = this;
    if (this.events[key]) { cpu.clearClockEvent(this.events[key]); this.events[key] = null; }
    const ch = this.cfg.channels[key];
    const { pwm, com } = this._channel(key);
    const div = this.divider;
    const top = Math.max(1, this.ocr.C);
    if (!pwm || !com || !div) { this._own(key, []); return; }
    const pins = [[ch.port, ch.out]];
    if (com === 1) pins.push([ch.port, ch.inverse]);
    this._own(key, pins);
    const ocr = Math.min(this.ocr[key], top);
    const inverted = com === 3;
    const drive = (high) => {
      const level = inverted ? !high : high;
      this._setPin(ch.port, ch.out, level ? PinOverrideMode.Set : PinOverrideMode.Clear);
      if (com === 1) this._setPin(ch.port, ch.inverse, level ? PinOverrideMode.Clear : PinOverrideMode.Set);
    };
    // Non-inverting: high from BOTTOM to the up-count match (and from the down-count match back to BOTTOM).
    if (ocr === 0) { drive(false); return; }
    if (ocr >= top) { drive(true); return; }
    const period = (this.phaseCorrect ? 2 * top : top + 1) * div;
    const highTime = (this.phaseCorrect ? 2 * ocr : ocr) * div;
    // Phase correct: the high part is centred on BOTTOM.
    const offset = this.phaseCorrect ? -highTime / 2 : 0;
    const step = () => {
      const pos = ((cpu.cycles - this.start - offset) % period + period) % period;
      const high = pos < highTime;
      drive(high);
      const next = high ? highTime - pos : period - pos;
      this.events[key] = cpu.addClockEvent(step, Math.max(1, Math.round(next)));
    };
    step();
  }
}
