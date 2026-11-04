/**
 * Libraries: search the index, install, list what is installed, and work out
 * which library provides a header the compiler could not find.
 *
 * The library index says which headers each library provides
 * (`provides_includes`), so a failed compile naming `Adafruit_SSD1306.h` can be
 * answered with the library that has it instead of a guess. That is also how
 * the agent checks a library exists before recommending it.
 * @module main/services/libraryService
 */

const INDEX_TTL_MS = 6 * 60 * 60 * 1000;
const INSTALLED_TTL_MS = 30 * 1000;

/** "fatal error: Adafruit_SSD1306.h: No such file or directory" → the header. */
const MISSING_HEADER = /fatal error:\s*([A-Za-z0-9_./+-]+\.h(?:pp)?):\s*No such file or directory/g;

/** Headers a sketch includes, in order, without repeats. */
function includesOf(code) {
  const out = [];
  for (const m of String(code || '').matchAll(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Every header the compiler said it could not find, in order, without repeats. */
function missingHeadersOf(output) {
  const out = [];
  for (const m of String(output || '').matchAll(MISSING_HEADER)) {
    const header = m[1].split('/').pop();
    if (!out.includes(header)) out.push(header);
  }
  return out;
}

const lower = (v) => String(v || '').toLowerCase();

/**
 * Headers everyone uses → the library that owns them. The index does not say
 * who provides Adafruit_GFX.h (and a stray library that ships a copy would
 * win), so the well-known ones are spelled out. `null` means the board's own
 * core provides the header: there is nothing to install.
 */
/**
 * Headers that belong to a core's SDK or the toolchain rather than to any
 * library: ESP-IDF (esp_*.h, driver/, freertos/, soc/…), the ESP8266 SDK,
 * avr-libc, and the C/C++ standard headers. The Library Manager index lists
 * a few libraries that ship copies of these; installing one shadows the real
 * header and breaks builds.
 */
const CORE_HEADER_PATTERNS = {
  '*': [
    /^(stdint|stdlib|stdio|string|strings|math|stdbool|inttypes|ctype|limits|errno|time|assert|stdarg|stddef|float|setjmp|signal|unistd|fcntl)\.h$/,
    /^(vector|string|map|unordered_map|set|array|functional|algorithm|memory|utility|cstdint|cstring|cmath|cstdio|cstdlib|cstddef|cstdarg|cctype|climits|cerrno|cassert|iterator|tuple|optional|variant|type_traits|initializer_list|new|atomic|chrono|numeric|deque|list|queue|stack|bitset|iostream|sstream|iomanip|limits|exception|stdexcept)$/,
    /^Arduino\.h$/, /^pins_arduino\.h$/, /^sys\//,
  ],
  esp32: [/^esp_/, /^esp32-hal/, /^(driver|freertos|soc|hal|rom|lwip|mbedtls|nvs|esp_private|xtensa|riscv|esp_system|spi_flash|bootloader_support|hal)\//, /^sdkconfig\.h$/, /^nvs(_flash)?\.h$/, /^rtc_wdt\.h$/, /^sd_protocol_types\.h$/],
  esp8266: [/^(user_interface|osapi|ets_sys|espnow|os_type|mem|c_types|eagle_soc|gpio|uart|sntp|ping|smartconfig|spi_flash|umm_malloc)\.h$/, /^(lwip|umm_malloc)\//, /^core_esp8266/],
  avr: [/^(avr|util)\//],
  megaavr: [/^(avr|util)\//],
  mbed: [/^mbed/, /^rtos/],
  rp2040: [/^(hardware|pico)\//],
};
// Unambiguous names (esp_*.h, driver/, avr/io.h, hardware/pwm.h) mean the core
// whatever the board: a sketch for another board is still not a library to
// install. The ESP8266 SDK's short names (gpio.h, mem.h) count only on it.
const CORE_HEADERS_ALWAYS = ['*', 'esp32', 'avr', 'rp2040'];
function isCoreHeader(header, arch = '') {
  const h = String(header || '').replace(/^<|>$/g, '').replace(/^"|"$/g, '');
  const groups = CORE_HEADERS_ALWAYS.map((k) => CORE_HEADER_PATTERNS[k]);
  if (arch && !CORE_HEADERS_ALWAYS.includes(arch) && CORE_HEADER_PATTERNS[arch]) groups.push(CORE_HEADER_PATTERNS[arch]);
  return groups.flat().some((re) => re.test(h));
}

const KNOWN_HEADERS = {
  // the core's own
  'Arduino.h': null, 'Wire.h': null, 'SPI.h': null, 'EEPROM.h': null, 'SoftwareSerial.h': null, 'WiFi.h': null,
  'WiFiClient.h': null, 'WiFiClientSecure.h': null, 'WiFiUdp.h': null, 'HTTPClient.h': null, 'WebServer.h': null,
  'ESPmDNS.h': null, 'Update.h': null, 'Preferences.h': null, 'SPIFFS.h': null, 'LittleFS.h': null, 'FS.h': null,
  'BLEDevice.h': null, 'BLEServer.h': null, 'BLEUtils.h': null, 'esp_now.h': null, 'ESP8266WiFi.h': null,
  'ESP8266WebServer.h': null, 'ESP8266HTTPClient.h': null, 'ArduinoOTA.h': null, 'Ticker.h': null, 'HardwareSerial.h': null,
  'USB.h': null, 'USBHIDKeyboard.h': null, 'USBHIDMouse.h': null, 'Keyboard.h': null, 'Mouse.h': null, 'avr/sleep.h': null,
  'ETH.h': null, 'BLE2902.h': null, 'BluetoothSerial.h': null, 'ESP_I2S.h': null,
  // displays
  'Adafruit_GFX.h': 'Adafruit GFX Library', 'Adafruit_SSD1306.h': 'Adafruit SSD1306', 'Adafruit_SH110X.h': 'Adafruit SH110X',
  'Adafruit_ST7735.h': 'Adafruit ST7735 and ST7789 Library', 'Adafruit_ST7789.h': 'Adafruit ST7735 and ST7789 Library',
  'Adafruit_ILI9341.h': 'Adafruit ILI9341', 'Adafruit_BusIO_Register.h': 'Adafruit BusIO', 'Adafruit_I2CDevice.h': 'Adafruit BusIO',
  'U8g2lib.h': 'U8g2', 'U8x8lib.h': 'U8g2', 'TFT_eSPI.h': 'TFT_eSPI', 'LiquidCrystal.h': 'LiquidCrystal',
  'LiquidCrystal_I2C.h': 'LiquidCrystal I2C', 'hd44780.h': 'hd44780', 'TM1637Display.h': 'TM1637', 'TM1637.h': 'TM1637',
  'LedControl.h': 'LedControl', 'MD_MAX72xx.h': 'MD_MAX72XX', 'MD_Parola.h': 'MD_Parola', 'SevSeg.h': 'SevSeg',
  'GxEPD2_BW.h': 'GxEPD2', 'GxEPD2_3C.h': 'GxEPD2', 'GxEPD2_7C.h': 'GxEPD2',
  'Adafruit_NeoPixel.h': 'Adafruit NeoPixel', 'FastLED.h': 'FastLED', 'Adafruit_LEDBackpack.h': 'Adafruit LED Backpack Library',
  // sensors
  'DHT.h': 'DHT sensor library', 'DHT_U.h': 'DHT sensor library', 'DHTesp.h': 'DHT sensor library for ESPx',
  'Adafruit_Sensor.h': 'Adafruit Unified Sensor', 'Adafruit_BMP280.h': 'Adafruit BMP280 Library', 'Adafruit_BME280.h': 'Adafruit BME280 Library',
  'Adafruit_BME680.h': 'Adafruit BME680 Library', 'Adafruit_MPU6050.h': 'Adafruit MPU6050', 'MPU6050.h': 'MPU6050',
  'Adafruit_AHTX0.h': 'Adafruit AHTX0', 'Adafruit_SGP30.h': 'Adafruit SGP30 Sensor', 'Adafruit_TCS34725.h': 'Adafruit TCS34725',
  'Adafruit_VL53L0X.h': 'Adafruit_VL53L0X', 'VL53L0X.h': 'VL53L0X', 'BH1750.h': 'BH1750', 'Adafruit_ADS1X15.h': 'Adafruit ADS1X15',
  'Adafruit_INA219.h': 'Adafruit INA219', 'Adafruit_MAX31865.h': 'Adafruit MAX31865 library', 'max6675.h': 'MAX6675 library',
  'OneWire.h': 'OneWire', 'DallasTemperature.h': 'DallasTemperature', 'HX711.h': 'HX711 Arduino Library', 'NewPing.h': 'NewPing',
  'OneWireNg_CurrentPlatform.h': 'OneWireNg', 'OneWireNg.h': 'OneWireNg', 'DSTherm.h': 'OneWireNg',
  'Adafruit_BMP085.h': 'Adafruit BMP085 Library', 'Adafruit_SHT31.h': 'Adafruit SHT31 Library', 'Adafruit_ADXL345_U.h': 'Adafruit ADXL345',
  'Adafruit_MLX90614.h': 'Adafruit MLX90614 Library', 'MAX30105.h': 'SparkFun MAX3010x Pulse and Proximity Sensor Library',
  'heartRate.h': 'SparkFun MAX3010x Pulse and Proximity Sensor Library', 'spo2_algorithm.h': 'SparkFun MAX3010x Pulse and Proximity Sensor Library',
  'Ultrasonic.h': 'Ultrasonic', 'MFRC522.h': 'MFRC522', 'TinyGPS++.h': 'TinyGPSPlus', 'TinyGPSPlus.h': 'TinyGPSPlus',
  'Adafruit_Fingerprint.h': 'Adafruit Fingerprint Sensor Library', 'IRremote.h': 'IRremote', 'IRremote.hpp': 'IRremote',
  'IRremoteESP8266.h': 'IRremoteESP8266', 'RTClib.h': 'RTClib', 'Keypad.h': 'Keypad', 'Encoder.h': 'Encoder',
  'ESP32Encoder.h': 'ESP32Encoder', 'Bounce2.h': 'Bounce2', 'OneButton.h': 'OneButton', 'ezButton.h': 'ezButton',
  // actuators
  'Servo.h': 'Servo', 'ESP32Servo.h': 'ESP32Servo', 'Stepper.h': 'Stepper', 'AccelStepper.h': 'AccelStepper',
  'Adafruit_PWMServoDriver.h': 'Adafruit PWM Servo Driver Library', 'Adafruit_MotorShield.h': 'Adafruit Motor Shield V2 Library',
  'AFMotor.h': 'Adafruit Motor Shield library', 'L298N.h': 'L298N', 'DFRobotDFPlayerMini.h': 'DFRobotDFPlayerMini',
  // comms and data
  'PubSubClient.h': 'PubSubClient', 'ArduinoJson.h': 'ArduinoJson', 'NTPClient.h': 'NTPClient', 'TimeLib.h': 'Time',
  'ArduinoBLE.h': 'ArduinoBLE', 'WiFiNINA.h': 'WiFiNINA', 'Ethernet.h': 'Ethernet', 'LoRa.h': 'LoRa', 'RF24.h': 'RF24',
  'WebSocketsServer.h': 'WebSockets', 'WebSocketsClient.h': 'WebSockets',
  'WiFiManager.h': 'WiFiManager', 'ESPAsyncWebServer.h': 'ESP Async WebServer', 'AsyncTCP.h': 'Async TCP',
  'ThingSpeak.h': 'ThingSpeak', 'SD.h': 'SD', 'TaskScheduler.h': 'TaskScheduler', 'Adafruit_LiquidCrystal.h': 'Adafruit LiquidCrystal',
};

class LibraryService {
  /** @param {(args: string[], opts?: object) => Promise<{ success: boolean, stdout: string, stderr: string }>} runCli */
  constructor(runCli) {
    this.runCli = runCli;
    this._index = { at: 0, libraries: [] };
    this._installed = { at: 0, libraries: [] };
  }

  async _json(args, timeout = 60000) {
    const res = await this.runCli([...args, '--format', 'json'], { timeout });
    if (!res?.success) throw new Error((res?.stderr || res?.stdout || 'arduino-cli failed').trim().split('\n').pop());
    try {
      return JSON.parse(res.stdout || '{}');
    } catch {
      throw new Error('arduino-cli returned something that is not JSON');
    }
  }

  /**
   * The whole library index, cached. Each entry: name, latest version, what it
   * is for, and the headers it provides.
   */
  async index({ refresh = false } = {}) {
    if (!refresh && this._index.libraries.length && Date.now() - this._index.at < INDEX_TTL_MS) return this._index.libraries;
    if (refresh) await this.runCli(['lib', 'update-index'], { timeout: 120000 }).catch(() => null);
    let data;
    try {
      data = await this._json(['lib', 'search'], 120000);
    } catch (error) {
      // No index yet (first run, or offline): update once, then give up quietly.
      if (!this._index.libraries.length && !refresh) {
        await this.runCli(['lib', 'update-index'], { timeout: 120000 }).catch(() => null);
        data = await this._json(['lib', 'search'], 120000).catch(() => null);
      }
      if (!data) throw error;
    }
    const libraries = (data.libraries || []).map((lib) => {
      const releases = lib.releases || {};
      const latest = lib.latest || releases[lib.latest_version] || Object.values(releases).pop() || {};
      return {
        name: lib.name,
        version: latest.version || lib.latest_version || '',
        author: latest.author || '',
        sentence: latest.sentence || '',
        paragraph: latest.paragraph || '',
        website: latest.website || '',
        category: latest.category || '',
        architectures: latest.architectures || [],
        provides: latest.provides_includes || [],
        versions: Object.keys(releases),
      };
    });
    this._index = { at: Date.now(), libraries };
    return libraries;
  }

  /** Installed libraries (name, version, the headers they provide). */
  async installed({ refresh = false } = {}) {
    if (!refresh && this._installed.libraries.length && Date.now() - this._installed.at < INSTALLED_TTL_MS) return this._installed.libraries;
    const data = await this._json(['lib', 'list'], 60000);
    const libraries = (data.installed_libraries || []).map((entry) => {
      const lib = entry.library || entry;
      return {
        name: lib.name,
        version: lib.version || '',
        location: lib.location || '',
        provides: lib.provides_includes || [],
        sentence: lib.sentence || '',
        architectures: lib.architectures || [],
      };
    });
    this._installed = { at: Date.now(), libraries };
    return libraries;
  }

  /** Forget the installed list (after an install or uninstall). */
  invalidate() {
    this._installed = { at: 0, libraries: [] };
  }

  /**
   * Libraries matching a query, best first: an exact name, then a header it
   * provides, then words in the name, then the description.
   * @returns {Promise<Array<object>>}
   */
  async search(query, { limit = 20, fqbn = '' } = {}) {
    const q = lower(query).trim();
    const libraries = await this.index();
    const installed = new Map((await this.installed().catch(() => [])).map((l) => [lower(l.name), l]));
    const arch = String(fqbn || '').split(':')[1] || '';
    const score = (lib) => {
      const name = lower(lib.name);
      if (!q) return 1;
      if (name === q) return 100;
      if (lib.provides.some((h) => lower(h) === q || lower(h) === `${q}.h`)) return 90;
      if (name.startsWith(q)) return 70;
      if (name.includes(q)) return 50;
      if (lower(lib.sentence).includes(q)) return 20;
      if (lower(lib.paragraph).includes(q)) return 10;
      return 0;
    };
    return libraries
      .map((lib) => ({ lib, s: score(lib) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.lib.name.localeCompare(b.lib.name))
      .slice(0, limit)
      .map(({ lib }) => ({
        ...lib,
        installed: installed.has(lower(lib.name)),
        installedVersion: installed.get(lower(lib.name))?.version || null,
        // A library that names architectures and not this one may still compile, so this is a note, not a filter.
        fitsBoard: !arch || !lib.architectures.length || lib.architectures.includes('*') || lib.architectures.includes(arch),
      }));
  }

  /**
   * The library that provides a header, best first. A well-known header goes
   * to the library that owns it; otherwise a library named like the header
   * beats one that merely ships a copy, and one that fits the board beats one
   * that does not. A header the core provides has no providers at all.
   */
  async providersOf(header, { fqbn = '' } = {}) {
    const arch = String(fqbn || '').split(':')[1] || '';
    // SDK and toolchain headers (esp_sleep.h, driver/ledc.h, avr/io.h, <vector>)
    // come with the core: a library that claims them must never be installed.
    if (isCoreHeader(header, arch)) return [];
    const key = Object.keys(KNOWN_HEADERS).find((h) => lower(h) === lower(String(header).split('/').pop()));
    const want = lower(header);
    const bare = want.replace(/\.(h|hpp)$/, '');
    const libraries = await this.index();
    const installed = new Set((await this.installed().catch(() => [])).map((l) => lower(l.name)));
    const squash = (v) => lower(v).replace(/[^a-z0-9]/g, '');
    const decorate = (lib) => ({
      ...lib,
      installed: installed.has(lower(lib.name)),
      exactHeader: lib.provides.some((h) => lower(h) === want),
      fitsBoard: !arch || !lib.architectures.length || lib.architectures.includes('*') || lib.architectures.includes(arch),
      nameMatch: squash(lib.name) === squash(bare) ? 2 : squash(lib.name).startsWith(squash(bare)) ? 1 : 0,
    });
    if (key !== undefined) {
      const owner = KNOWN_HEADERS[key];
      if (owner === null) return []; // the core's own header
      const lib = libraries.find((l) => lower(l.name) === lower(owner));
      if (lib) return [decorate(lib)];
    }
    const hits = libraries.filter((lib) => lib.provides.some((h) => lower(h) === want) || squash(lib.name) === squash(bare));
    return hits
      .map(decorate)
      .sort((a, b) => b.nameMatch - a.nameMatch
        || Number(b.exactHeader) - Number(a.exactHeader)
        || Number(b.fitsBoard) - Number(a.fitsBoard)
        || a.name.length - b.name.length
        || a.name.localeCompare(b.name));
  }

  /**
   * Install a library by name (and optional version).
   * @param {string} name
   * @param {{ version?: string, onOutput?: (line: string) => void }} [opts]
   */
  async install(name, { version = '', onOutput } = {}) {
    if (!name || !/^[\w .+-]{1,120}$/.test(name)) throw new Error(`"${name}" is not a library name.`);
    if (version && !/^[\w.-]{1,40}$/.test(version)) throw new Error(`"${version}" is not a version.`);
    const spec = version ? `${name}@${version}` : name;
    const res = await this.runCli(['lib', 'install', spec], { timeout: 300000, onOutput });
    if (!res?.success) {
      const message = (res?.stderr || res?.stdout || '').trim().split('\n').pop() || 'the install failed';
      throw new Error(`Could not install ${spec}: ${message}`);
    }
    this.invalidate();
    return { name, version: version || null, output: `${res.stdout || ''}${res.stderr || ''}`.trim() };
  }

  async uninstall(name) {
    if (!name || !/^[\w .+-]{1,120}$/.test(name)) throw new Error(`"${name}" is not a library name.`);
    const res = await this.runCli(['lib', 'uninstall', name], { timeout: 120000 });
    if (!res?.success) throw new Error((res?.stderr || res?.stdout || 'the uninstall failed').trim().split('\n').pop());
    this.invalidate();
    return { name };
  }

  /**
   * Which headers of a sketch no installed library provides, and what would
   * provide them. Headers the board's own core provides are not listed: a
   * compile is what proves those, so this only reports what the index knows.
   * @param {string} code
   * @param {{ fqbn?: string }} [opts]
   */
  async missingFor(code, { fqbn = '' } = {}) {
    const headers = includesOf(code);
    if (!headers.length) return [];
    const installed = await this.installed().catch(() => []);
    const provided = new Set(installed.flatMap((l) => l.provides.map(lower)));
    const out = [];
    for (const header of headers) {
      const base = header.split('/').pop();
      if (provided.has(lower(base)) || provided.has(lower(header))) continue;
      const providers = await this.providersOf(base, { fqbn }).catch(() => []);
      // Nothing in the index provides it: it is the core's own header (Wire.h,
      // WiFi.h on an ESP32) or a file of the sketch, so there is nothing to install.
      if (!providers.length || providers[0].installed) continue;
      out.push({ header: base, suggestion: providers[0], alternatives: providers.slice(1, 4) });
    }
    return out;
  }

  /**
   * A compile failed on missing headers: install what provides them.
   * @param {string} output  the build output
   * @param {{ fqbn?: string, max?: number, onOutput?: (line: string) => void }} [opts]
   * @returns {Promise<{ installed: object[], unresolved: string[] }>}
   */
  async installForMissingHeaders(output, { fqbn = '', max = 3, onOutput } = {}) {
    const headers = missingHeadersOf(output).slice(0, max);
    const installed = [];
    const unresolved = [];
    for (const header of headers) {
      const providers = await this.providersOf(header, { fqbn }).catch(() => []);
      const pick = providers.find((p) => !p.installed);
      if (!pick) {
        unresolved.push(header);
        continue;
      }
      try {
        await this.install(pick.name, { onOutput });
        installed.push({ header, name: pick.name, version: pick.version });
      } catch (error) {
        unresolved.push(`${header} (${error.message})`);
      }
    }
    return { installed, unresolved };
  }
}

module.exports = { LibraryService, includesOf, missingHeadersOf, KNOWN_HEADERS, CORE_HEADER_PATTERNS, isCoreHeader };
