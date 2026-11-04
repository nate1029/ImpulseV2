const { EventEmitter } = require('events');
const { SerialPort } = require('serialport');

// Lines are assembled here, not in the window: a window that is busy (or not
// even showing the serial pane) can no longer lose output, both views and the
// agent read the same history, and a fast-printing sketch costs one batched
// message every FLUSH_MS instead of one per chunk.
const MAX_LINES = 5000;
const FLUSH_MS = 40;
// A device that prints without newlines still shows: flush a partial line when
// it goes quiet, or when it grows past this.
const PARTIAL_IDLE_MS = 150;
const MAX_PARTIAL = 4096;

/**
 * Whether two port names are the same device. macOS gives every serial device
 * two names, /dev/cu.X and /dev/tty.X; arduino-cli lists the cu. one and the
 * serialport library the tty. one, so a plain string comparison never matches.
 */
function samePort(a, b) {
  const norm = (v) => String(v || '').replace(/^\/dev\/(cu|tty)\./, '/dev/');
  return !!a && !!b && norm(a) === norm(b);
}

class SerialMonitor extends EventEmitter {
  constructor() {
    super();
    /** The last MAX_LINES lines, for both views, the agent and reopened panes. */
    this.lines = [];
    this._seq = 0;
    this._partial = '';
    this._pending = [];
    this._flushTimer = null;
    this._partialTimer = null;
    // An upload needs the port: it is closed and reopened around the upload.
    this._resumeAfterUpload = null;
    this.port = null;
    this.parser = null;
    this.isConnected = false;
    this.currentBaudRate = null;
    this.commonBaudRates = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
    this.autoBaudRateDetection = true;

    // Auto-reconnect state
    this._autoReconnect = true;
    this._lastPortPath = null;
    this._lastBaudRate = null;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 200;  // about a minute of trying at 300 ms
    this._reconnectIntervalMs = 300;  // a board on native USB is back within a second of waking
    this._intentionalDisconnect = false;
  }

  async listPorts() {
    try {
      const ports = await SerialPort.list();
      return ports.map(port => ({
        path: port.path,
        manufacturer: port.manufacturer || 'Unknown',
        vendorId: port.vendorId,
        productId: port.productId,
        serialNumber: port.serialNumber
      }));
    } catch (error) {
      throw new Error(`Failed to list serial ports: ${error.message}`);
    }
  }

