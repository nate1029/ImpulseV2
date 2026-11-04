// Every example project must compile, run on its own circuit and do what its
// description promises.
import { EXAMPLES, exampleDiagram, EXAMPLE_CATEGORIES } from '../examples.js';
import { fromDiagram, plugLinks } from '../diagram.js';
import { circuitChecks } from '../checks.js';
import { parseExpectations, evaluateExpectations } from '../expectations.js';
import { BOARDS } from '../boards.js';
import { partDef } from '../parts/catalog.js';
import { Bench } from './bench.js';
import { compileSketch, describeWithCli, installedLibraries, PICO, ATTINY, ESP32, compileEsp32, stopEsp32, hasEsp32Core } from './cli.js';
import { F_CPU } from '../avr-runner.js';

const LIBS = installedLibraries();
// Examples for boards whose core isn't installed here are skipped.
const needsCore = (ex) => (ex.board === 'pico' && !PICO) || (ex.board === 'attiny85' && !ATTINY) || isEsp32(ex);
// ESP32 examples run in the emulator, in real time (their own suite below).
const isEsp32 = (ex) => BOARDS[ex.board].family === 'esp32';
const lcdText = (b, id) => String.fromCharCode(...(b.part(id).el.characters || []));
const press = (id) => (b) => b.behavior(id).set(true);
const release = (id) => (b) => b.behavior(id).set(false);
const key = (k, row, column) => (b) => b.part('keypad1').el.dispatchEvent(new CustomEvent('button-press', { detail: { key: k, row, column } }));
const unkey = (k) => (b) => b.part('keypad1').el.dispatchEvent(new CustomEvent('button-release', { detail: { key: k } }));

