/**
 * Known-good recipes for the parts in components.js: the libraries to
 * install (Library Manager names), the wiring, and a minimal sketch that
 * Impulse compiles for real boards (scripts/knowledge-recipes.mjs) before it
 * ships. `{{PIN}}` placeholders take the pins table for the board family;
 * `sketch` and `libs` may differ per family when the API does (Servo vs
 * ESP32Servo). Pins are chosen to exist and be free on every board of the
 * family: 2–13 on AVR boards; 4, 5, 13–18, 21 on the ESP32 and ESP32-S3.
 * @module main/services/ai/knowledge/recipes
 */

// The default I²C pins of each chip, as its core's variant defines them
// (Wire.begin() uses these).
const I2C_WIRING = {
  default: { SDA: 'A4 on the Uno/Nano, 20 on the Mega', SCL: 'A5 on the Uno/Nano, 21 on the Mega' },
  esp32: { SDA: 'GPIO 21', SCL: 'GPIO 22' },
  esp32s2: { SDA: 'GPIO 8', SCL: 'GPIO 9' },
  esp32s3: { SDA: 'GPIO 8', SCL: 'GPIO 9' },
  esp32c3: { SDA: 'GPIO 8', SCL: 'GPIO 9' },
  esp32c6: { SDA: 'GPIO 23', SCL: 'GPIO 22' },
  esp8266: { SDA: 'D2 (GPIO 4)', SCL: 'D1 (GPIO 5)' },
  rp2040: { SDA: 'GP4', SCL: 'GP5' },
  'nano-esp32': { SDA: 'A4', SCL: 'A5' },
};
// The default SPI pins, the same way (for wiring text only).
const SPI_BUS = {
  default: { BUS: 'MOSI 11, MISO 12, SCK 13 (ICSP on the Mega)' },
  esp32: { BUS: 'MOSI 23, MISO 19, SCK 18' },
  esp32s2: { BUS: 'MOSI 35, MISO 37, SCK 36' },
  esp32s3: { BUS: 'MOSI 11, MISO 13, SCK 12' },
  esp32c3: { BUS: 'MOSI 6, MISO 5, SCK 4' },
  esp32c6: { BUS: 'MOSI 19, MISO 20, SCK 21' },
  rp2040: { BUS: 'MOSI GP19, MISO GP16, SCK GP18' },
  'nano-esp32': { BUS: 'MOSI D11, MISO D12, SCK D13' },
};
// An analog input by number, because ESP32 and Pico boards are labelled by GPIO, not A0.
const ANALOG_IN = {
  default: { AIN: 'A0' }, esp32: { AIN: 34 }, esp32s2: { AIN: 1 }, esp32s3: { AIN: 1 }, esp32c3: { AIN: 0 }, esp32c6: { AIN: 0 }, rp2040: { AIN: 26 }, 'nano-esp32': { AIN: 'A0' },
};
const i2cWiring = (vcc = 'VCC → 3.3 V (5 V also works on modules with a regulator)') => [vcc, 'GND → GND', 'SDA → {{SDA}}', 'SCL → {{SCL}}'];

