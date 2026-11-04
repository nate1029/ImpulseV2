// The USI (Universal Serial Interface) of the ATtiny25/45/85, from the
// datasheet (Atmel-2586, section 15), and the I²C bus it drives in two-wire
// mode. ATTinyCore's Wire (USI_TWI_Master, as in Atmel's AVR310) and
// TinyWireM clock it by software strobes; its SPI uses three-wire mode.
//
// Two-wire mode makes SDA (PB0) and SCL (PB2) open drain: a pin is pulled LOW
// when its DDR bit is set and either its PORT bit or, for SDA, the output
// latch (USIDR bit 7) is 0; otherwise the line floats HIGH on its pull-up.
// The data register shifts in SDA on each rising SCL edge, the 4-bit counter
// counts clock edges (or USITC strobes), and START and STOP conditions on the
// bus raise USISIF and USIPF.
//
// The simulated I²C devices answer bytes (I2CBus), so I2CPinBridge plays them
// on the pins: it follows START, address, data and STOP from the bus levels
// and pulls SDA LOW for ACKs and for the bits of the bytes a device sends.
// Reads of PINB see that pull. Three-wire mode (SPI) is all on the pins: DO
// and USCK change as on the chip and parts clock the bits in themselves.
// Clocking from Timer0's compare match (USICS = 01) isn't modelled.

const USISIF = 0x80;
const USIOIF = 0x40;
const USIPF = 0x20;
const USIDC = 0x10;
const USISIE = 0x80;
const USIOIE = 0x40;
const USICLK = 0x02;
const USITC = 0x01;

export const usiConfig = {
  USICR: 0x2d, USISR: 0x2e, USIDR: 0x2f, USIBR: 0x30,
  PIN: 0x36, DDR: 0x37, PORT: 0x38,
  startInterrupt: 13, ovfInterrupt: 14,
  // DI/SDA, DO and USCK/SCL on PORTB.
  di: 0, do: 1, usck: 2,
};

// avr8js' PinOverrideMode (not exported from the package root).
const Override = { None: 0, Set: 2, Clear: 3 };

/**
 * The slave side of an I²C bus at pin level, for byte-level devices:
 * { i2cConnect?(read), i2cWrite?(byte), i2cRead?(), i2cStop?() } (see I2CBus).
 */
export class I2CPinBridge {
  constructor(bus) {
    this.bus = bus;
    this.state = 'idle';
    this.sdaLow = false; // this side pulls SDA LOW
    this.device = null;
    this.bits = 0;
    this.byte = 0;
    this.read = false;
  }

  start() {
    this.state = 'address';
    this.bits = 0;
    this.byte = 0;
    this.sdaLow = false;
  }

  stop() {
    this.device?.i2cStop?.();
    this.device = null;
    this.state = 'idle';
    this.sdaLow = false;
  }

  /** SCL went HIGH: the receiver samples SDA. */
  rise(sda) {
    if (this.state === 'address' || this.state === 'write') {
      this.byte = ((this.byte << 1) | (sda ? 1 : 0)) & 0xff;
      this.bits++;
    } else if (this.state === 'master-ack') {
      this.masterAck = !sda;
    }
  }

  /** SCL went LOW: the transmitter may change SDA. */
  fall() {
    switch (this.state) {
      case 'address':
        if (this.bits < 8) return;
        this.read = !!(this.byte & 1);
        this.device = this.bus.devices.get(this.byte >> 1) || null;
        if (this.device && this.device.i2cConnect?.(this.read) !== false) {
          this.sdaLow = true; // ACK
          this.state = 'address-ack';
        } else {
          this.device = null;
          this.state = 'ignore';
        }
        return;
      case 'address-ack':
        if (this.read) this.sendByte();
        else this.receiveByte();
        return;
      case 'write':
        if (this.bits < 8) return;
        this.sdaLow = this.device.i2cWrite?.(this.byte) !== false; // ACK, or NACK
        this.state = 'write-ack';
        return;
      case 'write-ack':
        this.receiveByte();
        return;
      case 'read':
        if (this.bits < 8) {
          this.sdaLow = !(this.byte & (0x80 >> this.bits));
          this.bits++;
        } else {
          this.sdaLow = false; // the master ACKs or NACKs
          this.state = 'master-ack';
        }
        return;
      case 'master-ack':
        if (this.masterAck) this.sendByte();
        else { this.sdaLow = false; this.state = 'ignore'; }
        return;
      default:
    }
  }

