// Simulated boards. Pin tables follow the Arduino AVR core's pins_arduino.h
// (variants/standard, eightanaloginputs and mega), for the Raspberry Pi Pico
// the Arduino-Pico core (variants/rpipico), and for the ATtiny85 ATTinyCore
// (variants/tinyX5).
//
// Every board numbers its pins like the Arduino core does: digital pins first,
// then A0.. as digital pins (Uno A0 = 14, Mega A0 = 54). Pins that exist only
// as analog inputs (Nano A6/A7) get numbers after the last digital pin and no
// port. On the Pico a pin number is its GPIO number (A0 = GP26), and on the
// ATtiny85 its PORTB bit (A1 = PB2).
//
// Electrical levels per board: logicVolts (an output HIGH), threshold (an
// input reads HIGH from here), pull-up/down resistance, ADC reference, and the
// most a pin may see (maxPinVolts).

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

function pin(n, port, bit, extra = {}) {
  return { pin: n, port, bit, ...extra };
}

// ── ATmega328P boards ───────────────────────────────────────────────────────

const PINS_328P = [
  ...range(0, 7).map(n => pin(n, 'D', n)),
  ...range(8, 13).map(n => pin(n, 'B', n - 8)),
  ...range(0, 5).map(i => pin(14 + i, 'C', i, { adc: i, analog: `A${i}` })),
];
const PWM_328P = [3, 5, 6, 9, 10, 11];

// ── ATmega2560 (Mega) ───────────────────────────────────────────────────────

const MEGA_PORTS = [
  'E0', 'E1', 'E4', 'E5', 'G5', 'E3', 'H3', 'H4', 'H5', 'H6', 'B4', 'B5', 'B6', 'B7', // 0-13
  'J1', 'J0', 'H1', 'H0', 'D3', 'D2', 'D1', 'D0', // 14-21
  'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', // 22-29
  'C7', 'C6', 'C5', 'C4', 'C3', 'C2', 'C1', 'C0', // 30-37
  'D7', 'G2', 'G1', 'G0', // 38-41
  'L7', 'L6', 'L5', 'L4', 'L3', 'L2', 'L1', 'L0', // 42-49
  'B3', 'B2', 'B1', 'B0', // 50-53
  'F0', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', // 54-61 = A0-A7
  'K0', 'K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', // 62-69 = A8-A15
];
const PINS_2560 = MEGA_PORTS.map((pb, n) => pin(n, pb[0], Number(pb[1]),
  n >= 54 ? { adc: n - 54, analog: `A${n - 54}` } : {}));

// ── RP2040 (Raspberry Pi Pico) ──────────────────────────────────────────────

// GP0–GP22 and GP26–GP28 reach the header; GP25 is the LED.
const PICO_GPIO = [...range(0, 22), 25, 26, 27, 28];
const PINS_PICO = PICO_GPIO.map(n => pin(n, 'GPIO', n, n >= 26 ? { adc: n - 26, analog: `A${n - 26}` } : {}));
const PICO_ALIASES = Object.fromEntries(PICO_GPIO.map(n => [`GP${n}`, n >= 26 ? `A${n - 26}` : String(n)]));

// ── ATtiny85 ────────────────────────────────────────────────────────────────

// PB0–PB5 are pins 0–5. Analog inputs follow the ADC channels, not the pins:
// A0 = PB5, A1 = PB2, A2 = PB4, A3 = PB3 (ATTinyCore's analogInputToDigitalPin).
const TINY85_ADC = { 5: 0, 2: 1, 4: 2, 3: 3 };
const PINS_TINY85 = range(0, 5).map(n => pin(n, 'B', n, n in TINY85_ADC ? { adc: TINY85_ADC[n], analog: `A${TINY85_ADC[n]}` } : {}));
const TINY85_ALIASES = Object.fromEntries(range(0, 5).map(n => [`PB${n}`, String(n)]));

const AVR_LEVELS = { logicVolts: 5, threshold: 2.5, pullupOhms: 35000, pulldownOhms: null, adcRef: 5, maxPinVolts: 5 };

// ── ATmega32U4 (Leonardo) ───────────────────────────────────────────────────

// variants/leonardo/pins_arduino.h: digital pins 0-17, A0-A5 as 18-23. A6-A11
// share digital pins 4, 6, 8, 9, 10 and 12 (ADC channels 8, 10, 11, 12, 13, 9).
const LEONARDO_PORTS = ['D2', 'D3', 'D1', 'D0', 'D4', 'C6', 'D7', 'E6', 'B4', 'B5', 'B6', 'B7', 'D6', 'C7', 'B3', 'B1', 'B2', 'B0',
  'F7', 'F6', 'F5', 'F4', 'F1', 'F0'];
