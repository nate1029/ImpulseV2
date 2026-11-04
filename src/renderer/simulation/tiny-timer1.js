// Timer/Counter1 of the ATtiny25/45/85, from the datasheet (Atmel-2586,
// section 12). avr8js ships a model of it, but runs its PWM phase-correct and
// leaves the pins alone when CTC1 is set; the chip's PWM is a fast PWM from 0
// to OCR1C, which is what ATTinyCore's analogWrite() on PB1 and PB4 uses.
//
// The counter is kept lazily: it is brought up to date when the program reads
// or writes a Timer1 register, and at a clock event scheduled for the next
// compare match or wrap, which is also when outputs and flags change.

// avr8js' PinOverrideMode (its GPIO module doesn't export it from the package root).
const PinOverrideMode = { None: 0, Enable: 1, Set: 2, Clear: 3, Toggle: 4 };

const TCCR1_CTC1 = 0x80;
const TCCR1_PWM1A = 0x40;
const GTCCR_PWM1B = 0x40;
const GTCCR_FOC1B = 0x08;
const GTCCR_FOC1A = 0x04;
const GTCCR_PSR1 = 0x02;
const PLLCSR_LSM = 0x80;
const PLLCSR_PCKE = 0x04;
const PLLCSR_PLLE = 0x02;
const PLLCSR_PLOCK = 0x01;

export const tinyTimer1Config = {
  TCCR1: 0x50, GTCCR: 0x4c, TCNT1: 0x4f, OCR1A: 0x4e, OCR1B: 0x4b, OCR1C: 0x4d, PLLCSR: 0x47,
  TIFR: 0x58, TIMSK: 0x59,
  OCF1A: 0x40, OCF1B: 0x20, TOV1: 0x04,
  compAInterrupt: 3, ovfInterrupt: 4, compBInterrupt: 9,
  port: 0x38, // PORTB
  // OC1A on PB1 and its complement on PB0; OC1B on PB4, complement on PB3.
  pins: { A: { out: 1, inverse: 0 }, B: { out: 4, inverse: 3 } },
};

export class TinyTimer1 {
  /** @param {import('avr8js').CPU} cpu */
  constructor(cpu, config = tinyTimer1Config) {
    this.cpu = cpu;
    this.config = config;
    this.tcnt = 0;
    this.ocr = { A: 0, B: 0, C: 0 };
    this.lastCycle = 0; // cpu cycle at which tcnt was current
    this.divider = 0;   // CPU cycles per timer tick (0 = stopped)
    this._event = null;
    this._owned = new Set(); // output pins the timer drives

    const { TIFR, TIMSK } = config;
    const irq = (address, mask) => ({ address, flagRegister: TIFR, flagMask: mask, enableRegister: TIMSK, enableMask: mask });
    this.irq = { A: irq(config.compAInterrupt, config.OCF1A), B: irq(config.compBInterrupt, config.OCF1B), OVF: irq(config.ovfInterrupt, config.TOV1) };

    const hooks = cpu.writeHooks;
    const { TCCR1, GTCCR, TCNT1, OCR1A, OCR1B, OCR1C, PLLCSR } = config;
    cpu.readHooks[TCNT1] = () => {
      this.sync();
      return (cpu.data[TCNT1] = this.tcnt);
    };
    hooks[TCNT1] = (value) => {
      this.sync();
      this.tcnt = value;
      cpu.data[TCNT1] = value;
      this.schedule();
      return true;
    };
    for (const [addr, key] of [[OCR1A, 'A'], [OCR1B, 'B'], [OCR1C, 'C']]) {
      hooks[addr] = (value) => {
        this.sync();
        this.ocr[key] = value;
        cpu.data[addr] = value;
        this.schedule();
        return true;
      };
    }
    hooks[TCCR1] = (value) => {
      this.sync();
      cpu.data[TCCR1] = value;
      this.updateClock();
      this.updateOutputs();
      this.schedule();
      return true;
    };
    const prevGtccr = hooks[GTCCR];
    hooks[GTCCR] = (value, oldValue, addr, mask) => {
      this.sync();
      if (value & GTCCR_PSR1) this.lastCycle = cpu.cycles;
      const stored = value & ~(GTCCR_FOC1A | GTCCR_FOC1B | GTCCR_PSR1);
      if (!prevGtccr?.(stored, oldValue, addr, mask)) cpu.data[GTCCR] = stored;
      this.updateOutputs();
      if (value & GTCCR_FOC1A) this.forceCompare('A');
      if (value & GTCCR_FOC1B) this.forceCompare('B');
      this.schedule();
      return true;
    };
    hooks[PLLCSR] = (value) => {
      this.sync();
      // The PLL locks at once here; ATTinyCore waits for PLOCK before using it.
      cpu.data[PLLCSR] = (value & ~PLLCSR_PLOCK) | (value & PLLCSR_PLLE ? PLLCSR_PLOCK : 0);
      this.updateClock();
      this.schedule();
      return true;
    };
    // TIFR and TIMSK are shared with Timer0, whose hooks run first. Every TIFR
    // bit is a flag that writing 1 clears and writing 0 leaves alone.
    const prevTifr = hooks[TIFR];
    hooks[TIFR] = (value, oldValue, addr, mask) => {
      const keep = cpu.data[TIFR] & ~value;
      prevTifr?.(value, oldValue, addr, mask);
      for (const i of Object.values(this.irq)) cpu.clearInterruptByFlag(i, value);
      cpu.data[TIFR] = keep;
      return true;
    };
    const prevTimsk = hooks[TIMSK];
    hooks[TIMSK] = (value, oldValue, addr, mask) => {
      prevTimsk?.(value, oldValue, addr, mask);
      cpu.data[TIMSK] = value;
      for (const i of Object.values(this.irq)) cpu.updateInterruptEnable(i, value);
      return true;
    };
  }

