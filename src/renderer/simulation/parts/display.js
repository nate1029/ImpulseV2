// Display parts: 7-segment, character LCDs, SSD1306 OLED, NeoPixels,
// ILI9341 TFT and MAX7219 LED matrix.

import { Behavior } from './behavior.js';
import { HD44780 } from '../hd44780.js';
import { SSD1306 } from '../devices/ssd1306.js';
import { ILI9341 } from '../devices/ili9341.js';
import { MAX7219 } from '../devices/shift.js';
import { WS2812Decoder } from '../devices/ws2812.js';
import { TM1637 } from '../devices/tm1637.js';
// Just the font: the package index would load every element.
import { fontA00 } from '@wokwi/elements/dist/esm/lcd1602-font-a00.js';

const SEGMENTS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP'];

/**
 * Seven-segment display, 1-4 digits, common anode or cathode. Multiplexed
 * digits are integrated over each frame (persistence of vision).
 */
export class SevenSegmentBehavior extends Behavior {
  start() {
    const digits = Math.max(1, Math.min(4, this.ctx.attr('digits', 1)));
    this.digits = digits;
    this.anode = this.ctx.attr('common', 'anode') !== 'cathode';
    this.digPins = digits === 1 ? ['COM.1'] : Array.from({ length: digits }, (_, i) => `DIG${i + 1}`);
    this.acc = new Float64Array(digits * 8 + 1);
    this.lit = new Uint8Array(digits * 8 + 1);
    this.lastT = this.ctx.now();
    this._compute();
  }

  _on(pin, activeHigh) {
    const lv = this.ctx.level(pin);
    return lv === null ? false : (lv === 1) === activeHigh;
  }

  _compute() {
    const segActive = !this.anode; // anode: segments sink (LOW); cathode: segments source (HIGH)
    const seg = SEGMENTS.map(s => this._on(s, segActive));
    for (let d = 0; d < this.digits; d++) {
      const digitOn = this._on(this.digPins[d], this.anode);
      for (let s = 0; s < 8; s++) this.lit[d * 8 + s] = digitOn && seg[s] ? 1 : 0;
    }
    if (this.digits === 4) this.lit[32] = this._on('CLN', segActive) && this._on('COM', this.anode) ? 1 : 0;
  }

  _integrate() {
    const t = this.ctx.now();
    const dt = t - this.lastT;
    if (dt > 0) for (let i = 0; i < this.lit.length; i++) if (this.lit[i]) this.acc[i] += dt;
    this.lastT = t;
  }

  onPin() {
    this._integrate();
    this._compute();
  }

  frame(dt) {
    this._integrate();
    if (!(dt > 0)) return;
    const values = [];
    for (let i = 0; i < this.digits * 8; i++) values.push(this.acc[i] / dt > 0.06 ? 1 : 0);
    if (values.join() !== (this.el.values || []).join()) this.el.values = values;
    if (this.digits === 4) this.el.colonValue = this.acc[32] / dt > 0.06;
    this.acc.fill(0);
    this._compute();
  }

  stop() {
    this.el.values = new Array((this.digits || 1) * 8).fill(0);
    this.el.colonValue = false;
  }
}

/** HD44780 LCD 16x2 / 20x4, either I²C backpack or parallel 4/8-bit bus. */
export class LcdBehavior extends Behavior {
  start() {
    const big = this.el.tagName.toLowerCase() === 'wokwi-lcd2004';
    this.lcd = new HD44780(big ? 20 : 16, big ? 4 : 2);
    this.i2cMode = (this.ctx.attr('pins', 'full')) === 'i2c';
    this._fontVersion = -1;
    this._dirty = true;
    this.lcd.onChange = () => { this._dirty = true; };
    if (this.i2cMode) {
      const address = parseInt(this.ctx.attr('i2cAddress', '0x27'), 16) || 0x27;
      this.address = address;
      this.ctx.i2c(address, {
        i2cConnect: () => true,
        i2cWrite: (byte) => { this.lcd.writePcf(byte); return true; },
        i2cRead: () => this.lcd.readPcf(),
      });
    } else {
      this.eightBit = ['D0', 'D1', 'D2', 'D3'].every(p => this.ctx.connected(p));
      this._enHigh = false;
    }
  }

