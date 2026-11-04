const path = require('path');
const os = require('os');
const fs = require('fs');
const { DocsService, allowed, htmlToText, excerpt } = require('../docs');

const PAGE = `<html><head><title>GPIO &amp; RTC GPIO &mdash; ESP32-C3</title></head>
<body><nav>skip me</nav><script>bad()</script>
<h1>GPIO</h1><p>The ESP32-C3 has 22 GPIO pins.</p>
<table><tr><th>Pin</th><th>Use</th></tr><tr><td>GPIO8</td><td>Strapping</td></tr></table>
<footer>also skip</footer></body></html>`;

function service({ body = PAGE, status = 200, type = 'text/html', fail = null } = {}) {
  const calls = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-docs-'));
  const fetchImpl = jest.fn(async (url) => {
    calls.push(url);
    if (fail) throw new Error(fail);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? type : null) },
      arrayBuffer: async () => Buffer.from(body),
    };
  });
  return { docs: new DocsService({ cacheDir: dir, fetch: fetchImpl }), calls, dir, fetchImpl };
}

describe('what may be read', () => {
  it('allows documentation sites over https and nothing else', () => {
    expect(allowed('https://docs.arduino.cc/hardware/uno-rev3/')).toBe(true);
    expect(allowed('https://docs.espressif.com/x')).toBe(true);
    expect(allowed('http://docs.arduino.cc/x')).toBe(false);
    expect(allowed('https://example.com/x')).toBe(false);
    expect(allowed('file:///etc/passwd')).toBe(false);
    expect(allowed('not a url')).toBe(false);
  });

  it('refuses a page outside the list without fetching it', async () => {
    const { docs, fetchImpl } = service();
    const res = await docs.read('https://evil.example.com/pins');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/only reads documentation sites/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('turning a page into text', () => {
  it('drops scripts, nav and footers and keeps tables readable', () => {
    const text = htmlToText(PAGE);
    expect(text).toMatch(/The ESP32-C3 has 22 GPIO pins\./);
    expect(text).toMatch(/GPIO8 \| Strapping/);
    expect(text).not.toMatch(/bad\(\)/);
    expect(text).not.toMatch(/skip me|also skip/);
    expect(text).toMatch(/GPIO & RTC GPIO/); // entities decoded
  });

  it('cuts long pages around what was asked about', () => {
    const body = `${'filler '.repeat(400)}THE ANSWER IS HERE${' more'.repeat(400)}`;
    const hit = excerpt(body, { focus: 'the answer', max: 200 });
    expect(hit.truncated).toBe(true);
    expect(hit.text).toMatch(/THE ANSWER IS HERE/);
    expect(excerpt('short', { max: 200 })).toEqual({ text: 'short', truncated: false });
  });
});

describe('reading', () => {
  it('reads a page, decodes its title and caches it', async () => {
    const { docs, calls } = service();
    const first = await docs.read('https://docs.espressif.com/x/gpio.html', { focus: 'GPIO8' });
    expect(first).toMatchObject({ ok: true, cached: false, title: 'GPIO & RTC GPIO — ESP32-C3' });
    expect(first.text).toMatch(/GPIO8 \| Strapping/);
    const second = await docs.read('https://docs.espressif.com/x/gpio.html');
    expect(second.cached).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('says what went wrong instead of throwing', async () => {
    const down = service({ fail: 'network down' });
    expect((await down.docs.read('https://docs.arduino.cc/a')).error).toMatch(/Could not reach docs\.arduino\.cc.*network down/);
    const missing = service({ status: 404 });
    expect((await missing.docs.read('https://docs.arduino.cc/b')).error).toMatch(/answered 404/);
    const pdf = service({ type: 'application/pdf' });
    expect((await pdf.docs.read('https://datasheets.raspberrypi.com/c.pdf')).error).toMatch(/PDF/);
    const empty = service({ body: '<html><body></body></html>' });
    expect((await empty.docs.read('https://docs.arduino.cc/d')).error).toMatch(/no text/);
  });

  it('lists the pages it knows for a board and its chip', async () => {
    const { docs } = service();
    const pages = docs.listFor({ catalogId: 'xiao-esp32c3', family: 'esp32-c3', boardName: 'XIAO ESP32-C3' });
    expect(pages[0]).toMatchObject({ scope: 'board', url: expect.stringContaining('seeedstudio.com') });
    expect(pages.some((p) => p.scope === 'chip' && /espressif\.com/.test(p.url))).toBe(true);
    expect(docs.listFor({ family: 'nope' })).toEqual([]);
  });
});
