// Ready-to-run example projects: a sketch plus its wired circuit.
// Every example is compiled and simulated by the test suite.

import { PART_PINS } from './parts/pins.js';
import { PARTS } from './parts/catalog.js';
import { breadboardHole } from './parts/modules.js';
import { routeHints } from './diagram.js';

export const EXAMPLE_CATEGORIES = ['Basics', 'Displays', 'Sensors', 'Input', 'Motors', 'Logic', 'Boards', 'Projects'];

/** Builds a diagram with parts placed by where one of their pins should land. */
class Layout {
  constructor(boardType, x = 0, y = 0) {
    this.parts = [];
    this.wires = [];
    this.boardId = {
      'wokwi-arduino-uno': 'uno', 'wokwi-arduino-nano': 'nano', 'wokwi-arduino-mega': 'mega', 'impulse-pi-pico': 'pico', 'impulse-attiny85': 'attiny85',
      'impulse-arduino-leonardo': 'leonardo', 'wokwi-esp32-devkit-v1': 'esp32', 'impulse-esp32-s3-devkitc': 'esp32s3', 'impulse-esp32-c3-devkitm': 'esp32c3', 'impulse-nano-esp32': 'nanoesp32',
    }[boardType];
    this.part(boardType, this.boardId, { x, y });
  }

  part(type, id, { x = 0, y = 0, rotate = 0, attrs = {} } = {}) {
    this.parts.push({ type, id, x: round(x), y: round(y), rotate, attrs: { ...(PARTS[type]?.attrs || {}), ...attrs } });
    return this;
  }

  /** World position of a placed part's pin. */
  pin(ref) {
    const [id, name] = ref.split(/:(.+)/);
    const p = this.parts.find(q => q.id === id);
    if (p.type.includes('breadboard')) {
      const h = breadboardHole(p.attrs.size || 'full', name);
      return { x: p.x + h.x, y: p.y + h.y };
    }
    const local = pinLocal(p.type, name, p.rotate);
    return { x: p.x + local.x, y: p.y + local.y };
  }

  /** Place `type` so its `pin` sits at `target` (a point or "part:pin"). */
  at(type, id, pin, target, { rotate = 0, attrs = {}, dx = 0, dy = 0 } = {}) {
    const t = typeof target === 'string' ? this.pin(target) : target;
    const local = pinLocal(type, pin, rotate);
    return this.part(type, id, { x: t.x + dx - local.x, y: t.y + dy - local.y, rotate, attrs });
  }

  wire(a, b, color = null, points = []) {
    const [ap, apin] = a.split(/:(.+)/);
    const [bp, bpin] = b.split(/:(.+)/);
    this.wires.push({ from: { partId: ap, pin: apin }, to: { partId: bp, pin: bpin }, color, points });
    return this;
  }

  /** Chain of wires a-b, b-c, … */
  chain(color, ...ends) {
    for (let i = 0; i + 1 < ends.length; i++) this.wire(ends[i], ends[i + 1], color);
    return this;
  }

  done() {
    for (const w of this.wires) if (w.points.length) w.start = this.pin(`${w.from.partId}:${w.from.pin}`);
    return { parts: this.parts, wires: this.wires };
  }
}

const round = (v) => Math.round(v * 100) / 100;

function pinLocal(type, pin, rotate = 0) {
  const t = PART_PINS[type];
  if (!t) throw new Error(`No pin table for ${type}`);
  const at = t.at[pin];
  if (!at) throw new Error(`${type} has no pin ${pin}`);
  if (!rotate) return { x: at[0], y: at[1] };
  const a = (rotate * Math.PI) / 180;
  const dx = at[0] - t.w / 2;
  const dy = at[1] - t.h / 2;
  return { x: t.w / 2 + dx * Math.cos(a) - dy * Math.sin(a), y: t.h / 2 + dx * Math.sin(a) + dy * Math.cos(a) };
}

// ── Circuits ─────────────────────────────────────────────────────────────────

function ledOnPin(L, board, pin, ledId, color, x, y) {
  const rId = `r_${ledId}`;
  L.at('wokwi-led', ledId, 'A', { x, y }, { attrs: { color } });
  // Rotated 90°, pin 1 is the top end: the resistor hangs below the anode.
  L.at('wokwi-resistor', rId, '1', `${ledId}:A`, { rotate: 90, dy: 10 });
  L.wire(`${rId}:1`, `${ledId}:A`);
  L.wire(`${rId}:2`, `${board}:${pin}`);
  return L;
}

