// Parts catalog: every part the simulator offers, with search keywords,
// descriptions, pin documentation, editable properties, live controls and
// the behavior that simulates it.
//
// Part "type" strings match Wokwi's diagram.json names wherever a Wokwi part
// exists, so Wokwi projects import as-is. Parts drawn by Impulse use the
// "impulse-" prefix.

import { BoardBehavior, LedBehavior, RgbLedBehavior, BarGraphBehavior, BuzzerBehavior, PushbuttonBehavior,
  SlideSwitchBehavior, DipSwitchBehavior, PotentiometerBehavior } from './basic.js';
import { SevenSegmentBehavior, LcdBehavior, Ssd1306Behavior, NeoPixelBehavior, LedRingBehavior, NeoMatrixBehavior,
  Ili9341Behavior, Max7219Behavior, Tm1637Behavior } from './display.js';
import { JoystickBehavior, RotaryEncoderBehavior, KeypadBehavior, IrReceiverBehavior, IrRemoteBehavior,
  RotaryDialerBehavior, TiltBehavior } from './input.js';
import { UltrasonicBehavior, DhtBehavior, PirBehavior, PhotoresistorBehavior, NtcBehavior, Lm35Behavior,
  GasBehavior, FlameBehavior, SoundBehavior, SoilBehavior, HeartbeatBehavior, Mpu6050Behavior, Ds1307Behavior,
  Hx711Behavior, Ds18b20Behavior } from './sensors.js';
import { ServoBehavior, StepperBehavior, BiaxialStepperBehavior, StepperDriverBehavior, RelayBehavior,
  RelayModuleBehavior, DcMotorBehavior, HBridgeBehavior, L298nBehavior, ShiftRegisterBehavior,
  Stepper28byjBehavior } from './motion.js';
import { DigitalModuleBehavior, AnalogOutModuleBehavior, LdrBehavior, TransistorBehavior, ReedSwitchBehavior,
  breadboardLinks, breadboardPins } from './modules.js';
import { BatteryBehavior, CapacitorBehavior, DiodeBehavior, MosfetBehavior } from './power.js';
import { AndGateBehavior, NandGateBehavior, OrGateBehavior, NorGateBehavior, XorGateBehavior, NotGateBehavior,
  FlipFlopDBehavior } from './logic.js';
import { PART_PINS } from './pins.js';

export const CATEGORY_ORDER = ['Boards', 'Breadboards', 'Basic', 'Displays', 'Input', 'Sensors', 'Motors & actuators', 'Logic & power'];

export const CATEGORY_HINTS = {
  Boards: 'The microcontroller that runs your sketch',
  Breadboards: 'Push parts into the holes to connect them',
  Basic: 'LEDs, resistors, buttons, knobs and sound',
  Displays: 'Text, graphics and light',
  Input: 'Things you press, turn or point at',
  Sensors: 'Measure the world: distance, temperature, light…',
  'Motors & actuators': 'Make things move or switch',
  'Logic & power': 'Batteries, diodes, transistors, logic gates and chips',
};

const LED_COLORS = ['red', 'green', 'blue', 'yellow', 'orange', 'white', 'purple'];
const sel = (key, label, options, extra = {}) => ({ key, label, type: 'select', options, ...extra });
const num = (key, label, min, max, step, unit, extra = {}) => ({ key, label, type: 'range', min, max, step, unit, ...extra });
const text = (key, label, extra = {}) => ({ key, label, type: 'text', ...extra });
const toggle = (key, label, extra = {}) => ({ key, label, type: 'toggle', ...extra });
const action = (key, label) => ({ key, label, type: 'action' });

const I2C_LCD_ADDRESSES = ['0x27', '0x3F', '0x20', '0x26'];

