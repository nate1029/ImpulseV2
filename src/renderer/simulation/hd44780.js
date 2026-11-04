// HD44780 character LCD controller, fed by a PCF8574 I²C backpack
// (LiquidCrystal_I2C) or by the parallel bus (LiquidCrystal, 4- or 8-bit).
//
// Starts in 8-bit interface mode like the real chip after power-on; a
// "function set" with DL=0 switches to 4-bit transfers. Keeps DDRAM, CGRAM
// (custom characters), entry mode, display/cursor/blink and display shift.

// PCF8574 → HD44780 mapping used by LiquidCrystal_I2C.
const RS_BIT = 0x01;
const RW_BIT = 0x02;
const EN_BIT = 0x04;
const BL_BIT = 0x08;

const ROW_START = [0x00, 0x40, 0x14, 0x54];

export class HD44780 {
  constructor(cols = 16, rows = 2) {
    this.cols = cols;
    this.rows = rows;
    this.ddram = new Uint8Array(0x80).fill(0x20);
    this.cgram = new Uint8Array(64);
    this.onChange = null;
    this.backlight = true;
    this._lastEn = false;
    this._pcf = 0;
    this.reset();
  }

  reset() {
    this.ddram.fill(0x20);
    this.cgram.fill(0);
    this.addr = 0;
    this.cgMode = false;     // address counter points into CGRAM
    this.incr = true;
    this.shiftOnWrite = false;
    this.displayOn = true;   // most modules show text without an explicit display-on
    this.cursorOn = false;
    this.blinkOn = false;
    this.shift = 0;
    this.eightBit = true;
    this._hi = null;
    this.cgramVersion = 0;
    if (this.onChange) this.onChange();
  }

  // ── PCF8574 (I²C) ────────────────────────────────────────────────────────
  writePcf(value) {
    this._pcf = value;
    this.backlight = !!(value & BL_BIT);
    const en = !!(value & EN_BIT);
    // Data is latched on the EN falling edge; RW high means a read (ignored).
    if (this._lastEn && !en && !(value & RW_BIT)) {
      this._bus(!!(value & RS_BIT), (value >> 4) & 0x0f, null);
    }
    this._lastEn = en;
    if (this.onChange) this.onChange();
  }

  readPcf() {
    return this._pcf;
  }

  // ── Parallel bus ─────────────────────────────────────────────────────────
  /** EN falling edge with D4-D7 as `nibble` (4-bit wiring). */
  writeParallelNibble(rs, nibble) {
    this._bus(!!rs, nibble & 0x0f, null);
  }

  /** EN falling edge with all eight data lines (8-bit wiring). */
  writeParallelByte(rs, byte) {
    this._bus(!!rs, (byte >> 4) & 0x0f, byte & 0x0f);
  }

  _bus(rs, high, low) {
    if (this.eightBit) {
      // In 8-bit mode every EN pulse is a whole byte; with 4-bit wiring the
      // low lines read as 0, which is exactly what the init sequence relies on.
      this._byte(rs, (high << 4) | (low ?? 0));
      return;
    }
    if (this._hi === null) {
      this._hi = { rs, nibble: high };
      return;
    }
    const byte = (this._hi.nibble << 4) | high;
    const asData = this._hi.rs;
    this._hi = null;
    this._byte(asData, byte);
  }

  _byte(rs, byte) {
    if (rs) this._writeData(byte);
    else this._command(byte);
    if (this.onChange) this.onChange();
  }

  _command(cmd) {
    if (cmd & 0x80) {                 // set DDRAM address
      this.addr = cmd & 0x7f;
      this.cgMode = false;
    } else if (cmd & 0x40) {          // set CGRAM address
      this.addr = cmd & 0x3f;
      this.cgMode = true;
    } else if (cmd & 0x20) {          // function set
      this.eightBit = !!(cmd & 0x10);
      this._hi = null;
    } else if (cmd & 0x10) {          // cursor / display shift
      const right = !!(cmd & 0x04);
      if (cmd & 0x08) this.shift += right ? -1 : 1; // moving the display left reveals later columns
      else this.addr = (this.addr + (right ? 1 : -1)) & 0x7f;
    } else if (cmd & 0x08) {          // display on/off control
      this.displayOn = !!(cmd & 0x04);
      this.cursorOn = !!(cmd & 0x02);
      this.blinkOn = !!(cmd & 0x01);
    } else if (cmd & 0x04) {          // entry mode set
      this.incr = !!(cmd & 0x02);
      this.shiftOnWrite = !!(cmd & 0x01);
    } else if (cmd & 0x02) {          // return home
      this.addr = 0;
      this.shift = 0;
      this.cgMode = false;
    } else if (cmd & 0x01) {          // clear display
      this.ddram.fill(0x20);
      this.addr = 0;
      this.shift = 0;
      this.incr = true;
      this.cgMode = false;
    }
  }

  _writeData(byte) {
    if (this.cgMode) {
      this.cgram[this.addr & 0x3f] = byte & 0x1f;
      this.addr = (this.addr + (this.incr ? 1 : -1)) & 0x3f;
      this.cgramVersion++;
      return;
    }
    this.ddram[this.addr & 0x7f] = byte;
    this.addr = (this.addr + (this.incr ? 1 : -1)) & 0x7f;
    if (this.shiftOnWrite) this.shift += this.incr ? 1 : -1;
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  /** Visible characters, row by row (cols × rows). */
  toCharacters() {
    const out = new Uint8Array(this.cols * this.rows).fill(0x20);
    if (!this.displayOn) return out;
    const lineLen = this.rows > 1 ? 40 : 80;
    for (let r = 0; r < this.rows; r++) {
      const base = ROW_START[r];
      // Rows 0/2 and 1/3 share a 40-character line on 4-row modules.
      const lineBase = r === 2 ? 0x00 : r === 3 ? 0x40 : base;
      const startOffset = base - lineBase;
      for (let c = 0; c < this.cols; c++) {
        const pos = (((startOffset + c + this.shift) % lineLen) + lineLen) % lineLen;
        out[r * this.cols + c] = this.ddram[lineBase + pos];
      }
    }
    return out;
  }

  /** Cursor cell on screen, or null when it isn't visible. */
  cursorCell() {
    if (this.cgMode) return null;
    const lineLen = this.rows > 1 ? 40 : 80;
    for (let r = 0; r < this.rows; r++) {
      const lineBase = r === 2 ? 0x00 : r === 3 ? 0x40 : ROW_START[r];
      if (this.addr < lineBase || this.addr >= lineBase + lineLen) continue;
      const startOffset = ROW_START[r] - lineBase;
      const rel = ((((this.addr - lineBase) - startOffset - this.shift) % lineLen) + lineLen) % lineLen;
      if (rel < this.cols) return { x: rel, y: r };
    }
    return null;
  }

  /** Apply custom characters 0-7 (and their 8-15 mirrors) to a 5×8 font table. */
  patchFont(baseFont) {
    const font = baseFont?.length ? new Uint8Array(baseFont) : new Uint8Array(256 * 8);
    for (let ch = 0; ch < 8; ch++) {
      for (let row = 0; row < 8; row++) {
        const bits = this.cgram[ch * 8 + row];
        let mirrored = 0;
        for (let b = 0; b < 5; b++) if (bits & (1 << (4 - b))) mirrored |= 1 << b;
        font[ch * 8 + row] = mirrored;
        font[(ch + 8) * 8 + row] = mirrored;
      }
    }
    return font;
  }
}
