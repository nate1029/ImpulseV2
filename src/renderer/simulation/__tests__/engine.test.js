// Circuit engine end-to-end: real sketches (and real Arduino libraries when
// installed) driving simulated parts through the netlist.
import { Bench } from './bench.js';
import { compileSketch, describeWithCli, installedLibraries } from './cli.js';
import { BOARDS } from '../boards.js';

const LIBS = installedLibraries();
const withLibs = (...names) => (names.every(n => LIBS.has(n.toLowerCase())) ? it : it.skip);
const uno = (code, name) => compileSketch(code, BOARDS.uno.fqbn, name);
const T = 120000;

describeWithCli('circuit engine with real firmware', () => {
  it('lights LEDs with PWM brightness and reads buttons, pull-downs and a potentiometer', () => {
    const hex = uno(`
void setup() {
  Serial.begin(115200);
  pinMode(13, OUTPUT); digitalWrite(13, HIGH);
  pinMode(2, INPUT_PULLUP);
  pinMode(4, INPUT);
  analogWrite(9, 64);
}
void loop() {
  Serial.print("b2="); Serial.print(digitalRead(2));
  Serial.print(" b4="); Serial.print(digitalRead(4));
  Serial.print(" a0="); Serial.println(analogRead(A0));
  delay(40);
}`, 'basics');
    const b = new Bench('uno');
    b.add('wokwi-resistor', 'r1', { value: '220' });
    b.add('wokwi-led', 'led1');
    b.add('wokwi-resistor', 'r2', { value: '220' });
    b.add('wokwi-led', 'led2');
    b.add('wokwi-led', 'led3'); // reversed: never lights
    b.add('wokwi-pushbutton', 'btn1');
    b.add('wokwi-pushbutton', 'btn2');
    b.add('wokwi-resistor', 'r3', { value: '10000' });
    b.add('wokwi-potentiometer', 'pot1', { value: '256' });
    b.wire('uno:13', 'r1:1', 'r1:2', 'led1:A', 'led1:C', 'uno:GND.1');
    b.wire('uno:9', 'r2:1', 'r2:2', 'led2:A', 'led2:C', 'uno:GND.1');
    b.wire('uno:13', 'led3:C', 'led3:A', 'uno:GND.2');
    b.wire('btn1:1.l', 'uno:2', 'btn1:2.l', 'uno:GND.2');
    b.wire('btn2:1.l', 'uno:4', 'btn2:2.r', 'uno:5V', 'r3:1', 'uno:4', 'r3:2', 'uno:GND.3');
    b.wire('pot1:VCC', 'uno:5V', 'pot1:GND', 'uno:GND.3', 'pot1:SIG', 'uno:A0');
    b.load(hex).run(0.25);
    expect(b.part('led1').el.value).toBe(true);
    expect(b.part('led1').el.brightness).toBeCloseTo(1, 2);
    expect(b.part('led2').el.value).toBe(true);
    expect(b.part('led2').el.brightness).toBeGreaterThan(0.2);
    expect(b.part('led2').el.brightness).toBeLessThan(0.3);
    expect(b.part('led3').el.value).toBe(false);
    const before = b.lines().slice(-1)[0];
    expect(before).toMatch(/b2=1 b4=0 a0=25[5-7]/);

    b.behavior('btn1').set(true);
    b.behavior('btn2').set(true);
    b.run(0.1);
    expect(b.lines().slice(-1)[0]).toMatch(/b2=0 b4=1/);
    b.behavior('btn1').set(false);
    b.behavior('btn2').set(false);
    b.run(0.1);
    expect(b.lines().slice(-1)[0]).toMatch(/b2=1 b4=0/);
    expect(b.shorts).toEqual([]);
  }, T);

  it('reports a short circuit when an output fights a rail', () => {
    const hex = uno('void setup(){ pinMode(13, OUTPUT); digitalWrite(13, HIGH); } void loop(){}', 'short');
    const b = new Bench('uno');
    b.wire('uno:13', 'uno:GND.1');
    b.load(hex).run(0.05);
    expect(b.shorts.length).toBe(1);
    expect(b.shorts[0].tags.sort()).toEqual(['D13', 'GND']);
  }, T);

  it('answers HC-SR04 pings with the configured distance', () => {
    const hex = uno(`
void setup() { Serial.begin(115200); pinMode(3, OUTPUT); pinMode(2, INPUT); }
void loop() {
  digitalWrite(3, LOW); delayMicroseconds(2);
  digitalWrite(3, HIGH); delayMicroseconds(10); digitalWrite(3, LOW);
  long us = pulseIn(2, HIGH, 30000);
  Serial.print("cm="); Serial.println(us / 58);
  delay(30);
}`, 'sonar');
    const b = new Bench('uno');
    b.add('wokwi-hc-sr04', 'sonar', { distance: '123' });
    b.wire('sonar:TRIG', 'uno:3', 'sonar:ECHO', 'uno:2', 'sonar:VCC', 'uno:5V', 'sonar:GND', 'uno:GND.1');
    b.load(hex).run(0.2);
    expect(b.lines().slice(-1)[0]).toMatch(/cm=123/);
    for (const cm of [2, 40, 57, 250, 399]) {
      b.part('sonar').attrs.distance = String(cm);
      b.run(0.15);
      expect({ cm, line: b.lines().slice(-1)[0] }).toEqual({ cm, line: `cm=${cm}` });
    }
  }, T);

  withLibs('DHT sensor library')('reads DHT22 and DHT11 through the DHT library', () => {
    for (const [model, type, expectT, expectH] of [['DHT22', 'wokwi-dht22', '-12.30', '55.50'], ['DHT11', 'wokwi-dht11', '21.00', '33.00']]) {
      const hex = uno(`
#include <DHT.h>
DHT dht(2, ${model});
void setup() { Serial.begin(115200); dht.begin(); }
void loop() {
  delay(2100);
  Serial.print("T="); Serial.print(dht.readTemperature());
  Serial.print(" H="); Serial.println(dht.readHumidity());
}`, `dht_${model}`);
      const b = new Bench('uno');
      b.add(type, 'dht', model === 'DHT22' ? { temperature: '-12.3', humidity: '55.5' } : { temperature: '21', humidity: '33' });
      b.wire('dht:SDA', 'uno:2', 'dht:VCC', 'uno:5V', 'dht:GND', 'uno:GND.1');
      b.load(hex).run(2.3);
      expect(b.lines().slice(-1)[0]).toBe(`T=${expectT} H=${expectH}`);
    }
  }, T);

  withLibs('LiquidCrystal I2C', 'LiquidCrystal')('prints on I2C and parallel LCDs', () => {
    const i2c = uno(`
#include <LiquidCrystal_I2C.h>
LiquidCrystal_I2C lcd(0x27, 16, 2);
void setup() { lcd.init(); lcd.backlight(); lcd.setCursor(2, 1); lcd.print("Impulse"); }
void loop() {}`, 'lcd_i2c');
    const b = new Bench('uno');
    b.add('wokwi-lcd1602', 'lcd');
    b.wire('lcd:SDA', 'uno:A4', 'lcd:SCL', 'uno:A5', 'lcd:VCC', 'uno:5V', 'lcd:GND', 'uno:GND.1');
    b.load(i2c).run(1.3); // LiquidCrystal_I2C::begin() waits one second
    const text = String.fromCharCode(...b.part('lcd').el.characters);
    expect(text.slice(16, 32)).toBe('  Impulse       ');
    expect(b.part('lcd').el.backlight).toBe(true);

    const par = uno(`
#include <LiquidCrystal.h>
LiquidCrystal lcd(12, 11, 5, 4, 3, 2);
byte heart[8] = {0, 10, 31, 31, 14, 4, 0, 0};
void setup() { lcd.begin(16, 2); lcd.createChar(0, heart); lcd.setCursor(0, 0); lcd.print("Parallel "); lcd.write(byte(0)); }
void loop() {}`, 'lcd_par');
    const p = new Bench('uno');
    p.add('wokwi-lcd1602-parallel', 'lcd');
    p.wire('lcd:RS', 'uno:12', 'lcd:E', 'uno:11', 'lcd:D4', 'uno:5', 'lcd:D5', 'uno:4', 'lcd:D6', 'uno:3', 'lcd:D7', 'uno:2',
      'lcd:RW', 'uno:GND.1', 'lcd:VSS', 'uno:GND.1', 'lcd:VDD', 'uno:5V', 'lcd:K', 'uno:GND.2', 'lcd:A', 'uno:5V');
    p.load(par).run(0.3);
    const chars = p.part('lcd').el.characters;
    expect(String.fromCharCode(...chars.slice(0, 9))).toBe('Parallel ');
    expect(chars[9]).toBe(0);
    expect(p.part('lcd').el.font[0 * 8 + 1]).toBe(0b01010);
  }, T);

  withLibs('Adafruit SSD1306', 'Adafruit GFX Library')('draws on an SSD1306 OLED over I2C', () => {
    const hex = uno(`
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
Adafruit_SSD1306 display(128, 64, &Wire, -1);
void setup() {
  Serial.begin(115200);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) { Serial.println("no oled"); for(;;); }
  display.clearDisplay();
  display.fillRect(0, 0, 10, 8, SSD1306_WHITE);
  display.drawPixel(127, 63, SSD1306_WHITE);
  display.display();
  Serial.println("ok");
}
void loop() {}`, 'oled');
    const b = new Bench('uno');
    b.add('wokwi-ssd1306', 'oled');
    b.wire('oled:DATA', 'uno:A4', 'oled:CLK', 'uno:A5', 'oled:VIN', 'uno:5V', 'oled:GND', 'uno:GND.1');
    b.load(hex).run(0.6);
    expect(b.serial).toContain('ok');
    const oled = b.behavior('oled').oled;
    expect(oled.on).toBe(true);
    expect(oled.pixel(0, 0)).toBe(true);
    expect(oled.pixel(9, 7)).toBe(true);
    expect(oled.pixel(10, 0)).toBe(false);
    expect(oled.pixel(127, 63)).toBe(true);
    expect(oled.pixel(64, 32)).toBe(false);
    // The element received the rendered frame.
    const d = b.part('oled').el.imageData.data;
    expect(d[0]).toBeGreaterThan(200);
  }, T);

  it('finds only the I2C devices that exist (scanner sketch)', () => {
    const hex = uno(`
#include <Wire.h>
void setup() {
  Serial.begin(115200); Wire.begin();
  for (byte a = 1; a < 127; a++) { Wire.beginTransmission(a); if (Wire.endTransmission() == 0) { Serial.print("found 0x"); Serial.println(a, HEX); } }
  Serial.println("done");
}
void loop() {}`, 'scanner');
    const b = new Bench('uno');
    b.add('wokwi-lcd1602', 'lcd');
    b.add('wokwi-ssd1306', 'oled');
    b.add('wokwi-ds1307', 'rtc');
    b.wire('lcd:SDA', 'uno:A4', 'lcd:SCL', 'uno:A5', 'oled:DATA', 'uno:A4', 'oled:CLK', 'uno:A5', 'rtc:SDA', 'uno:A4', 'rtc:SCL', 'uno:A5');
    b.load(hex).run(0.4);
    expect(b.lines()).toEqual(['found 0x27', 'found 0x3C', 'found 0x68', 'done']);
  }, T);
});
