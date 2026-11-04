// AVR runner: one simulated board (Uno, Nano, Mega 2560 or ATtiny85) built on avr8js.
//
// The runner owns the CPU and its peripherals and exposes a small surface to
// the rest of the simulator: pin states and edges, external drive of input
// pins, ADC voltages, the serial ports, an addressed I²C bus, an SPI bus with
// chip-select routing, and cycle-accurate scheduling for timing protocols.

import {
  CPU,
  avrInstruction,
  AVRIOPort,
  AVRUSART,
  AVRADC,
  AVRTimer,
  AVRTWI,
  AVRSPI,
  AVREEPROM,
  EEPROMMemoryBackend,
  AVRClock,
  AVRWatchdog,
  PinState as AvrPinState,
} from 'avr8js';
import { SoftUartTx, SoftUartRx } from './soft-uart.js';
import { TinyTimer1 } from './tiny-timer1.js';
import { TinyUsi } from './usi.js';
import { Usb32u4 } from './usb32u4.js';
import { Timer4 } from './timer4.js';
import { parseHex, hexImageSize } from './hex-loader.js';
import { MCUS } from './mcu.js';
import { boardById } from './boards.js';

export const F_CPU = 16_000_000; // 16 MHz on every supported board
const CYCLES_PER_MS = F_CPU / 1000;

/** avr8js pin states, plus InputPullDown for boards that have pull-downs (the RP2040). */
export const PinState = Object.freeze({ ...AvrPinState, InputPullDown: 4 });

/**
 * I²C bus shared by every device on SDA/SCL. Devices answer to a 7-bit address:
 *   { i2cConnect?(read: boolean): boolean, i2cWrite?(byte): boolean,
 *     i2cRead?(ack: boolean): number, i2cStop?(): void }
 * Addresses without a device NACK, like real hardware.
 */
export class I2CBus {
  constructor() {
    this.devices = new Map();
  }

  add(address, device) {
    this.devices.set(address & 0x7f, device);
  }

  remove(address, device) {
    if (this.devices.get(address) === device) this.devices.delete(address);
  }

  clear() {
    this.devices.clear();
  }
}

/**
 * SPI bus. Each device decides whether it is selected (usually its CS pin is
 * LOW) and answers one byte per transfer:
 *   { selected(): boolean, transfer(byte): number }
 */
export class SPIBus {
  constructor() {
    this.devices = new Set();
  }

  add(device) { this.devices.add(device); }
  remove(device) { this.devices.delete(device); }
  clear() { this.devices.clear(); }

  transfer(byte) {
    let miso = 0xff;
    for (const dev of this.devices) {
      if (dev.selected()) {
        const out = dev.transfer(byte);
        if (typeof out === 'number') miso &= out;
      }
    }
    return miso & 0xff;
  }
}

export class AvrRunner {
  constructor() {
    this.cpu = null;
    this.board = boardById('uno');
    this.mcu = MCUS[this.board.mcu];
    this.ports = {};
    this.usarts = [];
    this.adc = null;
    this.twi = null;
    this.spi = null;
    this.running = false;
    this._rafId = null;
    this._speed = 0;
    this._startWall = 0;
    this._startCycles = 0;
    this._hex = null;

    this.i2c = new I2CBus();
    this.spiBus = new SPIBus();
    this._eepromBackends = new Map(); // board id → backend, kept across reloads

    // Callbacks
    this.onPinChange = null;   // (pin, high, cycles) — output level edges
    this.onPinState = null;    // (pin, state: PinState, cycles) — any mode/level change
    this.onSerial = null;      // (char, port) — port 0 is Serial, 1-3 are Serial1-3 (Mega)
    // Baud rate for typing into a software Serial (ATtiny85) before the
    // sketch has sent anything to measure; set from the sketch's Serial.begin().
    this.softSerialBaud = 9600;
    this.onError = null;       // (msg) => void
    this.onReset = null;       // () => void, after a reset (watchdog, RESET pin, restart)
    // Debugging: checked after every instruction while set; returning true
    // stops the run before the next instruction and calls onBreak.
    this.stopCheck = null;     // (cpu) => boolean
    this.onBreak = null;       // () => void

    this._resetPinArrays();
  }