  get pwm() {
    return { A: !!(this.cpu.data[this.config.TCCR1] & TCCR1_PWM1A), B: !!(this.cpu.data[this.config.GTCCR] & GTCCR_PWM1B) };
  }

  com(ch) {
    const reg = ch === 'A' ? this.config.TCCR1 : this.config.GTCCR;
    return (this.cpu.data[reg] >> 4) & 3;
  }

  /** The counter clears after OCR1C in PWM and CTC modes, after 0xFF otherwise. */
  get top() {
    const { A, B } = this.pwm;
    return A || B || (this.cpu.data[this.config.TCCR1] & TCCR1_CTC1) ? this.ocr.C : 0xff;
  }

  updateClock() {
    const cs = this.cpu.data[this.config.TCCR1] & 0x0f;
    const pll = this.cpu.data[this.config.PLLCSR];
    // PCKE runs the timer from the 64 MHz PLL (32 MHz with LSM): 4 or 2 ticks
    // per CPU cycle at 16 MHz before the prescaler.
    const base = pll & PLLCSR_PCKE ? (pll & PLLCSR_LSM ? 0.5 : 0.25) : 1;
    const divider = cs ? base * 2 ** (cs - 1) : 0;
    if (divider !== this.divider) {
      this.divider = divider;
      this.lastCycle = this.cpu.cycles;
    }
  }

  /** Bring the counter up to the current cycle, handling every match and wrap on the way. */
  sync() {
    const { cpu } = this;
    if (!this.divider) { this.lastCycle = cpu.cycles; return; }
    let ticks = Math.floor((cpu.cycles - this.lastCycle) / this.divider);
    if (ticks <= 0) return;
    this.lastCycle += ticks * this.divider;
    while (ticks > 0) {
      const step = Math.min(ticks, this.ticksToEvent());
      ticks -= step;
      this.advance(step);
    }
  }

  /** Ticks until the next compare match or wrap. */
  ticksToEvent() {
    const wrapAt = this.tcnt <= this.top ? this.top : 0xff;
    let next = wrapAt - this.tcnt + 1;
    for (const ch of ['A', 'B']) {
      const ocr = this.ocr[ch];
      if (ocr > this.tcnt && ocr <= wrapAt) next = Math.min(next, ocr - this.tcnt);
    }
    return next;
  }

  advance(step) {
    const wrapAt = this.tcnt <= this.top ? this.top : 0xff;
    this.tcnt += step;
    if (this.tcnt > wrapAt) {
      this.tcnt = 0;
      const pwm = this.pwm;
      // TOV1: when the counter clears after OCR1C in PWM mode, or overflows past 0xFF.
      if (pwm.A || pwm.B || wrapAt === 0xff) this.cpu.setInterruptFlag(this.irq.OVF);
      for (const ch of ['A', 'B']) if (pwm[ch]) this.pwmBottom(ch);
    }
    for (const ch of ['A', 'B']) if (this.ocr[ch] === this.tcnt) this.compareMatch(ch);
  }

  compareMatch(ch) {
    this.cpu.setInterruptFlag(this.irq[ch]);
    const com = this.com(ch);
    if (!com) return;
    if (this.pwm[ch]) {
      // COM 01 and 10: OC1x clears on match (01 also drives the complement); 11 sets.
      this.drive(ch, com === 3);
    } else {
      this.setPin(this.config.pins[ch].out, com === 1 ? PinOverrideMode.Toggle : com === 2 ? PinOverrideMode.Clear : PinOverrideMode.Set);
    }
  }

  /** PWM outputs at TCNT1 = 0: set for COM 01/10, cleared for 11. */
  pwmBottom(ch) {
    const com = this.com(ch);
    if (com) this.drive(ch, com !== 3);
  }

  drive(ch, high) {
    const { out, inverse } = this.config.pins[ch];
    this.setPin(out, high ? PinOverrideMode.Set : PinOverrideMode.Clear);
    if (this.com(ch) === 1) this.setPin(inverse, high ? PinOverrideMode.Clear : PinOverrideMode.Set);
  }

  forceCompare(ch) {
    if (!this.pwm[ch] && this.com(ch)) this.compareMatch(ch);
  }

  setPin(pin, mode) {
    this.cpu.gpioByPort[this.config.port]?.timerOverridePin(pin, mode);
  }

  /**
   * Hand OC1x (and its complement in PWM mode with COM 01) to the timer, or
   * back to PORTB. Only pins this timer took are released: PB0 and PB1 are
   * also Timer0's outputs.
   */
  updateOutputs() {
    const want = new Set();
    for (const ch of ['A', 'B']) {
      const com = this.com(ch);
      if (com) want.add(this.config.pins[ch].out);
      if (com === 1 && this.pwm[ch]) want.add(this.config.pins[ch].inverse);
    }
    for (const pin of want) if (!this._owned.has(pin)) this.setPin(pin, PinOverrideMode.Enable);
    for (const pin of this._owned) if (!want.has(pin)) this.setPin(pin, PinOverrideMode.None);
    this._owned = want;
  }

  schedule() {
    const { cpu } = this;
    if (this._event) { cpu.clearClockEvent(this._event); this._event = null; }
    if (!this.divider) return;
    const at = this.lastCycle + this.ticksToEvent() * this.divider;
    this._event = cpu.addClockEvent(() => {
      this._event = null;
      this.sync();
      this.schedule();
    }, Math.max(1, Math.ceil(at - cpu.cycles)));
  }
}
