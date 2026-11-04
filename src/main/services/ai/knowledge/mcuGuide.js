/**
 * What an embedded developer knows about each microcontroller family: the
 * electrical limits, the pins to avoid, how the ADC, PWM, timers and USB
 * Serial behave, the core APIs that changed, and the mistakes people make.
 * The board-specific numbers (which pin is LED_BUILTIN…) come from the
 * installed core instead (boardKnowledge.js); this is the part a core's files
 * don't say. Facts are kept to what the datasheets and the cores' own
 * documentation state.
 */

/** Rules that hold on every board. */
const GENERAL = {
  id: 'general',
  title: 'Embedded fundamentals (every board)',
  facts: [
    'Never drive motors, relays, solenoids or long LED strips from a GPIO: use a transistor/MOSFET or a driver module, a separate supply, a flyback diode across inductive loads, and a common ground.',
    'Every LED needs a series resistor: R = (Vsupply − Vforward) / I. About 220–330 Ω at 5 V and 68–150 Ω at 3.3 V for a typical 10–15 mA indicator.',
    'Never feed a 5 V signal into a 3.3 V-only pin. Use a voltage divider (e.g. 1 kΩ / 2 kΩ) for slow signals, or a level shifter (BSS138 boards, 74AHCT125 for fast data like NeoPixels).',
    'Inputs must never float: use INPUT_PULLUP (button to GND, reads LOW when pressed) or an external pull-up/pull-down (10 kΩ).',
    'Debounce mechanical buttons (20–50 ms with millis(), or a library such as Bounce2).',
    'Prefer non-blocking timing with millis() over delay() so the loop can read inputs while waiting. Compare with subtraction (millis() - last >= interval) so it survives the ~49-day rollover.',
    'Variables shared with an interrupt handler must be volatile; keep ISRs short (no Serial printing, no delay()), and read multi-byte shared values with interrupts disabled on 8-bit chips.',
    'I2C needs pull-ups on SDA and SCL (4.7 kΩ typical; most modules include them). Two devices with the same address can\'t share a bus. Run an I2C scanner sketch when a device doesn\'t answer.',
    'SPI devices share MOSI/MISO/SCK; each needs its own chip-select (CS/SS) pin, held HIGH when not in use.',
    'The Serial Monitor baud must match Serial.begin(). Garbled text almost always means a baud mismatch.',
    'Servos and motors cause supply dips that reset boards (brownouts): power them separately and add a large capacitor (e.g. 470–1000 µF) across their supply.',
    'Measure a voltage higher than the ADC reference with a divider: Vin = Vadc × (R1 + R2) / R2. Mind the ADC input impedance (keep divider resistance ≤ ~10 kΩ on AVR, or add a capacitor).',
    'Use the board\'s named constants (LED_BUILTIN, SDA, SCL, A0…) instead of hard-coded numbers: they are correct for the board selected.',
  ],
};

/**
 * Families. `match` finds a family from build properties: mcu, the platform
 * (vendor:arch) or the board id.
 */
