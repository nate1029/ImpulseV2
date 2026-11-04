// The ATmega32U4's USB device controller, and a computer on the other end of
// the cable. Leonardo-family boards have no USB-to-serial chip: their Serial
// is the 32U4's own USB port (the core's CDC ACM class). So the model plays
// the host: it resets the bus, enumerates the board (descriptors, address,
// configuration), opens the serial port (line coding, DTR, so
// `while (!Serial)` passes), then carries Serial both ways over the bulk
// endpoints and sends a start-of-frame every millisecond, which the core uses
// to flush Serial and time its TX/RX LEDs.
//
// Registers and bits follow the ATmega16U4/32U4 datasheet, chapters 21–22.

const vec = (n) => n * 2;

export const usb32u4Config = {
  PLLCSR: 0x49,
  UHWCON: 0xd7, USBCON: 0xd8, USBSTA: 0xd9, USBINT: 0xda,
  UDCON: 0xe0, UDINT: 0xe1, UDIEN: 0xe2, UDADDR: 0xe3, UDFNUML: 0xe4, UDFNUMH: 0xe5, UDMFN: 0xe6,
  UEINTX: 0xe8, UENUM: 0xe9, UERST: 0xea, UECONX: 0xeb, UECFG0X: 0xec, UECFG1X: 0xed,
  UESTA0X: 0xee, UESTA1X: 0xef, UEIENX: 0xf0, UEDATX: 0xf1, UEBCLX: 0xf2, UEBCHX: 0xf3, UEINT: 0xf4,
  genInterrupt: vec(10),
  comInterrupt: vec(11),
};

// UEINTX
const TXINI = 0x01;
const RXOUTI = 0x04;
const RXSTPI = 0x08;
const RWAL = 0x20;
const FIFOCON = 0x80;
// UDINT / UDIEN
const SOFI = 0x04;
const EORSTI = 0x08;
// Others
const USBE = 0x80;
const FRZCLK = 0x20;
const DETACH = 0x01;
const EPEN = 0x01;
const STALLRQ = 0x20;
const PLLE = 0x02;
const PLOCK = 0x01;

const EP_COUNT = 7;
const FRAME_MS = 1;

/** A control transfer: the 8-byte SETUP, then data out, or how much to read. */
const setup = (bmRequestType, bRequest, wValue, wIndex, wLength) => [
  bmRequestType, bRequest, wValue & 0xff, wValue >> 8, wIndex & 0xff, wIndex >> 8, wLength & 0xff, wLength >> 8,
];

export class Usb32u4 {
  /**
   * @param {import('avr8js').CPU} cpu
   * @param {typeof usb32u4Config} cfg
   * @param {{ cyclesPerMs: number, onSerial?: (byte: number) => void, onConfigured?: () => void }} opts
   */
  constructor(cpu, cfg, opts) {
    this.cpu = cpu;
    this.cfg = cfg;
    this.cyclesPerMs = opts.cyclesPerMs;
    this.onSerial = opts.onSerial || null;
    this.onConfigured = opts.onConfigured || null;
    this.eps = Array.from({ length: EP_COUNT }, () => this._newEndpoint());
    this.udint = 0;
    this.udien = 0;
    this.frame = 0;
    this.attached = false;
    this.configured = false;
    this.lineState = 0;
    this.txQueue = [];      // bytes typed into Serial, waiting for the OUT endpoint
    this.inEp = 3;          // CDC data endpoints, from the configuration descriptor
    this.outEp = 2;
    this._host = null;      // the control transfer in progress
    this._steps = [];
    this._sofEvent = null;
    this._genIrq = { address: cfg.genInterrupt, enableRegister: cfg.UDIEN, enableMask: 0xff, flagRegister: cfg.UDINT, flagMask: 0xff, constant: true };
    this._comIrq = { address: cfg.comInterrupt, enableRegister: cfg.UEIENX, enableMask: 0xff, flagRegister: cfg.UEINTX, flagMask: 0xff, constant: true };
    this.reset();
    this._hook();
  }

  /** Power-on state (also after a watchdog reset). */
  reset() {
    this.eps = Array.from({ length: EP_COUNT }, () => this._newEndpoint());
    this.udint = 0;
    this.udien = 0;
    this.attached = false;
    this.configured = false;
    this.lineState = 0;
    this._host = null;
    this._steps = [];
    this.cpu.data[this.cfg.UDCON] = DETACH;
    this.cpu.data[this.cfg.USBCON] = FRZCLK;
    this.cpu.clearInterrupt(this._genIrq, false);
    this.cpu.clearInterrupt(this._comIrq, false);
  }

