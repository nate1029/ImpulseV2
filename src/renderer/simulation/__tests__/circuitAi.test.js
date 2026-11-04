import { validateCircuit, layoutCircuit, catalogText } from '../circuit-ai.js';

const uno = { id: 'uno', type: 'wokwi-arduino-uno' };

describe('validateCircuit', () => {
  it('accepts a valid LED circuit and warns about the missing resistor', () => {
    const res = validateCircuit({
      parts: [uno, { id: 'led1', type: 'wokwi-led' }],
      connections: [['uno:13', 'led1:A'], ['led1:C', 'uno:GND.1']]
    });
    expect(res.ok).toBe(true);
    expect(res.warnings[0]).toContain('without series resistors');
    expect(res.circuit.wires).toHaveLength(2);
  });

  it('rejects unknown parts, pins and duplicate ids', () => {
    const res = validateCircuit({
      parts: [uno, { id: 'x', type: 'wokwi-flux-capacitor' }, { id: 'led1', type: 'wokwi-led' }, { id: 'led1', type: 'wokwi-led' }],
      connections: [['uno:99', 'led1:A'], ['ghost:1', 'uno:GND.1']]
    });
    expect(res.ok).toBe(false);
    expect(res.errors).toEqual(expect.arrayContaining([
      'Unknown part type: wokwi-flux-capacitor',
      'Duplicate part id: led1',
      'wokwi-arduino-uno "uno" has no pin "99"',
      'Connection references unknown part: ghost'
    ]));
  });

  it('requires exactly one Arduino board, of any kind', () => {
    expect(validateCircuit({ parts: [], connections: [] }).errors).toContain('Circuit has no Arduino board');
    expect(validateCircuit({ parts: [uno, { id: 'mega', type: 'wokwi-arduino-mega' }], connections: [] }).errors)
      .toContain('Circuit has more than one Arduino board');
    const mega = validateCircuit({
      parts: [{ id: 'mega', type: 'wokwi-arduino-mega' }, { id: 'lcd1', type: 'wokwi-lcd1602', attrs: { pins: 'i2c' } }],
      connections: [['mega:20', 'lcd1:SDA'], ['mega:21', 'lcd1:SCL']]
    });
    expect(mega.ok).toBe(true);
  });

  it('resolves saved variant types from their attrs', () => {
    const res = validateCircuit({
      parts: [uno, { id: 'lcd1', type: 'wokwi-lcd1602', attrs: { pins: 'full' } }],
      connections: [['uno:12', 'lcd1:RS']]
    });
    expect(res.ok).toBe(true);
    expect(res.circuit.parts[1].type).toBe('wokwi-lcd1602-parallel');
  });
});

describe('layout and catalog', () => {
  it('places the board left of every other part without overlaps in a column', () => {
    const { circuit } = validateCircuit({
      parts: [uno, { id: 'led1', type: 'wokwi-led' }, { id: 'lcd1', type: 'wokwi-lcd1602' }, { id: 'pot1', type: 'wokwi-potentiometer' }],
      connections: []
    });
    const out = layoutCircuit(circuit);
    const board = out.parts.find(p => p.id === 'uno');
    for (const p of out.parts) if (p !== board) expect(p.x).toBeGreaterThan(board.x + 274);
  });

  it('describes every non-board part to the model', () => {
    const text = catalogText();
    expect(text).toContain('wokwi-hc-sr04 — Ultrasonic sensor (HC-SR04)');
    expect(text).toContain('impulse-74hc595');
    expect(text).not.toContain('wokwi-arduino-uno —');
    expect(text.length).toBeLessThan(256 * 1024);
  });
});
