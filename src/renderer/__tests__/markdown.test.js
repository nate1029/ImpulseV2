import { renderMarkdown, inline } from '../markdown.js';

describe('markdown for AI answers', () => {
  it('escapes HTML everywhere, so an answer cannot add markup', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)> & <b>hi</b>')).toBe('<p>&lt;img src=x onerror=alert(1)&gt; &amp; &lt;b&gt;hi&lt;/b&gt;</p>');
    expect(renderMarkdown('`<script>`')).toBe('<p><code>&lt;script&gt;</code></p>');
    expect(renderMarkdown('# <i>x</i>')).toBe('<h3>&lt;i&gt;x&lt;/i&gt;</h3>');
  });

  it('keeps line breaks inside a paragraph and splits paragraphs on blank lines', () => {
    expect(renderMarkdown('D2 → LED +\nGND → LED −\n\nThen upload.')).toBe('<p>D2 → LED +<br>GND → LED −</p><p>Then upload.</p>');
  });

  it('renders headings a few sizes down (answers sit inside a chat)', () => {
    expect(renderMarkdown('## Wiring ##')).toBe('<h4>Wiring</h4>');
    expect(renderMarkdown('#include <Servo.h>')).toBe('<p>#include &lt;Servo.h&gt;</p>');
  });

  it('renders bullet, numbered and nested lists', () => {
    expect(renderMarkdown('- Arduino Uno\n- 220 Ω resistor')).toBe('<ul><li>Arduino Uno</li><li>220 Ω resistor</li></ul>');
    expect(renderMarkdown('3. Wire it\n4. Upload')).toBe('<ol start="3"><li>Wire it</li><li>Upload</li></ol>');
    expect(renderMarkdown('1. Parts\n   - LED\n   - Resistor\n2. Code')).toBe('<ol><li>Parts<ul><li>LED</li><li>Resistor</li></ul></li><li>Code</li></ol>');
  });

  it('renders tables with a header row', () => {
    const html = renderMarkdown('| Pin | Part |\n|---|:--:|\n| D9 | LED |\n| A0 | Pot `wiper` |');
    expect(html).toBe('<div class="md-table"><table><thead><tr><th>Pin</th><th>Part</th></tr></thead><tbody><tr><td>D9</td><td>LED</td></tr><tr><td>A0</td><td>Pot <code>wiper</code></td></tr></tbody></table></div>');
  });

  it('turns fenced code into a code block with Copy and Insert, untouched inside', () => {
    const html = renderMarkdown('Here:\n```cpp\nint x = a * b * c; // **not bold**\n```\nDone.');
    expect(html).toContain('<span class="code-lang">cpp</span>');
    expect(html).toContain('<pre><code class="language-cpp">int x = a * b * c; // **not bold**</code></pre>');
    expect(html.startsWith('<p>Here:</p><div class="code-block-wrapper">')).toBe(true);
    expect(html.endsWith('</div><p>Done.</p>')).toBe(true);
  });

  it('keeps an unclosed fence as code to the end', () => {
    expect(renderMarkdown('```\nvoid loop() {}')).toContain('<code class="language-text">void loop() {}</code>');
  });

  it('formats inline text without touching identifiers or code', () => {
    expect(inline('**Bold** and *italic* and ~~gone~~')).toBe('<strong>Bold</strong> and <em>italic</em> and <del>gone</del>');
    expect(inline('LED_BUILTIN and pin_mode stay as they are')).toBe('LED_BUILTIN and pin_mode stay as they are');
    expect(inline('int *ptr and *p')).toBe('int *ptr and *p');
    expect(inline('`**x**`')).toBe('<code>**x**</code>');
  });

  it('links only http(s) URLs, opening in the browser', () => {
    expect(inline('[docs](https://docs.arduino.cc/x)')).toBe('<a href="https://docs.arduino.cc/x" target="_blank" rel="noopener noreferrer">docs</a>');
    expect(inline('See https://example.com/a.')).toBe('See <a href="https://example.com/a" target="_blank" rel="noopener noreferrer">https://example.com/a</a>.');
    expect(inline('[x](javascript:alert(1))')).toBe('[x](javascript:alert(1))');
    expect(inline('[x](https://a.b/"onmouseover=")')).not.toContain('"onmouseover');
  });

  it('renders quotes and rules', () => {
    expect(renderMarkdown('> Check the polarity\n> first')).toBe('<blockquote>Check the polarity<br>first</blockquote>');
    expect(renderMarkdown('Above\n---\nBelow')).toBe('<p>Above</p><hr><p>Below</p>');
  });

  it('handles empty and missing text', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown(null)).toBe('');
  });
});