  _resetPinArrays() {
    const n = this.board.pinCount;
    this._state = new Uint8Array(n).fill(PinState.Input);
    this._high = new Array(n).fill(false);
    this._external = new Array(n).fill(null); // null = not driven by the circuit
    this._analog = new Array(this.mcu.adcChannels).fill(0); // volts
  }

  get cycles() {
    return this.cpu ? this.cpu.cycles : 0;
  }

  /** Simulated time in seconds. */
  get time() {
    return this.cpu ? this.cpu.cycles / F_CPU : 0;
  }

  /** Ratio of simulated speed to real time (1 = realtime). */
  get speed() {
    return this._speed;
  }

  /**
   * Load a program and build the board's peripherals.
   * @param {string} hexString Intel HEX
   * @param {string} [boardId] uno | nano | mega
   * @param {string} [mcuId] a smaller sibling of the board's chip (atmega168 on the Nano)
   */
  load(hexString, boardId, mcuId) {
    try {
      if (boardId) this.board = boardById(boardId);
      this.mcu = MCUS[mcuId] || MCUS[this.board.mcu];
      const size = hexImageSize(hexString);
      if (size > this.mcu.flashBytes) {
        throw new Error(`the program is ${size} bytes but the ${this.mcu.name} has ${this.mcu.flashBytes} bytes of flash. Was it compiled for a different board?`);
      }
      this._hex = hexString;
      this._build();
      return true;
    } catch (err) {
      if (this.onError) this.onError(`Failed to load program: ${err.message}`);
      return false;
    }
  }