const defs = {
  // ── Boards ─────────────────────────────────────────────────────────────────
  'wokwi-arduino-uno': {
    label: 'Arduino Uno', category: 'Boards', board: 'uno', behavior: BoardBehavior,
    keywords: ['uno', 'r3', 'uno r3', 'atmega328p', 'arduino', 'board', 'microcontroller', 'genuino', 'redboard', 'clone', 'ch340'],
    description: 'The classic Arduino: ATmega328P at 16 MHz, 14 digital pins (6 PWM), 6 analog inputs, I²C on A4/A5, SPI on 10-13.',
  },
  'wokwi-arduino-nano': {
    label: 'Arduino Nano', category: 'Boards', board: 'nano', behavior: BoardBehavior,
    keywords: ['nano', 'nano v3', 'atmega328p', 'arduino', 'board', 'breadboard', 'small', 'microcontroller', 'pro mini', 'arduino mini', 'clone', 'ch340'],
    description: 'Breadboard-sized ATmega328P board: same chip as the Uno plus two analog-only inputs A6 and A7.',
  },
  'wokwi-arduino-mega': {
    label: 'Arduino Mega 2560', category: 'Boards', board: 'mega', behavior: BoardBehavior,
    keywords: ['mega', '2560', 'atmega2560', 'arduino', 'board', 'microcontroller', 'many pins', 'serial1'],
    description: 'ATmega2560 with 54 digital pins (15 PWM), 16 analog inputs, 4 hardware serial ports, I²C on 20/21 and SPI on 50-53.',
  },
  'impulse-pi-pico': {
    label: 'Raspberry Pi Pico', category: 'Boards', board: 'pico', behavior: BoardBehavior,
    keywords: ['pico', 'raspberry pi pico', 'rpi pico', 'rp2040', 'raspberry', 'board', 'microcontroller', 'arm', 'cortex-m0', '3.3v', 'arduino-pico', 'earlephilhower'],
    description: 'RP2040 board with 3.3 V logic: 26 GPIO (all PWM), analog inputs on GP26–GP28, I²C on GP4/GP5, SPI on GP16–GP19, Serial over USB and Serial1 on GP0/GP1. Compiles with the Arduino-Pico core. Its pins take at most 3.3 V.',
  },
  'impulse-attiny85': {
    label: 'ATtiny85', category: 'Boards', board: 'attiny85', behavior: BoardBehavior,
    keywords: ['attiny85', 'attiny', 'tiny85', 'attiny 85', 'attinycore', 'avr', 'dip-8', 'dip8', 'chip', 'microcontroller', 'digispark', 'small', 'low power'],
    description: 'An 8-pin AVR chip at 16 MHz: PB0–PB5 as pins 0–5, PWM on 0, 1 and 4, analog inputs A1 (PB2), A2 (PB4), A3 (PB3) and A0 (PB5, the RESET pin). Serial is software: TX on PB0, RX on PB1. I²C (Wire) and SPI run on its USI: SDA PB0, SCL PB2, DO PB1. Plug it across a breadboard\'s center gap and power VCC and GND. Compiles with ATTinyCore.',
    pins: { PB0: 'Pin 0 · PWM · Serial TX · I²C SDA · SPI DI', PB1: 'Pin 1 · PWM · LED_BUILTIN · Serial RX · SPI DO', PB2: 'Pin 2 · A1 · I²C SCL · SPI USCK · INT0', PB3: 'Pin 3 · A3', PB4: 'Pin 4 · A2 · PWM', PB5: 'Pin 5 · A0 · RESET', VCC: 'Supply (5 V)', GND: 'Ground' },
  },

  'impulse-arduino-leonardo': {
    label: 'Arduino Leonardo', category: 'Boards', board: 'leonardo', behavior: BoardBehavior,
    keywords: ['leonardo', 'atmega32u4', '32u4', 'micro', 'pro micro', 'esplora', 'yun', 'native usb', 'keyboard', 'mouse', 'hid', 'arduino', 'board', 'microcontroller'],
    description: 'ATmega32U4 with native USB: Serial is the USB port itself (the core waits for the computer with while (!Serial)), Serial1 is pins 0/1, I²C is on 2/3 (SDA/SCL), PWM on 3, 5, 6, 9, 10, 11 and 13, analog inputs A0–A5 plus A6–A11 on pins 4, 6, 8, 9, 10 and 12. The Micro, Esplora, Yún and other 32U4 boards run on it.',
  },
  'wokwi-esp32-devkit-v1': {
    label: 'ESP32 DevKit V1', category: 'Boards', board: 'esp32', behavior: BoardBehavior,
    keywords: ['esp32', 'esp-32', 'devkit', 'devkit v1', 'doit', 'esp32 dev module', 'esp-wroom-32', 'wroom', 'wifi', 'bluetooth', 'espressif', 'nodemcu-32s', '3.3v', 'board', 'microcontroller'],
    description: 'ESP32 (dual-core, 240 MHz) with 3.3 V logic: pins are GPIO numbers; the blue LED is on GPIO2 (LED_BUILTIN); analog inputs on GPIO32–39 (ADC1) and others; GPIO34–39 are inputs only, without pull-ups; I²C on 21/22, SPI on 18/19/23/5; Serial on GPIO1/3. Runs in Espressif\'s ESP32 emulator (Wi-Fi and Bluetooth aren\'t simulated). Compiles with Espressif\'s ESP32 core.',
  },
  'impulse-esp32-s3-devkitc': {
    label: 'ESP32-S3 DevKitC-1', category: 'Boards', board: 'esp32s3', behavior: BoardBehavior,
    keywords: ['esp32-s3', 'esp32s3', 's3', 'devkitc', 'devkitc-1', 'esp32-s3-wroom-1', 'espressif', 'rgb led', 'neopixel', 'ws2812', 'wifi', '3.3v', 'board', 'microcontroller'],
    description: 'ESP32-S3 (dual-core, 240 MHz) with 3.3 V logic: pins are GPIO numbers; an RGB LED (WS2812) on GPIO48 lights with digitalWrite(LED_BUILTIN, HIGH) or neopixelWrite(); analog inputs on GPIO1–20; I²C on 8/9, SPI on 10–13; Serial on TX (GPIO43) / RX (GPIO44). Runs in Espressif\'s ESP32-S3 emulator. ESP32-S2 boards run on it too.',
  },
  'impulse-esp32-c3-devkitm': {
    label: 'ESP32-C3 DevKitM-1', category: 'Boards', board: 'esp32c3', behavior: BoardBehavior,
    keywords: ['esp32-c3', 'esp32c3', 'c3', 'devkitm', 'devkitm-1', 'risc-v', 'riscv', 'esp32-c3-mini-1', 'espressif', 'rgb led', 'xiao esp32c3', '3.3v', 'board', 'microcontroller'],
    description: 'ESP32-C3 (single-core RISC-V, 160 MHz) with 3.3 V logic: pins are GPIO numbers; an RGB LED (WS2812) on GPIO8 (LED_BUILTIN); analog inputs on GPIO0–5; I²C on 8/9, SPI on 4–7; Serial on TX (GPIO21) / RX (GPIO20). Runs in Espressif\'s ESP32-C3 emulator.',
  },
  'impulse-nano-esp32': {
    label: 'Arduino Nano ESP32', category: 'Boards', board: 'nanoesp32', behavior: BoardBehavior,
    keywords: ['nano esp32', 'nano-esp32', 'nano_nora', 'esp32-s3', 'arduino', 'nano', 'board', 'microcontroller', '3.3v', 'wifi'],
    description: 'An ESP32-S3 in the Nano shape with 3.3 V logic: D0–D13 and A0–A7 as on every Nano (the core maps them to GPIOs), LED_BUILTIN on D13, I²C on A4/A5, SPI on D10–D13. Runs in Espressif\'s ESP32-S3 emulator. Compiles with Arduino\'s ESP32 core.',
  },

  // ── Breadboards ────────────────────────────────────────────────────────────
  'impulse-breadboard': {
    label: 'Breadboard (full, 830 points)', category: 'Breadboards',
    keywords: ['breadboard', 'protoboard', 'solderless', 'bb', '830', 'full', 'plugboard'],
    description: 'Drop parts onto the holes and they connect: each column of five (a-e, f-j) is joined, and the + and − rails run the full length.',
    attrs: { size: 'full' }, size: { w: 622, h: 192 },
    links: (attrs) => breadboardLinks(attrs.size || 'full'), pinNames: (attrs) => breadboardPins(attrs.size || 'full'),
    aliases: ['wokwi-breadboard'],
  },
  'impulse-breadboard-half': {
    label: 'Breadboard (half, 400 points)', category: 'Breadboards', tag: 'impulse-breadboard',
    keywords: ['breadboard', 'half', '400', 'protoboard', 'solderless'],
    description: 'Half-size breadboard with 30 columns and power rails on both sides.',
    attrs: { size: 'half' }, size: { w: 306, h: 192 },
    links: () => breadboardLinks('half'), pinNames: () => breadboardPins('half'),
    aliases: ['wokwi-breadboard-half'],
  },
  'impulse-breadboard-mini': {
    label: 'Breadboard (mini, 170 points)', category: 'Breadboards', tag: 'impulse-breadboard',
    keywords: ['breadboard', 'mini', '170', 'small'],
    description: 'Mini breadboard with 17 columns and no power rails.',
    attrs: { size: 'mini' }, size: { w: 181, h: 139 },
    links: () => breadboardLinks('mini'), pinNames: () => breadboardPins('mini'),
    aliases: ['wokwi-breadboard-mini'],
  },

  // ── Basic ──────────────────────────────────────────────────────────────────
  'wokwi-led': {
    label: 'LED', category: 'Basic', behavior: LedBehavior,
    keywords: ['led', 'light', 'diode', 'lamp', 'indicator', 'blink', '5mm', 'light emitting diode', 'laser', 'laser module', 'ky-008'],
    description: 'Lights when current flows from A (anode, the longer leg) to C (cathode). Use a 220 Ω series resistor. PWM pins dim it.',
    attrs: { color: 'red' },
    props: [sel('color', 'Color', LED_COLORS), text('label', 'Label')],
    pins: { A: 'Anode (+), longer leg', C: 'Cathode (−), flat side' },
  },
  'wokwi-rgb-led': {
    label: 'RGB LED', category: 'Basic', behavior: RgbLedBehavior,
    keywords: ['rgb', 'led', 'color', 'colour', 'full color', 'common cathode', 'common anode', 'tricolor'],
    description: 'Three LEDs in one package. Common cathode: COM to GND, drive R/G/B HIGH. Common anode: COM to 5V, drive R/G/B LOW. PWM mixes colors.',
    attrs: { common: 'cathode' },
    props: [sel('common', 'Common pin', ['cathode', 'anode'])],
    pins: { R: 'Red', G: 'Green', B: 'Blue', COM: 'Common cathode/anode' },
  },
  'wokwi-resistor': {
    label: 'Resistor', category: 'Basic',
    keywords: ['resistor', 'ohm', 'pull-up', 'pullup', 'pull-down', 'pulldown', '220', '10k', 'current limiting'],
    description: 'Limits current and forms pull-ups, pull-downs and voltage dividers. The simulator solves the voltages.',
    attrs: { value: '220' },
    props: [sel('value', 'Resistance (Ω)', ['100', '220', '330', '470', '1000', '2200', '4700', '10000', '47000', '100000', '1000000'], { allowCustom: true })],
    resistors: (attrs) => [['1', '2', parseResistance(attrs.value)]],
    pins: { 1: 'Lead 1', 2: 'Lead 2' },
  },
  'wokwi-pushbutton': {
    label: 'Pushbutton', category: 'Basic', behavior: PushbuttonBehavior, interactive: true,
    keywords: ['button', 'push button', 'pushbutton', 'tactile', 'switch', 'momentary', 'tact', 'key', 'limit switch', 'end stop', 'endstop'],
    description: 'Momentary 12 mm button. Pins on the same side (1.l/1.r, 2.l/2.r) are always joined; pressing joins side 1 to side 2. Wire one side to a pin with INPUT_PULLUP and the other to GND.',
    attrs: { color: 'green' },
    props: [sel('color', 'Color', ['red', 'green', 'blue', 'yellow', 'white', 'black']), text('key', 'Keyboard key', { placeholder: 'e.g. a, Space' })],
    links: () => [['1.l', '1.r'], ['2.l', '2.r']],
    pins: { '1.l': 'Side 1 (left)', '1.r': 'Side 1 (right)', '2.l': 'Side 2 (left)', '2.r': 'Side 2 (right)' },
  },
  'wokwi-pushbutton-6mm': {
    label: 'Pushbutton (6 mm)', category: 'Basic', behavior: PushbuttonBehavior, interactive: true,
    keywords: ['button', 'small button', 'tactile', 'momentary', '6mm', 'breadboard button'],
    description: 'Small breadboard tactile switch; works like the 12 mm pushbutton.',
    attrs: { color: 'green' },
    props: [sel('color', 'Color', ['red', 'green', 'blue', 'yellow', 'white', 'black']), text('key', 'Keyboard key')],
    links: () => [['1.l', '1.r'], ['2.l', '2.r']],
  },
  'wokwi-potentiometer': {
    label: 'Potentiometer', category: 'Basic', behavior: PotentiometerBehavior, interactive: true,
    keywords: ['potentiometer', 'pot', 'knob', 'variable resistor', 'trimmer', 'rotary', 'analog', 'dial', '10k'],
    description: 'Rotary 10 kΩ knob. VCC to 5V, GND to GND, SIG to an analog pin: analogRead gives 0-1023 as you turn it.',
    attrs: { value: '512' },
    controls: [num('value', 'Position', 0, 1023, 1, '')],
    pins: { VCC: 'One end of the track (5V)', SIG: 'Wiper (to an analog pin)', GND: 'Other end (GND)' },
  },
  'wokwi-buzzer': {
    label: 'Buzzer', category: 'Basic', behavior: BuzzerBehavior,
    keywords: ['buzzer', 'piezo', 'speaker', 'sound', 'tone', 'beep', 'alarm', 'melody', 'music', 'audio'],
    description: 'Plays sound through your speakers. Passive: use tone(pin, freq). Active: beeps whenever its + pin is HIGH.',
    attrs: { mode: 'passive' },
    props: [sel('mode', 'Type', ['passive', 'active'])],
    pins: { 1: 'Negative (−)', 2: 'Positive (+)' },
  },
  'wokwi-slide-switch': {
    label: 'Slide switch', category: 'Basic', behavior: SlideSwitchBehavior, interactive: true,
    keywords: ['switch', 'slide', 'toggle', 'spdt', 'on off', 'selector'],
    description: 'SPDT switch: pin 2 is common and connects to pin 1 (handle left) or pin 3 (handle right).',
    attrs: { value: '0' },
    pins: { 1: 'Left contact', 2: 'Common', 3: 'Right contact' },
  },

  // ── Displays ───────────────────────────────────────────────────────────────
  'wokwi-lcd1602': {
    label: 'LCD 16×2 (I²C)', category: 'Displays', behavior: LcdBehavior,
    keywords: ['lcd', '1602', '16x2', 'i2c', 'liquidcrystal', 'character display', 'text', 'pcf8574', 'screen', 'display'],
    description: 'Character LCD with an I²C backpack (LiquidCrystal_I2C). SDA → A4, SCL → A5 on Uno/Nano (20/21 on Mega).',
    attrs: { pins: 'i2c', i2cAddress: '0x27' },
    props: [sel('i2cAddress', 'I²C address', I2C_LCD_ADDRESSES), sel('color', 'Text color', ['black', 'white', 'blue']), sel('background', 'Backlight', ['green', 'blue'])],
    libraries: ['LiquidCrystal I2C'],
    pins: { GND: 'Ground', VCC: '5V', SDA: 'I²C data', SCL: 'I²C clock' },
  },
  'wokwi-lcd1602-parallel': {
    label: 'LCD 16×2 (parallel)', category: 'Displays', tag: 'wokwi-lcd1602', behavior: LcdBehavior,
    keywords: ['lcd', '1602', '16x2', 'parallel', 'liquidcrystal', 'hd44780', 'character display', '4-bit'],
    description: 'HD44780 character LCD on the parallel bus (LiquidCrystal library, 4- or 8-bit). RW to GND, K to GND and A to 5V through 220 Ω for the backlight.',
    attrs: { pins: 'full' },
    saveAs: 'wokwi-lcd1602',
    libraries: ['LiquidCrystal'],
  },
  'wokwi-lcd2004': {
    label: 'LCD 20×4 (I²C)', category: 'Displays', behavior: LcdBehavior,
    keywords: ['lcd', '2004', '20x4', 'i2c', 'liquidcrystal', 'character display', 'text', 'screen'],
    description: 'Four-line character LCD with an I²C backpack.',
    attrs: { pins: 'i2c', i2cAddress: '0x27' },
    props: [sel('i2cAddress', 'I²C address', I2C_LCD_ADDRESSES)],
    libraries: ['LiquidCrystal I2C'],
  },
  'wokwi-lcd2004-parallel': {
    label: 'LCD 20×4 (parallel)', category: 'Displays', tag: 'wokwi-lcd2004', behavior: LcdBehavior,
    keywords: ['lcd', '2004', '20x4', 'parallel', 'liquidcrystal', 'hd44780'],
    description: 'Four-line HD44780 LCD on the parallel bus (LiquidCrystal).',
    attrs: { pins: 'full' },
    saveAs: 'wokwi-lcd2004',
    libraries: ['LiquidCrystal'],
  },
  'wokwi-ssd1306': {
    label: 'OLED 128×64 (SSD1306)', category: 'Displays', behavior: Ssd1306Behavior,
    keywords: ['oled', 'ssd1306', '128x64', '0.96', 'graphic display', 'i2c', 'adafruit gfx', 'u8g2', 'screen', 'display'],
    description: 'Monochrome graphics display. I²C (address 0x3C): DATA → SDA, CLK → SCL. For SPI, also wire DC and CS.',
    attrs: { i2cAddress: '0x3c' },
    props: [sel('i2cAddress', 'I²C address', ['0x3c', '0x3d'])],
    libraries: ['Adafruit SSD1306', 'Adafruit GFX Library'],
    pins: { DATA: 'SDA (I²C) / MOSI (SPI)', CLK: 'SCL (I²C) / SCK (SPI)', DC: 'Data/command (SPI)', RST: 'Reset', CS: 'Chip select (SPI)', '3V3': '3.3V', VIN: '5V', GND: 'Ground' },
  },
  'wokwi-7segment': {
    label: '7-segment display', category: 'Displays', behavior: SevenSegmentBehavior,
    keywords: ['7 segment', 'seven segment', '7seg', 'digit', 'numeric', 'counter', 'display', 'number'],
    description: 'One digit. Common anode: COM to 5V, drive segments LOW. Common cathode: COM to GND, drive segments HIGH. Use 220 Ω resistors.',
    attrs: { common: 'anode', color: 'red' },
    props: [sel('common', 'Common pin', ['anode', 'cathode']), sel('color', 'Color', ['red', 'green', 'blue', 'yellow', 'white'])],
    links: () => [['COM.1', 'COM.2']],
    pins: { A: 'Segment A (top)', B: 'Segment B', C: 'Segment C', D: 'Segment D (bottom)', E: 'Segment E', F: 'Segment F', G: 'Segment G (middle)', DP: 'Decimal point', 'COM.1': 'Common', 'COM.2': 'Common' },
  },
  'wokwi-7segment-4': {
    label: '4-digit 7-segment', category: 'Displays', tag: 'wokwi-7segment', behavior: SevenSegmentBehavior,
    keywords: ['7 segment', '4 digit', 'four digit', 'clock display', 'multiplex', 'seven segment', 'sevseg'],
    description: 'Four multiplexed digits sharing segment lines; DIG1-DIG4 select the digit. Works with the SevSeg library.',
    attrs: { digits: '4', common: 'anode', colon: '', color: 'red' },
    props: [sel('common', 'Common pin', ['anode', 'cathode'])],
    saveAs: 'wokwi-7segment',
    libraries: ['SevSeg'],
  },
  'wokwi-led-bar-graph': {
    label: 'LED bar graph', category: 'Displays', behavior: BarGraphBehavior,
    keywords: ['bar graph', 'led bar', '10 segment', 'level meter', 'vu meter'],
    description: 'Ten LEDs in a row: A1-A10 anodes, C1-C10 cathodes.',
    attrs: { color: 'red' },
    props: [sel('color', 'Color', ['red', 'green', 'blue', 'yellow', 'GYR', 'BCYR'])],
  },
  'wokwi-neopixel': {
    label: 'NeoPixel (WS2812B)', category: 'Displays', behavior: NeoPixelBehavior,
    keywords: ['neopixel', 'ws2812', 'ws2812b', 'addressable', 'rgb', 'fastled', 'smart led', 'pixel'],
    description: 'One addressable RGB LED. Chain them DOUT → DIN. Works with Adafruit NeoPixel and FastLED.',
    libraries: ['Adafruit NeoPixel'],
    pins: { VDD: '5V', VSS: 'Ground', DIN: 'Data in', DOUT: 'Data out (to the next pixel)' },
  },
  'wokwi-led-ring': {
    label: 'NeoPixel ring', category: 'Displays', behavior: LedRingBehavior,
    keywords: ['neopixel ring', 'led ring', 'ws2812', 'circle', 'addressable', 'fastled'],
    description: 'Ring of WS2812 LEDs (16 by default).',
    attrs: { pixels: '16' },
    props: [sel('pixels', 'Pixels', ['8', '12', '16', '24', '32'])],
    libraries: ['Adafruit NeoPixel'],
  },
  'wokwi-neopixel-matrix': {
    label: 'NeoPixel matrix 8×8', category: 'Displays', behavior: NeoMatrixBehavior,
    keywords: ['neopixel matrix', 'led matrix', 'ws2812', 'rgb matrix', 'pixel art', 'fastled', 'panel'],
    description: 'Grid of WS2812 LEDs, row by row (or serpentine).',
    attrs: { rows: '8', cols: '8' },
    props: [sel('rows', 'Rows', ['4', '8', '16']), sel('cols', 'Columns', ['4', '8', '16', '32']), sel('layout', 'Wiring', ['', 'serpentine'], { labels: ['Row by row', 'Serpentine'] })],
    libraries: ['Adafruit NeoPixel'],
  },
  'impulse-max7219-matrix': {
    label: 'LED matrix 8×8 (MAX7219)', category: 'Displays', behavior: Max7219Behavior,
    keywords: ['max7219', 'dot matrix', 'led matrix', '8x8', 'ledcontrol', 'md_max72xx', 'scrolling text', 'marquee'],
    description: 'Red 8×8 dot matrix with a MAX7219 driver. DIN, CS and CLK to any pins (LedControl) or to MOSI/SS/SCK (MD_MAX72XX). Chain modules DOUT → DIN.',
    props: [sel('color', 'Color', ['red', 'green', 'blue', 'yellow', 'white'])],
    attrs: { color: 'red' },
    libraries: ['LedControl'],
    links: () => [['VCC', 'VCC.2'], ['GND', 'GND.2'], ['CS', 'CS.2'], ['CLK', 'CLK.2']],
    pins: { VCC: '5V', GND: 'Ground', DIN: 'Data in', CS: 'Load / chip select', CLK: 'Clock', DOUT: 'Data out (to the next module)' },
  },
  'impulse-tm1637': {
    label: '4-digit display (TM1637)', category: 'Displays', behavior: Tm1637Behavior,
    keywords: ['tm1637', '4 digit', '4-digit', 'clock display', '7 segment module', 'seven segment module', 'countdown', 'timer display', 'score display'],
    description: 'Two-wire 4-digit display with a clock colon. Use the TM1637 library: TM1637Display display(CLK, DIO).',
    libraries: ['TM1637'],
    pins: { CLK: 'Clock', DIO: 'Data', VCC: '5V', GND: 'Ground' },
    aliases: ['wokwi-tm1637-7segment'],
  },
  'wokwi-ili9341': {
    label: 'TFT 2.8" (ILI9341)', category: 'Displays', behavior: Ili9341Behavior,
    keywords: ['tft', 'ili9341', 'lcd', 'color display', 'colour', '240x320', '2.8', 'spi', 'adafruit gfx', 'screen'],
    description: '240×320 color display over SPI: MOSI, SCK to the board\'s SPI pins, CS and D/C to any pins.',
    libraries: ['Adafruit ILI9341', 'Adafruit GFX Library'],
    pins: { VCC: '5V', GND: 'Ground', CS: 'Chip select', RST: 'Reset', 'D/C': 'Data/command', MOSI: 'SPI data in', SCK: 'SPI clock', LED: 'Backlight', MISO: 'SPI data out' },
  },

  // ── Input ──────────────────────────────────────────────────────────────────
  'wokwi-membrane-keypad': {
    label: 'Keypad 4×4', category: 'Input', behavior: KeypadBehavior, interactive: true,
    keywords: ['keypad', 'keyboard', 'membrane', 'matrix', '4x4', 'password', 'pin code', 'numpad', 'keys'],
    description: 'Membrane keypad: a pressed key joins its row (R1-R4) to its column (C1-C4). Use the Keypad library. You can also type on your keyboard.',
    libraries: ['Keypad'],
  },
  'wokwi-membrane-keypad-3': {
    label: 'Keypad 4×3', category: 'Input', tag: 'wokwi-membrane-keypad', behavior: KeypadBehavior, interactive: true,
    keywords: ['keypad', '4x3', '3x4', 'phone keypad', 'numpad'],
    description: 'Telephone-style keypad with 3 columns.',
    attrs: { columns: '3' },
    saveAs: 'wokwi-membrane-keypad',
    libraries: ['Keypad'],
  },
  'wokwi-ky-040': {
    label: 'Rotary encoder (KY-040)', category: 'Input', behavior: RotaryEncoderBehavior, interactive: true,
    keywords: ['rotary encoder', 'encoder', 'ky-040', 'ky040', 'knob', 'quadrature', 'infinite rotation', 'menu'],
    description: 'Quadrature encoder with push switch. Each detent pulses CLK and DT; clockwise, CLK falls while DT is HIGH. Module has pull-ups.',
    controls: [action('ccw', '⟲ Turn left'), action('cw', 'Turn right ⟳')],
  },
  'wokwi-analog-joystick': {
    label: 'Joystick', category: 'Input', behavior: JoystickBehavior, interactive: true,
    keywords: ['joystick', 'thumbstick', 'ky-023', 'xy', 'gamepad', 'analog stick', 'controller'],
    description: 'Two potentiometers and a push switch. VERT and HORZ read ~512 at rest; SEL connects to GND when pressed (use INPUT_PULLUP).',
    controls: [num('x', 'Horizontal', -1, 1, 0.05, ''), num('y', 'Vertical', -1, 1, 0.05, '')],
  },
  'wokwi-slide-potentiometer': {
    label: 'Slide potentiometer', category: 'Input', behavior: PotentiometerBehavior, interactive: true,
    keywords: ['slide pot', 'slider', 'fader', 'linear potentiometer'],
    description: 'Linear 10 kΩ potentiometer.',
    attrs: { travelLength: '30', value: '50' },
    controls: [num('value', 'Position', 0, 100, 1, '%')],
  },
  'wokwi-dip-switch-8': {
    label: 'DIP switch (8)', category: 'Input', behavior: DipSwitchBehavior, interactive: true,
    keywords: ['dip switch', 'dip', 'toggle switches', 'configuration', 'address switch'],
    description: 'Eight independent switches: switch n joins na to nb when on.',
  },
  'wokwi-tilt-switch': {
    label: 'Tilt switch', category: 'Input', behavior: TiltBehavior, interactive: true,
    keywords: ['tilt', 'ball switch', 'sw-520d', 'orientation', 'shake'],
    description: 'Tilt sensor module: OUT goes HIGH while tilted. Click it while running.',
    controls: [toggle('tilted', 'Tilted')],
  },
  'wokwi-ir-remote': {
    label: 'IR remote', category: 'Input', behavior: IrRemoteBehavior, interactive: true,
    keywords: ['ir remote', 'infrared', 'remote control', 'nec', 'tv remote', 'irremote'],
    description: 'Sends NEC codes to every IR receiver in the circuit (address 0x00). No wiring needed.',
    libraries: ['IRremote'],
  },
  'wokwi-ir-receiver': {
    label: 'IR receiver', category: 'Input', behavior: IrReceiverBehavior,
    keywords: ['ir receiver', 'infrared', 'vs1838b', 'tsop', 'remote', 'irremote', 'decoder'],
    description: 'Demodulating IR receiver: DAT idles HIGH and pulses LOW with each burst from the IR remote.',
    libraries: ['IRremote'],
  },
  'wokwi-rotary-dialer': {
    label: 'Rotary dialer', category: 'Input', behavior: RotaryDialerBehavior, interactive: true,
    keywords: ['rotary dial', 'telephone', 'dialer', 'phone', 'retro'],
    description: 'Old telephone dial: DIAL is grounded while dialing and PULSE opens once per count (use INPUT_PULLUP).',
  },

  // ── Sensors ────────────────────────────────────────────────────────────────
  'wokwi-hc-sr04': {
    label: 'Ultrasonic sensor (HC-SR04)', category: 'Sensors', behavior: UltrasonicBehavior,
    keywords: ['ultrasonic', 'hc-sr04', 'hcsr04', 'sr04', 'distance', 'sonar', 'range', 'proximity', 'echo', 'obstacle'],
    description: 'Measures distance: a 10 µs TRIG pulse makes ECHO go HIGH for 58 µs per cm. Use pulseIn(echoPin, HIGH).',
    attrs: { distance: '100' },
    controls: [num('distance', 'Distance', 2, 400, 1, 'cm')],
    pins: { VCC: '5V', TRIG: 'Trigger input', ECHO: 'Echo output', GND: 'Ground' },
  },
  'wokwi-dht22': {
    label: 'DHT22 temperature & humidity', category: 'Sensors', behavior: DhtBehavior,
    keywords: ['dht22', 'am2302', 'temperature', 'humidity', 'weather', 'climate', 'thermometer', 'dht'],
    description: 'Digital temperature and humidity sensor on one data pin (SDA) with the DHT sensor library.',
    attrs: { temperature: '24', humidity: '40' },
    controls: [num('temperature', 'Temperature', -40, 80, 0.1, '°C'), num('humidity', 'Humidity', 0, 100, 0.5, '%')],
    libraries: ['DHT sensor library', 'Adafruit Unified Sensor'],
    pins: { VCC: '3.3-5V', SDA: 'Data', NC: 'Not connected', GND: 'Ground' },
  },
  'wokwi-dht11': {
    label: 'DHT11 temperature & humidity', category: 'Sensors', tag: 'impulse-dht11', behavior: DhtBehavior, saveAs: 'wokwi-dht22',
    keywords: ['dht11', 'temperature', 'humidity', 'weather', 'thermometer', 'dht', 'blue sensor'],
    description: 'Lower-cost DHT sensor: whole degrees and 1 % humidity steps, 0-50 °C. Use DHT dht(pin, DHT11).',
    attrs: { model: 'dht11', temperature: '24', humidity: '40' },
    controls: [num('temperature', 'Temperature', 0, 50, 1, '°C'), num('humidity', 'Humidity', 20, 90, 1, '%')],
    libraries: ['DHT sensor library', 'Adafruit Unified Sensor'],
  },
  'wokwi-pir-motion-sensor': {
    label: 'PIR motion sensor', category: 'Sensors', behavior: PirBehavior, interactive: true,
    keywords: ['pir', 'motion', 'movement', 'hc-sr501', 'presence', 'occupancy', 'infrared', 'intruder', 'security'],
    description: 'OUT goes HIGH for a few seconds when it sees motion. Click the sensor while running to trigger it.',
    attrs: { delayTime: '5' },
    controls: [action('motion', 'Trigger motion'), num('delayTime', 'Hold time', 1, 30, 1, 's')],
  },
  'wokwi-photoresistor-sensor': {
    label: 'Light sensor (LDR module)', category: 'Sensors', behavior: PhotoresistorBehavior,
    keywords: ['ldr', 'photoresistor', 'light', 'lux', 'brightness', 'photocell', 'day night', 'light dependent resistor'],
    description: 'Photoresistor module: AO voltage drops as light increases; DO goes LOW above the threshold.',
    attrs: { lux: '500' },
    controls: [num('lux', 'Light', 0.1, 100000, 1, 'lux', { log: true })],
  },
  'impulse-ldr': {
    label: 'Photoresistor (bare LDR)', category: 'Sensors', behavior: LdrBehavior,
    keywords: ['ldr', 'photoresistor', 'light dependent resistor', 'photocell', 'voltage divider', 'cds'],
    description: 'A light-dependent resistor: resistance falls as light rises. Pair it with a 10 kΩ resistor as a voltage divider into an analog pin.',
    attrs: { lux: '500' },
    controls: [num('lux', 'Light', 0.1, 100000, 1, 'lux', { log: true })],
  },
  'wokwi-ntc-temperature-sensor': {
    label: 'NTC temperature sensor', category: 'Sensors', behavior: NtcBehavior,
    keywords: ['ntc', 'thermistor', 'temperature', 'thermometer', 'analog temperature', 'heat'],
    description: 'Thermistor module with a 10 kΩ divider (β 3950): OUT voltage drops as it warms up.',
    attrs: { temperature: '24' },
    controls: [num('temperature', 'Temperature', -24, 80, 0.5, '°C')],
  },
  'impulse-lm35': {
    label: 'LM35 temperature sensor', category: 'Sensors', behavior: Lm35Behavior,
    keywords: ['lm35', 'temperature', 'analog temperature', 'thermometer', 'to-92', 'tmp36'],
    description: 'Analog temperature IC: VOUT is 10 mV per °C. Temperature = analogRead × 500 / 1024.',
    attrs: { temperature: '24' },
    controls: [num('temperature', 'Temperature', 0, 150, 0.5, '°C')],
    pins: { VS: '+5V', VOUT: 'Output (10 mV/°C)', GND: 'Ground' },
  },
  'impulse-ds18b20': {
    label: 'DS18B20 temperature sensor', category: 'Sensors', behavior: Ds18b20Behavior,
    keywords: ['ds18b20', '18b20', 'onewire', 'one wire', '1-wire', 'dallas', 'temperature probe', 'waterproof temperature', 'thermometer', 'digital temperature', 'temperature'],
    description: 'Digital 1-Wire thermometer (−55 to 125 °C). Read it with the OneWire and DallasTemperature libraries; several sensors can share one pin. The 4.7 kΩ pull-up is included.',
    attrs: { temperature: '22.5' },
    controls: [num('temperature', 'Temperature', -55, 125, 0.5, '°C')],
    libraries: ['OneWire', 'DallasTemperature'],
    pins: { GND: 'Ground', DQ: 'Data (1-Wire)', VCC: '3-5.5 V (VDD)' },
    aliases: ['wokwi-ds18b20'],
  },
  'wokwi-gas-sensor': {
    label: 'Gas sensor (MQ-2)', category: 'Sensors', behavior: GasBehavior,
    keywords: ['gas', 'mq-2', 'mq2', 'smoke', 'lpg', 'co', 'air quality', 'mq-135', 'alcohol'],
    description: 'MQ gas sensor module: AOUT rises with gas concentration, DOUT goes LOW above the threshold.',
    attrs: { ppm: '400' },
    controls: [num('ppm', 'Gas concentration', 100, 10000, 10, 'ppm')],
  },
  'wokwi-flame-sensor': {
    label: 'Flame sensor', category: 'Sensors', behavior: FlameBehavior,
    keywords: ['flame', 'fire', 'ir flame', 'fire alarm'],
    description: 'IR flame sensor: AOUT falls as a flame gets closer, DOUT goes LOW when one is detected.',
    attrs: { flame: '0' },
    controls: [num('flame', 'Flame', 0, 100, 1, '%')],
  },
  'wokwi-big-sound-sensor': {
    label: 'Sound sensor (big)', category: 'Sensors', behavior: SoundBehavior,
    keywords: ['sound', 'microphone', 'mic', 'noise', 'clap', 'ky-037', 'audio level'],
    description: 'Microphone module: AOUT follows loudness, DOUT goes HIGH above the threshold.',
    attrs: { level: '20' },
    controls: [num('level', 'Loudness', 0, 100, 1, '%')],
  },
  'wokwi-small-sound-sensor': {
    label: 'Sound sensor (small)', category: 'Sensors', behavior: SoundBehavior,
    keywords: ['sound', 'microphone', 'mic', 'ky-038', 'clap', 'noise'],
    description: 'Small microphone module with analog and digital outputs.',
    attrs: { level: '20' },
    controls: [num('level', 'Loudness', 0, 100, 1, '%')],
  },
  'wokwi-heart-beat-sensor': {
    label: 'Heartbeat sensor', category: 'Sensors', behavior: HeartbeatBehavior,
    keywords: ['heartbeat', 'pulse', 'heart rate', 'bpm', 'pulse sensor', 'health'],
    description: 'Pulses OUT once per heartbeat.',
    attrs: { bpm: '72' },
    controls: [num('bpm', 'Heart rate', 30, 200, 1, 'BPM')],
  },
  'impulse-soil-moisture': {
    label: 'Soil moisture sensor', category: 'Sensors', tag: 'impulse-sensor-module', behavior: SoilBehavior,
    keywords: ['soil', 'moisture', 'plant', 'garden', 'irrigation', 'watering', 'hygrometer', 'yl-69', 'fc-28'],
    description: 'Resistive soil probe module: AO drops as the soil gets wetter, DO goes LOW above the threshold.',
    attrs: { label: 'SOIL MOISTURE', pins: 'VCC,GND,DO,AO', icon: 'soil', moisture: '40' },
    controls: [num('moisture', 'Moisture', 0, 100, 1, '%')],
  },
  'impulse-water-level': {
    label: 'Water level sensor', category: 'Sensors', tag: 'impulse-sensor-module', behavior: AnalogOutModuleBehavior,
    keywords: ['water level', 'liquid', 'tank', 'rain', 'flood', 'depth'],
    description: 'Analog water depth sensor: SIG rises as more of the strip is under water.',
    attrs: { label: 'WATER LEVEL', pins: 'SIG,VCC,GND', icon: 'water', level: '30', out: 'SIG', unit: '%', max: '100' },
    controls: [num('level', 'Water level', 0, 100, 1, '%')],
  },
  'impulse-rain-sensor': {
    label: 'Rain sensor', category: 'Sensors', tag: 'impulse-sensor-module', behavior: SoilBehavior,
    keywords: ['rain', 'raindrop', 'weather', 'wet', 'fc-37', 'yl-83'],
    description: 'Rain plate with comparator: AO drops when wet, DO goes LOW when rain is detected.',
    attrs: { label: 'RAIN', pins: 'VCC,GND,DO,AO', icon: 'rain', moisture: '0' },
    controls: [num('moisture', 'Wetness', 0, 100, 1, '%')],
  },
  'impulse-ir-obstacle': {
    label: 'IR obstacle sensor', category: 'Sensors', tag: 'impulse-sensor-module', behavior: DigitalModuleBehavior, interactive: true,
    keywords: ['ir obstacle', 'infrared', 'avoidance', 'proximity', 'fc-51', 'object detection', 'robot'],
    description: 'Infrared reflection sensor: OUT goes LOW when an object is in front of it. Click it while running to toggle.',
    attrs: { label: 'IR OBSTACLE', pins: 'VCC,GND,OUT', icon: 'ir', activeLow: 'true', active: 'false' },
    controls: [toggle('active', 'Object detected')],
  },
  'impulse-line-sensor': {
    label: 'Line tracking sensor', category: 'Sensors', tag: 'impulse-sensor-module', behavior: DigitalModuleBehavior, interactive: true,
    keywords: ['line follower', 'line tracking', 'tcrt5000', 'black line', 'robot', 'reflective'],
    description: 'TCRT5000 module: OUT goes HIGH over a black line. Click it while running to toggle.',
    attrs: { label: 'LINE TRACKER', pins: 'VCC,GND,OUT', icon: 'ir', activeLow: 'false', active: 'false' },
    controls: [toggle('active', 'Over the black line')],
  },
  'impulse-hall-sensor': {
    label: 'Hall effect sensor', category: 'Sensors', tag: 'impulse-sensor-module', behavior: DigitalModuleBehavior, interactive: true,
    keywords: ['hall', 'magnet', 'magnetic', 'a3144', 'ky-003', 'rpm', 'reed'],
    description: 'Detects a magnet: OUT goes LOW when one is near. Click it while running to toggle.',
    attrs: { label: 'HALL SENSOR', pins: 'VCC,GND,OUT', icon: 'magnet', activeLow: 'true', active: 'false' },
    controls: [toggle('active', 'Magnet nearby')],
  },
  'impulse-touch-sensor': {
    label: 'Touch sensor (TTP223)', category: 'Sensors', tag: 'impulse-sensor-module', behavior: DigitalModuleBehavior, interactive: true,
    keywords: ['touch', 'capacitive', 'ttp223', 'touch button', 'finger'],
    description: 'Capacitive touch pad: OUT is HIGH while touched. Hold the pointer on it while running.',
    attrs: { label: 'TOUCH', pins: 'GND,VCC,OUT', icon: 'touch', activeLow: 'false', active: 'false', momentary: 'true' },
    controls: [toggle('active', 'Touched')],
  },
  'impulse-vibration-sensor': {
    label: 'Vibration sensor (SW-420)', category: 'Sensors', tag: 'impulse-sensor-module', behavior: DigitalModuleBehavior, interactive: true,
    keywords: ['vibration', 'shock', 'knock', 'sw-420', 'earthquake', 'tamper'],
    description: 'OUT goes HIGH while shaken. Click it while running.',
    attrs: { label: 'VIBRATION', pins: 'VCC,GND,OUT', icon: 'vibration', activeLow: 'false', active: 'false', momentary: 'true' },
    controls: [toggle('active', 'Vibrating')],
  },
  'impulse-generic-analog': {
    label: 'Generic analog sensor', category: 'Sensors', tag: 'impulse-sensor-module', behavior: AnalogOutModuleBehavior,
    keywords: ['generic', 'analog', 'custom sensor', 'any sensor', 'other', 'placeholder', 'voltage', 'module'],
    description: 'Stands in for any sensor with an analog output: set the voltage on OUT with the slider.',
    attrs: { label: 'ANALOG SENSOR', pins: 'VCC,GND,OUT', icon: 'wave', level: '2.5', out: 'OUT', unit: 'V', max: '5' },
    controls: [num('level', 'Output', 0, 5, 0.01, 'V'), text('label', 'Name on the board')],
  },
  'impulse-generic-digital': {
    label: 'Generic digital sensor', category: 'Sensors', tag: 'impulse-sensor-module', behavior: DigitalModuleBehavior, interactive: true,
    keywords: ['generic', 'digital', 'custom sensor', 'any sensor', 'other', 'placeholder', 'switch output', 'module'],
    description: 'Stands in for any sensor with an on/off output. Toggle OUT from the inspector or click it while running.',
    attrs: { label: 'DIGITAL SENSOR', pins: 'VCC,GND,OUT', icon: 'pulse', activeLow: 'false', active: 'false' },
    controls: [toggle('active', 'Output active'), toggle('activeLow', 'Active LOW'), text('label', 'Name on the board')],
  },
  'impulse-reed-switch': {
    label: 'Reed switch', category: 'Sensors', behavior: ReedSwitchBehavior, interactive: true,
    keywords: ['reed', 'magnetic switch', 'door sensor', 'window sensor', 'magnet'],
    description: 'Two-lead switch that closes near a magnet. Wire like a button with INPUT_PULLUP.',
    controls: [toggle('closed', 'Magnet nearby')],
  },
  'wokwi-mpu6050': {
    label: 'Accelerometer + gyro (MPU6050)', category: 'Sensors', behavior: Mpu6050Behavior,
    keywords: ['mpu6050', 'mpu-6050', 'accelerometer', 'gyroscope', 'gyro', 'imu', 'tilt', 'motion', 'gy-521', 'orientation'],
    description: '6-axis IMU on I²C (0x68, or 0x69 with AD0 HIGH). Works with Adafruit_MPU6050 and the MPU6050 library.',
    attrs: { accelX: '0', accelY: '0', accelZ: '1', rotationX: '0', rotationY: '0', rotationZ: '0', temperature: '24' },
    controls: [
      num('accelX', 'Accel X', -2, 2, 0.01, 'g'), num('accelY', 'Accel Y', -2, 2, 0.01, 'g'), num('accelZ', 'Accel Z', -2, 2, 0.01, 'g'),
      num('rotationX', 'Gyro X', -250, 250, 1, '°/s'), num('rotationY', 'Gyro Y', -250, 250, 1, '°/s'), num('rotationZ', 'Gyro Z', -250, 250, 1, '°/s'),
      num('temperature', 'Temperature', -40, 85, 0.5, '°C'),
    ],
    libraries: ['Adafruit MPU6050', 'Adafruit Unified Sensor'],
  },
  'wokwi-hx711': {
    label: 'Load cell + HX711', category: 'Sensors', behavior: Hx711Behavior,
    keywords: ['hx711', 'load cell', 'weight', 'scale', 'force', 'strain gauge', 'kg'],
    description: '24-bit ADC with a load cell. Reads ≈420 counts per gram (5 kg cell).',
    attrs: { type: '5kg', weight: '0' },
    props: [sel('type', 'Load cell', ['5kg', '50kg', 'gauge'])],
    controls: [num('weight', 'Weight', 0, 5000, 1, 'g')],
    libraries: ['HX711'],
  },
  'wokwi-ds1307': {
    label: 'Real-time clock (DS1307)', category: 'Sensors', behavior: Ds1307Behavior,
    keywords: ['rtc', 'ds1307', 'real time clock', 'clock', 'time', 'date', 'rtclib', 'ds3231', 'calendar'],
    description: 'I²C real-time clock at 0x68 that starts at your computer\'s current date and time. Works with RTClib.',
    libraries: ['RTClib'],
  },

  // ── Motors & actuators ─────────────────────────────────────────────────────
  'wokwi-servo': {
    label: 'Servo motor', category: 'Motors & actuators', behavior: ServoBehavior,
    keywords: ['servo', 'sg90', 'mg996r', 'motor', 'angle', 'rc servo', 'micro servo', 'arm'],
    description: 'Hobby servo: PWM to a pin and Servo.attach(pin); 544-2400 µs pulses turn it 0-180°.',
    props: [sel('horn', 'Horn', ['single', 'double', 'cross'])],
    libraries: ['Servo'],
    pins: { GND: 'Ground (brown)', 'V+': '5V (red)', PWM: 'Signal (orange)' },
  },
  'wokwi-stepper-motor': {
    label: 'Stepper motor (NEMA 17)', category: 'Motors & actuators', behavior: StepperBehavior,
    keywords: ['stepper', 'nema 17', 'nema17', 'bipolar', 'step motor', 'accelstepper', 'cnc', '3d printer'],
    description: 'Bipolar stepper, 200 steps per turn. Drive A+/A-/B+/B- from four pins (Stepper library) or from an A4988 driver.',
    attrs: { size: '17' },
    props: [sel('size', 'NEMA size', ['8', '11', '14', '17', '23', '34'])],
    libraries: ['Stepper', 'AccelStepper'],
  },
  'wokwi-biaxial-stepper': {
    label: 'Biaxial stepper (clock hands)', category: 'Motors & actuators', behavior: BiaxialStepperBehavior,
    keywords: ['biaxial', 'clock', 'dual stepper', 'hands', 'gauge'],
    description: 'Two concentric steppers, like clock hands.',
  },
  'impulse-stepper-28byj48': {
    label: 'Stepper 28BYJ-48 + ULN2003', category: 'Motors & actuators', behavior: Stepper28byjBehavior,
    keywords: ['28byj-48', '28byj48', '28byj', 'uln2003', 'unipolar', 'geared stepper', '5v stepper', 'small stepper', 'stepper', 'stepper kit'],
    description: 'The 5 V geared stepper from starter kits on its ULN2003 board: 2048 steps per turn. With the Stepper library use Stepper(2048, IN1, IN3, IN2, IN4).',
    libraries: ['Stepper', 'AccelStepper'],
    pins: { IN1: 'Coil A', IN2: 'Coil B', IN3: 'Coil C', IN4: 'Coil D', VCC: '5V', GND: 'Ground' },
  },
  'impulse-a4988': {
    label: 'Stepper driver (A4988)', category: 'Motors & actuators', behavior: StepperDriverBehavior,
    keywords: ['a4988', 'drv8825', 'stepper driver', 'step dir', 'accelstepper', 'pololu', 'cnc'],
    description: 'STEP pulses move the motor one step; DIR sets the direction. Tie SLEEP and RESET together. Wire 1A/1B/2A/2B to the motor coils.',
    links: () => [['GND', 'GND.2']],
    pins: { ENABLE: 'LOW = enabled', MS1: 'Microstep select', MS2: 'Microstep select', MS3: 'Microstep select', RESET: 'Active LOW', SLEEP: 'Active LOW', STEP: 'Step pulse', DIR: 'Direction', VMOT: 'Motor supply', GND: 'Ground', '2B': 'Coil 2', '2A': 'Coil 2', '1A': 'Coil 1', '1B': 'Coil 1', VDD: 'Logic 5V' },
  },
  'impulse-dc-motor': {
    label: 'DC motor', category: 'Motors & actuators', behavior: DcMotorBehavior,
    keywords: ['dc motor', 'motor', 'fan', 'wheel', 'robot car', 'toy motor', 'gear motor', 'pump', 'water pump', 'vibration motor'],
    description: 'Spins with the voltage across A and B; reverse the polarity to reverse it. Drive it through an L293D or a transistor, not straight from a pin.',
    attrs: { maxRpm: '200' },
  },
  'impulse-l293d': {
    label: 'Motor driver (L293D)', category: 'Motors & actuators', behavior: HBridgeBehavior,
    keywords: ['l293d', 'h-bridge', 'h bridge', 'motor driver', 'dual motor', 'robot car', 'sn754410'],
    description: 'Dual H-bridge: OUT1-OUT4 follow IN1-IN4 while EN1/EN2 are HIGH (PWM on EN sets the speed). VSS is logic 5V, VS the motor supply.',
    links: () => [['GND.1', 'GND.2'], ['GND.2', 'GND.3'], ['GND.3', 'GND.4']],
    pins: { EN1: 'Enable 1-2 (PWM = speed)', IN1: 'Input 1', IN2: 'Input 2', OUT1: 'Motor A', OUT2: 'Motor A', EN2: 'Enable 3-4', IN3: 'Input 3', IN4: 'Input 4', OUT3: 'Motor B', OUT4: 'Motor B', VSS: 'Logic 5V', VS: 'Motor supply' },
  },
  'impulse-l298n': {
    label: 'Motor driver (L298N)', category: 'Motors & actuators', behavior: L298nBehavior,
    keywords: ['l298n', 'l298', 'h-bridge', 'h bridge', 'motor driver', 'dual motor', 'robot car', 'dc motor driver', 'motor controller'],
    description: 'Dual H-bridge module: OUT1/OUT2 follow IN1/IN2 and OUT3/OUT4 follow IN3/IN4. Leave the ENA/ENB jumpers off and PWM those pins to set the speed.',
    pins: { ENA: 'Enable A (PWM = speed)', IN1: 'Input 1', IN2: 'Input 2', IN3: 'Input 3', IN4: 'Input 4', ENB: 'Enable B (PWM = speed)', OUT1: 'Motor A', OUT2: 'Motor A', OUT3: 'Motor B', OUT4: 'Motor B', '12V': 'Motor supply (7-12 V)', GND: 'Ground', '5V': '5V out (regulator jumper on)' },
    supplyPins: ['12V', '5V'],
  },
  'impulse-relay-module': {
    label: 'Relay module', category: 'Motors & actuators', behavior: RelayModuleBehavior,
    keywords: ['relay', 'relay module', 'switch mains', 'srd-05vdc', 'songle', 'high voltage', 'lamp', 'solenoid', 'solenoid valve', 'door lock'],
    description: '5 V relay module: IN HIGH closes COM↔NO (set "Trigger" to LOW for active-low boards).',
    attrs: { trigger: 'high' },
    props: [sel('trigger', 'Trigger', ['high', 'low'])],
  },
  'wokwi-ks2e-m-dc5': {
    label: 'Relay (DPDT, KS2E)', category: 'Motors & actuators', behavior: RelayBehavior,
    keywords: ['relay', 'dpdt', 'ks2e', 'coil', 'bare relay'],
    description: 'Bare DPDT relay: energizing the coil (COIL1/COIL2) switches P1/P2 from NC to NO.',
  },

  // ── Logic & power ──────────────────────────────────────────────────────────
  'impulse-74hc595': {
    label: 'Shift register (74HC595)', category: 'Logic & power', behavior: ShiftRegisterBehavior,
    keywords: ['74hc595', '595', 'shift register', 'shiftout', 'serial to parallel', 'port expander', 'more outputs'],
    description: '8 more outputs from 3 pins: DS (data), SHCP (clock), STCP (latch). Chain chips with Q7S → DS. Tie MR to 5V and OE to GND.',
    pins: { Q0: 'Output 0', Q1: 'Output 1', Q2: 'Output 2', Q3: 'Output 3', Q4: 'Output 4', Q5: 'Output 5', Q6: 'Output 6', Q7: 'Output 7', DS: 'Serial data in', SHCP: 'Shift clock', STCP: 'Latch (storage) clock', OE: 'Output enable (LOW)', MR: 'Reset (LOW)', Q7S: 'Serial out (to next DS)', VCC: '5V', GND: 'Ground' },
  },
  'impulse-npn-transistor': {
    label: 'NPN transistor (2N2222)', category: 'Logic & power', behavior: TransistorBehavior,
    keywords: ['transistor', 'npn', '2n2222', 'bc547', 'switch', 'driver', 'amplifier', 'tip120'],
    description: 'Switches a load from a pin: base through 1 kΩ to the pin, emitter to GND, load between 5V and collector.',
    pins: { E: 'Emitter', B: 'Base', C: 'Collector' },
  },
  'impulse-mosfet': {
    label: 'N-channel MOSFET', category: 'Logic & power', behavior: MosfetBehavior,
    keywords: ['mosfet', 'irlz44n', 'irf520', 'irf540', 'irf540n', 'n-channel', 'power switch', 'led strip driver', 'motor switch', 'logic level', 'transistor', 'fet'],
    description: 'Switches heavy loads: gate to a pin (10 kΩ gate-to-GND keeps it off at reset), source to GND, load between the supply and the drain. The IRLZ44N turns fully on at 5 V; the IRF520/IRF540N need about 4 V.',
    attrs: { label: 'IRLZ44N' },
    props: [sel('label', 'Model', ['IRLZ44N', 'IRF520', 'IRF540N'])],
    pins: { G: 'Gate', D: 'Drain', S: 'Source' },
  },
  'impulse-diode': {
    label: 'Diode', category: 'Logic & power', behavior: DiodeBehavior,
    keywords: ['diode', '1n4007', '1n4001', '1n4148', 'rectifier', 'flyback', 'freewheeling', 'reverse polarity', 'schottky', 'protection'],
    description: 'Lets current flow from A (anode) to C (cathode, the band side) only. Put one across a relay or motor coil, band towards +, to absorb the voltage kick.',
    attrs: { type: '1N4007' },
    props: [sel('type', 'Type', ['1N4007', '1N4148'])],
    pins: { A: 'Anode', C: 'Cathode (band)' },
  },
  'impulse-capacitor': {
    label: 'Capacitor', category: 'Logic & power', behavior: CapacitorBehavior,
    keywords: ['capacitor', 'cap', 'electrolytic', 'ceramic', '100nf', '10uf', '100uf', 'decoupling', 'filter', 'smoothing', 'bypass', 'rc', 'rc filter', 'low pass', 'debounce', 'timing', 'charge'],
    description: 'Stores charge: with a resistor it sets a time (RC = seconds when ohms × farads), smooths PWM into a steady voltage, or debounces a button. The simulator charges and discharges it in real time. Electrolytics have a + lead (1).',
    attrs: { type: 'ceramic', value: '100nF' },
    props: [sel('type', 'Type', ['ceramic', 'electrolytic']), text('value', 'Value')],
    capacitors: (attrs) => [['1', '2', parseCapacitance(attrs.value)]],
    pins: { 1: 'Lead 1 (+ on electrolytic)', 2: 'Lead 2' },
  },
  'impulse-battery': {
    label: 'Battery', category: 'Logic & power', behavior: BatteryBehavior,
    keywords: ['battery', '9v', '9v battery', 'aa', 'aa battery', 'battery pack', 'power supply', 'li-ion', 'lipo', '18650', 'cell', 'coin cell', 'cr2032', '12v', 'external power', 'power'],
    description: 'A battery or battery pack: + sits at its voltage above −. Wire − to the Arduino GND to share a ground. Never feed more than 5 V into an Arduino pin.',
    attrs: { voltage: '9' },
    props: [sel('voltage', 'Voltage', ['3', '3.7', '4.5', '6', '9', '12'])],
    pins: { '+': 'Positive terminal', '-': 'Negative terminal' },
  },
  'impulse-gate-and': {
    label: 'AND gate', category: 'Logic & power', behavior: AndGateBehavior,
    keywords: ['and', 'and gate', '74hc08', '7408', 'logic gate', 'gate', 'digital logic', 'boolean'],
    description: 'Y is HIGH only when A and B are both HIGH. A 74HC08 chip holds four.',
    pins: { A: 'Input A', B: 'Input B', Y: 'Output' },
  },
  'impulse-gate-or': {
    label: 'OR gate', category: 'Logic & power', behavior: OrGateBehavior,
    keywords: ['or', 'or gate', '74hc32', '7432', 'logic gate', 'gate', 'digital logic', 'boolean'],
    description: 'Y is HIGH when A or B (or both) is HIGH. A 74HC32 chip holds four.',
    pins: { A: 'Input A', B: 'Input B', Y: 'Output' },
  },
  'impulse-gate-not': {
    label: 'NOT gate (inverter)', category: 'Logic & power', behavior: NotGateBehavior,
    keywords: ['not', 'not gate', 'inverter', '74hc04', '7404', '74hc14', 'logic gate', 'gate', 'digital logic', 'boolean'],
    description: 'Y is the opposite of A. A 74HC04 chip holds six.',
    pins: { A: 'Input A', Y: 'Output' },
  },
  'impulse-gate-nand': {
    label: 'NAND gate', category: 'Logic & power', behavior: NandGateBehavior,
    keywords: ['nand', 'nand gate', '74hc00', '7400', 'logic gate', 'gate', 'digital logic', 'boolean'],
    description: 'Y is LOW only when A and B are both HIGH. A 74HC00 chip holds four.',
    pins: { A: 'Input A', B: 'Input B', Y: 'Output' },
  },
  'impulse-gate-nor': {
    label: 'NOR gate', category: 'Logic & power', behavior: NorGateBehavior,
    keywords: ['nor', 'nor gate', '74hc02', '7402', 'logic gate', 'gate', 'digital logic', 'boolean'],
    description: 'Y is HIGH only when A and B are both LOW. A 74HC02 chip holds four.',
    pins: { A: 'Input A', B: 'Input B', Y: 'Output' },
  },
  'impulse-gate-xor': {
    label: 'XOR gate', category: 'Logic & power', behavior: XorGateBehavior,
    keywords: ['xor', 'xor gate', 'exclusive or', '74hc86', '7486', 'logic gate', 'gate', 'digital logic', 'boolean'],
    description: 'Y is HIGH when A and B differ. A 74HC86 chip holds four.',
    pins: { A: 'Input A', B: 'Input B', Y: 'Output' },
  },
  'impulse-flipflop-d': {
    label: 'D flip-flop', category: 'Logic & power', behavior: FlipFlopDBehavior,
    keywords: ['flip flop', 'flip-flop', 'flipflop', 'd flip flop', 'dff', 'latch', '74hc74', '7474', 'register', 'memory bit', 'sequential logic', 'logic gate'],
    description: 'On every rising CLK edge Q copies D, and Q̄ is its opposite. A 74HC74 chip holds two.',
    pins: { D: 'Data', CLK: 'Clock (rising edge)', Q: 'Output', QN: 'Inverted output' },
  },
};