// Interaction script and assertions per example.
const CHECKS = {
  'blink': { run: 1.2, check: (b) => expect(b.trace(13).length).toBeGreaterThanOrEqual(2) },
  'button': {
    run: 0.4, actions: [[0.1, press('btn1')], [0.3, release('btn1')]],
    check: (b) => expect(b.lines()).toEqual(['Pressed', 'Released']),
  },
  'fade': { run: 0.6, check: (b) => expect(b.part('led1').el.brightness).toBeGreaterThan(0.05) },
  'traffic-light': {
    run: 4.5,
    check: (b) => {
      expect(b.part('led_green').el.value).toBe(true);
      expect(b.part('led_red').el.value).toBe(false);
    },
  },
  'potentiometer': { run: 0.3, check: (b) => expect(b.part('led1').el.brightness).toBeGreaterThan(0.4) },
  'rgb-led': { run: 0.6, check: (b) => expect(b.part('rgb1').el.ledRed + b.part('rgb1').el.ledGreen).toBeGreaterThan(0.5) },
  'melody': { run: 0.3, check: (b) => expect(b.engine.frequencyOfNet(b.engine.netOfNode('buzzer1:2'))).toBeGreaterThan(250) },
  'serial-echo': {
    run: 0.8, actions: [[0.2, (b) => b.runner.serialWrite('hello\n')], [0.4, (b) => b.runner.serialWrite('on\n')]],
    check: (b) => {
      expect(b.serial).toContain('You said: HELLO');
      expect(b.part('led1').el.value).toBe(true);
    },
  },
  'lcd-hello': { run: 1.4, check: (b) => expect(lcdText(b, 'lcd1').slice(0, 15)).toBe('Hello, Impulse!') },
  'oled': { run: 0.6, check: (b) => expect(b.behavior('oled1').oled.pixel(0, 12)).toBe(true) },
  'seven-segment': { run: 0.6, check: (b) => expect((b.part('seg1').el.values || []).some(v => v)).toBe(true) },
  'neopixel': { run: 0.2, check: (b) => expect(b.part('ring1').el.pixels.filter(p => p && (p.r || p.g || p.b)).length).toBe(16) },
  'led-matrix': { run: 0.3, check: (b) => expect((b.part('matrix1').el.values || []).filter(Boolean).length).toBeGreaterThan(10) },
  'distance-meter': { run: 1.6, check: (b) => expect(lcdText(b, 'lcd1').slice(16)).toMatch(/^100 cm/) },
  'weather-station': { run: 0.5, check: (b) => expect(b.behavior('oled1').oled.on).toBe(true) },
  'motion-alarm': {
    run: 0.8, actions: [[0.2, (b) => b.behavior('pir1').trigger()]],
    check: (b) => expect(b.serial).toContain('Motion detected!'),
  },
  'night-light': { run: 0.4, check: (b) => expect(b.part('led1').el.brightness).toBeGreaterThan(0.5) },
  'rc-charge': {
    // One reading every 0.1 s along 5·(1 − e^(−t/1 s)).
    run: 2.05,
    check: (b) => {
      const volts = b.lines().map(l => Number(l.replace('Volts: ', '')));
      expect(volts[0]).toBeLessThan(0.05);
      for (const i of [5, 10, 20]) expect(Math.abs(volts[i] - 5 * (1 - Math.exp(-i / 10)))).toBeLessThan(0.05);
    },
  },
  'tilt-sensor': { run: 0.8, check: (b) => expect(b.serial).toMatch(/Pitch: 0\.0 {2}Roll: 0\.0/) },
  'rtc-clock': { run: 1.5, check: (b) => expect(lcdText(b, 'lcd1').slice(0, 4)).toBe(String(new Date().getFullYear())) },
  'kitchen-scale': {
    run: 1.4, actions: [[0.6, (b) => { b.part('cell1').attrs.weight = '250'; }]],
    check: (b) => expect(b.lines().slice(-1)[0]).toBe('Weight: 250.0 g'),
  },
  'keypad-lock': {
    run: 2.8,
    actions: [
      [1.2, key('1', 0, 0)], [1.3, unkey('1')], [1.4, key('2', 0, 1)], [1.5, unkey('2')],
      [1.6, key('3', 0, 2)], [1.7, unkey('3')], [1.8, key('4', 1, 0)], [1.9, unkey('4')],
      [2.0, key('#', 3, 2)], [2.1, unkey('#')],
    ],
    check: (b) => {
      expect(lcdText(b, 'lcd1').slice(0, 9)).toBe('Unlocked!');
      expect(b.part('servo1').el.angle).toBeGreaterThan(85);
    },
  },
  'rotary-encoder': {
    run: 0.3, actions: [[0.1, (b) => b.behavior('enc1').turn(1)], [0.15, (b) => b.behavior('enc1').turn(1)]],
    check: (b) => expect(b.serial).toContain('Position: 2'),
  },
  'joystick-servo': {
    run: 0.5, actions: [[0.1, (b) => { b.part('joy1').el.xValue = 1; b.behavior('joy1').apply(); }]],
    check: (b) => expect(b.part('servo1').el.angle).toBeLessThan(5),
  },
  'ir-remote': {
    run: 0.8, actions: [[0.3, (b) => b.behavior('remote1').press(0x30)], [0.4, (b) => b.behavior('remote1').release()]],
    check: (b) => expect(b.part('led1').el.value).toBe(true),
  },
  'servo-sweep': { run: 1.0, check: (b) => expect(b.part('servo1').el.angle).toBeGreaterThan(30) },
  'stepper-driver': { run: 1.0, check: (b) => expect(Math.abs(b.behavior('motor1').steps)).toBeGreaterThan(20) },
  'relay-lamp': {
    run: 0.5, actions: [[0.1, press('btn1')], [0.25, release('btn1')]],
    check: (b) => expect(b.part('lamp1').el.value).toBe(true),
  },
  'dc-motor': { run: 1.0, check: (b) => expect(b.behavior('motor1').rpm).toBeGreaterThan(20) },
  'shift-register': { run: 0.2, check: (b) => expect(b.part('seg1').el.values.slice(0, 7)).toEqual([1, 1, 1, 1, 1, 1, 0]) },
  'leonardo-usb-serial': {
    run: 1, actions: [[0.5, (b) => b.runner.serialWrite('ok', 0)]],
    check: (b) => {
      expect(b.serial).toContain('Leonardo ready');
      expect(b.serial).toContain('You typed: o\r\nYou typed: k\r\n');
      expect(b.trace(13).length).toBeGreaterThan(100);
    },
  },
  'esp32-blink': {
    run: 1.5,
    check: (r) => {
      expect(r.trace(2).length).toBeGreaterThanOrEqual(4);
      expect(r.trace(4).length).toBeGreaterThanOrEqual(4);
      expect(r.serial).toContain('Blink 2');
    },
  },
  'esp32-wifi': {
    run: 2,
    check: (r) => {
      expect(r.serial).toMatch(/2 networks:\s+Impulse-WiFi/);
      expect(r.serial).toContain('Connected, IP 10.0.2.15');
      expect(r.trace(4).map(e => e.high)).toEqual([true]);
    },
  },
  'esp32-dimmer': {
    run: 1,
    check: (r) => {
      const reading = Number(r.lines().slice(-1)[0].replace('Reading: ', ''));
      expect(Math.abs(reading - 2048)).toBeLessThan(60);
      expect(Math.abs(r.part('led1').el.brightness - reading / 4095)).toBeLessThan(0.1);
    },
  },
  'esp32s3-rgb': {
    run: 2,
    check: (r) => {
      expect(r.serial).toMatch(/red\s+green\s+blue/);
      expect([[64, 0, 0], [0, 64, 0], [0, 0, 64]]).toContainEqual(r.runner.rgbOf(48));
    },
  },
  'esp32c3-button': {
    run: 1.2, actions: [[0.6, press('btn1')], [0.8, release('btn1')]],
    check: (r) => {
      expect(r.serial).toContain('Presses: 1');
      expect(r.trace(5).map(e => e.high)).toEqual([true, false]);
    },
  },
  'nano-esp32-blink': {
    run: 2.5,
    check: (r) => {
      expect(r.trace(5).length).toBeGreaterThanOrEqual(2);   // D2
      expect(r.trace(48).length).toBeGreaterThanOrEqual(2);  // D13, LED_BUILTIN
      expect(r.serial).toContain('Blink 1');
    },
  },
  'pico-blink': {
    run: 1.2,
    check: (b) => {
      expect(b.trace(25).length).toBeGreaterThanOrEqual(4);
      expect(b.trace(15).length).toBeGreaterThanOrEqual(4);
      expect(b.serial).toContain('Blink 2');
    },
  },
  'pico-dimmer': {
    run: 0.5,
    check: (b) => {
      const reading = Number(b.lines().slice(-1)[0].replace('Reading: ', ''));
      expect(Math.abs(reading - 512)).toBeLessThan(12);
      expect(Math.abs(b.part('led1').el.brightness - reading / 1023)).toBeLessThan(0.1);
    },
  },
  'attiny-blink': {
    run: 2.2,
    check: (b) => {
      expect(b.links.length).toBeGreaterThan(10);
      expect(b.trace(1).length).toBeGreaterThanOrEqual(4);
      expect(b.part('led1').el.brightness).toBeGreaterThanOrEqual(0);
      expect(b.shorts).toEqual([]);
    },
  },
  'attiny-dimmer': {
    run: 0.6,
    check: (b) => {
      const reading = Number(b.lines().slice(-1)[0].replace('Reading: ', ''));
      expect(Math.abs(reading - 512)).toBeLessThan(12);
      expect(Math.abs(b.part('led1').el.brightness - reading / 1023)).toBeLessThan(0.1);
    },
  },
  'attiny-lcd': {
    // LiquidCrystal_I2C's begin() waits a second before it talks to the LCD.
    run: 1.8,
    check: (b) => {
      expect(lcdText(b, 'lcd1').slice(0, 15)).toBe('Hello, ATtiny85');
      expect(lcdText(b, 'lcd1').slice(16)).toMatch(/^Count: [1-9]/);
    },
  },
  'mega-wave': { run: 0.4, check: (b) => expect([1, 2, 3, 4, 5, 6, 7, 8].filter(i => b.part(`led${i}`).el.value)).toHaveLength(1) },
  'nano-breadboard': {
    run: 0.3, actions: [[0.1, press('btn1')]],
    check: (b) => {
      expect(b.links.length).toBeGreaterThan(30);
      expect(b.part('led1').el.value).toBe(true);
    },
  },
  'thermometer': {
    run: 2.0,
    check: (b) => {
      expect(b.serial).toContain('Temperature: 21.4 C');
      expect(b.part('disp1').el.segments).toEqual([0x5b, 0x06, 0x63, 0x39]); // "21°C"
    },
  },
  'stepper-28byj': {
    run: 1.2,
    check: (b) => {
      expect(b.behavior('motor1').steps).toBeGreaterThan(400);
      expect(b.behavior('motor1').steps).toBeLessThan(620);
    },
  },
  'robot-car': {
    run: 1.0,
    check: (b) => {
      expect(Math.abs(b.behavior('left').rpm)).toBeGreaterThan(100);
      expect(Math.abs(b.behavior('right').rpm)).toBeGreaterThan(100);
    },
  },
  'truth-table': {
    run: 4.3,
    check: (b) => expect(b.lines().slice(0, 4)).toEqual([
      'A=0 B=0  ->  AND=0 OR=0 XOR=0', 'A=0 B=1  ->  AND=0 OR=1 XOR=1',
      'A=1 B=0  ->  AND=0 OR=1 XOR=1', 'A=1 B=1  ->  AND=1 OR=1 XOR=0',
    ]),
  },
  'reaction-game': { run: 1.3, check: (b) => expect(lcdText(b, 'lcd1').slice(0, 12)).toBe('Get ready...') },
};

