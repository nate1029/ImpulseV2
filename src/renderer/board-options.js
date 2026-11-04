// Board menu options (Tools › Board Options in Arduino IDE): USB CDC On Boot,
// flash size, PSRAM, CPU… Choices are kept per board and folded into the
// FQBN that compile and upload use.

const STORE_KEY = 'impulse-board-options';
const ESPRESSIF_VID = '0x303a';
// The built-in USB Serial/JTAG controller of the ESP32-S3, -C3, -C6 and -H2.
const ESP_NATIVE_USB_PIDS = new Set(['0x1001']);

/** "esp32:esp32:esp32s3:CDCOnBoot=cdc" → "esp32:esp32:esp32s3" */
export function baseFqbn(fqbn) {
  return String(fqbn || '').split(':').slice(0, 3).join(':');
}

/**
 * The FQBN for a board with the given choices; only choices that differ from
 * the board's defaults (and exist for it) are written.
 * @param {string} base
 * @param {{ option: string, values: { value: string, isDefault: boolean }[] }[]} options
 * @param {Record<string, string>} choices
 */
export function composeFqbn(base, options, choices = {}) {
  const parts = [];
  for (const opt of options || []) {
    const value = choices[opt.option];
    if (!value || !opt.values.some(v => v.value === value)) continue;
    const fallback = opt.values.find(v => v.isDefault)?.value;
    if (value !== fallback) parts.push(`${opt.option}=${value}`);
  }
  return parts.length ? `${base}:${parts.join(',')}` : base;
}

/**
 * Choices the connected port calls for. An ESP32 on its native USB port only
 * prints Serial output to that port with "USB CDC On Boot" enabled.
 * @param {object[]} options
 * @param {{ vid?: string|null, pid?: string|null } | null} port
 * @returns {Record<string, string>}
 */
export function suggestedChoices(options, port) {
  const out = {};
  const vid = String(port?.vid || '').toLowerCase();
  const pid = String(port?.pid || '').toLowerCase();
  if (vid === ESPRESSIF_VID && ESP_NATIVE_USB_PIDS.has(pid)) {
    const cdc = (options || []).find(o => o.option === 'CDCOnBoot');
    if (cdc?.values.some(v => v.value === 'cdc')) out.CDCOnBoot = 'cdc';
  }
  return out;
}

/** Choices the user made, per base FQBN. */
export function loadChoices() {
  try {
    const all = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return all && typeof all === 'object' ? all : {};
  } catch {
    return {};
  }
}

export function saveChoices(base, choices) {
  const all = loadChoices();
  all[base] = choices;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch { /* storage unavailable */ }
}

/** Effective choices: the port's suggestions, overridden by what the user picked. */
export function effectiveChoices(base, options, port) {
  return { ...suggestedChoices(options, port), ...(loadChoices()[base] || {}) };
}

// USB vendors whose serial ports people plug in, for ports arduino-cli
// can't match to a board.
const USB_VENDORS = {
  '0x2341': 'Arduino', '0x2a03': 'Arduino', '0x303a': 'Espressif native USB (ESP32-S3/C3/C6)',
  '0x1a86': 'CH340 USB serial', '0x10c4': 'CP210x USB serial', '0x0403': 'FTDI USB serial',
  '0x2e8a': 'Raspberry Pi Pico', '0x239a': 'Adafruit', '0x1b4f': 'SparkFun', '0x16c0': 'Teensy',
};

/** What a port is, for the port lists: the matched board, else the USB vendor. */
export function describePort(port) {
  const board = port?.board && !/^(Serial Port|Unknown)/i.test(port.board) ? port.board : null;
  if (board) return board;
  const vendor = USB_VENDORS[String(port?.vid || '').toLowerCase()];
  if (vendor) return vendor;
  return port?.vid ? 'USB serial device' : 'Not USB (Bluetooth or system port)';
}

/** USB ports first (boards are almost always on USB), then the rest. */
export function sortPorts(ports) {
  return [...(ports || [])].sort((a, b) => (b.vid ? 1 : 0) - (a.vid ? 1 : 0));
}
