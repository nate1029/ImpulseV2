// Register-file I²C devices: DS1307 real-time clock and MPU6050 IMU.
// Both follow the usual pattern: a write sets the register pointer (and
// optionally writes data), a read streams registers with auto-increment.

class RegisterDevice {
  constructor(size) {
    this.regs = new Uint8Array(size);
    this.ptr = 0;
    this._first = false;
  }

  i2cConnect(read) {
    if (!read) this._first = true;
    else this.beforeRead();
    return true;
  }

  i2cWrite(byte) {
    if (this._first) {
      this.ptr = byte % this.regs.length;
      this._first = false;
      return true;
    }
    this.writeReg(this.ptr, byte);
    this.ptr = (this.ptr + 1) % this.regs.length;
    return true;
  }

  i2cRead() {
    const v = this.readReg(this.ptr);
    this.ptr = (this.ptr + 1) % this.regs.length;
    return v;
  }

  i2cStop() { this._first = false; }

  beforeRead() {}
  readReg(addr) { return this.regs[addr]; }
  writeReg(addr, value) { this.regs[addr] = value; }
}

const bcd = (n) => ((Math.floor(n / 10) % 10) << 4) | (n % 10);
const unbcd = (b) => (b >> 4) * 10 + (b & 0x0f);

/**
 * DS1307: registers 0-6 hold BCD seconds..year, 7 is control, 8-0x3F RAM.
 * Time runs from `startDate` plus simulated seconds; writing the time
 * registers sets it (RTClib's adjust()).
 */
export class DS1307 extends RegisterDevice {
  /** @param {() => number} simSeconds */
  constructor(simSeconds, startDate = new Date()) {
    super(64);
    this.simSeconds = simSeconds;
    this.baseMs = startDate.getTime();
    this.baseSim = simSeconds();
    this.halted = false;
    this._pendingTime = null;
  }

  now() {
    return new Date(this.baseMs + (this.simSeconds() - this.baseSim) * 1000);
  }

  beforeRead() {
    if (this.halted) return;
    const d = this.now();
    this.regs[0] = bcd(d.getSeconds());
    this.regs[1] = bcd(d.getMinutes());
    this.regs[2] = bcd(d.getHours());          // 24-hour mode
    this.regs[3] = d.getDay() + 1;             // 1 = Sunday
    this.regs[4] = bcd(d.getDate());
    this.regs[5] = bcd(d.getMonth() + 1);
    this.regs[6] = bcd(d.getFullYear() % 100);
  }

  writeReg(addr, value) {
    this.regs[addr] = value;
    if (addr <= 6) {
      if (addr === 0) this.halted = !!(value & 0x80);
      this._pendingTime = true;
    }
  }

  i2cStop() {
    super.i2cStop();
    if (!this._pendingTime) return;
    this._pendingTime = null;
    const r = this.regs;
    let hours;
    if (r[2] & 0x40) { // 12-hour mode
      hours = unbcd(r[2] & 0x1f) % 12 + (r[2] & 0x20 ? 12 : 0);
    } else {
      hours = unbcd(r[2] & 0x3f);
    }
    const d = new Date(2000 + unbcd(r[6]), unbcd(r[5] & 0x1f) - 1, unbcd(r[4] & 0x3f), hours, unbcd(r[1] & 0x7f), unbcd(r[0] & 0x7f));
    if (!Number.isNaN(d.getTime())) {
      this.baseMs = d.getTime();
      this.baseSim = this.simSeconds();
    }
  }
}

/**
 * MPU6050: accelerometer, gyroscope and temperature from live values,
 * scaled by the configured full-scale ranges.
 */
export class MPU6050 extends RegisterDevice {
  constructor() {
    super(128);
    this.state = { ax: 0, ay: 0, az: 1, gx: 0, gy: 0, gz: 0, temp: 24 };
    this.regs[0x75] = 0x68;  // WHO_AM_I
    this.regs[0x6b] = 0x40;  // PWR_MGMT_1: sleep after reset
  }

  set(values) {
    Object.assign(this.state, values);
  }

  readReg(addr) {
    if (addr >= 0x3b && addr <= 0x48) {
      const accelScale = [16384, 8192, 4096, 2048][(this.regs[0x1c] >> 3) & 3];
      const gyroScale = [131, 65.5, 32.8, 16.4][(this.regs[0x1b] >> 3) & 3];
      const s = this.state;
      const words = [
        s.ax * accelScale, s.ay * accelScale, s.az * accelScale,
        (s.temp - 36.53) * 340,
        s.gx * gyroScale, s.gy * gyroScale, s.gz * gyroScale,
      ];
      const w = Math.max(-32768, Math.min(32767, Math.round(words[(addr - 0x3b) >> 1]))) & 0xffff;
      return (addr - 0x3b) & 1 ? w & 0xff : w >> 8;
    }
    return this.regs[addr];
  }

  writeReg(addr, value) {
    if (addr === 0x75) return; // read-only
    if (addr === 0x6b && value & 0x80) { // device reset
      this.regs.fill(0);
      this.regs[0x75] = 0x68;
      this.regs[0x6b] = 0x40;
      return;
    }
    this.regs[addr] = value;
  }
}