const LEONARDO_ADC = { 4: 8, 6: 10, 8: 11, 9: 12, 10: 13, 12: 9, 18: 7, 19: 6, 20: 5, 21: 4, 22: 1, 23: 0 };
const PINS_LEONARDO = LEONARDO_PORTS.map((pb, n) => pin(n, pb[0], Number(pb[1]),
  n >= 18 ? { adc: LEONARDO_ADC[n], analog: `A${n - 18}` } : n in LEONARDO_ADC ? { adc: LEONARDO_ADC[n] } : {}));

// ── ESP32 family (run in Espressif's QEMU) ──────────────────────────────────

// Pin numbers are GPIO numbers, as in Espressif's Arduino core; an analog
// input's ADC channel is its GPIO number too (analogRead takes the GPIO).
const gpioPins = (gpios, analog = {}) => gpios.map(n => pin(n, 'GPIO', n, n in analog ? { adc: n, analog: analog[n] } : {}));
const ESP32_LEVELS = { logicVolts: 3.3, threshold: 1.65, pullupOhms: 45000, pulldownOhms: 45000, adcRef: 3.3, maxPinVolts: 3.6 };

// ESP32 DevKit V1 (DOIT, 30 pins): variants/doitESP32devkitV1.
const ESP32_GPIO = [1, 2, 3, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39];
const ESP32_ANALOG = { 36: 'A0', 39: 'A3', 32: 'A4', 33: 'A5', 34: 'A6', 35: 'A7', 4: 'A10', 2: 'A12', 15: 'A13', 13: 'A14', 12: 'A15', 14: 'A16', 27: 'A17', 25: 'A18', 26: 'A19' };
const ESP32_INPUT_ONLY = [34, 35, 36, 39];
const ESP32_ALIASES = {
  ...Object.fromEntries(ESP32_GPIO.map(n => [`D${n}`, String(n)])),
  RX0: '3', TX0: '1', RX2: '16', TX2: '17', VP: '36', VN: '39',
};

// ESP32-S3-DevKitC-1: variants/esp32s3. The RGB LED (WS2812) is on GPIO48.
const S3_GPIO = [...range(0, 21), ...range(35, 48)];
const S3_ANALOG = Object.fromEntries(range(1, 20).map(n => [n, `A${n - 1}`]));

// ESP32-C3-DevKitM-1: variants/esp32c3. The RGB LED is on GPIO8.
const C3_GPIO = [...range(0, 10), 18, 19, 20, 21];
const C3_ANALOG = Object.fromEntries(range(0, 5).map(n => [n, `A${n}`]));

// Arduino Nano ESP32 (ESP32-S3), with the core's default Arduino pin numbering:
// D0–D13 and A0–A7 as on every Nano, mapped to GPIOs by the core.
const NANO_ESP32_D = [44, 43, 5, 6, 7, 8, 9, 10, 17, 18, 21, 38, 47, 48];
const NANO_ESP32_A = [1, 2, 3, 4, 11, 12, 13, 14];
const NANO_ESP32_GPIO = [...new Set([...NANO_ESP32_D, ...NANO_ESP32_A, 46, 0, 45])].sort((a, b) => a - b);
const NANO_ESP32_LABELS = {
  ...Object.fromEntries(NANO_ESP32_D.map((g, d) => [g, `D${d}`])),
  ...Object.fromEntries(NANO_ESP32_A.map((g, a) => [g, `A${a}`])),
  46: 'LED_RED', 0: 'LED_GREEN', 45: 'LED_BLUE',
};

/**
 * @typedef {object} BoardProfile
 * @property {string} id
 * @property {string} label
 * @property {string} tag           @wokwi/elements tag
 * @property {string} fqbn          used to compile for the simulator
 * @property {string} mcu           key into MCUS
 * @property {object[]} pins        { pin, port, bit, adc?, analog? }
 * @property {number[]} pwm
 * @property {number} ledBuiltin
 */

