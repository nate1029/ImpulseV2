/**
 * Official documentation the agent can read.
 *
 * The knowledge layer carries what is stable (pins, quirks, core API drift).
 * Everything else — a peripheral's exact behaviour, a vendor's own pinout, a
 * library's API — lives on the manufacturer's pages. This fetches those pages,
 * turns them into text and caches them, so an answer can rest on the
 * manufacturer's words instead of the model's memory.
 *
 * Only documentation hosts are allowed. Nothing about the user's project is
 * sent: a request is a URL from this file (or a link found on a page already
 * allowed), and nothing else.
 * @module main/services/ai/knowledge/docs
 */
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

/** Hosts whose pages may be read. Documentation only, no search engines. */
const ALLOWED_HOSTS = [
  'docs.arduino.cc', 'reference.arduino.cc', 'arduino.github.io',
  'docs.espressif.com', 'arduino-esp8266.readthedocs.io', 'arduino-pico.readthedocs.io',
  'datasheets.raspberrypi.com', 'www.raspberrypi.com',
  'wiki.seeedstudio.com', 'learn.adafruit.com', 'docs.m5stack.com', 'www.pjrc.com',
  'github.com', 'raw.githubusercontent.com',
  'docs.wemos.cc', 'www.waveshare.com', 'wiki.dfrobot.com', 'docs.heltec.org',
];

const MAX_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 15000;

/** Pages that answer "what does this board actually do", per chip family. */
const FAMILY_DOCS = {
  esp32: [
    { title: 'ESP32 GPIO (Espressif)', url: 'https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/peripherals/gpio.html' },
    { title: 'Arduino-ESP32 core reference', url: 'https://docs.espressif.com/projects/arduino-esp32/en/latest/' },
  ],
  'esp32-s2': [
    { title: 'ESP32-S2 GPIO (Espressif)', url: 'https://docs.espressif.com/projects/esp-idf/en/stable/esp32s2/api-reference/peripherals/gpio.html' },
    { title: 'Arduino-ESP32 core reference', url: 'https://docs.espressif.com/projects/arduino-esp32/en/latest/' },
  ],
  'esp32-s3': [
    { title: 'ESP32-S3 GPIO (Espressif)', url: 'https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/peripherals/gpio.html' },
    { title: 'Arduino-ESP32 core reference', url: 'https://docs.espressif.com/projects/arduino-esp32/en/latest/' },
  ],
  'esp32-c3': [
    { title: 'ESP32-C3 GPIO (Espressif)', url: 'https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-reference/peripherals/gpio.html' },
    { title: 'Arduino-ESP32 core reference', url: 'https://docs.espressif.com/projects/arduino-esp32/en/latest/' },
  ],
  'esp32-c6': [
    { title: 'ESP32-C6 GPIO (Espressif)', url: 'https://docs.espressif.com/projects/esp-idf/en/stable/esp32c6/api-reference/peripherals/gpio.html' },
    { title: 'Arduino-ESP32 core reference', url: 'https://docs.espressif.com/projects/arduino-esp32/en/latest/' },
  ],
  esp8266: [{ title: 'ESP8266 Arduino core reference', url: 'https://arduino-esp8266.readthedocs.io/en/latest/' }],
  rp2040: [{ title: 'Arduino-Pico (Earle Philhower) reference', url: 'https://arduino-pico.readthedocs.io/en/latest/' }],
  rp2350: [{ title: 'Arduino-Pico (Earle Philhower) reference', url: 'https://arduino-pico.readthedocs.io/en/latest/' }],
  stm32: [{ title: 'STM32duino wiki', url: 'https://github.com/stm32duino/Arduino_Core_STM32/wiki' }],
  teensy4: [{ title: 'Teensy 4 pinout (PJRC)', url: 'https://www.pjrc.com/teensy/pinout.html' }],
  'avr-atmega328p': [{ title: 'Arduino Uno R3 (Arduino docs)', url: 'https://docs.arduino.cc/hardware/uno-rev3/' }],
  'avr-atmega2560': [{ title: 'Arduino Mega 2560 (Arduino docs)', url: 'https://docs.arduino.cc/hardware/mega-2560/' }],
  'avr-atmega32u4': [{ title: 'Arduino Leonardo (Arduino docs)', url: 'https://docs.arduino.cc/hardware/leonardo/' }],
  'renesas-ra4m1': [{ title: 'Arduino Uno R4 WiFi (Arduino docs)', url: 'https://docs.arduino.cc/hardware/uno-r4-wifi/' }],
  nrf52840: [{ title: 'Arduino Nano 33 BLE (Arduino docs)', url: 'https://docs.arduino.cc/hardware/nano-33-ble/' }],
};