  _build() {
    const mcu = this.mcu;
    const cpu = new CPU(parseHex(this._hex, mcu.flashBytes), mcu.sramBytes);
    this.cpu = cpu;
    this._resetPinArrays();

    this.ports = {};
    for (const [letter, config] of Object.entries(mcu.ports)) {
      this.ports[letter] = new AVRIOPort(cpu, config);
    }

    // Timers that share TIMSK/TIFR (the ATmega8's) each install a hook there; chain them.
    const shared = new Map();
    for (const t of mcu.timers) {
      new AVRTimer(cpu, t);
      for (const addr of [t.TIMSK, t.TIFR]) {
        if (!shared.has(addr)) shared.set(addr, []);
        shared.get(addr).push(cpu.writeHooks[addr]);
      }
    }
    for (const [addr, hooks] of shared) {
      if (hooks.length < 2) continue;
      const flags = mcu.timers.some(t => t.TIFR === addr);
      cpu.writeHooks[addr] = (value, oldValue, a, mask) => {
        // TIFR: writing 1 clears a flag, 0 leaves it.
        const keep = cpu.data[addr] & ~value;
        for (const hook of hooks) hook?.(value, oldValue, a, mask);
        cpu.data[addr] = flags ? keep : value;
        return true;
      };
    }
    if (mcu.tinyTimer1) new TinyTimer1(cpu, mcu.tinyTimer1);
    if (mcu.timer4) new Timer4(cpu, mcu.timer4);
    mcu.setup?.(cpu);

    this.clock = new AVRClock(cpu, F_CPU, mcu.clock);
    // Serial port numbers: 0 is Serial. On the ATmega32U4 that's USB, and the USART is Serial1.
    const offset = mcu.usartPortOffset || 0;
    this.usarts = mcu.usarts.map((cfg, index) => {
      const usart = new AVRUSART(cpu, cfg, F_CPU);
      usart.onByteTransmit = (byte) => {
        if (this.onSerial) this.onSerial(String.fromCharCode(byte), index + offset);
      };
      // RX pacing: the UART accepts one byte per character time.
      usart._rxQueue = [];
      usart.onRxComplete = () => this._pumpRx(usart);
      return usart;
    });
    this.usart = this.usarts[0];
    this.usb = mcu.usb ? new Usb32u4(cpu, mcu.usb, {
      cyclesPerMs: F_CPU / 1000,
      onSerial: (byte) => this.onSerial?.(String.fromCharCode(byte), 0),
    }) : null;

    this.adc = new AVRADC(cpu, mcu.adc);
    if (mcu.adcReferenceOf) {
      Object.defineProperty(this.adc, 'referenceVoltageType', { get: () => mcu.adcReferenceOf(cpu.data[mcu.adc.ADMUX]) });
    }
    this._pushAnalog();

    this.twi = null;
    this.spi = null;
    if (mcu.twi) this._buildTwi(cpu, mcu);
    if (mcu.spi) this._buildSpi(cpu, mcu);
    this._comparator = mcu.analogComparator ? this._buildComparator(cpu, mcu.analogComparator) : null;
    this._softTx = null;
    this._softRx = null;
    if (this.board.softSerial && this._comparator && !mcu.noSoftSerial) this._buildSoftSerial(cpu);
    // The ATtiny85's USI: I²C (two-wire) and SPI (three-wire) on PB0-PB2.
    this.usi = mcu.usi ? new TinyUsi(cpu, cpu.gpioByPort[mcu.usi.PORT], mcu.usi, this.i2c) : null;

    let backend = this._eepromBackends.get(this.board.id);
    if (!backend || backend.memory.length !== mcu.eepromBytes) {
      backend = new EEPROMMemoryBackend(mcu.eepromBytes);
      this._eepromBackends.set(this.board.id, backend);
    }
    this.eeprom = new AVREEPROM(cpu, backend, mcu.eeprom);

    this.watchdog = new AVRWatchdog(cpu, mcu.watchdog, this.clock);
    // avr8js' CPU reset (used by the watchdog) only rewinds PC/SP. A real reset
    // also returns the I/O registers to their defaults, so do that here.
    const cpuReset = cpu.reset.bind(cpu);
    cpu.reset = () => {
      cpuReset();
      this._resetIoRegisters();
      if (this.onReset) queueMicrotask(() => this.onReset());
    };

    // Pin listeners: report output edges and mode changes per Arduino pin.
    for (const [letter, port] of Object.entries(this.ports)) {
      const pins = this.board.pins.filter(p => p.port === letter);
      if (!pins.length) continue;
      port.addListener(() => {
        for (const p of pins) this._refreshPin(p, port);
      });
    }
  }

  /** I²C master → addressed devices. */
  _buildTwi(cpu, mcu) {
    this.twi = new AVRTWI(cpu, mcu.twi, F_CPU);
    const twi = this.twi;
    let current = null;
    this.twi.eventHandler = {
      start: () => twi.completeStart(),
      stop: () => {
        current?.i2cStop?.();
        current = null;
        twi.completeStop();
      },
      connectToSlave: (addr, write) => {
        current = this.i2c.devices.get(addr) || null;
        const ack = !!current && current.i2cConnect?.(!write) !== false;
        if (!ack) current = null;
        twi.completeConnect(ack);
      },
      writeByte: (value) => {
        const ack = !!current && current.i2cWrite?.(value) !== false;
        twi.completeWrite(ack);
      },
      readByte: (ack) => {
        const value = current?.i2cRead ? current.i2cRead(ack) : 0xff;
        twi.completeRead(value & 0xff);
      },
    };
  }

  /** SPI master → chip-selected devices. */
  _buildSpi(cpu, mcu) {
    this.spi = new AVRSPI(cpu, mcu.spi, F_CPU);
    this.spi.onByte = (value) => {
      const response = this.spiBus.transfer(value);
      cpu.addClockEvent(() => this.spi.completeTransfer(response), this.spi.transferCycles);
    };
  }