export const BOARDS = {
  uno: {
    id: 'uno',
    label: 'Arduino Uno',
    short: 'Uno',
    tag: 'wokwi-arduino-uno',
    fqbn: 'arduino:avr:uno',
    mcu: 'atmega328p',
    pins: PINS_328P,
    pwm: PWM_328P,
    ledBuiltin: 13,
    i2c: { sda: 18, scl: 19 },
    spi: { ss: 10, mosi: 11, miso: 12, sck: 13 },
    serial: [{ rx: 0, tx: 1 }],
    interrupts: [2, 3],
    aliases: { 'A4.2': 'A4', 'A5.2': 'A5' },
    description: 'ATmega328P · 14 digital pins · 6 analog inputs',
    ...AVR_LEVELS,
  },
  nano: {
    id: 'nano',
    label: 'Arduino Nano',
    short: 'Nano',
    tag: 'wokwi-arduino-nano',
    fqbn: 'arduino:avr:nano',
    mcu: 'atmega328p',
    pins: [...PINS_328P, { pin: 20, adc: 6, analog: 'A6' }, { pin: 21, adc: 7, analog: 'A7' }],
    pwm: PWM_328P,
    ledBuiltin: 13,
    i2c: { sda: 18, scl: 19 },
    spi: { ss: 10, mosi: 11, miso: 12, sck: 13 },
    serial: [{ rx: 0, tx: 1 }],
    interrupts: [2, 3],
    aliases: { '11.2': '11', '12.2': '12', '13.2': '13' },
    description: 'ATmega328P · 14 digital pins · 8 analog inputs · breadboard friendly',
    ...AVR_LEVELS,
  },
  mega: {
    id: 'mega',
    label: 'Arduino Mega 2560',
    short: 'Mega 2560',
    tag: 'wokwi-arduino-mega',
    fqbn: 'arduino:avr:mega:cpu=atmega2560',
    mcu: 'atmega2560',
    pins: PINS_2560,
    pwm: [...range(2, 13), 44, 45, 46],
    ledBuiltin: 13,
    i2c: { sda: 20, scl: 21 },
    spi: { ss: 53, mosi: 51, miso: 50, sck: 52 },
    serial: [{ rx: 0, tx: 1 }, { rx: 19, tx: 18 }, { rx: 17, tx: 16 }, { rx: 15, tx: 14 }],
    interrupts: [2, 3, 18, 19, 20, 21],
    aliases: { SDA: '20', SCL: '21' },
    description: 'ATmega2560 · 54 digital pins · 16 analog inputs · 4 serial ports',
    ...AVR_LEVELS,
  },
  pico: {
    id: 'pico',
    label: 'Raspberry Pi Pico',
    short: 'Pico',
    tag: 'impulse-pi-pico',
    fqbn: 'rp2040:rp2040:rpipico',
    mcu: 'rp2040',
    family: 'rp2040',
    pins: PINS_PICO,
    pwm: PICO_GPIO,
    ledBuiltin: 25,
    i2c: { sda: 4, scl: 5 },
    spi: { miso: 16, ss: 17, sck: 18, mosi: 19 },
    // Serial is the USB port; Serial1 and Serial2 are UART0 and UART1.
    serial: [null, { tx: 0, rx: 1 }, { tx: 8, rx: 9 }],
    interrupts: PICO_GPIO,
    aliases: PICO_ALIASES,
    pinPrefix: 'GP',
    description: 'RP2040 · dual Cortex-M0+ at up to 200 MHz · 26 GPIO · 3 analog inputs · 3.3 V logic',
    logicVolts: 3.3,
    threshold: 1.65,
    pullupOhms: 50000,
    pulldownOhms: 50000,
    adcRef: 3.3,
    maxPinVolts: 3.3,
  },
  attiny85: {
    id: 'attiny85',
    label: 'ATtiny85',
    short: 'ATtiny85',
    tag: 'impulse-attiny85',
    // ATTinyCore at 16 MHz from the internal PLL: the simulator's clock.
    fqbn: 'ATTinyCore:avr:attinyx5:chip=85,clock=16pll',
    mcu: 'attiny85',
    core: 'attiny',
    pins: PINS_TINY85,
    pwm: [0, 1, 4],
    ledBuiltin: 1,
    // USI: SDA/DI on PB0, SCL/USCK on PB2, DO on PB1 (pins_arduino.h).
    i2c: { sda: 0, scl: 2 },
    spi: { ss: 3, mosi: 1, miso: 0, sck: 2 },
    // The USI clocks SPI out on the pins, so parts read it bit by bit.
    spiByPins: true,
    // Serial is TinySoftwareSerial: TX on AIN0 (PB0), RX on AIN1 (PB1).
    serial: [{ tx: 0, rx: 1 }],
    softSerial: { tx: 0, rx: 1 },
    interrupts: [2],
    aliases: TINY85_ALIASES,
    pinPrefix: 'PB',
    resetPin: 5,
    description: 'ATtiny85 · 8 KB flash · 6 I/O pins · 4 analog inputs · ATTinyCore',
    ...AVR_LEVELS,
  },
};

const ESP32_COMMON = { family: 'esp32', pinPrefix: 'GPIO', ...ESP32_LEVELS };