describe('examples catalog', () => {
  it('has a check, a category and a valid circuit for every example', () => {
    const ids = new Set();
    for (const ex of EXAMPLES) {
      expect(ids.has(ex.id)).toBe(false);
      ids.add(ex.id);
      expect(EXAMPLE_CATEGORIES).toContain(ex.category);
      expect(CHECKS[ex.id]).toBeDefined();
      const { parts, wires } = ex.circuit();
      const byId = new Map(parts.map(p => [p.id, p]));
      expect(parts.some(p => partDef(p.type)?.board)).toBe(true);
      for (const w of wires) {
        for (const end of [w.from, w.to]) {
          const p = byId.get(end.partId);
          expect(p).toBeDefined();
          expect(partDef(p.type).pinNames(p.attrs)).toContain(end.pin);
        }
      }
      // Saved diagrams load back to the same parts.
      const loaded = fromDiagram(JSON.parse(JSON.stringify(exampleDiagram(ex))));
      expect(loaded.unsupported).toEqual([]);
      expect(loaded.parts.map(p => p.type)).toEqual(parts.map(p => p.type));
    }
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(30);
  });

  it('passes the circuit check', () => {
    const found = {};
    for (const ex of EXAMPLES) {
      const { parts, wires } = ex.circuit();
      const issues = circuitChecks({ parts, wires, links: plugLinks(parts) });
      if (issues.length) found[ex.id] = issues.map(i => i.text);
    }
    expect(found).toEqual({});
  });

  it('lays out parts without stacking them on top of each other', () => {
    // Parts plugged into a breadboard overlap it on purpose; everything else must not.
    // An LED's element box leaves room for its glow; only the dome and legs are drawn.
    const INSET = { 'wokwi-led': { x: 9, y: 5 } };
    const box = (p) => {
      const { w, h } = partDef(p.type).size;
      const inset = INSET[p.type] || { x: 0, y: 0 };
      const turned = (((p.rotate || 0) % 180) + 180) % 180 === 90;
      const cx = p.x + w / 2;
      const cy = p.y + h / 2;
      const [bw, bh] = turned ? [h - 2 * inset.y, w - 2 * inset.x] : [w - 2 * inset.x, h - 2 * inset.y];
      return { id: p.id, l: cx - bw / 2, r: cx + bw / 2, t: cy - bh / 2, b: cy + bh / 2 };
    };
    const SLACK = 2;
    const overlaps = [];
    for (const ex of EXAMPLES) {
      const boxes = ex.circuit().parts.filter(p => !p.type.includes('breadboard')).map(box);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const c = boxes[j];
          const dx = Math.min(a.r, c.r) - Math.max(a.l, c.l);
          const dy = Math.min(a.b, c.b) - Math.max(a.t, c.t);
          if (dx > SLACK && dy > SLACK) overlaps.push(`${ex.id}: ${a.id} × ${c.id}`);
        }
      }
    }
    expect(overlaps).toEqual([]);
  });
});