const RECIPES = {
  'ssd1306': {
    libs: ['Adafruit SSD1306', 'Adafruit GFX Library', 'Adafruit BusIO'],
    pins: I2C_WIRING,
    wiring: i2cWiring(),
    sketch: `
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);  // 128x32 modules: change 64 to 32

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {  // 0x3D on some modules: run an I2C scanner
    Serial.println("SSD1306 not found");
    while (true) delay(10);
  }
  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("Hello");
  display.display();  // nothing shows until this
}

void loop() {}
`,
  },
  'lcd-i2c': {
    libs: ['LiquidCrystal I2C'],
    pins: I2C_WIRING,
    wiring: i2cWiring('VCC → 5 V (the backlight and contrast need 5 V; on 3.3 V boards use a level shifter or remove the backpack pull-ups)'),
    sketch: `
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

LiquidCrystal_I2C lcd(0x27, 16, 2);  // 0x3F on PCF8574A backpacks; (0x27, 20, 4) for a 20x4

void setup() {
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Hello");
}

void loop() {
  lcd.setCursor(0, 1);
  lcd.print(millis() / 1000);
  lcd.print(" s   ");
  delay(200);
}
`,
  },
  'lcd-parallel': {
    libs: ['LiquidCrystal'],
    pins: { default: { RS: 12, EN: 11, D4: 5, D5: 4, D6: 3, D7: 2 }, esp32: { RS: 4, EN: 13, D4: 14, D5: 16, D6: 17, D7: 18 }, esp32c3: { RS: 10, EN: 3, D4: 4, D5: 5, D6: 6, D7: 7 }, esp32c6: { RS: 0, EN: 1, D4: 2, D5: 3, D6: 6, D7: 7 } },
    wiring: ['VSS → GND; VDD → 5 V; V0 → wiper of a 10 kΩ pot between 5 V and GND (contrast)', 'RS → pin {{RS}}; RW → GND; E → pin {{EN}}', 'D4 → pin {{D4}}; D5 → pin {{D5}}; D6 → pin {{D6}}; D7 → pin {{D7}} (D0–D3 unconnected)', 'A → 220 Ω → 5 V; K → GND (backlight)'],
    sketch: `
#include <LiquidCrystal.h>

LiquidCrystal lcd({{RS}}, {{EN}}, {{D4}}, {{D5}}, {{D6}}, {{D7}});  // RS, E, D4, D5, D6, D7

void setup() {
  lcd.begin(16, 2);
  lcd.print("Hello");
}

void loop() {
  lcd.setCursor(0, 1);
  lcd.print(millis() / 1000);
}
`,
  },
  'dht': {
    libs: ['DHT sensor library', 'Adafruit Unified Sensor'],
    pins: { default: { DATA: 2 }, esp32: { DATA: 4 }, esp32c6: { DATA: 2 } },
    wiring: ['VCC → 3.3 V or 5 V', 'GND → GND', 'DATA → pin {{DATA}}, with 10 kΩ from DATA to VCC (bare sensors; modules have it)'],
    sketch: `
#include <DHT.h>

#define DHTPIN {{DATA}}
#define DHTTYPE DHT22  // DHT11 for the blue sensor

DHT dht(DHTPIN, DHTTYPE);

void setup() {
  Serial.begin(115200);
  dht.begin();
}

void loop() {
  delay(2000);  // a DHT22 answers at most every 2 s (DHT11: 1 s)
  float h = dht.readHumidity();
  float t = dht.readTemperature();
  if (isnan(h) || isnan(t)) {
    Serial.println("DHT read failed (wiring, pull-up, or read too soon)");
    return;
  }
  Serial.print(t); Serial.print(" C  ");
  Serial.print(h); Serial.println(" %");
}
`,
  },
  'ds18b20': {
    // OneWire 2.3.8 does not build for the ESP32-C6 (core 3.3.12): OneWireNg's own driver does.
    libs: { default: ['OneWire', 'DallasTemperature'], esp32c6: ['OneWireNg'] },
    pins: { default: { DATA: 2 }, esp32: { DATA: 4 }, esp32c6: { DATA: 2 } },
    wiring: ['VDD (red) → 3.3 V or 5 V', 'GND (black) → GND', 'DQ (yellow) → pin {{DATA}}, with 4.7 kΩ from DQ to VDD'],
    sketch: { default: `
#include <OneWire.h>
#include <DallasTemperature.h>

OneWire oneWire({{DATA}});  // 4.7 kΩ pull-up from DATA to VCC
DallasTemperature sensors(&oneWire);

void setup() {
  Serial.begin(115200);
  sensors.begin();
}

void loop() {
  sensors.requestTemperatures();
  float c = sensors.getTempCByIndex(0);
  if (c == DEVICE_DISCONNECTED_C) Serial.println("DS18B20 not found");
  else { Serial.print(c); Serial.println(" C"); }
  delay(1000);
}
`,
    esp32c6: `
// On the ESP32-C6, OneWireNg: OneWire 2.3.8 does not build for this chip.
#include <OneWireNg_CurrentPlatform.h>
#include <drivers/DSTherm.h>
#include <utils/Placeholder.h>

static Placeholder<OneWireNg_CurrentPlatform> ow;  // 4.7 kΩ pull-up from DATA to 3.3 V

void setup() {
  Serial.begin(115200);
  new (&ow) OneWireNg_CurrentPlatform({{DATA}}, false);
}

void loop() {
  DSTherm drv(ow);
  drv.convertTempAll(DSTherm::MAX_CONV_TIME, false);
  static Placeholder<DSTherm::Scratchpad> scratchpad;
  if (drv.readScratchpadSingle(scratchpad) == OneWireNg::EC_SUCCESS) {
    long milli = static_cast<DSTherm::Scratchpad&>(scratchpad).getTemp();  // 20.125 C reads 20125
    Serial.print(milli / 1000.0);
    Serial.println(" C");
  } else {
    Serial.println("DS18B20 not found");
  }
  delay(1000);
}
` },
  },
  'hc-sr04': {
    pins: { default: { TRIG: 9, ECHO: 10 }, esp32: { TRIG: 4, ECHO: 18 }, esp32s2: { TRIG: 4, ECHO: 5 }, esp32s3: { TRIG: 4, ECHO: 5 }, esp32c3: { TRIG: 4, ECHO: 5 }, esp32c6: { TRIG: 2, ECHO: 3 }, rp2040: { TRIG: 14, ECHO: 15 } },
    inputs: ['ECHO'],
    params: { default: { ECHO_HOW: 'directly' }, esp32: { ECHO_HOW: 'through a divider (1 kΩ from ECHO to the pin, 2 kΩ from the pin to GND): ECHO is a 5 V signal' }, rp2040: { ECHO_HOW: 'through a divider (1 kΩ from ECHO to the pin, 2 kΩ from the pin to GND): ECHO is a 5 V signal' }, 'nano-esp32': { ECHO_HOW: 'through a divider (1 kΩ from ECHO to the pin, 2 kΩ from the pin to GND): ECHO is a 5 V signal' } },
    wiring: ['VCC → 5 V (it does not work reliably from 3.3 V)', 'GND → GND', 'TRIG → pin {{TRIG}}', 'ECHO → pin {{ECHO}} {{ECHO_HOW}}'],
    sketch: `
const int TRIG_PIN = {{TRIG}};
const int ECHO_PIN = {{ECHO}};

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
}

void loop() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  unsigned long us = pulseIn(ECHO_PIN, HIGH, 30000UL);  // 30 ms timeout, about 5 m
  if (us == 0) Serial.println("no echo");
  else { Serial.print(us * 0.0343 / 2.0, 1); Serial.println(" cm"); }
  delay(100);  // at least 60 ms between pings
}
`,
  },
  'servo': {
    libs: { default: ['Servo'], esp32: ['ESP32Servo'] },
    pins: { default: { SIG: 9 }, esp32: { SIG: 18 }, esp32c3: { SIG: 4 } },
    wiring: ['Brown/black → GND, shared with the board', 'Red → 5 V from a supply that gives 1 A per servo (not the board\'s 3V3 pin; an SG90 on the Uno\'s 5 V pin is the limit)', 'Orange/yellow → pin {{SIG}}'],
    sketch: {
      default: `
#include <Servo.h>

Servo servo;

void setup() {
  servo.attach({{SIG}});  // 544–2400 µs pulses by default
}

void loop() {
  servo.write(0);   delay(1000);
  servo.write(90);  delay(1000);
  servo.write(180); delay(1000);
}
`,
      esp32: `
#include <ESP32Servo.h>  // the AVR Servo library does not build on the ESP32

Servo servo;

void setup() {
  servo.setPeriodHertz(50);
  servo.attach({{SIG}}, 500, 2400);  // pulse range in µs; narrow it if the servo buzzes at the ends
}

void loop() {
  servo.write(0);   delay(1000);
  servo.write(90);  delay(1000);
  servo.write(180); delay(1000);
}
`,
    },
  },
  'mpu6050': {
    libs: ['Adafruit MPU6050', 'Adafruit Unified Sensor', 'Adafruit BusIO'],
    pins: I2C_WIRING,
    wiring: i2cWiring('VCC → 3.3 V (GY-521 modules also take 5 V)'),
    sketch: `
#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>

Adafruit_MPU6050 mpu;

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  if (!mpu.begin()) {  // mpu.begin(0x69) when AD0 is tied to VCC
    Serial.println("MPU6050 not found");
    while (true) delay(10);
  }
  mpu.setAccelerometerRange(MPU6050_RANGE_4_G);
  mpu.setGyroRange(MPU6050_RANGE_500_DEG);
  mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
}

void loop() {
  sensors_event_t a, g, t;
  mpu.getEvent(&a, &g, &t);
  Serial.print("ax "); Serial.print(a.acceleration.x);
  Serial.print(" ay "); Serial.print(a.acceleration.y);
  Serial.print(" az "); Serial.print(a.acceleration.z);
  Serial.print("  gz "); Serial.println(g.gyro.z);
  delay(100);
}
`,
  },
  'neopixel': {
    libs: ['Adafruit NeoPixel'],
    pins: { default: { DATA: 6 }, esp32: { DATA: 4 }, esp32c6: { DATA: 2 } },
    wiring: ['5V → 5 V supply (60 mA per LED at full white: more than 8 LEDs needs its own supply, GND shared)', 'GND → GND', 'DIN → pin {{DATA}} (a 330 Ω series resistor and a 1000 µF capacitor across the supply protect the strip)', 'Onboard LED on an ESP32-S3 DevKitC: pin 48 (38 on some clones), count 1'],
    sketch: `
#include <Adafruit_NeoPixel.h>

#define LED_PIN   {{DATA}}
#define LED_COUNT 8

Adafruit_NeoPixel strip(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

void setup() {
  strip.begin();
  strip.setBrightness(40);  // 0–255; keep it low on USB power
  strip.show();             // all off
}

void loop() {
  for (int i = 0; i < LED_COUNT; i++) {
    strip.clear();
    strip.setPixelColor(i, strip.Color(0, 120, 0));
    strip.show();
    delay(80);
  }
}
`,
  },
  'bme280': {
    libs: ['Adafruit BME280 Library', 'Adafruit Unified Sensor', 'Adafruit BusIO'],
    pins: I2C_WIRING,
    wiring: i2cWiring(),
    sketch: `
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>

Adafruit_BME280 bme;

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  if (!bme.begin(0x76)) {  // 0x77 when SDO is tied to VCC; a BMP280 (no humidity) uses Adafruit_BMP280
    Serial.println("BME280 not found");
    while (true) delay(10);
  }
}

void loop() {
  Serial.print(bme.readTemperature()); Serial.print(" C  ");
  Serial.print(bme.readHumidity()); Serial.print(" %  ");
  Serial.print(bme.readPressure() / 100.0F); Serial.println(" hPa");
  delay(1000);
}
`,
  },
  'relay': {
    pins: { default: { IN: 7 }, esp32: { IN: 4 }, esp32c6: { IN: 2 } },
    wiring: ['VCC → 5 V (the coil needs 5 V; JD-VCC jumper on for a single supply)', 'GND → GND', 'IN → pin {{IN}} (most modules switch on with LOW; 3.3 V boards usually trigger them, else use a transistor or a 3.3 V relay module)', 'Load: COM to the supply, NO to the load (open until energised)'],
    sketch: `
const int RELAY_PIN = {{IN}};
const bool ACTIVE_LOW = true;  // most blue relay modules switch on with LOW

void relay(bool on) { digitalWrite(RELAY_PIN, (on != ACTIVE_LOW) ? HIGH : LOW); }

void setup() {
  pinMode(RELAY_PIN, OUTPUT);
  relay(false);
}

void loop() {
  relay(true);  delay(2000);
  relay(false); delay(2000);
}
`,
  },
  'buzzer': {
    pins: { default: { BUZ: 8 }, esp32: { BUZ: 13 }, esp32c3: { BUZ: 6 }, esp32c6: { BUZ: 3 } },
    wiring: ['+ → pin {{BUZ}}', '− → GND', 'Passive buzzers need tone(); active buzzers sound on a plain HIGH'],
    sketch: `
const int BUZZER_PIN = {{BUZ}};

void setup() {
  pinMode(BUZZER_PIN, OUTPUT);
}

void loop() {
  tone(BUZZER_PIN, 440, 200);  // passive buzzer: 440 Hz for 200 ms
  delay(400);
  tone(BUZZER_PIN, 880, 200);
  delay(1000);
  // Active buzzer (one fixed tone): digitalWrite(BUZZER_PIN, HIGH) / LOW instead of tone()
}
`,
  },
  'pir': {
    pins: { default: { OUT: 2 }, esp32: { OUT: 4 }, esp32c6: { OUT: 6 } },
    wiring: ['VCC → 5 V (HC-SR501; AM312 takes 3.3 V)', 'GND → GND', 'OUT → pin {{OUT}} (3.3 V logic output, safe on every board)'],
    sketch: `
const int PIR_PIN = {{OUT}};

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  pinMode(PIR_PIN, INPUT);
  Serial.println("PIR warming up (30-60 s)...");
  delay(30000);
}

void loop() {
  static bool last = false;
  bool motion = digitalRead(PIR_PIN) == HIGH;
  if (motion != last) {
    Serial.println(motion ? "motion" : "quiet");
    last = motion;
  }
  delay(50);
}
`,
  },
  'ldr': {
    pins: ANALOG_IN,
    analog: ['AIN'],
    wiring: ['LDR between pin {{AIN}} and the board\'s supply (5 V on AVR, 3.3 V on ESP32 and Pico)', '10 kΩ between pin {{AIN}} and GND (the divider; bright = higher reading)'],
    sketch: `
const int LDR_PIN = {{AIN}};  // LDR from this pin to VCC, 10 kΩ from it to GND

void setup() { Serial.begin(115200); }

void loop() {
  int raw = analogRead(LDR_PIN);  // 0–1023 on AVR, 0–4095 on ESP32
  Serial.println(raw);
  delay(200);
}
`,
  },
  'button': {
    pins: { default: { BTN: 2 }, esp32: { BTN: 4 }, esp32c6: { BTN: 3 } },
    wiring: ['One leg → pin {{BTN}}', 'Other leg → GND (INPUT_PULLUP: no resistor needed; pressed reads LOW)'],
    sketch: `
const int BUTTON_PIN = {{BTN}};  // button between the pin and GND

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_PIN, INPUT_PULLUP);  // pressed = LOW
}

void loop() {
  static bool wasPressed = false;
  static unsigned long changedAt = 0;
  bool pressed = digitalRead(BUTTON_PIN) == LOW;
  if (pressed != wasPressed && millis() - changedAt > 30) {  // 30 ms debounce
    wasPressed = pressed;
    changedAt = millis();
    if (pressed) Serial.println("pressed");
  }
}
`,
  },
  'led': {
    pwm: ['LED'],
    pins: { default: { LED: 9 }, esp32: { LED: 4 }, esp32c6: { LED: 2 } },
    wiring: ['Anode (long leg) → 220 Ω → pin {{LED}}', 'Cathode (short leg) → GND'],
    sketch: `
const int LED_PIN = {{LED}};  // anode → 220 Ω → pin; cathode → GND

void setup() { pinMode(LED_PIN, OUTPUT); }

void loop() {
  for (int b = 0; b <= 255; b += 5) { analogWrite(LED_PIN, b); delay(10); }  // PWM fade up
  for (int b = 255; b >= 0; b -= 5) { analogWrite(LED_PIN, b); delay(10); }  // and down
}
`,
  },
  // ── Chunk 2: displays, input, motion, radio, storage, power ─────────────
  'tm1637': {
    libs: ['TM1637'],
    pins: { default: { CLK: 2, DIO: 3 }, esp32: { CLK: 4, DIO: 13 }, esp32c3: { CLK: 4, DIO: 5 }, esp32c6: { CLK: 2, DIO: 3 } },
    wiring: ['VCC → 3.3 V or 5 V', 'GND → GND', 'CLK → pin {{CLK}}', 'DIO → pin {{DIO}} (any two digital pins; it is not I2C)'],
    sketch: `
#include <TM1637Display.h>

TM1637Display display({{CLK}}, {{DIO}});  // CLK, DIO

void setup() {
  display.setBrightness(5);  // 0–7
}

void loop() {
  display.showNumberDecEx(1234, 0b01000000, true);  // colon on, leading zeros
  delay(1000);
  display.showNumberDec(millis() / 1000);
  delay(1000);
}
`,
  },
  'max7219': {
    libs: ['MD_MAX72XX'],
    pins: { default: { DIN: 11, CLK: 13, CS: 10 }, esp32: { DIN: 13, CLK: 14, CS: 16 }, esp32c3: { DIN: 4, CLK: 5, CS: 6 }, esp32c6: { DIN: 2, CLK: 3, CS: 6 } },
    wiring: ['VCC → 5 V', 'GND → GND', 'DIN → pin {{DIN}}; CLK → pin {{CLK}}; CS → pin {{CS}} (bit-banged: any pins)', 'Chain modules DOUT → next DIN'],
    sketch: `
#include <MD_MAX72xx.h>  // works on AVR and ESP32 (LedControl needs avr/pgmspace.h and fails to build on the ESP32)
#include <SPI.h>

#define HARDWARE_TYPE MD_MAX72XX::FC16_HW  // the common blue 4-in-1 modules; GENERIC_HW or PAROLA_HW if the image is mirrored
MD_MAX72XX mx = MD_MAX72XX(HARDWARE_TYPE, {{DIN}}, {{CLK}}, {{CS}}, 1);  // DIN, CLK, CS, number of modules

void setup() {
  mx.begin();
  mx.control(MD_MAX72XX::INTENSITY, 4);  // 0–15
  mx.clear();
}

void loop() {
  for (int row = 0; row < 8; row++) {
    mx.clear();
    mx.setRow(row, 0xFF);  // one full row at a time
    delay(120);
  }
}
`,
  },
  'rotary-encoder': {
    pins: { default: { CLK: 2, DT: 3, SW: 4 }, esp32: { CLK: 4, DT: 13, SW: 14 }, esp32c3: { CLK: 4, DT: 5, SW: 6 }, esp32c6: { CLK: 2, DT: 3, SW: 6 } },
    wiring: ['+ → 3.3 V or 5 V (the board\'s logic level)', 'GND → GND', 'CLK → pin {{CLK}} (interrupt-capable: 2 or 3 on the Uno)', 'DT → pin {{DT}}', 'SW → pin {{SW}} (pressed = LOW with INPUT_PULLUP)'],
    sketch: `
#ifndef IRAM_ATTR
#define IRAM_ATTR  // the ESP32 wants interrupt handlers in RAM; other boards do not know the word
#endif

const int CLK_PIN = {{CLK}};
const int DT_PIN = {{DT}};
const int SW_PIN = {{SW}};

volatile long position = 0;

void IRAM_ATTR onTurn() {
  // On a CLK edge, DT tells the direction.
  if (digitalRead(DT_PIN) != digitalRead(CLK_PIN)) position++;
  else position--;
}

void setup() {
  Serial.begin(115200);
  pinMode(CLK_PIN, INPUT_PULLUP);
  pinMode(DT_PIN, INPUT_PULLUP);
  pinMode(SW_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(CLK_PIN), onTurn, CHANGE);
}

void loop() {
  static long shown = 0;
  if (position != shown) { shown = position; Serial.println(shown); }
  if (digitalRead(SW_PIN) == LOW) { Serial.println("pressed"); delay(200); }
}
`,
  },
  'joystick': {
    pins: { default: { X: 'A0', Y: 'A1', SW: 2 }, esp32: { X: 34, Y: 35, SW: 4 }, esp32s2: { X: 1, Y: 2, SW: 4 }, esp32s3: { X: 1, Y: 2, SW: 4 }, esp32c3: { X: 0, Y: 1, SW: 4 }, esp32c6: { X: 0, Y: 1, SW: 2 }, rp2040: { X: 26, Y: 27, SW: 2 } },
    analog: ['X', 'Y'],
    wiring: ['VCC → the board\'s ADC supply (5 V on AVR, 3.3 V on ESP32: the axes output the supply voltage)', 'GND → GND', 'VRx → pin {{X}}; VRy → pin {{Y}} (analog inputs)', 'SW → pin {{SW}} (pressed = LOW with INPUT_PULLUP)'],
    sketch: `
const int X_PIN = {{X}}, Y_PIN = {{Y}}, SW_PIN = {{SW}};

void setup() {
  Serial.begin(115200);
  pinMode(SW_PIN, INPUT_PULLUP);
}

void loop() {
  Serial.print("x "); Serial.print(analogRead(X_PIN));
  Serial.print(" y "); Serial.print(analogRead(Y_PIN));
  Serial.println(digitalRead(SW_PIN) == LOW ? " pressed" : "");
  delay(100);
}
`,
  },
  'keypad': {
    libs: ['Keypad'],
    pins: {
      default: { R1: 9, R2: 8, R3: 7, R4: 6, C1: 5, C2: 4, C3: 3, C4: 2 },
      esp32: { R1: 13, R2: 14, R3: 16, R4: 17, C1: 18, C2: 19, C3: 21, C4: 22 },
      esp32s2: { R1: 1, R2: 2, R3: 3, R4: 4, C1: 5, C2: 6, C3: 7, C4: 8 },
      esp32s3: { R1: 1, R2: 2, R3: 4, R4: 5, C1: 6, C2: 7, C3: 15, C4: 16 },
      esp32c3: { R1: 0, R2: 1, R3: 3, R4: 4, C1: 5, C2: 6, C3: 7, C4: 10 },
      esp32c6: { R1: 0, R2: 1, R3: 2, R4: 3, C1: 6, C2: 7, C3: 10, C4: 11 },
    },
    wiring: ['Keypad pins 1–4 (rows) → pins {{R1}}, {{R2}}, {{R3}}, {{R4}}', 'Keypad pins 5–8 (columns) → pins {{C1}}, {{C2}}, {{C3}}, {{C4}}', 'No power or resistors: the library scans with internal pull-ups'],
    sketch: `
#include <Keypad.h>

const byte ROWS = 4, COLS = 4;
char keys[ROWS][COLS] = {
  {'1', '2', '3', 'A'},
  {'4', '5', '6', 'B'},
  {'7', '8', '9', 'C'},
  {'*', '0', '#', 'D'}
};
byte rowPins[ROWS] = {{{R1}}, {{R2}}, {{R3}}, {{R4}}};  // keypad pins 1–4, left to right
byte colPins[COLS] = {{{C1}}, {{C2}}, {{C3}}, {{C4}}};  // keypad pins 5–8

Keypad keypad = Keypad(makeKeymap(keys), rowPins, colPins, ROWS, COLS);

void setup() { Serial.begin(115200); }

void loop() {
  char key = keypad.getKey();
  if (key) Serial.println(key);
}
`,
  },
  'stepper-28byj48': {
    libs: ['Stepper'],
    pins: { default: { IN1: 8, IN2: 9, IN3: 10, IN4: 11 }, esp32: { IN1: 13, IN2: 14, IN3: 16, IN4: 17 }, esp32c3: { IN1: 3, IN2: 4, IN3: 5, IN4: 6 }, esp32c6: { IN1: 0, IN2: 1, IN3: 2, IN4: 3 } },
    wiring: ['ULN2003 IN1–IN4 → pins {{IN1}}, {{IN2}}, {{IN3}}, {{IN4}}', 'ULN2003 − → GND (shared); + → 5 V from a supply or the board\'s 5 V pin (240 mA)', 'Motor plug into the ULN2003 header'],
    sketch: `
#include <Stepper.h>

const int STEPS_PER_REV = 2048;  // 28BYJ-48 with its 1:64 gearbox, full-step
// The ULN2003 inputs IN1..IN4 go to the Stepper as IN1, IN3, IN2, IN4 (the coil order).
Stepper stepper(STEPS_PER_REV, {{IN1}}, {{IN3}}, {{IN2}}, {{IN4}});

void setup() {
  stepper.setSpeed(10);  // rpm; above about 15 it stalls
}

void loop() {
  stepper.step(STEPS_PER_REV);   // one turn one way
  delay(500);
  stepper.step(-STEPS_PER_REV);  // and back
  delay(500);
}
`,
  },
  'stepper-driver': {
    libs: ['AccelStepper'],
    pins: { default: { STEP: 3, DIR: 2, EN: 4 }, esp32: { STEP: 4, DIR: 13, EN: 14 }, esp32c3: { STEP: 4, DIR: 5, EN: 6 }, esp32c6: { STEP: 2, DIR: 3, EN: 6 } },
    wiring: ['STEP → pin {{STEP}}; DIR → pin {{DIR}}; EN → pin {{EN}} (or EN to GND: always enabled)', 'VDD → 3.3/5 V logic; GND → GND (shared)', 'VMOT → 8–35 V motor supply with a 100 µF capacitor right at the driver; never unplug the motor while powered', 'MS1–MS3 set microstepping; set the current limit with the trim pot (Vref) before the first run'],
    sketch: `
#include <AccelStepper.h>

AccelStepper stepper(AccelStepper::DRIVER, {{STEP}}, {{DIR}});  // STEP, DIR
const int EN_PIN = {{EN}};  // the driver's ENABLE is active-LOW

void setup() {
  pinMode(EN_PIN, OUTPUT);
  digitalWrite(EN_PIN, LOW);
  stepper.setMaxSpeed(1000);     // steps per second
  stepper.setAcceleration(500);  // steps per second²
  stepper.moveTo(1600);          // 8 turns at 200 full steps per revolution
}

void loop() {
  if (stepper.distanceToGo() == 0) stepper.moveTo(-stepper.currentPosition());
  stepper.run();  // call it constantly: no delay() in loop
}
`,
  },
  'dc-motor-driver': {
    pwm: ['EN'],
    pins: { default: { IN1: 7, IN2: 8, EN: 9 }, esp32: { IN1: 16, IN2: 17, EN: 4 }, esp32c3: { IN1: 5, IN2: 6, EN: 4 }, esp32c6: { IN1: 2, IN2: 3, EN: 6 } },
    wiring: ['IN1 → pin {{IN1}}; IN2 → pin {{IN2}}; ENA → pin {{EN}} (PWM; remove the ENA jumper)', '12V (VMS) → motor supply; GND → GND shared with the board; 5V out can power an Uno only when the 5V-EN jumper is on and VMS ≤ 12 V', 'OUT1/OUT2 → the motor'],
    sketch: `
const int IN1 = {{IN1}}, IN2 = {{IN2}}, ENA = {{EN}};  // ENA needs a PWM pin

void drive(int speed) {  // -255..255
  digitalWrite(IN1, speed > 0 ? HIGH : LOW);
  digitalWrite(IN2, speed < 0 ? HIGH : LOW);
  analogWrite(ENA, abs(speed));
}

void setup() {
  pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT); pinMode(ENA, OUTPUT);
}

void loop() {
  drive(200);  delay(2000);
  drive(0);    delay(500);
  drive(-200); delay(2000);
  drive(0);    delay(500);
}
`,
  },
  'shift-register': {
    pins: { default: { DATA: 11, CLOCK: 12, LATCH: 8 }, esp32: { DATA: 13, CLOCK: 14, LATCH: 16 }, esp32c3: { DATA: 4, CLOCK: 5, LATCH: 6 }, esp32c6: { DATA: 2, CLOCK: 3, LATCH: 6 } },
    wiring: ['DS (14) → pin {{DATA}}; SHCP (11) → pin {{CLOCK}}; STCP (12) → pin {{LATCH}}', 'VCC (16) and MR (10) → VCC; GND (8) and OE (13) → GND', 'Q0–Q7 → LEDs through 220 Ω; Q7\' (9) → DS of the next register'],
    sketch: `
const int DATA_PIN = {{DATA}}, CLOCK_PIN = {{CLOCK}}, LATCH_PIN = {{LATCH}};  // DS, SHCP, STCP

void show(byte value) {
  digitalWrite(LATCH_PIN, LOW);
  shiftOut(DATA_PIN, CLOCK_PIN, MSBFIRST, value);
  digitalWrite(LATCH_PIN, HIGH);
}

void setup() {
  pinMode(DATA_PIN, OUTPUT); pinMode(CLOCK_PIN, OUTPUT); pinMode(LATCH_PIN, OUTPUT);
}

void loop() {
  for (int i = 0; i < 8; i++) { show(1 << i); delay(100); }  // one output at a time, Q0..Q7
}
`,
  },
  'mfrc522': {
    libs: ['MFRC522'],
    pins: { default: { SS: 10, RST: 9, MOSI: 11, MISO: 12, SCK: 13 }, esp32: { SS: 27, RST: 4, MOSI: 23, MISO: 19, SCK: 18 }, esp32s3: { SS: 10, RST: 9, MOSI: 11, MISO: 13, SCK: 12 }, esp32s2: { SS: 34, RST: 9, MOSI: 35, MISO: 37, SCK: 36 }, esp32c3: { SS: 7, RST: 10, MOSI: 6, MISO: 5, SCK: 4 }, esp32c6: { SS: 18, RST: 2, MOSI: 19, MISO: 20, SCK: 21 }, rp2040: { SS: 17, RST: 20, MOSI: 19, MISO: 16, SCK: 18 } },
    wiring: ['3.3V → 3.3 V ONLY (5 V kills it); GND → GND', 'SDA/SS → pin {{SS}}; RST → pin {{RST}}', 'MOSI → pin {{MOSI}}; MISO → pin {{MISO}}; SCK → pin {{SCK}} (the board\'s SPI pins)', 'On 5 V boards the SPI lines are 5 V: it usually survives, a level shifter is correct'],
    sketch: `
#include <SPI.h>
#include <MFRC522.h>

MFRC522 rfid({{SS}}, {{RST}});  // SDA/SS, RST

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  SPI.begin();
  rfid.PCD_Init();
  Serial.println("Hold a tag near the reader");
}

void loop() {
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return;
  Serial.print("UID:");
  for (byte i = 0; i < rfid.uid.size; i++) {
    Serial.print(rfid.uid.uidByte[i] < 0x10 ? " 0" : " ");
    Serial.print(rfid.uid.uidByte[i], HEX);
  }
  Serial.println();
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}
`,
  },
  'ir-receiver': {
    libs: ['IRremote'],
    pins: { default: { IR: 2 }, esp32: { IR: 4 }, esp32c6: { IR: 2 } },
    wiring: ['OUT → pin {{IR}}', 'GND → GND', 'VCC → 3.3 V or 5 V'],
    sketch: `
#include <IRremote.hpp>  // IRremote 4.x: include the .hpp in exactly one file

const int IR_PIN = {{IR}};

void setup() {
  Serial.begin(115200);
  IrReceiver.begin(IR_PIN, ENABLE_LED_FEEDBACK);
}

void loop() {
  if (IrReceiver.decode()) {
    Serial.print("protocol "); Serial.print((int)IrReceiver.decodedIRData.protocol);
    Serial.print("  command 0x"); Serial.println(IrReceiver.decodedIRData.command, HEX);
    IrReceiver.resume();  // ready for the next code
  }
}
`,
  },
  'hc05': {
    pins: { default: { RX: 10, TX: 11 }, esp32: { RX: 16, TX: 17 }, esp32c3: { RX: 4, TX: 5 }, esp32c6: { RX: 6, TX: 7 } },
    wiring: ['VCC → 5 V (3.6–6 V); GND → GND', 'Module TXD → board pin {{RX}} (board RX)', 'Module RXD → board pin {{TX}} (board TX) through a 1 kΩ/2 kΩ divider on 5 V boards: RXD is 3.3 V logic', 'Pair from the phone with PIN 1234 (HC-05) or 0000 (HC-06); a serial terminal app talks to it'],
    sketch: {
      default: `
#include <SoftwareSerial.h>

SoftwareSerial bt({{RX}}, {{TX}});  // board RX (from module TXD), board TX (to module RXD via a divider)

void setup() {
  Serial.begin(115200);
  bt.begin(9600);  // HC-05 default 9600 (38400 in AT mode)
}

void loop() {
  if (bt.available()) Serial.write(bt.read());
  if (Serial.available()) bt.write(Serial.read());
}
`,
      esp32: `
// A hardware UART: the ESP32 has no SoftwareSerial (and has Bluetooth of its own: see BLE / BluetoothSerial).
const int RX_PIN = {{RX}}, TX_PIN = {{TX}};

void setup() {
  Serial.begin(115200);
  Serial1.begin(9600, SERIAL_8N1, RX_PIN, TX_PIN);
}

void loop() {
  if (Serial1.available()) Serial.write(Serial1.read());
  if (Serial.available()) Serial1.write(Serial.read());
}
`,
    },
  },
  'gps': {
    libs: ['TinyGPSPlus'],
    pins: { default: { RX: 10, TX: 11 }, esp32: { RX: 16, TX: 17 }, esp32c3: { RX: 4, TX: 5 }, esp32c6: { RX: 6, TX: 7 } },
    wiring: ['VCC → 3.3 V or 5 V (module); GND → GND', 'GPS TX → board pin {{RX}} (board RX)', 'GPS RX → board pin {{TX}} (optional, only to configure it; through a divider on 5 V boards)', 'The antenna needs the sky: the first fix takes minutes outdoors and may never come indoors'],
    sketch: {
      default: `
#include <SoftwareSerial.h>
#include <TinyGPS++.h>

SoftwareSerial gpsSerial({{RX}}, {{TX}});  // board RX from the GPS TX
TinyGPSPlus gps;

void setup() {
  Serial.begin(115200);
  gpsSerial.begin(9600);  // NEO-6M default
}

void loop() {
  while (gpsSerial.available()) gps.encode(gpsSerial.read());
  static unsigned long last = 0;
  if (millis() - last > 1000) {
    last = millis();
    if (gps.location.isValid()) {
      Serial.print(gps.location.lat(), 6); Serial.print(", "); Serial.println(gps.location.lng(), 6);
    } else {
      Serial.print("waiting for a fix, satellites: "); Serial.println(gps.satellites.value());
    }
  }
}
`,
      esp32: `
#include <TinyGPS++.h>

const int RX_PIN = {{RX}}, TX_PIN = {{TX}};
TinyGPSPlus gps;

void setup() {
  Serial.begin(115200);
  Serial1.begin(9600, SERIAL_8N1, RX_PIN, TX_PIN);  // NEO-6M default 9600
}

void loop() {
  while (Serial1.available()) gps.encode(Serial1.read());
  static unsigned long last = 0;
  if (millis() - last > 1000) {
    last = millis();
    if (gps.location.isValid()) {
      Serial.print(gps.location.lat(), 6); Serial.print(", "); Serial.println(gps.location.lng(), 6);
    } else {
      Serial.print("waiting for a fix, satellites: "); Serial.println(gps.satellites.value());
    }
  }
}
`,
    },
  },
  'sd-card': {
    libs: { default: ['SD'], esp32: [] },
    pins: { default: { CS: 10, MOSI: 11, MISO: 12, SCK: 13 }, esp32: { CS: 27, MOSI: 23, MISO: 19, SCK: 18 }, esp32s3: { CS: 10, MOSI: 11, MISO: 13, SCK: 12 }, esp32s2: { CS: 34, MOSI: 35, MISO: 37, SCK: 36 }, esp32c3: { CS: 7, MOSI: 6, MISO: 5, SCK: 4 }, esp32c6: { CS: 18, MOSI: 19, MISO: 20, SCK: 21 }, rp2040: { CS: 17, MOSI: 19, MISO: 16, SCK: 18 } },
    wiring: ['CS → pin {{CS}}; MOSI → pin {{MOSI}}; MISO → pin {{MISO}}; SCK → pin {{SCK}}', 'VCC → 5 V on modules with a regulator and level shifter, 3.3 V on bare micro-SD adapters; GND → GND', 'Card formatted FAT32 (FAT16 for ≤ 2 GB); 32 GB or smaller'],
    sketch: {
      default: `
#include <SPI.h>
#include <SD.h>

const int CS_PIN = {{CS}};

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  if (!SD.begin(CS_PIN)) {
    Serial.println("SD failed: wiring, CS pin, FAT32 formatting, or the card wants 3.3 V");
    while (true) delay(10);
  }
  File f = SD.open("log.txt", FILE_WRITE);  // creates it, writes at the end
  if (f) { f.println("hello from the board"); f.close(); Serial.println("written"); }
  else Serial.println("could not open log.txt");
}

void loop() {}
`,
      esp32: `
#include <SPI.h>
#include <SD.h>

const int CS_PIN = {{CS}};

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  if (!SD.begin(CS_PIN)) {
    Serial.println("SD failed: wiring, CS pin, FAT32 formatting, or the card wants 3.3 V");
    while (true) delay(10);
  }
  File f = SD.open("/log.txt", FILE_APPEND);  // ESP32: paths start with '/'; FILE_WRITE would truncate
  if (f) { f.println("hello from the board"); f.close(); Serial.println("written"); }
  else Serial.println("could not open /log.txt");
}

void loop() {}
`,
    },
  },
  'rtc': {
    libs: ['RTClib', 'Adafruit BusIO'],
    pins: I2C_WIRING,
    wiring: i2cWiring('VCC → 3.3 V or 5 V (DS3231); 5 V (DS1307)'),
    sketch: `
#include <Wire.h>
#include <RTClib.h>

RTC_DS3231 rtc;  // RTC_DS1307 rtc; for the DS1307

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  if (!rtc.begin()) { Serial.println("RTC not found"); while (true) delay(10); }
  if (rtc.lostPower()) rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));  // set once from the compile time
}

void loop() {
  DateTime now = rtc.now();
  char buf[] = "YYYY-MM-DD hh:mm:ss";
  Serial.println(now.toString(buf));
  delay(1000);
}
`,
  },
  'bh1750': {
    libs: ['BH1750'],
    pins: I2C_WIRING,
    wiring: i2cWiring(),
    sketch: `
#include <Wire.h>
#include <BH1750.h>

BH1750 lightMeter;  // 0x23 with ADDR low; BH1750 lightMeter(0x5C); with ADDR high

void setup() {
  Serial.begin(115200);
  Wire.begin();
  lightMeter.begin();
}

void loop() {
  Serial.print(lightMeter.readLightLevel()); Serial.println(" lx");
  delay(500);
}
`,
  },
  'vl53l0x': {
    libs: ['Adafruit_VL53L0X', 'Adafruit BusIO'],
    pins: I2C_WIRING,
    wiring: i2cWiring(),
    sketch: `
#include <Wire.h>
#include <Adafruit_VL53L0X.h>

Adafruit_VL53L0X lox;

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  if (!lox.begin()) { Serial.println("VL53L0X not found"); while (true) delay(10); }
}

void loop() {
  VL53L0X_RangingMeasurementData_t m;
  lox.rangingTest(&m, false);
  if (m.RangeStatus != 4) { Serial.print(m.RangeMilliMeter); Serial.println(" mm"); }
  else Serial.println("out of range");
  delay(100);
}
`,
  },
  'ads1115': {
    libs: ['Adafruit ADS1X15', 'Adafruit BusIO'],
    pins: I2C_WIRING,
    wiring: [...i2cWiring(), 'ADDR → GND for 0x48 (VDD 0x49, SDA 0x4A, SCL 0x4B)', 'A0–A3 → the signals (never above VDD + 0.3 V)'],
    sketch: `
#include <Wire.h>
#include <Adafruit_ADS1X15.h>

Adafruit_ADS1115 ads;  // Adafruit_ADS1015 ads; for the 12-bit part

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  ads.setGain(GAIN_ONE);  // ±4.096 V full scale
  if (!ads.begin()) { Serial.println("ADS1115 not found"); while (true) delay(10); }  // ads.begin(0x49) with ADDR to VDD
}

void loop() {
  int16_t raw = ads.readADC_SingleEnded(0);
  Serial.print(raw); Serial.print("  "); Serial.print(ads.computeVolts(raw), 4); Serial.println(" V");
  delay(500);
}
`,
  },
  'ina219': {
    libs: ['Adafruit INA219', 'Adafruit BusIO'],
    pins: I2C_WIRING,
    wiring: [...i2cWiring(), 'VIN+ → supply, VIN− → the load (the shunt sits in the positive lead); GND shared with the load'],
    sketch: `
#include <Wire.h>
#include <Adafruit_INA219.h>

Adafruit_INA219 ina219;  // 0x40

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  if (!ina219.begin()) { Serial.println("INA219 not found"); while (true) delay(10); }
}

void loop() {
  Serial.print(ina219.getBusVoltage_V()); Serial.print(" V  ");
  Serial.print(ina219.getCurrent_mA()); Serial.print(" mA  ");
  Serial.print(ina219.getPower_mW()); Serial.println(" mW");
  delay(1000);
}
`,
  },
  'pca9685': {
    libs: ['Adafruit PWM Servo Driver Library', 'Adafruit BusIO'],
    pins: I2C_WIRING,
    wiring: [...i2cWiring('VCC → 3.3 V or 5 V (logic)'), 'V+ → 5–6 V servo supply through the screw terminal (its own supply; GND shared)', 'Servos on channels 0–15 (signal, V+, GND rows)'],
    sketch: `
#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>

Adafruit_PWMServoDriver pwm;  // 0x40

const int SERVO_MIN = 110, SERVO_MAX = 500;  // ticks of 4096 at 50 Hz (about 0.5–2.4 ms); tune per servo

void setup() {
  pwm.begin();
  pwm.setPWMFreq(50);
}

void loop() {
  pwm.setPWM(0, 0, SERVO_MIN); delay(1000);  // channel 0 to one end
  pwm.setPWM(0, 0, SERVO_MAX); delay(1000);  // and the other
}
`,
  },
  'hx711': {
    libs: ['HX711 Arduino Library'],
    pins: { default: { DT: 3, SCK: 2 }, esp32: { DT: 16, SCK: 4 }, esp32c3: { DT: 4, SCK: 5 }, esp32c6: { DT: 2, SCK: 3 } },
    inputs: ['DT'],
    wiring: ['VCC → 3.3 V or 5 V; GND → GND', 'DT → pin {{DT}}; SCK → pin {{SCK}}', 'Load cell: red → E+, black → E−, white → A−, green → A+'],
    sketch: `
#include <HX711.h>

HX711 scale;
const int DT_PIN = {{DT}}, SCK_PIN = {{SCK}};

void setup() {
  Serial.begin(115200);
  scale.begin(DT_PIN, SCK_PIN);
  scale.set_scale();  // 1 = raw units; put a known weight on and divide to find your factor
  scale.tare();       // zero with nothing on the cell
}

void loop() {
  if (scale.is_ready()) Serial.println(scale.get_units(5), 1);
  else Serial.println("HX711 not ready");
  delay(500);
}
`,
  },
  'nrf24l01': {
    libs: ['RF24'],
    pins: { default: { CE: 9, CSN: 10, MOSI: 11, MISO: 12, SCK: 13 }, esp32: { CE: 4, CSN: 27, MOSI: 23, MISO: 19, SCK: 18 }, esp32s3: { CE: 4, CSN: 10, MOSI: 11, MISO: 13, SCK: 12 }, esp32s2: { CE: 4, CSN: 34, MOSI: 35, MISO: 37, SCK: 36 }, esp32c3: { CE: 10, CSN: 7, MOSI: 6, MISO: 5, SCK: 4 }, esp32c6: { CE: 2, CSN: 18, MOSI: 19, MISO: 20, SCK: 21 }, rp2040: { CE: 20, CSN: 17, MOSI: 19, MISO: 16, SCK: 18 } },
    wiring: ['VCC → 3.3 V ONLY with a 10 µF capacitor across VCC/GND at the module; GND → GND', 'CE → pin {{CE}}; CSN → pin {{CSN}}', 'MOSI → pin {{MOSI}}; MISO → pin {{MISO}}; SCK → pin {{SCK}}', 'Short wires; the same code on both boards with isSender flipped'],
    sketch: `
#include <SPI.h>
#include <RF24.h>

RF24 radio({{CE}}, {{CSN}});  // CE, CSN
const byte ADDRESS[6] = "node1";
bool isSender = true;  // flash false onto the other board

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  if (!radio.begin()) { Serial.println("nRF24 not found (3.3 V supply, 10 uF across it, short wires)"); while (true) delay(10); }
  radio.setPALevel(RF24_PA_LOW);
  radio.setDataRate(RF24_1MBPS);
  if (isSender) { radio.openWritingPipe(ADDRESS); radio.stopListening(); }
  else { radio.openReadingPipe(1, ADDRESS); radio.startListening(); }
}

void loop() {
  if (isSender) {
    unsigned long t = millis();
    Serial.println(radio.write(&t, sizeof(t)) ? "sent" : "no ack");
    delay(1000);
  } else if (radio.available()) {
    unsigned long t;
    radio.read(&t, sizeof(t));
    Serial.print("got "); Serial.println(t);
  }
}
`,
  },
  'soil-moisture': {
    pins: ANALOG_IN,
    analog: ['AIN'],
    params: { default: { DRY: 800, WET: 400 }, esp32: { DRY: 3000, WET: 1200 }, rp2040: { DRY: 800, WET: 400 }, 'nano-esp32': { DRY: 3000, WET: 1200 } },
    wiring: ['VCC → 3.3 V or 5 V (or a GPIO, HIGH only while reading, to slow corrosion of resistive probes); GND → GND', 'AOUT → pin {{AIN}} (analog); DOUT is a threshold output set by the pot, usually unused'],
    sketch: `
const int SENSOR_PIN = {{AIN}};
const int DRY = {{DRY}}, WET = {{WET}};  // measure yours: the reading in air, then in water

void setup() { Serial.begin(115200); }

void loop() {
  int raw = analogRead(SENSOR_PIN);
  int percent = constrain(map(raw, DRY, WET, 0, 100), 0, 100);
  Serial.print(raw); Serial.print("  "); Serial.print(percent); Serial.println(" %");
  delay(1000);
}
`,
  },
  'mq-gas': {
    pins: ANALOG_IN,
    analog: ['AIN'],
    wiring: ['VCC → 5 V (the heater draws about 150 mA; not from a 3V3 pin); GND → GND', 'AO → pin {{AIN}} directly on 5 V boards; on 3.3 V boards through a 1 kΩ/2 kΩ divider (AO goes up to 5 V)', 'DO → optional digital threshold set by the pot'],
    sketch: `
const int MQ_PIN = {{AIN}};

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  Serial.println("warming up: 2-3 minutes for stable readings, 24 h burn-in for a new sensor");
}

void loop() {
  Serial.println(analogRead(MQ_PIN));  // relative level; ppm needs the datasheet curve and a clean-air baseline (R0)
  delay(1000);
}
`,
  },
  // ── ESP32 features ───────────────────────────────────────────────────────
  'esp32-wifi': {
    sketch: { esp32: `
#include <WiFi.h>
#include <HTTPClient.h>

const char* WIFI_SSID = "your-network";  // 2.4 GHz only
const char* WIFI_PASS = "your-password";

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("connecting");
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print('.'); }
  Serial.println();
  Serial.print("IP "); Serial.println(WiFi.localIP());
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin("http://worldtimeapi.org/api/ip");  // https: WiFiClientSecure client; client.setInsecure(); http.begin(client, url)
    int code = http.GET();
    if (code > 0) { Serial.println(code); Serial.println(http.getString().substring(0, 200)); }
    else Serial.println(http.errorToString(code));
    http.end();
  }
  delay(10000);
}
` },
  },
  'esp32-webserver': {
    pins: { esp32: { LED: 4 }, esp32c6: { LED: 2 } },
    wiring: ['LED anode → 220 Ω → pin {{LED}}; cathode → GND (or drive a relay the same way)'],
    sketch: { esp32: `
#include <WiFi.h>
#include <WebServer.h>

const char* WIFI_SSID = "your-network";
const char* WIFI_PASS = "your-password";
const int LED_PIN = {{LED}};
WebServer server(80);

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  pinMode(LED_PIN, OUTPUT);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(500);
  Serial.print("open http://"); Serial.println(WiFi.localIP());
  server.on("/", []() { server.send(200, "text/html", "<h1>Board</h1><a href='/on'>LED on</a> | <a href='/off'>LED off</a>"); });
  server.on("/on", []() { digitalWrite(LED_PIN, HIGH); server.sendHeader("Location", "/"); server.send(303); });
  server.on("/off", []() { digitalWrite(LED_PIN, LOW); server.sendHeader("Location", "/"); server.send(303); });
  server.begin();
}

void loop() { server.handleClient(); }
` },
  },
  'esp32-mqtt': {
    libs: { esp32: ['PubSubClient'] },
    sketch: { esp32: `
#include <WiFi.h>
#include <PubSubClient.h>

const char* WIFI_SSID = "your-network";
const char* WIFI_PASS = "your-password";
const char* MQTT_HOST = "broker.hivemq.com";  // public test broker: port 1883, no login, anyone can read it

WiFiClient net;
PubSubClient mqtt(net);

void onMessage(char* topic, byte* payload, unsigned int length) {
  Serial.print(topic); Serial.print(": ");
  Serial.write(payload, length);
  Serial.println();
}

void connectMqtt() {
  while (!mqtt.connected()) {
    String id = "impulse-" + String((uint32_t)ESP.getEfuseMac(), HEX);
    if (mqtt.connect(id.c_str())) mqtt.subscribe("impulse/demo/cmd");  // mqtt.connect(id, user, pass) for a private broker
    else delay(2000);
  }
}

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(500);
  mqtt.setServer(MQTT_HOST, 1883);
  mqtt.setCallback(onMessage);
}

void loop() {
  if (!mqtt.connected()) connectMqtt();
  mqtt.loop();  // keeps the connection alive and delivers messages
  static unsigned long last = 0;
  if (millis() - last > 5000) {
    last = millis();
    mqtt.publish("impulse/demo/uptime", String(millis() / 1000).c_str());
  }
}
` },
  },
  'esp-now': {
    sketch: { esp32: `
#include <WiFi.h>
#include <esp_now.h>

// Flash this on both boards. Broadcast reaches every ESP32 nearby; put the other board's MAC
// (it prints "my MAC") in PEER to talk to it alone.
uint8_t PEER[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

struct Message { uint32_t count; float value; };

// The receive callback changed in core 3.x. This builds on both: core 3.x (Espressif's ESP32
// boards) and 2.x (older installs, and Arduino's own core for the Nano ESP32).
#if ESP_ARDUINO_VERSION_MAJOR >= 3
void onReceive(const esp_now_recv_info_t* info, const uint8_t* data, int len) {
  const uint8_t* mac = info->src_addr;
#else
void onReceive(const uint8_t* mac, const uint8_t* data, int len) {
#endif
  Message m;
  memcpy(&m, data, sizeof(m));
  Serial.printf("from %02X:%02X:%02X:%02X:%02X:%02X  count %lu  value %.2f\\n",
                mac[0], mac[1], mac[2], mac[3], mac[4], mac[5], (unsigned long)m.count, m.value);
}

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  WiFi.mode(WIFI_STA);  // required; both boards must also sit on the same Wi-Fi channel
  Serial.print("my MAC "); Serial.println(WiFi.macAddress());
  if (esp_now_init() != ESP_OK) { Serial.println("esp_now_init failed"); while (true) delay(10); }
  esp_now_register_recv_cb(onReceive);
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, PEER, 6);
  peer.channel = 0;
  peer.encrypt = false;
  esp_now_add_peer(&peer);
}

void loop() {
  static Message m = {0, 0};
  m.count++;
  m.value = millis() / 1000.0f;
  esp_now_send(PEER, (uint8_t*)&m, sizeof(m));
  delay(2000);
}
` },
  },
  'esp32-deep-sleep': {
    sketch: { esp32: `
#include <esp_sleep.h>

RTC_DATA_ATTR int bootCount = 0;  // RTC memory survives deep sleep (not a power cycle)
const uint64_t SLEEP_SECONDS = 10;

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (S3, C3, S2): the port re-enumerates and the monitor reconnects 1–2 s after wake
  bootCount++;
  Serial.printf("Boot %d, wake cause %d\\n", bootCount, (int)esp_sleep_get_wakeup_cause());  // 4 = timer, 2 = ext0 pin, 0 = power-on/reset
  Serial.println("Working for 3 s...");
  delay(3000);
  esp_sleep_enable_timer_wakeup(SLEEP_SECONDS * 1000000ULL);
  // Wake on a pin too: classic/S2/S3 esp_sleep_enable_ext0_wakeup(GPIO_NUM_4, 0) on an RTC pin; C3/C6 esp_deep_sleep_enable_gpio_wakeup().
  Serial.println("Sleeping");
  Serial.flush();
  esp_deep_sleep_start();  // never returns: the chip restarts in setup()
}

void loop() {}
` },
  },
  'esp32-preferences': {
    sketch: { esp32: `
#include <Preferences.h>

Preferences prefs;
uint32_t boots = 0;

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  prefs.begin("app", false);  // namespace (up to 15 chars), read-write
  boots = prefs.getUInt("boots", 0) + 1;
  prefs.putUInt("boots", boots);  // also putString, putFloat, putBool, putBytes
  prefs.end();
  // EEPROM.h still works on the ESP32, but Preferences (NVS) wears the flash evenly and survives re-uploads.
}

void loop() {
  // Said again every few seconds, so a serial monitor opened late still sees it.
  Serial.printf("This board has booted %lu times\\n", (unsigned long)boots);
  delay(5000);
}
` },
  },
  'esp32-ledc': {
    pins: { esp32: { PWM: 4 }, esp32c6: { PWM: 2 } },
    wiring: ['LED anode → 220 Ω → pin {{PWM}}; cathode → GND (any output-capable pin works)'],
    sketch: { esp32: `
const int PWM_PIN = {{PWM}};
const int FREQ = 5000, RESOLUTION = 8;  // 8 bits: duty 0–255

void setup() {
  ledcAttach(PWM_PIN, FREQ, RESOLUTION);  // core 3.x: pins, not channels (ledcSetup/ledcAttachPin are gone)
}

void loop() {
  for (int d = 0; d <= 255; d += 5) { ledcWrite(PWM_PIN, d); delay(8); }
  for (int d = 255; d >= 0; d -= 5) { ledcWrite(PWM_PIN, d); delay(8); }
  // analogWrite(pin, 0–255) also works on the ESP32 core; for servos use ESP32Servo.
}
` },
  },
  'esp32-touch': {
    pins: { esp32: { TOUCH: 4 }, esp32s2: { TOUCH: 1 }, esp32s3: { TOUCH: 1 }, esp32c3: null, esp32c6: null, esp32h2: null },
    params: { esp32: { NOTE: 'T0 = GPIO4; values about 70 that DROP when touched' }, esp32s2: { NOTE: 'T1 = GPIO1; values about 20,000–30,000 that RISE when touched' }, esp32s3: { NOTE: 'T1 = GPIO1; values about 20,000–30,000 that RISE when touched' } },
    wiring: ['A wire, foil pad or screw → pin {{TOUCH}} ({{NOTE}}); nothing else'],
    sketch: { esp32: `
// Classic ESP32: T0..T9 (T0 = GPIO4, T3 = GPIO15, T4 = GPIO13, T5 = GPIO12, T6 = GPIO14, T7 = GPIO27, T8 = GPIO33, T9 = GPIO32):
//   readings around 70 that DROP when touched.
// ESP32-S2/S3: T1..T14 = GPIO1..14: readings around 20,000–30,000 that RISE when touched.
// The C3, C6 and H2 have no touch pads.
const int TOUCH_PIN = {{TOUCH}};

void setup() {
  Serial.begin(115200);
  delay(500);
}

void loop() {
  uint32_t v = touchRead(TOUCH_PIN);
  Serial.println(v);
  delay(200);
}
` },
  },
  'esp32-ble': {
    pins: { esp32: {}, esp32s2: null },
    sketch: { esp32: `
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// Open "nRF Connect" on a phone, connect to "Impulse", and watch the value change once a second.
// A BLE sketch is about 1.2 MB: pick Partition Scheme "Huge APP" or "Minimal SPIFFS" in Board Options if it does not fit.
#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"

BLECharacteristic* characteristic;

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  BLEDevice::init("Impulse");
  BLEServer* server = BLEDevice::createServer();
  BLEService* service = server->createService(SERVICE_UUID);
  characteristic = service->createCharacteristic(CHARACTERISTIC_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  characteristic->addDescriptor(new BLE2902());
  service->start();
  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->start();
  Serial.println("advertising as Impulse");
}

void loop() {
  String value = String(millis() / 1000);
  characteristic->setValue(value.c_str());
  characteristic->notify();
  delay(1000);
}
` },
  },
  // ── Round 3: displays ────────────────────────────────────────────────────
  'sh1106': {
    libs: ['Adafruit SH110X', 'Adafruit GFX Library', 'Adafruit BusIO'],
    pins: I2C_WIRING,
    wiring: i2cWiring(),
    sketch: `
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SH110X.h>

Adafruit_SH1106G display = Adafruit_SH1106G(128, 64, &Wire, -1);  // 1.3" OLEDs are SH1106, not SSD1306

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  delay(250);  // the OLED needs a moment after power-up
  if (!display.begin(0x3C, true)) {  // 0x3D on some modules: run an I2C scanner
    Serial.println("SH1106 not found");
    while (true) delay(10);
  }
  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(SH110X_WHITE);
  display.setCursor(0, 0);
  display.println("Hello");
  display.display();  // nothing shows until this
}

void loop() {}
`,
  },
  'ili9341': {
    libs: ['Adafruit ILI9341', 'Adafruit GFX Library', 'Adafruit BusIO'],
    pins: {
      default: { CS: 10, DC: 9, RST: 8 },
      esp32: { CS: 27, DC: 26, RST: 25 },
      esp32s2: { CS: 34, DC: 38, RST: 39 },
      esp32s3: { CS: 10, DC: 14, RST: 15 },
      esp32c3: { CS: 7, DC: 3, RST: 10 },
      esp32c6: { CS: 18, DC: 2, RST: 3 },
      rp2040: { CS: 17, DC: 20, RST: 21 },
    },
    params: {
      ...SPI_BUS,
      default: { ...SPI_BUS.default, LEVEL: 'through a level shifter: the panel takes 3.3 V logic and a 5 V board can damage it' },
      esp32: { ...SPI_BUS.esp32, LEVEL: 'directly (3.3 V logic on both sides)' },
      rp2040: { ...SPI_BUS.rp2040, LEVEL: 'directly (3.3 V logic on both sides)' },
      'nano-esp32': { ...SPI_BUS['nano-esp32'], LEVEL: 'directly (3.3 V logic on both sides)' },
    },
    wiring: ['VCC → 3.3 V (5 V only on modules with a regulator); GND → GND; LED (backlight) → 3.3 V', 'CS → pin {{CS}}; DC → pin {{DC}}; RESET → pin {{RST}}', 'SDI/MOSI, SDO/MISO and SCK → the board\'s SPI pins ({{BUS}}), {{LEVEL}}'],
    sketch: `
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>

#define TFT_CS  {{CS}}
#define TFT_DC  {{DC}}
#define TFT_RST {{RST}}

// Hardware SPI on the board's SPI pins. For an ST7789 panel: #include <Adafruit_ST7789.h>,
// Adafruit_ST7789 tft(TFT_CS, TFT_DC, TFT_RST); and tft.init(240, 240) instead of begin().
Adafruit_ILI9341 tft = Adafruit_ILI9341(TFT_CS, TFT_DC, TFT_RST);

void setup() {
  tft.begin();
  tft.setRotation(1);
  tft.fillScreen(ILI9341_BLACK);
  tft.setTextColor(ILI9341_WHITE);
  tft.setTextSize(3);
  tft.setCursor(20, 20);
  tft.println("Hello");
}

void loop() {
  tft.fillRect(20, 80, 220, 30, ILI9341_BLACK);
  tft.setCursor(20, 80);
  tft.print(millis() / 1000);
  tft.print(" s");
  delay(1000);
}
`,
  },
  'epaper': {
    libs: ['GxEPD2', 'Adafruit GFX Library', 'Adafruit BusIO'],
    pins: {
      default: { CS: 10, DC: 9, RST: 8, BUSY: 7 },
      esp32: { CS: 27, DC: 26, RST: 25, BUSY: 33 },
      esp32s2: { CS: 34, DC: 38, RST: 39, BUSY: 40 },
      esp32s3: { CS: 10, DC: 14, RST: 15, BUSY: 16 },
      esp32c3: { CS: 7, DC: 3, RST: 10, BUSY: 1 },
      esp32c6: { CS: 18, DC: 2, RST: 3, BUSY: 6 },
      rp2040: { CS: 17, DC: 20, RST: 21, BUSY: 22 },
    },
    inputs: ['BUSY'],
    params: {
      ...SPI_BUS,
      // AVR boards draw the screen in pages of 25 rows (625 bytes of RAM); the others hold it whole.
      default: { ...SPI_BUS.default, PAGE: 'GxEPD2_154_D67::HEIGHT / 8', LEVEL: 'through a level shifter unless the module has one: the panel takes 3.3 V logic' },
      esp32: { ...SPI_BUS.esp32, PAGE: 'GxEPD2_154_D67::HEIGHT', LEVEL: 'directly' },
      rp2040: { ...SPI_BUS.rp2040, PAGE: 'GxEPD2_154_D67::HEIGHT', LEVEL: 'directly' },
      'nano-esp32': { ...SPI_BUS['nano-esp32'], PAGE: 'GxEPD2_154_D67::HEIGHT', LEVEL: 'directly' },
    },
    wiring: ['VCC → 3.3 V; GND → GND', 'CS → pin {{CS}}; DC → pin {{DC}}; RST → pin {{RST}}; BUSY → pin {{BUSY}}', 'DIN → MOSI, CLK → SCK of the board\'s SPI pins ({{BUS}}), {{LEVEL}}'],
    sketch: `
#include <GxEPD2_BW.h>
#include <Fonts/FreeMonoBold12pt7b.h>

// A 1.54" 200x200 panel (GDEY0154D67, Waveshare 1.54" V2). For other sizes, pick the matching
// class from GxEPD2's examples: the wrong class shows garbage or nothing.
GxEPD2_BW<GxEPD2_154_D67, {{PAGE}}> display(GxEPD2_154_D67(/*CS=*/ {{CS}}, /*DC=*/ {{DC}}, /*RST=*/ {{RST}}, /*BUSY=*/ {{BUSY}}));

void setup() {
  Serial.begin(115200);
  display.init(115200);  // prints the panel's diagnostics on Serial
  display.setRotation(1);
  display.setFont(&FreeMonoBold12pt7b);
  display.setTextColor(GxEPD_BLACK);
  display.setFullWindow();
  display.firstPage();
  do {
    display.fillScreen(GxEPD_WHITE);
    display.setCursor(10, 40);
    display.print("Hello");
  } while (display.nextPage());
  display.hibernate();  // e-paper keeps the image with no power
}

void loop() {}
`,
  },
  'seven-segment': {
    pins: {
      default: { A: 2, B: 3, C: 4, D: 5, E: 6, F: 7, G: 8, DP: 9 },
      esp32: { A: 13, B: 14, C: 16, D: 17, E: 18, F: 19, G: 21, DP: 22 },
      esp32s2: { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, DP: 8 },
      esp32s3: { A: 1, B: 2, C: 4, D: 5, E: 6, F: 7, G: 15, DP: 16 },
      esp32c3: { A: 0, B: 1, C: 3, D: 4, E: 5, F: 6, G: 7, DP: 10 },
      esp32c6: { A: 0, B: 1, C: 2, D: 3, E: 6, F: 7, G: 10, DP: 11 },
      rp2040: { A: 2, B: 3, C: 4, D: 5, E: 6, F: 7, G: 8, DP: 9 },
    },
    wiring: ['Segments a, b, c, d, e, f, g, dp → pins {{A}}, {{B}}, {{C}}, {{D}}, {{E}}, {{F}}, {{G}}, {{DP}}, each through its own 220 Ω resistor', 'COM → GND for a common-cathode display, or VCC for common-anode (then set COMMON_ANODE to true)'],
    sketch: `
// Segment pins a, b, c, d, e, f, g, dp, each through its own 220 Ω resistor.
const int SEG[8] = { {{A}}, {{B}}, {{C}}, {{D}}, {{E}}, {{F}}, {{G}}, {{DP}} };
const bool COMMON_ANODE = false;  // true when COM goes to VCC

// Bit 0 is segment a … bit 6 is g.
const byte DIGITS[10] = {
  0b00111111, 0b00000110, 0b01011011, 0b01001111, 0b01100110,
  0b01101101, 0b01111101, 0b00000111, 0b01111111, 0b01101111
};

void show(int digit) {
  for (int s = 0; s < 7; s++) {
    bool on = DIGITS[digit] & (1 << s);
    digitalWrite(SEG[s], on != COMMON_ANODE ? HIGH : LOW);
  }
  digitalWrite(SEG[7], COMMON_ANODE ? HIGH : LOW);  // decimal point off
}

void setup() {
  for (int s = 0; s < 8; s++) pinMode(SEG[s], OUTPUT);
}

void loop() {
  for (int d = 0; d < 10; d++) {
    show(d);
    delay(700);
  }
}
`,
  },
  // ── Round 3: sensors ─────────────────────────────────────────────────────
  'bmp180': {
    libs: ['Adafruit BMP085 Library', 'Adafruit BusIO'],
    pins: I2C_WIRING,
    wiring: i2cWiring(),
    sketch: `
#include <Wire.h>
#include <Adafruit_BMP085.h>

Adafruit_BMP085 bmp;  // the BMP180 and BMP085 share this driver (address 0x77)

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  if (!bmp.begin()) {
    Serial.println("BMP180 not found");
    while (true) delay(10);
  }
}

void loop() {
  Serial.print(bmp.readTemperature()); Serial.print(" C  ");
  Serial.print(bmp.readPressure() / 100.0); Serial.print(" hPa  ");
  Serial.print(bmp.readAltitude()); Serial.println(" m (at standard sea-level pressure)");
  delay(1000);
}
`,
  },
  'aht20': {
    libs: ['Adafruit AHTX0', 'Adafruit Unified Sensor', 'Adafruit BusIO'],
    pins: I2C_WIRING,
    wiring: i2cWiring(),
    sketch: `
#include <Wire.h>
#include <Adafruit_AHTX0.h>

Adafruit_AHTX0 aht;  // AHT10, AHT20 and AHT21 at 0x38

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  if (!aht.begin()) {
    Serial.println("AHT20 not found");
    while (true) delay(10);
  }
}

void loop() {
  sensors_event_t humidity, temp;
  aht.getEvent(&humidity, &temp);
  Serial.print(temp.temperature); Serial.print(" C  ");
  Serial.print(humidity.relative_humidity); Serial.println(" %");
  delay(1000);
}
`,
  },
  'sht3x': {
    libs: ['Adafruit SHT31 Library', 'Adafruit BusIO'],
    pins: I2C_WIRING,
    wiring: i2cWiring(),
    sketch: `
#include <Wire.h>
#include <Adafruit_SHT31.h>

Adafruit_SHT31 sht31 = Adafruit_SHT31();  // SHT40/41/45 use the Adafruit SHT4x library instead

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  if (!sht31.begin(0x44)) {  // 0x45 when ADDR is tied to VCC
    Serial.println("SHT31 not found");
    while (true) delay(10);
  }
}

void loop() {
  float t = sht31.readTemperature();
  float h = sht31.readHumidity();
  if (isnan(t) || isnan(h)) {
    Serial.println("SHT31 read failed");
  } else {
    Serial.print(t); Serial.print(" C  ");
    Serial.print(h); Serial.println(" %");
  }
  delay(1000);
}
`,
  },
  'scd4x': {
    libs: ['SparkFun SCD4x Arduino Library'],
    pins: I2C_WIRING,
    wiring: i2cWiring(),
    sketch: `
#include <Wire.h>
#include "SparkFun_SCD4x_Arduino_Library.h"

SCD4x co2Sensor;  // SCD40 and SCD41 at 0x62

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  Wire.begin();
  if (!co2Sensor.begin()) {  // also starts measuring: one reading every 5 s
    Serial.println("SCD4x not found");
    while (true) delay(10);
  }
}

void loop() {
  if (co2Sensor.readMeasurement()) {  // true when a new reading is ready
    Serial.print(co2Sensor.getCO2()); Serial.print(" ppm  ");
    Serial.print(co2Sensor.getTemperature(), 1); Serial.print(" C  ");
    Serial.print(co2Sensor.getHumidity(), 1); Serial.println(" %");
  }
  delay(500);
}
`,
  },
  'adxl345': {
    libs: ['Adafruit ADXL345', 'Adafruit Unified Sensor', 'Adafruit BusIO'],
    pins: I2C_WIRING,
    wiring: i2cWiring(),
    sketch: `
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_ADXL345_U.h>

Adafruit_ADXL345_Unified accel = Adafruit_ADXL345_Unified(12345);

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  if (!accel.begin()) {  // 0x53 with SDO to GND; accel.begin(0x1D) with SDO to VCC
    Serial.println("ADXL345 not found");
    while (true) delay(10);
  }
  accel.setRange(ADXL345_RANGE_4_G);
}

void loop() {
  sensors_event_t event;
  accel.getEvent(&event);
  Serial.print("x "); Serial.print(event.acceleration.x);
  Serial.print("  y "); Serial.print(event.acceleration.y);
  Serial.print("  z "); Serial.print(event.acceleration.z);
  Serial.println(" m/s2");
  delay(200);
}
`,
  },
  'lis3dh': {
    libs: ['Adafruit LIS3DH', 'Adafruit Unified Sensor', 'Adafruit BusIO'],
    pins: I2C_WIRING,
    wiring: i2cWiring(),
    sketch: `
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_LIS3DH.h>

Adafruit_LIS3DH lis = Adafruit_LIS3DH();

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  if (!lis.begin(0x18)) {  // 0x19 with SA0 to VCC
    Serial.println("LIS3DH not found");
    while (true) delay(10);
  }
  lis.setRange(LIS3DH_RANGE_4_G);
}

void loop() {
  sensors_event_t event;
  lis.getEvent(&event);
  Serial.print("x "); Serial.print(event.acceleration.x);
  Serial.print("  y "); Serial.print(event.acceleration.y);
  Serial.print("  z "); Serial.print(event.acceleration.z);
  Serial.println(" m/s2");
  delay(200);
}
`,
  },
  'compass': {
    libs: ['QMC5883LCompass'],
    pins: I2C_WIRING,
    wiring: i2cWiring(),
    sketch: `
#include <Wire.h>
#include <QMC5883LCompass.h>

// Most GY-273 boards sold now carry a QMC5883L (address 0x0D). An HMC5883L (0x1E)
// needs the Adafruit HMC5883 Unified library instead; an I2C scanner tells which you have.
QMC5883LCompass compass;

void setup() {
  Serial.begin(115200);
  compass.init();
}

void loop() {
  compass.read();
  Serial.print("x "); Serial.print(compass.getX());
  Serial.print("  y "); Serial.print(compass.getY());
  Serial.print("  z "); Serial.print(compass.getZ());
  Serial.print("  heading "); Serial.println(compass.getAzimuth());  // calibrate away from steel for true north
  delay(250);
}
`,
  },
  'potentiometer': {
    pins: ANALOG_IN,
    analog: ['AIN'],
    params: { default: { REF: '5 V (3.3 V on a 3.3 V board)', MAX: 1023 }, esp32: { REF: '3.3 V', MAX: 4095 }, rp2040: { REF: '3.3 V', MAX: 1023 }, 'nano-esp32': { REF: '3.3 V', MAX: 4095 } },
    wiring: ['One outer leg → {{REF}}; the other outer leg → GND', 'Middle leg (wiper) → pin {{AIN}}'],
    sketch: `
const int POT_PIN = {{AIN}};  // the middle leg

void setup() {
  Serial.begin(115200);
}

void loop() {
  int raw = analogRead(POT_PIN);  // 0 to {{MAX}}
  int percent = map(raw, 0, {{MAX}}, 0, 100);
  Serial.print(raw); Serial.print("  "); Serial.print(percent); Serial.println(" %");
  delay(100);
}
`,
  },
  'pn532': {
    libs: ['Adafruit PN532', 'Adafruit BusIO'],
    pins: {
      default: { IRQ: 2, RST: 3 },
      esp32: { IRQ: 4, RST: 13 },
      esp32s2: { IRQ: 4, RST: 5 },
      esp32s3: { IRQ: 4, RST: 5 },
      esp32c3: { IRQ: 3, RST: 10 },
      esp32c6: { IRQ: 2, RST: 3 },
      rp2040: { IRQ: 6, RST: 7 },
    },
    inputs: ['IRQ'],
    wiring: [...i2cWiring('VCC → 5 V or 3.3 V (the module regulates)'), 'IRQ → pin {{IRQ}}; RSTO → pin {{RST}}', 'Set the mode switches to I²C (on the red V3 boards: switch 1 ON, switch 2 OFF)'],
    sketch: `
#include <Wire.h>
#include <Adafruit_PN532.h>

Adafruit_PN532 nfc({{IRQ}}, {{RST}});  // I2C mode: the IRQ and reset pins

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  nfc.begin();
  uint32_t version = nfc.getFirmwareVersion();
  if (!version) {
    Serial.println("PN532 not found: check the mode switches (I2C) and the wiring");
    while (true) delay(10);
  }
  Serial.print("PN532 firmware ");
  Serial.print((version >> 16) & 0xFF); Serial.print('.'); Serial.println((version >> 8) & 0xFF);
  nfc.SAMConfig();
  Serial.println("Hold a card near the reader");
}

void loop() {
  uint8_t uid[7];
  uint8_t uidLength;
  if (nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLength, 1000)) {
    Serial.print("UID:");
    for (uint8_t i = 0; i < uidLength; i++) {
      Serial.print(uid[i] < 0x10 ? " 0" : " ");
      Serial.print(uid[i], HEX);
    }
    Serial.println();
    delay(1000);
  }
}
`,
  },
  'mlx90614': {
    libs: ['Adafruit MLX90614 Library', 'Adafruit BusIO'],
    pins: I2C_WIRING,
    wiring: i2cWiring(),
    sketch: `
#include <Wire.h>
#include <Adafruit_MLX90614.h>

Adafruit_MLX90614 mlx = Adafruit_MLX90614();  // 0x5A

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  if (!mlx.begin()) {
    Serial.println("MLX90614 not found");
    while (true) delay(10);
  }
}

void loop() {
  Serial.print("object "); Serial.print(mlx.readObjectTempC()); Serial.print(" C  ");
  Serial.print("ambient "); Serial.print(mlx.readAmbientTempC()); Serial.println(" C");
  delay(500);
}
`,
  },
  'pulse-oximeter': {
    libs: ['SparkFun MAX3010x Pulse and Proximity Sensor Library'],
    pins: I2C_WIRING,
    wiring: i2cWiring('VIN → 3.3 V (some purple modules pull SDA/SCL up to 1.8 V and fail on 5 V boards)'),
    sketch: `
#include <Wire.h>
#include "MAX30105.h"
#include "heartRate.h"

MAX30105 sensor;  // the MAX30102 and MAX30105 share this driver
const byte RATE_SIZE = 4;
byte rates[RATE_SIZE];
byte rateSpot = 0;
unsigned long lastBeat = 0;

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  if (!sensor.begin(Wire, I2C_SPEED_FAST)) {
    Serial.println("MAX30102 not found");
    while (true) delay(10);
  }
  sensor.setup();                    // default LED settings
  sensor.setPulseAmplitudeRed(0x0A);  // a dim red LED shows it is on
  sensor.setPulseAmplitudeGreen(0);
  Serial.println("Rest a finger on the sensor with steady pressure (not a medical device)");
}

void loop() {
  long ir = sensor.getIR();
  if (checkForBeat(ir)) {
    unsigned long delta = millis() - lastBeat;
    lastBeat = millis();
    float bpm = 60 / (delta / 1000.0);
    if (bpm > 20 && bpm < 255) {
      rates[rateSpot++] = (byte)bpm;
      rateSpot %= RATE_SIZE;
      int average = 0;
      for (byte i = 0; i < RATE_SIZE; i++) average += rates[i];
      Serial.print("BPM "); Serial.print(bpm, 0);
      Serial.print("  average "); Serial.println(average / RATE_SIZE);
    }
  }
  static unsigned long lastHint = 0;
  if (ir < 50000 && millis() - lastHint > 2000) {
    Serial.println("No finger?");
    lastHint = millis();
  }
}
`,
  },
  'thermocouple': {
    libs: ['MAX6675 library'],
    pins: {
      default: { SO: 4, CS: 5, SCK: 6 },
      esp32: { SO: 16, CS: 17, SCK: 18 },
      esp32s2: { SO: 4, CS: 5, SCK: 6 },
      esp32s3: { SO: 4, CS: 5, SCK: 6 },
      esp32c3: { SO: 3, CS: 4, SCK: 5 },
      esp32c6: { SO: 2, CS: 3, SCK: 6 },
      rp2040: { SO: 10, CS: 11, SCK: 12 },
    },
    inputs: ['SO'],
    wiring: ['VCC → 3.3 V or 5 V; GND → GND', 'SO → pin {{SO}}; CS → pin {{CS}}; SCK → pin {{SCK}} (read in software: any pins)', 'K-type probe: red lead to −, yellow (or the other) to + on most modules; a reading that falls when heated means the leads are swapped'],
    sketch: `
#include <max6675.h>

const int THERMO_SO = {{SO}}, THERMO_CS = {{CS}}, THERMO_SCK = {{SCK}};
MAX6675 thermocouple(THERMO_SCK, THERMO_CS, THERMO_SO);

void setup() {
  Serial.begin(115200);
  delay(500);  // the MAX6675 needs a moment after power-up
}

void loop() {
  float c = thermocouple.readCelsius();
  if (isnan(c)) {
    Serial.println("Thermocouple open: check the probe wires");
  } else {
    Serial.print(c); Serial.println(" C");
  }
  delay(1000);  // it converts at most about 4 times a second
}
`,
  },
  'acs712': {
    pins: ANALOG_IN,
    analog: ['AIN'],
    params: {
      default: { DIVNOTE: '' , VREF_MV: 5000, ADC_MAX: 1023, DIVIDER: '1.0' },
      esp32: { DIVNOTE: ' through a divider (10 kΩ from OUT to the pin, 20 kΩ from the pin to GND): the output swings up to 5 V' },
      rp2040: { DIVNOTE: ' through a divider (10 kΩ from OUT to the pin, 20 kΩ from the pin to GND): the output swings up to 5 V', VREF_MV: 3300, ADC_MAX: 1023, DIVIDER: '1.5' },
      'nano-esp32': { DIVNOTE: ' through a divider (10 kΩ from OUT to the pin, 20 kΩ from the pin to GND): the output swings up to 5 V' },
    },
    wiring: ['VCC → 5 V; GND → GND', 'OUT → pin {{AIN}}{{DIVNOTE}}', 'The measured current flows through the IP+ and IP− screw terminals, in series with the load. Mains (230 V) work needs an enclosure and someone qualified.'],
    sketch: {
      default: `
const int SENSOR_PIN = {{AIN}};
const float MV_PER_AMP = 185.0;  // the 5 A module; 100 for the 20 A one, 66 for the 30 A one
const float DIVIDER = {{DIVIDER}};    // 1.0 when OUT goes straight to the pin

float zeroMv = 2500.0;  // measured at startup with no current flowing

float readMv() {
  long sum = 0;
  for (int i = 0; i < 100; i++) sum += analogRead(SENSOR_PIN);
  return (sum / 100.0) * ({{VREF_MV}}.0 / {{ADC_MAX}}.0) * DIVIDER;
}

void setup() {
  Serial.begin(115200);
  zeroMv = readMv();  // keep the load off while the board starts
}

void loop() {
  float amps = (readMv() - zeroMv) / MV_PER_AMP;
  Serial.print(amps, 2); Serial.println(" A");
  delay(500);
}
`,
      esp32: `
const int SENSOR_PIN = {{AIN}};  // through a 10 kΩ / 20 kΩ divider: the sensor outputs up to 5 V
const float MV_PER_AMP = 185.0;  // the 5 A module; 100 for the 20 A one, 66 for the 30 A one
const float DIVIDER = 1.5;       // (10 kΩ + 20 kΩ) / 20 kΩ

float zeroMv = 2500.0;  // measured at startup with no current flowing

float readMv() {
  uint32_t sum = 0;
  for (int i = 0; i < 100; i++) sum += analogReadMilliVolts(SENSOR_PIN);  // calibrated, unlike analogRead
  return (sum / 100.0) * DIVIDER;
}

void setup() {
  Serial.begin(115200);
  zeroMv = readMv();  // keep the load off while the board starts
}

void loop() {
  float amps = (readMv() - zeroMv) / MV_PER_AMP;
  Serial.print(amps, 2); Serial.println(" A");
  delay(500);
}
`,
    },
  },
  'io-expander': {
    libs: ['PCF8574'],
    pins: I2C_WIRING,
    wiring: [...i2cWiring(), 'A0–A2 → GND for address 0x20 (PCF8574A modules start at 0x38)', 'An LED from VCC through 220 Ω into P0 (the PCF8574 sinks current; it can barely source it); a button from P1 to GND'],
    sketch: `
#include <Wire.h>
#include "PCF8574.h"

PCF8574 expander(0x20);

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  Wire.begin();
  if (!expander.begin()) {
    Serial.println("PCF8574 not found");
    while (true) delay(10);
  }
}

void loop() {
  expander.write(0, LOW);   // LED on (the pin sinks the current)
  delay(500);
  expander.write(0, HIGH);  // LED off
  delay(500);
  Serial.print("P1 reads ");
  Serial.println(expander.read(1));  // 0 while the button is pressed
}
`,
  },
  'eeprom-i2c': {
    pins: I2C_WIRING,
    wiring: [...i2cWiring(), 'A0, A1, A2 → GND (address 0x50); WP → GND to allow writes'],
    sketch: `
#include <Wire.h>

const uint8_t EEPROM_ADDR = 0x50;  // up to 0x57 with A0–A2 tied high
uint8_t boots = 0;

void writeByte(uint16_t address, uint8_t value) {
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write((uint8_t)(address >> 8));    // the AT24C32 and larger take two address bytes
  Wire.write((uint8_t)(address & 0xFF));
  Wire.write(value);
  Wire.endTransmission();
  delay(5);  // a write takes up to 5 ms
}

uint8_t readByte(uint16_t address) {
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write((uint8_t)(address >> 8));
  Wire.write((uint8_t)(address & 0xFF));
  Wire.endTransmission(false);  // repeated start, then read
  Wire.requestFrom(EEPROM_ADDR, (uint8_t)1);
  return Wire.available() ? Wire.read() : 0xFF;
}

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  Wire.begin();
  uint8_t stored = readByte(0);
  boots = (stored == 0xFF) ? 1 : stored + 1;  // a new chip reads 0xFF
  writeByte(0, boots);
}

void loop() {
  // Said again every few seconds, so a serial monitor opened late still sees it.
  Serial.print("Started ");
  Serial.print(boots);
  Serial.println(" times (counted in the EEPROM)");
  delay(5000);
}
`,
  },
  // ── Round 3: radios, buses, power ────────────────────────────────────────
  'sim800': {
    pins: {
      default: { RX: 7, TX: 8 },
      esp32: { RX: 16, TX: 17 },
      esp32s2: { RX: 18, TX: 17 },
      esp32s3: { RX: 18, TX: 17 },
      esp32c3: { RX: 4, TX: 5 },
      esp32c6: { RX: 6, TX: 7 },
      rp2040: { RX: 9, TX: 8 },
    },
    inputs: ['RX'],
    wiring: ['VCC → a 3.7–4.2 V supply that gives 2 A peaks (a Li-ion cell, or a buck converter set to 4 V), never 5 V or the 3.3 V pin; GND shared with the board', 'Module TXD → board pin {{RX}}; module RXD → board pin {{TX}} (through a 1 kΩ/2 kΩ divider from a 5 V board)', 'A SIM card with SMS enabled, PIN lock off, and the antenna fitted'],
    sketch: {
      default: `
#include <SoftwareSerial.h>

SoftwareSerial modem({{RX}}, {{TX}});  // board RX (from the module's TXD), board TX (to its RXD)
const bool SEND_TEST_SMS = false;     // true, with your number below, sends one SMS
const char *PHONE = "+91XXXXXXXXXX";

void command(const char *cmd, unsigned long waitMs = 1000) {
  modem.println(cmd);
  unsigned long start = millis();
  Serial.print(cmd);
  Serial.print(" -> ");
  while (millis() - start < waitMs) {
    while (modem.available()) Serial.write(modem.read());
  }
  Serial.println();
}

void setup() {
  Serial.begin(115200);
  modem.begin(9600);
  delay(3000);          // the module needs a few seconds after power-up
  command("AT");        // OK when wiring and baud rate are right
  command("AT+CSQ");    // signal: 10–31 is usable, 99 means none
  command("AT+CREG?");  // 0,1 or 0,5 means registered on the network
  if (SEND_TEST_SMS) {
    command("AT+CMGF=1");  // text mode
    modem.print("AT+CMGS=");
    modem.write('"');
    modem.print(PHONE);
    modem.write('"');
    modem.println();
    delay(500);
    modem.print("Hello from Impulse");
    modem.write(26);       // Ctrl+Z sends the message
    delay(5000);
  }
}

void loop() {
  // Type AT commands in the serial monitor; the replies print back.
  if (modem.available()) Serial.write(modem.read());
  if (Serial.available()) modem.write(Serial.read());
}
`,
      esp32: `
const int MODEM_RX = {{RX}}, MODEM_TX = {{TX}};  // board RX (from the module's TXD), board TX (to its RXD)
HardwareSerial &modem = Serial1;
const bool SEND_TEST_SMS = false;  // true, with your number below, sends one SMS
const char *PHONE = "+91XXXXXXXXXX";

void command(const char *cmd, unsigned long waitMs = 1000) {
  modem.println(cmd);
  unsigned long start = millis();
  Serial.print(cmd);
  Serial.print(" -> ");
  while (millis() - start < waitMs) {
    while (modem.available()) Serial.write(modem.read());
  }
  Serial.println();
}

void setup() {
  Serial.begin(115200);
  modem.begin(9600, SERIAL_8N1, MODEM_RX, MODEM_TX);
  delay(3000);          // the module needs a few seconds after power-up
  command("AT");        // OK when wiring and baud rate are right
  command("AT+CSQ");    // signal: 10–31 is usable, 99 means none
  command("AT+CREG?");  // 0,1 or 0,5 means registered on the network
  if (SEND_TEST_SMS) {
    command("AT+CMGF=1");  // text mode
    modem.print("AT+CMGS=");
    modem.write('"');
    modem.print(PHONE);
    modem.write('"');
    modem.println();
    delay(500);
    modem.print("Hello from Impulse");
    modem.write(26);       // Ctrl+Z sends the message
    delay(5000);
  }
}

void loop() {
  // Type AT commands in the serial monitor; the replies print back.
  if (modem.available()) Serial.write(modem.read());
  if (Serial.available()) modem.write(Serial.read());
}
`,
    },
  },
  'rs485': {
    libs: ['ModbusMaster'],
    pins: {
      default: { RX: 8, TX: 9, DE: 7 },
      esp32: { RX: 16, TX: 17, DE: 4 },
      esp32s2: { RX: 18, TX: 17, DE: 4 },
      esp32s3: { RX: 18, TX: 17, DE: 4 },
      esp32c3: { RX: 4, TX: 5, DE: 3 },
      esp32c6: { RX: 6, TX: 7, DE: 2 },
      rp2040: { RX: 9, TX: 8, DE: 7 },
    },
    inputs: ['RX'],
    wiring: ['MAX485 module VCC → 5 V (a MAX3485 for 3.3 V boards; from a 5 V module, RO needs a divider into a 3.3 V pin); GND → GND', 'RO → pin {{RX}}; DI → pin {{TX}}; DE and RE joined → pin {{DE}}', 'A → A and B → B on the bus, with 120 Ω across A–B at each end of a long bus'],
    sketch: {
      default: `
#include <SoftwareSerial.h>
#include <ModbusMaster.h>

const int RS485_DE = {{DE}};             // DE and RE joined
SoftwareSerial rs485({{RX}}, {{TX}});    // RO → board RX, DI → board TX
ModbusMaster node;

void beforeSend() { digitalWrite(RS485_DE, HIGH); }  // transmit
void afterSend() { digitalWrite(RS485_DE, LOW); }    // listen

void setup() {
  Serial.begin(115200);
  pinMode(RS485_DE, OUTPUT);
  afterSend();
  rs485.begin(9600);
  node.begin(1, rs485);  // Modbus device id 1
  node.preTransmission(beforeSend);
  node.postTransmission(afterSend);
}

void loop() {
  uint8_t result = node.readHoldingRegisters(0, 2);  // registers 0 and 1
  if (result == node.ku8MBSuccess) {
    Serial.print("reg0 "); Serial.print(node.getResponseBuffer(0));
    Serial.print("  reg1 "); Serial.println(node.getResponseBuffer(1));
  } else {
    Serial.print("Modbus error 0x");
    Serial.println(result, HEX);  // E2 means no reply: check A/B, the device id and the baud rate
  }
  delay(1000);
}
`,
      esp32: `
#include <ModbusMaster.h>

const int RS485_RX = {{RX}}, RS485_TX = {{TX}}, RS485_DE = {{DE}};  // RO, DI, and DE+RE joined
HardwareSerial &rs485 = Serial1;
ModbusMaster node;

void beforeSend() { digitalWrite(RS485_DE, HIGH); }  // transmit
void afterSend() { digitalWrite(RS485_DE, LOW); }    // listen

void setup() {
  Serial.begin(115200);
  pinMode(RS485_DE, OUTPUT);
  afterSend();
  rs485.begin(9600, SERIAL_8N1, RS485_RX, RS485_TX);
  node.begin(1, rs485);  // Modbus device id 1
  node.preTransmission(beforeSend);
  node.postTransmission(afterSend);
}

void loop() {
  uint8_t result = node.readHoldingRegisters(0, 2);  // registers 0 and 1
  if (result == node.ku8MBSuccess) {
    Serial.print("reg0 "); Serial.print(node.getResponseBuffer(0));
    Serial.print("  reg1 "); Serial.println(node.getResponseBuffer(1));
  } else {
    Serial.print("Modbus error 0x");
    Serial.println(result, HEX);  // E2 means no reply: check A/B, the device id and the baud rate
  }
  delay(1000);
}
`,
    },
  },
  'can': {
    libs: { default: ['mcp_can'], esp32: [] },
    pins: {
      default: { CS: 10, INT: 2 },
      esp32: { CTX: 21, CRX: 22 },
      esp32s2: { CTX: 4, CRX: 5 },
      esp32s3: { CTX: 4, CRX: 5 },
      esp32c3: { CTX: 4, CRX: 5 },
      esp32c6: { CTX: 2, CRX: 3 },
      rp2040: { CS: 17, INT: 20 },
    },
    inputs: ['INT', 'CRX'],
    params: { ...SPI_BUS },
    wiring: {
      default: ['MCP2515 module: VCC → 5 V; GND → GND; CS → pin {{CS}}; INT → pin {{INT}}; SI, SO, SCK → the board\'s SPI pins ({{BUS}}); note the crystal (8 or 16 MHz) printed on the module', 'CANH and CANL to the bus, with 120 Ω across them at both ends'],
      esp32: ['The built-in CAN controller (TWAI) with a 3.3 V transceiver (SN65HVD230): CTX → pin {{CTX}}; CRX → pin {{CRX}}; VCC → 3.3 V; GND → GND', 'CANH and CANL to the bus, with 120 Ω across them at both ends'],
    },
    sketch: {
      default: `
#include <SPI.h>
#include <mcp_can.h>

MCP_CAN CAN0({{CS}});         // the MCP2515's CS pin
const int CAN_INT = {{INT}};  // LOW when a frame has arrived

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  // 500 kbit/s with the module's 8 MHz crystal (MCP_16MHZ if the crystal says 16.000)
  if (CAN0.begin(MCP_ANY, CAN_500KBPS, MCP_8MHZ) != CAN_OK) {
    Serial.println("MCP2515 not found: check CS, the SPI wiring and the crystal setting");
    while (true) delay(10);
  }
  CAN0.setMode(MCP_NORMAL);
  pinMode(CAN_INT, INPUT);
}

void loop() {
  static unsigned long lastSend = 0;
  if (millis() - lastSend > 1000) {
    lastSend = millis();
    INT8U data[8] = {1, 2, 3, 4, 5, 6, 7, (INT8U)(millis() / 1000)};
    INT8U sent = CAN0.sendMsgBuf(0x100, 0, 8, data);  // standard 11-bit id 0x100
    Serial.println(sent == CAN_OK ? "sent 0x100" : "send failed (is another node there to acknowledge?)");
  }
  if (!digitalRead(CAN_INT)) {
    INT32U id;
    INT8U len = 0;
    INT8U buf[8];
    CAN0.readMsgBuf(&id, &len, buf);
    Serial.print("got 0x"); Serial.print(id, HEX);
    Serial.print(" len "); Serial.println(len);
  }
}
`,
      esp32: `
#include "driver/twai.h"

const gpio_num_t CAN_TX = (gpio_num_t){{CTX}};  // to the transceiver's CTX/TXD
const gpio_num_t CAN_RX = (gpio_num_t){{CRX}};  // from the transceiver's CRX/RXD

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  twai_general_config_t g = TWAI_GENERAL_CONFIG_DEFAULT(CAN_TX, CAN_RX, TWAI_MODE_NORMAL);
  twai_timing_config_t t = TWAI_TIMING_CONFIG_500KBITS();
  twai_filter_config_t f = TWAI_FILTER_CONFIG_ACCEPT_ALL();
  if (twai_driver_install(&g, &t, &f) != ESP_OK || twai_start() != ESP_OK) {
    Serial.println("CAN (TWAI) failed to start");
    while (true) delay(10);
  }
  Serial.println("CAN running at 500 kbit/s");
}

void loop() {
  static unsigned long lastSend = 0;
  if (millis() - lastSend > 1000) {
    lastSend = millis();
    twai_message_t msg = {};
    msg.identifier = 0x100;  // standard 11-bit id
    msg.data_length_code = 8;
    for (int i = 0; i < 8; i++) msg.data[i] = i;
    esp_err_t err = twai_transmit(&msg, pdMS_TO_TICKS(100));
    Serial.println(err == ESP_OK ? "sent 0x100" : "send failed (is another node there to acknowledge?)");
  }
  twai_message_t rx;
  if (twai_receive(&rx, 0) == ESP_OK) {
    Serial.print("got 0x"); Serial.print(rx.identifier, HEX);
    Serial.print(" len "); Serial.println(rx.data_length_code);
  }
}
`,
    },
  },
  'ethernet-w5500': {
    libs: { default: ['Ethernet'], esp32: [] },
    pins: {
      default: { CS: 10 },
      esp32: { CS: 27, IRQ: 4, RST: 13 },
      esp32s2: { CS: 34, IRQ: 4, RST: 5 },
      esp32s3: { CS: 10, IRQ: 4, RST: 5 },
      esp32c3: { CS: 7, IRQ: 3, RST: 10 },
      esp32c6: { CS: 18, IRQ: 2, RST: 3 },
      rp2040: { CS: 17 },
    },
    inputs: ['IRQ'],
    params: { ...SPI_BUS },
    wiring: {
      default: ['W5500 module: 3.3 V → 3.3 V (it draws about 130 mA); GND → GND', 'CS → pin {{CS}}', 'MOSI, MISO, SCK → the board\'s SPI pins ({{BUS}})'],
      esp32: ['W5500 module: 3.3 V → 3.3 V (it draws about 130 mA); GND → GND', 'CS → pin {{CS}}; INT → pin {{IRQ}}; RST → pin {{RST}}', 'MOSI, MISO, SCK → the board\'s SPI pins ({{BUS}})'],
    },
    sketch: {
      default: `
#include <SPI.h>
#include <Ethernet.h>

byte mac[] = { 0xDE, 0xAD, 0xBE, 0xEF, 0xFE, 0xED };  // any address not used elsewhere on your network

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  Ethernet.init({{CS}});  // the module's CS pin
  Serial.println("Asking the router for an address (DHCP)...");
  if (Ethernet.begin(mac) == 0) {
    if (Ethernet.hardwareStatus() == EthernetNoHardware) Serial.println("No W5x00 found: check CS and the SPI wiring");
    else if (Ethernet.linkStatus() == LinkOFF) Serial.println("No cable");
    else Serial.println("DHCP failed");
    while (true) delay(10);
  }
  Serial.print("IP ");
  Serial.println(Ethernet.localIP());
}

void loop() {
  Ethernet.maintain();  // renews the DHCP lease
}
`,
      esp32: `
#include <ETH.h>
#include <SPI.h>

const int W5500_CS = {{CS}}, W5500_INT = {{IRQ}}, W5500_RST = {{RST}};

void onEvent(arduino_event_id_t event, arduino_event_info_t info) {
  switch (event) {
    case ARDUINO_EVENT_ETH_START: ETH.setHostname("impulse-board"); break;
    case ARDUINO_EVENT_ETH_CONNECTED: Serial.println("Cable connected"); break;
    case ARDUINO_EVENT_ETH_GOT_IP: Serial.print("IP "); Serial.println(ETH.localIP()); break;
    case ARDUINO_EVENT_ETH_DISCONNECTED: Serial.println("Cable unplugged"); break;
    default: break;
  }
}

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  Network.onEvent(onEvent);
  SPI.begin(SCK, MISO, MOSI);  // the board's default SPI pins
  // A W5500 on SPI: PHY address 1, then the CS, interrupt and reset pins.
  if (!ETH.begin(ETH_PHY_W5500, 1, W5500_CS, W5500_INT, W5500_RST, SPI)) {
    Serial.println("W5500 not found: check CS, INT, RST and the SPI wiring");
  }
}

void loop() {}
`,
    },
  },
  'i2s-audio': {
    pins: {
      esp32: { BCLK: 26, LRC: 25, DOUT: 22 },
      esp32s2: { BCLK: 4, LRC: 5, DOUT: 6 },
      esp32s3: { BCLK: 4, LRC: 5, DOUT: 6 },
      esp32c3: { BCLK: 4, LRC: 5, DOUT: 6 },
      esp32c6: { BCLK: 2, LRC: 3, DOUT: 6 },
    },
    wiring: ['MAX98357A: VIN → 5 V (3.3 V works, quieter); GND → GND', 'BCLK → pin {{BCLK}}; LRC → pin {{LRC}}; DIN → pin {{DOUT}}', 'A 4–8 Ω speaker on the + and − terminals; GAIN left open is 9 dB'],
    sketch: { esp32: `
#include <ESP_I2S.h>

const int I2S_BCLK = {{BCLK}}, I2S_LRC = {{LRC}}, I2S_DOUT = {{DOUT}};
const int SAMPLE_RATE = 16000;
I2SClass i2s;

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  i2s.setPins(I2S_BCLK, I2S_LRC, I2S_DOUT);
  if (!i2s.begin(I2S_MODE_STD, SAMPLE_RATE, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO)) {
    Serial.println("I2S failed to start");
    while (true) delay(10);
  }
  Serial.println("Playing a 440 Hz tone");
}

void loop() {
  static float phase = 0;
  int16_t samples[256];
  for (int i = 0; i < 256; i++) {
    samples[i] = (int16_t)(sinf(phase) * 3000);  // keep the volume moderate
    phase += 2 * PI * 440 / SAMPLE_RATE;
    if (phase > 2 * PI) phase -= 2 * PI;
  }
  i2s.write((uint8_t *)samples, sizeof(samples));
}
` },
  },
  'mosfet': {
    pwm: ['GATE'],
    pins: {
      default: { GATE: 9 },
      esp32: { GATE: 4 },
      esp32s2: { GATE: 4 },
      esp32s3: { GATE: 4 },
      esp32c3: { GATE: 4 },
      esp32c6: { GATE: 2 },
      rp2040: { GATE: 15 },
    },
    wiring: ['Gate → 220 Ω → pin {{GATE}}; 10 kΩ from the gate to GND (keeps the load off while the board boots)', 'Source → GND, shared with the board', 'Drain → the load\'s negative lead; the load\'s positive lead → its own supply (a 12 V strip or motor)', 'Motors, relays and solenoids need a flyback diode (1N4007) across the load, stripe towards +', 'Use a logic-level MOSFET (IRLZ44N, AO3400): an IRF540 or IRFZ44N needs about 10 V on the gate and runs hot at 3.3–5 V'],
    sketch: `
const int GATE_PIN = {{GATE}};  // PWM into the MOSFET's gate

void setup() {
  pinMode(GATE_PIN, OUTPUT);
}

void loop() {
  for (int duty = 0; duty <= 255; duty += 5) { analogWrite(GATE_PIN, duty); delay(20); }  // brighten
  for (int duty = 255; duty >= 0; duty -= 5) { analogWrite(GATE_PIN, duty); delay(20); }  // and dim
}
`,
  },
  // ── Round 3: ESP32 features ──────────────────────────────────────────────
  'esp32-ota': {
    sketch: { esp32: `
#include <WiFi.h>
#include <ArduinoOTA.h>

const char *WIFI_SSID = "your-network";
const char *WIFI_PASS = "your-password";

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(500);
  ArduinoOTA.setHostname("impulse-board");  // shows up as a network port with this name
  ArduinoOTA.setPassword("change-me");       // without one, anyone on the network can flash it
  ArduinoOTA.onStart([]() { Serial.println("OTA update starting"); });
  ArduinoOTA.onEnd([]() { Serial.println("OTA update done, restarting"); });
  ArduinoOTA.onError([](ota_error_t error) { Serial.printf("OTA error %u\\n", error); });
  ArduinoOTA.begin();
  Serial.print("Ready for OTA at ");
  Serial.println(WiFi.localIP());
}

void loop() {
  ArduinoOTA.handle();  // must run often: keep loop() free of long delays
}
` },
  },
  'esp32-littlefs': {
    sketch: { esp32: `
#include <LittleFS.h>

int boots = 0;

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  if (!LittleFS.begin(true)) {  // true: format the partition the first time
    Serial.println("LittleFS failed to mount");
    while (true) delay(10);
  }
  File log = LittleFS.open("/boots.txt", FILE_APPEND);
  log.println(millis());
  log.close();
  log = LittleFS.open("/boots.txt", FILE_READ);
  while (log.available()) if (log.read() == '\\n') boots++;
  log.close();
}

void loop() {
  // Said again every few seconds, so a serial monitor opened late still sees it.
  Serial.printf("Started %d times; %u of %u bytes used\\n", boots, (unsigned)LittleFS.usedBytes(), (unsigned)LittleFS.totalBytes());
  delay(5000);
}
` },
  },
  'esp32-cam': {
    pins: { esp32: {}, esp32s2: null, esp32s3: null, esp32c3: null, esp32c6: null, esp32h2: null },
    sketch: { esp32: `
#include "esp_camera.h"

// The AI Thinker ESP32-CAM's camera pins (Tools › Board: "AI Thinker ESP32-CAM").
// Other camera boards use other pins: take them from the board maker's example.
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = psramFound() ? FRAMESIZE_SVGA : FRAMESIZE_QVGA;
  config.jpeg_quality = 12;  // 0–63, lower is better
  config.fb_count = psramFound() ? 2 : 1;
  config.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  config.grab_mode = CAMERA_GRAB_LATEST;
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x: check the board's pin map, the ribbon cable and the 5 V supply\\n", (unsigned)err);
    while (true) delay(10);
  }
  Serial.println("Camera ready");
}

void loop() {
  camera_fb_t *frame = esp_camera_fb_get();
  if (!frame) {
    Serial.println("Capture failed");
  } else {
    Serial.printf("Captured a %ux%u JPEG of %u bytes\\n", (unsigned)frame->width, (unsigned)frame->height, (unsigned)frame->len);
    esp_camera_fb_return(frame);
  }
  delay(2000);
}
` },
  },
  'esp32-bt-serial': {
    pins: { esp32: {}, esp32s2: null, esp32s3: null, esp32c3: null, esp32c6: null, esp32h2: null },
    sketch: { esp32: `
#include <BluetoothSerial.h>

BluetoothSerial SerialBT;

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  SerialBT.begin("Impulse-ESP32");  // the name a phone sees when pairing
  Serial.println("Pair with Impulse-ESP32, then open a Bluetooth serial terminal app");
}

void loop() {
  if (SerialBT.available()) Serial.write(SerialBT.read());  // phone → serial monitor
  if (Serial.available()) SerialBT.write(Serial.read());    // serial monitor → phone
}
` },
  },
  'esp32-ntp': {
    sketch: { esp32: `
#include <WiFi.h>
#include <time.h>

const char *WIFI_SSID = "your-network";
const char *WIFI_PASS = "your-password";

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(500);
  configTime(19800, 0, "pool.ntp.org", "time.google.com");  // India: UTC+5:30, no daylight saving
}

void loop() {
  struct tm now;
  if (getLocalTime(&now)) {  // waits up to 5 s for the first answer
    char text[32];
    strftime(text, sizeof(text), "%d %b %Y %H:%M:%S", &now);
    Serial.println(text);
  } else {
    Serial.println("Waiting for the time from the internet...");
  }
  delay(1000);
}
` },
  },
  'esp32-https': {
    sketch: { esp32: `
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

const char *WIFI_SSID = "your-network";
const char *WIFI_PASS = "your-password";

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(500);
  Serial.print("IP ");
  Serial.println(WiFi.localIP());
}

void loop() {
  WiFiClientSecure client;
  client.setInsecure();  // a test only: skips the certificate check. For a product, client.setCACert(rootCA)
  HTTPClient https;
  if (https.begin(client, "https://api.github.com/zen")) {
    int code = https.GET();
    if (code > 0) {
      Serial.print(code);
      Serial.print("  ");
      Serial.println(https.getString());
    } else {
      Serial.println(https.errorToString(code));
    }
    https.end();
  }
  delay(15000);
}
` },
  },
  'esp32-websocket': {
    libs: { esp32: ['WebSockets'] },
    sketch: { esp32: `
#include <WiFi.h>
#include <WebServer.h>
#include <WebSocketsServer.h>

const char *WIFI_SSID = "your-network";
const char *WIFI_PASS = "your-password";

WebServer server(80);
WebSocketsServer webSocket(81);

// The page: it opens a WebSocket to the board and shows what arrives.
const char PAGE[] PROGMEM = R"html(<!doctype html>
<meta name="viewport" content="width=device-width">
<h1 id="v">connecting…</h1>
<script>
const ws = new WebSocket('ws://' + location.hostname + ':81/');
ws.onmessage = (e) => { document.getElementById('v').textContent = e.data; };
</script>)html";

void onEvent(uint8_t client, WStype_t type, uint8_t *payload, size_t length) {
  if (type == WStype_CONNECTED) Serial.printf("browser %u connected\\n", client);
  if (type == WStype_TEXT) Serial.printf("browser %u says: %.*s\\n", client, (int)length, (const char *)payload);
}

void setup() {
  Serial.begin(115200);
  delay(2000);  // native-USB boards (ESP32-S3/C3, Pico, Leonardo) reconnect after a reset: let the monitor catch up
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) delay(500);
  server.on("/", []() { server.send_P(200, "text/html", PAGE); });
  server.begin();
  webSocket.begin();
  webSocket.onEvent(onEvent);
  Serial.print("Open http://");
  Serial.println(WiFi.localIP());
}

void loop() {
  server.handleClient();
  webSocket.loop();
  static unsigned long last = 0;
  if (millis() - last > 1000) {
    last = millis();
    String message = String(millis() / 1000) + " s";
    webSocket.broadcastTXT(message);
  }
}
` },
  },
};

module.exports = { RECIPES };