BOARDS.leonardo = {
  id: 'leonardo',
  label: 'Arduino Leonardo',
  short: 'Leonardo',
  tag: 'impulse-arduino-leonardo',
  fqbn: 'arduino:avr:leonardo',
  mcu: 'atmega32u4',
  pins: PINS_LEONARDO,
  pwm: [3, 5, 6, 9, 10, 11, 13],
  ledBuiltin: 13,
  i2c: { sda: 2, scl: 3 },
  spi: { ss: 17, mosi: 16, miso: 14, sck: 15 },
  // Serial is the 32U4's own USB port; Serial1 is pins 0 and 1.
  serial: [null, { rx: 0, tx: 1 }],
  interrupts: [0, 1, 2, 3, 7],
  // The R3 header's SDA/SCL next to AREF are D2/D3 on this board.
  aliases: { 'A4.2': '2', 'A5.2': '3' },
  description: 'ATmega32U4 · native USB (Serial) · 20 digital pins · 12 analog inputs',
  ...AVR_LEVELS,
};

Object.assign(BOARDS, {
  esp32: {
    id: 'esp32',
    label: 'ESP32 DevKit V1',
    short: 'ESP32',
    tag: 'wokwi-esp32-devkit-v1',
    fqbn: 'esp32:esp32:esp32doit-devkit-v1',
    mcu: 'esp32',
    pins: gpioPins(ESP32_GPIO, ESP32_ANALOG),
    pwm: ESP32_GPIO.filter(n => !ESP32_INPUT_ONLY.includes(n)),
    inputOnly: ESP32_INPUT_ONLY,
    ledBuiltin: 2,
    ledProp: 'led1',
    i2c: { sda: 21, scl: 22 },
    spi: { ss: 5, mosi: 23, miso: 19, sck: 18 },
    serial: [{ rx: 3, tx: 1 }],
    interrupts: ESP32_GPIO,
    aliases: ESP32_ALIASES,
    description: 'ESP32 · dual-core Xtensa LX6 at 240 MHz · 25 GPIO on the header · 3.3 V logic',
    ...ESP32_COMMON,
  },
  esp32s3: {
    id: 'esp32s3',
    label: 'ESP32-S3 DevKitC-1',
    short: 'ESP32-S3',
    tag: 'impulse-esp32-s3-devkitc',
    fqbn: 'esp32:esp32:esp32s3',
    mcu: 'esp32s3',
    pins: gpioPins(S3_GPIO, S3_ANALOG),
    pwm: S3_GPIO,
    ledBuiltin: 48,
    rgbLed: 48,
    i2c: { sda: 8, scl: 9 },
    spi: { ss: 10, mosi: 11, miso: 13, sck: 12 },
    serial: [{ tx: 43, rx: 44 }],
    interrupts: S3_GPIO,
    aliases: { TX: '43', RX: '44' },
    description: 'ESP32-S3 · dual-core Xtensa LX7 at 240 MHz · 36 GPIO · RGB LED on GPIO48 · 3.3 V logic',
    ...ESP32_COMMON,
  },
  esp32c3: {
    id: 'esp32c3',
    label: 'ESP32-C3 DevKitM-1',
    short: 'ESP32-C3',
    tag: 'impulse-esp32-c3-devkitm',
    fqbn: 'esp32:esp32:esp32c3',
    mcu: 'esp32c3',
    pins: gpioPins(C3_GPIO, C3_ANALOG),
    pwm: C3_GPIO,
    ledBuiltin: 8,
    rgbLed: 8,
    i2c: { sda: 8, scl: 9 },
    spi: { ss: 7, mosi: 6, miso: 5, sck: 4 },
    serial: [{ tx: 21, rx: 20 }],
    interrupts: C3_GPIO,
    aliases: { TX: '21', RX: '20' },
    description: 'ESP32-C3 · single-core RISC-V at 160 MHz · 15 GPIO · RGB LED on GPIO8 · 3.3 V logic',
    ...ESP32_COMMON,
  },
  nanoesp32: {
    id: 'nanoesp32',
    label: 'Arduino Nano ESP32',
    short: 'Nano ESP32',
    tag: 'impulse-nano-esp32',
    fqbn: 'arduino:esp32:nano_nora',
    mcu: 'esp32s3',
    pins: NANO_ESP32_GPIO.map(n => pin(n, 'GPIO', n, NANO_ESP32_A.includes(n) ? { adc: n, analog: `A${NANO_ESP32_A.indexOf(n)}` } : {})),
    pwm: NANO_ESP32_GPIO,
    ledBuiltin: 48,
    i2c: { sda: 11, scl: 12 },
    spi: { ss: 21, mosi: 38, miso: 47, sck: 48 },
    serial: [{ rx: 44, tx: 43 }],
    interrupts: NANO_ESP32_GPIO,
    // Header names (the Nano's) → GPIO; D-numbers in sketches and tests → GPIO.
    aliases: {
      ...Object.fromEntries(NANO_ESP32_D.map((g, d) => [String(d), String(g)])),
      '11.2': '38', '12.2': '47', '13.2': '48',
    },
    digitalPins: NANO_ESP32_D,
    labels: NANO_ESP32_LABELS,
    description: 'ESP32-S3 in the Nano shape · D0–D13 and A0–A7 like every Nano · RGB LED · 3.3 V logic',
    family: 'esp32',
    ...ESP32_LEVELS,
  },
});