describeWithCli('every example runs on its circuit (needs arduino-cli)', () => {
  for (const ex of EXAMPLES) {
    const missing = (ex.libraries || []).filter(l => !LIBS.has(l.toLowerCase()));
    // Pico and ATtiny85 examples need the Arduino-Pico core and ATTinyCore (see cli.js).
    (missing.length || needsCore(ex) ? it.skip : it)(`${ex.id}: ${ex.title}`, () => {
      const hex = compileSketch(ex.code, BOARDS[ex.board].fqbn, ex.id.replace(/-/g, '_'));
      const b = new Bench(ex.board, { addBoard: false });
      b.addModel(ex.circuit());
      b.trace = (pin) => b._trace.filter(e => e.pin === pin);
      b._trace = [];
      b.load(hex);
      const prev = b.runner.onPinChange;
      b.runner.onPinChange = (pin, high, cycles) => { b._trace.push({ pin, high, cycles }); prev?.(pin, high, cycles); };
      const spec = CHECKS[ex.id];
      b.run(spec.run, spec.actions || []);
      spec.check(b);
      expect(b.shorts).toEqual([]);
      expect(b.logs.filter(l => /\[sim\]/.test(l))).toEqual([]);
    }, 120000);
  }
});

describeWithCli('example hardware tests pass in the headless runner', () => {
  for (const ex of EXAMPLES) {
    const { items, errors } = parseExpectations(ex.code, ex.board);
    if (!items.length) continue;
    const missing = (ex.libraries || []).filter(l => !LIBS.has(l.toLowerCase()));
    // Pico and ATtiny85 examples need the Arduino-Pico core and ATTinyCore (see cli.js).
    (missing.length || needsCore(ex) ? it.skip : it)(`${ex.id} @expect lines`, async () => {
      const { runHeadless } = await import('../headless.js');
      expect(errors).toEqual([]);
      const hex = compileSketch(ex.code, BOARDS[ex.board].fqbn, ex.id.replace(/-/g, '_'));
      const { seconds } = parseExpectations(ex.code, ex.board);
      const run = await runHeadless(hex, { seconds, board: ex.board, circuit: ex.circuit() });
      const results = evaluateExpectations(items, run, ex.board);
      for (const r of results) expect({ check: r.raw, pass: r.pass, detail: r.detail }).toMatchObject({ pass: true });
    }, 120000);
  }
});