  async connect(portPath, baudRate = 9600) {
    if (this.isConnected) {
      await this.disconnect();
    }

    try {
      this.port = new SerialPort({
        path: portPath,
        baudRate: baudRate,
        autoOpen: false
      });

      // Set up event handlers BEFORE opening the port.
      // NOTE: We intentionally stream raw chunks instead of a line-based parser.
      // Many devices don't always end lines with '\n' (or may output binary),
      // and a Readline parser can make it look like "serial monitor doesn't work"
      // because it buffers until a delimiter is found.
      this.parser = null;

      this.port.on('data', (chunk) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        // Raw chunks still go out for anything that wants them; lines are what the UI reads.
        this.emit('data', { timestamp: new Date().toISOString(), data: text, baudRate: this.currentBaudRate });
        this._take(text);
      });

      this.port.on('error', (error) => {
        this.record(`Serial error: ${error.message}`, 'error');
        this.emit('error', error);
      });

      this.port.on('close', () => {
        this.isConnected = false;
        this._flushPartial();
        if (!this._intentionalDisconnect) this.record('The board disconnected.', 'info');
        this.emit('disconnected');
        // Trigger auto-reconnect if disconnect was not intentional (USB yanked)
        if (this._autoReconnect && !this._intentionalDisconnect && this._lastPortPath) {
          this._startReconnect();
        }
      });

      // Open the port (using promise-based API)
      await new Promise((resolve, reject) => {
        this.port.open((error) => {
          if (error) {
            reject(new Error(`Failed to open port: ${error.message}`));
          } else {
            resolve();
          }
        });
      });

      this._flushPartial();
      this.isConnected = true;
      this.currentBaudRate = baudRate;
      this._lastPortPath = portPath;
      this._lastBaudRate = baudRate;
      this._intentionalDisconnect = false;
      this._reconnectAttempts = 0;
      this._stopReconnect();
      this.emit('connected');
    } catch (error) {
      throw new Error(`Failed to create serial connection: ${error.message}`);
    }
  }

  async disconnect({ keepLines = true } = {}) {
    this._intentionalDisconnect = true;
    this._stopReconnect();
    this._flushPartial();
    if (!keepLines) this.clearLines();
    return new Promise((resolve) => {
      if (this.port && this.isConnected) {
        this.port.close((error) => {
          if (error) {
            console.error('Error closing port:', error);
          }
          this.isConnected = false;
          this.port = null;
          this.parser = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  async send(data) {
    if (!this.isConnected || !this.port) {
      throw new Error('Serial port not connected');
    }

    return new Promise((resolve, reject) => {
      this.port.write(data, (error) => {
        if (error) {
          reject(new Error(`Failed to send data: ${error.message}`));
        } else {
          // Wait for drain to ensure data is sent
          this.port.drain((error) => {
            if (error) {
              reject(new Error(`Failed to drain: ${error.message}`));
            } else {
              resolve();
            }
          });
        }
      });
    });
  }

  async tryBaudRates(portPath) {
    if (!this.autoBaudRateDetection) {
      return null;
    }

    for (const baudRate of this.commonBaudRates) {
      try {
        await this.connect(portPath, baudRate);
        // Wait a bit to see if we get valid data
        await new Promise(resolve => setTimeout(resolve, 500));
        
        if (this.isConnected) {
          return baudRate;
        }
      } catch (error) {
        // Try next baud rate
        continue;
      }
    }

    return null;
  }

  setBaudRate(baudRate) {
    if (this.isConnected && this.port) {
      this.currentBaudRate = baudRate;
      // Note: Changing baud rate requires reconnection
      // This is a simplified version
    }
  }

  /**
   * Check if connected (method version for compatibility)
   */
  isConnectedStatus() {
    return this.isConnected;
  }

  /**
   * Get current baud rate
   */
  getBaudRate() {
    return this.currentBaudRate;
  }

  // ==================== Lines ====================

  /** A chunk from the port: split into lines, keep a partial for the next chunk. */
  _take(text) {
    this._partial += text;
    let nl;
    while ((nl = this._partial.indexOf('\n')) !== -1) {
      const line = this._partial.slice(0, nl).replace(/\r$/, '');
      this._partial = this._partial.slice(nl + 1);
      this.record(line, 'rx');
    }
    if (this._partial.length > MAX_PARTIAL) this._flushPartial();
    // A sketch that prints without a newline (a prompt, a progress dot) still shows.
    clearTimeout(this._partialTimer);
    if (this._partial.length) this._partialTimer = setTimeout(() => this._flushPartial(), PARTIAL_IDLE_MS);
  }

  _flushPartial() {
    clearTimeout(this._partialTimer);
    this._partialTimer = null;
    if (!this._partial.length) return;
    const line = this._partial;
    this._partial = '';
    this.record(line, 'rx');
  }

  /**
   * Add one line to the history and the next batch. Everything the user sees
   * goes through here, so what was sent and what the app said are in order
   * with what the board printed.
   * @param {string} text
   * @param {'rx'|'tx'|'info'|'error'} kind
   */
  record(text, kind = 'info') {
    const line = { seq: ++this._seq, at: new Date().toISOString(), text: String(text ?? ''), kind };
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    this._pending.push(line);
    if (!this._flushTimer) this._flushTimer = setTimeout(() => this._flush(), FLUSH_MS);
    return line;
  }

  _flush() {
    clearTimeout(this._flushTimer);
    this._flushTimer = null;
    if (!this._pending.length) return;
    const batch = this._pending;
    this._pending = [];
    this.emit('lines', batch);
  }

  /** The last `n` lines (the agent and a reopened pane read this). */
  recent(n = 200) {
    return this.lines.slice(Math.max(0, this.lines.length - Math.max(1, n)));
  }

  clearLines() {
    this.lines = [];
    this._pending = [];
    this._partial = '';
    this.emit('cleared');
  }

  // ==================== Uploads ====================

  /**
   * Free the port for an upload, remembering whether to reopen it afterwards.
   * Every upload path goes through here, so the monitor behaves the same from
   * the IDE, chat mode and the agent.
   */
  async holdForUpload() {
    if (!this.isConnected) {
      this._resumeAfterUpload = null;
      return false;
    }
    this._resumeAfterUpload = { port: this._lastPortPath, baudRate: this.currentBaudRate };
    this.record('Closing the port for the upload…', 'info');
    await this.disconnect();
    return true;
  }

  /**
   * Reopen the port after an upload, waiting for the board to come back (a
   * board with native USB re-enumerates and can take a few seconds).
   * @param {{ port?: string, timeoutMs?: number }} [opts]
   */
  async resumeAfterUpload({ port = null, timeoutMs = 12000 } = {}) {
    const want = this._resumeAfterUpload;
    this._resumeAfterUpload = null;
    if (!want) return false;
    const path = port || want.port;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      let here = false;
      try {
        here = (await SerialPort.list()).some((p) => samePort(p.path, path));
      } catch { /* listing failed; try again */ }
      if (!here) continue;
      try {
        await this.connect(path, want.baudRate || 115200);
        this.record(`Reconnected to ${path} after the upload.`, 'info');
        this.emit('reconnected', { port: path });
        return true;
      } catch { /* the board is still coming up */ }
    }
    this.record(`${path} did not come back after the upload. Connect again when the board is ready.`, 'info');
    this.emit('reconnect-failed', { port: path });
    return false;
  }

  // ==================== Auto-Reconnect ====================

  /**
   * Start polling for the port to reappear after USB disconnect.
   * Emits 'reconnecting' with attempt count, and reconnects automatically.
   */
  _startReconnect() {
    if (this._reconnectTimer) return; // Already reconnecting
    this._reconnectAttempts = 0;

    this.emit('reconnecting', { attempt: 0, port: this._lastPortPath });

    this._reconnectTimer = setInterval(async () => {
      this._reconnectAttempts++;

      if (this._reconnectAttempts > this._maxReconnectAttempts) {
        this._stopReconnect();
        this.emit('reconnect-failed', { port: this._lastPortPath });
        return;
      }

      try {
        // Check if the port has reappeared
        const ports = await SerialPort.list();
        const found = ports.some(p => samePort(p.path, this._lastPortPath));

        if (found) {
          this._stopReconnect();
          this.record(`${this._lastPortPath} is back; reconnecting…`, 'info');
          this.emit('reconnecting', {
            attempt: this._reconnectAttempts,
            port: this._lastPortPath,
            status: 'port-found'
          });

          // A moment for the OS to finish enumerating the device (a failed
          // open below just starts the poll again).
          await new Promise(r => setTimeout(r, 350));

          try {
            await this.connect(this._lastPortPath, this._lastBaudRate);
            this.record(`Reconnected to ${this._lastPortPath}.`, 'info');
            this.emit('reconnected', { port: this._lastPortPath });
          } catch (err) {
            // Port appeared but connection failed — keep trying
            this._startReconnect();
          }
        } else {
          this.emit('reconnecting', {
            attempt: this._reconnectAttempts,
            port: this._lastPortPath,
            status: 'waiting'
          });
        }
      } catch (err) {
        // List failed — keep trying
      }
    }, this._reconnectIntervalMs);
  }

  _stopReconnect() {
    if (this._reconnectTimer) {
      clearInterval(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  /**
   * Enable/disable auto-reconnect
   */
  setAutoReconnect(enabled) {
    this._autoReconnect = enabled;
    if (!enabled) {
      this._stopReconnect();
    }
  }
}

module.exports = SerialMonitor;
module.exports.samePort = samePort;