const FAMILIES = [
  {
    id: 'avr-atmega328p',
    logic: '5 V logic (3.3 V on 8 MHz Pro Mini / LilyPad)',
    title: 'ATmega328P / ATmega168 (classic AVR: Uno R3, Nano, Pro Mini, Mini, Duemilanove, Fio, LilyPad)',
    match: { mcu: /^atmega(328p?|328pb|168p?a?|168)$/i },
    facts: [
      '8-bit AVR. 16 MHz on 5 V boards; 8 MHz on 3.3 V Pro Mini / LilyPad variants.',
      'ATmega328P: 32 KB flash (Uno keeps 0.5 KB for the Optiboot bootloader), 2 KB SRAM, 1 KB EEPROM. ATmega168: 16 KB flash, 1 KB SRAM, 512 B EEPROM.',
      'Logic level = supply (5 V on Uno/Nano). Pins may not see more than Vcc + 0.5 V.',
      'Pin current: 20 mA recommended, 40 mA absolute maximum per pin, about 200 mA for the whole chip.',
      'ADC: 10-bit (0–1023), reference AVCC by default; analogReference(INTERNAL) = 1.1 V. On Nano/Pro Mini, A6 and A7 are analog inputs only (no digitalRead/digitalWrite, no pull-up).',
      'PWM (analogWrite): pins 3, 5, 6, 9, 10, 11. About 490 Hz, except 5 and 6 at about 980 Hz.',
      'External interrupts: pins 2 and 3 only (attachInterrupt(digitalPinToInterrupt(2), …)). Pin-change interrupts exist on every pin (PinChangeInterrupt library).',
      'I2C: A4 = SDA, A5 = SCL. SPI: 10 SS, 11 MOSI, 12 MISO, 13 SCK. Serial: 0 RX, 1 TX, shared with the USB-serial chip.',
      'Timer0 runs millis()/delay() and PWM on 5/6; Timer1 (16-bit) is taken by the Servo library, which disables PWM on 9 and 10; Timer2 is used by tone() (disables PWM on 3 and 11) and by IRremote.',
      'There is no internal pull-down resistor, only INPUT_PULLUP.',
      'int is 16-bit (−32768…32767): store millis() in unsigned long. double is the same 32-bit float as float.',
    ],
    pitfalls: [
      '2 KB of RAM runs out fast: wrap string literals in F("…") inside Serial.print, avoid String concatenation in loops (heap fragmentation), put large tables in PROGMEM. Running out shows up as random resets or garbage.',
      'Don\'t use pins 0 and 1 for other things while using Serial (and disconnect anything on pin 0 while uploading).',
      'On the Uno, pin 13 carries the LED and its resistor, which loads pin 13 when used as an input.',
      'Clone boards with a CH340 USB chip may need its driver on older systems; clone Nanos often need Tools › Processor › ATmega328P (Old Bootloader) to upload.',
      'EEPROM cells last about 100,000 writes: use EEPROM.update()/put(), never write in a fast loop.',
    ],
  },
  {
    id: 'avr-atmega2560',
    logic: '5 V logic',
    title: 'ATmega2560 / ATmega1280 (Mega 2560, Mega ADK, Mega 1280)',
    match: { mcu: /^atmega(2560|1280)$/i },
    facts: [
      '8-bit AVR at 16 MHz, 5 V. ATmega2560: 256 KB flash, 8 KB SRAM, 4 KB EEPROM (ATmega1280: 128 KB flash).',
      '54 digital pins, 15 PWM pins (2–13 and 44–46), 16 analog inputs (A0–A15).',
      'Four hardware serial ports: Serial (0 RX / 1 TX, USB), Serial1 (19 RX / 18 TX), Serial2 (17 RX / 16 TX), Serial3 (15 RX / 14 TX). Prefer these over SoftwareSerial.',
      'I2C: 20 = SDA, 21 = SCL (not A4/A5 as on the Uno). SPI: 50 MISO, 51 MOSI, 52 SCK, 53 SS (keep 53 an OUTPUT for SPI master mode).',
      'External interrupts: 2, 3, 18, 19, 20, 21.',
      'Pin limits as the ATmega328P: 20 mA recommended / 40 mA absolute maximum per pin.',
      'The Servo library uses Timer5 first, which disables PWM on 44, 45 and 46.',
    ],
    pitfalls: [
      'Uno shields that use A4/A5 for I2C need jumpers to 20/21 (or use the SDA/SCL header next to AREF).',
      'SoftwareSerial on the Mega only receives on pins that support pin-change interrupts (10–15, 50–53, A8–A15).',
    ],
  },
  {
    id: 'avr-atmega32u4',
    logic: '5 V logic (3.3 V on the 8 MHz Pro Micro)',
    title: 'ATmega32U4 (Leonardo, Micro, Pro Micro, Esplora, Yún, LilyPad USB)',
    match: { mcu: /^atmega32u4$/i },
    facts: [
      '8-bit AVR with built-in USB, 16 MHz (8 MHz on 3.3 V Pro Micro). 32 KB flash (4 KB used by the bootloader), 2.5 KB SRAM, 1 KB EEPROM.',
      'Serial is the USB connection; Serial1 is the hardware UART on pins 0 (RX) and 1 (TX).',
      'I2C is on pins 2 (SDA) and 3 (SCL), not A4/A5. On the Leonardo, SPI is only on the ICSP header.',
      'External interrupts on pins 0, 1, 2, 3 and 7.',
      'PWM on 3, 5, 6, 9, 10, 11 and 13.',
      'Can act as a USB keyboard or mouse with the Keyboard and Mouse libraries.',
    ],
    pitfalls: [
      'while (!Serial); waits for the Serial Monitor to open: a sketch with it never runs on battery or USB power without a computer. Use it only for debugging, or add a timeout.',
      'Output printed before the Serial Monitor connects is lost, because Serial is USB.',
      'A sketch that crashes the USB stack makes the port disappear: press reset (twice on some boards) just as the upload starts to reach the bootloader.',
    ],
  },
  {
    id: 'megaavr-atmega4809',
    logic: '5 V logic',
    title: 'ATmega4809 (megaAVR 0-series: Nano Every, Uno WiFi Rev2)',
    match: { mcu: /^atmega4809$/i, platform: /:megaavr$/ },
    facts: [
      '8-bit AVR of the newer 0-series: 48 KB flash, 6 KB SRAM, 256 B EEPROM, 5 V. The Nano Every runs it at 16 MHz by default (20 MHz possible).',
      'Its peripherals and registers are completely different from the ATmega328P (PORTx.OUT, VPORTx, TCA/TCB timers, a new USART).',
      'On the Nano Every, Serial is USB (through a SAMD11 bridge) and Serial1 is pins 0/1.',
    ],
    pitfalls: [
      'Code written for Uno registers (PORTB, DDRB, TCCR1A, OCR1A…) and libraries that program Uno timers directly (TimerOne, older IR and LED-matrix libraries) don\'t work. The board menu\'s "Registers emulation: ATMEGA328" helps only with simple port writes.',
    ],
  },
  {
    id: 'attiny-x5',
    logic: 'logic at the supply voltage (2.7–5.5 V)',
    title: 'ATtiny25 / 45 / 85 (8-pin, ATTinyCore or Digispark)',
    match: { mcu: /^attiny(25|45|85)$/i },
    facts: [
      '8-pin AVR, 2.7–5.5 V. 2/4/8 KB flash, 128/256/512 B SRAM. Pins PB0–PB5; PB5 is RESET (using it as I/O needs a fuse change that stops ISP programming).',
      'No hardware UART: ATTinyCore provides a software Serial (TX on PB0, RX on PB1 by default, half duplex).',
      'The USI does I2C (SDA PB0, SCL PB2) and SPI; ATTinyCore\'s Wire works on it.',
      'PWM on PB0, PB1 and PB4. ADC channels: A0 = PB5, A1 = PB2, A2 = PB4, A3 = PB3.',
      'Clock: internal 1 or 8 MHz, or 16 MHz from the PLL; the clock is set by fuses with Tools › Burn Bootloader.',
    ],
    pitfalls: [
      'Programming needs an ISP programmer (an Arduino running ArduinoISP works) unless it has a Micronucleus/Digispark USB bootloader.',
      'After changing the clock option, run Burn Bootloader once, or delays run 8× too slow or too fast.',
      'Software Serial and I2C share PB0: you can\'t use both at once.',
    ],
  },
  {
    id: 'attiny-modern',
    logic: 'logic at the supply voltage (1.8–5.5 V)',
    title: 'tinyAVR 0/1/2-series (ATtiny 412, 1614, 3216…, megaTinyCore)',
    match: { mcu: /^attiny(2|4|8|16|32)(0[2-7]|1[2-7]|2[2-7])$/i, platform: /megaTinyCore/i },
    facts: [
      'Newer AVR family with the same peripheral style as the ATmega4809, programmed over the single-pin UPDI interface (a serial adapter with a resistor, or a dedicated UPDI programmer).',
      'Has real hardware UART, I2C (TWI) and SPI; register-level code for classic ATtiny/ATmega doesn\'t apply.',
    ],
    pitfalls: ['These chips are not programmed with ISP; use the board menu\'s UPDI programmer option.'],
  },
  {
    id: 'samd21',
    logic: '3.3 V logic, NOT 5 V tolerant',
    title: 'SAMD21 (Arduino Zero, MKR family, Nano 33 IoT, Seeed XIAO SAMD21, Adafruit M0)',
    match: { platform: /:samd$/i, board: /SAMD_|ZERO|MKR|NANO_33_IOT|XIAO_M0|_M0\b|_M0_/i },
    facts: [
      'ARM Cortex-M0+ at 48 MHz, 256 KB flash, 32 KB SRAM. 3.3 V logic and NOT 5 V tolerant.',
      'About 7 mA per pin is the safe limit; drive anything bigger through a transistor.',
      'ADC up to 12-bit: call analogReadResolution(12) (the default is 10-bit for compatibility). True 10-bit DAC on A0 (analogWrite(A0, value)).',
      'Serial is the native USB port (SerialUSB on some cores); Serial1 is the hardware UART on pins 0/1.',
      'Interrupts on most pins. Extra UART/I2C/SPI ports can be made from SERCOM peripherals.',
      'Nano 33 IoT: Wi-Fi and BLE come from a NINA-W102 module (WiFiNINA and ArduinoBLE libraries); its 5 V pin is off unless the VUSB jumper is bridged.',
    ],
    pitfalls: [
      'There is no EEPROM: use the FlashStorage library (flash wears out, so save rarely).',
      'Double-tap reset to enter the bootloader when the USB port disappears.',
      'Output printed before the Serial Monitor connects is lost (USB Serial).',
    ],
  },
  {
    id: 'samd51',
    logic: '3.3 V logic, NOT 5 V tolerant',
    title: 'SAMD51 (Adafruit M4 boards, Seeed Wio Terminal)',
    match: { board: /SAMD51|_M4\b|_M4_|WIO_TERMINAL|GRAND_CENTRAL/i },
    facts: [
      'ARM Cortex-M4F at 120 MHz with a floating-point unit, 3.3 V logic, not 5 V tolerant.',
      '12-bit ADC and two 12-bit DACs (A0, A1). Native USB Serial.',
    ],
    pitfalls: ['No EEPROM; use flash storage libraries. Never apply 5 V to a pin.'],
  },
  {
    id: 'renesas-ra4m1',
    logic: '5 V logic, 8 mA per pin max',
    title: 'Renesas RA4M1 (Arduino UNO R4 Minima, UNO R4 WiFi)',
    match: { platform: /:renesas_uno$/i, board: /UNOR4|MINIMA/i },
    facts: [
      'Arm Cortex-M4 at 48 MHz with FPU, 256 KB flash, 32 KB SRAM, 8 KB data flash (used by the EEPROM library). The board runs at 5 V logic like the Uno R3.',
      'Keep each pin under 8 mA: this is much less than the Uno R3\'s 20 mA. Drive LEDs gently and anything bigger through a transistor.',
      'ADC up to 14-bit (analogReadResolution(14)); a 12-bit DAC on A0 (analogWrite(DAC, value)); an op-amp on A1–A3; CAN bus on D4/D5 (needs an external transceiver).',
      'Serial is the USB-C port; Serial1 is pins 0/1. It can act as a USB keyboard/mouse.',
      'UNO R4 WiFi: an ESP32-S3 module provides Wi-Fi and BLE (WiFiS3 and ArduinoBLE libraries), plus a 12×8 red LED matrix (Arduino_LED_Matrix library) and a Qwiic connector that is Wire1 at 3.3 V.',
    ],
    pitfalls: [
      'AVR-specific code does not work: direct port registers (PORTB, DDRB), avr/ headers, AVR timer registers, and libraries built on them.',
      'Libraries must support the renesas_uno architecture; check before using older AVR-only libraries.',
    ],
  },
  {
    id: 'nrf52840',
    logic: '3.3 V logic, NOT 5 V tolerant',
    title: 'nRF52840 (Nano 33 BLE / BLE Sense, Seeed XIAO nRF52840, Adafruit Feather nRF52840)',
    match: { mcu: /nrf52840/i, platform: /:(mbed_nano|nrf52|mbed)$/i, board: /NANO33BLE|NRF52840|XIAO_NRF52840/i },
    facts: [
      'Arm Cortex-M4F at 64 MHz, 1 MB flash, 256 KB SRAM, Bluetooth LE 5. 3.3 V logic and NOT 5 V tolerant.',
      'Nano 33 BLE: BLE through the ArduinoBLE library; the RGB LED pins LEDR/LEDG/LEDB and LED_PWR are active-LOW. The 5 V pin is off unless its jumper is bridged.',
      'Serial is USB; Serial1 is pins 0/1. The 12-bit ADC uses an internal reference.',
      'Adafruit/Seeed boards use the Bluefruit (Adafruit nRF52) core with a different BLE API than ArduinoBLE.',
    ],
    pitfalls: ['Never connect 5 V signals. Sensors on the Nano 33 BLE Sense need their own libraries per board revision (Rev2 changed several sensors).'],
  },
  {
    id: 'rp2040',
    logic: '3.3 V logic, NOT 5 V tolerant',
    title: 'RP2040 (Raspberry Pi Pico / Pico W, XIAO RP2040, Feather RP2040, Nano RP2040 Connect)',
    match: { mcu: /^rp2040$/i, chip: /^rp2040$/i, board: /RASPBERRY_PI_PICO|RP2040/i },
    facts: [
      'Dual Arm Cortex-M0+ (133 MHz by default in Arduino-Pico), 264 KB SRAM, external QSPI flash (2 MB on the Pico). 3.3 V logic and NOT 5 V tolerant.',
      'Keep each pin at about 4–12 mA (configurable drive strength).',
      'ADC: 12-bit on GP26, GP27, GP28 (A0–A2); on the Pico, GP29 (A3) measures VSYS/3. analogReadResolution(12) for full resolution.',
      'PWM on every GPIO, but pins on the same PWM slice share a frequency.',
      'Serial is USB; Serial1 = UART0 (GP0 TX / GP1 RX by default), Serial2 = UART1. Wire = I2C0 (GP4 SDA / GP5 SCL by default); SPI = SPI0 (GP16 MISO, GP17 CS, GP18 SCK, GP19 MOSI). Most peripherals can be moved to other pins (Wire.setSDA/setSCL, Serial1.setTX/setRX).',
      'PIO state machines can implement extra protocols (WS2812, extra UARTs).',
      'Arduino-Pico (rp2040:rp2040) runs setup1()/loop1() on the second core. Arduino\'s own Mbed core (arduino:mbed_rp2040, arduino:mbed_nano) is a different core with different APIs and libraries.',
      'Upload: hold BOOTSEL while plugging in to get the RPI-RP2 drive.',
    ],
    pitfalls: [
      'There is no real EEPROM: the EEPROM library emulates it in flash and needs EEPROM.begin(size) and EEPROM.commit().',
      'Pico W: the LED is on the Wi-Fi chip; LED_BUILTIN works through the core, but a raw GPIO25 does not.',
      'Output printed before the Serial Monitor connects is lost (USB Serial): add a short wait (e.g. while (!Serial && millis() < 3000);) for debugging.',
    ],
  },
  {
    id: 'rp2350',
    logic: '3.3 V logic (GPIOs 5 V tolerant while powered)',
    title: 'RP2350 (Raspberry Pi Pico 2 / Pico 2 W and other RP2350 boards)',
    match: { mcu: /^rp2350/i, chip: /^rp2350/i, board: /RP2350|PICO2/i },
    facts: [
      'Dual Arm Cortex-M33 (or Hazard3 RISC-V) at 150 MHz, 520 KB SRAM, 4 MB flash on the Pico 2. 3.3 V supply; its GPIOs are 5 V tolerant while the chip is powered.',
      'Same programming model as the RP2040 in Arduino-Pico (Serial is USB, Serial1 = UART0, PIO, setup1/loop1).',
    ],
    pitfalls: [
      'Erratum RP2350-E9 (A2 stepping): an input using the internal pull-down can latch HIGH. Use an external pull-down (8.2 kΩ or less) where it matters.',
    ],
  },
  {
    id: 'esp32',
    logic: '3.3 V logic, NOT 5 V tolerant',
    title: 'ESP32 (original: ESP32-WROOM/WROVER, DevKitC, NodeMCU-32S, Wemos D1 R32)',
    match: { mcu: /^esp32$/i },
    facts: [
      'Dual-core Xtensa LX6 at 240 MHz, 520 KB SRAM, usually 4 MB flash. Wi-Fi + Bluetooth Classic + BLE. 3.3 V logic and NOT 5 V tolerant.',
      'Keep each pin at about 20 mA (40 mA absolute maximum).',
      'GPIO 34–39 are input-only and have no internal pull-ups or pull-downs.',
      'GPIO 6–11 are wired to the flash chip: never use them.',
      'Strapping pins 0, 2, 5, 12, 15 set the boot mode: avoid driving them at reset. GPIO12 pulled HIGH at boot selects 1.8 V flash and stops the board booting.',
      'ADC: 12-bit; ADC1 = GPIO 32–39, ADC2 = GPIO 0, 2, 4, 12–15, 25–27. ADC2 cannot be used while Wi-Fi is on: use ADC1 pins for analog with Wi-Fi. Readings are non-linear near 0 V and 3.3 V.',
      'DAC: 8-bit on GPIO 25 and 26 (dacWrite). Touch sensing on T0–T9.',
      'Default pins: I2C SDA 21 / SCL 22; SPI (VSPI) MOSI 23, MISO 19, SCK 18, SS 5; Serial = UART0 on GPIO1 TX / GPIO3 RX through the USB-serial chip.',
      'Many ESP32 dev boards have no user LED (only power); some have one on GPIO2.',
    ],
    pitfalls: [
      'Interrupt handlers need IRAM_ATTR. A loop that never yields while other tasks run can trip the watchdog.',
      'Starting Wi-Fi draws current spikes that brown out weak USB supplies ("Brownout detector was triggered"): use a better cable/supply or a capacitor on 3.3 V.',
      'Prefer the Preferences library over EEPROM for saved settings.',
      'Servo: use the ESP32Servo library (the AVR Servo library does not run on ESP32).',
    ],
  },
  {
    id: 'esp32-s2',
    logic: '3.3 V logic, NOT 5 V tolerant',
    title: 'ESP32-S2',
    match: { mcu: /^esp32s2$/i },
    facts: [
      'Single-core Xtensa LX7 at 240 MHz, 320 KB SRAM. Wi-Fi only (no Bluetooth). Native USB (OTG). 3.3 V, NOT 5 V tolerant.',
      'Two 8-bit DACs on GPIO17 and GPIO18. Touch sensing on GPIO1–14.',
      'Serial goes to the native USB port only when USB CDC On Boot is enabled; otherwise Serial is UART0.',
    ],
    pitfalls: ['No Bluetooth at all: BLE code won\'t compile for the S2.'],
  },
  {
    id: 'esp32-s3',
    logic: '3.3 V logic, NOT 5 V tolerant',
    title: 'ESP32-S3 (DevKitC-1, Nano ESP32, XIAO ESP32S3, many N8R8/N16R8 boards)',
    match: { mcu: /^esp32s3$/i },
    facts: [
      'Dual-core Xtensa LX7 at 240 MHz, 512 KB SRAM, optional PSRAM. Wi-Fi + Bluetooth LE 5 (no Bluetooth Classic). Native USB. 3.3 V logic and NOT 5 V tolerant.',
      'No DAC. Touch sensing on GPIO1–14. ADC1 = GPIO1–10, ADC2 = GPIO11–20 (ADC2 can\'t be used while Wi-Fi is on).',
      'Strapping pins: GPIO0 (BOOT button), 3, 45, 46. GPIO19/20 are USB D−/D+.',
      'GPIO26–32 are used by the flash on most modules; on modules with octal PSRAM (N8R8, N16R8) GPIO33–37 are taken too.',
      'PSRAM must match the module: Tools › PSRAM = "OPI PSRAM" for N8R8/N16R8 modules, "QSPI" for quad PSRAM, "Disabled" when there is none. The wrong setting can stop the board booting.',
      'ESP32-S3-DevKitC-1: an RGB LED (WS2812) on GPIO48 (GPIO38 on board v1.1), driven by neopixelWrite() (core 2.x) or rgbLedWrite() (core 3.x) with RGB_BUILTIN. It has two USB ports: "UART" (USB-serial chip, UART0 on GPIO43/44) and "USB" (the chip\'s native USB).',
      'On the native USB port, Serial is the chip\'s USB CDC: the port re-enumerates after every reset, upload and deep-sleep wake, and the monitor reconnects 1–2 s later, so the first prints are lost unless the sketch waits (delay(2000) before printing; while(!Serial) returns too early). Deep sleep with a 5 s wake therefore shows only lines printed late in the awake time.',
      'Touch pads T1–T14 are GPIO1–14; touchRead() returns values around 20,000–30,000 that RISE when touched (the classic ESP32\'s fall). temperatureRead() gives the die temperature in °C. LEDC PWM on any output pin with ledcAttach(pin, freq, bits); the S3 has no DAC.',
      'Serial follows "USB CDC On Boot": enabled = Serial is the native USB port; disabled = Serial is UART0 (GPIO43 TX / GPIO44 RX). Impulse turns it on automatically when the board is on its native USB port.',
      'Default I2C: SDA 8 / SCL 9 (DevKit variant; other boards differ, check get_board_info).',
    ],
    pitfalls: [
      'With USB CDC On Boot enabled, output printed before the Serial Monitor connects is lost.',
      'If uploading fails on the native USB port, hold BOOT, press RESET, release BOOT (download mode), then upload.',
    ],
  },
  {
    id: 'esp32-c3',
    logic: '3.3 V logic, NOT 5 V tolerant',
    title: 'ESP32-C3 (C3 DevKitM, XIAO ESP32C3, "C3 SuperMini")',
    match: { mcu: /^esp32c3$/i },
    facts: [
      'Single-core RISC-V at 160 MHz, 400 KB SRAM, Wi-Fi + BLE 5, built-in USB Serial/JTAG. 3.3 V, NOT 5 V tolerant.',
      'GPIO0–21. Strapping pins GPIO2, 8 and 9 (GPIO9 is the BOOT button). GPIO12–17 connect to flash on most modules. GPIO18/19 are USB D−/D+.',
      'ADC1 on GPIO0–4 (ADC2 on GPIO5 is not recommended). No DAC, no touch.',
      'Serial goes to the USB port only with USB CDC On Boot enabled.',
    ],
    pitfalls: ['Cheap C3 SuperMini boards have the LED on GPIO8, active-LOW, and weak antennas.'],
  },
  {
    id: 'esp32-c6',
    logic: '3.3 V logic, NOT 5 V tolerant',
    title: 'ESP32-C6',
    match: { mcu: /^esp32c6$/i },
    facts: [
      'RISC-V at 160 MHz, Wi-Fi 6 (2.4 GHz), BLE 5 and IEEE 802.15.4 (Thread / Zigbee). Built-in USB Serial/JTAG. 3.3 V, NOT 5 V tolerant.',
      'Needs ESP32 Arduino core 3.x (core 2.x does not support it).',
    ],
    pitfalls: ['Zigbee needs the Zigbee mode and partition scheme set in Tools.'],
  },
  {
    id: 'esp32-h2',
    logic: '3.3 V logic, NOT 5 V tolerant',
    title: 'ESP32-H2',
    match: { mcu: /^esp32h2$/i },
    facts: ['RISC-V at 96 MHz, BLE 5 and IEEE 802.15.4 (Thread / Zigbee), no Wi-Fi. 3.3 V. Needs ESP32 core 3.x.'],
    pitfalls: ['There is no Wi-Fi: WiFi.h sketches won\'t work.'],
  },
  {
    id: 'esp32-p4',
    logic: '3.3 V logic, NOT 5 V tolerant',
    title: 'ESP32-P4',
    match: { mcu: /^esp32p4$/i },
    facts: ['High-performance dual-core RISC-V without radio of its own (boards add an ESP32-C6 for Wi-Fi). Needs ESP32 core 3.1 or newer.'],
    pitfalls: [],
  },
  {
    id: 'esp8266',
    logic: '3.3 V logic',
    title: 'ESP8266 (NodeMCU, Wemos/LOLIN D1 mini, ESP-01)',
    match: { mcu: /^esp8266$/i, platform: /:esp8266$/i },
    facts: [
      'Tensilica L106 at 80/160 MHz, about 50 KB of free heap, Wi-Fi only. 3.3 V logic.',
      'Board labels D0–D8 are not GPIO numbers: use the D-constants (D4 = GPIO2, which drives the onboard LED, active-LOW).',
      'D0 (GPIO16) has no interrupt or PWM; connect it to RST to wake from deep sleep.',
      'Boot pins: GPIO0 (D3) and GPIO2 (D4) must be HIGH and GPIO15 (D8) LOW at reset.',
      'One ADC input, A0: 0–1 V on the bare chip; NodeMCU and D1 mini have a divider so A0 reads 0–3.3 V. 10-bit.',
      'analogWrite range is 0–255 in core 3.x (0–1023 in older cores); analogWriteRange() changes it.',
    ],
    pitfalls: [
      'Long loops without yield() or delay() reset the chip (soft watchdog).',
      'GPIO6–11 are the flash: never use them.',
      'Interrupt handlers need IRAM_ATTR.',
    ],
  },
  {
    id: 'stm32',
    logic: '3.3 V logic (many pins 5 V tolerant)',
    title: 'STM32 (STM32duino: Blue Pill F103, Black Pill F401/F411, Nucleo, Discovery)',
    match: { platform: /^STMicroelectronics:stm32$|:stm32$/i, board: /BLUEPILL|BLACKPILL|NUCLEO|DISCO|GENERIC_F/i },
    facts: [
      'Arm Cortex-M (M0 to M7 depending on the part), 3.3 V. Many pins are 5 V tolerant ("FT" in the datasheet), but analog-capable pins are not while used as analog.',
      'Pins are named PA0, PB1… (use these names in code). 12-bit ADC.',
      'Upload through an ST-Link, the built-in DFU/serial bootloader, or a USB bootloader; choose it in Tools › Upload method.',
    ],
    pitfalls: [
      'Many cheap "Blue Pill" boards carry clone chips (CKS32, CS32) that ST-Link may refuse, and some have a wrong USB pull-up resistor (R10).',
    ],
  },
  {
    id: 'teensy4',
    logic: '3.3 V logic, NOT 5 V tolerant',
    title: 'Teensy 4.0 / 4.1 (i.MX RT1062)',
    match: { platform: /^teensy:avr$/i, board: /TEENSY4/i },
    facts: [
      'Arm Cortex-M7 at 600 MHz, 1 MB RAM. 3.3 V and NOT 5 V tolerant.',
      'Serial is USB (choose the USB type in Tools: Serial, MIDI, Audio, HID…); Serial1–Serial8 are hardware UARTs.',
    ],
    pitfalls: ['Uploads go through the Teensy Loader that the Teensyduino core installs.'],
  },
  {
    id: 'stm32h7-mbed',
    logic: '3.3 V logic, NOT 5 V tolerant',
    title: 'STM32H747 (Portenta H7, GIGA R1 WiFi)',
    match: { platform: /:(mbed_portenta|mbed_giga)$/i },
    facts: [
      'Dual-core Arm Cortex-M7 (480 MHz) + M4, 3.3 V, NOT 5 V tolerant (the GIGA\'s pins are 3.3 V even though it has the Mega layout).',
      'Arduino Mbed OS core: the M4 core is programmed separately (RPC library to talk between cores).',
    ],
    pitfalls: ['Mega shields that put 5 V on signal pins can damage the GIGA.'],
  },
  {
    id: 'uno-q',
    logic: '3.3 V logic',
    title: 'Arduino UNO Q (Qualcomm QRB2210 + STM32U585)',
    match: { platform: /:zephyr$/i, board: /UNO_Q/i },
    facts: [
      'Two processors: a Qualcomm Dragonwing QRB2210 running Linux, and an STM32U585 microcontroller that runs Arduino sketches on the Zephyr-based core (arduino:zephyr).',
      'The two sides exchange data through Arduino\'s Bridge; Arduino App Lab manages both.',
    ],
    pitfalls: ['Libraries must support the Zephyr-based core; many AVR-era libraries don\'t yet.'],
  },
];

