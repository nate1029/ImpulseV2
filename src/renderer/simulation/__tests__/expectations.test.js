import { parseExpectations, evaluateExpectations, parsePinRef } from '../expectations.js';

const run = {
  serial: 'ready\ntemp=23\n',
  trace: [0, 0.5, 1, 1.5, 2, 2.5].map((t, i) => ({ pin: 13, high: i % 2 === 0, t })),
  finalStates: Object.assign(new Array(20).fill(false), { 9: true })
};

describe('parsePinRef', () => {
  it.each([['13', 13], ['D7', 7], ['A0', 14], ['a5', 19], ['LED_BUILTIN', 13], ['A9', null], ['42', null], ['x', null]])(
    '%s → %s', (ref, pin) => expect(parsePinRef(ref)).toBe(pin)
  );
});

describe('parseExpectations', () => {
  it('reads expectations and run length from comments', () => {
    const { seconds, items, errors } = parseExpectations([
      'void setup() {}',
      '// @run 5s',
      '// @expect serial contains "ready"',
      '  // @expect pin LED_BUILTIN frequency 1Hz ±5%',
      '// @expect pin 9 high',
      '// @expect bogus thing'
    ].join('\n'));
    expect(seconds).toBe(5);
    expect(items.map(i => i.kind)).toEqual(['serial-contains', 'pin-frequency', 'pin-high']);
    expect(items[1]).toMatchObject({ pin: 13, hz: 1, tolerance: 0.05, line: 4 });
    expect(errors).toEqual([{ line: 6, message: 'Unrecognised expectation: "bogus thing"' }]);
  });

  it('caps the run length and accepts milliseconds', () => {
    expect(parseExpectations('// @run 500ms').seconds).toBe(0.5);
    expect(parseExpectations('// @run 999s').seconds).toBe(30);
  });

  it('reports invalid regular expressions', () => {
    expect(parseExpectations('// @expect serial matches /(/').errors[0].message).toContain('Invalid regular expression');
  });
});

describe('evaluateExpectations', () => {
  const check = (line) => evaluateExpectations(parseExpectations(line).items, run)[0];

  it('checks serial text and patterns', () => {
    expect(check('// @expect serial contains "ready"').pass).toBe(true);
    expect(check('// @expect serial contains "error"').pass).toBe(false);
    expect(check('// @expect serial matches /temp=\\d+/').pass).toBe(true);
    expect(check('// @expect no serial').pass).toBe(false);
  });

  it('checks pin toggling, final level and frequency', () => {
    expect(check('// @expect pin 13 toggles').pass).toBe(true);
    expect(check('// @expect pin 12 toggles').pass).toBe(false);
    expect(check('// @expect pin 9 high').pass).toBe(true);
    expect(check('// @expect pin 9 low').pass).toBe(false);
    const freq = check('// @expect pin 13 frequency 1Hz');
    expect(freq.pass).toBe(true);
    expect(freq.detail).toBe('measured 1.00 Hz');
    expect(check('// @expect pin 13 frequency 2Hz').pass).toBe(false);
  });
});