(ESP32 ? describe : describe.skip)('ESP32 examples run in the emulator (IMPULSE_ESP32_TESTS=1)', () => {
  afterAll(() => stopEsp32());
  for (const ex of EXAMPLES.filter(isEsp32)) {
    (hasEsp32Core(BOARDS[ex.board].fqbn) ? it : it.skip)(`${ex.id}: ${ex.title}`, async () => {
      const { runHeadless } = await import('../headless.js');
      const program = await compileEsp32(ex.code, BOARDS[ex.board].fqbn, ex.id.replace(/-/g, '_'));
      const spec = CHECKS[ex.id];
      const { seconds } = parseExpectations(ex.code, ex.board);
      let rig = null;
      let checked = false;
      const run = await runHeadless(program, {
        seconds: Math.max(spec.run, seconds),
        board: ex.board,
        circuit: ex.circuit(),
        setup: (runner, engine) => {
          rig = { runner, engine, behavior: (id) => engine.behaviorOf(id), part: (id) => engine.parts.find(p => p.id === id) };
          for (const [t, action] of spec.actions || []) runner.schedule(t * F_CPU, () => action(rig));
        },
        // Parts are checked while the circuit still runs.
        beforeStop: (runner, engine, { serial, trace }) => {
          spec.check({
            ...rig,
            serial,
            trace: (pin) => trace.filter(e => e.pin === pin),
            lines: () => serial.split('\n').map(l => l.trim()).filter(Boolean),
          });
          checked = true;
        },
      });
      expect(checked).toBe(true);
      expect(run.shorts).toEqual([]);
      const { items } = parseExpectations(ex.code, ex.board);
      for (const r of evaluateExpectations(items, run, ex.board)) expect({ check: r.raw, pass: r.pass, detail: r.detail }).toMatchObject({ pass: true });
    }, 600000);
  }
});