  /**
   * The analog comparator (ACSR): AIN0 or the bandgap against AIN1, with its
   * interrupt on toggle, falling or rising output. Pin voltages are the
   * digital levels the circuit gives them.
   */
  _buildComparator(cpu, cfg) {
    const ACD = 0x80, ACBG = 0x40, ACO = 0x20, ACI = 0x10, ACIE = 0x08;
    const irq = { address: cfg.interrupt, flagRegister: cfg.ACSR, flagMask: ACI, enableRegister: cfg.ACSR, enableMask: ACIE };
    const update = () => {
      const acsr = cpu.data[cfg.ACSR];
      if (acsr & ACD) return;
      const plus = acsr & ACBG ? cfg.bandgap : this._pinVolts(cfg.ain0);
      const out = plus > this._pinVolts(cfg.ain1);
      const was = !!(acsr & ACO);
      if (out === was) return;
      cpu.data[cfg.ACSR] = out ? acsr | ACO : acsr & ~ACO;
      const mode = acsr & 0x03; // ACIS1:0 = 00 toggle, 10 falling, 11 rising
      if (mode === 0 || (mode === 2 && !out) || (mode === 3 && out)) cpu.setInterruptFlag(irq);
    };
    cpu.writeHooks[cfg.ACSR] = (value) => {
      const old = cpu.data[cfg.ACSR];
      cpu.data[cfg.ACSR] = (value & ~(ACO | ACI)) | (old & (ACO | ACI));
      cpu.clearInterruptByFlag(irq, value); // writing 1 to ACI clears it
      cpu.updateInterruptEnable(irq, value);
      update();
      return true;
    };
    return { update, pins: new Set([cfg.ain0, cfg.ain1]), enabledWithBandgap: () => (cpu.data[cfg.ACSR] & (ACD | ACBG)) === ACBG };
  }

  /** Serial on a chip without a UART: decode its TX pin, drive its RX pin. */
  _buildSoftSerial(cpu) {
    const { tx, rx } = this.board.softSerial;
    const txPort = this._portOf(tx);
    const schedule = (cycles, fn) => cpu.addClockEvent(fn, Math.max(1, Math.round(cycles)));
    this._softTx = new SoftUartTx({
      schedule,
      level: () => this.pinState(tx) !== PinState.Low,
      // TinySoftwareSerial.begin() turns on the comparator with the bandgap.
      enabled: () => this._comparator.enabledWithBandgap(),
      onByte: (byte) => this.onSerial?.(String.fromCharCode(byte), 0),
    });
    const PORT = txPort.port.portConfig.PORT;
    const portWrite = cpu.writeHooks[PORT];
    cpu.writeHooks[PORT] = (value, oldValue, addr, mask) => {
      this._softTx.write(cpu.cycles);
      return portWrite(value, oldValue, addr, mask);
    };
    this._softRx = new SoftUartRx({
      schedule,
      drive: (high) => this.setInputPin(rx, high),
      bitCycles: () => this._softTx.bitCycles || F_CPU / Math.max(300, this.softSerialBaud || 9600),
    });
  }

  /** A pin's voltage as the circuit and the pin's own driver make it. */
  _pinVolts(pin) {
    const st = this._state[pin];
    if (st === PinState.High) return this.board.logicVolts;
    if (st === PinState.Low) return 0;
    const ext = this._external[pin];
    if (ext !== null && ext !== undefined) return ext ? this.board.logicVolts : 0;
    return st === PinState.InputPullUp ? this.board.logicVolts : 0;
  }

