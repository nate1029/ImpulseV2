// Shift-register style chips, fed bit by bit (shiftOut / bit-banging) or a
// byte at a time (hardware SPI).

/** 74HC595: 8-bit serial-in, parallel-out shift register with output latch. */
export class HC595 {
  constructor() {
    this.shift = 0;
    this.latched = 0;
    this.onLatch = null;
  }

  /** Rising edge on SHCP with the DS level. Returns the bit shifted out (Q7S). */
  clock(bit) {
    this.shift = ((this.shift << 1) | (bit ? 1 : 0)) & 0xff;
    return this.q7s;
  }

  /** A whole byte clocked in MSB first (SPI). */
  byte(value) {
    this.shift = value & 0xff;
  }

  get q7s() {
    return (this.shift >> 7) & 1;
  }

  /** Rising edge on STCP. */
  latch() {
    this.latched = this.shift;
    this.onLatch?.(this.latched);
  }

  clear() {
    this.shift = 0;
  }
}

/** MAX7219 8-digit LED driver (one chip), as used by LedControl / MD_MAX72XX. */
export class MAX7219 {
  constructor() {
    this.digits = new Uint8Array(8);
    this.decode = 0;
    this.intensity = 7;
    this.scanLimit = 7;
    this.shutdown = true;
    this.test = false;
    this.shift = 0;
    this.dirty = true;
  }

  /** Clock in one bit (CLK rising). Returns the bit leaving the 16-bit register (DOUT). */
  clock(bit) {
    const out = (this.shift >> 15) & 1;
    this.shift = ((this.shift << 1) | (bit ? 1 : 0)) & 0xffff;
    return out;
  }

  /** Clock in a byte MSB first (SPI). Returns the byte pushed out. */
  byte(value) {
    const out = (this.shift >> 8) & 0xff;
    this.shift = ((this.shift << 8) | (value & 0xff)) & 0xffff;
    return out;
  }

  /** LOAD/CS rising edge: execute the 16-bit word in the register. */
  load() {
    this.write((this.shift >> 8) & 0x0f, this.shift & 0xff);
  }

  write(reg, value) {
    if (reg >= 1 && reg <= 8) this.digits[reg - 1] = value;
    else if (reg === 0x09) this.decode = value;
    else if (reg === 0x0a) this.intensity = value & 0x0f;
    else if (reg === 0x0b) this.scanLimit = value & 0x07;
    else if (reg === 0x0c) this.shutdown = (value & 1) === 0;
    else if (reg === 0x0f) this.test = (value & 1) === 1;
    this.dirty = true;
  }

  /** LED at (row 0-7, col 0-7) of an 8×8 matrix module: digit = row, bit 7 = column 0. */
  led(row, col) {
    if (this.test) return true;
    if (this.shutdown || row > this.scanLimit) return false;
    return !!(this.digits[row] & (0x80 >> col));
  }
}
