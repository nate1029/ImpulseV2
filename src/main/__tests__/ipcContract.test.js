// The preload bridge and the main-process handlers must agree: a renderer call
// with no handler fails at runtime ("No handler registered"), and a handler the
// preload doesn't expose is dead surface.
const fs = require('fs');
const path = require('path');

const mainDir = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(p, 'utf8');

function mainSources(dir = mainDir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : mainSources(full);
    return entry.name.endsWith('.js') && entry.name !== 'preload.js' ? [read(full)] : [];
  });
}

const preload = read(path.join(mainDir, 'preload.js'));
const sources = mainSources().join('\n');
const channels = (src, re) => new Set([...src.matchAll(re)].map((m) => m[1]));

const invoked = channels(preload, /ipcRenderer\.(?:invoke|send)\(\s*'([^']+)'/g);
const listened = channels(preload, /ipcRenderer\.on\(\s*'([^']+)'/g);
const handled = channels(sources, /ipcMain\.(?:handle|on|once|handleOnce)\(\s*'([^']+)'/g);

describe('IPC contract', () => {
  it('every channel the renderer calls has a main-process handler', () => {
    expect([...invoked].filter((c) => !handled.has(c))).toEqual([]);
  });

  it('every main-process handler is reachable from the preload', () => {
    expect([...handled].filter((c) => !invoked.has(c))).toEqual([]);
  });

  it('every channel the renderer listens to is sent by the main process', () => {
    const sentAnywhere = (c) => sources.includes(`'${c}'`) || sources.includes(`\`${c}\``)
      || (c.startsWith('updater:') && sources.includes("'updater:"));
    expect([...listened].filter((c) => !sentAnywhere(c))).toEqual([]);
  });

  it('the generic notification listener only accepts notification channels', () => {
    expect(preload).toMatch(/channel\.startsWith\('notification:'\)/);
  });
});