  _resetIoRegisters() {
    const { cpu, mcu } = this;
    const zero = (addr) => { if (addr) cpu.writeData(addr, 0); };
    for (const cfg of Object.values(mcu.ports)) { zero(cfg.DDR); zero(cfg.PORT); }
    for (const t of mcu.timers) { zero(t.TIMSK); zero(t.TCCRA); zero(t.TCCRB); }
    if (mcu.tinyTimer1) { zero(mcu.tinyTimer1.TCCR1); zero(mcu.tinyTimer1.GTCCR); }
    if (mcu.timer4) for (const r of ['TCCR4A', 'TCCR4B', 'TCCR4C', 'TCCR4D']) zero(mcu.timer4[r]);
    for (const u of mcu.usarts) zero(u.UCSRB);
    zero(mcu.adc.ADCSRA);
    if (mcu.twi) zero(mcu.twi.TWCR);
    if (mcu.spi) zero(mcu.spi.SPCR);
    if (mcu.analogComparator) zero(mcu.analogComparator.ACSR);
    this.usi?.reset();
    this.usb?.reset();
  }

  _refreshPin(p, port) {
    const st = port.pinState(p.bit);
    if (this._state[p.pin] === st) return;
    this._state[p.pin] = st;
    if (st === PinState.Input || st === PinState.InputPullUp) this._applyInput(p.pin);
    const high = st === PinState.High;
    if (this._high[p.pin] !== high) {
      this._high[p.pin] = high;
      if (this.onPinChange) this.onPinChange(p.pin, high, this.cpu.cycles);
    }
    if (this.onPinState) this.onPinState(p.pin, st, this.cpu.cycles);
    if (this._comparator?.pins.has(p.pin)) this._comparator.update();
    if (this._softTx && p.pin === this.board.softSerial.tx) this._softTx.edge(st !== PinState.Low, this.cpu.cycles);
  }

  // ── Run control ──────────────────────────────────────────────────────────

  start() {
    if (!this.cpu || this.running) return;
    this.running = true;
    this._startWall = performance.now();
    this._startCycles = this.cpu.cycles;
    this._tick();
  }