/** Pages for one board, where the vendor has its own (checked to resolve). */
const BOARD_DOCS = {
  uno: [{ title: 'Arduino Uno R3', url: 'https://docs.arduino.cc/hardware/uno-rev3/' }],
  nano: [{ title: 'Arduino Nano', url: 'https://docs.arduino.cc/hardware/nano/' }],
  mega: [{ title: 'Arduino Mega 2560', url: 'https://docs.arduino.cc/hardware/mega-2560/' }],
  leonardo: [{ title: 'Arduino Leonardo', url: 'https://docs.arduino.cc/hardware/leonardo/' }],
  'nano-esp32': [{ title: 'Arduino Nano ESP32 (pin numbering included)', url: 'https://docs.arduino.cc/hardware/nano-esp32/' }],
  'uno-r4-wifi': [{ title: 'Arduino Uno R4 WiFi', url: 'https://docs.arduino.cc/hardware/uno-r4-wifi/' }],
  'uno-r4-minima': [{ title: 'Arduino Uno R4 Minima', url: 'https://docs.arduino.cc/hardware/uno-r4-minima/' }],
  'nano-33-ble': [{ title: 'Arduino Nano 33 BLE', url: 'https://docs.arduino.cc/hardware/nano-33-ble/' }],
  'nano-33-iot': [{ title: 'Arduino Nano 33 IoT', url: 'https://docs.arduino.cc/hardware/nano-33-iot/' }],
  'xiao-esp32c3': [{ title: 'Seeed XIAO ESP32-C3 (Seeed wiki)', url: 'https://wiki.seeedstudio.com/XIAO_ESP32C3_Getting_Started/' }],
  'xiao-esp32s3': [{ title: 'Seeed XIAO ESP32-S3 (Seeed wiki)', url: 'https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/' }],
  'xiao-rp2040': [{ title: 'Seeed XIAO RP2040 (Seeed wiki)', url: 'https://wiki.seeedstudio.com/XIAO-RP2040/' }],
  'feather-esp32-v2': [{ title: 'Adafruit Feather ESP32 V2', url: 'https://learn.adafruit.com/adafruit-esp32-feather-v2' }],
  'm5stack-atoms3': [{ title: 'M5Stack AtomS3', url: 'https://docs.m5stack.com/en/core/AtomS3' }],
  teensy40: [{ title: 'Teensy 4.0 pinout', url: 'https://www.pjrc.com/teensy/pinout.html' }],
  teensy41: [{ title: 'Teensy 4.1 pinout', url: 'https://www.pjrc.com/teensy/pinout.html' }],
};

/** Whether a URL may be fetched. */
function allowed(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  return ALLOWED_HOSTS.includes(parsed.hostname);
}

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&mdash;': '—', '&ndash;': '–' };

/** &amp; → &, &#8212; → —. */
function decodeEntities(text) {
  return String(text || '')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39|apos|mdash|ndash);/g, (m) => ENTITIES[m] || m)
    .replace(/&#(\d{1,6});/g, (m, code) => String.fromCharCode(Number(code)));
}

