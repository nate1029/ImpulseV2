// SSD1306 OLED controller (128×64), driven over I²C or 4-wire SPI.
// Covers what Adafruit_SSD1306 and U8g2 use: page/horizontal/vertical
// addressing, column/page windows, segment remap, COM scan direction,
// display on/off, invert, entire-display-on and display start line.

const ARG_COUNT = {
  0x20: 1, 0x21: 2, 0x22: 2, 0x26: 6, 0x27: 6, 0x29: 5, 0x2a: 5, 0x81: 1, 0x82: 1,
  0xa3: 2, 0xa8: 1, 0xd3: 1, 0xd5: 1, 0xd8: 1, 0xd9: 1, 0xda: 1, 0xdb: 1, 0x8d: 1,
};

export class SSD1306 {
  constructor(width = 128, height = 64) {
    this.width = width;
    this.height = height;
    this.pages = height / 8;
    this.ram = new Uint8Array(width * this.pages);
    this.reset();
    this.onChange = null;
  }

  reset() {
    this.ram.fill(0);
    this.mode = 2;          // page addressing after reset
    this.col = 0;
    this.page = 0;
    this.colStart = 0;
    this.colEnd = this.width - 1;
    this.pageStart = 0;
    this.pageEnd = this.pages - 1;
    this.on = false;
    this.invert = false;
    this.allOn = false;
    this.segRemap = false;
    this.comReverse = false;
    this.startLine = 0;
    this.offset = 0;
    this.contrast = 0x7f;
    this._pending = null;
    this._ctrl = null;
    this.dirty = true;
  }

  // ── I²C transport ────────────────────────────────────────────────────────
  i2cConnect() { this._ctrl = null; return true; }
  i2cStop() { this._ctrl = null; }
  i2cRead() { return this.on ? 0x03 : 0x43; } // status byte: display on/off
  i2cWrite(byte) {
    if (this._ctrl === null) {
      this._ctrl = byte;
      return true;
    }
    const data = !!(this._ctrl & 0x40);
    if (data) this.data(byte);
    else this.command(byte);
    // Co = 1: only one byte follows, then a new control byte.
    if (this._ctrl & 0x80) this._ctrl = null;
    return true;
  }

  // ── Commands ─────────────────────────────────────────────────────────────
  command(byte) {
    if (this._pending) {
      this._pending.args.push(byte);
      if (this._pending.args.length >= this._pending.need) {
        const { cmd, args } = this._pending;
        this._pending = null;
        this._exec(cmd, args);
      }
      return;
    }
    const need = ARG_COUNT[byte];
    if (need) {
      this._pending = { cmd: byte, args: [], need };
      return;
    }
    this._exec(byte, []);
  }

  _exec(cmd, args) {
    if (cmd <= 0x0f) {               // lower column nibble (page mode)
      this.col = (this.col & 0xf0) | cmd;
    } else if (cmd <= 0x1f) {        // higher column nibble
      this.col = ((cmd & 0x0f) << 4) | (this.col & 0x0f);
    } else if (cmd === 0x20) {
      this.mode = args[0] & 0x03;
    } else if (cmd === 0x21) {
      this.colStart = args[0] & 0x7f;
      this.colEnd = Math.min(args[1] & 0x7f, this.width - 1);
      this.col = this.colStart;
    } else if (cmd === 0x22) {
      this.pageStart = args[0] & 0x07;
      this.pageEnd = Math.min(args[1] & 0x07, this.pages - 1);
      this.page = this.pageStart;
    } else if (cmd >= 0x40 && cmd <= 0x7f) {
      this.startLine = cmd & 0x3f;
      this.dirty = true;
    } else if (cmd === 0x81) {
      this.contrast = args[0];
    } else if (cmd === 0xa0 || cmd === 0xa1) {
      this.segRemap = cmd === 0xa1;
      this.dirty = true;
    } else if (cmd === 0xa4 || cmd === 0xa5) {
      this.allOn = cmd === 0xa5;
      this.dirty = true;
    } else if (cmd === 0xa6 || cmd === 0xa7) {
      this.invert = cmd === 0xa7;
      this.dirty = true;
    } else if (cmd === 0xae || cmd === 0xaf) {
      this.on = cmd === 0xaf;
      this.dirty = true;
    } else if (cmd >= 0xb0 && cmd <= 0xb7) {
      this.page = cmd & 0x07;
    } else if (cmd === 0xc0 || cmd === 0xc8) {
      this.comReverse = cmd === 0xc8;
      this.dirty = true;
    } else if (cmd === 0xd3) {
      this.offset = args[0] & 0x3f;
      this.dirty = true;
    }
    // Scrolling, timing, charge pump, mux ratio and pin config are accepted and ignored.
  }

  data(byte) {
    if (this.page < this.pages && this.col < this.width) {
      this.ram[this.page * this.width + this.col] = byte;
      this.dirty = true;
    }
    if (this.mode === 0) {           // horizontal
      if (++this.col > this.colEnd) {
        this.col = this.colStart;
        if (++this.page > this.pageEnd) this.page = this.pageStart;
      }
    } else if (this.mode === 1) {    // vertical
      if (++this.page > this.pageEnd) {
        this.page = this.pageStart;
        if (++this.col > this.colEnd) this.col = this.colStart;
      }
    } else {                         // page
      if (++this.col >= this.width) this.col = 0;
    }
  }

  /** Pixel as seen on the glass (x right, y down). */
  pixel(x, y) {
    if (!this.on) return false;
    if (this.allOn) return true;
    const col = this.segRemap ? x : this.width - 1 - x;
    const row = this.comReverse ? y : this.height - 1 - y;
    const line = (row + this.startLine + this.offset) % this.height;
    const on = !!(this.ram[(line >> 3) * this.width + col] & (1 << (line & 7)));
    return this.invert ? !on : on;
  }

  /** Paint into an RGBA ImageData-like buffer. */
  render(image, on = [235, 245, 255], off = [0, 0, 0]) {
    const d = image.data;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const c = this.pixel(x, y) ? on : off;
        const i = (y * this.width + x) * 4;
        d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
      }
    }
    this.dirty = false;
  }
}