export const BOARD_ORDER = ['uno', 'nano', 'mega', 'leonardo', 'pico', 'attiny85', 'esp32', 'esp32s3', 'esp32c3', 'nanoesp32'];
export const DEFAULT_BOARD = 'uno';

/** Which boards run, for messages: every board built on an emulated chip. */
export function simulatedBoardsText() {
  return 'boards built on the ATmega328P or 168 (Uno, Nano, Pro Mini…), the ATmega2560 or 1280 (Mega), the ATmega32U4 (Leonardo, Micro…), the ATtiny25/45/85, the RP2040 (Pico, XIAO, Feather…) and the ESP32, ESP32-S2, ESP32-S3 and ESP32-C3';
}

for (const board of Object.values(BOARDS)) {
  board.byPin = new Map(board.pins.map(p => [p.pin, p]));
  board.byAnalog = new Map(board.pins.filter(p => p.analog).map(p => [p.analog, p]));
  board.pinCount = Math.max(...board.pins.map(p => p.pin)) + 1;
  board.digitalCount = board.pins.filter(p => p.port && (board.pinPrefix || !p.analog)).length;
  board.pwmSet = new Set(board.pwm);
}

export function boardById(id) {
  return BOARDS[id] || BOARDS[DEFAULT_BOARD];
}

export function boardByTag(tag) {
  return Object.values(BOARDS).find(b => b.tag === tag) || null;
}

export function isBoardTag(tag) {
  return !!boardByTag(tag);
}

// Arduino-Pico 6.3 boards built on the RP2350 (Cortex-M33), which isn't
// emulated, whose ids don't all say so. The Pico W is left out too: its LED
// is on the Wi-Fi chip. An unknown RP2350 board is refused at load time
// (its UF2 isn't an RP2040 image), so a new one fails loudly, not silently.
const RP2350_BOARDS = new Set([
  'adafruit_fruitjam', 'cytron_iriv_io_controller', 'datanoisetv_picoadk_v2', 'jumperless_v5',
  'olimex_pico2bb48', 'olimex_pico2xl', 'olimex_pico2xxl', 'pimoroni_explorer', 'pimoroni_pico_plus_2',
  'pimoroni_pico_plus_2w', 'rpipico2', 'rpipico2w', 'sparkfun_xrp_controller', 'wiznet_5100s_evb_pico2',
  'wiznet_5500_evb_pico2', 'wiznet_6300_evb_pico2',
]);

// Boards of Espressif's core (esp32:esp32 2.0.17) not built on the classic
// ESP32, by chip (build.mcu in boards.txt); the rest are ESP32 boards. Boards
// added in later cores are looked up in the installed core (registerBoardChip).
const ESP32_CHIPS = {
  esp32s3: ['Bee_Data_Logger', 'Bee_Motion_S3', 'Bee_S3', 'Edgebox-ESP-100', 'XIAO_ESP32S3', 'adafruit_camera_esp32s3', 'adafruit_feather_esp32s3', 'adafruit_feather_esp32s3_nopsram', 'adafruit_feather_esp32s3_reversetft', 'adafruit_feather_esp32s3_tft', 'adafruit_matrixportal_esp32s3', 'adafruit_metro_esp32s3', 'adafruit_qtpy_esp32s3_n4r2', 'adafruit_qtpy_esp32s3_nopsram', 'adafruit_qualia_s3_rgb666', 'atd147_s3', 'aventen_s3_sync', 'bpi_leaf_s3', 'crabik_slot_esp32_s3', 'cytron_maker_feather_aiot_s3', 'deneyapkart1Av2', 'dfrobot_firebeetle2_esp32s3', 'dfrobot_romeo_esp32s3', 'esp32s3', 'esp32s3_powerfeather', 'esp32s3box', 'esp32s3camlcd', 'esp32s3usbotg', 'feathers3', 'gen4-ESP32-S3R8n16', 'heltec_wifi_kit_32_V3', 'heltec_wifi_lora_32_V3', 'lilygo_t_display_s3', 'lionbits3', 'lolin_s3', 'lolin_s3_mini', 'lolin_s3_pro', 'm5stack-atoms3', 'm5stack-cores3', 'motorgo_mini_1', 'namino_arancio', 'namino_rosso', 'nano_nora', 'nanos3', 'nebulas3', 'nora_w10', 'pros3', 'redpill_esp32s3', 'stamp-s3', 'tamc_termod_s3', 'tinys3', 'unphone8', 'unphone9', 'wifiduino32s3'],
  esp32c3: ['AirM2M_CORE_ESP32C3', 'Bee_Motion_Mini', 'VALTRACK_V4_MFW_ESP32_C3', 'VALTRACK_V4_VTS_ESP32_C3', 'XIAO_ESP32C3', 'adafruit_qtpy_esp32c3', 'deneyapkartg', 'dfrobot_beetle_esp32c3', 'esp32c3', 'esp32c3m1IKit', 'lolin_c3_mini', 'ttgo-t-oi-plus', 'wifiduino32c3'],
  esp32s2: ['Bee_Motion', 'adafruit_feather_esp32s2', 'adafruit_feather_esp32s2_reversetft', 'adafruit_feather_esp32s2_tft', 'adafruit_funhouse_esp32s2', 'adafruit_magtag29_esp32s2', 'adafruit_metro_esp32s2', 'adafruit_qtpy_esp32s2', 'atmegazero_esp32s2', 'deneyapmini', 'deneyapminiv2', 'department_of_alchemy_minimain_esp32s2', 'esp32s2', 'esp32s2usb', 'feathers2', 'feathers2neo', 'franzininho_wifi_esp32s2', 'franzininho_wifi_msc_esp32s2', 'lolin_s2_mini', 'lolin_s2_pico', 'micros2', 'rmp', 'sensebox_mcu_esp32s2', 'sparkfun_esp32s2_thing_plus', 'tinys2'],
};
const ESP32_CHIP_OF = new Map(Object.entries(ESP32_CHIPS).flatMap(([chip, ids]) => ids.map(id => [id, chip])));
const registeredChips = new Map();

