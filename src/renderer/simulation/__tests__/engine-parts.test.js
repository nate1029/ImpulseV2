// More parts end-to-end with real libraries: addressable LEDs, keypads,
// motors, shift registers, LED matrices, encoders, IR, RTC, IMU, load cells.
import { Bench } from './bench.js';
import { compileSketch, describeWithCli, installedLibraries } from './cli.js';
import { BOARDS } from '../boards.js';
import { breadboardPins } from '../parts/modules.js';

const LIBS = installedLibraries();
const withLibs = (...names) => (names.every(n => LIBS.has(n.toLowerCase())) ? it : it.skip);
const uno = (code, name) => compileSketch(code, BOARDS.uno.fqbn, name);
const T = 120000;

describeWithCli('parts with real libraries', () => {
  withLibs('Adafruit NeoPixel')('drives a NeoPixel ring and a chained single pixel', () => {
    const hex = uno(`
#include <Adafruit_NeoPixel.h>
Adafruit_NeoPixel strip(17, 6, NEO_GRB + NEO_KHZ800);
void setup() {
  strip.begin();
  strip.setPixelColor(0, strip.Color(255, 0, 0));
  strip.setPixelColor(5, strip.Color(0, 128, 0));
  strip.setPixelColor(15, strip.Color(0, 0, 64));
  strip.setPixelColor(16, strip.Color(10, 20, 30));
  strip.show();
}
void loop() {}`, 'neopixel');
    const b = new Bench('uno');
    b.add('wokwi-led-ring', 'ring', { pixels: '16' });
    b.add('wokwi-neopixel', 'px');
    b.wire('ring:DIN', 'uno:6', 'ring:DOUT', 'px:DIN', 'ring:VCC', 'uno:5V', 'ring:GND', 'uno:GND.1');
    b.load(hex).run(0.1);
    // Decoded bytes, exactly as the sketch sent them…
    const raw = b.behavior('ring').pixels;
    expect(raw[0]).toEqual({ r: 255, g: 0, b: 0 });
    expect(raw[5]).toEqual({ r: 0, g: 128, b: 0 });
    expect(raw[15]).toEqual({ r: 0, g: 0, b: 64 });
    expect(raw[1]).toEqual({ r: 0, g: 0, b: 0 });
    expect(b.behavior('px').pixels[0]).toEqual({ r: 10, g: 20, b: 30 });
    // …and shown with a display gamma so dim values stay visible.
    const px = b.part('ring').el.pixels;
    expect(px[0]).toEqual({ r: 1, g: 0, b: 0 });
    expect(px[5].g).toBeGreaterThan(0.6);
    expect(px[5].g).toBeLessThan(0.8);
  }, T);

  withLibs('Keypad')('reads keys through the Keypad library', () => {
    const hex = uno(`
#include <Keypad.h>
char keys[4][4] = {{'1','2','3','A'},{'4','5','6','B'},{'7','8','9','C'},{'*','0','#','D'}};
byte rowPins[4] = {9, 8, 7, 6};
byte colPins[4] = {5, 4, 3, 2};
Keypad keypad = Keypad(makeKeymap(keys), rowPins, colPins, 4, 4);
void setup() { Serial.begin(115200); }
void loop() { char k = keypad.getKey(); if (k) { Serial.print("key "); Serial.println(k); } }`, 'keypad');
    const b = new Bench('uno');
    b.add('wokwi-membrane-keypad', 'kp');
    b.wire('kp:R1', 'uno:9', 'kp:R2', 'uno:8', 'kp:R3', 'uno:7', 'kp:R4', 'uno:6', 'kp:C1', 'uno:5', 'kp:C2', 'uno:4', 'kp:C3', 'uno:3', 'kp:C4', 'uno:2');
    b.load(hex).run(0.05);
    const press = (key, row, column) => (bench) => bench.part('kp').el.dispatchEvent(new CustomEvent('button-press', { detail: { key, row, column } }));
    const release = (key) => (bench) => bench.part('kp').el.dispatchEvent(new CustomEvent('button-release', { detail: { key } }));
    b.run(0.6, [[0.06, press('5', 1, 1)], [0.2, release('5')], [0.3, press('D', 3, 3)], [0.45, release('D')]]);
    expect(b.lines()).toEqual(['key 5', 'key D']);
  }, T);

  withLibs('Servo')('turns a servo with Servo.write()', () => {
    const hex = uno(`
#include <Servo.h>
Servo s;
void setup() { s.attach(9); s.write(45); delay(300); s.write(135); }
void loop() {}`, 'servo');
    const b = new Bench('uno');
    b.add('wokwi-servo', 'servo');
    b.wire('servo:PWM', 'uno:9', 'servo:V+', 'uno:5V', 'servo:GND', 'uno:GND.1');
    b.load(hex).run(0.2);
    expect(b.part('servo').el.angle).toBeGreaterThan(43);
    expect(b.part('servo').el.angle).toBeLessThan(47);
    b.run(0.3);
    expect(b.part('servo').el.angle).toBeGreaterThan(133);
    expect(b.part('servo').el.angle).toBeLessThan(137);
  }, T);

  it('shifts data through two cascaded 74HC595s (shiftOut and SPI)', () => {
    for (const [name, body] of [
      ['shiftout', 'digitalWrite(10, LOW); shiftOut(11, 13, MSBFIRST, 0x81); shiftOut(11, 13, MSBFIRST, 0xA5); digitalWrite(10, HIGH);'],
      ['spi', 'SPI.begin(); digitalWrite(10, LOW); SPI.transfer(0x81); SPI.transfer(0xA5); digitalWrite(10, HIGH);'],
    ]) {
      const hex = uno(`
#include <SPI.h>
void setup() { pinMode(10, OUTPUT); pinMode(11, OUTPUT); pinMode(13, OUTPUT); ${body} }
void loop() {}`, `hc595_${name}`);
      const b = new Bench('uno');
      b.add('impulse-74hc595', 'sr1');
      b.add('impulse-74hc595', 'sr2');
      b.add('wokwi-led', 'led');
      b.wire('sr1:DS', 'uno:11', 'sr1:SHCP', 'uno:13', 'sr1:STCP', 'uno:10', 'sr1:MR', 'uno:5V', 'sr1:OE', 'uno:GND.1');
      b.wire('sr2:DS', 'sr1:Q7S', 'sr2:SHCP', 'uno:13', 'sr2:STCP', 'uno:10', 'sr2:MR', 'uno:5V', 'sr2:OE', 'uno:GND.1');
      b.wire('led:A', 'sr2:Q0', 'led:C', 'uno:GND.2');
      b.load(hex).run(0.05);
      expect(b.behavior('sr1').reg.latched).toBe(0xa5);
      expect(b.behavior('sr2').reg.latched).toBe(0x81);
      expect(b.part('led').el.value).toBe(true);
    }
  }, T);

  withLibs('LedControl')('draws on a MAX7219 matrix with LedControl', () => {
    const hex = uno(`
#include <LedControl.h>
LedControl lc(12, 11, 10, 1);
void setup() { lc.shutdown(0, false); lc.setIntensity(0, 8); lc.clearDisplay(0); lc.setRow(0, 0, B10000001); lc.setLed(0, 7, 3, true); }
void loop() {}`, 'max7219');
    const b = new Bench('uno');
    b.add('impulse-max7219-matrix', 'mx');
    b.wire('mx:DIN', 'uno:12', 'mx:CLK', 'uno:11', 'mx:CS', 'uno:10', 'mx:VCC', 'uno:5V', 'mx:GND', 'uno:GND.1');
    b.load(hex).run(0.1);
    const v = b.part('mx').el.values;
    expect(v.slice(0, 8)).toEqual([1, 0, 0, 0, 0, 0, 0, 1]);
    expect(v[7 * 8 + 3]).toBe(1);
    expect(v.reduce((a, x) => a + x, 0)).toBe(3);
  }, T);

  it('counts rotary encoder detents both ways (interrupt sketch)', () => {
    const hex = uno(`
volatile int pos = 0;
void onClk() { if (digitalRead(3) == HIGH) pos++; else pos--; }
void setup() { Serial.begin(115200); pinMode(2, INPUT); pinMode(3, INPUT); pinMode(4, INPUT_PULLUP); attachInterrupt(digitalPinToInterrupt(2), onClk, FALLING); }
void loop() { static int last = 99; if (pos != last) { last = pos; Serial.print("pos="); Serial.println(pos); } if (digitalRead(4) == LOW) { Serial.println("push"); delay(100); } }`, 'encoder');
    const b = new Bench('uno');
    b.add('wokwi-ky-040', 'enc');
    b.wire('enc:CLK', 'uno:2', 'enc:DT', 'uno:3', 'enc:SW', 'uno:4', 'enc:VCC', 'uno:5V', 'enc:GND', 'uno:GND.1');
    b.load(hex).run(0.02);
    const turn = (dir) => (bench) => bench.behavior('enc').turn(dir);
    b.run(0.3, [[0.03, turn(1)], [0.05, turn(1)], [0.07, turn(1)], [0.12, turn(-1)], [0.2, (x) => x.behavior('enc')._press()], [0.25, (x) => x.behavior('enc')._release()]]);
    expect(b.lines()).toEqual(['pos=0', 'pos=1', 'pos=2', 'pos=3', 'pos=2', 'push']);
  }, T);

  withLibs('IRremote')('decodes IR remote buttons with IRremote', () => {
    const hex = uno(`
#include <IRremote.hpp>
void setup() { Serial.begin(115200); IrReceiver.begin(2, DISABLE_LED_FEEDBACK); }
void loop() {
  if (IrReceiver.decode()) {
    if (!(IrReceiver.decodedIRData.flags & IRDATA_FLAGS_IS_REPEAT)) { Serial.print("cmd=0x"); Serial.println(IrReceiver.decodedIRData.command, HEX); }
    IrReceiver.resume();
  }
}`, 'irremote');
    const b = new Bench('uno');
    b.add('wokwi-ir-receiver', 'ir');
    b.add('wokwi-ir-remote', 'remote');
    b.wire('ir:DAT', 'uno:2', 'ir:VCC', 'uno:5V', 'ir:GND', 'uno:GND.1');
    b.load(hex).run(0.05);
    const remote = (code) => (x) => x.behavior('remote').press(code);
    const up = (x) => x.behavior('remote').release();
    b.run(1.0, [[0.3, remote(0xa2)], [0.45, up], [0.6, remote(0x68)], [0.8, up]]);
    expect(b.lines()).toEqual(['cmd=0xA2', 'cmd=0x68']);
  }, T);

  withLibs('RTClib')('keeps time in a DS1307 RTC (RTClib)', () => {
    const hex = uno(`
#include <RTClib.h>
RTC_DS1307 rtc;
void setup() {
  Serial.begin(115200);
  if (!rtc.begin()) { Serial.println("no rtc"); return; }
  rtc.adjust(DateTime(2030, 6, 15, 12, 30, 0));
  delay(2000);
  DateTime n = rtc.now();
  Serial.print(n.year()); Serial.print('-'); Serial.print(n.month()); Serial.print('-'); Serial.print(n.day());
  Serial.print(' '); Serial.print(n.hour()); Serial.print(':'); Serial.print(n.minute()); Serial.print(':'); Serial.println(n.second());
}
void loop() {}`, 'rtc');
    const b = new Bench('uno');
    b.add('wokwi-ds1307', 'rtc');
    b.wire('rtc:SDA', 'uno:A4', 'rtc:SCL', 'uno:A5', 'rtc:5V', 'uno:5V', 'rtc:GND', 'uno:GND.1');
    b.load(hex).run(2.3);
    expect(b.lines().slice(-1)[0]).toBe('2030-6-15 12:30:2');
  }, T);

  withLibs('Adafruit MPU6050')('reports acceleration from an MPU6050', () => {
    const hex = uno(`
#include <Adafruit_MPU6050.h>
Adafruit_MPU6050 mpu;
void setup() {
  Serial.begin(115200);
  if (!mpu.begin()) { Serial.println("no mpu"); return; }
  mpu.setAccelerometerRange(MPU6050_RANGE_2_G);
  sensors_event_t a, g, t; mpu.getEvent(&a, &g, &t);
  Serial.print("ax="); Serial.print(a.acceleration.x, 1); Serial.print(" az="); Serial.print(a.acceleration.z, 1); Serial.print(" t="); Serial.println(t.temperature, 0);
}
void loop() {}`, 'mpu');
    const b = new Bench('uno');
    b.add('wokwi-mpu6050', 'imu', { accelX: '0.5', accelZ: '1', temperature: '30' });
    b.wire('imu:SDA', 'uno:A4', 'imu:SCL', 'uno:A5', 'imu:VCC', 'uno:5V', 'imu:GND', 'uno:GND.1');
    b.load(hex).run(0.4);
    expect(b.lines().slice(-1)[0]).toBe('ax=4.9 az=9.8 t=30');
  }, T);

  withLibs('HX711')('weighs with an HX711 load cell', () => {
    const hex = uno(`
#include <HX711.h>
HX711 scale;
void setup() { Serial.begin(115200); scale.begin(3, 2); }
void loop() { if (scale.is_ready()) { Serial.print("raw="); Serial.println(scale.read()); delay(50); } }`, 'hx711');
    const b = new Bench('uno');
    b.add('wokwi-hx711', 'cell', { weight: '1000' });
    b.wire('cell:DT', 'uno:3', 'cell:SCK', 'uno:2', 'cell:VCC', 'uno:5V', 'cell:GND', 'uno:GND.1');
    b.load(hex).run(0.2);
    expect(b.lines().slice(-1)[0]).toMatch(/^raw=420000(\.00)?$/);
  }, T);

  withLibs('SevSeg')('shows a number on a 4-digit 7-segment with SevSeg', () => {
    const hex = uno(`
#include <SevSeg.h>
SevSeg sevseg;
void setup() {
  byte digitPins[] = {2, 3, 4, 5};
  byte segmentPins[] = {6, 7, 8, 9, 10, 11, 12, 13};
  sevseg.begin(COMMON_ANODE, 4, digitPins, segmentPins, true);
  sevseg.setNumber(1234);
}
void loop() { sevseg.refreshDisplay(); }`, 'sevseg');
    const b = new Bench('uno');
    b.add('wokwi-7segment-4', 'seg', { common: 'anode' });
    const segs = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP'];
    segs.forEach((s, i) => b.wire(`seg:${s}`, `uno:${6 + i}`));
    ['DIG1', 'DIG2', 'DIG3', 'DIG4'].forEach((d, i) => b.wire(`seg:${d}`, `uno:${2 + i}`));
    b.load(hex).run(0.3);
    const v = b.part('seg').el.values;
    // A B C D E F G DP per digit
    expect(v.slice(0, 8)).toEqual([0, 1, 1, 0, 0, 0, 0, 0]); // 1
    expect(v.slice(8, 16)).toEqual([1, 1, 0, 1, 1, 0, 1, 0]); // 2
    expect(v.slice(16, 24)).toEqual([1, 1, 1, 1, 0, 0, 1, 0]); // 3
    expect(v.slice(24, 32)).toEqual([0, 1, 1, 0, 0, 1, 1, 0]); // 4
  }, T);

  withLibs('Stepper')('steps a bipolar stepper with the Stepper library', () => {
    const hex = uno(`
#include <Stepper.h>
Stepper motor(200, 8, 9, 10, 11);
void setup() { motor.setSpeed(60); motor.step(50); }
void loop() {}`, 'stepper');
    const b = new Bench('uno');
    b.add('wokwi-stepper-motor', 'm');
    b.wire('m:A+', 'uno:8', 'm:A-', 'uno:9', 'm:B+', 'uno:10', 'm:B-', 'uno:11');
    b.load(hex).run(0.4);
    expect(Math.abs(b.behavior('m').steps)).toBe(50);
    expect(b.part('m').el.angle).toBeCloseTo(b.behavior('m').steps > 0 ? 90 : 270, 0);
  }, T);

  it('switches loads through a relay module and an NPN transistor', () => {
    const hex = uno('void setup(){ pinMode(7, OUTPUT); pinMode(8, OUTPUT); } void loop(){ digitalWrite(7, HIGH); digitalWrite(8, HIGH); delay(100); digitalWrite(7, LOW); digitalWrite(8, LOW); delay(100); }', 'switching');
    const b = new Bench('uno');
    b.add('impulse-relay-module', 'relay');
    b.add('wokwi-led', 'lamp');
    b.add('wokwi-resistor', 'rb', { value: '1000' });
    b.add('impulse-npn-transistor', 'q1');
    b.add('wokwi-led', 'load');
    b.add('wokwi-resistor', 'rl', { value: '220' });
    b.wire('relay:IN', 'uno:7', 'relay:VCC', 'uno:5V', 'relay:GND', 'uno:GND.1', 'relay:COM', 'uno:5V', 'relay:NO', 'lamp:A', 'lamp:C', 'uno:GND.1');
    b.wire('uno:8', 'rb:1', 'rb:2', 'q1:B', 'q1:E', 'uno:GND.2', 'uno:5V', 'rl:1', 'rl:2', 'load:A', 'load:C', 'q1:C');
    b.load(hex).run(0.05);
    expect(b.part('lamp').el.value).toBe(true);
    expect(b.part('load').el.value).toBe(true);
    b.run(0.1);
    expect(b.part('lamp').el.value).toBe(false);
    expect(b.part('load').el.value).toBe(false);
  }, T);

  it('connects parts through breadboard strips and rails', () => {
    const hex = uno('void setup(){ pinMode(12, OUTPUT); digitalWrite(12, HIGH); } void loop(){}', 'breadboard');
    const b = new Bench('uno');
    b.add('impulse-breadboard-half', 'bb', { size: 'half' });
    expect(b.part('bb').el.pinInfo.length).toBe(breadboardPins('half').length);
    b.add('wokwi-resistor', 'r1');
    b.add('wokwi-led', 'led');
    // Pin 12 → column 5, resistor 5→9, LED 9 → minus rail, rail → GND.
    b.wire('uno:12', 'bb:5t.a', 'r1:1', 'bb:5t.c', 'r1:2', 'bb:9t.c', 'led:A', 'bb:9t.e', 'led:C', 'bb:tn.7', 'bb:tn.20', 'uno:GND.1');
    b.load(hex).run(0.05);
    expect(b.part('led').el.value).toBe(true);
  }, T);

  it('keeps EEPROM across a reset', () => {
    const hex = uno(`
#include <EEPROM.h>
void setup() { Serial.begin(115200); byte n = EEPROM.read(0); Serial.print("boot "); Serial.println(n); EEPROM.write(0, n + 1); }
void loop() {}`, 'eeprom');
    const b = new Bench('uno');
    b.load(hex).run(0.05);
    b.runner.reset();
    b.engine.restartParts();
    b.run(0.05);
    expect(b.lines()).toEqual(['boot 255', 'boot 0']);
  }, T);

  it('drives Mega-only pins and analog inputs from parts', () => {
    const hex = compileSketch(`
void setup() { Serial.begin(115200); pinMode(40, OUTPUT); digitalWrite(40, HIGH); }
void loop() { Serial.print("a12="); Serial.println(analogRead(A12)); delay(20); }`, BOARDS.mega.fqbn, 'mega_parts');
    const b = new Bench('mega');
    b.add('wokwi-led', 'led');
    b.add('wokwi-resistor', 'r');
    b.add('wokwi-potentiometer', 'pot', { value: '1023' });
    b.wire('mega:40', 'r:1', 'r:2', 'led:A', 'led:C', 'mega:GND.1', 'pot:SIG', 'mega:A12', 'pot:VCC', 'mega:5V', 'pot:GND', 'mega:GND.2');
    b.load(hex).run(0.1);
    expect(b.part('led').el.value).toBe(true);
    expect(b.lines().slice(-1)[0]).toMatch(/a12=102[23]/);
  }, T);
});
