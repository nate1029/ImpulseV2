// Sensors: ultrasonic, DHT, DS18B20, PIR, light, temperature, gas, flame,
// sound, heartbeat, IMU, RTC, load cell. Live values come from the inspector and are
// saved in the part's attrs (Wokwi-compatible names where they exist).

import { Behavior, PinState, clamp, playWaveform } from './behavior.js';
import { dhtWaveform, DHT_START_US } from '../devices/dht.js';
import { DS1307, MPU6050 } from '../devices/i2c-registers.js';
import { Ds18b20, romFor } from '../devices/ds18b20.js';

/** HC-SR04: a ≥10 µs TRIG pulse makes ECHO go HIGH for 58 µs per cm. */
export class UltrasonicBehavior extends Behavior {
  start() {
    this.ctx.drive('ECHO', 0);
    this._trigAt = -1;
    this._busy = false;
    this._pings = 0;
  }

  onPin(pin) {
    if (pin !== 'TRIG') return;
    const level = this.ctx.level('TRIG');
    const t = this.ctx.now();
    if (level === 1) {
      this._trigAt = t;
      return;
    }
    if (this._trigAt < 0) return;
    const width = t - this._trigAt;
    this._trigAt = -1;
    if (width < 8e-6 || this._busy) return;
    this._busy = true;
    // ECHO stays HIGH 58 µs per cm (the round trip used by the Arduino
    // reference code: duration / 58, or / 29 / 2). Half a centimetre is added
    // and 0.5 % for the millis() interrupt that pauses pulseIn() while it
    // counts, so those formulas read back exactly the distance set here.
    // Beyond the 4 m range the module times out with a 38 ms pulse.
    const distance = this.ctx.attr('distance', 100);
    const echo = distance > 400 ? 38e-3 : ((clamp(distance, 2, 400) + 0.5) * 58e-6) / 0.995;
    // 8 × 40 kHz burst first, then the echo pulse.
    this.ctx.schedule(250e-6, () => {
      this.ctx.drive('ECHO', 1);
      this.ctx.schedule(echo, () => {
        this.ctx.drive('ECHO', 0);
        this._busy = false;
        this._pings++;
      });
    });
  }

  control() { this.ctx.changed(); }

  status() {
    return `Distance ${Math.round(this.ctx.attr('distance', 100))} cm · ${this._pings || 0} pings answered`;
  }
}

/** DHT11 / DHT22 temperature and humidity sensor. */
export class DhtBehavior extends Behavior {
  start() {
    this._lowAt = -1;
    this._busy = false;
    this.reads = 0;
  }

  pullups() {
    return [['SDA', 10000]];
  }

  get model() {
    return this.ctx.attr('model', 'dht22') === 'dht11' ? 'dht11' : 'dht22';
  }

  onPin(pin) {
    if (pin !== 'SDA' || this._busy) return;
    const state = this.ctx.mcuState('SDA');
    const t = this.ctx.now();
    if (state === PinState.Low) {
      if (this._lowAt < 0) this._lowAt = t;
      return;
    }
    if (this._lowAt < 0) return;
    const lowUs = (t - this._lowAt) * 1e6;
    this._lowAt = -1;
    if (lowUs < DHT_START_US[this.model]) return;
    this._busy = true;
    const temp = this.ctx.attr('temperature', 24);
    const hum = this.ctx.attr('humidity', 40);
    playWaveform(this.ctx, 'SDA', dhtWaveform(this.model, temp, hum), {
      openDrain: true,
      idle: null,
      onDone: () => { this._busy = false; this.reads++; },
    });
  }

  control() { this.ctx.changed(); }

  status() {
    return `${this.model.toUpperCase()} · ${this.ctx.attr('temperature', 24)} °C · ${this.ctx.attr('humidity', 40)} % RH · ${this.reads || 0} reads`;
  }
}