const circuits = {
  blink() {
    const L = new Layout('wokwi-arduino-uno', 0, 160);
    ledOnPin(L, 'uno', '13', 'led1', 'red', 120, 40);
    L.wire('led1:C', 'uno:GND.1', 'black');
    return L.done();
  },

  button() {
    const L = new Layout('wokwi-arduino-uno', 0, 160);
    ledOnPin(L, 'uno', '13', 'led1', 'red', 108, 40);
    L.wire('led1:C', 'uno:GND.1', 'black');
    L.at('wokwi-pushbutton', 'btn1', '1.l', { x: 210, y: 70 }, { attrs: { color: 'green', key: 'b' } });
    L.wire('btn1:1.l', 'uno:2', 'blue');
    L.wire('btn1:2.l', 'uno:GND.1', 'black');
    return L.done();
  },

  fade() {
    const L = new Layout('wokwi-arduino-uno', 0, 160);
    ledOnPin(L, 'uno', '9', 'led1', 'green', 158, 40);
    L.wire('led1:C', 'uno:GND.1', 'black');
    return L.done();
  },

  trafficLight() {
    const L = new Layout('wokwi-arduino-uno', 0, 250);
    L.part('impulse-breadboard-half', 'bb', { x: 20, y: 0, attrs: { size: 'half' } });
    const leds = [['red', 3, '12'], ['yellow', 12, '11'], ['green', 21, '10']];
    for (const [color, col, pin] of leds) {
      const id = `led_${color}`;
      L.at('wokwi-led', id, 'C', `bb:${col}t.a`, { attrs: { color } });
      L.at('wokwi-resistor', `r_${color}`, '1', `bb:${col + 1}t.c`);
      L.wire(`uno:${pin}`, `bb:${col + 7}t.e`, color === 'yellow' ? 'orange' : color);
      L.wire(`bb:${col}t.b`, `bb:tn.${Math.round((col + 2) * 25 / 30)}`, 'black');
    }
    L.wire('uno:GND.1', 'bb:tn.1', 'black');
    return L.done();
  },

  potentiometer() {
    const L = new Layout('wokwi-arduino-uno', 0, 160);
    ledOnPin(L, 'uno', '9', 'led1', 'yellow', 158, 40);
    L.wire('led1:C', 'uno:GND.1', 'black');
    L.at('wokwi-potentiometer', 'pot1', 'SIG', { x: 230, y: 470 }, { attrs: { value: '512' } });
    L.wire('pot1:SIG', 'uno:A0', 'green');
    L.wire('pot1:VCC', 'uno:5V', 'red');
    L.wire('pot1:GND', 'uno:GND.2', 'black');
    return L.done();
  },

  rgb() {
    const L = new Layout('wokwi-arduino-uno', 0, 180);
    L.at('wokwi-rgb-led', 'rgb1', 'COM', { x: 180, y: 70 }, { attrs: { common: 'cathode' } });
    L.wire('rgb1:R', 'uno:9', 'red');
    L.wire('rgb1:G', 'uno:10', 'green');
    L.wire('rgb1:B', 'uno:11', 'blue');
    L.wire('rgb1:COM', 'uno:GND.1', 'black');
    return L.done();
  },

  melody() {
    const L = new Layout('wokwi-arduino-uno', 0, 170);
    L.at('wokwi-buzzer', 'buzzer1', '2', { x: 180, y: 110 });
    L.wire('buzzer1:2', 'uno:8', 'orange');
    L.wire('buzzer1:1', 'uno:GND.1', 'black');
    return L.done();
  },

  serialEcho() {
    const L = new Layout('wokwi-arduino-uno', 0, 160);
    ledOnPin(L, 'uno', '13', 'led1', 'yellow', 120, 40);
    L.wire('led1:C', 'uno:GND.1', 'black');
    return L.done();
  },

  lcd() {
    const L = new Layout('wokwi-arduino-uno', 0, 40);
    L.at('wokwi-lcd1602', 'lcd1', 'GND', { x: 340, y: 60 });
    L.wire('lcd1:GND', 'uno:GND.2', 'black');
    L.wire('lcd1:VCC', 'uno:5V', 'red');
    L.wire('lcd1:SDA', 'uno:A4', 'blue');
    L.wire('lcd1:SCL', 'uno:A5', 'purple');
    return L.done();
  },

  oled() {
    const L = new Layout('wokwi-arduino-uno', 0, 180);
    L.at('wokwi-ssd1306', 'oled1', 'DATA', { x: 140, y: 40 });
    L.wire('oled1:DATA', 'uno:A4', 'blue');
    L.wire('oled1:CLK', 'uno:A5', 'purple');
    L.wire('oled1:VIN', 'uno:5V', 'red');
    L.wire('oled1:GND', 'uno:GND.1', 'black');
    return L.done();
  },

  sevenSegment() {
    const L = new Layout('wokwi-arduino-uno', 0, 180);
    L.at('wokwi-7segment-4', 'seg1', 'DIG1', { x: 60, y: 30 }, { attrs: { common: 'anode', colon: '' } });
    const seg = L.parts.find(p => p.id === 'seg1');
    const color = (name) => (name.startsWith('DIG') ? 'blue' : 'green');
    // Top-row pins, right to left, run over the display and down its right side
    // in nested lanes; the sketch's pin choice keeps the lanes from crossing.
    ['B', 'DIG3', 'DIG2', 'F', 'A', 'DIG1'].forEach((name, k) => {
      const from = L.pin(`seg1:${name}`);
      const to = L.pin(`uno:${7 - k}`);
      const top = seg.y - 6 - 5 * k;
      const side = 246 + 5 * k;
      const drop = 150 + 5 * k;
      L.wire(`seg1:${name}`, `uno:${7 - k}`, color(name),
        [{ x: from.x, y: top }, { x: side, y: top }, { x: side, y: drop }, { x: to.x, y: drop }]);
    });
    // Bottom-row pins, left to right, step down to pins 13…8.
    ['E', 'D', 'DP', 'C', 'G', 'DIG4'].forEach((name, k) => {
      const from = L.pin(`seg1:${name}`);
      const to = L.pin(`uno:${13 - k}`);
      const lane = 145 - 5 * k;
      L.wire(`seg1:${name}`, `uno:${13 - k}`, color(name), [{ x: from.x, y: lane }, { x: to.x, y: lane }]);
    });
    return L.done();
  },

  neopixel() {
    const L = new Layout('wokwi-arduino-uno', 0, 210);
    L.at('wokwi-led-ring', 'ring1', 'DIN', { x: 200, y: 170 }, { attrs: { pixels: '16' } });
    L.wire('ring1:DIN', 'uno:6', 'green');
    L.wire('ring1:VCC', 'uno:5V', 'red');
    L.wire('ring1:GND', 'uno:GND.1', 'black');
    return L.done();
  },

  matrix() {
    const L = new Layout('wokwi-arduino-uno', 0, 210);
    L.at('impulse-max7219-matrix', 'matrix1', 'DIN', { x: 170, y: 170 });
    L.wire('matrix1:DIN', 'uno:12', 'green');
    L.wire('matrix1:CLK', 'uno:11', 'purple');
    L.wire('matrix1:CS', 'uno:10', 'orange');
    L.wire('matrix1:VCC', 'uno:5V', 'red');
    L.wire('matrix1:GND', 'uno:GND.1', 'black');
    return L.done();
  },

  ultrasonic() {
    const L = new Layout('wokwi-arduino-uno', 0, 190);
    L.at('wokwi-hc-sr04', 'sonar1', 'TRIG', { x: 227, y: 140 }, { attrs: { distance: '100' } });
    L.wire('sonar1:TRIG', 'uno:3', 'orange');
    L.wire('sonar1:ECHO', 'uno:2', 'green');
    L.wire('sonar1:VCC', 'uno:5V', 'red');
    L.wire('sonar1:GND', 'uno:GND.1', 'black');
    L.at('wokwi-lcd1602', 'lcd1', 'GND', { x: 360, y: 260 });
    L.wire('lcd1:GND', 'uno:GND.2', 'black');
    L.wire('lcd1:VCC', 'uno:5V', 'red');
    L.wire('lcd1:SDA', 'uno:A4', 'blue');
    L.wire('lcd1:SCL', 'uno:A5', 'purple');
    return L.done();
  },

  weather() {
    const L = new Layout('wokwi-arduino-uno', 0, 200);
    L.at('wokwi-dht22', 'dht1', 'SDA', { x: 236.5, y: 160 }, { attrs: { temperature: '24', humidity: '40' } });
    L.wire('dht1:SDA', 'uno:2', 'green');
    L.wire('dht1:VCC', 'uno:5V', 'red');
    L.wire('dht1:GND', 'uno:GND.1', 'black');
    L.at('wokwi-ssd1306', 'oled1', 'DATA', { x: 330, y: 230 });
    L.wire('oled1:DATA', 'uno:A4', 'blue');
    L.wire('oled1:CLK', 'uno:A5', 'purple');
    L.wire('oled1:VIN', 'uno:5V', 'red');
    L.wire('oled1:GND', 'uno:GND.2', 'black');
    return L.done();
  },

  pirAlarm() {
    const L = new Layout('wokwi-arduino-uno', 0, 180);
    L.at('wokwi-pir-motion-sensor', 'pir1', 'OUT', { x: 300, y: 110 });
    L.wire('pir1:OUT', 'uno:2', 'green');
    L.wire('pir1:VCC', 'uno:5V', 'red');
    L.wire('pir1:GND', 'uno:GND.1', 'black');
    L.at('wokwi-buzzer', 'buzzer1', '2', { x: 195, y: 130 });
    L.wire('buzzer1:2', 'uno:8', 'orange');
    L.wire('buzzer1:1', 'uno:GND.1', 'black');
    ledOnPin(L, 'uno', '13', 'led1', 'red', 60, 40);
    L.wire('led1:C', 'uno:GND.1', 'black');
    return L.done();
  },

  nightLight() {
    const L = new Layout('wokwi-arduino-uno', 0, 200);
    ledOnPin(L, 'uno', '9', 'led1', 'white', 158, 60);
    L.wire('led1:C', 'uno:GND.1', 'black');
    L.at('wokwi-photoresistor-sensor', 'ldr1', 'AO', { x: 120, y: 470 }, { attrs: { lux: '50' } });
    L.wire('ldr1:AO', 'uno:A0', 'green');
    L.wire('ldr1:VCC', 'uno:5V', 'red');
    L.wire('ldr1:GND', 'uno:GND.2', 'black');
    return L.done();
  },

  rcCharge() {
    const L = new Layout('wokwi-arduino-uno', 0, 160);
    L.at('wokwi-resistor', 'r1', '1', { x: 190, y: 420 }, { attrs: { value: '10k' } });
    L.at('impulse-capacitor', 'c1', '1', { x: 280, y: 425 }, { attrs: { value: '100uF', type: 'electrolytic' } });
    L.wire('uno:A1', 'r1:1', 'orange');
    L.wire('r1:2', 'uno:A0', 'green');
    L.wire('r1:2', 'c1:1', 'green');
    L.wire('c1:2', 'uno:GND.2', 'black');
    return L.done();
  },

  imu() {
    const L = new Layout('wokwi-arduino-uno', 0, 160);
    L.at('wokwi-mpu6050', 'imu1', 'SDA', { x: 330, y: 60 });
    L.wire('imu1:SDA', 'uno:A4', 'blue');
    L.wire('imu1:SCL', 'uno:A5', 'purple');
    L.wire('imu1:VCC', 'uno:5V', 'red');
    L.wire('imu1:GND', 'uno:GND.2', 'black');
    return L.done();
  },

  rtc() {
    const L = new Layout('wokwi-arduino-uno', 0, 40);
    L.at('wokwi-ds1307', 'rtc1', 'SDA', { x: 330, y: 330 });
    L.wire('rtc1:SDA', 'uno:A4', 'blue');
    L.wire('rtc1:SCL', 'uno:A5', 'purple');
    L.wire('rtc1:5V', 'uno:5V', 'red');
    L.wire('rtc1:GND', 'uno:GND.3', 'black');
    L.at('wokwi-lcd1602', 'lcd1', 'GND', { x: 340, y: 60 });
    L.wire('lcd1:GND', 'uno:GND.2', 'black');
    L.wire('lcd1:VCC', 'uno:5V', 'red');
    L.wire('lcd1:SDA', 'uno:A4', 'blue');
    L.wire('lcd1:SCL', 'uno:A5', 'purple');
    return L.done();
  },

  scale() {
    const L = new Layout('wokwi-arduino-uno', 0, 40);
    L.at('wokwi-hx711', 'cell1', 'DT', { x: 330, y: 300 }, { attrs: { type: '5kg', weight: '0' } });
    L.wire('cell1:DT', 'uno:3', 'green');
    L.wire('cell1:SCK', 'uno:2', 'purple');
    L.wire('cell1:VCC', 'uno:5V', 'red');
    L.wire('cell1:GND', 'uno:GND.2', 'black');
    return L.done();
  },

  keypadLock() {
    const L = new Layout('wokwi-arduino-uno', 0, 380);
    L.at('wokwi-membrane-keypad', 'keypad1', 'R1', { x: 160, y: 330 }, { dy: 0 });
    const rows = ['R1', 'R2', 'R3', 'R4'];
    const cols = ['C1', 'C2', 'C3', 'C4'];
    rows.forEach((r, i) => L.wire(`keypad1:${r}`, `uno:${9 - i}`, 'green'));
    cols.forEach((c, i) => L.wire(`keypad1:${c}`, `uno:${5 - i}`, 'blue'));
    L.at('wokwi-servo', 'servo1', 'PWM', { x: 330, y: 300 });
    L.wire('servo1:PWM', 'uno:10', 'orange');
    L.wire('servo1:V+', 'uno:5V', 'red');
    L.wire('servo1:GND', 'uno:GND.1', 'black');
    L.at('wokwi-lcd1602', 'lcd1', 'GND', { x: 340, y: 470 });
    L.wire('lcd1:GND', 'uno:GND.2', 'black');
    L.wire('lcd1:VCC', 'uno:5V', 'red');
    L.wire('lcd1:SDA', 'uno:A4', 'blue');
    L.wire('lcd1:SCL', 'uno:A5', 'purple');
    return L.done();
  },

  encoder() {
    const L = new Layout('wokwi-arduino-uno', 0, 160);
    L.at('wokwi-ky-040', 'enc1', 'CLK', { x: 300, y: 50 });
    L.wire('enc1:CLK', 'uno:2', 'green');
    L.wire('enc1:DT', 'uno:3', 'blue');
    L.wire('enc1:SW', 'uno:4', 'orange');
    L.wire('enc1:VCC', 'uno:5V', 'red');
    L.wire('enc1:GND', 'uno:GND.2', 'black');
    return L.done();
  },

  joystickServo() {
    const L = new Layout('wokwi-arduino-uno', 0, 170);
    L.at('wokwi-analog-joystick', 'joy1', 'HORZ', { x: 360, y: 480 });
    L.wire('joy1:HORZ', 'uno:A0', 'green');
    L.wire('joy1:VERT', 'uno:A1', 'blue');
    L.wire('joy1:SEL', 'uno:2', 'orange');
    L.wire('joy1:VCC', 'uno:5V', 'red');
    L.wire('joy1:GND', 'uno:GND.2', 'black');
    L.at('wokwi-servo', 'servo1', 'PWM', { x: 300, y: 110 });
    L.wire('servo1:PWM', 'uno:9', 'orange');
    L.wire('servo1:V+', 'uno:5V', 'red');
    L.wire('servo1:GND', 'uno:GND.1', 'black');
    return L.done();
  },

  irRemote() {
    const L = new Layout('wokwi-arduino-uno', 0, 200);
    L.at('wokwi-ir-receiver', 'ir1', 'DAT', { x: 300, y: 150 });
    L.wire('ir1:DAT', 'uno:2', 'green');
    L.wire('ir1:VCC', 'uno:5V', 'red');
    L.wire('ir1:GND', 'uno:GND.1', 'black');
    L.part('wokwi-ir-remote', 'remote1', { x: 360, y: 20 });
    ledOnPin(L, 'uno', '9', 'led1', 'red', 120, 60);
    ledOnPin(L, 'uno', '10', 'led2', 'green', 158, 60);
    ledOnPin(L, 'uno', '11', 'led3', 'blue', 196, 60);
    L.wire('led1:C', 'uno:GND.1', 'black');
    L.wire('led2:C', 'led1:C', 'black');
    L.wire('led3:C', 'led2:C', 'black');
    return L.done();
  },

  servoSweep() {
    const L = new Layout('wokwi-arduino-uno', 0, 170);
    L.at('wokwi-servo', 'servo1', 'PWM', { x: 300, y: 100 });
    L.wire('servo1:PWM', 'uno:9', 'orange');
    L.wire('servo1:V+', 'uno:5V', 'red');
    L.wire('servo1:GND', 'uno:GND.1', 'black');
    return L.done();
  },

  stepper() {
    const L = new Layout('wokwi-arduino-uno', 0, 250);
    L.at('impulse-a4988', 'driver1', 'STEP', { x: 227, y: 140 });
    L.wire('driver1:STEP', 'uno:3', 'orange');
    L.wire('driver1:DIR', 'uno:2', 'blue');
    L.wire('driver1:SLEEP', 'driver1:RESET', 'gray');
    L.wire('driver1:VDD', 'uno:5V', 'red');
    L.wire('driver1:VMOT', 'uno:VIN', 'red');
    L.wire('driver1:GND', 'uno:GND.1', 'black');
    L.at('wokwi-stepper-motor', 'motor1', 'A+', { x: 250, y: -10 }, { dy: 0 });
    L.wire('driver1:1A', 'motor1:A+', 'green');
    L.wire('driver1:1B', 'motor1:A-', 'green');
    L.wire('driver1:2A', 'motor1:B+', 'purple');
    L.wire('driver1:2B', 'motor1:B-', 'purple');
    return L.done();
  },

  relay() {
    const L = new Layout('wokwi-arduino-uno', 0, 200);
    L.at('impulse-relay-module', 'relay1', 'IN', { x: 330, y: 120 });
    L.wire('relay1:IN', 'uno:7', 'orange');
    L.wire('relay1:VCC', 'uno:5V', 'red');
    L.wire('relay1:GND', 'uno:GND.1', 'black');
    L.at('wokwi-led', 'lamp1', 'A', { x: 560, y: 60 }, { attrs: { color: 'yellow' } });
    L.at('wokwi-resistor', 'r1', '1', 'lamp1:A', { rotate: 90, dy: 10 });
    L.wire('r1:1', 'lamp1:A');
    L.wire('relay1:NO', 'r1:2', 'red');
    L.wire('relay1:COM', 'uno:5V', 'red');
    L.wire('lamp1:C', 'uno:GND.2', 'black');
    L.at('wokwi-pushbutton', 'btn1', '1.l', { x: 200, y: 60 }, { attrs: { color: 'red', key: 'Space' } });
    L.wire('btn1:1.l', 'uno:2', 'blue');
    L.wire('btn1:2.l', 'uno:GND.1', 'black');
    return L.done();
  },

  dcMotor() {
    const L = new Layout('wokwi-arduino-uno', 0, 220);
    L.at('impulse-l293d', 'driver1', 'EN1', { x: 312, y: 170 });
    L.wire('driver1:EN1', 'uno:9', 'orange');
    L.wire('driver1:IN1', 'uno:8', 'blue');
    L.wire('driver1:IN2', 'uno:7', 'purple');
    L.wire('driver1:VSS', 'uno:5V', 'red');
    L.wire('driver1:VS', 'uno:5V', 'red');
    L.wire('driver1:GND.1', 'uno:GND.1', 'black');
    L.at('impulse-dc-motor', 'motor1', 'A', { x: 336, y: 60 });
    L.wire('driver1:OUT1', 'motor1:A', 'green');
    L.wire('driver1:OUT2', 'motor1:B', 'green');
    L.at('wokwi-potentiometer', 'pot1', 'SIG', { x: 230, y: 510 }, { attrs: { value: '800' } });
    L.wire('pot1:SIG', 'uno:A0', 'green');
    L.wire('pot1:VCC', 'uno:5V', 'red');
    L.wire('pot1:GND', 'uno:GND.2', 'black');
    return L.done();
  },

  shiftRegister() {
    const L = new Layout('wokwi-arduino-uno', 0, 260);
    L.at('impulse-74hc595', 'sr1', 'DS', { x: 220, y: 190 });
    L.wire('sr1:DS', 'uno:11', 'blue');
    L.wire('sr1:SHCP', 'uno:13', 'purple');
    L.wire('sr1:STCP', 'uno:10', 'orange');
    L.wire('sr1:VCC', 'uno:5V', 'red');
    L.wire('sr1:MR', 'sr1:VCC', 'red');
    L.wire('sr1:GND', 'uno:GND.1', 'black');
    L.wire('sr1:OE', 'sr1:GND', 'black');
    L.at('wokwi-7segment', 'seg1', 'COM.1', { x: 360, y: 120 }, { attrs: { common: 'cathode' } });
    const segs = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'DP'];
    segs.forEach((s, i) => L.wire(`sr1:Q${i}`, `seg1:${s}`, 'green'));
    L.wire('seg1:COM.1', 'uno:GND.2', 'black');
    return L.done();
  },

  mega() {
    const L = new Layout('wokwi-arduino-mega', 0, 230);
    L.part('impulse-breadboard-half', 'bb', { x: 440, y: 140, attrs: { size: 'half' } });
    const colors = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'white'];
    for (let i = 0; i < 8; i++) {
      const col = 3 + i * 3;
      L.at('wokwi-led', `led${i + 1}`, 'C', `bb:${col}t.a`, { attrs: { color: colors[i] } });
      L.at('wokwi-resistor', `r${i + 1}`, '1', `bb:${col + 1}t.c`, { rotate: 90 });
      L.wire(`bb:${col}t.b`, `bb:tn.${Math.min(25, Math.round(col * 25 / 30) + 1)}`, 'black');
      L.wire(`mega:${22 + i}`, `bb:${col + 1}b.j`, colors[i] === 'white' ? 'gray' : colors[i]);
    }
    L.wire('mega:GND.4', 'bb:tn.25', 'black');
    L.at('wokwi-potentiometer', 'pot1', 'SIG', { x: 300, y: 520 }, { attrs: { value: '300' } });
    L.wire('pot1:SIG', 'mega:A8', 'green');
    L.wire('pot1:VCC', 'mega:5V', 'red');
    L.wire('pot1:GND', 'mega:GND.2', 'black');
    return L.done();
  },

  picoBlink() {
    const L = new Layout('impulse-pi-pico', 0, 0);
    ledOnPin(L, 'pico', 'GP15', 'led1', 'red', -70, 90);
    L.wire('led1:C', 'pico:GND.4', 'black');
    return L.done();
  },

  picoDimmer() {
    const L = new Layout('impulse-pi-pico', 0, 0);
    L.at('wokwi-potentiometer', 'pot1', 'SIG', { x: 190, y: 120 }, { attrs: { value: '512' } });
    L.wire('pot1:SIG', 'pico:GP26', 'green');
    L.wire('pot1:VCC', 'pico:3V3', 'red');
    L.wire('pot1:GND', 'pico:AGND', 'black');
    ledOnPin(L, 'pico', 'GP16', 'led1', 'green', 140, 240);
    L.wire('led1:C', 'pico:GND.6', 'black');
    return L.done();
  },

  leonardoKeys() {
    const L = new Layout('impulse-arduino-leonardo', 0, 160);
    ledOnPin(L, 'leonardo', '13', 'led1', 'yellow', 120, 40);
    L.wire('led1:C', 'leonardo:GND.1', 'black');
    return L.done();
  },

  esp32Blink() {
    const L = new Layout('wokwi-esp32-devkit-v1', 0, 0);
    ledOnPin(L, 'esp32', 'D4', 'led1', 'red', 180, 40);
    L.wire('led1:C', 'esp32:GND.1', 'black');
    return L.done();
  },

  esp32Dimmer() {
    const L = new Layout('wokwi-esp32-devkit-v1', 0, 0);
    L.at('wokwi-potentiometer', 'pot1', 'SIG', { x: -110, y: 60 }, { attrs: { value: '512' } });
    L.wire('pot1:SIG', 'esp32:D34', 'green');
    L.wire('pot1:VCC', 'esp32:3V3', 'red');
    L.wire('pot1:GND', 'esp32:GND.2', 'black');
    ledOnPin(L, 'esp32', 'D18', 'led1', 'yellow', 190, 30);
    L.wire('led1:C', 'esp32:GND.1', 'black');
    return L.done();
  },

  esp32s3Rgb() {
    return new Layout('impulse-esp32-s3-devkitc', 0, 0).done();
  },

  esp32c3Button() {
    const L = new Layout('impulse-esp32-c3-devkitm', 0, 0);
    ledOnPin(L, 'esp32c3', '5', 'led1', 'green', 200, 20);
    L.wire('led1:C', 'esp32c3:GND.8', 'black');
    L.at('wokwi-pushbutton', 'btn1', '1.l', { x: 190, y: 160 }, { attrs: { color: 'blue', key: 'b' } });
    L.wire('btn1:1.l', 'esp32c3:4', 'blue');
    L.wire('btn1:2.l', 'esp32c3:GND.9', 'black');
    return L.done();
  },

  nanoEsp32Blink() {
    const L = new Layout('impulse-nano-esp32', 0, 120);
    ledOnPin(L, 'nanoesp32', '2', 'led1', 'red', 255, 20);
    L.wire('led1:C', 'nanoesp32:GND.2', 'black');
    return L.done();
  },

  // ATtiny85 across the center channel (VCC in column 8), 3×AA on the rails.
  tiny(L) {
    L.parts = [];
    L.part('impulse-breadboard-half', 'bb', { x: 0, y: 0, attrs: { size: 'half' } });
    L.at('impulse-attiny85', 'attiny85', 'VCC', 'bb:8t.e');
    L.at('impulse-battery', 'bat', '+', { x: -60, y: 20 }, { attrs: { voltage: '4.5' } });
    L.wire('bat:+', 'bb:tp.1', 'red');
    L.wire('bat:-', 'bb:tn.1', 'black');
    L.wire('bb:8t.a', 'bb:tp.6', 'red');
    L.wire('bb:11b.j', 'bb:bn.9', 'black');
    L.wire('bb:tn.25', 'bb:bn.25', 'black');
    return L;
  },

  tinyBlink() {
    const L = circuits.tiny(new Layout('impulse-attiny85'));
    // PB1 (column 10) → 220 Ω → LED → GND rail.
    L.at('wokwi-resistor', 'r1', '1', 'bb:10t.c');
    L.at('wokwi-led', 'led1', 'A', 'bb:16t.a', { attrs: { color: 'red' } });
    L.wire('bb:15t.b', 'bb:tn.13', 'black');
    return L.done();
  },

  tinyDimmer() {
    const L = circuits.tiny(new Layout('impulse-attiny85'));
    L.at('wokwi-potentiometer', 'pot1', 'SIG', { x: L.pin('bb:21t.a').x, y: -40 }, { attrs: { value: '512' } });
    L.wire('pot1:SIG', 'bb:9t.a', 'green');
    L.wire('pot1:VCC', 'bb:tp.19', 'red');
    L.wire('pot1:GND', 'bb:tn.17', 'black');
    // PB4 (column 10, lower half) → 220 Ω → LED → GND rail.
    L.at('wokwi-resistor', 'r1', '1', 'bb:10b.h');
    L.at('wokwi-led', 'led1', 'A', 'bb:16b.j', { rotate: 180, attrs: { color: 'yellow' } });
    L.wire('bb:17b.i', 'bb:bn.15', 'black');
    return L.done();
  },

  tinyLcd() {
    const L = circuits.tiny(new Layout('impulse-attiny85'));
    L.at('wokwi-lcd1602', 'lcd1', 'GND', { x: 350, y: 40 });
    // SDA is PB0 (column 11), SCL is PB2 (column 9).
    L.wire('lcd1:SDA', 'bb:11t.a', 'blue');
    L.wire('lcd1:SCL', 'bb:9t.a', 'purple');
    L.wire('lcd1:VCC', 'bb:tp.24', 'red');
    L.wire('lcd1:GND', 'bb:tn.25', 'black');
    return L.done();
  },

  nano() {
    const L = new Layout('wokwi-arduino-nano', 0, 0);
    L.parts = [];
    L.part('impulse-breadboard-half', 'bb', { x: 0, y: 0, attrs: { size: 'half' } });
    L.at('wokwi-arduino-nano', 'nano', '12', 'bb:3t.d');
    L.at('wokwi-led', 'led1', 'C', 'bb:20t.a', { attrs: { color: 'red' } });
    L.at('wokwi-resistor', 'r1', '1', 'bb:21t.c');
    L.at('wokwi-pushbutton-6mm', 'btn1', '1.l', 'bb:25t.e', { rotate: 90, attrs: { color: 'blue', key: 'b' } });
    L.wire('bb:20t.b', 'bb:tn.17', 'black');
    L.wire('bb:27t.d', 'bb:3b.j', 'green');
    L.wire('bb:25t.a', 'bb:13t.a', 'blue');
    L.wire('bb:23b.j', 'bb:bn.19', 'black');
    L.wire('bb:14t.a', 'bb:tn.12', 'black');
    L.wire('bb:16b.j', 'bb:bn.13', 'black');
    L.wire('bb:tn.24', 'bb:bn.24', 'black');
    return L.done();
  },

  thermometer() {
    const L = new Layout('wokwi-arduino-uno', 0, 240);
    // TM1637 on the left with its header facing the board.
    L.part('impulse-tm1637', 'disp1', { x: -190, y: 70 });
    const at = (ref) => L.pin(ref);
    L.wire('disp1:CLK', 'uno:11', 'purple', [{ x: at('uno:11').x, y: at('disp1:CLK').y }]);
    L.wire('disp1:DIO', 'uno:12', 'blue', [{ x: at('uno:12').x, y: at('disp1:DIO').y }]);
    L.wire('disp1:GND', 'uno:GND.1', 'black', [{ x: at('uno:GND.1').x, y: at('disp1:GND').y }]);
    L.wire('disp1:VCC', 'uno:5V', 'red', [{ x: -15, y: at('disp1:VCC').y }, { x: -15, y: 452 }, { x: at('uno:5V').x, y: 452 }]);
    // DS18B20 above pin 2, with the 4.7 kΩ pull-up from DQ to VDD.
    L.at('impulse-ds18b20', 'temp1', 'DQ', { x: 236.5, y: 150 }, { attrs: { temperature: '21.4' } });
    L.at('wokwi-resistor', 'r1', '1', { x: 236.5, y: 190 }, { attrs: { value: '4.7k' } });
    const dq = at('temp1:DQ');
    const vdd = at('temp1:VCC');
    const r2 = at('r1:2');
    L.wire('temp1:DQ', 'r1:1', 'green');
    L.wire('r1:1', 'uno:2', 'green');
    L.wire('temp1:VCC', 'r1:2', 'red', [{ x: vdd.x, y: dq.y + 10 }, { x: r2.x, y: dq.y + 10 }]);
    L.wire('r1:2', 'uno:5V', 'red', [{ x: r2.x + 18, y: r2.y }, { x: r2.x + 18, y: 446 }, { x: at('uno:5V').x, y: 446 }]);
    L.wire('temp1:GND', 'uno:GND.1', 'black', [{ x: at('temp1:GND').x, y: dq.y + 25 }, { x: at('uno:GND.1').x, y: dq.y + 25 }]);
    return L.done();
  },

  truthTable() {
    const L = new Layout('wokwi-arduino-uno', 0, 260);
    const gates = [['and1', 'impulse-gate-and', 40, '5'], ['or1', 'impulse-gate-or', 110, '6'], ['xor1', 'impulse-gate-xor', 180, '7']];
    for (const [id, type, y] of gates) L.part(type, id, { x: 60, y });
    // A and B run down two buses on the left; outputs drop straight to their pins.
    const busA = 40;
    const busB = 30;
    gates.forEach(([id, , , pin], i) => {
      const a = L.pin(`${id}:A`);
      const b = L.pin(`${id}:B`);
      const y = L.pin(`${id}:Y`);
      L.wire(`${id}:Y`, `uno:${pin}`, ['orange', 'yellow', 'purple'][i], [{ x: L.pin(`uno:${pin}`).x, y: y.y }]);
      if (i < gates.length - 1) {
        const next = gates[i + 1][0];
        L.wire(`${id}:A`, `${next}:A`, 'green', [{ x: busA, y: a.y }, { x: busA, y: L.pin(`${next}:A`).y }]);
        L.wire(`${id}:B`, `${next}:B`, 'blue', [{ x: busB, y: b.y }, { x: busB, y: L.pin(`${next}:B`).y }]);
      } else {
        L.wire(`${id}:A`, 'uno:8', 'green', [{ x: busA, y: a.y }, { x: busA, y: 240 }, { x: L.pin('uno:8').x, y: 240 }]);
        L.wire(`${id}:B`, 'uno:9', 'blue', [{ x: busB, y: b.y }, { x: busB, y: 248 }, { x: L.pin('uno:9').x, y: 248 }]);
      }
    });
    return L.done();
  },

  stepper28byj() {
    const L = new Layout('wokwi-arduino-uno', 0, 180);
    L.part('impulse-stepper-28byj48', 'motor1', { x: 300, y: 80 });
    // IN1-IN4 step down to pins 11-8 in nested lanes.
    ['IN1', 'IN2', 'IN3', 'IN4'].forEach((name, i) => {
      const pin = String(11 - i);
      L.wire(`motor1:${name}`, `uno:${pin}`, ['blue', 'purple', 'yellow', 'orange'][i], [{ x: L.pin(`uno:${pin}`).x, y: L.pin(`motor1:${name}`).y }]);
    });
    const vcc = L.pin('motor1:VCC');
    const gnd = L.pin('motor1:GND');
    L.wire('motor1:VCC', 'uno:5V', 'red', [{ x: 288, y: vcc.y }, { x: 288, y: 395 }, { x: L.pin('uno:5V').x, y: 395 }]);
    L.wire('motor1:GND', 'uno:GND.3', 'black', [{ x: 295, y: gnd.y }, { x: 295, y: 402 }, { x: L.pin('uno:GND.3').x, y: 402 }]);
    return L.done();
  },

  robotCar() {
    const L = new Layout('wokwi-arduino-uno', 100, 300);
    L.part('impulse-l298n', 'drv', { x: 170, y: 40 });
    L.part('impulse-dc-motor', 'left', { x: 60, y: 20 });
    L.part('impulse-dc-motor', 'right', { x: 350, y: 20 });
    const p = (ref) => L.pin(ref);
    // Motor terminals, routed under each motor.
    L.wire('drv:OUT1', 'left:B', 'orange', [{ x: 160, y: p('drv:OUT1').y }, { x: 160, y: 145 }, { x: p('left:B').x, y: 145 }]);
    L.wire('drv:OUT2', 'left:A', 'yellow', [{ x: 165, y: p('drv:OUT2').y }, { x: 165, y: 152 }, { x: p('left:A').x, y: 152 }]);
    L.wire('drv:OUT3', 'right:A', 'orange', [{ x: 342, y: p('drv:OUT3').y }, { x: 342, y: 145 }, { x: p('right:A').x, y: 145 }]);
    L.wire('drv:OUT4', 'right:B', 'yellow', [{ x: 337, y: p('drv:OUT4').y }, { x: 337, y: 152 }, { x: p('right:B').x, y: 152 }]);
    // Control header to pins 10…5, left wires on the lowest lanes.
    const ctrl = [['ENA', '10', 'green'], ['IN1', '9', 'blue'], ['IN2', '8', 'purple'], ['IN3', '7', 'gray'], ['IN4', '6', 'white'], ['ENB', '5', 'green']];
    ctrl.forEach(([name, pin, color], i) => {
      const lane = 255 - i * 7;
      L.wire(`drv:${name}`, `uno:${pin}`, color, [{ x: p(`drv:${name}`).x, y: lane }, { x: p(`uno:${pin}`).x, y: lane }]);
    });
    // Battery pack powers the motors; its − shares the Arduino's ground.
    L.part('impulse-battery', 'bat', { x: 20, y: 250, attrs: { voltage: '9' } });
    L.wire('bat:+', 'drv:12V', 'red', [{ x: p('bat:+').x, y: 208 }, { x: p('drv:12V').x, y: 208 }]);
    L.wire('bat:-', 'drv:GND', 'black', [{ x: p('bat:-').x, y: 216 }, { x: p('drv:GND').x, y: 216 }]);
    L.wire('uno:GND.1', 'drv:GND', 'black', [{ x: p('uno:GND.1').x, y: 262 }, { x: p('drv:GND').x, y: 262 }]);
    return L.done();
  },

  reaction() {
    const L = new Layout('wokwi-arduino-uno', 0, 200);
    ledOnPin(L, 'uno', '13', 'led1', 'green', 110, 60);
    L.wire('led1:C', 'uno:GND.1', 'black');
    L.at('wokwi-pushbutton', 'btn1', '1.l', { x: 200, y: 100 }, { attrs: { color: 'red', key: 'Space' } });
    L.wire('btn1:1.l', 'uno:2', 'blue');
    L.wire('btn1:2.l', 'uno:GND.1', 'black');
    L.at('wokwi-lcd1602', 'lcd1', 'GND', { x: 360, y: 250 });
    L.wire('lcd1:GND', 'uno:GND.2', 'black');
    L.wire('lcd1:VCC', 'uno:5V', 'red');
    L.wire('lcd1:SDA', 'uno:A4', 'blue');
    L.wire('lcd1:SCL', 'uno:A5', 'purple');
    return L.done();
  },
};