/** HTML → readable text: scripts, styles, nav and tags out; entities decoded. */
function htmlToText(html) {
  let text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  // Keep the shape of tables and lists, which is where pinouts live.
  text = text
    .replace(/<\/(tr|p|div|h[1-6]|li|section)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  return text.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}

/** The part of a page that mentions `focus`, or its start. */
function excerpt(text, { focus = '', max = 4000 } = {}) {
  const body = String(text || '');
  if (body.length <= max) return { text: body, truncated: false };
  const needle = String(focus || '').trim().toLowerCase();
  if (needle) {
    const at = body.toLowerCase().indexOf(needle);
    if (at >= 0) {
      const from = Math.max(0, at - Math.floor(max / 3));
      return { text: `${from ? '…\n' : ''}${body.slice(from, from + max)}\n…`, truncated: true };
    }
  }
  return { text: `${body.slice(0, max)}\n…`, truncated: true };
}

class DocsService {
  /**
   * @param {{ cacheDir: string, fetch?: typeof fetch, now?: () => number }} opts
   */
  constructor({ cacheDir, fetch: fetchImpl, now = Date.now } = {}) {
    this.cacheDir = cacheDir;
    this.fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.now = now;
  }

  /** The pages Impulse knows for a board, best first. */
  listFor({ catalogId = '', family = '', boardName = '' } = {}) {
    const out = [];
    for (const doc of BOARD_DOCS[catalogId] || []) out.push({ ...doc, scope: 'board' });
    for (const doc of FAMILY_DOCS[family] || []) {
      if (!out.some((d) => d.url === doc.url)) out.push({ ...doc, scope: 'chip' });
    }
    return out.map((doc) => ({ ...doc, about: boardName || family || '' }));
  }

  _cachePath(url) {
    return path.join(this.cacheDir, `${crypto.createHash('sha1').update(url).digest('hex').slice(0, 20)}.json`);
  }

  async _cached(url) {
    try {
      const raw = JSON.parse(await fs.readFile(this._cachePath(url), 'utf8'));
      if (this.now() - raw.at > CACHE_TTL_MS) return null;
      return raw;
    } catch {
      return null;
    }
  }

  async _store(url, entry) {
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      await fs.writeFile(this._cachePath(url), JSON.stringify(entry), 'utf8');
    } catch { /* the cache is a bonus */ }
  }

  /**
   * Read one documentation page.
   * @param {string} url
   * @param {{ focus?: string, max?: number, refresh?: boolean }} [opts]
   * @returns {Promise<{ ok: boolean, url: string, title?: string, text?: string, truncated?: boolean, cached?: boolean, error?: string }>}
   */
  async read(url, { focus = '', max = 4000, refresh = false } = {}) {
    if (!allowed(url)) {
      return { ok: false, url, error: `Impulse only reads documentation sites (${ALLOWED_HOSTS.slice(0, 6).join(', ')}…). ${url} is not one.` };
    }
    if (!refresh) {
      const hit = await this._cached(url);
      if (hit) return { ok: true, url, title: hit.title, ...excerpt(hit.text, { focus, max }), cached: true };
    }
    let response;
    try {
      response = await this.fetch(url, {
        redirect: 'follow',
        headers: { accept: 'text/html,text/plain;q=0.9,*/*;q=0.8', 'user-agent': 'Impulse IDE (documentation reader)' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      return { ok: false, url, error: `Could not reach ${new URL(url).hostname}: ${error?.message || 'no answer'}. Answer from what you already know and say the page could not be read.` };
    }
    if (!response.ok) return { ok: false, url, error: `${new URL(url).hostname} answered ${response.status}.` };
    const type = response.headers.get('content-type') || '';
    if (/pdf|octet-stream|zip/i.test(type)) return { ok: false, url, error: 'That is a PDF or a download, which Impulse does not read. Try the HTML page.' };
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) return { ok: false, url, error: 'That page is too big to read.' };
    const body = Buffer.from(buffer).toString('utf8');
    const rawTitle = /<title[^>]*>([\s\S]{1,200}?)<\/title>/i.exec(body)?.[1] || new URL(url).pathname.split('/').filter(Boolean).pop() || url;
    const title = decodeEntities(rawTitle).replace(/\s+/g, ' ').trim();
    const text = /html/i.test(type) || /^\s*</.test(body) ? htmlToText(body) : body;
    if (!text.trim()) return { ok: false, url, error: 'That page had no text to read.' };
    await this._store(url, { at: this.now(), title, text: text.slice(0, MAX_BYTES) });
    return { ok: true, url, title, ...excerpt(text, { focus, max }), cached: false };
  }
}

module.exports = { DocsService, ALLOWED_HOSTS, FAMILY_DOCS, BOARD_DOCS, allowed, htmlToText, decodeEntities, excerpt };