/** PIR: OUT goes HIGH for `delayTime` seconds after motion. */
export class PirBehavior extends Behavior {
  start() {
    this.ctx.drive('OUT', 0);
    this.timer = null;
    this.motion = false;
  }

  trigger() {
    this.ctx.cancel(this.timer);
    this.motion = true;
    this.ctx.drive('OUT', 1);
    this.ctx.changed();
    this.timer = this.ctx.schedule(this.ctx.attr('delayTime', 5), () => {
      this.motion = false;
      this.ctx.drive('OUT', 0);
      this.ctx.changed();
    });
  }

  press() { this.trigger(); }

  control(key) {
    if (key === 'motion') this.trigger();
  }

  status() {
    return this.motion ? 'Motion detected · OUT HIGH' : 'No motion · click the sensor to trigger';
  }
}

/** Photoresistor module: AO falls as light rises; DO is LOW when bright. */
export class PhotoresistorBehavior extends Behavior {
  start() { this.apply(); }

  apply() {
    const lux = Math.max(0.1, this.ctx.attr('lux', 500));
    const gamma = this.ctx.attr('gamma', 0.7);
    const rl10 = this.ctx.attr('rl10', 50) * 1000;
    const r = rl10 * Math.pow(10, gamma) / Math.pow(lux, gamma);
    const v = 5 * r / (r + 2000);
    this.volts = v;
    this.ctx.driveVolts('AO', v, 100);
    const bright = v < this.ctx.attr('threshold', 2.5);
    this.ctx.drive('DO', bright ? 0 : 1);
    this.el.ledDO = bright;
    this.el.ledPower = true;
    this.ctx.changed();
  }

  control() { this.apply(); }

  stop() {
    this.el.ledDO = false;
    this.el.ledPower = false;
  }

  status() {
    return `${this.ctx.attr('lux', 500)} lux · AO ${this.volts?.toFixed(2) ?? '–'} V (≈${Math.round((this.volts || 0) / 5 * 1023)})`;
  }
}

/** NTC thermistor module (10 kΩ, β 3950) on the low side of a 10 kΩ divider. */
export class NtcBehavior extends Behavior {
  start() { this.apply(); }

  apply() {
    const t = this.ctx.attr('temperature', 24) + 273.15;
    const beta = this.ctx.attr('beta', 3950);
    const r = 10000 * Math.exp(beta * (1 / t - 1 / 298.15));
    this.volts = 5 * r / (r + 10000);
    this.ctx.driveVolts('OUT', this.volts, 100);
    this.ctx.changed();
  }

  control() { this.apply(); }

  status() {
    return `${this.ctx.attr('temperature', 24)} °C · OUT ${this.volts?.toFixed(2) ?? '–'} V`;
  }
}

/** LM35: 10 mV per °C. */
export class Lm35Behavior extends Behavior {
  start() { this.apply(); }

  apply() {
    this.volts = clamp(this.ctx.attr('temperature', 24) * 0.01, 0, 1.5);
    this.ctx.driveVolts('VOUT', this.volts, 100);
    this.ctx.changed();
  }

  control() { this.apply(); }

  status() {
    return `${this.ctx.attr('temperature', 24)} °C · VOUT ${(this.volts * 1000).toFixed(0)} mV`;
  }
}

/** Analog module with a comparator output (gas, flame, sound, soil moisture). */
export class AnalogModuleBehavior extends Behavior {
  /** Override: { key, def, volts(value) → V, active(value, volts) → bool, aout, dout, activeLow, led } */
  get spec() { return null; }

  start() { this.apply(); }

  apply() {
    const s = this.spec;
    const value = this.ctx.attr(s.key, s.def);
    const v = clamp(s.volts(value), 0, 5);
    const active = s.active(value, v);
    this.volts = v;
    this.active = active;
    this.ctx.driveVolts(s.aout, v, 100);
    if (s.dout) this.ctx.drive(s.dout, active === !s.activeLow ? 1 : 0);
    if (s.led) this.el[s.led] = active;
    if (s.power) this.el[s.power] = true;
    this.ctx.changed();
  }