/** ESP32 Arduino core 2.x → 3.x changes that break code (Espressif\'s migration guide). */
const ESP32_CORE3 = [
  'LEDC (PWM): ledcSetup() and ledcAttachPin() are gone; use ledcAttach(pin, freq, resolution) and ledcWrite(pin, duty) (pins replace channels).',
  'Timers: timerBegin() takes only a frequency; timerAlarm() replaces timerAlarmWrite()/timerAlarmEnable(); timerAttachInterrupt() lost its edge argument.',
  'RGB LED: neopixelWrite() became rgbLedWrite().',
  'hallRead() was removed (no Hall sensor support). analogSetClockDiv(), adcAttachPin() and analogSetVRefPin() were removed.',
  'I2S and RMT were rewritten on the new ESP-IDF drivers with new APIs.',
  'Default UART pins changed: ESP32 UART1 is RX 26 / TX 27, UART2 is RX 4 / TX 25.',
  'WiFiServer.available() is deprecated in favour of accept(); WiFiClient.flush() no longer clears the receive buffer (use clear()).',
];

/** Which family a board belongs to, from its build properties. */
function familyOf(props = {}, fqbn = '') {
  const mcu = String(props['build.mcu'] || '');
  const chip = String(props['build.chip'] || '');
  const board = String(props['build.board'] || '');
  const platform = String(fqbn).split(':').slice(0, 2).join(':');
  const test = (re, v) => re && v && re.test(v);
  // A named MCU (atmega328p, esp32s3) decides; Arm cores report only their CPU
  // (cortex-m4), so for those the chip, board and platform decide.
  const order = /^cortex-/i.test(mcu) || !mcu ? ['chip', 'board', 'platform', 'mcu'] : ['mcu', 'chip', 'board', 'platform'];
  for (const key of order) {
    for (const f of FAMILIES) {
      const value = { mcu, chip, platform, board }[key];
      if (test(f.match[key], value)) return f;
    }
  }
  return null;
}