  stop() {
    this.running = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /** Power-cycle the board: rebuild every peripheral from the loaded program. */
  reset() {
    const wasRunning = this.running;
    this.stop();
    if (this._hex) this._build();
    if (this.onReset) this.onReset();
    if (wasRunning) this.start();
  }

  /** Run `cycles` CPU cycles synchronously (headless runs and tests). */
  step(cycles) {
    const cpu = this.cpu;
    const end = cpu.cycles + cycles;
    while (cpu.cycles < end) {
      avrInstruction(cpu);
      cpu.tick();
    }
  }

  /**
   * Run until `stopCheck` stops the CPU or `maxCycles` pass (headless debugging and tests).
   * @returns {boolean} whether it stopped
   */
  runUntilStop(maxCycles) {
    const cpu = this.cpu;
    const check = this.stopCheck;
    const end = cpu.cycles + maxCycles;
    while (cpu.cycles < end) {
      avrInstruction(cpu);
      cpu.tick();
      if (check && check(cpu)) {
        this.onBreak?.();
        return true;
      }
    }
    return false;
  }

  /**
   * Call `fn` after `cycles` CPU cycles of simulated time.
   * @returns {Function} handle for cancel()
   */
  schedule(cycles, fn) {
    if (!this.cpu) return null;
    return this.cpu.addClockEvent(fn, Math.max(1, Math.round(cycles)));
  }

  cancel(handle) {
    if (handle && this.cpu) this.cpu.clearClockEvent(handle);
  }

  // ── Pins ─────────────────────────────────────────────────────────────────

  _portOf(pin) {
    const entry = this.board.byPin.get(pin);
    if (!entry || !entry.port) return null;
    return { port: this.ports[entry.port], bit: entry.bit, entry };
  }

  /** PinState of an Arduino pin (Low/High = output, Input/InputPullUp = input). */
  pinState(pin) {
    return this._state[pin] ?? PinState.Input;
  }

  isOutput(pin) {
    const st = this.pinState(pin);
    return st === PinState.High || st === PinState.Low;
  }

  /** True when the pin is an output driven HIGH. */
  getPinState(pin) {
    return !!this._high[pin];
  }

  /** Drive an input pin from the circuit. */
  setInputPin(pin, high) {
    if (this._external[pin] === !!high) return;
    this._external[pin] = !!high;
    this._applyInput(pin);
  }

  /** Stop driving a pin from the circuit; the pull-up (if enabled) reads HIGH. */
  setPinFloating(pin) {
    if (this._external[pin] === null) return;
    this._external[pin] = null;
    this._applyInput(pin);
  }

  _applyInput(pin) {
    const loc = this._portOf(pin);
    if (!loc) return;
    const ext = this._external[pin];
    const value = ext !== null ? ext : loc.port.pinState(loc.bit) === PinState.InputPullUp;
    loc.port.setPin(loc.bit, value);
    if (this._comparator?.pins.has(pin)) this._comparator.update();
  }

  /** Set an ADC channel to a voltage (0-5 V). */
  setAnalogVoltage(channel, volts) {
    if (channel < 0 || channel >= this._analog.length) return;
    this._analog[channel] = Math.max(0, Math.min(5, Number(volts) || 0));
    this._pushAnalog();
  }

  /** Back-compat: ADC channel from a 0-1023 reading. */
  setAnalogPin(channel, value) {
    this.setAnalogVoltage(channel, (Math.max(0, Math.min(1023, value)) / 1023) * 5);
  }

  /** Apply a voltage to an Arduino pin: ADC channel if it has one, digital level otherwise. */
  setPinVoltage(pin, volts) {
    const entry = this.board.byPin.get(pin);
    if (!entry) return;
    if (entry.adc !== undefined) this.setAnalogVoltage(entry.adc, volts);
    if (entry.port) this.setInputPin(pin, volts > 2.5);
  }

  _pushAnalog() {
    if (!this.adc) return;
    for (let i = 0; i < this._analog.length; i++) this.adc.channelValues[i] = this._analog[i];
  }

  // ── Serial ───────────────────────────────────────────────────────────────

  /** Queue text for a UART; bytes are fed at line rate. */
  serialWrite(text, port = 0) {
    if (port === 0 && this._softRx) {
      this._softRx.write([...text].map(ch => ch.charCodeAt(0) & 0xff));
      return;
    }
    if (port === 0 && this.usb) {
      this.usb.write([...text].map(ch => ch.charCodeAt(0) & 0xff));
      return;
    }
    const usart = this.usarts[port - (this.mcu.usartPortOffset || 0)];
    if (!usart) return;
    for (const ch of text) usart._rxQueue.push(ch.charCodeAt(0) & 0xff);
    this._pumpRx(usart);
  }

  _pumpRx(usart) {
    if (!usart || !usart._rxQueue) return;
    while (usart._rxQueue.length && usart.writeByte(usart._rxQueue[0])) {
      usart._rxQueue.shift();
    }
  }

  // ── Main loop ────────────────────────────────────────────────────────────

  _tick() {
    if (!this.running) return;

    const frameBudgetMs = 12;
    const targetCycles = CYCLES_PER_MS * 16; // ~16 ms of simulated time per frame
    const start = performance.now();

    try {
      const cpu = this.cpu;
      const endCycles = cpu.cycles + targetCycles;
      const check = this.stopCheck;
      while (cpu.cycles < endCycles) {
        if (check) {
          for (let i = 0; i < 5000; i++) {
            avrInstruction(cpu);
            cpu.tick();
            if (check(cpu)) {
              this.running = false;
              this._rafId = null;
              this.onBreak?.();
              return;
            }
          }
        } else {
          for (let i = 0; i < 5000; i++) {
            avrInstruction(cpu);
            cpu.tick();
          }
        }
        if (performance.now() - start > frameBudgetMs) break;
      }
    } catch (err) {
      this.running = false;
      if (this.onError) this.onError(`Runtime error: ${err.message}`);
      return;
    }

    const wallSec = (performance.now() - this._startWall) / 1000;
    if (wallSec > 0.2) {
      const simSec = (this.cpu.cycles - this._startCycles) / F_CPU;
      this._speed = simSec / wallSec;
    }

    this._rafId = requestAnimationFrame(() => this._tick());
  }
}
