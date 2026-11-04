// ILI9341 240×320 TFT controller over 4-wire SPI (Adafruit_ILI9341, TFT_eSPI
// AVR builds, MCUFRIEND-style SPI). Implements the window/RAM-write path,
// memory access control (rotation), inversion, sleep and display on/off, and
// answers the read-ID commands drivers probe during begin().

const W = 240;
const H = 320;

export class ILI9341 {
  constructor() {
    this.fb = new Uint16Array(W * H);
    this.reset();
  }

  reset() {
    this.fb.fill(0);
    this.cmd = 0;
    this.args = [];
    this.madctl = 0;
    this.x0 = 0; this.x1 = W - 1;
    this.y0 = 0; this.y1 = H - 1;
    this.x = 0; this.y = 0;
    this.on = false;
    this.inverted = false;
    this.byteHi = null;
    this.readQueue = [];
    this.dirty = true;
  }

  /** One SPI byte with the D/C line level. Returns the MISO byte. */
  transfer(byte, isData) {
    if (!isData) {
      this._command(byte);
      return 0;
    }
    if (this.readQueue.length) return this.readQueue.shift();
    if (this.cmd === 0x2c || this.cmd === 0x3c) {
      if (this.byteHi === null) {
        this.byteHi = byte;
      } else {
        this._pixel((this.byteHi << 8) | byte);
        this.byteHi = null;
      }
      return 0;
    }
    this.args.push(byte);
    this._arg();
    return 0;
  }

  _command(byte) {
    this.cmd = byte;
    this.args = [];
    this.byteHi = null;
    this.readQueue = [];
    switch (byte) {
      case 0x01: { const fb = this.fb; this.reset(); this.fb = fb; this.fb.fill(0); break; }
      case 0x10: this.on = false; this.dirty = true; break;          // sleep in
      case 0x11: break;                                              // sleep out
      case 0x20: this.inverted = false; this.dirty = true; break;
      case 0x21: this.inverted = true; this.dirty = true; break;
      case 0x28: this.on = false; this.dirty = true; break;
      case 0x29: this.on = true; this.dirty = true; break;
      case 0x2c: this.x = this.x0; this.y = this.y0; break;          // memory write
      case 0x04: this.readQueue = [0x00, 0x00, 0x93, 0x41]; break;    // read display ID
      case 0x09: this.readQueue = [0x00, 0x84, 0x53, 0x04, 0x00]; break;
      case 0x0a: this.readQueue = [0x00, this.on ? 0x9c : 0x08]; break;
      case 0x0b: this.readQueue = [0x00, this.madctl]; break;
      case 0x0c: this.readQueue = [0x00, 0x05]; break;
      case 0x0f: this.readQueue = [0x00, 0xc0]; break;
      case 0xd3: this.readQueue = [0x00, 0x00, 0x93, 0x41]; break;    // read ID4
      default: break;
    }
    if (byte >= 0xda && byte <= 0xdc) this.readQueue = [0x00, [0x00, 0x93, 0x41][byte - 0xda]];
  }

  _arg() {
    const a = this.args;
    if (this.cmd === 0x2a && a.length === 4) {
      this.x0 = (a[0] << 8) | a[1];
      this.x1 = (a[2] << 8) | a[3];
      this.x = this.x0;
    } else if (this.cmd === 0x2b && a.length === 4) {
      this.y0 = (a[0] << 8) | a[1];
      this.y1 = (a[2] << 8) | a[3];
      this.y = this.y0;
    } else if (this.cmd === 0x36 && a.length === 1) {
      this.madctl = a[0];
    }
  }

  _pixel(color) {
    // Logical (column, page) → panel (x, y) per MADCTL MY/MX/MV.
    const my = this.madctl & 0x80;
    const mx = this.madctl & 0x40;
    const mv = this.madctl & 0x20;
    let px = mv ? this.y : this.x;
    let py = mv ? this.x : this.y;
    if (mx) px = W - 1 - px;
    if (my) py = H - 1 - py;
    if (px >= 0 && px < W && py >= 0 && py < H) {
      this.fb[py * W + px] = color;
      this.dirty = true;
    }
    if (++this.x > this.x1) {
      this.x = this.x0;
      if (++this.y > this.y1) this.y = this.y0;
    }
  }

  /** Paint into an RGBA ImageData-like buffer (240×320). */
  render(image) {
    const d = image.data;
    const bgr = !!(this.madctl & 0x08);
    for (let i = 0; i < this.fb.length; i++) {
      let c = this.fb[i];
      if (this.inverted) c = ~c & 0xffff;
      let r = ((c >> 11) & 0x1f) * 255 / 31;
      const g = ((c >> 5) & 0x3f) * 255 / 63;
      let b = (c & 0x1f) * 255 / 31;
      if (!bgr) [r, b] = [b, r]; // the glass is BGR; drivers set the BGR bit to correct it
      const o = i * 4;
      if (this.on) { d[o] = r; d[o + 1] = g; d[o + 2] = b; } else { d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; }
      d[o + 3] = 255;
    }
    this.dirty = false;
  }
}