  // Parallel bus: latch on the E falling edge.
  onPin(pin) {
    if (this.i2cMode || pin !== 'E') return;
    const en = this.ctx.level('E') === 1;
    if (this._enHigh && !en) {
      const rs = this.ctx.level('RS') === 1;
      const bit = (p) => (this.ctx.level(p) === 1 ? 1 : 0);
      const hi = bit('D4') | (bit('D5') << 1) | (bit('D6') << 2) | (bit('D7') << 3);
      if (this.eightBit) {
        const lo = bit('D0') | (bit('D1') << 1) | (bit('D2') << 2) | (bit('D3') << 3);
        this.lcd.writeParallelByte(rs, (hi << 4) | lo);
      } else {
        this.lcd.writeParallelNibble(rs, hi);
      }
    }
    this._enHigh = en;
  }

  frame() {
    if (!this.i2cMode) {
      const a = this.ctx.fraction('A');
      const k = this.ctx.fraction('K');
      const lit = a !== null && k !== null ? a * (1 - k) > 0.05 : false;
      this.lcd.backlight = lit || (!this.ctx.connected('A') && !this.ctx.connected('K'));
    }
    if (!this._dirty) return;
    this._dirty = false;
    const el = this.el;
    el.characters = this.lcd.toCharacters();
    el.backlight = this.lcd.backlight;
    const cell = this.lcd.cursorCell();
    el.cursor = this.lcd.displayOn && this.lcd.cursorOn && !!cell;
    el.blink = this.lcd.displayOn && this.lcd.blinkOn && !!cell;
    if (cell) { el.cursorX = cell.x; el.cursorY = cell.y; }
    if (this.lcd.cgramVersion !== this._fontVersion) {
      this._fontVersion = this.lcd.cgramVersion;
      el.font = this.lcd.patchFont(fontA00);
    }
  }

  stop() {
    const el = this.el;
    el.characters = new Uint8Array((this.lcd?.cols || 16) * (this.lcd?.rows || 2)).fill(0x20);
    el.cursor = false;
    el.blink = false;
    el.backlight = true;
    el.font = fontA00;
  }

  status() {
    if (!this.lcd) return null;
    const mode = this.i2cMode ? `I²C 0x${this.address.toString(16)}` : `parallel ${this.eightBit ? '8' : '4'}-bit`;
    return `${mode} · ${this.lcd.displayOn ? 'display on' : 'display off'}`;
  }
}

/**
 * Bit-banged SPI receiver: shifts MOSI on SCK rising edges while CS is LOW,
 * for libraries that drive SPI devices from plain GPIO.
 */
class SoftSpi {
  constructor(onByte) {
    this.onByte = onByte;
    this.bits = 0;
    this.value = 0;
    this.lastClk = false;
  }

  clock(clkHigh, dataBit) {
    if (clkHigh && !this.lastClk) {
      this.value = ((this.value << 1) | dataBit) & 0xff;
      if (++this.bits === 8) {
        this.onByte(this.value);
        this.bits = 0;
        this.value = 0;
      }
    }
    this.lastClk = clkHigh;
  }

  resync() {
    this.bits = 0;
    this.value = 0;
  }
}

/** SSD1306 128×64 OLED over I²C (default) or SPI (when CS and DC are wired). */
export class Ssd1306Behavior extends Behavior {
  start() {
    this.oled = new SSD1306(128, 64);
    this.address = parseInt(this.ctx.attr('i2cAddress', '0x3c'), 16) || 0x3c;
    this.ctx.i2c(this.address, this.oled);
    this.spiMode = this.ctx.connected('CS') && this.ctx.connected('DC');
    if (this.spiMode) {
      this.ctx.spi({
        selected: () => this.ctx.level('CS') === 0 && this.ctx.onSpiPin('CLK', 'sck'),
        transfer: (byte) => { this._byte(byte); return 0xff; },
      });
      this.soft = new SoftSpi((b) => this._byte(b));
    }
    this._rst = this.ctx.level('RST');
  }

  _byte(byte) {
    if (this.ctx.level('DC') === 1) this.oled.data(byte);
    else this.oled.command(byte);
  }

  onPin(pin) {
    if (pin === 'RST') {
      const rst = this.ctx.level('RST');
      if (rst === 0 && this._rst !== 0) this.oled.reset();
      this._rst = rst;
      return;
    }
    if (!this.spiMode) return;
    if (pin === 'CS' && this.ctx.level('CS') === 1) this.soft.resync();
    if (pin === 'CLK' && this.ctx.level('CS') === 0 && !this.ctx.onSpiPin('CLK', 'sck')) {
      this.soft.clock(this.ctx.level('CLK') === 1, this.ctx.level('DATA') === 1 ? 1 : 0);
    }
  }

