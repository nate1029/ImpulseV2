// ESP32, ESP32-S3 and ESP32-C3 boards (and the ESP32-S2, built for the S3):
// the firmware runs in Espressif's QEMU, started by the main process. QEMU
// runs in real time on its own, so this runner follows it: the time is the
// firmware's (every message carries micros() from the chip, and a heartbeat
// arrives when nothing else does), parts' timers fire as that time passes, and
// pin activity, PWM, the RGB LED and I²C traffic arrive from the simulator
// bridge compiled into the sketch (src/main/services/esp32sim/impulse_sim.cpp).
// Input levels, analog voltages and I²C replies go back the same way.
//
// Same surface as AvrRunner and Rp2040Runner, except step(): the CPU can't be
// stepped from here, so headless runs wait in real time (runner.realtime).

import { I2CBus, SPIBus, PinState, F_CPU } from './avr-runner.js';
import { boardById } from './boards.js';

const GPIO_COUNT = 64;
// PWM up to this rate is also delivered as edges, for parts that time pulses (servos).
const EDGE_PWM_MAX_HZ = 400;
const ADC_REF = 3.3;

// Arduino-ESP32 pinMode values (esp32-hal-gpio.h).
const MODE_INPUT = 0x01;
const MODE_OUTPUT = 0x03;
const MODE_PULLUP = 0x04;
const MODE_PULLDOWN = 0x08;
const MODE_OPEN_DRAIN = 0x10;

/** The connection to the emulator: Electron's IPC in the app, set by the command-line runner otherwise. */
let bridgeFactory = () => {
  const api = globalThis.window?.electronAPI?.esp32sim;
  if (!api) throw new Error('The ESP32 emulator runs in the Impulse app.');
  return api;
};

/** Use another connection to the emulator (the command-line test runner, tests). */
export function setEsp32Bridge(factory) {
  bridgeFactory = factory;
}

class WatchedI2CBus extends I2CBus {
  constructor(onChange) {
    super();
    this._onChange = onChange;
  }

  add(address, device) { super.add(address, device); this._onChange(); }
  remove(address, device) { super.remove(address, device); this._onChange(); }
  clear() { super.clear(); this._onChange(); }
}

