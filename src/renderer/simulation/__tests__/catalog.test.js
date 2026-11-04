import { PARTS, CATEGORY_ORDER, partDef, resolvePartType, savedType, parseResistance } from '../parts/catalog.js';
import { searchParts, suggestParts, adviceFor } from '../search.js';
import { toDiagram, fromDiagram, routeHints, hintsToPoints, remapBoardWires } from '../diagram.js';
import { breadboardPins } from '../parts/modules.js';
import { BOARDS } from '../boards.js';

const top = (q, n = 3) => searchParts(q).slice(0, n).map(r => r.part.type);

describe('parts catalog', () => {
  it('describes every part completely', () => {
    for (const [type, def] of Object.entries(PARTS)) {
      expect(CATEGORY_ORDER).toContain(def.category);
      expect(def.label.length).toBeGreaterThan(2);
      expect(def.description.length).toBeGreaterThan(20);
      expect(Array.isArray(def.keywords) && def.keywords.length >= 2).toBe(true);
      const pins = def.pinNames(def.attrs);
      if (type !== 'wokwi-ir-remote') expect(pins.length).toBeGreaterThan(0);
      for (const pin of Object.keys(def.pins || {})) expect(pins).toContain(pin);
      for (const c of [...(def.controls || []), ...(def.props || [])]) expect(c.key && c.label && c.type).toBeTruthy();
    }
  });

  it('offers a wide range of parts in every category', () => {
    const count = (cat) => Object.values(PARTS).filter(p => p.category === cat).length;
    expect(Object.keys(PARTS).length).toBeGreaterThanOrEqual(70);
    // One part per simulated board.
    expect(count('Boards')).toBe(Object.keys(BOARDS).length);
    expect(count('Sensors')).toBeGreaterThanOrEqual(20);
    expect(count('Displays')).toBeGreaterThanOrEqual(10);
  });

  it('round-trips variant types through their saved Wokwi type', () => {
    expect(savedType('wokwi-lcd1602-parallel')).toBe('wokwi-lcd1602');
    expect(resolvePartType('wokwi-lcd1602', { pins: 'i2c' })).toBe('wokwi-lcd1602');
    expect(resolvePartType('wokwi-lcd1602', {})).toBe('wokwi-lcd1602-parallel');
    expect(resolvePartType('wokwi-7segment', { digits: '4' })).toBe('wokwi-7segment-4');
    expect(resolvePartType('wokwi-dht22', { model: 'dht11' })).toBe('wokwi-dht11');
    expect(resolvePartType('wokwi-breadboard', {})).toBe('impulse-breadboard');
    expect(resolvePartType('wokwi-unknown-thing', {})).toBeNull();
    expect(partDef('wokwi-breadboard-half').type).toBe('impulse-breadboard-half');
  });

  it('parses resistor values', () => {
    expect(parseResistance('220')).toBe(220);
    expect(parseResistance('4.7k')).toBe(4700);
    expect(parseResistance('1M')).toBe(1e6);
    expect(parseResistance('oops')).toBe(220);
  });

  it('generates Wokwi-compatible breadboard pins', () => {
    expect(breadboardPins('full')).toHaveLength(830);
    expect(breadboardPins('half')).toHaveLength(400);
    expect(breadboardPins('mini')).toHaveLength(170);
    expect(breadboardPins('full')).toEqual(expect.arrayContaining(['1t.a', '63b.j', 'tp.50', 'bn.1']));
  });
});

describe('part search', () => {
  it('finds parts by what people call them', () => {
    expect(top('ultrasonic')).toContain('wokwi-hc-sr04');
    expect(top('distance sensor')[0]).toBe('wokwi-hc-sr04');
    expect(top('temperature', 6)).toEqual(expect.arrayContaining(['wokwi-dht22', 'wokwi-dht11', 'impulse-lm35']));
    expect(top('oled')[0]).toBe('wokwi-ssd1306');
    expect(top('lcd i2c')[0]).toBe('wokwi-lcd1602');
    expect(top('led strip', 4)).toContain('wokwi-neopixel');
    expect(top('motion')[0]).toBe('wokwi-pir-motion-sensor');
    expect(top('servo')[0]).toBe('wokwi-servo');
    expect(top('breadboard')[0]).toBe('impulse-breadboard');
    expect(top('mega')[0]).toBe('wokwi-arduino-mega');
    expect(top('pot')[0]).toBe('wokwi-potentiometer');
    expect(top('74hc595')[0]).toBe('impulse-74hc595');
    expect(top('soil')[0]).toBe('impulse-soil-moisture');
    expect(top('attiny85')[0]).toBe('impulse-attiny85');
    expect(top('attiny')[0]).toBe('impulse-attiny85');
  });

  it('points unsimulated boards at the ones it runs', () => {
    expect(adviceFor('attiny85')).toBeNull();
    expect(adviceFor('attiny84')?.parts.map(p => p.type)).toContain('impulse-attiny85');
    expect(adviceFor('esp8266')?.text).toMatch(/ESP32-S3, ESP32-C3 and Nano ESP32/);
    expect(adviceFor('esp32-c6')?.parts.map(p => p.type)).toContain('wokwi-esp32-devkit-v1');
  });

  it('finds the Leonardo for ATmega32U4 boards', () => {
    expect(adviceFor('leonardo')).toBeNull();
    expect(top('leonardo')[0]).toBe('impulse-arduino-leonardo');
    expect(top('pro micro')).toContain('impulse-arduino-leonardo');
  });

  it('finds the ESP32 boards', () => {
    expect(adviceFor('esp32')).toBeNull();
    expect(top('esp32')[0]).toBe('wokwi-esp32-devkit-v1');
    expect(top('esp32-s3')[0]).toBe('impulse-esp32-s3-devkitc');
    expect(top('esp32 c3')[0]).toBe('impulse-esp32-c3-devkitm');
    expect(top('nano esp32')[0]).toBe('impulse-nano-esp32');
  });

  it('tolerates typos', () => {
    expect(top('potentiometr')).toContain('wokwi-potentiometer');
    expect(top('ultrasnic')).toContain('wokwi-hc-sr04');
  });

  it('always has a fallback', () => {
    expect(searchParts('flux capacitor')).toEqual([]);
    const s = suggestParts('flux capacitor');
    expect(s.generic.map(p => p.type)).toEqual(['impulse-generic-digital', 'impulse-generic-analog']);
    expect(suggestParts('gas leak detector').similar.map(p => p.type)).toContain('wokwi-gas-sensor');
  });
});