/** A family by id, chip name or title words: "esp32-s3", "ESP32S3", "atmega328p", "attiny85", "rp2040". */
function familyById(id) {
  const n = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = n(id);
  if (!key) return null;
  return FAMILIES.find((f) => n(f.id) === key)
    || FAMILIES.find((f) => f.match.mcu && (f.match.mcu.test(key) || f.match.mcu.test(String(id).toLowerCase())))
    || FAMILIES.find((f) => f.match.chip && f.match.chip.test(key))
    || FAMILIES.find((f) => n(f.id).endsWith(key) || key.endsWith(n(f.id)))
    || FAMILIES.find((f) => n(f.title).includes(key))
    || null;
}

/**
 * A family's guide as text for the model.
 * @param {object} family
 * @param {{ coreVersion?: string, includeGeneral?: boolean }} [opts]
 */
function guideText(family, { coreVersion = '', includeGeneral = true } = {}) {
  const lines = [`# ${family.title}`, '', ...(family.logic ? [`- Logic level: ${family.logic}.`] : []), ...family.facts.map((f) => `- ${f}`)];
  if (family.pitfalls?.length) lines.push('', 'Common mistakes:', ...family.pitfalls.map((p) => `- ${p}`));
  if (/^esp32/.test(family.id)) {
    const core3 = /^[3-9]\./.test(coreVersion);
    lines.push('', `ESP32 Arduino core ${coreVersion || '(version unknown)'}: ${core3 ? 'this is core 3.x; code written for 2.x may need these changes' : 'code written for core 3.x won\'t compile on 2.x; these are the differences'}:`, ...ESP32_CORE3.map((c) => `- ${c}`));
  }
  if (includeGeneral) lines.push('', `# ${GENERAL.title}`, ...GENERAL.facts.map((f) => `- ${f}`));
  return lines.join('\n');
}

module.exports = { FAMILIES, GENERAL, ESP32_CORE3, familyOf, familyById, guideText };
