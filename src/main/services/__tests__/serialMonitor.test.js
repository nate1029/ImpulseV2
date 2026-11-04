/**
 * Line assembly, history and the port handover around an upload. The port
 * itself is faked: these are the parts that decide whether the monitor shows
 * everything and comes back by itself.
 */

const listed = { ports: [] };
jest.mock('serialport', () => ({
  SerialPort: Object.assign(
    function FakePort({ path, baudRate }) {
      const port = new (require('events').EventEmitter)();
      port.path = path;
      port.baudRate = baudRate;
      port.open = (cb) => setImmediate(() => cb(FakePort.failOpen ? new Error('busy') : null));
      port.close = (cb) => setImmediate(() => { port.emit('close'); cb?.(null); });
      port.write = (data, cb) => cb?.(null);
      port.drain = (cb) => cb?.(null);
      FakePort.last = port;
      return port;
    },
    { list: async () => listed.ports, failOpen: false, last: null },
  ),
}));

const SerialMonitor = require('../serialMonitor');
const { SerialPort } = require('serialport');

const flush = () => new Promise((r) => setTimeout(r, 70));

describe('serial lines', () => {
  let monitor;
  beforeEach(async () => {
    SerialPort.failOpen = false;
    listed.ports = [{ path: '/dev/cu.usbmodem1101' }];
    monitor = new SerialMonitor();
    await monitor.connect('/dev/cu.usbmodem1101', 115200);
  });
  afterEach(() => { monitor.setAutoReconnect(false); monitor.removeAllListeners(); });

  it('assembles lines across chunks and batches them', async () => {
    const batches = [];
    monitor.on('lines', (b) => batches.push(b));
    SerialPort.last.emit('data', Buffer.from('temp=21\r\nhum='));
    SerialPort.last.emit('data', Buffer.from('43\ndone\n'));
    await flush();
    expect(batches).toHaveLength(1); // one message for three lines
    expect(batches[0].map((l) => l.text)).toEqual(['temp=21', 'hum=43', 'done']);
    expect(batches[0].every((l) => l.kind === 'rx')).toBe(true);
    expect(monitor.recent(10).map((l) => l.text)).toEqual(['temp=21', 'hum=43', 'done']);
  });

  it('shows a line that never ends in a newline', async () => {
    const seen = [];
    monitor.on('lines', (b) => seen.push(...b.map((l) => l.text)));
    SerialPort.last.emit('data', Buffer.from('Enter a command: '));
    await flush();
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toEqual(['Enter a command: ']);
  });

  it('keeps a bounded history that survives a disconnect, and clears on request', async () => {
    for (let i = 0; i < 5200; i++) monitor.record(`line ${i}`, 'rx');
    expect(monitor.lines).toHaveLength(5000);
    expect(monitor.lines[0].text).toBe('line 200');
    expect(monitor.recent(3).map((l) => l.text)).toEqual(['line 5197', 'line 5198', 'line 5199']);
    await monitor.disconnect();
    expect(monitor.lines.length).toBe(5000);
    monitor.clearLines();
    expect(monitor.lines).toEqual([]);
  });

  it('keeps what was sent and what the app said in order with what the board printed', async () => {
    const seen = [];
    monitor.on('lines', (b) => seen.push(...b.map((l) => `${l.kind}:${l.text}`)));
    monitor.record('> ping', 'tx');
    SerialPort.last.emit('data', Buffer.from('pong\n'));
    await flush();
    expect(seen).toEqual(['tx:> ping', 'rx:pong']);
  });
});

describe('the port around an upload', () => {
  let monitor;
  beforeEach(() => {
    SerialPort.failOpen = false;
    listed.ports = [{ path: '/dev/cu.usbmodem1101' }];
    monitor = new SerialMonitor();
  });
  afterEach(() => { monitor.setAutoReconnect(false); monitor.removeAllListeners(); });

  it('closes the port and reopens it when the board comes back', async () => {
    await monitor.connect('/dev/cu.usbmodem1101', 9600);
    expect(await monitor.holdForUpload()).toBe(true);
    expect(monitor.isConnected).toBe(false);
    // The board is still re-enumerating for the first moment.
    listed.ports = [];
    const resumed = monitor.resumeAfterUpload({ timeoutMs: 4000 });
    setTimeout(() => { listed.ports = [{ path: '/dev/cu.usbmodem1101' }]; }, 600);
    await expect(resumed).resolves.toBe(true);
    expect(monitor.isConnected).toBe(true);
    expect(monitor.currentBaudRate).toBe(9600);
    expect(monitor.recent(5).some((l) => /Reconnected to .* after the upload/.test(l.text))).toBe(true);
  });

  it('finds the port again under its other macOS name (cu. chosen, tty. listed)', async () => {
    await monitor.connect('/dev/cu.usbmodem1101', 115200);
    await monitor.holdForUpload();
    // The serialport library lists only the tty. name on macOS.
    listed.ports = [{ path: '/dev/tty.usbmodem1101' }];
    await expect(monitor.resumeAfterUpload({ timeoutMs: 3000 })).resolves.toBe(true);
    expect(monitor.isConnected).toBe(true);
    expect(SerialMonitor.samePort('/dev/cu.usbmodem1101', '/dev/tty.usbmodem1101')).toBe(true);
    expect(SerialMonitor.samePort('/dev/cu.usbmodem1101', '/dev/cu.usbmodem1102')).toBe(false);
    expect(SerialMonitor.samePort('COM3', 'COM3')).toBe(true);
  });

  it('does nothing when the monitor was closed before the upload', async () => {
    expect(await monitor.holdForUpload()).toBe(false);
    await expect(monitor.resumeAfterUpload()).resolves.toBe(false);
  });

  it('says so when the board never comes back', async () => {
    await monitor.connect('/dev/cu.usbmodem1101', 115200);
    await monitor.holdForUpload();
    listed.ports = [];
    await expect(monitor.resumeAfterUpload({ timeoutMs: 900 })).resolves.toBe(false);
    expect(monitor.recent(5).some((l) => /did not come back after the upload/.test(l.text))).toBe(true);
  });
});