describe('diagram.json', () => {
  const model = {
    parts: [
      { id: 'uno', type: 'wokwi-arduino-uno', x: 10, y: 20, attrs: {} },
      { id: 'lcd', type: 'wokwi-lcd1602-parallel', x: 300, y: 40, rotate: 90, attrs: { pins: 'full' } },
    ],
    wires: [{ from: { partId: 'uno', pin: '12' }, to: { partId: 'lcd', pin: 'RS' }, color: 'orange', start: { x: 0, y: 0 }, points: [{ x: 10, y: 0 }, { x: 10, y: 20 }] }],
  };

  it('saves in Wokwi format and loads back', () => {
    const d = toDiagram(model);
    expect(d.parts[1]).toEqual({ type: 'wokwi-lcd1602', id: 'lcd', top: 40, left: 300, rotate: 90, attrs: { pins: 'full' } });
    expect(d.connections[0]).toEqual(['uno:12', 'lcd:RS', 'orange', ['h10', 'v20', '*']]);
    const back = fromDiagram(JSON.parse(JSON.stringify(d)));
    expect(back.parts.map(p => p.type)).toEqual(['wokwi-arduino-uno', 'wokwi-lcd1602-parallel']);
    expect(back.parts[1].rotate).toBe(90);
    expect(back.wires[0].from).toEqual({ partId: 'uno', pin: '12' });
  });

  it('reports parts it does not know instead of dropping them silently', () => {
    const r = fromDiagram({ parts: [{ type: 'wokwi-esp32-cam', id: 'cam' }, { type: 'wokwi-led', id: 'led1' }], connections: [['cam:1', 'led1:A', 'red', []]] });
    expect(r.unsupported).toEqual(['wokwi-esp32-cam']);
    expect(r.parts).toHaveLength(1);
    expect(r.wires).toHaveLength(0);
    expect(fromDiagram({ nope: 1 }).errors.length).toBe(1);
  });

  it('converts routing hints both ways', () => {
    expect(routeHints({ x: 0, y: 0 }, [{ x: 0, y: -9.6 }, { x: 19.2, y: -9.6 }])).toEqual(['v-9.6', 'h19.2', '*']);
    expect(hintsToPoints(['v-9.6', 'h19.2', '*', 'v5'], { x: 0, y: 0 }, { x: 50, y: 50 }))
      .toEqual([{ x: 0, y: -9.6 }, { x: 19.2, y: -9.6 }, { x: 50, y: 45 }]);
  });

  it('moves I2C wires to the new board\'s SDA/SCL and keeps pin numbers', () => {
    const wires = [
      { from: { partId: 'b', pin: 'A4' }, to: { partId: 'lcd', pin: 'SDA' } },
      { from: { partId: 'b', pin: 'A5' }, to: { partId: 'lcd', pin: 'SCL' } },
      { from: { partId: 'b', pin: 'A4' }, to: { partId: 'pot', pin: 'SIG' } },
      { from: { partId: 'b', pin: '13' }, to: { partId: 'led', pin: 'A' } },
      { from: { partId: 'b', pin: 'GND.3' }, to: { partId: 'led', pin: 'C' } },
    ];
    const types = { lcd: 'wokwi-lcd1602', pot: 'wokwi-potentiometer', led: 'wokwi-led' };
    const up = remapBoardWires(wires, 'b', 'wokwi-arduino-uno', 'wokwi-arduino-mega', types);
    expect(up.wires.map(w => w.from.pin)).toEqual(['SDA', 'SCL', 'A4', '13', 'GND.3']);
    expect(up.dropped).toEqual([]);
    const down = remapBoardWires([{ from: { partId: 'b', pin: '53' }, to: { partId: 'led', pin: 'A' } }, { from: { partId: 'b', pin: '20' }, to: { partId: 'lcd', pin: 'SDA' } }], 'b', 'wokwi-arduino-mega', 'wokwi-arduino-nano', types);
    expect(down.wires.map(w => w.from.pin)).toEqual(['A4']);
    expect(down.dropped).toHaveLength(1);
  });
});