  _newEndpoint() {
    return { epen: false, cfg0: 0, cfg1: 0, ueintx: 0, ueienx: 0, fifo: [] };
  }

  get _ep() {
    return this.eps[this.cpu.data[this.cfg.UENUM] & 7] || this.eps[0];
  }

  // ── Registers ────────────────────────────────────────────────────────────

  _hook() {
    const { cpu, cfg } = this;
    const store = (addr, fn) => { cpu.writeHooks[addr] = (value) => { fn(value); return true; }; };

    // The PLL locks as soon as it's on.
    cpu.readHooks[cfg.PLLCSR] = () => (cpu.data[cfg.PLLCSR] & ~PLOCK) | (cpu.data[cfg.PLLCSR] & PLLE ? PLOCK : 0);
    cpu.readHooks[cfg.USBSTA] = () => 0x01; // VBUS present
    store(cfg.USBCON, (v) => { cpu.data[cfg.USBCON] = v; this._checkAttach(); });
    store(cfg.UDCON, (v) => { cpu.data[cfg.UDCON] = v; this._checkAttach(); });

    // Interrupt flags are cleared by writing 0; writing 1 changes nothing.
    cpu.readHooks[cfg.UDINT] = () => this.udint;
    store(cfg.UDINT, (v) => { this.udint &= v; this._irq(); });
    cpu.readHooks[cfg.UDIEN] = () => this.udien;
    store(cfg.UDIEN, (v) => { this.udien = v; this._irq(); });
    cpu.readHooks[cfg.UDFNUML] = () => this.frame & 0xff;
    cpu.readHooks[cfg.UDFNUMH] = () => (this.frame >> 8) & 0x07;

    store(cfg.UENUM, (v) => { cpu.data[cfg.UENUM] = v & 7; });
    store(cfg.UERST, (v) => {
      for (let i = 1; i < EP_COUNT; i++) if (v & (1 << i)) this._resetEndpoint(i, this.eps[i].epen);
    });
    cpu.readHooks[cfg.UECONX] = () => (this._ep.epen ? EPEN : 0);
    store(cfg.UECONX, (v) => {
      const ep = this._ep;
      const i = this.eps.indexOf(ep);
      const was = ep.epen;
      ep.epen = !!(v & EPEN);
      if (ep.epen && !was) this._resetEndpoint(i, true);
      // A stalled request: the host gives up on it and goes on.
      if (v & STALLRQ && i === 0 && this._host && !this._host.finished) this._finish(this._host);
    });
    cpu.readHooks[cfg.UECFG0X] = () => this._ep.cfg0;
    store(cfg.UECFG0X, (v) => {
      this._ep.cfg0 = v;
      const i = this.eps.indexOf(this._ep);
      if (i > 0 && this._ep.epen) this._resetEndpoint(i, true);
    });
    cpu.readHooks[cfg.UECFG1X] = () => this._ep.cfg1;
    store(cfg.UECFG1X, (v) => { this._ep.cfg1 = v; });
    cpu.readHooks[cfg.UESTA0X] = () => (this._ep.epen && this._ep.cfg1 & 0x02 ? 0x80 : 0); // CFGOK when allocated
    cpu.readHooks[cfg.UEIENX] = () => this._ep.ueienx;
    store(cfg.UEIENX, (v) => { this._ep.ueienx = v; this._irq(); });
    cpu.readHooks[cfg.UEINTX] = () => this._ueintx(this._ep);
    store(cfg.UEINTX, (v) => this._writeUeintx(this.eps.indexOf(this._ep), v));
    cpu.readHooks[cfg.UEDATX] = () => this._ep.fifo.shift() ?? 0;
    store(cfg.UEDATX, (v) => { if (this._ep.fifo.length < 64) this._ep.fifo.push(v); });
    cpu.readHooks[cfg.UEBCLX] = () => Math.min(255, this._ep.fifo.length);
    cpu.readHooks[cfg.UEBCHX] = () => 0;
    cpu.readHooks[cfg.UEINT] = () => this.eps.reduce((m, ep, i) => (ep.ueintx & ep.ueienx & 0xdf ? m | (1 << i) : m), 0);
  }