  control() { this.apply(); }

  stop() {
    const s = this.spec;
    if (s.led) this.el[s.led] = false;
    if (s.power) this.el[s.power] = false;
  }

  status() {
    const s = this.spec;
    return `${s.label(this.ctx.attr(s.key, s.def))} · ${s.aout} ${this.volts?.toFixed(2) ?? '–'} V${s.dout ? ` · ${s.dout} ${this.active === !s.activeLow ? 'HIGH' : 'LOW'}` : ''}`;
  }
}

export class GasBehavior extends AnalogModuleBehavior {
  get spec() {
    return {
      key: 'ppm', def: 400, aout: 'AOUT', dout: 'DOUT', activeLow: true, led: 'ledD0', power: 'ledPower',
      volts: (ppm) => 0.2 + 4.6 * Math.log10(clamp(ppm, 100, 10000) / 100) / 2,
      active: (ppm, v) => v >= this.ctx.attr('threshold', 2.5),
      label: (ppm) => `${Math.round(ppm)} ppm`,
    };
  }
}

export class FlameBehavior extends AnalogModuleBehavior {
  get spec() {
    return {
      key: 'flame', def: 0, aout: 'AOUT', dout: 'DOUT', activeLow: true, led: 'ledSignal', power: 'ledPower',
      volts: (f) => 4.8 - clamp(f, 0, 100) / 100 * 4.5,
      active: (f, v) => v <= this.ctx.attr('threshold', 2.5),
      label: (f) => (f > 0 ? `Flame ${Math.round(f)}%` : 'No flame'),
    };
  }
}

export class SoundBehavior extends AnalogModuleBehavior {
  get spec() {
    return {
      key: 'level', def: 20, aout: 'AOUT', dout: 'DOUT', activeLow: false, led: 'led2', power: 'led1',
      volts: (l) => 0.3 + clamp(l, 0, 100) / 100 * 4.4,
      active: (l) => l >= this.ctx.attr('threshold', 60),
      label: (l) => `Sound ${Math.round(l)}%`,
    };
  }
}

export class SoilBehavior extends AnalogModuleBehavior {
  get spec() {
    return {
      key: 'moisture', def: 40, aout: 'AO', dout: 'DO', activeLow: true,
      // Resistive probe: wetter soil conducts more and lowers AO.
      volts: (m) => 4.7 - clamp(m, 0, 100) / 100 * 3.5,
      active: (m) => m >= this.ctx.attr('threshold', 50),
      label: (m) => `Moisture ${Math.round(m)}%`,
    };
  }
}

/** Pulse sensor: one 100 ms HIGH pulse per beat. */
export class HeartbeatBehavior extends Behavior {
  start() {
    this.ctx.drive('OUT', 0);
    this.beats = 0;
    const beat = () => {
      this.ctx.drive('OUT', 1);
      this.beats++;
      this.ctx.schedule(0.1, () => this.ctx.drive('OUT', 0));
      this.ctx.schedule(60 / clamp(this.ctx.attr('bpm', 72), 20, 220), beat);
    };
    this.ctx.schedule(0.5, beat);
  }

  control() { this.ctx.changed(); }

  status() {
    return `${this.ctx.attr('bpm', 72)} BPM · ${this.beats || 0} beats`;
  }
}

export class Mpu6050Behavior extends Behavior {
  start() {
    this.imu = new MPU6050();
    this.apply();
    this.address = this.ctx.level('AD0') === 1 ? 0x69 : 0x68;
    this.ctx.i2c(this.address, this.imu);
  }

  apply() {
    const a = (k, d) => this.ctx.attr(k, d);
    this.imu?.set({
      ax: a('accelX', 0), ay: a('accelY', 0), az: a('accelZ', 1),
      gx: a('rotationX', 0), gy: a('rotationY', 0), gz: a('rotationZ', 0),
      temp: a('temperature', 24),
    });
    this.ctx.changed();
  }

