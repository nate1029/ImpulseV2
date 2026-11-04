const { circuitBlock, circuitHash, circuitToolResult, normalizeCircuit } = require('../circuitFacts');

const RAW = {
  hasCircuit: true,
  board: 'uno',
  boardLabel: 'Arduino Uno',
  parts: ['LED led1', 'Resistor r1', 'Pushbutton btn1'],
  lines: ['D13 → LED led1:A', 'D2 → Pushbutton btn1:1.l', 'GND → Resistor r1:2, Pushbutton btn1:2.l'],
  checks: [{ level: 'warn', text: 'The button on pin 2 has no pull-up or pull-down resistor; use INPUT_PULLUP.' }],
  changedBy: 'user',
  updatedAt: '2026-10-18T14:02:00.000Z',
};

describe('circuitFacts', () => {
  it('bounds and cleans what the renderer sent', () => {
    const c = normalizeCircuit({ ...RAW, lines: Array.from({ length: 200 }, (_, i) => `D${i} → x`), parts: [1, 'ok'], checks: [{ level: 'error', text: 'short' }, { text: 'no level' }, 'junk'], changedBy: 'robot' });
    expect(c.lines).toHaveLength(80);
    expect(c.parts).toEqual(['ok']);
    expect(c.checks).toEqual([{ level: 'error', text: 'short' }, { level: 'warn', text: 'no level' }]);
    expect(c.changedBy).toBeNull();
    expect(typeof c.hash).toBe('string');
    expect(normalizeCircuit(null)).toBeNull();
  });

  it('hashes the wiring, not the time', () => {
    const a = normalizeCircuit(RAW);
    const b = normalizeCircuit({ ...RAW, updatedAt: '2027-01-01T00:00:00.000Z' });
    const c = normalizeCircuit({ ...RAW, lines: [...RAW.lines, 'D4 → Buzzer bz1:1'] });
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
    expect(circuitHash({ hasCircuit: false })).toBe('none');
  });

  it('writes the block with parts, pins, the check and who wired it', () => {
    const text = circuitBlock(normalizeCircuit(RAW));
    expect(text).toMatch(/^\[CIRCUIT\] On the simulator canvas, saved as diagram\.json next to the sketch, wired by the user at \d/);
    expect(text).toMatch(/Parts: LED led1, Resistor r1, Pushbutton btn1/);
    expect(text).toMatch(/D13 → LED led1:A/);
    expect(text).toMatch(/Wiring check: 1 problem:\n- The button on pin 2/);
    expect(text).not.toMatch(/CIRCUIT CHANGED/);
  });

  it('says when the circuit changed, and nothing when nothing is wired', () => {
    expect(circuitBlock(normalizeCircuit(RAW), { changed: true })).toMatch(/\[CIRCUIT CHANGED\] The circuit changed since earlier messages/);
    expect(circuitBlock(normalizeCircuit({ hasCircuit: false }))).toBeNull();
    expect(circuitBlock(null)).toBeNull();
    const ai = circuitBlock(normalizeCircuit({ ...RAW, changedBy: 'ai' }));
    expect(ai).toMatch(/placed by Impulse's circuit builder/);
  });

  it('keeps the block short for big circuits', () => {
    const big = normalizeCircuit({ ...RAW, lines: Array.from({ length: 50 }, (_, i) => `D${i} → Part p${i}:1`), checks: Array.from({ length: 9 }, (_, i) => ({ level: 'warn', text: `issue ${i}` })) });
    const text = circuitBlock(big);
    expect(text.split('\n').filter((l) => / → /.test(l))).toHaveLength(30);
    expect(text).toMatch(/… and 20 more pins/);
    expect(text).toMatch(/- … and 4 more/);
  });

  it('answers the tool with the full wiring, or with advice to draw it', () => {
    expect(circuitToolResult(normalizeCircuit(RAW))).toMatchObject({ hasCircuit: true, board: 'Arduino Uno', wiring: RAW.lines, changedBy: 'user' });
    expect(circuitToolResult(null)).toMatchObject({ hasCircuit: false });
    expect(circuitToolResult(null).note).toMatch(/draw it in the simulator/);
  });
});
