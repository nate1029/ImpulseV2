// TM1637 LED driver: a two-wire bus like I²C without addresses. START is DIO
// falling while CLK is high, STOP is DIO rising while CLK is high; bits are
// sampled LSB first on CLK rising, and the chip acknowledges each byte by
// pulling DIO low through the ninth clock.

export class TM1637 {
  constructor() {
    this.digits = [0, 0, 0, 0, 0, 0];
    this.on = false;
    this.brightness = 7;
    this._autoIncrement = true;
    this._address = 0;
    this._active = false;
    this._bit = 0;
    this._byte = 0;
    this._count = 0;
    this._acking = false;
  }

  start() {
    this._active = true;
    this._bit = 0;
    this._byte = 0;
    this._count = 0;
    this._acking = false;
  }

  stop() {
    this._active = false;
    this._acking = false;
  }

  /** CLK rose: sample a data bit (the ninth clock is the acknowledge). */
  clockRise(dio) {
    if (!this._active || this._bit >= 8) return;
    this._byte |= (dio ? 1 : 0) << this._bit;
    this._bit++;
  }

  /**
   * CLK fell. Returns 'ack' when the chip should start pulling DIO low,
   * 'release' when it should let go, or null.
   */
  clockFall() {
    if (!this._active) return null;
    if (this._acking) {
      this._acking = false;
      const byte = this._byte;
      this._bit = 0;
      this._byte = 0;
      this._onByte(byte);
      return 'release';
    }
    if (this._bit === 8) {
      this._acking = true;
      return 'ack';
    }
    return null;
  }

  _onByte(byte) {
    const first = this._count++ === 0;
    if (first) {
      const kind = byte & 0xc0;
      if (kind === 0x40) this._autoIncrement = !(byte & 0x04);
      else if (kind === 0xc0) { this._address = byte & 0x07; this._writing = true; return; }
      else if (kind === 0x80) { this.on = !!(byte & 0x08); this.brightness = byte & 0x07; }
      this._writing = false;
      return;
    }
    if (!this._writing) return;
    if (this._address < this.digits.length) this.digits[this._address] = byte;
    if (this._autoIncrement) this._address++;
  }
}
