// Raspberry Pi Pico runner: an RP2040 (rp2040js) behind the same surface as
// AvrRunner, so the circuit engine, the part models and the UI drive it
// unchanged.
//
// Time: the rest of the simulator counts in 16 MHz cycles (the AVR clock).
// This runner reports simulated time in that unit too, so every pulse timing
// in the part models (DHT, HC-SR04, NeoPixel, IR…) carries over.
//
// Serial (port 0) is the Pico's USB CDC port, as in the Arduino-Pico core;
// Serial1 and Serial2 (ports 1 and 2) are UART0 and UART1.

import { Simulator, USBCDC, GPIOPinState, I2CMode } from 'rp2040js';
import { bootromB1 } from './rp2040/bootrom.js';
import { I2CBus, SPIBus, PinState, F_CPU } from './avr-runner.js';
import { boardById } from './boards.js';

const FLASH_START = 0x10000000;
const FLASH_BYTES = 16 * 1024 * 1024;
const NS_PER_CYCLE = 1e9 / F_CPU;
const ADC_REF = 3.3;
const GPIO_COUNT = 30;
const UF2_MAGIC = [0x0a324655, 0x9e5d5157];
// SIO registers of the inter-core mailbox (RP2040 datasheet, 2.3.1.7).
const SIO_FIFO_ST = 0x50;
const SIO_FIFO_WR = 0x54;
const SIO_FIFO_RD = 0x58;

const STATE = {
  [GPIOPinState.Low]: PinState.Low,
  [GPIOPinState.High]: PinState.High,
  [GPIOPinState.Input]: PinState.Input,
  [GPIOPinState.InputPullUp]: PinState.InputPullUp,
  [GPIOPinState.InputPullDown]: PinState.InputPullDown,
  [GPIOPinState.InputBusKeeper]: PinState.Input,
};

const UF2_FAMILY_PRESENT = 0x2000;
const RP2040_FAMILY = 0xe48bff56;

/**
 * Flash blocks of a UF2 file (or a raw .bin image, which starts at flash address 0).
 * @param {Uint8Array} bytes
 * @returns {{ addr: number, data: Uint8Array }[]}
 */
export function flashImage(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blocks = [];
  if (bytes.length >= 512 && view.getUint32(0, true) === UF2_MAGIC[0] && view.getUint32(4, true) === UF2_MAGIC[1]) {
    for (let off = 0; off + 512 <= bytes.length; off += 512) {
      if (view.getUint32(off, true) !== UF2_MAGIC[0] || view.getUint32(off + 4, true) !== UF2_MAGIC[1]) continue;
      const flags = view.getUint32(off + 8, true);
      if (flags & 1) continue; // "not main flash"
      // Blocks tagged for another chip (the RP2350's families end 57–5b) can't run here.
      if (flags & UF2_FAMILY_PRESENT && view.getUint32(off + 28, true) !== RP2040_FAMILY) {
        throw new Error('This program was built for another chip (an RP2350?). The simulator emulates the RP2040.');
      }
      const addr = view.getUint32(off + 12, true);
      const size = view.getUint32(off + 16, true);
      if (addr < FLASH_START || addr + size > FLASH_START + FLASH_BYTES || size > 476) throw new Error('This UF2 file is not an RP2040 flash image');
      blocks.push({ addr, data: bytes.subarray(off + 32, off + 32 + size) });
    }
    if (!blocks.length) throw new Error('The UF2 file holds no flash blocks');
    return blocks;
  }
  if (!bytes.length || bytes.length > FLASH_BYTES) throw new Error('The program image is empty or larger than the flash');
  return [{ addr: FLASH_START, data: bytes }];
}

export class Rp2040Runner {
  constructor() {
    this.sim = null;
    this.mcu = null;
    this.board = boardById('pico');
    this.running = false;
    this._rafId = null;
    this._speed = 0;
    this._startWall = 0;
    this._startNanos = 0;
    this._image = null;
    this.i2c = new I2CBus();
    this.spiBus = new SPIBus();

    this.onPinChange = null;   // (pin, high, cycles)
    this.onPinState = null;    // (pin, state, cycles)
    this.onSerial = null;      // (char, port)
    this.onError = null;       // (msg)
    this.onReset = null;       // ()
    this.stopCheck = null;     // not supported on the Pico (the debugger runs AVR boards)
    this.onBreak = null;

    this._resetPinArrays();
  }

  _resetPinArrays() {
    this._state = new Uint8Array(GPIO_COUNT).fill(PinState.Input);
    this._high = new Array(GPIO_COUNT).fill(false);
    this._external = new Array(GPIO_COUNT).fill(null);
    this._analog = new Array(5).fill(0);
  }