/** "100nF", "10uF", "4.7µF", "22pF", "1mF", "0.1u" → farads (100 nF when unreadable). */
export function parseCapacitance(value) {
  const m = /^\s*([\d.]+)\s*([pnuµm]?)/i.exec(String(value ?? ''));
  if (!m) return 100e-9;
  const scale = { p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3 }[m[2].toLowerCase()] ?? 1;
  const f = parseFloat(m[1]) * scale;
  return f > 0 && f < 10 ? f : 100e-9;
}

/** "220", "4.7k", "10K", "1M", "330Ω" → ohms. */
export function parseResistance(value) {
  const m = /^\s*([\d.]+)\s*([kKmM]?)/.exec(String(value ?? ''));
  if (!m) return 220;
  const n = parseFloat(m[1]);
  const mult = m[2] === 'k' || m[2] === 'K' ? 1e3 : m[2] === 'M' || m[2] === 'm' ? 1e6 : 1;
  return n * mult > 0 ? n * mult : 220;
}

export const PARTS = {};
for (const [type, def] of Object.entries(defs)) {
  const table = PART_PINS[type];
  PARTS[type] = {
    type,
    tag: def.tag || type,
    attrs: {},
    pinNames: table ? () => table.pins : () => [],
    size: table ? { w: table.w, h: table.h } : null,
    ...def,
  };
  PARTS[type].defaultAttrs = PARTS[type].attrs; // older callers
}

