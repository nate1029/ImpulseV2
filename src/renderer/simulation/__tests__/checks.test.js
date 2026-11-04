// Circuit check rules on a deliberately broken circuit.
import { circuitChecks } from '../checks.js';

const part = (id, type, attrs = {}) => ({ id, type, attrs, x: 0, y: 0, rotate: 0 });
const wire = (a, b) => {
  const [ap, apin] = a.split(/:(.+)/);
  const [bp, bpin] = b.split(/:(.+)/);
  return { from: { partId: ap, pin: apin }, to: { partId: bp, pin: bpin } };
};

describe('circuit check', () => {
  it('finds the common wiring mistakes', () => {
    const parts = [
      part('uno', 'wokwi-arduino-uno'),
      part('led1', 'wokwi-led'),
      part('btn1', 'wokwi-pushbutton'),
      part('dht1', 'wokwi-dht22'),
      part('lcd1', 'wokwi-lcd1602', { pins: 'i2c' }),
      part('lcd2', 'wokwi-lcd1602', { pins: 'i2c' }),
      part('g1', 'impulse-gate-and'),
      part('bat1', 'impulse-battery', { voltage: '9' }),
      part('bat2', 'impulse-battery', { voltage: '6' }),
      part('t1', 'impulse-ds18b20'),
    ];
    const wires = [
      wire('led1:A', 'uno:13'), wire('led1:C', 'uno:GND.1'),
      wire('dht1:SDA', 'uno:2'),
      ...['lcd1', 'lcd2'].flatMap(id => [wire(`${id}:SDA`, 'uno:A4'), wire(`${id}:SCL`, 'uno:A5'), wire(`${id}:VCC`, 'uno:5V'), wire(`${id}:GND`, 'uno:GND.2')]),
      wire('g1:A', 'uno:8'), wire('g1:Y', 'uno:7'),
      wire('bat1:+', 'uno:3'), wire('bat1:-', 'uno:GND.1'),
      wire('bat2:+', 'uno:GND.3'),
      wire('t1:DQ', 'uno:4'), wire('t1:VCC', 'uno:5V'), wire('t1:GND', 'uno:GND.1'),
    ];
    const texts = circuitChecks({ parts, wires }).map(i => `${i.level}: ${i.text}`);
    const has = (re) => expect(texts.some(t => re.test(t))).toBe(true);
    has(/^warn: led1 has no series resistor/);
    has(/^info: btn1 \(Pushbutton\) isn't connected/);
    has(/^warn: dht1 .* has no power/);
    has(/^warn: lcd1 and lcd2 both use I²C address 0x27/);
    has(/^warn: g1's input B isn't connected/);
    has(/^error: bat1 puts 9 V straight onto D3/);
    has(/^error: bat2's \+ is wired to GND/);
    has(/^info: t1 has no 4\.7 kΩ pull-up/);
    expect(texts.some(t => /lcd1 .* has no power/.test(t))).toBe(false);
  });

  it('reports a missing board and recorded shorts', () => {
    const texts = circuitChecks({ parts: [], wires: [] }, { shorts: [{ tags: ['D2', 'GND'] }] }).map(i => i.text);
    expect(texts[0]).toMatch(/no Arduino board/);
    expect(texts[1]).toMatch(/^Short circuit: D2 and GND/);
  });
});