  _isIn(ep) {
    return !!(ep.cfg0 & 0x01);
  }

  _resetEndpoint(i, keepConfig = false) {
    const ep = this.eps[i];
    ep.fifo = [];
    ep.ueintx = 0;
    if (!keepConfig) return;
    // An IN endpoint starts with a free bank; control endpoint 0 too.
    if (i === 0 || this._isIn(ep)) ep.ueintx = TXINI | RWAL | FIFOCON;
  }

  /** UEINTX as read: RWAL follows the bank (room to write on IN, data to read on OUT). */
  _ueintx(ep) {
    let v = ep.ueintx & ~RWAL;
    const i = this.eps.indexOf(ep);
    if (i === 0) return v;
    if (this._isIn(ep)) { if (ep.fifo.length < 64 && ep.ueintx & FIFOCON) v |= RWAL; } else if (ep.fifo.length) v |= RWAL;
    return v;
  }

  _writeUeintx(i, v) {
    const ep = this.eps[i];
    const before = ep.ueintx;
    ep.ueintx &= v | RWAL;
    const cleared = before & ~ep.ueintx;
    if (i === 0) {
      // Control endpoint. Clearing RXSTPI takes the SETUP (the same write
      // clears a stale TXINI and RXOUTI); clearing TXINI on its own sends
      // what's in the FIFO, or a zero-length status packet.
      if (cleared & RXSTPI) {
        ep.fifo = [];
        this._setupTaken();
      } else {
        if (cleared & TXINI) this._controlIn(ep.fifo.splice(0));
        if (cleared & RXOUTI) this._controlOutTaken();
      }
    } else if (cleared & FIFOCON) {
      if (this._isIn(ep)) {
        // Bank released: the host takes it at once and the bank is free again.
        const data = ep.fifo.splice(0);
        ep.ueintx |= TXINI | FIFOCON;
        if (i === this.inEp && this.configured) for (const b of data) this.onSerial?.(b);
      } else {
        ep.fifo = [];
        ep.ueintx &= ~RXOUTI;
        this._feedOut();
      }
    }
    this._irq();
  }

  _irq() {
    const { cpu } = this;
    const on = !!(cpu.data[this.cfg.USBCON] & USBE);
    if (on && this.udint & this.udien & 0x7f) cpu.queueInterrupt(this._genIrq);
    else cpu.clearInterrupt(this._genIrq, false);
    const com = this.eps.some(ep => ep.ueintx & ep.ueienx & 0xdf);
    if (on && com) cpu.queueInterrupt(this._comIrq);
    else cpu.clearInterrupt(this._comIrq, false);
  }

  // ── The host ─────────────────────────────────────────────────────────────

  _checkAttach() {
    const { cpu, cfg } = this;
    const usbcon = cpu.data[cfg.USBCON];
    const up = !!(usbcon & USBE) && !(usbcon & FRZCLK) && !(cpu.data[cfg.UDCON] & DETACH);
    if (up === this.attached) return;
    this.attached = up;
    if (!up) {
      this.configured = false;
      return;
    }
    // Bus reset a few milliseconds after the pull-up appears, then frames and enumeration.
    this._after(5, () => {
      this.udint |= EORSTI;
      this._irq();
      this._startFrames();
      this._after(5, () => this._enumerate());
    });
  }

  _after(ms, fn) {
    this.cpu.addClockEvent(fn, Math.max(1, Math.round(ms * this.cyclesPerMs)));
  }

  _startFrames() {
    if (this._sofRunning) return;
    this._sofRunning = true;
    const tick = () => {
      if (!this.attached) { this._sofRunning = false; return; }
      this.frame = (this.frame + 1) & 0x7ff;
      this.udint |= SOFI;
      this._irq();
      this._feedOut();
      this._after(FRAME_MS, tick);
    };
    this._after(FRAME_MS, tick);
  }