const ALIASES = new Map();
for (const [type, def] of Object.entries(PARTS)) for (const a of def.aliases || []) ALIASES.set(a, type);

/** Part definition by type (Wokwi aliases resolve to their Impulse part). */
export function partDef(type) {
  return PARTS[type] || PARTS[ALIASES.get(type)] || null;
}

/** Canonical catalog type for a diagram part type, or null when unknown. */
export function resolvePartType(type, attrs = {}) {
  if (PARTS[type] && !PARTS[type].saveAs) {
    // Saved variants share a Wokwi type; pick the variant from attrs.
    if (type === 'wokwi-lcd1602' && attrs.pins !== 'i2c') return 'wokwi-lcd1602-parallel';
    if (type === 'wokwi-lcd2004' && attrs.pins !== 'i2c') return 'wokwi-lcd2004-parallel';
    if (type === 'wokwi-7segment' && Number(attrs.digits) > 1) return 'wokwi-7segment-4';
    if (type === 'wokwi-membrane-keypad' && String(attrs.columns) === '3') return 'wokwi-membrane-keypad-3';
    if (type === 'wokwi-dht22' && attrs.model === 'dht11') return 'wokwi-dht11';
    return type;
  }
  if (PARTS[type]) return type;
  return ALIASES.get(type) || null;
}

/** Type written to diagram.json (variants share their Wokwi type). */
export function savedType(type) {
  return PARTS[type]?.saveAs || type;
}

export const BOARD_TYPES = Object.values(PARTS).filter(p => p.board).map(p => p.type);

/** Short summary of every part for the AI circuit builder. */
export function catalogForAi() {
  return Object.values(PARTS).map((p) => ({
    type: p.type,
    label: p.label,
    category: p.category,
    attrs: p.attrs,
    pins: p.pins || null,
    description: p.description,
  }));
}
