// WS2812 / NeoPixel data decoder, fed with the data pin's edges in CPU cycles.
// A HIGH pulse longer than ~0.55 µs is a 1 bit; bits arrive MSB first as
// G, R, B bytes per pixel. A LOW gap over 50 µs latches the frame.

export const F_CPU = 16_000_000;
const ONE_THRESHOLD = Math.round(0.55e-6 * F_CPU); // cycles
const LATCH_CYCLES = Math.round(50e-6 * F_CPU);

export class WS2812Decoder {
  /** @param {(bytes: Uint8Array) => void} onFrame */
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.bytes = [];
    this.current = 0;
    this.bitCount = 0;
    this.riseAt = -1;
    this.lastFall = -1;
  }

  edge(high, cycles) {
    if (high) {
      if (this.lastFall >= 0 && cycles - this.lastFall > LATCH_CYCLES) this.latch();
      this.riseAt = cycles;
      return;
    }
    if (this.riseAt < 0) return;
    const width = cycles - this.riseAt;
    this.riseAt = -1;
    this.lastFall = cycles;
    if (width > 4 * ONE_THRESHOLD) return; // not a data bit (pin held high)
    this.current = (this.current << 1) | (width > ONE_THRESHOLD ? 1 : 0);
    if (++this.bitCount === 8) {
      this.bytes.push(this.current & 0xff);
      this.current = 0;
      this.bitCount = 0;
    }
  }

  /** Call periodically with the current cycle count to latch an idle line. */
  poll(cycles) {
    if (this.bytes.length && this.lastFall >= 0 && cycles - this.lastFall > LATCH_CYCLES) this.latch();
  }

  latch() {
    if (this.bytes.length) this.onFrame(Uint8Array.from(this.bytes));
    this.bytes = [];
    this.current = 0;
    this.bitCount = 0;
    this.lastFall = -1;
  }
}

/** Split a GRB byte stream into { r, g, b } (0..255) pixels. */
export function grbPixels(bytes, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = i * 3;
    if (o + 2 >= bytes.length) break;
    out.push({ g: bytes[o], r: bytes[o + 1], b: bytes[o + 2] });
  }
  return out;
}
