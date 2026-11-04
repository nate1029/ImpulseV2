import { codeBlocksOf, isSketchShaped, sketchBlockFrom } from '../answer-code.js';

const SKETCH = 'void setup() {\n  pinMode(13, OUTPUT);\n}\n\nvoid loop() {\n  digitalWrite(13, HIGH);\n}';

describe('answer-code', () => {
  it('reads fenced blocks with their language', () => {
    const blocks = codeBlocksOf('Here:\n\n```cpp\nint a;\n```\n\nand\n\n~~~\nint b;\n~~~\n');
    expect(blocks).toEqual([{ lang: 'cpp', code: 'int a;' }, { lang: '', code: 'int b;' }]);
  });

  it('tells a whole sketch from a snippet', () => {
    expect(isSketchShaped(SKETCH)).toBe(true);
    expect(isSketchShaped('void setup(void) {}\nvoid loop(void) {}')).toBe(true);
    expect(isSketchShaped('digitalWrite(13, HIGH);')).toBe(false);
    expect(isSketchShaped('void setup() {}')).toBe(false);
  });

  it('returns the one sketch block of an answer', () => {
    const text = `I wrote the blink sketch:\n\n\`\`\`arduino\n${SKETCH}\n\`\`\`\n\nChange the delay here:\n\n\`\`\`cpp\ndelay(500);\n\`\`\`\n`;
    expect(sketchBlockFrom(text)).toEqual({ lang: 'arduino', code: SKETCH });
  });

  it('refuses when there is no sketch or more than one', () => {
    expect(sketchBlockFrom('Use `digitalWrite` here.\n\n```cpp\ndelay(10);\n```')).toBeNull();
    expect(sketchBlockFrom(`\`\`\`cpp\n${SKETCH}\n\`\`\`\n\nOr:\n\n\`\`\`cpp\n${SKETCH.replace('13', '12')}\n\`\`\``)).toBeNull();
    expect(sketchBlockFrom('')).toBeNull();
  });

  it('is not fooled by a fence inside a line', () => {
    expect(codeBlocksOf('text ```not a block``` more')).toEqual([]);
  });
});