  /** Simulated time in 16 MHz cycles (the unit the circuit engine uses). */
  get cycles() {
    return this.sim ? this.sim.clock.nanos / NS_PER_CYCLE : 0;
  }

  get time() {
    return this.sim ? this.sim.clock.nanos / 1e9 : 0;
  }

  get speed() {
    return this._speed;
  }

  /**
   * @param {Uint8Array} image - UF2 (or .bin) from the Arduino-Pico core
   * @param {string} [boardId]
   */
  load(image, boardId) {
    try {
      if (boardId) this.board = boardById(boardId);
      this._image = flashImage(image);
      this._build();
      return true;
    } catch (err) {
      this.onError?.(`Failed to load program: ${err.message}`);
      return false;
    }
  }

  _build() {
    const sim = new Simulator();
    const mcu = sim.rp2040;
    // rp2040js reports registers it doesn't model; firmware runs fine without them.
    mcu.logger = { debug() {}, info() {}, warn() {}, error() {} };
    mcu.loadBootrom(bootromB1);
    // Only core 0 is simulated: its mailbox from core 1 stays empty and always
    // has room (FIFO_ST: RDY set, VLD clear). rp2040js doesn't model these registers.
    const { sio } = mcu;
    const readSio = sio.readUint32.bind(sio);
    const writeSio = sio.writeUint32.bind(sio);
    sio.readUint32 = (offset) => (offset === SIO_FIFO_ST ? 0b10 : offset === SIO_FIFO_RD ? 0 : readSio(offset));
    sio.writeUint32 = (offset, value) => {
      if (offset !== SIO_FIFO_ST && offset !== SIO_FIFO_WR) writeSio(offset, value);
    };
    for (const block of this._image) mcu.flash.set(block.data, block.addr - FLASH_START);
    // The boot ROM's flash boot ends by jumping to the second-stage loader at
    // the start of flash; start there, as rp2040js' own examples do.
    mcu.core.PC = FLASH_START;
    this.sim = sim;
    this.mcu = mcu;
    this._resetPinArrays();

    mcu.gpio.forEach((gpio, pin) => {
      gpio.addListener((state) => this._gpioChanged(pin, state));
    });

    this.cdc = new USBCDC(mcu.usbCtrl);
    this.cdc.onSerialData = (buffer) => {
      for (const byte of buffer) this.onSerial?.(String.fromCharCode(byte), 0);
    };
    mcu.uart.forEach((uart, index) => {
      uart.onByte = (byte) => this.onSerial?.(String.fromCharCode(byte), index + 1);
    });

    for (const bus of mcu.i2c) this._attachI2C(bus);
    for (const spi of mcu.spi) {
      spi.onTransmit = (value) => spi.completeTransmit(this.spiBus.transfer(value));
    }
    this._pushAnalog();
  }

  _attachI2C(bus) {
    let current = null;
    bus.onStart = () => bus.completeStart();
    bus.onConnect = (address, mode) => {
      current = this.i2c.devices.get(address) || null;
      const ack = !!current && current.i2cConnect?.(mode === I2CMode.Read) !== false;
      if (!ack) current = null;
      bus.completeConnect(ack);
    };
    bus.onWriteByte = (value) => {
      bus.completeWrite(!!current && current.i2cWrite?.(value) !== false);
    };
    bus.onReadByte = (ack) => {
      bus.completeRead((current?.i2cRead ? current.i2cRead(ack) : 0xff) & 0xff);
    };
    bus.onStop = () => {
      current?.i2cStop?.();
      current = null;
      bus.completeStop();
    };
  }

  _gpioChanged(pin, gpioState) {
    // GPIO 23, 24 and 29 are wired inside the Pico (power save, VBUS and VSYS sensing).
    if (!this.board.byPin.has(pin)) return;
    const st = STATE[gpioState] ?? PinState.Input;
    if (this._state[pin] === st) return;
    this._state[pin] = st;
    if (st === PinState.Input || st === PinState.InputPullUp || st === PinState.InputPullDown) this._applyInput(pin);
    const high = st === PinState.High;
    const cycles = this.cycles;
    if (this._high[pin] !== high) {
      this._high[pin] = high;
      this.onPinChange?.(pin, high, cycles);
    }
    this.onPinState?.(pin, st, cycles);
  }

  // ── Run control ──────────────────────────────────────────────────────────