// ── Sketches ─────────────────────────────────────────────────────────────────

const ex = (spec) => spec;

export const EXAMPLES = [
  ex({
    id: 'blink', title: 'Blink', category: 'Basics', board: 'uno', level: 'Beginner',
    summary: 'The first sketch everyone runs: an LED blinking once a second.',
    tags: ['LED', 'digitalWrite', 'delay'],
    circuit: circuits.blink,
    code: `// Blink
// The on-board L LED and the red LED on pin 13 blink once a second.
// Sketch > Run Hardware Tests checks the @expect lines below in the simulator.
// @run 2.2s
// @expect pin 13 frequency 1Hz ±5%

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
}
`,
  }),
  ex({
    id: 'button', title: 'Button and LED', category: 'Basics', board: 'uno', level: 'Beginner',
    summary: 'Read a pushbutton with INPUT_PULLUP and light an LED while it is pressed.',
    tags: ['pushbutton', 'digitalRead', 'INPUT_PULLUP'],
    circuit: circuits.button,
    code: `// Button and LED
// Press the button (click it, or hold the B key) to light the LED.
// The button connects pin 2 to GND, so with INPUT_PULLUP it reads LOW while pressed.

const int BUTTON = 2;
const int LED = 13;
bool wasPressed = false;

void setup() {
  pinMode(BUTTON, INPUT_PULLUP);
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  bool pressed = digitalRead(BUTTON) == LOW;
  digitalWrite(LED, pressed ? HIGH : LOW);
  if (pressed != wasPressed) {
    Serial.println(pressed ? "Pressed" : "Released");
    wasPressed = pressed;
  }
  delay(10);
}
`,
  }),
  ex({
    id: 'fade', title: 'Fade', category: 'Basics', board: 'uno', level: 'Beginner',
    summary: 'Dim an LED up and down with PWM using analogWrite().',
    tags: ['PWM', 'analogWrite'],
    circuit: circuits.fade,
    code: `// Fade
// analogWrite() switches PWM pin 9 on and off very fast; the LED looks dimmer
// the shorter the "on" part of each cycle is.
// @run 1s
// @expect pin 9 toggles

const int LED = 9;
int brightness = 0;
int step = 5;

void setup() {
  pinMode(LED, OUTPUT);
}

void loop() {
  analogWrite(LED, brightness);
  brightness += step;
  if (brightness <= 0 || brightness >= 255) step = -step;
  delay(30);
}
`,
  }),
  ex({
    id: 'traffic-light', title: 'Traffic light', category: 'Basics', board: 'uno', level: 'Beginner',
    summary: 'Three LEDs on a breadboard cycle like a road signal.',
    tags: ['breadboard', 'LED', 'timing'],
    circuit: circuits.trafficLight,
    code: `// Traffic light
// Red, yellow and green LEDs on a breadboard cycle like a road signal.
// Each LED sits in two breadboard columns; its resistor bridges to the column
// the Arduino wire is plugged into, and the short black wires go to the GND rail.
// @run 8.5s
// @expect pin 12 toggles
// @expect pin 10 toggles

const int RED = 12;
const int YELLOW = 11;
const int GREEN = 10;

void setup() {
  pinMode(RED, OUTPUT);
  pinMode(YELLOW, OUTPUT);
  pinMode(GREEN, OUTPUT);
}

void loop() {
  digitalWrite(RED, HIGH);
  delay(3000);
  digitalWrite(YELLOW, HIGH);
  delay(1000);
  digitalWrite(RED, LOW);
  digitalWrite(YELLOW, LOW);
  digitalWrite(GREEN, HIGH);
  delay(3000);
  digitalWrite(GREEN, LOW);
  digitalWrite(YELLOW, HIGH);
  delay(1000);
  digitalWrite(YELLOW, LOW);
}
`,
  }),
  ex({
    id: 'potentiometer', title: 'Potentiometer dimmer', category: 'Basics', board: 'uno', level: 'Beginner',
    summary: 'Turn a knob to read 0-1023 on A0 and set an LED\'s brightness.',
    tags: ['analogRead', 'potentiometer', 'Serial Plotter'],
    circuit: circuits.potentiometer,
    code: `// Potentiometer dimmer
// Turn the knob (drag it, or use the slider in the inspector): analogRead(A0)
// goes from 0 to 1023 and sets the LED brightness. Open the Serial Plotter to
// watch the value.
// @run 0.5s
// @expect serial matches /^5\\d\\d\\r?$/m

const int POT = A0;
const int LED = 9;

void setup() {
  Serial.begin(9600);
  pinMode(LED, OUTPUT);
}

void loop() {
  int value = analogRead(POT);
  analogWrite(LED, value / 4);
  Serial.println(value);
  delay(50);
}
`,
  }),
  ex({
    id: 'rgb-led', title: 'RGB color wheel', category: 'Basics', board: 'uno', level: 'Beginner',
    summary: 'Mix colors on a common-cathode RGB LED with three PWM pins.',
    tags: ['RGB LED', 'PWM', 'color'],
    circuit: circuits.rgb,
    code: `// RGB color wheel
// PWM on pins 9, 10 and 11 mixes the red, green and blue parts of a
// common-cathode RGB LED, fading around the color wheel.

const int R = 9;
const int G = 10;
const int B = 11;

void setColor(int r, int g, int b) {
  analogWrite(R, r);
  analogWrite(G, g);
  analogWrite(B, b);
}

void setup() {
  pinMode(R, OUTPUT);
  pinMode(G, OUTPUT);
  pinMode(B, OUTPUT);
}

void loop() {
  for (int i = 0; i < 256; i++) { setColor(255 - i, i, 0); delay(8); }
  for (int i = 0; i < 256; i++) { setColor(0, 255 - i, i); delay(8); }
  for (int i = 0; i < 256; i++) { setColor(i, 0, 255 - i); delay(8); }
}
`,
  }),
  ex({
    id: 'melody', title: 'Melody', category: 'Basics', board: 'uno', level: 'Beginner',
    summary: 'Play a scale on a piezo buzzer with tone() — through your speakers.',
    tags: ['buzzer', 'tone', 'sound'],
    circuit: circuits.melody,
    code: `// Melody
// tone() plays a C-major scale on the buzzer. Turn your speakers on; the
// speaker button next to the simulation clock mutes it.
// @run 1s
// @expect pin 8 toggles

const int BUZZER = 8;
const int NOTES[] = {262, 294, 330, 349, 392, 440, 494, 523};

void setup() {}

void loop() {
  for (int i = 0; i < 8; i++) {
    tone(BUZZER, NOTES[i], 200);
    delay(250);
  }
  noTone(BUZZER);
  delay(1000);
}
`,
  }),
  ex({
    id: 'serial-echo', title: 'Serial chat', category: 'Basics', board: 'uno', level: 'Beginner',
    summary: 'Type into the Serial monitor: the Arduino answers, and “on” / “off” switch an LED.',
    tags: ['Serial', 'input', 'String'],
    circuit: circuits.serialEcho,
    code: `// Serial chat
// Type a message in the box under the Serial monitor and press Enter:
// the Arduino answers in capitals. Send "on" or "off" to switch the LED.
// @run 0.3s
// @expect serial contains "Type something"

const int LED = 13;

void setup() {
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
  Serial.println("Type something and press Enter (try: on, off).");
}

void loop() {
  if (Serial.available()) {
    String line = Serial.readStringUntil('\\n');
    line.trim();
    line.toUpperCase();
    if (line == "ON") digitalWrite(LED, HIGH);
    if (line == "OFF") digitalWrite(LED, LOW);
    Serial.print("You said: ");
    Serial.println(line);
  }
}
`,
  }),

  ex({
    id: 'lcd-hello', title: 'Hello LCD', category: 'Displays', board: 'uno', level: 'Beginner',
    summary: 'Print text and a live counter on a 16×2 I²C LCD.',
    tags: ['LCD', 'I2C', 'LiquidCrystal_I2C'], libraries: ['LiquidCrystal I2C'],
    circuit: circuits.lcd,
    code: `// Hello LCD
// A 16x2 character LCD with an I2C backpack (address 0x27) shows a greeting
// and how long the sketch has been running. SDA goes to A4, SCL to A5.

#include <LiquidCrystal_I2C.h>

LiquidCrystal_I2C lcd(0x27, 16, 2);

void setup() {
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Hello, Impulse!");
}

void loop() {
  lcd.setCursor(0, 1);
  lcd.print("Uptime: ");
  lcd.print(millis() / 1000);
  lcd.print(" s   ");
  delay(250);
}
`,
  }),
  ex({
    id: 'oled', title: 'OLED graphics', category: 'Displays', board: 'uno', level: 'Intermediate',
    summary: 'Text, shapes and a bouncing ball on a 128×64 SSD1306.',
    tags: ['OLED', 'SSD1306', 'Adafruit GFX', 'animation'], libraries: ['Adafruit SSD1306', 'Adafruit GFX Library'],
    circuit: circuits.oled,
    code: `// OLED graphics
// Adafruit GFX draws text, a frame and a bouncing ball on a 128x64 SSD1306
// OLED over I2C (address 0x3C).

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);
int x = 20, y = 30, dx = 3, dy = 2;

void setup() {
  Serial.begin(9600);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("SSD1306 not found");
    for (;;);
  }
}

void loop() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("Impulse OLED");
  display.drawRect(0, 12, 128, 52, SSD1306_WHITE);
  display.fillCircle(x, y, 4, SSD1306_WHITE);
  display.display();
  x += dx;
  y += dy;
  if (x < 6 || x > 121) dx = -dx;
  if (y < 18 || y > 57) dy = -dy;
  delay(20);
}
`,
  }),
  ex({
    id: 'seven-segment', title: 'Stopwatch display', category: 'Displays', board: 'uno', level: 'Intermediate',
    summary: 'Count tenths of a second on a multiplexed 4-digit 7-segment display.',
    tags: ['7-segment', 'multiplexing', 'SevSeg'], libraries: ['SevSeg'],
    circuit: circuits.sevenSegment,
    code: `// Stopwatch display
// SevSeg lights one digit at a time so fast that all four look lit
// (multiplexing). The display counts tenths of a second.

#include <SevSeg.h>

SevSeg sevseg;

void setup() {
  // SevSeg works with any pins; these keep the wires on the canvas tidy.
  byte digitPins[] = {2, 5, 6, 8};                      // DIG1..DIG4
  byte segmentPins[] = {3, 7, 10, 12, 13, 4, 9, 11};    // A B C D E F G DP
  sevseg.begin(COMMON_ANODE, 4, digitPins, segmentPins, true);
  sevseg.setBrightness(90);
}

void loop() {
  static unsigned long last = 0;
  static int tenths = 0;
  if (millis() - last >= 100) {
    last += 100;
    tenths = (tenths + 1) % 10000;
    sevseg.setNumber(tenths, 1);
  }
  sevseg.refreshDisplay();
}
`,
  }),
  ex({
    id: 'neopixel', title: 'NeoPixel rainbow', category: 'Displays', board: 'uno', level: 'Beginner',
    summary: 'A 16-LED WS2812 ring cycling through the rainbow.',
    tags: ['NeoPixel', 'WS2812', 'RGB'], libraries: ['Adafruit NeoPixel'],
    circuit: circuits.neopixel,
    code: `// NeoPixel rainbow
// A ring of 16 WS2812 LEDs on pin 6 cycles through the rainbow using the
// Adafruit NeoPixel library.

#include <Adafruit_NeoPixel.h>

const int PIN = 6;
const int COUNT = 16;
Adafruit_NeoPixel ring(COUNT, PIN, NEO_GRB + NEO_KHZ800);

void setup() {
  ring.begin();
  ring.setBrightness(80);
}

void loop() {
  static uint16_t hue = 0;
  for (int i = 0; i < COUNT; i++) {
    ring.setPixelColor(i, ring.gamma32(ring.ColorHSV(hue + i * 65536L / COUNT)));
  }
  ring.show();
  hue += 512;
  delay(20);
}
`,
  }),
  ex({
    id: 'led-matrix', title: 'LED matrix faces', category: 'Displays', board: 'uno', level: 'Beginner',
    summary: 'Draw a smiley on an 8×8 MAX7219 dot matrix with LedControl.',
    tags: ['MAX7219', 'LED matrix', 'LedControl'], libraries: ['LedControl'],
    circuit: circuits.matrix,
    code: `// LED matrix faces
// LedControl talks to a MAX7219 driver over three wires and draws faces on
// its 8x8 LED matrix, one row byte at a time.

#include <LedControl.h>

LedControl lc(12, 11, 10, 1); // DIN, CLK, CS, number of modules

const byte SMILE[8] = {B00111100, B01000010, B10100101, B10000001, B10100101, B10011001, B01000010, B00111100};
const byte NEUTRAL[8] = {B00111100, B01000010, B10100101, B10000001, B10111101, B10000001, B01000010, B00111100};

void show(const byte *face) {
  for (int row = 0; row < 8; row++) lc.setRow(0, row, face[row]);
}

void setup() {
  lc.shutdown(0, false);
  lc.setIntensity(0, 6);
  lc.clearDisplay(0);
}

void loop() {
  show(SMILE);
  delay(1000);
  show(NEUTRAL);
  delay(1000);
}
`,
  }),

  ex({
    id: 'distance-meter', title: 'Distance meter', category: 'Sensors', board: 'uno', level: 'Beginner',
    summary: 'Measure distance with an HC-SR04 and show it on an LCD.',
    tags: ['ultrasonic', 'HC-SR04', 'pulseIn', 'LCD'], libraries: ['LiquidCrystal I2C'],
    circuit: circuits.ultrasonic,
    code: `// Distance meter
// The HC-SR04 sends a sound pulse when TRIG goes HIGH for 10 µs; ECHO stays
// HIGH for 58 µs per centimetre. Select the sensor and drag its distance
// slider while the simulation runs.
// @run 1.6s
// @expect serial contains "Distance: 100 cm"

#include <LiquidCrystal_I2C.h>

const int TRIG = 3;
const int ECHO = 2;
LiquidCrystal_I2C lcd(0x27, 16, 2);

void setup() {
  Serial.begin(9600);
  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);
  lcd.init();
  lcd.backlight();
  lcd.print("Distance meter");
}

void loop() {
  digitalWrite(TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG, LOW);
  long duration = pulseIn(ECHO, HIGH, 30000);
  int cm = duration / 58;

  lcd.setCursor(0, 1);
  lcd.print(cm);
  lcd.print(" cm      ");
  Serial.print("Distance: ");
  Serial.print(cm);
  Serial.println(" cm");
  delay(200);
}
`,
  }),
  ex({
    id: 'weather-station', title: 'Weather station', category: 'Sensors', board: 'uno', level: 'Intermediate',
    summary: 'DHT22 temperature and humidity on an OLED display.',
    tags: ['DHT22', 'temperature', 'humidity', 'OLED'], libraries: ['DHT sensor library', 'Adafruit Unified Sensor', 'Adafruit SSD1306', 'Adafruit GFX Library'],
    circuit: circuits.weather,
    code: `// Weather station
// Reads a DHT22 every two seconds and shows temperature and humidity on an
// OLED. Change the values in the inspector while it runs.
// @run 2.5s
// @expect serial contains "T=24.00 H=40.00"

#include <DHT.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

DHT dht(2, DHT22);
Adafruit_SSD1306 display(128, 64, &Wire, -1);

void setup() {
  Serial.begin(9600);
  dht.begin();
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
}

void loop() {
  float t = dht.readTemperature();
  float h = dht.readHumidity();

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("Weather station");
  display.setTextSize(2);
  display.setCursor(0, 20);
  if (isnan(t) || isnan(h)) {
    display.println("No data");
  } else {
    display.print(t, 1);
    display.println(" C");
    display.print(h, 0);
    display.println(" %");
  }
  display.display();

  Serial.print("T=");
  Serial.print(t);
  Serial.print(" H=");
  Serial.println(h);
  delay(2000);
}
`,
  }),
  ex({
    id: 'motion-alarm', title: 'Motion alarm', category: 'Sensors', board: 'uno', level: 'Beginner',
    summary: 'A PIR sensor triggers a flashing LED and a buzzer.',
    tags: ['PIR', 'motion', 'buzzer', 'alarm'],
    circuit: circuits.pirAlarm,
    code: `// Motion alarm
// When the PIR sensor sees motion its OUT pin goes HIGH; the LED flashes and
// the buzzer sounds. Click the PIR sensor while the simulation runs.

const int PIR = 2;
const int LED = 13;
const int BUZZER = 8;

void setup() {
  pinMode(PIR, INPUT);
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  if (digitalRead(PIR) == HIGH) {
    Serial.println("Motion detected!");
    for (int i = 0; i < 5; i++) {
      digitalWrite(LED, HIGH);
      tone(BUZZER, 1200);
      delay(150);
      digitalWrite(LED, LOW);
      noTone(BUZZER);
      delay(150);
    }
  }
  delay(50);
}
`,
  }),
  ex({
    id: 'night-light', title: 'Night light', category: 'Sensors', board: 'uno', level: 'Beginner',
    summary: 'The darker it gets, the brighter the LED — using a light sensor.',
    tags: ['LDR', 'light sensor', 'analogRead', 'PWM'],
    circuit: circuits.nightLight,
    code: `// Night light
// The light sensor's AO voltage rises as the room gets darker. Its reading
// sets the LED brightness. Change "Light" in the inspector to try day and night.

const int SENSOR = A0;
const int LED = 9;

void setup() {
  Serial.begin(9600);
  pinMode(LED, OUTPUT);
}

void loop() {
  int darkness = analogRead(SENSOR);
  analogWrite(LED, map(darkness, 0, 1023, 0, 255));
  Serial.print("Light sensor: ");
  Serial.println(darkness);
  delay(100);
}
`,
  }),
  ex({
    id: 'rc-charge', title: 'Capacitor charging (RC)', category: 'Sensors', board: 'uno', level: 'Beginner',
    summary: 'Watch a capacitor charge and discharge through a resistor: the RC curve on the Serial Plotter.',
    tags: ['capacitor', 'RC', 'time constant', 'analogRead', 'Serial Plotter'],
    circuit: circuits.rcCharge,
    code: `// Capacitor charging (RC)
// A1 charges a 100 µF capacitor through 10 kΩ and A0 reads its voltage.
// RC = 10 kΩ × 100 µF = 1 second: after 1 s the capacitor is at 63% of 5 V,
// after 5 s it is practically full. Then A1 goes LOW and it discharges.
// Open Tools › Serial Plotter to see the curve, or change the capacitor or
// resistor value in the inspector and run it again.
// @run 1.05s
// @expect serial contains "Volts: 3.1"

const int CHARGE = A1;
const int SENSE = A0;

void setup() {
  Serial.begin(115200);
  pinMode(CHARGE, OUTPUT);
}

void loop() {
  digitalWrite(CHARGE, HIGH);   // charge for 5 s
  for (int i = 0; i < 50; i++) report();
  digitalWrite(CHARGE, LOW);    // then discharge for 5 s
  for (int i = 0; i < 50; i++) report();
}

void report() {
  float volts = analogRead(SENSE) * 5.0 / 1023;
  Serial.print("Volts: ");
  Serial.println(volts, 2);
  delay(100);
}
`,
  }),
  ex({
    id: 'tilt-sensor', title: 'Tilt angles (MPU6050)', category: 'Sensors', board: 'uno', level: 'Intermediate',
    summary: 'Compute pitch and roll from an MPU6050 accelerometer.',
    tags: ['MPU6050', 'accelerometer', 'I2C', 'IMU'], libraries: ['Adafruit MPU6050', 'Adafruit Unified Sensor'],
    circuit: circuits.imu,
    code: `// Tilt angles
// Pitch and roll from the MPU6050 accelerometer. Move the Accel sliders in
// the inspector to tilt the sensor.
// @run 0.6s
// @expect serial contains "MPU6050 ready"

#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <Wire.h>

Adafruit_MPU6050 mpu;

void setup() {
  Serial.begin(115200);
  if (!mpu.begin()) {
    Serial.println("MPU6050 not found");
    while (true) delay(10);
  }
  mpu.setAccelerometerRange(MPU6050_RANGE_2_G);
  Serial.println("MPU6050 ready");
}

void loop() {
  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);
  float ax = a.acceleration.x, ay = a.acceleration.y, az = a.acceleration.z;
  float pitch = atan2(ax, sqrt(ay * ay + az * az)) * 180 / PI;
  float roll = atan2(ay, az) * 180 / PI;
  Serial.print("Pitch: ");
  Serial.print(pitch, 1);
  Serial.print("  Roll: ");
  Serial.println(roll, 1);
  delay(200);
}
`,
  }),
  ex({
    id: 'rtc-clock', title: 'Desk clock', category: 'Sensors', board: 'uno', level: 'Intermediate',
    summary: 'A DS1307 real-time clock with the date and time on an LCD.',
    tags: ['RTC', 'DS1307', 'RTClib', 'LCD', 'clock'], libraries: ['RTClib', 'LiquidCrystal I2C'],
    circuit: circuits.rtc,
    code: `// Desk clock
// The DS1307 real-time clock and the LCD share the I2C bus. The simulated RTC
// starts at your computer's current date and time.

#include <RTClib.h>
#include <LiquidCrystal_I2C.h>

RTC_DS1307 rtc;
LiquidCrystal_I2C lcd(0x27, 16, 2);

void print2(int v) {
  if (v < 10) lcd.print('0');
  lcd.print(v);
}

void setup() {
  lcd.init();
  lcd.backlight();
  if (!rtc.begin()) {
    lcd.print("RTC not found");
    while (true);
  }
}

void loop() {
  DateTime now = rtc.now();
  lcd.setCursor(0, 0);
  lcd.print(now.year());
  lcd.print('-');
  print2(now.month());
  lcd.print('-');
  print2(now.day());
  lcd.setCursor(0, 1);
  print2(now.hour());
  lcd.print(':');
  print2(now.minute());
  lcd.print(':');
  print2(now.second());
  delay(250);
}
`,
  }),
  ex({
    id: 'kitchen-scale', title: 'Kitchen scale', category: 'Sensors', board: 'uno', level: 'Intermediate',
    summary: 'Weigh things with a load cell and an HX711 amplifier.',
    tags: ['HX711', 'load cell', 'weight'], libraries: ['HX711'],
    circuit: circuits.scale,
    code: `// Kitchen scale
// The HX711 reads a load cell; set_scale() converts counts to grams. Change
// the weight in the inspector while it runs.
// @run 0.8s
// @expect serial contains "Weight: 0.0 g"

#include <HX711.h>

HX711 scale;
const float COUNTS_PER_GRAM = 420.0;

void setup() {
  Serial.begin(9600);
  scale.begin(3, 2); // DT, SCK
  scale.set_scale(COUNTS_PER_GRAM);
  scale.tare();
  Serial.println("Scale ready. Change the weight in the inspector.");
}

void loop() {
  if (scale.is_ready()) {
    Serial.print("Weight: ");
    Serial.print(scale.get_units(5), 1);
    Serial.println(" g");
  }
  delay(250);
}
`,
  }),

  ex({
    id: 'thermometer', title: 'Thermometer display', category: 'Sensors', board: 'uno', level: 'Intermediate',
    summary: 'A DS18B20 on 1-Wire measures the temperature; a TM1637 display shows it.',
    tags: ['DS18B20', 'TM1637', 'OneWire'], libraries: ['OneWire', 'DallasTemperature', 'TM1637'],
    circuit: circuits.thermometer,
    code: `// Thermometer display
// A DS18B20 measures the temperature on a 1-Wire bus (with its 4.7 kΩ
// pull-up) and a TM1637 display shows it. Change the temperature in the
// sensor's inspector while the sketch runs.
// @run 2s
// @expect serial matches /Temperature: \\d+\\.\\d C/

#include <OneWire.h>
#include <DallasTemperature.h>
#include <TM1637Display.h>

OneWire oneWire(2);
DallasTemperature sensors(&oneWire);
TM1637Display display(11, 12);   // CLK, DIO

const uint8_t DEGREE = SEG_A | SEG_B | SEG_F | SEG_G;
const uint8_t LETTER_C = SEG_A | SEG_D | SEG_E | SEG_F;

void setup() {
  Serial.begin(9600);
  sensors.begin();
  display.setBrightness(5);
}

void loop() {
  sensors.requestTemperatures();   // 750 ms at 12-bit resolution
  float c = sensors.getTempCByIndex(0);
  Serial.print("Temperature: ");
  Serial.print(c, 1);
  Serial.println(" C");

  int t = round(c);
  if (t >= 0 && t < 100) {
    display.showNumberDec(t, false, 2, 0);
    uint8_t unit[] = { DEGREE, LETTER_C };
    display.setSegments(unit, 2, 2);
  } else {
    display.showNumberDec(t, false, 3, 0);
    uint8_t unit[] = { DEGREE };
    display.setSegments(unit, 1, 3);
  }
  delay(250);
}
`,
  }),
  ex({
    id: 'keypad-lock', title: 'Keypad door lock', category: 'Input', board: 'uno', level: 'Intermediate',
    summary: 'Enter a PIN on a 4×4 keypad; a servo unlocks the door.',
    tags: ['keypad', 'servo', 'LCD', 'password'], libraries: ['Keypad', 'Servo', 'LiquidCrystal I2C'],
    circuit: circuits.keypadLock,
    code: `// Keypad door lock
// Type 1 2 3 4 then # on the keypad (or on your keyboard while the keypad is
// focused). The servo turns to unlock for three seconds. * clears.

#include <Keypad.h>
#include <Servo.h>
#include <LiquidCrystal_I2C.h>

const char PASSWORD[] = "1234";
char keys[4][4] = {
  {'1', '2', '3', 'A'},
  {'4', '5', '6', 'B'},
  {'7', '8', '9', 'C'},
  {'*', '0', '#', 'D'},
};
byte rowPins[4] = {9, 8, 7, 6};
byte colPins[4] = {5, 4, 3, 2};
Keypad keypad = Keypad(makeKeymap(keys), rowPins, colPins, 4, 4);
LiquidCrystal_I2C lcd(0x27, 16, 2);
Servo lock;
String input;

void prompt() {
  lcd.clear();
  lcd.print("Enter PIN + #");
  lcd.setCursor(0, 1);
}

void setup() {
  lock.attach(10);
  lock.write(0);
  lcd.init();
  lcd.backlight();
  prompt();
}

void loop() {
  char key = keypad.getKey();
  if (!key) return;
  if (key == '#') {
    lcd.clear();
    if (input == PASSWORD) {
      lcd.print("Unlocked!");
      lock.write(90);
      delay(3000);
      lock.write(0);
    } else {
      lcd.print("Wrong PIN");
      delay(1500);
    }
    input = "";
    prompt();
  } else if (key == '*') {
    input = "";
    prompt();
  } else if (input.length() < 8) {
    input += key;
    lcd.print('*');
  }
}
`,
  }),
  ex({
    id: 'rotary-encoder', title: 'Rotary encoder', category: 'Input', board: 'uno', level: 'Intermediate',
    summary: 'Count encoder detents with an interrupt; press the knob to reset.',
    tags: ['encoder', 'KY-040', 'interrupt'],
    circuit: circuits.encoder,
    code: `// Rotary encoder
// Each detent pulses CLK; reading DT on the falling edge gives the direction.
// Hover the encoder and click its arrows, or use the inspector buttons.

const int CLK = 2;
const int DT = 3;
const int SW = 4;
volatile long position = 0;

void onClock() {
  position += digitalRead(DT) == HIGH ? 1 : -1;
}

void setup() {
  Serial.begin(9600);
  pinMode(CLK, INPUT);
  pinMode(DT, INPUT);
  pinMode(SW, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(CLK), onClock, FALLING);
  Serial.println("Turn the knob, press it to reset.");
}

void loop() {
  static long last = 0;
  noInterrupts();
  long p = position;
  interrupts();
  if (p != last) {
    last = p;
    Serial.print("Position: ");
    Serial.println(p);
  }
  if (digitalRead(SW) == LOW) {
    noInterrupts();
    position = 0;
    interrupts();
    Serial.println("Reset");
    delay(300);
  }
}
`,
  }),
  ex({
    id: 'joystick-servo', title: 'Joystick pan servo', category: 'Input', board: 'uno', level: 'Beginner',
    summary: 'Steer a servo with a thumb joystick; click the stick to center it.',
    tags: ['joystick', 'servo', 'analogRead'], libraries: ['Servo'],
    circuit: circuits.joystickServo,
    code: `// Joystick pan servo
// The joystick's horizontal axis steers the servo; pressing the stick (SEL)
// centers it. Drag the stick, or use the arrow keys while it is focused.

#include <Servo.h>

Servo pan;

void setup() {
  pan.attach(9);
  pinMode(2, INPUT_PULLUP);
}

void loop() {
  int x = analogRead(A0);
  if (digitalRead(2) == LOW) pan.write(90);
  else pan.write(map(x, 0, 1023, 180, 0));
  delay(15);
}
`,
  }),
  ex({
    id: 'ir-remote', title: 'IR remote control', category: 'Input', board: 'uno', level: 'Intermediate',
    summary: 'Toggle three LEDs with buttons 1, 2 and 3 on an IR remote.',
    tags: ['IR', 'remote', 'IRremote', 'NEC'], libraries: ['IRremote'],
    circuit: circuits.irRemote,
    code: `// IR remote control
// Press 1, 2 or 3 on the remote: the receiver decodes the NEC code and the
// matching LED toggles.

#include <IRremote.hpp>

const int RECEIVER = 2;

void setup() {
  Serial.begin(9600);
  pinMode(9, OUTPUT);
  pinMode(10, OUTPUT);
  pinMode(11, OUTPUT);
  IrReceiver.begin(RECEIVER, DISABLE_LED_FEEDBACK);
  Serial.println("Press 1, 2 or 3 on the remote.");
}

void loop() {
  if (!IrReceiver.decode()) return;
  if (!(IrReceiver.decodedIRData.flags & IRDATA_FLAGS_IS_REPEAT)) {
    uint8_t code = IrReceiver.decodedIRData.command;
    Serial.print("Code 0x");
    Serial.println(code, HEX);
    if (code == 0x30) digitalWrite(9, !digitalRead(9));
    if (code == 0x18) digitalWrite(10, !digitalRead(10));
    if (code == 0x7A) digitalWrite(11, !digitalRead(11));
  }
  IrReceiver.resume();
}
`,
  }),

  ex({
    id: 'servo-sweep', title: 'Servo sweep', category: 'Motors', board: 'uno', level: 'Beginner',
    summary: 'Sweep a hobby servo from 0° to 180° and back.',
    tags: ['servo', 'Servo library'], libraries: ['Servo'],
    circuit: circuits.servoSweep,
    code: `// Servo sweep
// The Servo library sends a 0.5-2.4 ms pulse every 20 ms; the pulse width sets
// the angle.

#include <Servo.h>

Servo servo;

void setup() {
  servo.attach(9);
}

void loop() {
  for (int angle = 0; angle <= 180; angle++) {
    servo.write(angle);
    delay(10);
  }
  for (int angle = 180; angle >= 0; angle--) {
    servo.write(angle);
    delay(10);
  }
}
`,
  }),
  ex({
    id: 'stepper-driver', title: 'Stepper with A4988', category: 'Motors', board: 'uno', level: 'Intermediate',
    summary: 'AccelStepper drives a NEMA 17 back and forth through an A4988.',
    tags: ['stepper', 'A4988', 'AccelStepper'], libraries: ['AccelStepper'],
    circuit: circuits.stepper,
    code: `// Stepper with A4988
// Each pulse on STEP moves the motor one step (1.8°); DIR picks the direction.
// AccelStepper ramps the speed up and down.

#include <AccelStepper.h>

const int STEP = 3;
const int DIR = 2;
AccelStepper stepper(AccelStepper::DRIVER, STEP, DIR);

void setup() {
  stepper.setMaxSpeed(400);
  stepper.setAcceleration(200);
  stepper.moveTo(200);
}

void loop() {
  if (stepper.distanceToGo() == 0) stepper.moveTo(-stepper.currentPosition());
  stepper.run();
}
`,
  }),
  ex({
    id: 'stepper-28byj', title: '28BYJ-48 stepper', category: 'Motors', board: 'uno', level: 'Beginner',
    summary: 'The starter-kit stepper on its ULN2003 board turns a full revolution each way.',
    tags: ['28BYJ-48', 'ULN2003', 'Stepper library'], libraries: ['Stepper'],
    circuit: circuits.stepper28byj,
    code: `// 28BYJ-48 stepper
// The small geared stepper from most starter kits, on its ULN2003 driver
// board. It turns one full revolution one way, then back: 2048 steps = 1 turn.
// @run 1s
// @expect serial contains "Clockwise"

#include <Stepper.h>

const int STEPS_PER_TURN = 2048;
// IN1-IN4 are on pins 11, 10, 9, 8. The Stepper library wants the coils in
// the order IN1, IN3, IN2, IN4.
Stepper motor(STEPS_PER_TURN, 11, 9, 10, 8);

void setup() {
  Serial.begin(9600);
  motor.setSpeed(15);   // RPM: the 28BYJ-48 tops out around 15
}

void loop() {
  Serial.println("Clockwise");
  motor.step(STEPS_PER_TURN);
  delay(500);
  Serial.println("Counter-clockwise");
  motor.step(-STEPS_PER_TURN);
  delay(500);
}
`,
  }),
  ex({
    id: 'relay-lamp', title: 'Relay lamp switch', category: 'Motors', board: 'uno', level: 'Beginner',
    summary: 'A button toggles a relay that switches a separate lamp circuit.',
    tags: ['relay', 'button', 'toggle'],
    circuit: circuits.relay,
    code: `// Relay lamp switch
// Each press of the button (or the space bar) flips the relay. The relay's
// COM-NO contact switches the lamp's own power, just like mains wiring.

const int BUTTON = 2;
const int RELAY = 7;
bool on = false;

void setup() {
  pinMode(BUTTON, INPUT_PULLUP);
  pinMode(RELAY, OUTPUT);
}

void loop() {
  if (digitalRead(BUTTON) == LOW) {
    on = !on;
    digitalWrite(RELAY, on ? HIGH : LOW);
    delay(50);
    while (digitalRead(BUTTON) == LOW) delay(10);
  }
}
`,
  }),
  ex({
    id: 'dc-motor', title: 'DC motor speed', category: 'Motors', board: 'uno', level: 'Intermediate',
    summary: 'Control a DC motor\'s speed and direction through an L293D.',
    tags: ['DC motor', 'L293D', 'H-bridge', 'PWM'],
    circuit: circuits.dcMotor,
    code: `// DC motor speed
// The L293D H-bridge powers the motor. IN1/IN2 choose the direction and PWM
// on EN1 sets the speed. Turn the knob: left half reverses, right half forward.

const int EN = 9;
const int IN1 = 8;
const int IN2 = 7;
const int POT = A0;

void setup() {
  pinMode(EN, OUTPUT);
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
}

void loop() {
  int value = analogRead(POT);
  bool forward = value > 512;
  digitalWrite(IN1, forward ? HIGH : LOW);
  digitalWrite(IN2, forward ? LOW : HIGH);
  analogWrite(EN, min(abs(value - 512) / 2, 255));
  delay(20);
}
`,
  }),

  ex({
    id: 'robot-car', title: 'Robot car motors (L298N)', category: 'Motors', board: 'uno', level: 'Intermediate',
    summary: 'Two DC motors through an L298N: forward, turn, reverse and stop, with PWM speed.',
    tags: ['L298N', 'DC motor', 'robot', 'PWM'],
    circuit: circuits.robotCar,
    code: `// Robot car motors (L298N)
// Two DC motors through an L298N dual H-bridge, powered by a 9 V battery
// that shares the Arduino's ground. IN1/IN2 and IN3/IN4 set each motor's
// direction; PWM on ENA/ENB sets its speed.
// @run 0.5s
// @expect serial contains "Forward"

const int ENA = 10, IN1 = 9, IN2 = 8;   // left motor
const int IN3 = 7, IN4 = 6, ENB = 5;    // right motor

// speed: -255 (full reverse) … 255 (full forward)
void motor(int en, int a, int b, int speed) {
  digitalWrite(a, speed > 0);
  digitalWrite(b, speed < 0);
  analogWrite(en, abs(speed));
}

void drive(int left, int right) {
  motor(ENA, IN1, IN2, left);
  motor(ENB, IN3, IN4, right);
}

void setup() {
  Serial.begin(9600);
  int pins[] = { ENA, IN1, IN2, IN3, IN4, ENB };
  for (int p : pins) pinMode(p, OUTPUT);
}

void loop() {
  Serial.println("Forward");
  drive(200, 200);
  delay(2000);
  Serial.println("Turn left");
  drive(-150, 150);
  delay(1000);
  Serial.println("Reverse");
  drive(-200, -200);
  delay(2000);
  Serial.println("Stop");
  drive(0, 0);
  delay(1000);
}
`,
  }),
  ex({
    id: 'shift-register', title: 'Shift register counter', category: 'Logic', board: 'uno', level: 'Intermediate',
    summary: 'Drive a 7-segment digit from three pins through a 74HC595.',
    tags: ['74HC595', 'shiftOut', '7-segment'],
    circuit: circuits.shiftRegister,
    code: `// Shift register counter
// shiftOut() clocks eight bits into the 74HC595; a pulse on the latch pin
// copies them to Q0-Q7, which drive the segments of a common-cathode digit.

const int DATA = 11;
const int CLOCK = 13;
const int LATCH = 10;

// Segments A..G and DP on Q0..Q7 (bit 0 = segment A).
const byte DIGITS[10] = {0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F};

void show(byte segments) {
  digitalWrite(LATCH, LOW);
  shiftOut(DATA, CLOCK, MSBFIRST, segments);
  digitalWrite(LATCH, HIGH);
}

void setup() {
  pinMode(DATA, OUTPUT);
  pinMode(CLOCK, OUTPUT);
  pinMode(LATCH, OUTPUT);
}

void loop() {
  for (int digit = 0; digit < 10; digit++) {
    show(DIGITS[digit]);
    delay(500);
  }
}
`,
  }),

  ex({
    id: 'truth-table', title: 'Logic gate truth table', category: 'Logic', board: 'uno', level: 'Beginner',
    summary: 'The Arduino feeds an AND, an OR and an XOR gate and prints their truth table.',
    tags: ['logic gates', 'AND', 'OR', 'XOR'],
    circuit: circuits.truthTable,
    code: `// Logic gate truth table
// The Arduino sets the gate inputs A and B, then reads each gate's output
// back. A gate's output lead lights up green while it is HIGH.
// @run 4.5s
// @expect serial contains "A=1 B=1  ->  AND=1 OR=1 XOR=0"

const int A = 8, B = 9;
const int OUT_AND = 5, OUT_OR = 6, OUT_XOR = 7;

void setup() {
  Serial.begin(9600);
  pinMode(A, OUTPUT);
  pinMode(B, OUTPUT);
}

void loop() {
  for (int v = 0; v < 4; v++) {
    int a = v >> 1, b = v & 1;
    digitalWrite(A, a);
    digitalWrite(B, b);
    delay(1);
    Serial.print("A="); Serial.print(a);
    Serial.print(" B="); Serial.print(b);
    Serial.print("  ->  AND="); Serial.print(digitalRead(OUT_AND));
    Serial.print(" OR="); Serial.print(digitalRead(OUT_OR));
    Serial.print(" XOR="); Serial.println(digitalRead(OUT_XOR));
    delay(1000);
  }
  Serial.println();
}
`,
  }),
  ex({
    id: 'pico-blink', title: 'Raspberry Pi Pico: blink', category: 'Boards', board: 'pico', level: 'Beginner',
    summary: 'The Pico’s own LED and an LED on GP15 blink, and the count goes to Serial over USB.',
    tags: ['Raspberry Pi Pico', 'RP2040', '3.3 V', 'Serial'],
    circuit: circuits.picoBlink,
    code: `// Raspberry Pi Pico: blink
// The Pico's own LED (GP25) and the LED on GP15 blink twice a second, and the
// count goes to the Serial monitor over USB. Pico pins are 3.3 V.
// @run 1.2s
// @expect pin LED_BUILTIN frequency 2Hz ±5%
// @expect serial contains "Blink 2"

const int LED = 15;
int count = 0;

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(LED, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  digitalWrite(LED, HIGH);
  delay(250);
  digitalWrite(LED_BUILTIN, LOW);
  digitalWrite(LED, LOW);
  delay(250);
  Serial.print("Blink ");
  Serial.println(++count);
}
`,
  }),
  ex({
    id: 'pico-dimmer', title: 'Raspberry Pi Pico: dimmer', category: 'Boards', board: 'pico', level: 'Beginner',
    summary: 'A potentiometer on GP26 sets the brightness of an LED on GP16 with PWM.',
    tags: ['Raspberry Pi Pico', 'RP2040', 'analogRead', 'PWM', 'potentiometer'],
    circuit: circuits.picoDimmer,
    code: `// Raspberry Pi Pico: dimmer
// The potentiometer on GP26 (A0) sets the brightness of the LED on GP16.
// The Pico's ADC measures 0-3.3 V, and analogRead gives 0-1023 by default.
// Turn the potentiometer in the inspector while it runs.
// @run 0.5s
// @expect serial matches /^Reading: \\d+/m

const int POT = A0;  // GP26
const int LED = 16;

void setup() {
  Serial.begin(115200);
  pinMode(LED, OUTPUT);
}

void loop() {
  int reading = analogRead(POT);
  analogWrite(LED, reading / 4);
  Serial.print("Reading: ");
  Serial.println(reading);
  delay(100);
}
`,
  }),
  ex({
    id: 'attiny-blink', title: 'ATtiny85: blink', category: 'Boards', board: 'attiny85', level: 'Beginner',
    summary: 'An ATtiny85 on a breadboard, powered by 3×AA, blinks an LED on PB1.',
    tags: ['ATtiny85', 'ATTinyCore', 'breadboard', 'battery'],
    circuit: circuits.tinyBlink,
    code: `// ATtiny85: blink
// An ATtiny85 on a breadboard, running from 3×AA (4.5 V). The LED on PB1 —
// the chip's pin 6, and LED_BUILTIN in ATTinyCore — blinks once a second.
// On the ATtiny85, pin numbers are PORTB bits: pin 1 is PB1.
// @run 2.2s
// @expect pin LED_BUILTIN frequency 1Hz ±1%

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
}
`,
  }),
  ex({
    id: 'attiny-dimmer', title: 'ATtiny85: dimmer', category: 'Boards', board: 'attiny85', level: 'Beginner',
    summary: 'A potentiometer on PB2 sets the brightness of an LED on PB4; readings go out on the software Serial.',
    tags: ['ATtiny85', 'ATTinyCore', 'analogRead', 'PWM', 'potentiometer', 'Serial'],
    circuit: circuits.tinyDimmer,
    code: `// ATtiny85: dimmer
// The potentiometer on PB2 (A1) sets the brightness of the LED on PB4, which
// gets its PWM from Timer1. The ATtiny85 has no UART: ATTinyCore's Serial
// sends in software on PB0 (TX) at 9600 baud. The simulator shows it here; on
// a real chip read it with a USB-serial adapter on PB0.
// Turn the potentiometer in the inspector while it runs.
// @run 0.6s
// @expect serial matches /^Reading: \\d+/m

const int POT = A1;  // PB2
const int LED = 4;   // PB4

void setup() {
  Serial.begin(9600);
  pinMode(LED, OUTPUT);
}

void loop() {
  int reading = analogRead(POT);
  analogWrite(LED, reading / 4);
  Serial.print("Reading: ");
  Serial.println(reading);
  delay(100);
}
`,
  }),
  ex({
    id: 'attiny-lcd', title: 'ATtiny85: I²C LCD', category: 'Boards', board: 'attiny85', level: 'Intermediate',
    summary: 'An ATtiny85 drives a 16×2 I²C LCD through its USI: Wire on PB0 (SDA) and PB2 (SCL).',
    tags: ['ATtiny85', 'ATTinyCore', 'I2C', 'USI', 'LCD', 'LiquidCrystal_I2C'], libraries: ['LiquidCrystal I2C'],
    circuit: circuits.tinyLcd,
    code: `// ATtiny85: I2C LCD
// The ATtiny85 has no I2C peripheral: ATTinyCore's Wire drives its USI, with
// SDA on PB0 and SCL on PB2. A 16x2 LCD with an I2C backpack (address 0x27)
// says hello and counts. Serial would share PB0 with SDA, so the LCD shows
// what the sketch is doing.

#include <LiquidCrystal_I2C.h>

LiquidCrystal_I2C lcd(0x27, 16, 2);
unsigned int count = 0;

void setup() {
  lcd.init();
  lcd.backlight();
  lcd.print("Hello, ATtiny85");
}

void loop() {
  lcd.setCursor(0, 1);
  lcd.print("Count: ");
  lcd.print(count++);
  delay(250);
}
`,
  }),
  ex({
    id: 'mega-wave', title: 'Mega LED wave', category: 'Boards', board: 'mega', level: 'Beginner',
    summary: 'Eight LEDs on Mega-only pins 22-29; a pot on A8 sets the speed.',
    tags: ['Mega 2560', 'breadboard', 'analogRead'],
    circuit: circuits.mega,
    code: `// Mega LED wave
// The Mega 2560 has pins the Uno doesn't: eight LEDs on pins 22-29 light in a
// wave, and the potentiometer on A8 sets the speed.
// @run 0.4s
// @expect serial contains "Mega 2560 ready"

const int FIRST = 22;

void setup() {
  for (int i = 0; i < 8; i++) pinMode(FIRST + i, OUTPUT);
  Serial.begin(115200);
  Serial.println("Mega 2560 ready");
}

void loop() {
  int wait = map(analogRead(A8), 0, 1023, 20, 300);
  for (int i = 0; i < 8; i++) {
    digitalWrite(FIRST + i, HIGH);
    delay(wait);
    digitalWrite(FIRST + i, LOW);
  }
}
`,
  }),
  ex({
    id: 'nano-breadboard', title: 'Nano on a breadboard', category: 'Boards', board: 'nano', level: 'Beginner',
    summary: 'A Nano plugged into a breadboard with a button and an LED.',
    tags: ['Nano', 'breadboard', 'button'],
    circuit: circuits.nano,
    code: `// Nano on a breadboard
// The Nano straddles the breadboard's center channel, so every pin gets its
// own column. Press the button (or hold B) to light the LED on pin 13.

const int BUTTON = 2;
const int LED = 13;

void setup() {
  pinMode(BUTTON, INPUT_PULLUP);
  pinMode(LED, OUTPUT);
}

void loop() {
  digitalWrite(LED, digitalRead(BUTTON) == LOW ? HIGH : LOW);
}
`,
  }),

  ex({
    id: 'leonardo-usb-serial', title: 'Leonardo: USB serial', category: 'Boards', board: 'leonardo', level: 'Beginner',
    summary: 'The Leonardo’s Serial is its own USB port: it waits for the computer, then echoes what you type and fades an LED.',
    tags: ['Leonardo', 'ATmega32U4', 'native USB', 'Serial', 'PWM'],
    circuit: circuits.leonardoKeys,
    code: `// Leonardo: USB serial
// The ATmega32U4 talks USB itself: Serial is its USB port, so the sketch
// waits until the computer opens it (while (!Serial)). Type in the Serial
// monitor and the board answers. The LED on pin 13 fades with PWM from the
// chip's Timer4. (Serial1 is the UART on pins 0 and 1.)
// @run 1s
// @expect serial contains "Leonardo ready"
// @expect pin 13 frequency 490Hz ±2%

void setup() {
  Serial.begin(9600);
  while (!Serial);
  Serial.println("Leonardo ready. Type something:");
}

int level = 0;
int step = 5;

void loop() {
  analogWrite(13, level);
  level += step;
  if (level <= 0 || level >= 255) step = -step;
  while (Serial.available()) {
    Serial.print("You typed: ");
    Serial.println((char)Serial.read());
  }
  delay(20);
}
`,
  }),
  ex({
    id: 'esp32-blink', title: 'ESP32: blink', category: 'Boards', board: 'esp32', level: 'Beginner',
    summary: 'The ESP32 DevKit’s blue LED (GPIO2) and an LED on GPIO4 blink, and the count goes to Serial.',
    tags: ['ESP32', 'Espressif', '3.3 V', 'Serial'],
    circuit: circuits.esp32Blink,
    code: `// ESP32: blink
// The DevKit's blue LED (GPIO2, LED_BUILTIN) and the LED on GPIO4 blink twice
// a second, and the count goes to the Serial monitor. ESP32 pins are 3.3 V and
// numbered by GPIO: the board's "D4" is GPIO4.
// @run 1.5s
// @expect pin LED_BUILTIN frequency 2Hz ±5%
// @expect serial contains "Blink 2"

const int LED = 4;
int count = 0;

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(LED, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  digitalWrite(LED, HIGH);
  delay(250);
  digitalWrite(LED_BUILTIN, LOW);
  digitalWrite(LED, LOW);
  delay(250);
  Serial.print("Blink ");
  Serial.println(++count);
}
`,
  }),
  ex({
    id: 'esp32-wifi', title: 'ESP32: Wi-Fi status light', category: 'Boards', board: 'esp32', level: 'Beginner',
    summary: 'Scans for networks, joins one and lights an LED while connected (a pretend network: the simulator has no radio).',
    tags: ['ESP32', 'Wi-Fi', 'WiFi.begin', 'scan'],
    circuit: circuits.esp32Blink,
    code: `// ESP32: Wi-Fi status light
// Scans for networks, joins one, and keeps the LED on GPIO4 on while it's
// connected. The simulator has no radio: it shows two pretend networks and
// joins any network you name, with IP 10.0.2.15. Requests to the internet
// get no answer there; on a real board, put your network's name and password.
// @run 2s
// @expect serial contains "Connected, IP 10.0.2.15"
// @expect pin 4 high

#include <WiFi.h>

const char *SSID = "Impulse-WiFi";
const char *PASSWORD = "password";
const int LED = 4;

void setup() {
  Serial.begin(115200);
  pinMode(LED, OUTPUT);

  int found = WiFi.scanNetworks();
  Serial.printf("%d networks:\\n", found);
  for (int i = 0; i < found; i++) {
    Serial.printf("  %s (%d dBm)\\n", WiFi.SSID(i).c_str(), WiFi.RSSI(i));
  }

  WiFi.begin(SSID, PASSWORD);
  Serial.print("Connecting");
  while (WiFi.status() != WL_CONNECTED) {
    delay(100);
    Serial.print(".");
  }
  Serial.print("\\nConnected, IP ");
  Serial.println(WiFi.localIP());
}

void loop() {
  digitalWrite(LED, WiFi.status() == WL_CONNECTED ? HIGH : LOW);
  delay(100);
}
`,
  }),
  ex({
    id: 'esp32-dimmer', title: 'ESP32: dimmer', category: 'Boards', board: 'esp32', level: 'Beginner',
    summary: 'A potentiometer on GPIO34 sets the brightness of an LED on GPIO18 with PWM.',
    tags: ['ESP32', 'analogRead', 'PWM', 'potentiometer'],
    circuit: circuits.esp32Dimmer,
    code: `// ESP32: dimmer
// The potentiometer on GPIO34 sets the brightness of the LED on GPIO18. The
// ESP32's ADC reads 0-4095 (12 bits) for 0-3.3 V, and analogWrite takes
// 0-255. Turn the potentiometer in the inspector while it runs.
// @run 1s
// @expect serial matches /^Reading: \\d+/m

const int POT = 34;  // an input-only pin on ADC1
const int LED = 18;

void setup() {
  Serial.begin(115200);
}

void loop() {
  int reading = analogRead(POT);
  analogWrite(LED, reading / 16);
  Serial.print("Reading: ");
  Serial.println(reading);
  delay(100);
}
`,
  }),
  ex({
    id: 'esp32s3-rgb', title: 'ESP32-S3: RGB LED', category: 'Boards', board: 'esp32s3', level: 'Beginner',
    summary: 'The DevKitC’s RGB LED (a WS2812 on GPIO48) steps through red, green and blue.',
    tags: ['ESP32-S3', 'RGB LED', 'WS2812', 'NeoPixel'],
    circuit: circuits.esp32s3Rgb,
    code: `// ESP32-S3: RGB LED
// The DevKitC-1's RGB LED is a WS2812 on GPIO48 (RGB_BUILTIN). Espressif's
// core drives it with rgbLedWrite() (neopixelWrite() before core 3.0).
// @run 2s
// @expect serial contains "blue"

void setColor(uint8_t r, uint8_t g, uint8_t b) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  rgbLedWrite(RGB_BUILTIN, r, g, b);
#else
  neopixelWrite(RGB_BUILTIN, r, g, b);
#endif
}

void setup() {
  Serial.begin(115200);
}

void loop() {
  setColor(64, 0, 0);
  Serial.println("red");
  delay(400);
  setColor(0, 64, 0);
  Serial.println("green");
  delay(400);
  setColor(0, 0, 64);
  Serial.println("blue");
  delay(400);
}
`,
  }),
  ex({
    id: 'esp32c3-button', title: 'ESP32-C3: button interrupt', category: 'Boards', board: 'esp32c3', level: 'Intermediate',
    summary: 'An interrupt counts presses of a button on GPIO4; the LED on GPIO5 shows the button.',
    tags: ['ESP32-C3', 'RISC-V', 'attachInterrupt', 'button'],
    circuit: circuits.esp32c3Button,
    code: `// ESP32-C3: button interrupt
// An interrupt on GPIO4 counts presses of the button (or hold B); the LED on
// GPIO5 lights while it's held. The C3 is a RISC-V chip; the sketch is the
// same as on any Arduino.
// @run 1s
// @expect serial contains "Press the button"

const int BUTTON = 4;
const int LED = 5;
volatile int presses = 0;

void IRAM_ATTR onPress() {
  presses++;
}

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON, INPUT_PULLUP);
  pinMode(LED, OUTPUT);
  attachInterrupt(digitalPinToInterrupt(BUTTON), onPress, FALLING);
  Serial.println("Press the button");
}

int shown = 0;

void loop() {
  digitalWrite(LED, digitalRead(BUTTON) == LOW ? HIGH : LOW);
  if (presses != shown) {
    shown = presses;
    Serial.print("Presses: ");
    Serial.println(shown);
  }
  delay(10);
}
`,
  }),
  ex({
    id: 'nano-esp32-blink', title: 'Nano ESP32: blink', category: 'Boards', board: 'nanoesp32', level: 'Beginner',
    summary: 'The Nano ESP32’s LED (D13) and an LED on D2 blink, numbered the Arduino way.',
    tags: ['Nano ESP32', 'ESP32-S3', 'Arduino', '3.3 V'],
    circuit: circuits.nanoEsp32Blink,
    code: `// Nano ESP32: blink
// The Nano ESP32 keeps the Nano's pin names: D13 is LED_BUILTIN and D2 is
// pin 2, whichever ESP32-S3 GPIO they're wired to. It starts with a short
// fade of its RGB LED, then blinks.
// @run 2.5s
// @expect pin 2 toggles
// @expect serial contains "Blink 1"

const int LED = 2;
int count = 0;

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(LED, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  digitalWrite(LED, HIGH);
  delay(250);
  digitalWrite(LED_BUILTIN, LOW);
  digitalWrite(LED, LOW);
  delay(250);
  Serial.print("Blink ");
  Serial.println(++count);
}
`,
  }),

  ex({
    id: 'reaction-game', title: 'Reaction timer game', category: 'Projects', board: 'uno', level: 'Beginner',
    summary: 'Wait for the LED, then hit the button (or Space) as fast as you can.',
    tags: ['game', 'button', 'LCD', 'millis'], libraries: ['LiquidCrystal I2C'],
    circuit: circuits.reaction,
    code: `// Reaction timer game
// Wait for the green LED, then press the button (or the space bar) as fast as
// you can. The LCD shows your time and your best.

#include <LiquidCrystal_I2C.h>

LiquidCrystal_I2C lcd(0x27, 16, 2);
const int LED = 13;
const int BUTTON = 2;
unsigned long best = 0;

void setup() {
  pinMode(LED, OUTPUT);
  pinMode(BUTTON, INPUT_PULLUP);
  lcd.init();
  lcd.backlight();
  randomSeed(analogRead(A0) + micros());
}

void loop() {
  lcd.clear();
  lcd.print("Get ready...");
  delay(random(1500, 4000));
  if (digitalRead(BUTTON) == LOW) {
    lcd.clear();
    lcd.print("Too soon!");
    delay(1500);
    return;
  }
  digitalWrite(LED, HIGH);
  unsigned long start = millis();
  while (digitalRead(BUTTON) == HIGH) {}
  unsigned long t = millis() - start;
  digitalWrite(LED, LOW);
  if (!best || t < best) best = t;
  lcd.clear();
  lcd.print("Time: ");
  lcd.print(t);
  lcd.print(" ms");
  lcd.setCursor(0, 1);
  lcd.print("Best: ");
  lcd.print(best);
  lcd.print(" ms");
  while (digitalRead(BUTTON) == LOW) {}
  delay(2500);
}
`,
  }),
];

/** Diagram (Wokwi format) for an example. */
export function exampleDiagram(example) {
  const { parts, wires } = example.circuit();
  return {
    version: 1,
    author: 'Impulse',
    editor: 'impulse',
    parts: parts.map(p => {
      const out = { type: PARTS[p.type]?.saveAs || p.type, id: p.id, top: p.y, left: p.x };
      if (p.rotate) out.rotate = p.rotate;
      out.attrs = p.attrs;
      return out;
    }),
    connections: wires.map(w => [`${w.from.partId}:${w.from.pin}`, `${w.to.partId}:${w.to.pin}`, w.color || 'green', routeHints(w.start, w.points)]),
  };
}

export function exampleById(id) {
  return EXAMPLES.find(e => e.id === id) || null;
}