  frame() {
    if (!this.oled.dirty) return;
    const el = this.el;
    if (!el.imageData) return;
    this.oled.render(el.imageData);
    el.redraw?.();
  }

  stop() {
    const el = this.el;
    if (el.imageData) {
      el.imageData.data.fill(0);
      for (let i = 3; i < el.imageData.data.length; i += 4) el.imageData.data[i] = 255;
      el.redraw?.();
    }
  }

  status() {
    if (!this.oled) return null;
    return `${this.spiMode ? 'SPI' : `I²C 0x${this.address.toString(16)}`} · ${this.oled.on ? 'display on' : 'display off'}`;
  }
}

/** Shared NeoPixel logic: decode DIN, keep N pixels, pass the rest down DOUT. */
class NeoPixelBase extends Behavior {
  get count() { return 1; }

  start() {
    this.pixels = new Array(this.count).fill(null).map(() => ({ r: 0, g: 0, b: 0 }));
    this.decoder = new WS2812Decoder((bytes) => this.receive(bytes));
    this._dirty = true;
  }

  onPin(pin, high, cycles) {
    if (pin === 'DIN') this.decoder.edge(high, cycles);
  }

  receive(bytes) {
    const n = this.count;
    for (let i = 0; i < n && i * 3 + 2 < bytes.length; i++) {
      const o = i * 3;
      this.pixels[i] = { g: bytes[o], r: bytes[o + 1], b: bytes[o + 2] };
    }
    this._dirty = true;
    if (bytes.length > n * 3) {
      const rest = bytes.subarray(n * 3);
      for (const next of this.ctx.engine.behaviorsOnNet(this.ctx.net('DOUT'), 'DIN', this.ctx.id)) next.receive?.(rest);
    }
  }

  frame() {
    this.decoder.poll(this.ctx.cycles());
    if (!this._dirty) return;
    this._dirty = false;
    this.paint();
  }

  stop() {
    this.pixels = (this.pixels || []).map(() => ({ r: 0, g: 0, b: 0 }));
    this.paint();
  }

  status() {
    const lit = (this.pixels || []).filter(p => p.r || p.g || p.b).length;
    return `${lit} of ${this.count} pixel${this.count === 1 ? '' : 's'} lit`;
  }
}

// Perceived brightness: the eye sees a dim PWM-driven LED as much brighter
// than its duty cycle, so map 0-255 through a display gamma.
const unit = (v) => Math.pow(v / 255, 0.45);

export class NeoPixelBehavior extends NeoPixelBase {
  paint() {
    const p = this.pixels[0];
    this.el.r = unit(p.r);
    this.el.g = unit(p.g);
    this.el.b = unit(p.b);
  }
}

export class LedRingBehavior extends NeoPixelBase {
  get count() { return Math.max(1, this.ctx.attr('pixels', 16)); }

  paint() {
    this.pixels.forEach((p, i) => this.el.setPixel?.(i, { r: unit(p.r), g: unit(p.g), b: unit(p.b) }));
  }
}

export class NeoMatrixBehavior extends NeoPixelBase {
  get count() { return this.ctx.attr('rows', 8) * this.ctx.attr('cols', 8); }

  paint() {
    const rows = this.ctx.attr('rows', 8);
    const cols = this.ctx.attr('cols', 8);
    const serpentine = this.ctx.attr('layout', '') === 'serpentine';
    this.pixels.forEach((p, i) => {
      const row = Math.floor(i / cols);
      let col = i % cols;
      if (serpentine && row % 2 === 1) col = cols - 1 - col;
      if (row < rows) this.el.setPixel?.(row, col, { r: unit(p.r), g: unit(p.g), b: unit(p.b) });
    });
  }
}

/** ILI9341 2.8" TFT over SPI. */
export class Ili9341Behavior extends Behavior {
  start() {
    this.tft = new ILI9341();
    this.ctx.spi({
      selected: () => this.ctx.level('CS') === 0 && this.ctx.onSpiPin('SCK', 'sck'),
      transfer: (byte) => this.tft.transfer(byte, this.ctx.level('D/C') === 1),
    });
    this.soft = new SoftSpi((b) => this.tft.transfer(b, this.ctx.level('D/C') === 1));
    this._rst = this.ctx.level('RST');
  }