/** The chip a board is built on (build.mcu from the installed core), for boards the table doesn't know. */
export function registerBoardChip(fqbn, mcu) {
  const base = String(fqbn || '').split(':').slice(0, 3).join(':');
  if (base && mcu) registeredChips.set(base, String(mcu));
}

/** build.mcu of an ESP32-family board: registered, from the table, else guessed from its id. */
export function esp32ChipOf(fqbn) {
  const base = String(fqbn || '').split(':').slice(0, 3).join(':');
  if (registeredChips.has(base)) return registeredChips.get(base);
  const [vendor, , id = ''] = base.split(':');
  if (vendor === 'arduino') return id === 'nano_nora' ? 'esp32s3' : null;
  if (ESP32_CHIP_OF.has(id)) return ESP32_CHIP_OF.get(id);
  if (/c6|h2|p4|c2|c5|c61/i.test(id)) return null;
  return /s3/i.test(id) ? 'esp32s3' : /s2/i.test(id) ? 'esp32s2' : /c3/i.test(id) ? 'esp32c3' : 'esp32';
}

/** The drawn board a chip's boards run on. */
const ESP32_DRAWN = { esp32: 'esp32', esp32s3: 'esp32s3', esp32s2: 'esp32s3', esp32c3: 'esp32c3' };
const CHIP_NAMES = { esp32: 'ESP32', esp32s3: 'ESP32-S3', esp32s2: 'ESP32-S2', esp32c3: 'ESP32-C3' };

/**
 * How a board from the board menu is simulated: which drawn board it runs on,
 * the FQBN the simulator compiles with, and the chip it emulates. Every board
 * built on an emulated chip runs: the ATmega328P/168 family (Uno, Nano, Pro,
 * Mini, Fio, LilyPad, Ethernet, Duemilanove…), the ATmega2560/1280 (Mega, Mega
 * ADK), ATTinyCore's ATtiny25/45/85, and the RP2040 boards of the Arduino-Pico
 * core (pins are GPIO numbers on all of them, so they're wired on the Pico).
 * @returns {null | { board: object, fqbn: string, mcu: string, note?: string }}
 */
