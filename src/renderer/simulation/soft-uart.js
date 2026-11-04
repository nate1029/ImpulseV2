// A software UART on a chip without one: the ATtiny85, whose Serial is
// ATTinyCore's TinySoftwareSerial (TX bit-banged on PB0, RX on PB1 with the
// analog comparator's interrupt catching the start bit).
//
// Bit-banged transmitters write the port once per bit, so the first port
// write after the start bit's falling edge gives the bit time, whatever the
// baud rate. The line is then sampled mid-bit, like a UART receiver would.

const MIN_BIT_CYCLES = 16; // 1 Mbaud at 16 MHz
const MAX_BIT_CYCLES = Math.ceil(16_000_000 / 300); // 300 baud

export class SoftUartTx {
  /**
   * @param {{ schedule: (cycles: number, fn: Function) => any, level: () => boolean,
   *   enabled: () => boolean, onByte: (byte: number) => void }} io
   */
  constructor(io) {
    this.io = io;
    this.state = 'idle'; // 'idle' | 'start' | 'data'
    this.t0 = 0;
    this.bitCycles = 0; // last measured bit time
  }

  /** The TX pin changed level. */
  edge(high, cycles) {
    if (!high && this.state === 'idle' && this.io.enabled()) {
      this.state = 'start';
      this.t0 = cycles;
    } else if (high && this.state === 'start') {
      // Back up before a bit time passed: a glitch (setting the pin up), not a start bit.
      this.state = 'idle';
    }
  }

  /** The TX pin's port was written (before the new value takes effect). */
  write(cycles) {
    if (this.state !== 'start') return;
    const bit = cycles - this.t0;
    if (bit < MIN_BIT_CYCLES) return;
    if (bit > MAX_BIT_CYCLES) { this.state = 'idle'; return; }
    this.state = 'data';
    this.bitCycles = bit;
    let byte = 0;
    let i = 0;
    const sample = () => {
      if (i < 8) {
        if (this.io.level()) byte |= 1 << i;
        i++;
        this.io.schedule(bit, sample);
        return;
      }
      // Stop bit: a LOW line here is a framing error (or not a UART at all).
      this.state = 'idle';
      if (this.io.level()) this.io.onByte(byte);
    };
    // Bit 0's middle is 1.5 bit times after the start edge; this is 1 bit in.
    this.io.schedule(bit / 2, sample);
  }
}

/**
 * Feeds text into a software UART's RX pin: start bit, 8 data bits LSB first,
 * then two stop bits so the receiver's interrupt can return between bytes.
 */
export class SoftUartRx {
  /**
   * @param {{ schedule: (cycles: number, fn: Function) => any, drive: (high: boolean) => void,
   *   bitCycles: () => number }} io
   */
  constructor(io) {
    this.io = io;
    this.queue = [];
    this.busy = false;
  }

  write(bytes) {
    this.queue.push(...bytes);
    if (!this.busy) this._next();
  }

  _next() {
    if (!this.queue.length) { this.busy = false; return; }
    this.busy = true;
    const byte = this.queue.shift();
    const bit = this.io.bitCycles();
    const levels = [false];
    for (let i = 0; i < 8; i++) levels.push(!!(byte & (1 << i)));
    levels.push(true, true);
    let i = 0;
    const step = () => {
      if (i < levels.length) {
        this.io.drive(levels[i++]);
        this.io.schedule(bit, step);
      } else {
        this._next();
      }
    };
    step();
  }
}
