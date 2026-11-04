/**
 * One run of an ESP32 sketch in Espressif's QEMU. QEMU connects back to three
 * local sockets: UART0 (the sketch's Serial), the simulator bridge on UART1
 * (impulse_sim.cpp, line messages both ways) and the QEMU monitor (pause,
 * resume, reset). Plain Node, so the command-line test runner uses it too.
 * @module main/services/esp32sim/session
 */

const net = require('net');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

/** QEMU machine and binary per chip; the S2 isn't emulated (its sketches run on the S3). */
const MACHINES = {
  esp32: { arch: 'xtensa', machine: 'esp32', timg: 'timer.esp32.timg' },
  esp32s3: { arch: 'xtensa', machine: 'esp32s3', timg: 'timer.esp32s3.timg' },
  esp32c3: { arch: 'riscv32', machine: 'esp32c3', timg: 'timer.esp32c3.timg' },
};

const CONNECT_TIMEOUT_MS = 15000;

/** A one-connection server on a free local port. */
function listenOnce() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.maxConnections = 1;
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const connection = new Promise((res) => server.once('connection', (socket) => {
        socket.setNoDelay(true);
        res(socket);
      }));
      resolve({ server, port: server.address().port, connection });
    });
  });
}

/** The QEMU command line for a chip, a flash image and the three socket ports. */
function qemuArgs({ chip, flashPath, ports, psramMB = 0 }) {
  const m = MACHINES[chip];
  if (!m) throw new Error(`The simulator doesn't emulate the ${chip}.`);
  const sock = (id, port) => ['-chardev', `socket,id=${id},host=127.0.0.1,port=${port}`];
  return [
    '-machine', m.machine,
    '-display', 'none',
    '-monitor', 'none',
    '-drive', `file=${flashPath},if=mtd,format=raw`,
    // The watchdogs would reset a sketch the emulator runs slower than real time.
    '-global', `driver=${m.timg},property=wdt_disable,value=true`,
    ...(psramMB ? ['-m', `${psramMB}M`] : []),
    ...sock('uart0', ports.uart0), '-serial', 'chardev:uart0',
    ...sock('bridge', ports.bridge), '-serial', 'chardev:bridge',
    ...sock('mon', ports.monitor), '-mon', 'chardev=mon,mode=readline',
  ];
}

class Esp32Session extends EventEmitter {
  /**
   * @param {{ qemu: string, chip: string, flashPath: string, psramMB?: number, env?: object }} opts
   *   qemu: the qemu-system-xtensa / qemu-system-riscv32 binary for the chip
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.proc = null;
    this.sockets = {};
    this.servers = [];
    this.closed = false;
    this.stderr = '';
    this._bridgeBuf = '';
  }

  static archOf(chip) {
    return MACHINES[chip]?.arch || null;
  }

  async start() {
    const listeners = {
      uart0: await listenOnce(),
      bridge: await listenOnce(),
      monitor: await listenOnce(),
    };
    this.servers = Object.values(listeners).map(l => l.server);
    const ports = Object.fromEntries(Object.entries(listeners).map(([k, l]) => [k, l.port]));
    const args = qemuArgs({ ...this.opts, ports });
    this.proc = spawn(this.opts.qemu, args, { windowsHide: true, env: this.opts.env || process.env });
    this.proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-8000); });
    this.proc.stdout.on('data', (d) => { this.stderr = (this.stderr + d).slice(-8000); });
    const exited = new Promise((resolve) => {
      this.proc.once('error', (err) => resolve(err.message));
      this.proc.once('exit', (code, signal) => resolve(`QEMU exited (${signal || code})`));
    });
    exited.then((why) => this._closed(why));

    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timed out waiting for QEMU'), CONNECT_TIMEOUT_MS); });
    const all = Promise.all(Object.entries(listeners).map(async ([k, l]) => { this.sockets[k] = await l.connection; }));
    const outcome = await Promise.race([all.then(() => null), exited, timeout]);
    clearTimeout(timer);
    for (const s of this.servers) s.close();
    if (outcome) {
      this.stop();
      const detail = this.stderr.trim().split('\n').slice(-3).join(' ');
      throw new Error(`The ESP32 emulator didn't start: ${outcome}${detail ? ` — ${detail}` : ''}`);
    }

    this.sockets.uart0.on('data', (d) => this.emit('serial', d));
    this.sockets.bridge.on('data', (d) => this._bridgeData(d));
    this.sockets.monitor.on('data', () => {});
    for (const s of Object.values(this.sockets)) s.on('error', () => {});
  }

  _bridgeData(chunk) {
    this._bridgeBuf += chunk.toString('latin1');
    const lines = this._bridgeBuf.split('\n');
    this._bridgeBuf = lines.pop();
    if (this._bridgeBuf.length > 4096) this._bridgeBuf = '';
    const out = lines.filter(Boolean);
    if (out.length) this.emit('bridge', out);
  }

  _closed(why) {
    if (this.closed) return;
    this.closed = true;
    for (const s of Object.values(this.sockets)) s.destroy();
    this.emit('exit', why);
  }

  /** Text or bytes to the sketch's Serial (UART0). */
  writeSerial(data) {
    if (!this.closed) this.sockets.uart0?.write(data);
  }

  /** Lines to the bridge (input levels, analog values, replies). */
  sendBridge(lines) {
    if (this.closed || !this.sockets.bridge) return;
    const text = (Array.isArray(lines) ? lines : [lines]).map(l => `${l}\n`).join('');
    if (text) this.sockets.bridge.write(text, 'latin1');
  }

  _monitor(cmd) {
    if (!this.closed) this.sockets.monitor?.write(`${cmd}\n`);
  }

  pause() { this._monitor('stop'); }
  resume() { this._monitor('cont'); }
  reset() { this._monitor('system_reset'); }

  stop() {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) {
      this._monitor('quit');
      const proc = this.proc;
      setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 1500).unref?.();
    }
    for (const s of this.servers) s.close();
    this._closed('stopped');
  }
}

module.exports = { Esp32Session, qemuArgs, MACHINES };
