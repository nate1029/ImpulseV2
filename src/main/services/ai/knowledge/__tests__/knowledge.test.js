// What the agent knows about boards, chips and parts: pins read from a core's
// variant headers, the family guides, the component guide, and the facts that
// go with every request.
const path = require('path');
const { readDefinitions, pinFacts, resolve } = require('../pinsHeader');
const { FAMILIES, familyOf, familyById, guideText } = require('../mcuGuide');
const { COMPONENTS, RECIPES, findComponents, componentText, familyKey, recipeFor, verifiedFor, componentsNamedIn, componentFacts } = require('../components');
const BoardKnowledge = require('../boardKnowledge');
const ToolExecutor = require('../../tools/toolExecutor');

const CORES = path.join(__dirname, '../../../../../../test/fixtures/cores');
const header = (core, variant) => path.join(CORES, core, 'variants', variant, 'pins_arduino.h');

describe('pins read from a core\'s variant header', () => {
  test('AVR: chains of defines and constants resolve to pin numbers; macros and comments are skipped', () => {
    const defs = readDefinitions(header('avr', 'standard'));
    const { pins, analog } = pinFacts(defs);
    expect(pins).toMatchObject({ LED_BUILTIN: 13, SDA: 18, SCL: 19, MOSI: 11, MISO: 12, SCK: 13, SS: 10, NUM_DIGITAL_PINS: 20 });
    expect(analog).toEqual({ A0: 14, A4: 18 });
    expect(defs.has('digitalPinHasPWM')).toBe(false);
  });

  test('ESP32-S3: an RGB LED_BUILTIN is named for what it is, with the right call for the core version', () => {
    const defs = readDefinitions(header('esp', 'esp32s3'));
    const core2 = pinFacts(defs, { family: 'esp32-s3', coreVersion: '2.0.17' });
    expect(core2.pins).toMatchObject({ LED_BUILTIN: 'RGB LED on GPIO48', BUILTIN_LED: 'RGB LED on GPIO48', RGB_BUILTIN: 'RGB LED on GPIO48', RGB_LED_GPIO: 48, TX: 43, SDA: 8, USB_VID: '0x303a' });
    expect(core2.notes.join(' ')).toMatch(/neopixelWrite\(RGB_BUILTIN/);
    expect(pinFacts(defs, { family: 'esp32-s3', coreVersion: '3.1.0' }).notes.join(' ')).toMatch(/rgbLedWrite\(RGB_BUILTIN/);
    expect(core2.touch).toEqual({ T1: 1 });
  });

  test('a board with no user LED says so', () => {
    const { pins, notes } = pinFacts(readDefinitions(header('esp', 'devkit')), { family: 'esp32' });
    expect(pins.LED_BUILTIN).toBeUndefined();
    expect(notes.join(' ')).toMatch(/LED_BUILTIN is NOT defined/);
  });

  test('Arduino-Pico: follows includes in the core, drops #ifdef-only aliases, marks unpinned 31s, and explains the NeoPixel', () => {
    const { pins, analog, notes } = pinFacts(readDefinitions(header('pico', 'xiao')), { family: 'rp2040' });
    expect(pins).toMatchObject({ LED_BUILTIN: 17, SDA: 6, SCL: 7, PIN_NEOPIXEL: 12, NEOPIXEL_POWER: 11, PIN_SERIAL2_TX: 'not pinned out' });
    expect(analog).toEqual({ A0: 26 });
    expect(notes.join(' ')).toMatch(/NeoPixel\) on pin 12.*pin 11.*HIGH first/);
  });

  test('an active-LOW LED is called out', () => {
    const { notes } = pinFacts(readDefinitions(header('nrf', 'nano33')), { family: 'nrf52840' });
    expect(notes.join(' ')).toMatch(/active-LOW/);
  });

  test('values it can\'t work out stay readable', () => {
    const defs = new Map([['X', { value: 'SOME_MACRO(3)' }], ['Y', { value: 'BASE + 2' }], ['BASE', { value: '(40u)' }]]);
    expect(resolve(defs, 'X')).toEqual({ value: null, expr: 'SOME_MACRO(3)' });
    expect(resolve(defs, 'Y').value).toBe(42);
  });
});

describe('chip family guides', () => {
  test('each family has a logic level, facts and something to match on', () => {
    expect(FAMILIES.length).toBeGreaterThanOrEqual(20);
    for (const f of FAMILIES) {
      expect(f.title).toBeTruthy();
      expect(f.logic).toBeTruthy();
      expect(f.facts.length).toBeGreaterThan(0);
      expect(Object.keys(f.match).length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(FAMILIES)).not.toMatch(/\\\\/); // no stray escapes in the text
  });

  test.each([
    [{ 'build.mcu': 'atmega328p' }, 'arduino:avr:uno', 'avr-atmega328p'],
    [{ 'build.mcu': 'atmega32u4' }, 'arduino:avr:leonardo', 'avr-atmega32u4'],
    [{ 'build.mcu': 'esp32s3' }, 'esp32:esp32:esp32s3', 'esp32-s3'],
    [{ 'build.mcu': 'cortex-m4', 'build.board': 'UNOR4_WIFI' }, 'arduino:renesas_uno:unor4wifi', 'renesas-ra4m1'],
    [{ 'build.mcu': 'cortex-m4', 'build.board': 'ARDUINO_NANO33BLE' }, 'arduino:mbed_nano:nano33ble', 'nrf52840'],
    [{ 'build.mcu': 'cortex-m0plus', 'build.board': 'SAMD_NANO_33_IOT' }, 'arduino:samd:nano_33_iot', 'samd21'],
    [{ 'build.mcu': 'cortex-m4', 'build.board': 'METRO_M4' }, 'adafruit:samd:adafruit_metro_m4', 'samd51'],
    [{ 'build.mcu': 'cortex-m0plus', 'build.board': 'NANO_RP2040_CONNECT' }, 'arduino:mbed_nano:nanorp2040connect', 'rp2040'],
    [{ 'build.mcu': 'cortex-m33', 'build.chip': 'rp2350' }, 'rp2040:rp2040:rpipico2', 'rp2350'],
  ])('%j (%s) is %s', (props, fqbn, id) => {
    expect(familyOf(props, fqbn).id).toBe(id);
  });

  test('found by chip or board name as people type them', () => {
    expect(familyById('ESP32S3').id).toBe('esp32-s3');
    expect(familyById('attiny85').id).toBe('attiny-x5');
    expect(familyById('uno r4').id).toBe('renesas-ra4m1');
    expect(familyById('nonsense-chip')).toBeNull();
  });

  test('ESP32 guides carry the core 2.x → 3.x changes; others the fundamentals', () => {
    const s3 = guideText(familyById('esp32-s3'), { coreVersion: '2.0.17' });
    expect(s3).toMatch(/ledcAttach\(pin, freq, resolution\)/);
    expect(s3).toMatch(/Logic level: 3\.3 V logic, NOT 5 V tolerant/);
    expect(guideText(familyById('atmega328p'))).toMatch(/F\("…"\)/);
    expect(guideText(familyById('atmega328p'))).toMatch(/Embedded fundamentals/);
  });
});

describe('component recipes (compiled sketches)', () => {
  test('knows the chip family of a board from its FQBN', () => {
    expect(familyKey('arduino:avr:uno')).toBe('avr');
    expect(familyKey('esp32:esp32:esp32')).toBe('esp32');
    expect(familyKey('esp32:esp32:esp32s3')).toBe('esp32s3');
    expect(familyKey('esp32:esp32:XIAO_ESP32C3')).toBe('esp32c3');
    expect(familyKey('esp32:esp32:heltec_wifi_lora_32_V3')).toBe('esp32s3');
    expect(familyKey('arduino:esp32:nano_nora')).toBe('nano-esp32'); // Arduino pin numbers, the ESP32's API
    expect(familyKey('esp32:esp32:nano_nora')).toBe('nano-esp32'); // Espressif's core numbers it the Arduino way too
    expect(familyKey('arduino:mbed_rp2040:nanorp2040connect')).toBe('mbed'); // Arduino pin numbers, not GPIO
    expect(familyKey('esp32:esp32:esp32c6')).toBe('esp32c6');
    expect(familyKey('rp2040:rp2040:rpipico')).toBe('rp2040');
    expect(familyKey('')).toBe('avr');
  });

  test('fills the family\'s pins into the sketch and the wiring, falling back chip → esp32 → default', () => {
    const dht = COMPONENTS.find((c) => c.id === 'dht');
    expect(recipeFor(dht, 'avr').sketch).toMatch(/#define DHTPIN 2\b/);
    expect(recipeFor(dht, 'esp32s3').sketch).toMatch(/#define DHTPIN 4\b/); // no S3 table: the esp32 one
    expect(recipeFor(dht, 'esp32s3').wiring.join(' ')).toMatch(/DATA → pin 4/);
    expect(recipeFor(dht, 'avr').libs).toEqual(['DHT sensor library', 'Adafruit Unified Sensor']);
    const lcd = COMPONENTS.find((c) => c.id === 'lcd-parallel');
    expect(recipeFor(lcd, 'esp32c3').sketch).toMatch(/LiquidCrystal lcd\(10, 3, 4, 5, 6, 7\)/); // the C3 has its own table (no strapping GPIO 2)
    expect(recipeFor(lcd, 'esp32').sketch).toMatch(/LiquidCrystal lcd\(4, 13, 14, 16, 17, 18\)/);
    expect(recipeFor(lcd, 'nano-esp32').sketch).toMatch(/LiquidCrystal lcd\(12, 11, 5, 4, 3, 2\)/); // Nano pin numbers
  });

  test('switches library and sketch where the API differs between families', () => {
    const servo = COMPONENTS.find((c) => c.id === 'servo');
    expect(recipeFor(servo, 'avr').libs).toEqual(['Servo']);
    expect(recipeFor(servo, 'avr').sketch).toMatch(/#include <Servo.h>/);
    expect(recipeFor(servo, 'esp32s3').libs).toEqual(['ESP32Servo']);
    expect(recipeFor(servo, 'esp32s3').sketch).toMatch(/#include <ESP32Servo.h>/);
    const sd = COMPONENTS.find((c) => c.id === 'sd-card');
    expect(recipeFor(sd, 'avr').libs).toEqual(['SD']);
    expect(recipeFor(sd, 'esp32').libs).toEqual([]); // the core ships SD
    expect(recipeFor(sd, 'esp32').sketch).toMatch(/FILE_APPEND/);
  });

  test('gives no recipe rather than a wrong one', () => {
    const touch = COMPONENTS.find((c) => c.id === 'esp32-touch');
    expect(recipeFor(touch, 'esp32s3').sketch).toMatch(/TOUCH_PIN = 1;/);
    expect(recipeFor(touch, 'esp32c3')).toBeNull(); // the C3 has no touch pads: no pin, no recipe
    expect(recipeFor(touch, 'avr')).toBeNull(); // an ESP32-only feature
    expect(recipeFor(COMPONENTS.find((c) => c.id === 'esp32-wifi'), 'avr')).toBeNull();
    expect(recipeFor(COMPONENTS.find((c) => c.id === 'esp32-bt-serial'), 'esp32s3')).toBeNull(); // BLE only on the S3
    expect(recipeFor(COMPONENTS.find((c) => c.id === 'esp32-bt-serial'), 'nano-esp32')).toBeNull(); // an S3 too
    expect(recipeFor(COMPONENTS.find((c) => c.id === 'esp32-cam'), 'esp32c3')).toBeNull(); // no camera interface
    expect(recipeFor(COMPONENTS.find((c) => c.id === 'i2s-audio'), 'nano-esp32')).toBeNull(); // no Nano-numbered pins written for it
  });

  test('every recipe belongs to a component, has a sketch with setup and loop, and names real pins', () => {
    const ids = new Set(COMPONENTS.map((c) => c.id));
    for (const [id, r] of Object.entries(RECIPES)) {
      expect(ids.has(id)).toBe(true);
      const bodies = typeof r.sketch === 'string' ? [r.sketch] : Object.values(r.sketch);
      for (const body of bodies) {
        expect(body).toMatch(/void setup\(\)/);
        expect(body).toMatch(/void loop\(\)/);
      }
      for (const table of Object.values(r.pins || {})) if (table !== null) for (const v of Object.values(table)) expect(['number', 'string']).toContain(typeof v); // null = this chip has none
    }
    expect(Object.keys(RECIPES).length).toBeGreaterThanOrEqual(81);
  });

  test('the guide text carries the wiring and the sketch for the board\'s family, the sketch only when asked', () => {
    const dht = findComponents('DHT22')[0];
    const text = componentText(dht, { family: 'esp32s3' });
    expect(text).toMatch(/Wiring for the ESP32-S3/);
    expect(text).toMatch(/Install: DHT sensor library/);
    expect(verifiedFor('dht', 'esp32s3')).toMatchObject({ fqbn: 'esp32:esp32:esp32s3' });
    expect(text).toMatch(/Known-good sketch for the ESP32-S3 \(core 3\.x\)\. Proof L3, compiled by Impulse: compiled for esp32:esp32:esp32s3 with esp32:esp32@/);
    // A family nobody compiled for: the sketch comes with a warning instead of a promise.
    const unproven = componentText(dht, { family: 'esp8266' });
    expect(unproven).toMatch(/Proof L0, not yet checked: not compiled by Impulse for this family yet/);
    expect(unproven).not.toMatch(/Known-good/);
    expect(text).toMatch(/```cpp\n#include <DHT.h>/);
    expect(componentText(dht, { family: 'esp32s3', withSketch: false })).not.toMatch(/```cpp/);
    expect(componentText(dht)).not.toMatch(/Wiring for/); // no family: the plain guide
    expect(findComponents('WiFi')[0].id).toBe('esp32-wifi');
    expect(findComponents('deep sleep')[0].id).toBe('esp32-deep-sleep');
  });
});

describe('recipe pins are safe on every chip', () => {
  const { checkPin } = require('../pinMap');
  const CHIP = { avr: 'avr-atmega328p', esp32: 'esp32', esp32s2: 'esp32-s2', esp32s3: 'esp32-s3', esp32c3: 'esp32-c3', esp32c6: 'esp32-c6', rp2040: 'rp2040' };
  // Beyond what the pin map flags: the serial console pins, the S3's octal PSRAM
  // (N8R8/N16R8 boards) and RGB LED, and the Pico's internal pins.
  const RESERVED = { avr: [0, 1], esp32: [1, 3], esp32s2: [43, 44], esp32s3: [33, 34, 35, 36, 37, 43, 44, 48], esp32c3: [20, 21], esp32c6: [16, 17], rp2040: [23, 24, 25, 29] };

  test('no recipe puts a part on a missing, flash, USB, strapping, input-only or reserved pin', () => {
    const problems = [];
    for (const [id, r] of Object.entries(RECIPES)) {
      const c = COMPONENTS.find((x) => x.id === id);
      for (const family of Object.keys(CHIP)) {
        const recipe = recipeFor(c, family);
        if (!recipe) continue;
        for (const [key, pin] of Object.entries(recipe.pins)) {
          if (!Number.isInteger(pin)) continue; // a name the core defines (A0) or a wiring hint
          const reading = (r.inputs || []).includes(key) || (r.analog || []).includes(key);
          const issue = checkPin(pin, CHIP[family], { output: !reading, analogRead: (r.analog || []).includes(key), analogWrite: family === 'avr' && (r.pwm || []).includes(key) });
          if (issue) problems.push(`${id} on ${family}: ${key} = ${pin}, ${issue.reason}`);
          else if (RESERVED[family].includes(pin)) problems.push(`${id} on ${family}: ${key} = ${pin} is reserved`);
        }
        const used = Object.entries(recipe.pins).filter(([, p]) => Number.isInteger(p));
        const seen = new Map();
        for (const [key, pin] of used) {
          if (seen.has(pin)) problems.push(`${id} on ${family}: ${key} and ${seen.get(pin)} share pin ${pin}`);
          seen.set(pin, key);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test('the compile record only names recipes and families that exist', () => {
    const record = require('../recipes.verified.json');
    for (const [id, families] of Object.entries(record.results)) {
      const c = COMPONENTS.find((x) => x.id === id);
      expect([id, Boolean(c && RECIPES[id])]).toEqual([id, true]);
      for (const [family, proof] of Object.entries(families)) {
        expect([id, family, Boolean(recipeFor(c, family))]).toEqual([id, family, true]);
        expect(proof).toMatchObject({ fqbn: expect.stringMatching(/^[\w.-]+:[\w.-]+:[\w.-]+$/), core: expect.stringMatching(/@\d/) });
      }
    }
  });

  test('every part has a recipe, and every recipe fills all of its blanks for some family', () => {
    expect(COMPONENTS.filter((c) => !RECIPES[c.id]).map((c) => c.id)).toEqual([]);
    for (const c of COMPONENTS) {
      const any = Object.keys(CHIP).some((family) => recipeFor(c, family));
      expect([c.id, any]).toEqual([c.id, true]);
    }
  });

  // The guide promises "Impulse installs what is missing when it compiles". The
  // library index lists headers for fewer than half of its releases (none for
  // GxEPD2, WebSockets or the SparkFun MAX3010x library), so each header must
  // lead the installer to the recipe's own library: through the core, the
  // known-headers table, or a library named like the header.
  test('every header a recipe includes leads the installer to that recipe\'s library', () => {
    const { KNOWN_HEADERS, isCoreHeader } = require('../../../libraryService');
    const ARCH = { avr: 'avr', esp32: 'esp32', esp32s2: 'esp32', esp32s3: 'esp32', esp32c3: 'esp32', esp32c6: 'esp32', 'nano-esp32': 'esp32', rp2040: 'rp2040' };
    const BUNDLED = { esp32: ['SD.h'] }; // the ESP32 core ships its own SD library
    const owners = new Map(Object.entries(KNOWN_HEADERS).map(([h, owner]) => [h.toLowerCase(), owner]));
    const squash = (v) => String(v).toLowerCase().replace(/[^a-z0-9]/g, '');
    const problems = [];
    for (const c of COMPONENTS) {
      for (const family of Object.keys(ARCH)) {
        const recipe = recipeFor(c, family);
        if (!recipe) continue;
        const includes = [...recipe.sketch.matchAll(/^\s*#include\s*[<"]([^>"]+)[>"]/gm)].map((m) => m[1]);
        for (const header of includes) {
          const file = header.split('/').pop();
          if (isCoreHeader(header, ARCH[family]) || (BUNDLED[ARCH[family]] || []).includes(file)) continue;
          const owner = owners.get(file.toLowerCase());
          if (owner === null) continue; // the core's own
          if (owner !== undefined) {
            if (!recipe.libs.some((lib) => lib.toLowerCase() === owner.toLowerCase())) problems.push(`${c.id} on ${family}: ${header} installs ${owner}, but the recipe uses ${recipe.libs.join(', ') || 'no library'}`);
            continue;
          }
          if (recipe.libs.some((lib) => squash(lib) === squash(file.replace(/\.(h|hpp)$/, '')))) continue;
          if (header.includes('/') && includes.some((other) => !other.includes('/') && owners.get(other.toLowerCase()))) continue; // inside a library the sketch already pulls in
          problems.push(`${c.id} on ${family}: nothing tells the installer which library has ${header}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('component facts that ride with a request', () => {
  test('finds the parts a message names as whole words, most specific first, two at most', () => {
    expect(componentsNamedIn('Show DHT22 readings on an OLED and blink the LED').map((c) => c.id)).toEqual(['dht', 'ssd1306']);
    expect(componentsNamedIn('I called the function but the led is off').map((c) => c.id)).toEqual(['led']); // "called" is not an LED
    expect(componentsNamedIn('use the MPU-6050 to detect a tap').map((c) => c.id)).toEqual(['mpu6050']);
    expect(componentsNamedIn('Scan for Wi-Fi networks').map((c) => c.id)).toEqual(['esp32-wifi']);
    expect(componentsNamedIn('a relay, a buzzer, a servo and a DHT11').length).toBe(2);
    expect(componentsNamedIn('hello there')).toEqual([]);
    expect(componentsNamedIn('')).toEqual([]);
  });

  test('writes a [COMPONENT FACTS] block with the sketch for the board, or nothing', () => {
    const facts = componentFacts('Show DHT22 readings on an LCD', { fqbn: 'esp32:esp32:esp32s3' });
    expect(facts).toMatch(/^\[COMPONENT FACTS\] The message names DHT11 and LCD 16x2 I2C/);
    expect(facts).toMatch(/Known-good sketch for the ESP32-S3/); // dht is compiled for the S3 (recipes.verified.json)
    expect(facts.match(/```cpp/g)).toHaveLength(1); // the sketch only for the first part
    expect(componentFacts('make it faster', { fqbn: 'arduino:avr:uno' })).toBeNull();
  });
});

describe('component guide', () => {
  test('every entry says how it connects and at what voltage; addresses are 7-bit hex', () => {
    expect(COMPONENTS.length).toBeGreaterThanOrEqual(50);
    for (const c of COMPONENTS) {
      expect(c.names.length).toBeGreaterThan(0);
      expect(c.interface).toBeTruthy();
      expect(c.voltage).toBeTruthy();
      for (const a of c.i2c || []) expect(a).toMatch(/^0x[0-7][0-9A-F]/i);
    }
  });

  test('found by name, part number or I2C address', () => {
    expect(findComponents('DHT22')[0].id).toBe('dht');
    expect(findComponents('hc-sr04')[0].id).toBe('hc-sr04');
    expect(findComponents('0x27').map((c) => c.id)).toContain('lcd-i2c');
    expect(findComponents('0x68').map((c) => c.id)).toEqual(expect.arrayContaining(['mpu6050', 'rtc']));
    expect(componentText(findComponents('nRF24L01')[0])).toMatch(/3\.6 V ONLY/);
  });
});

describe('board knowledge from arduino-cli', () => {
  const fakeCli = (variantDir, extra = {}) => async (args) => {
    if (args[0] === 'board' && args[1] === 'details') {
      if (args[3].startsWith('missing:')) return { success: false, stdout: '', stderr: 'Error: platform not installed' };
      return {
        success: true,
        stdout: JSON.stringify({
          name: 'ESP32S3 Dev Module', version: '2.0.17', package: { name: 'esp32' }, platform: { architecture: 'esp32', name: 'esp32' },
          config_options: [{ option: 'CDCOnBoot', option_label: 'USB CDC On Boot', values: [{ value: 'default', value_label: 'Disabled', selected: true }] }],
          build_properties: ['build.mcu=esp32s3', 'build.f_cpu=240000000L', 'build.cdc_on_boot=0', 'build.usb_mode=1', 'upload.maximum_size=1310720', 'upload.maximum_data_size=327680', `build.variant.path=${variantDir}`, `runtime.platform.path=${path.join(variantDir, '../..')}`, 'build.variant=esp32s3'],
          ...extra,
        }),
        stderr: '',
      };
    }
    if (args[1] === 'listall') return { success: true, stdout: JSON.stringify({ boards: [{ name: 'Arduino UNO', fqbn: 'arduino:avr:uno' }] }), stderr: '' };
    if (args[1] === 'search') return { success: true, stdout: JSON.stringify({ boards: [{ name: 'Arduino UNO R4 WiFi', platform: { metadata: { id: 'arduino:renesas_uno' } } }, { name: 'Arduino UNO', fqbn: 'arduino:avr:uno', platform: { metadata: { id: 'arduino:avr' } } }] }), stderr: '' };
    return { success: false, stdout: '', stderr: 'unexpected' };
  };
  const s3dir = path.join(CORES, 'esp', 'variants', 'esp32s3');

  test('a board\'s facts: chip, memory, pins, options and the traps', async () => {
    const bk = new BoardKnowledge(fakeCli(s3dir));
    const info = await bk.boardInfo('esp32:esp32:esp32s3');
    expect(info).toMatchObject({ name: 'ESP32S3 Dev Module', core: 'esp32:esp32 2.0.17', mcu: 'esp32s3', family: 'esp32-s3', cpuMHz: 240, sketchFlashBytes: 1310720, ramBytes: 327680 });
    expect(info.pins.LED_BUILTIN).toBe('RGB LED on GPIO48');
    expect(info.boardOptions).toEqual({ 'USB CDC On Boot': 'Disabled' });
    expect(info.notes.join(' ')).toMatch(/Serial is UART0 \(TX 43, RX 44\)/);
  });

  test('the paragraph that goes with every request', async () => {
    const text = await new BoardKnowledge(fakeCli(s3dir)).summary('esp32:esp32:esp32s3');
    expect(text).toMatch(/^\[BOARD FACTS/);
    expect(text).toMatch(/3\.3 V logic, NOT 5 V tolerant/);
    expect(text).toMatch(/LED_BUILTIN = RGB LED on GPIO48/);
    expect(text).toMatch(/I2C SDA 8, SCL 9/);
    // The knowledge layer's notes follow the core's facts: onboard parts, upload, power, the core's API drift.
    expect(text).toMatch(/\n\[BOARD NOTES\] ESP32-S3 DevKitC-1/);
    expect(text).toMatch(/RGB LED \(WS2812\) on GPIO48/);
    expect(text).toMatch(/Espressif ESP32 Arduino core 2\.0\.17: Core 2\.x/);
    expect(text.length).toBeLessThan(3600);
  });

  test('a board whose core isn\'t installed names the core to install', async () => {
    const bk = new BoardKnowledge(fakeCli(s3dir));
    await expect(bk.boardInfo('missing:arch:board')).rejects.toThrow(/core for missing:arch:board isn't installed.*missing:arch/);
    expect(await bk.summary('missing:arch:board')).toBeNull();
  });

  test('board search puts the catalog first, then what arduino-cli lists, without repeats', async () => {
    const found = await new BoardKnowledge(fakeCli(s3dir)).search('uno');
    expect(found[0].catalog).toBe(true);
    expect(found.find((b) => b.fqbn === 'arduino:avr:uno')).toMatchObject({ core: 'arduino:avr', installed: true, catalog: true });
    const r4 = found.filter((b) => /R4 WiFi/i.test(b.name));
    expect(r4).toHaveLength(1);
    expect(r4[0]).toMatchObject({ core: 'arduino:renesas_uno', installed: false });
  });

  test('the agent\'s tools answer through the executor', async () => {
    const exec = new ToolExecutor({ runCommand: fakeCli(s3dir) }, null, null, null);
    exec.setUICallbacks({ getSelectedBoard: async () => 'esp32:esp32:esp32s3' });
    const board = await exec.execute({ name: 'get_board_info', arguments: {} });
    expect(board.success).toBe(true);
    expect(board.result.pins.SDA).toBe(8);
    const guide = await exec.execute({ name: 'get_mcu_guide', arguments: {} });
    expect(guide.result.guide).toMatch(/ESP32-S3/);
    const part = await exec.execute({ name: 'get_component_guide', arguments: { query: 'SSD1306' } });
    expect(part.result.guide).toMatch(/0x3C/);
    const none = await exec.execute({ name: 'get_component_guide', arguments: { query: 'flux capacitor' } });
    expect(none.result.found).toBe(0);
    exec.setUICallbacks({ getSelectedBoard: async () => '' });
    const noBoard = await exec.execute({ name: 'get_board_info', arguments: {} });
    expect(noBoard.success).toBe(false);
    expect(noBoard.error).toMatch(/No board is selected/);
  });
});

// The real thing: arduino-cli and the installed AVR core.
const { spawnSync } = require('child_process');
const hasAvrCore = (() => {
  const r = spawnSync('arduino-cli', ['core', 'list', '--format', 'json'], { encoding: 'utf8' });
  return r.status === 0 && /"arduino:avr"/.test(r.stdout);
})();
(hasAvrCore ? describe : describe.skip)('with arduino-cli and the AVR core installed', () => {
  const runCli = async (args) => {
    const r = spawnSync('arduino-cli', args, { encoding: 'utf8' });
    return { success: r.status === 0, stdout: r.stdout, stderr: r.stderr };
  };

  test('the Uno, Mega and Leonardo, read from the core itself', async () => {
    const bk = new BoardKnowledge(runCli);
    const uno = await bk.boardInfo('arduino:avr:uno');
    expect(uno).toMatchObject({ mcu: 'atmega328p', family: 'avr-atmega328p', cpuMHz: 16 });
    expect(uno.pins).toMatchObject({ LED_BUILTIN: 13, SDA: 18, SCL: 19, SS: 10 });
    expect(await bk.summary('arduino:avr:uno')).toMatch(/SDA 18 \(A4\), SCL 19 \(A5\)/);
    expect((await bk.boardInfo('arduino:avr:mega')).pins).toMatchObject({ SDA: 20, SCL: 21, SS: 53 });
    expect((await bk.boardInfo('arduino:avr:leonardo')).pins).toMatchObject({ SDA: 2, SCL: 3 });
  }, 60000);
});