  receiveByte() {
    this.sdaLow = false;
    this.state = 'write';
    this.bits = 0;
    this.byte = 0;
  }

  /** Put the next byte's MSB on SDA while SCL is LOW. */
  sendByte() {
    this.byte = (this.device?.i2cRead ? this.device.i2cRead(true) : 0xff) & 0xff;
    this.sdaLow = !(this.byte & 0x80);
    this.bits = 1;
    this.state = 'read';
  }
}

export class TinyUsi {
  /**
   * @param {import('avr8js').CPU} cpu
   * @param {import('avr8js').AVRIOPort} port PORTB
   * @param {import('./avr-runner.js').I2CBus} i2c
   */
  constructor(cpu, port, cfg = usiConfig, i2c) {
    this.cpu = cpu;
    this.port = port;
    this.cfg = cfg;
    this.bridge = new I2CPinBridge(i2c);
    this.latch = true;          // the output latch: what USIDR bit 7 last put out
    this.sda = true;            // bus levels as last seen
    this.scl = true;
    this._overrides = new Set();
    this.strobeCounts = false;  // USICLK as last written
    this._busy = false;

    const irq = (address, flag, enable) => ({ address, flagRegister: cfg.USISR, flagMask: flag, enableRegister: cfg.USICR, enableMask: enable });
    this.START = irq(cfg.startInterrupt, USISIF, USISIE);
    this.OVF = irq(cfg.ovfInterrupt, USIOIF, USIOIE);

    const hooks = cpu.writeHooks;
    hooks[cfg.USIDR] = (value) => {
      cpu.data[cfg.USIDR] = value;
      this.updateLatch();
      return true;
    };
    hooks[cfg.USISR] = (value) => {
      // Flags clear by writing 1; USIDC is read-only; the counter is written as is.
      const flags = cpu.data[cfg.USISR] & (USISIF | USIOIF | USIPF) & ~value;
      cpu.data[cfg.USISR] = flags | (value & 0x0f);
      cpu.clearInterruptByFlag(this.START, value);
      cpu.clearInterruptByFlag(this.OVF, value);
      return true;
    };
    cpu.readHooks[cfg.USISR] = () => {
      const collision = this.twoWire && this.latch && !this.sda;
      return (cpu.data[cfg.USISR] = (cpu.data[cfg.USISR] & ~USIDC) | (collision ? USIDC : 0));
    };
    hooks[cfg.USICR] = (value) => {
      const wasTwoWire = this.twoWire;
      cpu.data[cfg.USICR] = value & ~(USICLK | USITC); // both read as 0
      // With an external clock, USICLK selects USITC strobes as the counter's clock.
      this.strobeCounts = !!(value & USICLK);
      cpu.updateInterruptEnable(this.START, value);
      cpu.updateInterruptEnable(this.OVF, value);
      if (this.twoWire !== wasTwoWire) {
        const lines = (1 << cfg.di) | (1 << cfg.usck);
        port.openCollector = this.twoWire ? port.openCollector | lines : port.openCollector & ~lines;
      }
      this.updateLatch();
      this.updateOutputs();
      const source = this.clockSource;
      if ((value & USICLK) && source === 0) {
        this.shift();
        this.count();
      }
      if (value & USITC) {
        // Toggle the USCK/SCL PORT bit; the edge shifts through the bus watcher.
        cpu.writeData(cfg.PORT, cpu.data[cfg.PORT] ^ (1 << cfg.usck));
        if ((value & USICLK) && source >= 2) this.count();
      }
      return true;
    };
    // PINB reads see a device holding SDA LOW.
    const sdaMask = 1 << cfg.di;
    cpu.readHooks[cfg.PIN] = () => (this.bridge.sdaLow ? cpu.data[cfg.PIN] & ~sdaMask : cpu.data[cfg.PIN]);
    // A PORTB write changes what two-wire mode puts on SDA.
    const portWrite = hooks[cfg.PORT];
    hooks[cfg.PORT] = (value, oldValue, addr, mask) => {
      const handled = portWrite(value, oldValue, addr, mask);
      this.updateOutputs();
      return handled;
    };
    port.addListener(() => this.busChanged());
  }

  /** A chip reset: registers to 0, pins back to PORTB, the bus released. */
  reset() {
    const { cpu, cfg } = this;
    cpu.writeData(cfg.USICR, 0);
    for (const reg of [cfg.USISR, cfg.USIDR, cfg.USIBR]) cpu.data[reg] = 0;
    this.bridge.stop();
    this.busChanged();
  }