export function simulationTarget(fqbn) {
  if (!fqbn) return null;
  const opt = (name) => new RegExp(`(?:^|[:,])${name}=([^,:]+)`).exec(fqbn)?.[1] || '';
  const as = (board, extra = {}) => ({ board, fqbn: board.fqbn, mcu: board.mcu, ...extra });
  // Clock-for-clock: the simulator runs at 16 MHz, so slower variants compile as their 16 MHz twin.
  const atmega168 = (board, drawn) => as(board, { fqbn: 'arduino:avr:diecimila:cpu=atmega168', mcu: 'atmega168', note: `runs on an emulated ATmega168, drawn as the ${drawn}` });

  if (/^arduino:avr:(mega|megaADK)(:|$)/.test(fqbn)) {
    return opt('cpu') === 'atmega1280'
      ? as(BOARDS.mega, { fqbn: 'arduino:avr:mega:cpu=atmega1280', mcu: 'atmega1280', note: 'runs on an emulated ATmega1280, drawn as the Mega 2560' })
      : as(BOARDS.mega);
  }
  // Arduino NG or older: an ATmega8 or ATmega168 in the Uno's pinout.
  if (/^arduino:avr:atmegang(:|$)/.test(fqbn)) {
    const cpu = opt('cpu') || 'atmega168';
    if (cpu === 'atmega8') return as(BOARDS.uno, { fqbn: 'arduino:avr:atmegang:cpu=atmega8', mcu: 'atmega8', note: 'runs on an emulated ATmega8, drawn as the Uno' });
    return atmega168(BOARDS.uno, 'Uno');
  }
  if (/^arduino:avr:(nano|pro|mini|fio|bt|lilypad)(:|$)/.test(fqbn)) {
    const cpu = opt('cpu');
    if (/atmega8\b|^atmega8$/.test(cpu)) {
      // ATmega8 Nano/Pro/Mini/LilyPad builds: the board's own pins, on the ATmega8.
      return as(BOARDS.nano, { fqbn, mcu: 'atmega8', note: 'runs on an emulated ATmega8, drawn as the Nano' });
    }
    return /atmega168/.test(cpu) ? atmega168(BOARDS.nano, 'Nano') : as(BOARDS.nano);
  }
  // ATmega32U4 boards. The 8 MHz ones compile as 16 MHz, the simulator's clock.
  const u4 = /^arduino:avr:(leonardo|leonardoeth|micro|esplora|LilyPadUSB|yun|yunmini|chiwawa|one|robotControl|robotMotor|circuitplay32u4cat)(:|$)/.exec(fqbn);
  if (u4) {
    const own = u4[1] === 'leonardo';
    const slow = u4[1] === 'LilyPadUSB' || u4[1] === 'circuitplay32u4cat';
    return as(BOARDS.leonardo, {
      fqbn: fqbn.split(':').slice(0, 3).join(':'),
      ...(slow ? { properties: { 'build.f_cpu': '16000000L' } } : {}),
      note: own ? undefined : `runs on an emulated ATmega32U4${slow ? ' at 16 MHz' : ''}, drawn as the Leonardo`,
    });
  }
  // Adafruit Gemma in Arduino's core: an ATtiny85 at 8 MHz, compiled for 16 MHz.
  if (/^arduino:avr:gemma(:|$)/.test(fqbn)) {
    return as(BOARDS.attiny85, { fqbn: 'arduino:avr:gemma', mcu: 'attiny85-gemma', properties: { 'build.f_cpu': '16000000L' }, note: 'runs on an emulated ATtiny85 at 16 MHz, drawn as the ATtiny85' });
  }
  // The Uno WiFi's sketch runs on its ATmega328P.
  if (/^arduino:avr:unowifi(:|$)/.test(fqbn)) return as(BOARDS.uno, { note: 'runs on its ATmega328P, drawn as the Uno (the Wi-Fi module isn\'t simulated)' });
  if (/^arduino:avr:(uno|unomini|ethernet|duemilanove|diecimila)(:|$)/.test(fqbn)) {
    return /atmega168/.test(opt('cpu')) ? atmega168(BOARDS.uno, 'Uno') : as(BOARDS.uno);
  }
  // ATTinyCore's ATtiny25/45/85 share the chip; the smaller ones have less flash and RAM.
  if (/^ATTinyCore:avr:attinyx5(micr)?(:|$)/.test(fqbn)) {
    const chip = opt('chip') || '85';
    if (chip === '85') return as(BOARDS.attiny85);
    if (chip !== '45' && chip !== '25') return null;
    return as(BOARDS.attiny85, { fqbn: `ATTinyCore:avr:attinyx5:chip=${chip},clock=16pll`, mcu: `attiny${chip}`, note: `runs on an emulated ATtiny${chip}, drawn as the ATtiny85` });
  }
  // ESP32 family: compiled for the board itself (its pins, its options) and
  // run in QEMU; S2 boards run on the S3, which the main process handles.
  const esp = /^(esp32|arduino):esp32:([^:]+)/.exec(fqbn);
  if (esp) {
    const chip = esp32ChipOf(fqbn);
    const drawn = BOARDS[esp[1] === 'arduino' ? (chip ? 'nanoesp32' : '') : ESP32_DRAWN[chip]];
    if (!drawn) return null;
    const own = fqbn.split(':').slice(0, 3).join(':') === drawn.fqbn;
    const runsOn = chip === 'esp32s2' ? 'ESP32-S3 (the ESP32-S2 isn\'t emulated; its GPIO numbers are the same)' : CHIP_NAMES[chip];
    return as(drawn, {
      fqbn,
      mcu: chip,
      note: own ? undefined : `runs on the emulated ${runsOn}, drawn as the ${drawn.label}: wire by GPIO number`,
    });
  }
  const rp = /^rp2040:rp2040:([^:]+)/.exec(fqbn);
  if (rp) {
    const id = rp[1];
    if (id === 'rpipico') return as(BOARDS.pico);
    if (RP2350_BOARDS.has(id) || /2350/.test(id) || id === 'rpipicow') return null;
    return as(BOARDS.pico, { fqbn: `rp2040:rp2040:${id}`, note: 'runs on the emulated RP2040, drawn as a Raspberry Pi Pico: wire by GPIO number (GP0–GP28)' });
  }
  return null;
}

