import { detectBaud, toLines, diffSerial } from '../compare.js';

describe('detectBaud', () => {
  it('reads the first Serial.begin rate', () => {
    expect(detectBaud('void setup(){ Serial.begin(115200); }')).toBe(115200);
    expect(detectBaud('Serial.begin( 9600 , SERIAL_8N1);')).toBe(9600);
    expect(detectBaud('void setup(){}')).toBe(9600);
  });
});

describe('toLines', () => {
  it('normalises CRLF and drops the trailing empty line', () => {
    expect(toLines('a\r\nb\r\n')).toEqual(['a', 'b']);
  });
});

describe('diffSerial', () => {
  it('matches identical output', () => {
    const d = diffSerial('on\noff\non\n', 'on\r\noff\r\non\r\n');
    expect(d).toMatchObject({ same: 3, values: 0, simOnly: 0, boardOnly: 0 });
  });

  it('treats lines that differ only in numbers as value differences', () => {
    const d = diffSerial('temp=21.5\nt=1000\n', 'temp=23.0\nt=1004\n');
    expect(d).toMatchObject({ same: 0, values: 2, simOnly: 0, boardOnly: 0 });
  });

  it('finds lines missing on either side', () => {
    const d = diffSerial('boot\nsensor ok\nready\n', 'boot\nsensor missing!\nready\n');
    expect(d.rows.map(r => r.type)).toEqual(['same', 'sim-only', 'board-only', 'same']);
    expect(d).toMatchObject({ same: 2, simOnly: 1, boardOnly: 1 });
  });

  it('handles empty output', () => {
    expect(diffSerial('', '').rows).toEqual([]);
    expect(diffSerial('x\n', '').simOnly).toBe(1);
  });
});
