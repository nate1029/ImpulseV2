// Regression guards for the P0 structural fixes. These are source-parsing tests:
// they catch the shapes of the bugs we fixed, not the runtime behaviour, which
// the smoke and e2e suites exercise anyway.
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(p, 'utf8');
const mainJs = read(path.join(__dirname, '../main.js'));
const preloadJs = read(path.join(__dirname, '../preload.js'));
const rendererJs = read(path.join(__dirname, '../../renderer/renderer.js'));

const countMatches = (src, re) => (src.match(re) || []).length;

describe('P0.1: updater handlers register exactly once', () => {
  // Before the fix, the try path registered three handlers; a failure after
  // partial registration left the catch path registering three more, crashing
  // Electron with "Attempted to register a second handler for 'updater:…'".
  for (const channel of ['updater:check', 'updater:download', 'updater:install']) {
    it(`main.js registers '${channel}' exactly once`, () => {
      const re = new RegExp(`ipcMain\\.handle\\(['"\`]${channel}['"\`]`, 'g');
      expect(countMatches(mainJs, re)).toBe(1);
    });
  }

  it('updater handlers are outside the try/catch that builds the service', () => {
    // The three handles must sit after the catch block closes, so a throw
    // inside the try can never leave half-registered state behind.
    const tryStart = mainJs.indexOf('const AutoUpdaterService = require');
    const catchEnd = mainJs.indexOf('}', mainJs.indexOf('updaterService = null;', tryStart));
    const firstHandle = mainJs.indexOf("ipcMain.handle('updater:check'");
    expect(tryStart).toBeGreaterThan(-1);
    expect(catchEnd).toBeGreaterThan(-1);
    expect(firstHandle).toBeGreaterThan(catchEnd);
  });
});

describe('P0.2: no editor-code RPC round-trip', () => {
  // Before the fix, getEditorCode sent 'ui:get-editor-code', armed a listener on
  // 'ui:editor-code-response', and fell back to a cached buffer after 1 s. The
  // round-trip could feed the agent stale code under load; main.js's uiState
  // buffer (kept fresh by ui:update-editor-code pushes) is authoritative now.
  it('main.js never sends ui:get-editor-code (dead push channel)', () => {
    // Match the usage shape, not any occurrence (the comment above the fix
    // still names the channel for context).
    expect(mainJs).not.toMatch(/send\(\s*['"`]ui:get-editor-code['"`]/);
  });

  it('main.js never listens for ui:editor-code-response (dead reply channel)', () => {
    expect(mainJs).not.toMatch(/ipcMain\.(?:once|on|handle)\(\s*['"`]ui:editor-code-response['"`]/);
  });

  it('preload exposes no onGetEditorCode method', () => {
    expect(preloadJs).not.toMatch(/onGetEditorCode/);
  });

  it('renderer does not register a response handler for ui:get-editor-code', () => {
    expect(rendererJs).not.toMatch(/onGetEditorCode/);
  });

  it('renderer debounce window is <= 100ms (staleness floor the agent can see)', () => {
    const match = rendererJs.match(/scheduleEditorSync\s*=\s*debounce\([\s\S]*?\},\s*(\d+)\)/);
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBeLessThanOrEqual(100);
  });
});

describe('P0.2 fast-follow: editor rev-check guards lost updates', () => {
  // The agent's read-modify-write tools (edit_code, replace_in_code) can lose
  // a user keystroke that lands between the read and the write. The rev-check
  // closes that: setEditorCode rejects the write when expectedRev no longer
  // matches the current editor rev.
  const toolExecutorJs = read(path.join(__dirname, '../services/ai/tools/toolExecutor.js'));

  it('uiHandlers bumps editorRev on each real change', () => {
    const uiHandlers = read(path.join(__dirname, '../ipc/uiHandlers.js'));
    expect(uiHandlers).toMatch(/editorRev/);
    expect(uiHandlers).toMatch(/if \(changed\) uiState\.editorRev/);
  });

  it('setEditorCode in main.js refuses stale writes with STALE_EDITOR', () => {
    expect(mainJs).toMatch(/STALE_EDITOR/);
    expect(mainJs).toMatch(/expectedRev[\s\S]*?!==\s*\(uiState\.editorRev/);
  });

  it('main.js exposes getEditorRev UI callback alongside getEditorCode', () => {
    expect(mainJs).toMatch(/getEditorRev\s*:/);
  });

  it('executeEditCode captures expectedRev at read time and passes it to the write', () => {
    expect(toolExecutorJs).toMatch(/const expectedRev[\s\S]*?getEditorRev/);
    expect(toolExecutorJs).toMatch(/setEditorCode\([^,]+,\s*expectedRev != null \? \{ expectedRev \}/);
  });

  it('tool returns STALE_EDITOR on reject so the agent re-reads and retries', () => {
    expect(toolExecutorJs).toMatch(/code:\s*'STALE_EDITOR'/);
  });
});