  /** Execute until `nanos` of simulated time; sleeping cores skip ahead to the next timer. */
  _runTo(nanos) {
    const { clock } = this.sim;
    const core = this.mcu.core;
    const mcu = this.mcu;
    while (clock.nanos < nanos) {
      if (core.waiting) {
        const next = clock.nanosToNextAlarm;
        clock.tick(next > 0 ? Math.min(next, nanos - clock.nanos) : nanos - clock.nanos);
      } else {
        const cycles = core.executeInstruction();
        clock.tick((cycles * 1e9) / mcu.clkSys);
      }
    }
  }

  start() {
    if (!this.sim || this.running) return;
    this.running = true;
    this._startWall = performance.now();
    this._startNanos = this.sim.clock.nanos;
    this._tick();
  }

  stop() {
    this.running = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /** Power-cycle the board. */
  reset() {
    const wasRunning = this.running;
    this.stop();
    if (this._image) this._build();
    this.onReset?.();
    if (wasRunning) this.start();
  }

  /** Run `cycles` (16 MHz units) synchronously: headless runs and tests. */
  step(cycles) {
    this._runTo(this.sim.clock.nanos + cycles * NS_PER_CYCLE);
  }

  /** Call `fn` after `cycles` (16 MHz units) of simulated time. */
  schedule(cycles, fn) {
    if (!this.sim) return null;
    const alarm = this.sim.clock.createAlarm(fn);
    alarm.schedule(Math.max(1, cycles) * NS_PER_CYCLE);
    return alarm;
  }

  cancel(handle) {
    handle?.cancel?.();
  }

  _tick() {
    if (!this.running) return;
    const frameBudgetMs = 12;
    const sliceNs = 1e6; // 1 ms of simulated time per slice
    const start = performance.now();
    const end = this.sim.clock.nanos + 16e6; // ~16 ms of simulated time per frame
    try {
      while (this.sim.clock.nanos < end) {
        this._runTo(Math.min(end, this.sim.clock.nanos + sliceNs));
        if (performance.now() - start > frameBudgetMs) break;
      }
    } catch (err) {
      this.running = false;
      this.onError?.(`Runtime error: ${err.message}`);
      return;
    }
    const wallSec = (performance.now() - this._startWall) / 1000;
    if (wallSec > 0.2) this._speed = (this.sim.clock.nanos - this._startNanos) / 1e9 / wallSec;
    this._rafId = requestAnimationFrame(() => this._tick());
  }

  // ── Pins ─────────────────────────────────────────────────────────────────

  pinState(pin) {
    return this._state[pin] ?? PinState.Input;
  }

  isOutput(pin) {
    const st = this.pinState(pin);
    return st === PinState.High || st === PinState.Low;
  }

  getPinState(pin) {
    return !!this._high[pin];
  }

  setInputPin(pin, high) {
    if (this._external[pin] === !!high) return;
    this._external[pin] = !!high;
    this._applyInput(pin);
  }

  setPinFloating(pin) {
    if (this._external[pin] === null) return;
    this._external[pin] = null;
    this._applyInput(pin);
  }

  _applyInput(pin) {
    const gpio = this.mcu?.gpio[pin];
    if (!gpio) return;
    const ext = this._external[pin];
    gpio.setInputValue(ext !== null ? ext : this._state[pin] === PinState.InputPullUp);
  }

  /** ADC channel (0–3 = GP26–GP29) to a voltage, 0–3.3 V. */
  setAnalogVoltage(channel, volts) {
    if (channel < 0 || channel >= 4) return;
    this._analog[channel] = Math.max(0, Math.min(ADC_REF, Number(volts) || 0));
    this._pushAnalog();
  }

  setPinVoltage(pin, volts) {
    const entry = this.board.byPin.get(pin);
    if (!entry) return;
    if (entry.adc !== undefined) this.setAnalogVoltage(entry.adc, volts);
    this.setInputPin(pin, volts > this.board.threshold);
  }

  _pushAnalog() {
    if (!this.mcu) return;
    for (let i = 0; i < 4; i++) this.mcu.adc.channelValues[i] = Math.round((this._analog[i] / ADC_REF) * 4095);
  }

  // ── Serial ───────────────────────────────────────────────────────────────

  /** Send text to Serial (USB, port 0) or Serial1/Serial2 (UART0/UART1). */
  serialWrite(text, port = 0) {
    if (!this.mcu) return;
    for (const ch of text) {
      const byte = ch.charCodeAt(0) & 0xff;
      if (port === 0) this.cdc.sendSerialByte(byte);
      else this.mcu.uart[port - 1]?.feedByte(byte);
    }
  }
}
