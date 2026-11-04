// DS18B20 1-Wire thermometer, bit by bit: the ROM layer (read, match, skip,
// search, alarm search) and the function commands (convert T, read/write/copy
// scratchpad, recall EEPROM, read power supply). The part behavior turns bus
// edges into slots; this class decides what the device does in each one.

/** Dallas/Maxim CRC-8 (x^8 + x^5 + x^4 + 1, LSB first). */
export function crc8(bytes) {
  let crc = 0;
  for (let b of bytes) {
    for (let i = 0; i < 8; i++) {
      const mix = (crc ^ b) & 1;
      crc >>= 1;
      if (mix) crc ^= 0x8c;
      b >>= 1;
    }
  }
  return crc;
}

/** A stable 64-bit ROM code (family 0x28) derived from a part id. */
export function romFor(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const rom = [0x28];
  for (let i = 0; i < 6; i++) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    rom.push(h & 0xff);
  }
  rom.push(crc8(rom));
  return rom;
}

const CONVERSION_S = { 9: 0.09375, 10: 0.1875, 11: 0.375, 12: 0.75 };

const bitsOf = (bytes) => bytes.flatMap(b => [0, 1, 2, 3, 4, 5, 6, 7].map(i => (b >> i) & 1));
const signed8 = (b) => (b & 0x80 ? b - 256 : b);

export class Ds18b20 {
  /**
   * @param {number[]} rom 8-byte ROM code
   * @param {() => number} readTemperature current temperature in °C
   */
  constructor(rom, readTemperature) {
    this.rom = rom;
    this.readTemperature = readTemperature;
    this.romBits = bitsOf(rom);
    this.th = 75;
    this.tl = 70;
    this.config = 0x7f;
    this.eeprom = { th: 75, tl: 70, config: 0x7f };
    this.raw = 85 * 16; // power-on value of the temperature register
    this._pending = null;
    this._doneAt = 0;
    this.mode = 'idle';
    this._rx = [];
    this._bits = 0;
    this._byte = 0;
  }

  get resolution() {
    return 9 + ((this.config >> 5) & 3);
  }

  conversionTime() {
    return CONVERSION_S[this.resolution];
  }

  /** Latch a finished conversion (call before reading the scratchpad). */
  tick(now) {
    if (this._pending !== null && now >= this._doneAt) this._latch();
  }

  _latch() {
    const t = Math.max(-55, Math.min(125, this._pending));
    const drop = 12 - this.resolution; // undefined low bits read as 0
    this.raw = (Math.round(t * 16) >> drop) << drop;
    this._pending = null;
  }

  get alarm() {
    const t = this.raw / 16;
    return t > signed8(this.th) || t < signed8(this.tl);
  }

  scratchpad() {
    const v = this.raw & 0xffff;
    const bytes = [v & 0xff, v >> 8, this.th & 0xff, this.tl & 0xff, this.config, 0xff, 0x0c, 0x10];
    return [...bytes, crc8(bytes)];
  }

  /** The master held the bus low long enough for a reset: answer with presence. */
  reset() {
    this.mode = 'rom';
    this._bits = 0;
    this._byte = 0;
    this._rx = [];
  }

  /** True when the next slot is one the device answers (a read slot). */
  get answering() {
    return this.mode === 'tx' || this.mode === 'convert' || this.mode === 'status'
      || (this.mode === 'search' && this._phase < 2);
  }

  /**
   * A read slot: the bit the device puts on the bus (0 pulls the line low).
   * @param {number} now seconds
   */
  readSlot(now) {
    switch (this.mode) {
      case 'tx': {
        const bit = this._tx.shift();
        if (!this._tx.length) this.mode = this._after;
        return bit;
      }
      case 'convert':
        this.tick(now);
        return this._pending === null ? 1 : 0;
      case 'status':
        return 1; // externally powered / recall finished
      case 'search': {
        const bit = this.romBits[this._index];
        return this._phase++ === 0 ? bit : 1 - bit;
      }
      default:
        return 1;
    }
  }

  /** A write slot from the master. */
  writeSlot(bit, now) {
    if (this.mode === 'search') {
      if (this._phase !== 2) return;
      if (bit !== this.romBits[this._index]) { this.mode = 'idle'; return; }
      this._index++;
      this._phase = 0;
      if (this._index === 64) this.mode = 'func';
      return;
    }
    if (!['rom', 'match', 'func', 'write'].includes(this.mode)) return;
    this._byte |= bit << this._bits;
    if (++this._bits < 8) return;
    const byte = this._byte;
    this._bits = 0;
    this._byte = 0;
    this._onByte(byte, now);
  }

  _send(bytes, after = 'idle') {
    this._tx = bitsOf(bytes);
    this._after = after;
    this.mode = 'tx';
  }

  _onByte(byte, now) {
    switch (this.mode) {
      case 'rom':
        if (byte === 0x33) this._send(this.rom, 'func');
        else if (byte === 0x55) { this.mode = 'match'; this._rx = []; }
        else if (byte === 0xcc) this.mode = 'func';
        else if (byte === 0xf0 || (byte === 0xec && this.alarm)) { this.mode = 'search'; this._index = 0; this._phase = 0; }
        else this.mode = 'idle';
        break;
      case 'match':
        this._rx.push(byte);
        if (this._rx.length === 8) this.mode = this._rx.every((b, i) => b === this.rom[i]) ? 'func' : 'idle';
        break;
      case 'func':
        this.tick(now);
        if (byte === 0x44) {
          this._pending = this.readTemperature();
          this._doneAt = now + this.conversionTime();
          this.mode = 'convert';
        } else if (byte === 0xbe) {
          this._send(this.scratchpad());
        } else if (byte === 0x4e) {
          this.mode = 'write';
          this._rx = [];
        } else if (byte === 0x48) {
          this.eeprom = { th: this.th, tl: this.tl, config: this.config };
          this.mode = 'idle';
        } else if (byte === 0xb8) {
          ({ th: this.th, tl: this.tl, config: this.config } = this.eeprom);
          this.mode = 'status';
        } else if (byte === 0xb4) {
          this.mode = 'status';
        } else {
          this.mode = 'idle';
        }
        break;
      case 'write':
        this._rx.push(byte);
        if (this._rx.length === 3) {
          [this.th, this.tl] = this._rx;
          this.config = (this._rx[2] & 0x60) | 0x1f;
          this.mode = 'idle';
        }
        break;
      default:
        break;
    }
  }
}