const hex = (bytes) => bytes.map(b => (b & 0xff).toString(16).padStart(2, '0')).join('');
const unhex = (s) => {
  const out = [];
  for (let i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
};

export class Esp32Runner {
  constructor() {
    this.realtime = true;
    this.board = boardById('esp32');
    this.running = false;
    this.i2c = new WatchedI2CBus(() => this._sendDevices());
    this.spiBus = new SPIBus();

    this.onPinChange = null;   // (pin, high, cycles)
    this.onPinState = null;    // (pin, state, cycles)
    this.onSerial = null;      // (char, port)
    this.onError = null;       // (msg)
    this.onReset = null;       // ()
    this.stopCheck = null;
    this.onBreak = null;
    this.onNotice = null;      // (text): starting the emulator, dropped messages

    this._program = null;
    this._session = null;
    this._booting = null;
    this._unsubscribe = null;
    this._outbox = [];
    this._flushQueued = false;
    this._speed = 0;
    this._clearState();
  }

  _clearState() {
    this._now = 0;
    this._lastGuest = 0;
    this._lastWall = 0;
    this._speedMark = null;
    this._timers = [];
    this._mode = new Uint8Array(GPIO_COUNT);
    this._state = new Uint8Array(GPIO_COUNT).fill(PinState.Input);
    this._out = new Array(GPIO_COUNT).fill(false);
    this._external = new Array(GPIO_COUNT).fill(null);
    this._sentLevel = new Array(GPIO_COUNT).fill(undefined);
    this._mv = new Array(GPIO_COUNT).fill(0);
    this._sentMv = new Array(GPIO_COUNT).fill(-1);
    this._pwm = new Array(GPIO_COUNT).fill(null);   // { duty: 0–1, freq, next }
    this._rgb = new Map();                           // pin → [r, g, b]
    this._inputLog = Array.from({ length: GPIO_COUNT }, () => []); // [time, level] of recent input changes
    this._pulseWaits = [];
    this._ready = false;
    this._awaitingBoot = true;  // messages from before a reset are stale
    this._setupAt = null;       // firmware time when setup() started
  }

  /** Simulated time in 16 MHz cycles (the unit the circuit engine uses). */
  get cycles() { return this._now * F_CPU; }
  get time() { return this._now; }
  get speed() { return this._speed; }

  /**
   * @param {{ image: string, chip: string, note?: string }} program  from compileHex: a flash image the main process built
   * @param {string} [boardId]
   */
  load(program, boardId) {
    if (!program?.image) {
      this.onError?.('Failed to load program: no ESP32 flash image');
      return false;
    }
    this.shutdown();
    if (boardId) this.board = boardById(boardId);
    this._program = program;
    this._clearState();
    return true;
  }

  // ── Run control ──────────────────────────────────────────────────────────

  start() {
    if (!this._program || this.running) return;
    this.running = true;
    if (this._session) {
      this._api().control(this._session, 'resume');
      this._lastWall = performance.now();
    } else if (!this._booting) {
      this._booting = this._boot();
    }
  }

  /** Pause (the emulator keeps the chip's state). */
  stop() {
    if (!this.running) return;
    this.running = false;
    if (this._session) this._api().control(this._session, 'pause');
  }

  /** End the emulator process (stop, or a different board). */
  shutdown() {
    this.running = false;
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (this._session) this._api().control(this._session, 'stop');
    this._session = null;
    this._booting = null;
  }

  /** Power-cycle the board. */
  reset() {
    if (!this._session) return;
    this._clearState();
    this._api().control(this._session, 'reset');
    if (!this.running) this._api().control(this._session, 'resume');
    this.running = true;
    this.onReset?.();
  }

  step() {
    throw new Error('The ESP32 runs in real time in its emulator; it can\'t be stepped.');
  }

  /** Seconds the sketch has run since setup() started (the chip boots first, sometimes slowly). */
  get sketchTime() {
    return this._setupAt === null ? 0 : Math.max(0, this._now - this._setupAt);
  }

  /**
   * Resolves once the sketch has run `seconds` from setup() (headless runs:
   * the emulated chip's boot isn't counted). Fails when the firmware's clock
   * stops moving for `stallMs` (a crash loop, a hang before the bridge starts).
   */
  waitUntil(seconds, { signal, stallMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      let last = this._now;
      let lastWall = Date.now();
      const check = () => {
        if (signal?.aborted) return reject(new Error('Simulation cancelled'));
        if (this._failed) return reject(new Error(this._failed));
        if (this._setupAt !== null && this.sketchTime >= seconds) return resolve();
        if (this._now !== last) {
          last = this._now;
          lastWall = Date.now();
        } else if (Date.now() - lastWall > stallMs) {
          return reject(new Error(this._awaitingBoot
            ? 'The ESP32 firmware didn\'t start in the emulator (it may be crashing at boot: see its Serial output).'
            : 'The ESP32 firmware stopped running in the emulator.'));
        }
        setTimeout(check, 20);
      };
      check();
    });
  }

  _api() {
    if (!this._bridge) this._bridge = bridgeFactory();
    return this._bridge;
  }

  async _boot() {
    const api = this._api();
    this._failed = null;
    this.onNotice?.('Starting the ESP32 emulator…');
    let res;
    try {
      res = await api.start(this._program.image);
    } catch (err) {
      res = { success: false, error: err.message };
    }
    if (this._booting === null) {
      // Stopped while starting.
      if (res?.success) api.control(res.session, 'stop');
      return;
    }
    this._booting = null;
    if (!res?.success) {
      this.running = false;
      this._failed = res?.error || 'The ESP32 emulator didn\'t start';
      this.onError?.(this._failed);
      return;
    }
    this._session = res.session;
    this._lastWall = performance.now();
    this._unsubscribe = api.onEvent((e) => {
      if (e.session !== this._session) return;
      if (e.type === 'serial') this._serial(e.data);
      else if (e.type === 'bridge') this._messages(e.data);
      else if (e.type === 'exit') this._exited(e.data);
    });
    if (!this.running) api.control(this._session, 'pause');
  }

  _exited(why) {
    this._session = null;
    this._unsubscribe?.();
    this._unsubscribe = null;
    if (!this.running) return;
    this.running = false;
    this._failed = `The ESP32 emulator stopped (${why}).`;
    this.onError?.(this._failed);
  }

  // ── Messages from the bridge ─────────────────────────────────────────────

  _serial(text) {
    for (const ch of text) this.onSerial?.(ch, 0);
  }

  _messages(lines) {
    for (const line of lines) {
      try {
        this._message(line);
      } catch (err) {
        this.onError?.(`Simulator bridge: ${err.message}`);
      }
    }
    this._flush();
  }

  _message(line) {
    const kind = line[0];
    if (this._awaitingBoot && kind !== 'B') return;
    const f = line.slice(1).split(',');
    const timeOf = (s) => Number(s) / 1e6;
    switch (kind) {
      case 'B': // the bridge started (power-on or reset): send the circuit's state, then go
        if (!this._awaitingBoot) this._rebooted();
        this._awaitingBoot = false;
        this._ready = true;
        this._sendState();
        this._send('G');
        return;
      case 'H':
        this._advance(timeOf(f[0]));
        return;
      case 'S':
        this._advance(timeOf(f[0]));
        this._setupAt = timeOf(f[0]);
        return;
      case 'M': {
        this._advance(timeOf(f[2]));
        const pin = Number(f[0]);
        if (pin >= GPIO_COUNT) return;
        this._mode[pin] = Number(f[1]);
        this._update(pin);
        return;
      }
      case 'W': {
        this._advance(timeOf(f[2]));
        const pin = Number(f[0]);
        if (pin >= GPIO_COUNT) return;
        this._out[pin] = f[1] === '1';
        if (!(this._mode[pin] & 0x02)) this._mode[pin] = MODE_OUTPUT; // written before pinMode()
        this._update(pin);
        return;
      }
      case 'P': {
        this._advance(timeOf(f[4]));
        const pin = Number(f[0]);
        if (pin >= GPIO_COUNT) return;
        const duty = Number(f[1]);
        const bits = Number(f[2]);
        const freq = Number(f[3]);
        if (duty < 0) {
          this._pwm[pin] = null;
        } else {
          const max = 2 ** bits - 1;
          const fraction = max > 0 ? Math.min(1, duty / max) : 0;
          const prev = this._pwm[pin];
          this._pwm[pin] = { duty: fraction, freq, next: prev?.next ?? this._now, high: prev?.high ?? false };
          this._mode[pin] = MODE_OUTPUT;
        }
        this._update(pin);
        return;
      }
      case 'N': {
        this._advance(timeOf(f[4]));
        this._rgb.set(Number(f[0]), [Number(f[1]), Number(f[2]), Number(f[3])]);
        return;
      }
      case 'Q': {
        this._advance(timeOf(f[4]));
        this._pulseWaits.push({ id: f[0], pin: Number(f[1]), level: f[2] === '1', since: timeOf(f[4]), deadline: timeOf(f[4]) + Number(f[3]) / 1e6 });
        this._checkPulses();
        return;
      }
      case 'T':
        this._advance(timeOf(f[3]));
        this._i2cWrite(Number(f[1]), unhex(f[2]));
        return;
      case 'R':
        this._advance(timeOf(f[4]));
        this._send(this._i2cRead(f[0], Number(f[2]), [], Number(f[3])));
        return;
      case 'X':
        this._advance(timeOf(f[5]));
        this._send(this._i2cRead(f[0], Number(f[2]), unhex(f[3]), Number(f[4])));
        return;
      case 'F': // the sketch used Wi-Fi: say what the pretend network is, once
        if (this._wifiNoted) return;
        this._wifiNoted = true;
        this.onNotice?.(line.startsWith('Fjoin,')
          ? `Wi-Fi isn't simulated: the sketch joined a pretend network "${line.slice(6)}" and got IP 10.0.2.15. Requests to the internet won't get answers.`
          : 'Wi-Fi isn\'t simulated: the sketch started an access point that nothing can join.');
        return;
      case 'Z': // SPI bytes out
        this._advance(timeOf(f[2]));
        for (const b of unhex(f[1])) this.spiBus.transfer(b);
        return;
      case 'Y': // SPI transfer: the selected devices answer
        this._advance(timeOf(f[3]));
        this._send(`y${f[0]},${hex(unhex(f[2]).map(b => this.spiBus.transfer(b)))}`);
        return;
      case 'O':
        this.onNotice?.(`The sketch changed pins faster than the simulator can follow (${f[0]} changes dropped). Add a short delay() in the loop.`);
        return;
      default:
    }
  }

  /** The chip restarted by itself (ESP.restart(), a crash): time starts again from zero. */
  _rebooted() {
    const external = this._external;
    const mv = this._mv;
    this._clearState();
    this._external = external;
    this._mv = mv;
    this.onReset?.();
  }

  /** The firmware reached time `t` (seconds): run parts' timers due by then, in order. */
  _advance(t) {
    if (!(t >= this._now)) return; // never back in time
    const wall = performance.now();
    if (!this._speedMark) this._speedMark = { t, wall };
    else if (wall - this._speedMark.wall > 500) {
      this._speed = (t - this._speedMark.t) / ((wall - this._speedMark.wall) / 1000);
      this._speedMark = { t, wall };
    }
    for (;;) {
      const timer = this._timers[0];
      const edge = this._nextPwmEdge(t);
      if (edge && (!timer || edge.at <= timer.at)) {
        this._now = edge.at;
        this._pwmEdge(edge.pin);
        continue;
      }
      if (!timer || timer.at > t) break;
      this._timers.shift();
      if (timer.cancelled) continue;
      this._now = Math.max(this._now, timer.at);
      timer.fn();
    }
    this._now = t;
    this._lastGuest = t;
    this._lastWall = wall;
    if (this._pulseWaits.length) this._checkPulses();
  }

  // ── Pins ─────────────────────────────────────────────────────────────────

  _stateOf(pin) {
    const mode = this._mode[pin];
    const pwm = this._pwm[pin];
    if (pwm) {
      if (this._slowPwm(pwm)) return pwm.high ? PinState.High : PinState.Low;
      return pwm.duty >= 0.5 ? PinState.High : PinState.Low;
    }
    if ((mode & MODE_OUTPUT) === MODE_OUTPUT) {
      if (mode & MODE_OPEN_DRAIN) return this._out[pin] ? (mode & MODE_PULLUP ? PinState.InputPullUp : PinState.Input) : PinState.Low;
      return this._out[pin] ? PinState.High : PinState.Low;
    }
    if (mode & MODE_PULLUP) return PinState.InputPullUp;
    if (mode & MODE_PULLDOWN) return PinState.InputPullDown;
    return PinState.Input;
  }

  _update(pin) {
    const st = this._stateOf(pin);
    if (this._state[pin] === st) return;
    const wasHigh = this._state[pin] === PinState.High;
    this._state[pin] = st;
    const cycles = this.cycles;
    const high = st === PinState.High;
    if (wasHigh !== high) this.onPinChange?.(pin, high, cycles);
    this.onPinState?.(pin, st, cycles);
  }

  /** PWM slow enough to deliver as edges (servo pulses), not at 0 % or 100 %. */
  _slowPwm(p) {
    return p.freq > 0 && p.freq <= EDGE_PWM_MAX_HZ && p.duty > 0 && p.duty < 1;
  }

  _nextPwmEdge(until) {
    let best = null;
    for (let pin = 0; pin < GPIO_COUNT; pin++) {
      const p = this._pwm[pin];
      if (!p || !this._slowPwm(p)) continue;
      if (p.next <= until && (!best || p.next < best.at)) best = { pin, at: p.next };
    }
    return best;
  }

  /** A PWM edge for a slow signal (servo pulses), at its exact time. */
  _pwmEdge(pin) {
    const p = this._pwm[pin];
    const period = 1 / p.freq;
    p.high = !p.high;
    p.next += p.high ? p.duty * period : (1 - p.duty) * period;
    const st = p.high ? PinState.High : PinState.Low;
    this._state[pin] = st;
    const cycles = this.cycles;
    this.onPinChange?.(pin, p.high, cycles);
    this.onPinState?.(pin, st, cycles);
  }

  pinState(pin) {
    return this._state[pin] ?? PinState.Input;
  }

  isOutput(pin) {
    if (this._pwm[pin]) return true;
    const st = this.pinState(pin);
    return st === PinState.High || st === PinState.Low;
  }

  getPinState(pin) {
    return this._state[pin] === PinState.High;
  }

  /** Duty (0–1) and frequency of a pin driven by the LEDC PWM, or null. */
  pwmOf(pin) {
    const p = this._pwm[pin];
    return p ? { duty: p.duty, freq: p.duty > 0 && p.duty < 1 ? p.freq : 0 } : null;
  }

  /** The colour last sent to an RGB LED (WS2812) on a pin: [r, g, b], or null. */
  rgbOf(pin) {
    return this._rgb.get(pin) || null;
  }

  setInputPin(pin, high) {
    if (pin >= GPIO_COUNT || this._external[pin] === !!high) return;
    this._external[pin] = !!high;
    this._input(pin);
  }

  setPinFloating(pin) {
    if (pin >= GPIO_COUNT || this._external[pin] === null) return;
    this._external[pin] = null;
    this._input(pin);
  }

  _input(pin) {
    const ext = this._external[pin];
    const level = ext === null ? -1 : ext ? 1 : 0;
    const log = this._inputLog[pin];
    log.push([this._now, ext === null ? !!(this._mode[pin] & MODE_PULLUP) : ext]);
    if (log.length > 64) log.shift();
    if (this._sentLevel[pin] === level) return;
    this._sentLevel[pin] = level;
    if (this._ready) this._send(`I${pin},${level}`);
    if (this._pulseWaits.length) this._checkPulses();
  }

  /** ADC channel to a voltage; on the ESP32 boards a channel is its GPIO number. */
  setAnalogVoltage(channel, volts) {
    if (channel < 0 || channel >= GPIO_COUNT) return;
    const mv = Math.round(Math.max(0, Math.min(ADC_REF, Number(volts) || 0)) * 1000);
    this._mv[channel] = mv;
    if (this._sentMv[channel] === mv) return;
    this._sentMv[channel] = mv;
    if (this._ready) this._send(`A${channel},${mv}`);
  }

  setPinVoltage(pin, volts) {
    const entry = this.board.byPin.get(pin);
    if (!entry) return;
    if (entry.adc !== undefined) this.setAnalogVoltage(entry.adc, volts);
    this.setInputPin(pin, volts > this.board.threshold);
  }

  // ── pulseIn(): answered from the input's recorded edges ──────────────────

  /** The level of an input pin at time t, from its log. */
  _levelAt(pin, t, log) {
    let level = null;
    for (const [at, l] of log) {
      if (at > t) break;
      level = l;
    }
    if (level !== null) return level;
    return log.length ? !log[0][1] : !!(this._mode[pin] & MODE_PULLUP);
  }

  _checkPulses() {
    this._pulseWaits = this._pulseWaits.filter((w) => {
      const log = this._inputLog[w.pin] || [];
      // As Arduino's pulseIn(): skip a pulse already under way, then time the next one.
      let level = this._levelAt(w.pin, w.since, log);
      let start = level === w.level ? null : -1;
      for (const [at, l] of log) {
        if (at <= w.since || l === level) continue;
        level = l;
        if (start === null) { if (l !== w.level) start = -1; continue; }
        if (start < 0 && l === w.level) { start = at; continue; }
        if (start >= 0 && l !== w.level) {
          if (at > w.deadline) break;
          this._send(`q${w.id},${Math.round((at - start) * 1e6)}`);
          return false;
        }
      }
      if (this._now > w.deadline) {
        this._send(`q${w.id},0`);
        return false;
      }
      return true;
    });
  }

  // ── I²C: devices answer from here ────────────────────────────────────────

  _sendDevices() {
    if (!this._ready) return;
    this._send(`D${[...this.i2c.devices.keys()].map(a => a.toString(16)).join(',')}`);
  }

  _i2cWrite(addr, bytes) {
    const dev = this.i2c.devices.get(addr);
    if (!dev) return;
    if (dev.i2cConnect?.(false) === false) return;
    for (const b of bytes) dev.i2cWrite?.(b);
    dev.i2cStop?.();
  }

  _i2cRead(id, addr, write, count) {
    const dev = this.i2c.devices.get(addr);
    if (!dev) return `r${id},0,`;
    if (write.length) {
      if (dev.i2cConnect?.(false) === false) return `r${id},0,`;
      for (const b of write) dev.i2cWrite?.(b);
    }
    if (dev.i2cConnect?.(true) === false) {
      dev.i2cStop?.();
      return `r${id},0,`;
    }
    const out = [];
    for (let i = 0; i < count; i++) out.push(dev.i2cRead ? dev.i2cRead(i < count - 1) & 0xff : 0xff);
    dev.i2cStop?.();
    return `r${id},1,${hex(out)}`;
  }

  // ── Timers for parts ─────────────────────────────────────────────────────

  /** Call `fn` after `cycles` (16 MHz units) of the firmware's time. */
  schedule(cycles, fn) {
    const timer = { at: this._now + Math.max(1, cycles) / F_CPU, fn, cancelled: false };
    let i = this._timers.length;
    while (i > 0 && this._timers[i - 1].at > timer.at) i--;
    this._timers.splice(i, 0, timer);
    return timer;
  }

  cancel(handle) {
    if (handle) handle.cancelled = true;
  }

  // ── Serial and the outgoing queue ────────────────────────────────────────

  /** Text to Serial (UART0). */
  serialWrite(text, port = 0) {
    if (port !== 0 || !this._session) return;
    this._api().write(this._session, String(text));
  }

  _sendState() {
    for (let pin = 0; pin < GPIO_COUNT; pin++) {
      const ext = this._external[pin];
      this._sentLevel[pin] = ext === null ? -1 : ext ? 1 : 0;
      if (ext !== null) this._outbox.push(`I${pin},${ext ? 1 : 0}`);
      this._sentMv[pin] = this._mv[pin];
      if (this._mv[pin]) this._outbox.push(`A${pin},${this._mv[pin]}`);
    }
    this._outbox.push(`D${[...this.i2c.devices.keys()].map(a => a.toString(16)).join(',')}`);
  }

  _send(line) {
    this._outbox.push(line);
    if (this._flushQueued) return;
    this._flushQueued = true;
    queueMicrotask(() => this._flush());
  }

  _flush() {
    this._flushQueued = false;
    if (!this._outbox.length || !this._session) return;
    const lines = this._outbox;
    this._outbox = [];
    this._api().send(this._session, lines);
  }
}

export const ESP32_MODES = { MODE_INPUT, MODE_OUTPUT, MODE_PULLUP, MODE_PULLDOWN, MODE_OPEN_DRAIN };
