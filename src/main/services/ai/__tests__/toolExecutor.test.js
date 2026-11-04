const ToolExecutor = require('../tools/toolExecutor');

function makeExecutor({ confirm = true, uploadResult = { success: true, output: 'ok' } } = {}) {
  const arduinoService = {
    upload: jest.fn().mockResolvedValue(uploadResult),
    compile: jest.fn().mockResolvedValue({ success: false, error: { message: 'Arduino CLI is not available' } }),
  };
  const serialMonitor = { isConnected: false, disconnect: jest.fn() };
  const executor = new ToolExecutor(arduinoService, serialMonitor, {}, null);
  const confirmUpload = jest.fn().mockResolvedValue(confirm);
  executor.setUICallbacks({
    getCurrentSketchPath: async () => '/projects/blink/blink.ino',
    getSelectedBoard: async () => 'arduino:avr:uno',
    getSelectedPort: async () => '/dev/cu.usbmodem1',
    saveSketch: jest.fn().mockResolvedValue('/projects/blink/blink.ino'),
    confirmUpload,
  });
  return { executor, arduinoService, confirmUpload };
}

describe('ToolExecutor', () => {
  it('rejects unknown tools and arguments of the wrong type', async () => {
    const { executor } = makeExecutor();
    expect((await executor.execute({ name: 'rm_rf', arguments: {} })).success).toBe(false);
    const bad = await executor.execute({ name: 'serial', arguments: { action: 'set_baud', baudRate: 'fast' } });
    expect(bad.success).toBe(false);
    expect(bad.error).toContain('baudRate');
  });

  it('rejects non-object arguments', async () => {
    const { executor } = makeExecutor();
    const res = await executor.execute({ name: 'list_ports', arguments: 'oops' });
    expect(res.success).toBe(false);
  });

  it('asks the user before an agent upload and stops when declined', async () => {
    const { executor, arduinoService, confirmUpload } = makeExecutor({ confirm: false });
    const res = await executor.execute({ name: 'upload_sketch', arguments: {} });
    expect(confirmUpload).toHaveBeenCalledWith({
      sketchPath: '/projects/blink/blink.ino', boardFQBN: 'arduino:avr:uno', port: '/dev/cu.usbmodem1'
    });
    expect(arduinoService.upload).not.toHaveBeenCalled();
    expect(res.success).toBe(false);
    expect(res.code).toBe('DECLINED');
    expect(res.error).toMatch(/did not allow the upload/);
  });

  it('uploads after the user approves', async () => {
    const { executor, arduinoService } = makeExecutor({ confirm: true });
    const res = await executor.execute({ name: 'upload_sketch', arguments: {} });
    expect(arduinoService.upload).toHaveBeenCalledTimes(1);
    expect(res.success).toBe(true);
  });

  it('reports a failed compile as a failure, not a success', async () => {
    const { executor } = makeExecutor();
    const res = await executor.execute({ name: 'compile_sketch', arguments: {} });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Arduino CLI is not available');
  });
});

describe('fixes the error decoder can make by itself', () => {
  const executorWith = (code, fqbn) => {
    const executor = new ToolExecutor({}, {}, {}, null);
    const written = [];
    executor.uiCallbacks = {
      getSelectedBoard: async () => fqbn,
      getEditorCode: async () => code,
      setEditorCode: async (next) => { written.push(next); },
    };
    return { executor, written };
  };

  test('core 2 LEDC on ESP32 core 3 is rewritten in the editor', async () => {
    const { executor, written } = executorWith('void setup() {\n  ledcSetup(0, 5000, 8);\n  ledcAttachPin(4, 0);\n  ledcWrite(0, 128);\n}\nvoid loop() {}\n', 'esp32:esp32:esp32');
    const check = { success: false, code: 'CODE_ERROR', diagnostics: [{ file: '/s/s.ino', line: 2, col: 3, level: 'error', message: "'ledcSetup' was not declared in this scope" }] };
    expect(await executor.applyKnownRewrite(check)).toEqual({ applied: ['esp32-ledc-core3'] });
    expect(written).toEqual(['void setup() {\n  ledcAttach(4, 5000, 8);\n  ledcWrite(4, 128);\n}\nvoid loop() {}\n']);
  });

  test('nothing to fix, a passing build or no editor: nothing is written', async () => {
    const { executor, written } = executorWith('void setup() {}\nvoid loop() {}\n', 'arduino:avr:uno');
    expect(await executor.applyKnownRewrite({ success: false, diagnostics: [{ file: 's.ino', line: 1, level: 'error', message: "call of overloaded 'f(int)' is ambiguous" }] })).toBeNull();
    expect(await executor.applyKnownRewrite({ success: true })).toBeNull();
    expect(written).toEqual([]);
    expect(await new ToolExecutor({}, {}, {}, null).applyKnownRewrite({ success: false })).toBeNull();
  });
});