/** The simulated board an FQBN compiles for, or null when it can't be simulated. */
export function boardForFqbn(fqbn) {
  return simulationTarget(fqbn)?.board ?? null;
}

/**
 * What to compile and emulate for a drawn board: the upload board's own target
 * when it runs on this board (a Pro Mini 168 on the Nano), else the board itself.
 */
export function compileTarget(board, uploadFqbn) {
  const target = simulationTarget(uploadFqbn);
  if (target && target.board.id === board.id) return target;
  return { board, fqbn: board.fqbn, mcu: board.mcu };
}

/**
 * Board header pin name → Arduino pin number. Returns null for power, ground,
 * reset and unknown names.
 */
export function boardPinNumber(board, name) {
  if (!board || name == null) return null;
  let key = String(name);
  if (board.aliases && key in board.aliases) key = board.aliases[key];
  if (/^\d+$/.test(key)) {
    const n = Number(key);
    const entry = board.byPin.get(n);
    return entry && entry.port && (board.pinPrefix || !entry.analog) ? n : null;
  }
  const analog = board.byAnalog.get(key);
  return analog ? analog.pin : null;
}

/** Electrical role of a board header pin that isn't an I/O pin. */
const POWER_PINS = {
  GND: { kind: 'gnd', volts: 0 },
  '5V': { kind: 'vcc', volts: 5 },
  IOREF: { kind: 'vcc', volts: 5 },
  VIN: { kind: 'vcc', volts: 5 },
  '3.3V': { kind: 'vcc', volts: 3.3 },
  RESET: { kind: 'reset' },
  // Raspberry Pi Pico
  '3V3': { kind: 'vcc', volts: 3.3 },
  ADC_VREF: { kind: 'vcc', volts: 3.3 },
  VBUS: { kind: 'vcc', volts: 5 },
  VSYS: { kind: 'vcc', volts: 5 },
  AGND: { kind: 'gnd', volts: 0 },
  RUN: { kind: 'reset' },
  // ESP32 boards
  EN: { kind: 'reset' },
  RST: { kind: 'reset' },
  // Bare chips (ATtiny85)
  VCC: { kind: 'vcc', volts: 5 },
};

/** Header pin name without its duplicate suffix: "GND.2" → "GND". */
export const basePinName = (name) => String(name).replace(/\.\d+$/, '');

export function boardPowerPin(name) {
  const role = POWER_PINS[basePinName(name)];
  return role ? { ...role } : null;
}

/** "D13" / "A0" for an Arduino pin number. */
export function pinLabel(board, n) {
  if (board?.labels?.[n]) return board.labels[n];
  if (board?.pinPrefix) return `${board.pinPrefix}${n}`;
  const entry = board?.byPin.get(n);
  if (entry?.analog) return entry.analog;
  return `D${n}`;
}

/**
 * Parse a pin reference written in a sketch or a test: 13, D13, A0, LED_BUILTIN.
 * @returns {number|null}
 */
export function parseBoardPin(board, ref) {
  const s = String(ref).trim().toUpperCase();
  if (s === 'LED_BUILTIN') return board.ledBuiltin;
  if (s === 'SDA') return board.i2c.sda;
  if (s === 'SCL') return board.i2c.scl;
  if (s === 'MOSI') return board.spi.mosi;
  if (s === 'MISO') return board.spi.miso;
  if (s === 'SCK') return board.spi.sck;
  if (s === 'SS') return board.spi.ss;
  // Boards numbered the Arduino way on another chip (Nano ESP32): D13 is a GPIO.
  if (board.digitalPins) {
    const d = /^D?(\d{1,2})$/.exec(s);
    if (d) return board.digitalPins[Number(d[1])] ?? null;
    const g = /^GPIO(\d{1,2})$/.exec(s);
    if (g) return board.byPin.has(Number(g[1])) ? Number(g[1]) : null;
  }
  let m = board.pinPrefix ? new RegExp(`^${board.pinPrefix}(\\d{1,2})$`).exec(s) : null;
  if (m) {
    const n = Number(m[1]);
    return board.byPin.has(n) ? n : null;
  }
  m = /^D?(\d{1,2})$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    return board.byPin.has(n) ? n : null;
  }
  m = /^A(\d{1,2})$/.exec(s);
  if (m) return board.byAnalog.get(`A${Number(m[1])}`)?.pin ?? null;
  return null;
}