  get mode() { return (this.cpu.data[this.cfg.USICR] >> 4) & 3; }
  get twoWire() { return this.mode >= 2; }
  get threeWire() { return this.mode === 1; }
  /** USICS1:0: 0 software strobe, 1 Timer0 compare, 2 external positive edge, 3 external negative edge. */
  get clockSource() { return (this.cpu.data[this.cfg.USICR] >> 2) & 3; }

  /** Whether this chip pulls a line LOW: its DDR bit set and its output 0. */
  _drivesLow(bit) {
    return !!(this.cpu.data[this.cfg.DDR] & (1 << bit)) && !(this.port.lastValue & (1 << bit));
  }

  busLevels() {
    return { sda: !(this._drivesLow(this.cfg.di) || this.bridge.sdaLow), scl: !this._drivesLow(this.cfg.usck) };
  }

  /** React to SDA/SCL changes: START and STOP, then clock edges. */
  busChanged() {
    if (this._busy) return;
    this._busy = true;
    try {
      for (let i = 0; i < 4; i++) {
        const { sda, scl } = this.busLevels();
        if (sda === this.sda && scl === this.scl) break;
        const sclRose = scl && !this.scl;
        const sclFell = !scl && this.scl;
        const sdaChanged = sda !== this.sda;
        this.sda = sda;
        this.scl = scl;
        if (sdaChanged && scl && !sclRose) {
          if (!sda) this.startCondition();
          else this.stopCondition();
        }
        if (sclRose) this.clockEdge(true);
        if (sclFell) this.clockEdge(false);
        this.updateLatch();
      }
    } finally {
      this._busy = false;
    }
  }

  startCondition() {
    if (this.twoWire) this.cpu.setInterruptFlag(this.START);
    this.bridge.start();
  }

  stopCondition() {
    if (this.twoWire) this.cpu.data[this.cfg.USISR] |= USIPF;
    this.bridge.stop();
  }

  clockEdge(rising) {
    if (rising) this.bridge.rise(this.sda);
    else this.bridge.fall();
    if (!this.mode) return;
    const source = this.clockSource;
    if (source < 2) return;
    // USICS0 = 0 shifts on the rising edge, 1 on the falling edge.
    if (rising === (source === 2)) this.shift();
    // Without USICLK the counter counts both external edges.
    if (!this.strobeCounts) this.count();
  }

  /** Shift one bit in at USIDR bit 0: SDA in two-wire mode, the DI pin otherwise. */
  shift() {
    const { cpu, cfg } = this;
    const input = this.twoWire ? (this.sda ? 1 : 0) : (cpu.data[cfg.PIN] >> cfg.di) & 1;
    cpu.data[cfg.USIDR] = ((cpu.data[cfg.USIDR] << 1) | input) & 0xff;
    this.updateLatch();
  }

  count() {
    const { cpu, cfg } = this;
    const counter = (cpu.data[cfg.USISR] + 1) & 0x0f;
    cpu.data[cfg.USISR] = (cpu.data[cfg.USISR] & 0xf0) | counter;
    if (!counter) {
      cpu.data[cfg.USIBR] = cpu.data[cfg.USIDR];
      cpu.setInterruptFlag(this.OVF);
    }
  }

  /**
   * The output latch passes USIDR bit 7 during the first half of an external
   * clock cycle (SCL LOW when shifting on the rising edge) and always with an
   * internal clock, so data changes on the edge opposite the one sampling it.
   */
  updateLatch() {
    const source = this.clockSource;
    const open = source < 2 || (source === 2 ? !this.scl : this.scl);
    if (!open) return;
    const latch = !!(this.cpu.data[this.cfg.USIDR] & 0x80);
    if (latch === this.latch) return;
    this.latch = latch;
    this.updateOutputs();
  }

  /** SDA (two-wire) or DO (three-wire) follows the latch; other modes leave the pins to PORTB. */
  updateOutputs() {
    const { cfg } = this;
    const want = new Map();
    if (this.twoWire) want.set(cfg.di, this.latch && !!(this.cpu.data[cfg.PORT] & (1 << cfg.di)));
    else if (this.threeWire) want.set(cfg.do, this.latch);
    for (const [pin, high] of want) this.port.timerOverridePin(pin, high ? Override.Set : Override.Clear);
    for (const pin of this._overrides) if (!want.has(pin)) this.port.timerOverridePin(pin, Override.None);
    this._overrides = new Set(want.keys());
  }
}