  control() { this.apply(); }

  status() {
    const a = (k, d) => this.ctx.attr(k, d);
    return `I²C 0x${(this.address || 0x68).toString(16)} · accel ${a('accelX', 0)}, ${a('accelY', 0)}, ${a('accelZ', 1)} g`;
  }
}

export class Ds1307Behavior extends Behavior {
  start() {
    this.rtc = new DS1307(() => this.ctx.now());
    this.ctx.i2c(0x68, this.rtc);
    this.ctx.drive('SQW', null);
  }

  status() {
    if (!this.rtc) return 'I²C 0x68 · starts at the current date and time';
    const d = this.rtc.now();
    return `I²C 0x68 · ${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
  }
}

/**
 * HX711 24-bit load-cell ADC: DT LOW means a sample is ready; each SCK pulse
 * shifts one bit out MSB first, extra pulses select the next gain.
 */
export class Hx711Behavior extends Behavior {
  start() {
    this.bit = 0;
    this.sample = 0;
    this._sck = false;
    this.ready();
  }

  ready() {
    const grams = this.ctx.attr('weight', 0);
    const perGram = this.ctx.attr('type', '5kg') === '50kg' ? 42 : 420;
    this.sample = clamp(Math.round(grams * perGram), -0x800000, 0x7fffff) & 0xffffff;
    this.bit = 0;
    this.ctx.drive('DT', 0);
  }

  onPin(pin) {
    if (pin !== 'SCK') return;
    const sck = this.ctx.level('SCK') === 1;
    if (sck && !this._sck) {
      if (this.bit < 24) {
        this.ctx.drive('DT', (this.sample >> (23 - this.bit)) & 1);
      } else if (this.bit === 24) {
        this.ctx.drive('DT', 1);
        this.ctx.schedule(0.0125, () => this.ready()); // 80 samples per second
      }
      this.bit++;
    }
    this._sck = sck;
  }

  control() { this.ctx.changed(); }

  status() {
    return `${this.ctx.attr('weight', 0)} g on the cell`;
  }
}

/**
 * DS18B20 on a 1-Wire bus. Bus edges become slots: a long low is a reset
 * (answered with a presence pulse), short and long lows are write-1 and
 * write-0 slots, and in a read slot the sensor holds the line low to send a 0.
 * The 4.7 kΩ pull-up the bus needs is included.
 */
export class Ds18b20Behavior extends Behavior {
  pullups() { return [['DQ', 4700]]; }

  start() {
    this.dev = new Ds18b20(romFor(this.ctx.id), () => this.ctx.attr('temperature', 22.5));
    this.low = this.ctx.mcuState('DQ') === PinState.Low;
    this.fellAt = 0;
    this.reading = false;
  }

  onPin(pin) {
    if (pin !== 'DQ') return;
    const low = this.ctx.mcuState('DQ') === PinState.Low;
    if (low === this.low) return;
    this.low = low;
    const now = this.ctx.now();
    if (low) {
      this.fellAt = now;
      this.reading = this.dev.answering;
      if (this.reading && this.dev.readSlot(now) === 0) this.pull(0, 30);
      return;
    }
    const width = now - this.fellAt;
    if (width > 400e-6) {
      this.dev.reset();
      this.pull(30, 120); // presence pulse
    } else if (!this.reading) {
      this.dev.writeSlot(width < 15e-6 ? 1 : 0, now);
    }
  }

  /** Hold the bus low for `forUs` µs, starting `afterUs` µs from now. */
  pull(afterUs, forUs) {
    const ctx = this.ctx;
    const go = () => {
      ctx.drive('DQ', 0);
      ctx.schedule(forUs / 1e6, () => ctx.drive('DQ', null));
    };
    if (afterUs) ctx.schedule(afterUs / 1e6, go);
    else go();
  }

  status() {
    return `${this.ctx.attr('temperature', 22.5)} °C · ${this.dev?.resolution ?? 12}-bit`;
  }
}