  onPin(pin) {
    if (pin === 'RST') {
      const rst = this.ctx.level('RST');
      if (rst === 0 && this._rst !== 0) this.tft.reset();
      this._rst = rst;
    } else if (pin === 'CS' && this.ctx.level('CS') === 1) {
      this.soft.resync();
    } else if (pin === 'SCK' && this.ctx.level('CS') === 0 && !this.ctx.onSpiPin('SCK', 'sck')) {
      this.soft.clock(this.ctx.level('SCK') === 1, this.ctx.level('MOSI') === 1 ? 1 : 0);
    }
  }

  frame() {
    if (!this.tft.dirty) return;
    const canvas = this.el.canvas;
    const g = canvas?.getContext('2d');
    if (!g) return;
    if (!this._image) this._image = g.createImageData(240, 320);
    this.tft.render(this._image);
    g.putImageData(this._image, 0, 0);
  }

  stop() {
    const g = this.el.canvas?.getContext('2d');
    if (g) { g.fillStyle = '#000'; g.fillRect(0, 0, 240, 320); }
  }

  status() {
    return this.tft?.on ? 'Display on' : 'Display off (waiting for init)';
  }
}

/**
 * MAX7219 8×8 LED matrix module (LedControl, MD_MAX72XX). Accepts hardware
 * SPI or bit-banged DIN/CLK, latches on CS rising and daisy-chains via DOUT.
 */
export class Max7219Behavior extends Behavior {
  start() {
    this.chip = new MAX7219();
    this._clk = false;
    this._cs = this.ctx.level('CS');
    this._out = 0;
    this.ctx.drive('DOUT', 0);
    this.ctx.spi({
      selected: () => this.ctx.level('CS') === 0 && this.ctx.onSpiPin('CLK', 'sck') && this.ctx.onSpiPin('DIN', 'mosi'),
      transfer: (byte) => { this.spiIn(byte); return 0xff; },
    });
  }

  // Hardware SPI: bytes pushed out of this chip continue to the next module.
  spiIn(byte) {
    const out = this.chip.byte(byte);
    for (const next of this.ctx.engine.behaviorsOnNet(this.ctx.net('DOUT'), 'DIN', this.ctx.id)) next.spiIn?.(out);
  }

  onPin(pin) {
    const ctx = this.ctx;
    if (pin === 'CLK') {
      const clk = ctx.level('CLK') === 1;
      if (clk && !this._clk && !ctx.onSpiPin('CLK', 'sck')) {
        this._out = this.chip.clock(ctx.level('DIN') === 1);
      } else if (!clk && this._clk) {
        ctx.drive('DOUT', this._out); // DOUT changes on the falling edge
      }
      this._clk = clk;
    } else if (pin === 'CS') {
      const cs = ctx.level('CS');
      if (cs === 1 && this._cs === 0) this.chip.load();
      this._cs = cs;
    }
  }

  frame() {
    if (!this.chip.dirty) return;
    this.chip.dirty = false;
    const leds = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) leds.push(this.chip.led(r, c) ? 1 : 0);
    this.el.values = leds;
    this.el.intensity = this.chip.intensity;
  }

  stop() {
    this.el.values = new Array(64).fill(0);
  }
}

/** TM1637 4-digit display module (pull-ups on CLK and DIO are on the board). */
export class Tm1637Behavior extends Behavior {
  pullups() { return [['CLK', 10000], ['DIO', 10000]]; }

  start() {
    this.chip = new TM1637();
    this.clk = this.ctx.level('CLK') !== 0;
    this.dio = this.ctx.level('DIO') !== 0;
    this.dirty = true;
    this.frame();
  }

  stop() {
    this.el.on = false;
  }

  onPin() {
    const clk = this.ctx.level('CLK') !== 0;
    const dio = this.ctx.level('DIO') !== 0;
    const chip = this.chip;
    if (clk && this.clk && dio !== this.dio) {
      if (dio) { chip.stop(); this.dirty = true; } else chip.start();
    } else if (clk && !this.clk) {
      chip.clockRise(dio);
    } else if (!clk && this.clk) {
      const act = chip.clockFall();
      if (act === 'ack') this.ctx.drive('DIO', 0);
      else if (act === 'release') { this.ctx.drive('DIO', null); this.dirty = true; }
    }
    this.clk = clk;
    this.dio = this.ctx.level('DIO') !== 0;
  }

  frame() {
    if (!this.dirty) return;
    this.dirty = false;
    this.el.segments = this.chip.digits.slice(0, 4);
    this.el.brightness = this.chip.brightness;
    this.el.on = this.chip.on;
  }

  status() {
    return this.chip?.on ? `On · brightness ${this.chip.brightness}/7` : 'Display off';
  }
}