  _enumerate() {
    this._steps = [
      { setup: setup(0x80, 6, 0x0100, 0, 64) },                 // GET_DESCRIPTOR device
      { setup: setup(0x00, 5, 7, 0, 0) },                       // SET_ADDRESS 7
      { setup: setup(0x80, 6, 0x0100, 0, 18) },
      { setup: setup(0x80, 6, 0x0200, 0, 9) },                  // GET_DESCRIPTOR configuration
      { setup: setup(0x80, 6, 0x0200, 0, 255), onData: (d) => this._readConfiguration(d) },
      { setup: setup(0x00, 9, 1, 0, 0) },                       // SET_CONFIGURATION 1
      // CDC: 115200 baud, 8N1, then DTR and RTS on (the port is open).
      { setup: () => setup(0x21, 0x20, 0, this.cdcInterface, 7), out: [0x00, 0xc2, 0x01, 0x00, 0x00, 0x00, 0x08] },
      { setup: () => setup(0x21, 0x22, 0x03, this.cdcInterface, 0), done: () => { this.lineState = 3; } },
    ];
    this.cdcInterface = 0;
    this._nextStep();
  }

  _nextStep() {
    const step = this._steps.shift();
    if (!step) {
      this._host = null;
      this.configured = true;
      this.onConfigured?.();
      this._feedOut();
      return;
    }
    const bytes = typeof step.setup === 'function' ? step.setup() : step.setup;
    this._host = { step, in: [], wLength: bytes[6] | (bytes[7] << 8), toHost: !!(bytes[0] & 0x80), stage: 'setup' };
    const ep0 = this.eps[0];
    ep0.fifo = bytes.slice();
    ep0.ueintx |= RXSTPI;
    this._irq();
    // A board that never answers (no USB code) leaves the host waiting, as a real one would.
  }

  _setupTaken() {
    const h = this._host;
    if (!h || h.stage !== 'setup') return;
    if (!h.toHost && h.step.out) {
      // Data stage: the OUT packet, once the firmware has taken the SETUP.
      h.stage = 'out';
      this._after(0.05, () => {
        const ep0 = this.eps[0];
        ep0.fifo = h.step.out.slice();
        ep0.ueintx |= RXOUTI;
        this._irq();
      });
      return;
    }
    h.stage = h.toHost ? 'in' : 'status';
    // The control IN bank is free for the firmware to fill.
    this.eps[0].ueintx |= TXINI;
    this._irq();
  }

  _controlOutTaken() {
    const h = this._host;
    if (!h || h.stage !== 'out') return;
    h.stage = 'status';
    this.eps[0].ueintx |= TXINI;
    this._irq();
  }

  _controlIn(data) {
    const h = this._host;
    const ep0 = this.eps[0];
    if (!h) { ep0.ueintx |= TXINI; return; }
    if (h.stage === 'in') {
      h.in.push(...data);
      // A short packet or the full length ends the data stage.
      if (data.length < 64 || h.in.length >= h.wLength) this._finish(h);
      else ep0.ueintx |= TXINI;
      return;
    }
    // Status stage (a zero-length packet) of a request without IN data.
    this._finish(h);
  }

  _finish(h) {
    if (h.finished) return;
    h.finished = true;
    h.step.onData?.(h.in);
    h.step.done?.();
    this.eps[0].ueintx |= TXINI;
    this._after(0.1, () => this._nextStep());
  }

  /** The CDC interface and its bulk endpoints, from the configuration descriptor. */
  _readConfiguration(d) {
    let iface = -1;
    let cdcClass = false;
    for (let i = 0; i + 1 < d.length && d[i] > 0; i += d[i]) {
      const type = d[i + 1];
      if (type === 4) {
        iface = d[i + 2];
        cdcClass = d[i + 5] === 0x02 || d[i + 5] === 0x0a;
        if (d[i + 5] === 0x02 && d[i + 6] === 0x02) this.cdcInterface = iface;
      } else if (type === 5 && cdcClass && (d[i + 3] & 3) === 2) {
        const addr = d[i + 2];
        if (addr & 0x80) this.inEp = addr & 0x0f;
        else this.outEp = addr & 0x0f;
      }
    }
  }

  /** Typed text into the OUT endpoint, a bank at a time. */
  _feedOut() {
    if (!this.configured || !this.txQueue.length) return;
    const ep = this.eps[this.outEp];
    if (!ep?.epen || ep.fifo.length || ep.ueintx & RXOUTI) return;
    ep.fifo = this.txQueue.splice(0, 64);
    ep.ueintx |= RXOUTI | FIFOCON;
    this._irq();
  }

  /** Text from the Serial monitor to the board's Serial. */
  write(bytes) {
    this.txQueue.push(...bytes);
    this._feedOut();
  }
}
