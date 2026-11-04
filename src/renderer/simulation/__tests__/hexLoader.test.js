import { parseHex } from '../hex-loader.js';
import { wordsToHex, TOGGLE_D13 } from './helpers.js';

describe('parseHex', () => {
  it('loads instruction words at their addresses', () => {
    const prog = parseHex(wordsToHex(TOGGLE_D13));
    expect(Array.from(prog.slice(0, 4))).toEqual(TOGGLE_D13);
    expect(prog.length).toBe(16 * 1024);
  });

  it('ignores blank lines, comments and stops at EOF', () => {
    const hex = `\n; comment\n${wordsToHex([0x1234])}\n:020000000000FE`;
    const prog = parseHex(hex);
    expect(prog[0]).toBe(0x1234);
    expect(prog[1]).toBe(0);
  });
});
