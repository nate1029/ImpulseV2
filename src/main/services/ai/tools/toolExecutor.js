const { proofLine, docsProof, fixProof } = require('../knowledge/proof');
const { lint, lintReport, autofix } = require('../knowledge/linter');
const { rewrite: rewriteErrors } = require('../knowledge/errorDecoder');
const { validateToolCall } = require('./toolSchema');
const { boundedOutput } = require('./retain');
const { circuitToolResult } = require('../knowledge/circuitFacts');
const { checkSketchPins, pinReport } = require('../knowledge/pinCheck');
const BoardKnowledge = require('../knowledge/boardKnowledge');
const { findComponents, componentText, familyKey, COMPONENTS } = require('../knowledge/components');

/**
 * Tool Executor
 * Executes structured tool instructions from the AI Agent
 * Routes to appropriate service handlers
 */
class ToolExecutor {
  constructor(arduinoService, serialMonitor, errorMemory, aiMemory) {
    this.arduinoService = arduinoService;
    this.serialMonitor = serialMonitor;
    this.errorMemory = errorMemory;
    this.aiMemory = aiMemory;

    // UI state callbacks - set by the main process
    this.uiCallbacks = null;

    // What the agent knows about boards, chips and components (read from the installed cores).
    this.boardKnowledge = arduinoService && typeof arduinoService.runCommand === 'function'
      ? new BoardKnowledge((args, opts) => arduinoService.runCommand(args, opts))
      : null;

    // Available baud rates
    this.availableBaudRates = [
      300, 1200, 2400, 4800, 9600, 19200, 38400,
      57600, 74880, 115200, 230400, 250000, 500000, 1000000, 2000000
    ];
  }

  /**
   * Set UI callbacks for interacting with the renderer
   */
  setUICallbacks(callbacks) {
    this.uiCallbacks = callbacks;
  }

  /**
   * Execute a tool call
   * @param {Object} toolCall - Structured tool instruction from agent
   * @returns {Promise<Object>} Execution result
   */
  async execute(toolCall) {
    // Validate tool call structure
    const validation = validateToolCall(toolCall);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error,
        tool: toolCall.name
      };
    }

    try {
      let result;

      switch (toolCall.name) {
        // Arduino Operations
        case 'compile_sketch':
          result = await this.executeCompile(toolCall.arguments);
          break;
        case 'upload_sketch':
          result = await this.executeUpload(toolCall.arguments);
          break;
        case 'list_boards':
          result = await this.executeListBoards();
          break;
        case 'list_ports':
          result = await this.executeListPorts();
          break;

        // Serial Monitor Operations
        case 'connect_serial':
          result = await this.executeConnectSerial(toolCall.arguments);
          break;
        case 'disconnect_serial':
          result = await this.executeDisconnectSerial();
          break;
        case 'send_serial':
          result = await this.executeSendSerial(toolCall.arguments);
          break;
        case 'read_serial':
          result = await this.executeReadSerial(toolCall.arguments);
          break;
        case 'auto_detect_baud':
          result = await this.executeAutoDetectBaud(toolCall.arguments);
          break;

        // Baud Rate Operations
        case 'get_baud_rate':
          result = await this.executeGetBaudRate();
          break;
        case 'set_baud_rate':
          result = await this.executeSetBaudRate(toolCall.arguments);
          break;
        case 'get_available_baud_rates':
          result = this.executeGetAvailableBaudRates();
          break;

        // Code Editor Operations
        case 'get_editor_code':
          result = await this.executeGetEditorCode();
          break;
        case 'set_editor_code':
          result = await this.executeSetEditorCode(toolCall.arguments);
          break;
        case 'edit_code':
          result = await this.executeEditCode(toolCall.arguments);
          break;
        case 'search_code':
          result = await this.executeSearchCode(toolCall.arguments);
          break;
        case 'replace_in_code':
          result = await this.executeReplaceInCode(toolCall.arguments);
          break;
        case 'get_current_sketch_path':
          result = await this.executeGetCurrentSketchPath();
          break;
        case 'save_sketch':
          result = await this.executeSaveSketch(toolCall.arguments);
          break;

        // Analysis Operations
        case 'analyze_error':
          result = await this.executeAnalyzeError(toolCall.arguments);
          break;
        case 'search_memory':
          result = await this.executeSearchMemory(toolCall.arguments);
          break;
        case 'record_fix':
          result = await this.executeRecordFix(toolCall.arguments);
          break;

        // Board and hardware knowledge
        case 'get_board_info':
          result = await this.executeGetBoardInfo(toolCall.arguments);
          break;
        case 'get_mcu_guide':
          result = await this.executeGetMcuGuide(toolCall.arguments);
          break;
        case 'get_component_guide':
          result = await this.executeGetComponentGuide(toolCall.arguments);
          break;
        case 'search_boards':
          result = await this.executeSearchBoards(toolCall.arguments);
          break;

        // State Operations
        case 'read_docs':
          result = await this.executeReadDocs(toolCall.arguments || {});
          break;
        case 'libraries':
          result = await this.executeLibraries(toolCall.arguments || {});
          break;
        case 'serial':
          result = await this.executeSerial(toolCall.arguments || {});
          break;
        case 'load_tools':
          result = { success: false, error: 'load_tools is handled by the agent loop; call it again from the model.' };
          break;
        case 'get_circuit':
          result = circuitToolResult(this.uiCallbacks?.getCircuit ? await this.uiCallbacks.getCircuit() : null);
          break;
        case 'get_current_state':
          result = await this.executeGetCurrentState();
          break;

        // Playground Operations
        case 'update_playground':
          result = await this.executeUpdatePlayground(toolCall.arguments);
          break;

        default:
          return {
            success: false,
            error: `Unknown tool: ${toolCall.name}`,
            tool: toolCall.name
          };
      }

      // Record execution in memory (matches aiMemory.recordExecution(toolCall, result) signature)
      if (this.aiMemory && this.aiMemory.recordExecution) {
        await this.aiMemory.recordExecution(
          { name: toolCall.name, arguments: toolCall.arguments },
          { success: result.success !== false, error: result.error, executionTime: result.executionTime }
        );
      }

      const ok = !(result && typeof result === 'object' && result.success === false);
      // The tool's own fields (code, summary, diagnostics, knownFixes…) travel
      // on the envelope as well as inside `result`: the agent loop reads them
      // there, and burying them made the verify guard blind to a BUSY build.
      const own = result && typeof result === 'object' ? { ...result } : {};
      delete own.success;
      delete own.tool;
      return ok
        ? { success: true, tool: toolCall.name, ...own, result }
        : { success: false, tool: toolCall.name, ...own, error: result.error || 'Tool failed', result };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        tool: toolCall.name
      };
    }
  }

  // Arduino Operation Implementations
  async executeCompile(args = {}) {
    // Resolve from args or UI state when user says "compile" without parameters
    let sketchPath = (args.sketchPath || '').trim();
    let boardFQBN = (args.boardFQBN || '').trim();
    if (this.uiCallbacks) {
      if (!sketchPath && this.uiCallbacks.getCurrentSketchPath) {
        sketchPath = (await this.uiCallbacks.getCurrentSketchPath()) || '';
      }
      if (!boardFQBN && this.uiCallbacks.getSelectedBoard) {
        boardFQBN = (await this.uiCallbacks.getSelectedBoard()) || '';
      }
    }
    if (!sketchPath) {
      return { success: false, error: 'No sketch open. Please open a .ino file first (Open Sketch in the sidebar).' };
    }
    if (!boardFQBN) {
      return { success: false, error: 'No board is chosen. Ask the user to click Choose a board at the top of the window, or pass the board FQBN.' };
    }
    // Save editor content to disk before compiling
    if (this.uiCallbacks && this.uiCallbacks.saveSketch) {
      await this.uiCallbacks.saveSketch(sketchPath);
    }
    try {
      const compileResult = await this.arduinoService.compile(sketchPath, boardFQBN);
      if (compileResult && compileResult.success === false) return this._withKnownFixes(buildFailure(compileResult, 'compile'), compileResult, 'compile', boardFQBN);
      return {
        success: true,
        message: compileResult.message,
        summary: compileResult.summary || [],
        memory: compileResult.memory || null,
        warnings: (compileResult.warnings || []).slice(0, 10),
        diagnostics: (compileResult.diagnostics || []).slice(0, 20),
        installedLibraries: compileResult.installedLibraries || [],
        pinIssues: compileResult.pinIssues || [],
        pinReport: compileResult.pinReport || null,
        // What compiles but fails on the bench (Impulse's hardware linter).
        ...(compileResult.lint?.length ? { lint: compileResult.lint.slice(0, 8).map((f) => ({ level: f.level, line: f.line, problem: f.message, fix: f.fix })) } : {}),
        output: boundedOutput(compileResult.output || '', 1200),
      };
    } catch (err) {
      return { success: false, error: err.message, output: boundedOutput(err.output || err.stdout || err.stderr || '', 1500) };
    }
  }

  async executeUpload(args = {}) {
    // Resolve from args or UI state
    let sketchPath = (args.sketchPath || '').trim();
    let boardFQBN = (args.boardFQBN || '').trim();
    let port = (args.port || '').trim();
    if (this.uiCallbacks) {
      if (!sketchPath && this.uiCallbacks.getCurrentSketchPath) {
        sketchPath = (await this.uiCallbacks.getCurrentSketchPath()) || '';
      }
      if (!boardFQBN && this.uiCallbacks.getSelectedBoard) {
        boardFQBN = (await this.uiCallbacks.getSelectedBoard()) || '';
      }
      if (!port && this.uiCallbacks.getSelectedPort) {
        port = (await this.uiCallbacks.getSelectedPort()) || '';
      }
    }
    if (!sketchPath) {
      return { success: false, error: 'No sketch open. Please open a .ino file first (Open Sketch in the sidebar).' };
    }
    if (!boardFQBN) {
      return { success: false, error: 'No board is chosen. Ask the user to click Choose a board at the top of the window, or pass the board FQBN.' };
    }
    if (!port) {
      return {
        success: false,
        code: 'NO_PORT',
        error: 'No port is selected, so there is nothing to upload to. Tell the user to plug the board in and pick its port from the board chip; the simulator can run the sketch meanwhile.',
      };
    }
    // Uploading drives real hardware: the user approves every agent upload.
    if (!this.uiCallbacks || !this.uiCallbacks.confirmUpload) {
      return { success: false, error: 'Upload needs user confirmation, which is unavailable right now.' };
    }
    const approved = await this.uiCallbacks.confirmUpload({ sketchPath, boardFQBN, port });
    if (!approved) {
      return { success: false, code: 'DECLINED', error: 'The user did not allow the upload. Do not retry unless they ask again.' };
    }
    // The port is freed and reopened by the upload itself (arduinoService).
    // Save editor content before uploading
    if (this.uiCallbacks && this.uiCallbacks.saveSketch) {
      await this.uiCallbacks.saveSketch(sketchPath);
    }
    try {
      const uploadResult = await this.arduinoService.upload(sketchPath, boardFQBN, port);
      if (uploadResult && uploadResult.success === false) return this._withKnownFixes(buildFailure(uploadResult, 'upload'), uploadResult, 'upload', boardFQBN);
      return {
        success: true,
        message: uploadResult.message || `Uploaded to ${port}`,
        port: uploadResult.port ?? port,
        boardFQBN,
        summary: uploadResult.summary || [],
        memory: uploadResult.memory || null,
        output: boundedOutput(uploadResult.output || '', 1200),
      };
    } catch (err) {
      return { success: false, error: err.message, output: boundedOutput(err.output || err.stdout || err.stderr || '', 1500) };
    }
  }

  /**
   * Fixes that resolved this same error before (this computer's, then other
   * people's through Impulse Cloud) join a failed build's result, so the model
   * applies what worked instead of guessing. Never slows a failure by more
   * than a couple of seconds.
   */
  async _withKnownFixes(failure, result, kind, boardFQBN) {
    if (failure.code === 'BUSY' || !this.uiCallbacks?.knownFixes) return failure;
    try {
      const known = await Promise.race([
        this.uiCallbacks.knownFixes({ output: result.output || result.excerpt || '', kind, failureCode: result.code || '', board: String(boardFQBN || '').split(':').slice(0, 3).join(':') }),
        new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
      ]);
      if (known && (known.local?.length || known.shared?.length)) {
        failure.knownFixes = known;
        const worked = (known.local?.length || 0) + (known.shared || []).reduce((n, f) => n + (Number(f.count) || 1), 0);
        failure.knownFixesProof = proofLine(fixProof(worked, known.shared?.length ? 'shared' : 'local'));
        failure.note = `${failure.note ? `${failure.note} ` : ''}This error was seen before: knownFixes lists what fixed it (local = on this computer, shared = other Impulse users). Apply the matching fix before trying anything else.`;
      }
    } catch { /* known fixes are a bonus */ }
    return failure;
  }

  /**
   * The pins the open sketch uses, checked against the selected board: a pin
   * the chip does not have, a flash pin, an input-only pin driven as an
   * output, a pin the board already uses. Deterministic, so the harness can
   * correct the model with it.
   * @returns {Promise<{ issues: object[], report: string|null, board: string }>}
   */
  async checkPins(code = null) {
    if (!this.boardKnowledge) return { issues: [], report: null, board: '' };
    const fqbn = await this.selectedFqbn().catch(() => '');
    if (!fqbn) return { issues: [], report: null, board: '' };
    const sketch = code ?? (this.uiCallbacks?.getEditorCode ? await this.uiCallbacks.getEditorCode() : '');
    if (!sketch) return { issues: [], report: null, board: '' };
    const info = await this.boardKnowledge.boardInfo(fqbn).catch(() => null);
    if (!info) return { issues: [], report: null, board: '' };
    const taken = info.pinsTaken || [];
    const issues = checkSketchPins(sketch, info, { taken, boardName: `the ${info.name}` });
    return { issues, report: pinReport(issues, { boardName: `the ${info.name}` }), board: info.name };
  }

  /**
   * The hardware linter on the open sketch, with the selected board's facts
   * (core version, LED_BUILTIN, USB CDC). Never throws: no board or no sketch
   * means no findings.
   */
  async lintSketch(code = null, { built = false } = {}) {
    try {
      const fqbn = await this.selectedFqbn().catch(() => '');
      const sketch = code ?? (this.uiCallbacks?.getEditorCode ? await this.uiCallbacks.getEditorCode() : '');
      if (!fqbn || !sketch) return { findings: [], report: '' };
      const findings = lint(sketch, await this.lintContext(fqbn, { built }));
      return { findings, report: lintReport(findings) };
    } catch {
      return { findings: [], report: '' };
    }
  }

  /** What the linter needs to know about the board and the sketch's other tabs. */
  async lintContext(fqbn, { built = false } = {}) {
    const info = this.boardKnowledge ? await this.boardKnowledge.boardInfo(fqbn).catch(() => null) : null;
    const pins = info?.pins && Object.keys(info.pins).length ? info.pins : null;
    const ctx = {
      fqbn,
      coreVersion: String(info?.core || '').split(' ')[1] || '',
      ledBuiltin: pins ? (pins.LED_BUILTIN ?? null) : undefined,
      cdcOnBoot: /enabled/i.test(String(info?.boardOptions?.['USB CDC On Boot'] || '')),
      built,
    };
    // The sketch's other tabs, so a Serial.begin() in another file counts.
    const sketchPath = this.uiCallbacks?.getCurrentSketchPath ? await this.uiCallbacks.getCurrentSketchPath().catch(() => '') : '';
    if (sketchPath) {
      const fs = require('fs');
      const path = require('path');
      const dir = path.dirname(sketchPath);
      ctx.project = fs.readdirSync(dir).filter((f) => /\.(?:ino|cpp|c|h|hpp)$/i.test(f) && path.join(dir, f) !== sketchPath)
        .slice(0, 20).map((f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } }).join('\n');
    }
    return ctx;
  }

  /**
   * The linter's mechanical fixes on the open sketch (a wait for a native-USB
   * monitor, the wrong core's API), without a model call.
   * @returns {Promise<{ applied: string[] } | null>}
   */
  async applyLintFixes() {
    try {
      if (!this.uiCallbacks?.getEditorCode || !this.uiCallbacks?.setEditorCode) return null;
      const fqbn = await this.selectedFqbn().catch(() => '');
      const code = await this.uiCallbacks.getEditorCode();
      if (!fqbn || !code) return null;
      const fixed = autofix(code, await this.lintContext(fqbn, { built: true }));
      if (!fixed.applied.length) return null;
      await this.uiCallbacks.setEditorCode(fixed.code);
      return { applied: fixed.applied };
    } catch {
      return null;
    }
  }

  /**
   * A failed build whose errors have a proven mechanical fix (the error
   * decoder's rewrites: an API that moved between core versions, a missing
   * include, pasted quotes): apply it to the open sketch without a model call.
   * @returns {Promise<{ applied: string[] } | null>}
   */
  async applyKnownRewrite(check) {
    try {
      if (!check || check.success !== false || !this.uiCallbacks?.getEditorCode || !this.uiCallbacks?.setEditorCode) return null;
      const fqbn = await this.selectedFqbn().catch(() => '');
      const code = await this.uiCallbacks.getEditorCode();
      if (!fqbn || !code) return null;
      const output = [check.output || '', ...(check.diagnostics || []).map((d) => `${d.file}:${d.line}:${d.col ?? 1}: ${d.level}: ${d.message}`)].join('\n');
      const info = this.boardKnowledge ? await this.boardKnowledge.boardInfo(fqbn).catch(() => null) : null;
      const led = info?.pins?.LED_BUILTIN;
      const fixed = rewriteErrors(code, output, { fqbn, ledPin: Number.isInteger(led) ? led : null });
      if (!fixed.applied.length) return null;
      await this.uiCallbacks.setEditorCode(fixed.code);
      return { applied: fixed.applied };
    } catch {
      return null;
    }
  }

  async executeListBoards() {
    const boards = await this.arduinoService.listBoards();
    return { boards };
  }

  async executeListPorts() {
    const ports = await this.arduinoService.listPorts();
    return { ports };
  }

  /**
   * The board maker's own pages. `list` says which Impulse knows for this
   * board; `read` fetches one (documentation hosts only) and returns the part
   * about `focus`, so an answer can quote the manufacturer.
   */
  async executeReadDocs(args = {}) {
    if (!this.docs) return { success: false, error: 'Documentation reading is not set up in this build.' };
    const action = String(args.action || '').toLowerCase();
    const fqbn = (await this.selectedFqbn().catch(() => '')) || '';
    const info = fqbn && this.boardKnowledge ? await this.boardKnowledge.boardInfo(fqbn).catch(() => null) : null;
    const pages = this.docs.listFor({ catalogId: info?.catalog?.id || '', family: info?.family || '', boardName: info?.name || '' });
    if (action === 'list') {
      return pages.length
        ? { success: true, pages, note: 'Read one with action "read" and a focus; quote the page and name it in your answer.' }
        : { success: true, pages: [], note: 'Impulse knows no official page for this board. Say what you know from the board facts instead of guessing.' };
    }
    if (action === 'read') {
      const url = String(args.url || '').trim() || pages[0]?.url;
      if (!url) return { success: false, error: 'Give a url, or call action "list" first.' };
      const page = await this.docs.read(url, { focus: String(args.focus || '').slice(0, 120) });
      return page.ok
        ? { success: true, url: page.url, title: page.title, focus: args.focus || null, truncated: !!page.truncated, cached: !!page.cached, proof: proofLine(docsProof(page.url)), text: page.text }
        : { success: false, error: page.error, url };
    }
    return { success: false, error: `Unknown read_docs action "${args.action}". Use list or read.` };
  }

  /**
   * Libraries by action. The index is the authority on what exists, so the
   * model can check before it recommends, and `missing` says exactly what a
   * sketch needs that this computer does not have.
   */
  async executeLibraries(args = {}) {
    const libraries = this.arduinoService?.libraries;
    if (!libraries) return { success: false, error: 'Libraries need arduino-cli.' };
    const action = String(args.action || '').toLowerCase();
    const fqbn = (await this.selectedFqbn().catch(() => '')) || '';
    const short = (lib) => ({
      name: lib.name, version: lib.version, installed: !!lib.installed, provides: (lib.provides || []).slice(0, 6),
      about: String(lib.sentence || '').slice(0, 160), fitsBoard: lib.fitsBoard !== false,
    });
    try {
      if (action === 'search') {
        const query = String(args.query || '').trim();
        if (!query) return { success: false, error: 'Say what to search for (a library name or a header like DHT.h).' };
        const hits = await libraries.search(query, { fqbn, limit: 8 });
        return hits.length
          ? { success: true, libraries: hits.map(short) }
          : { success: true, libraries: [], note: `Nothing in the Arduino library index matches "${query}". Do not tell the user to install it: look for another library, or write the code without one.` };
      }
      if (action === 'installed') {
        const list = await libraries.installed({ refresh: true });
        return { success: true, libraries: list.slice(0, 60).map((l) => ({ name: l.name, version: l.version, provides: (l.provides || []).slice(0, 4) })) };
      }
      if (action === 'missing') {
        const code = args.code || (this.uiCallbacks?.getEditorCode ? await this.uiCallbacks.getEditorCode() : '');
        const missing = await libraries.missingFor(code, { fqbn });
        return missing.length
          ? { success: true, missing: missing.map((m) => ({ header: m.header, install: short(m.suggestion), alternatives: m.alternatives.map((a) => a.name) })), note: 'Compiling installs these by itself; say what you are adding and why.' }
          : { success: true, missing: [], note: 'Every header the sketch includes is provided by an installed library or by the board\'s core.' };
      }
      if (action === 'install') {
        const name = String(args.name || '').trim();
        if (!name) return { success: false, error: 'Name the library exactly as search returned it.' };
        const res = await libraries.install(name, { version: String(args.version || '').trim() });
        return { success: true, installed: res.name, version: res.version, note: 'Compile again now.' };
      }
      return { success: false, error: `Unknown libraries action "${args.action}". Use search, installed, missing or install.` };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Serial Monitor Operation Implementations
  /** One tool for the monitor: dispatches on `action` (see toolSchema SERIAL). */
  async executeSerial(args = {}) {
    const action = String(args.action || '').toLowerCase();
    const port = async () => (args.port || '').trim() || (this.uiCallbacks?.getSelectedPort ? await this.uiCallbacks.getSelectedPort() : '') || '';
    switch (action) {
      case 'connect': {
        const p = await port();
        if (!p) return { success: false, error: 'No port: plug the board in and select its port, or pass port.' };
        return this.executeConnectSerial({ port: p, baudRate: Number(args.baudRate) || 115200 });
      }
      case 'read': return this.executeReadSerial({ lines: Number(args.lines) || 50 });
      case 'send': return this.executeSendSerial({ data: String(args.data ?? '') });
      case 'disconnect': return this.executeDisconnectSerial();
      case 'auto_baud': {
        const p = await port();
        if (!p) return { success: false, error: 'No port to try baud rates on.' };
        return this.executeAutoDetectBaud({ port: p });
      }
      case 'get_baud': return this.executeGetBaudRate();
      case 'set_baud': return this.executeSetBaudRate({ baudRate: Number(args.baudRate) });
      case 'baud_rates': return this.executeGetAvailableBaudRates ? this.executeGetAvailableBaudRates() : { baudRates: this.availableBaudRates };
      default: return { success: false, error: `Unknown serial action "${args.action}". Use connect, read, send, disconnect, auto_baud, get_baud, set_baud or baud_rates.` };
    }
  }

  async executeConnectSerial(args) {
    const { port, baudRate = 115200 } = args;
    await this.serialMonitor.connect(port, baudRate);
    return { port, baudRate, connected: true };
  }

  async executeDisconnectSerial() {
    await this.serialMonitor.disconnect();
    return { connected: false };
  }

  async executeSendSerial(args) {
    const { data } = args;
    await this.serialMonitor.send(data);
    return { sent: data };
  }

  async executeReadSerial(args) {
    // The main process keeps one history for the whole app, so the agent sees
    // what the board printed even when the user opened the monitor.
    const want = Math.max(1, Math.min(200, Number(args?.lines) || 50));
    const history = this.serialMonitor?.recent ? this.serialMonitor.recent(want) : [];
    return {
      lines: history.map((l) => ({ at: l.at, kind: l.kind, text: String(l.text).slice(0, 300) })),
      totalBuffered: this.serialMonitor?.lines?.length ?? 0,
      connected: !!this.serialMonitor?.isConnected,
      note: history.length ? undefined : 'Nothing has been printed. Connect the monitor (serial action connect) after an upload, and give the board a moment to start.',
    };
  }

  async executeAutoDetectBaud(args) {
    const { port } = args;

    if (this.serialMonitor.tryBaudRates) {
      const detectedBaud = await this.serialMonitor.tryBaudRates(port);

      if (detectedBaud) {
        return {
          success: true,
          baudRate: detectedBaud,
          port
        };
      }
    }

    return {
      success: false,
      error: 'Could not detect baud rate',
      port
    };
  }

  // Baud Rate Operation Implementations
  async executeGetBaudRate() {
    if (this.uiCallbacks && this.uiCallbacks.getBaudRate) {
      const baudRate = await this.uiCallbacks.getBaudRate();
      return { baudRate };
    }

    // Fallback to serial monitor's current baud rate
    if (this.serialMonitor && this.serialMonitor.currentBaudRate) {
      return { baudRate: this.serialMonitor.currentBaudRate };
    }

    return { baudRate: null, error: 'No baud rate information available' };
  }

  async executeSetBaudRate(args) {
    const { baudRate } = args;

    // Validate baud rate
    if (!this.availableBaudRates.includes(baudRate)) {
      return {
        success: false,
        error: `Invalid baud rate: ${baudRate}. Available rates: ${this.availableBaudRates.join(', ')}`
      };
    }

    if (this.uiCallbacks && this.uiCallbacks.setBaudRate) {
      await this.uiCallbacks.setBaudRate(baudRate);
      return { success: true, baudRate };
    }

    return { success: false, error: 'Unable to set baud rate - UI callback not available' };
  }

  executeGetAvailableBaudRates() {
    return { baudRates: this.availableBaudRates };
  }

  // Code Editor Operation Implementations
  async executeGetEditorCode() {
    if (this.uiCallbacks && this.uiCallbacks.getEditorCode) {
      const code = await this.uiCallbacks.getEditorCode();
      return { code };
    }

    return { code: null, error: 'Unable to get editor code - UI callback not available' };
  }

  /** The selected board's FQBN, from the IDE. */
  async selectedFqbn() {
    if (this.uiCallbacks?.getSelectedBoard) return (await this.uiCallbacks.getSelectedBoard()) || '';
    return '';
  }

  async executeGetBoardInfo(args = {}) {
    if (!this.boardKnowledge) return { success: false, error: 'Board knowledge needs arduino-cli.' };
    const fqbn = args.fqbn || await this.selectedFqbn();
    if (!fqbn) return { success: false, error: 'No board is selected. Ask the user to select one, or pass an FQBN (search_boards finds it).' };
    try {
      return { success: true, ...(await this.boardKnowledge.boardInfo(fqbn, { raw: !!args.raw })) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async executeGetMcuGuide(args = {}) {
    if (!this.boardKnowledge) return { success: false, error: 'Board knowledge needs arduino-cli.' };
    try {
      const fqbn = args.fqbn || (args.chip ? '' : await this.selectedFqbn());
      if (!args.chip && !fqbn) return { success: true, guide: await this.boardKnowledge.mcuGuide({ chip: 'general' }) };
      return { success: true, guide: await this.boardKnowledge.mcuGuide({ chip: args.chip, fqbn }) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async executeGetComponentGuide(args = {}) {
    const found = findComponents(args.query);
    if (!found.length) {
      return { success: true, found: 0, guide: `Nothing in the component guide matches "${args.query}". Known: ${COMPONENTS.map((c) => c.names[0]).join(', ')}.` };
    }
    // Wiring and the known-good sketch follow the selected board's family; the sketch only for the best match.
    const fqbn = args.fqbn || await this.selectedFqbn().catch(() => '');
    const family = familyKey(fqbn);
    return { success: true, found: found.length, family, guide: found.map((c, i) => componentText(c, { family, withSketch: i === 0 })).join('\n\n') };
  }

  async executeSearchBoards(args = {}) {
    if (!this.boardKnowledge) return { success: false, error: 'Board search needs arduino-cli.' };
    try {
      const boards = await this.boardKnowledge.search(String(args.query || '').trim());
      return { success: true, boards, note: boards.some((b) => !b.installed) ? 'Boards with installed: false need their core installed (Boards Manager) before they can be compiled for.' : undefined };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async executeSetEditorCode(args) {
    const { code } = args;

    // With no sketch open the editor is hidden: the code would vanish while
    // the tool reported success.
    if (this.uiCallbacks?.getCurrentSketchPath && !(await this.uiCallbacks.getCurrentSketchPath())) {
      return { success: false, error: 'No sketch open, so there is no editor to write to. Ask the user to create a sketch (File › New Sketch) or open one, and show them the code in your answer meanwhile.' };
    }

    if (this.uiCallbacks && this.uiCallbacks.setEditorCode) {
      await this.uiCallbacks.setEditorCode(code);
      return { success: true };
    }

    return { success: false, error: 'Unable to set editor code - UI callback not available' };
  }

  async executeEditCode(args) {
    const { operation, startLine, endLine, newCode } = args;

    if (!this.uiCallbacks || !this.uiCallbacks.getEditorCode || !this.uiCallbacks.setEditorCode) {
      return { success: false, error: 'Unable to edit code - UI callbacks not available' };
    }

    // Capture the rev at read time; setEditorCode rejects the write if the
    // user has typed since. The agent re-reads and retries on STALE_EDITOR.
    const expectedRev = this.uiCallbacks.getEditorRev ? await this.uiCallbacks.getEditorRev() : null;
    const currentCode = await this.uiCallbacks.getEditorCode();
    const lines = currentCode.split('\n');

    // Convert to 0-indexed
    const start = startLine - 1;
    const end = endLine ? endLine - 1 : start;

    let newLines;

    switch (operation) {
      case 'replace': {
        const codeLines = newCode ? newCode.split('\n') : [];
        newLines = [...lines.slice(0, start), ...codeLines, ...lines.slice(end + 1)];
        break;
      }

      case 'insert': {
        const insertLines = newCode ? newCode.split('\n') : [];
        newLines = [...lines.slice(0, start), ...insertLines, ...lines.slice(start)];
        break;
      }

      case 'delete':
        newLines = [...lines.slice(0, start), ...lines.slice(end + 1)];
        break;

      default:
        return { success: false, error: `Unknown operation: ${operation}` };
    }

    const newCodeStr = newLines.join('\n');
    try {
      await this.uiCallbacks.setEditorCode(newCodeStr, expectedRev != null ? { expectedRev } : undefined);
    } catch (err) {
      if (err?.code === 'STALE_EDITOR') return {
        success: false,
        code: 'STALE_EDITOR',
        error: 'The user edited the file while this tool was running. Read the editor again and re-apply.',
      };
      throw err;
    }

    return {
      success: true,
      operation,
      linesAffected: end - start + 1,
      newLineCount: newLines.length
    };
  }

  async executeSearchCode(args) {
    const { searchText, isRegex = false } = args;

    if (!this.uiCallbacks || !this.uiCallbacks.getEditorCode) {
      return { success: false, error: 'Unable to search code - UI callback not available' };
    }

    const code = await this.uiCallbacks.getEditorCode();
    const lines = code.split('\n');
    const matches = [];

    const regex = isRegex ? new RegExp(searchText, 'gi') : null;

    lines.forEach((line, index) => {
      let found = false;

      if (isRegex) {
        found = regex.test(line);
        regex.lastIndex = 0; // Reset regex state
      } else {
        found = line.toLowerCase().includes(searchText.toLowerCase());
      }

      if (found) {
        matches.push({
          lineNumber: index + 1,
          content: line.trim()
        });
      }
    });

    return {
      searchText,
      matchCount: matches.length,
      matches: matches.slice(0, 50) // Limit results
    };
  }

  async executeReplaceInCode(args) {
    const { searchText, replaceText, replaceAll = false } = args;

    if (!this.uiCallbacks || !this.uiCallbacks.getEditorCode || !this.uiCallbacks.setEditorCode) {
      return { success: false, error: 'Unable to replace in code - UI callbacks not available' };
    }

    const expectedRev = this.uiCallbacks.getEditorRev ? await this.uiCallbacks.getEditorRev() : null;
    const code = await this.uiCallbacks.getEditorCode();
    let newCode;
    let count = 0;

    if (replaceAll) {
      const regex = new RegExp(searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      count = (code.match(regex) || []).length;
      newCode = code.replace(regex, replaceText);
    } else {
      const index = code.indexOf(searchText);
      if (index !== -1) {
        newCode = code.substring(0, index) + replaceText + code.substring(index + searchText.length);
        count = 1;
      } else {
        newCode = code;
      }
    }

    try {
      await this.uiCallbacks.setEditorCode(newCode, expectedRev != null ? { expectedRev } : undefined);
    } catch (err) {
      if (err?.code === 'STALE_EDITOR') return {
        success: false,
        code: 'STALE_EDITOR',
        error: 'The user edited the file while this tool was running. Read the editor again and re-apply.',
      };
      throw err;
    }

    return {
      success: true,
      searchText,
      replaceText,
      replacementCount: count
    };
  }

  async executeGetCurrentSketchPath() {
    if (this.uiCallbacks && this.uiCallbacks.getCurrentSketchPath) {
      const path = await this.uiCallbacks.getCurrentSketchPath();
      return { path };
    }

    return { path: null, error: 'Unable to get sketch path - UI callback not available' };
  }

  async executeSaveSketch(args) {
    const { path } = args;

    if (this.uiCallbacks && this.uiCallbacks.saveSketch) {
      await this.uiCallbacks.saveSketch(path);
      return { success: true, path };
    }

    return { success: false, error: 'Unable to save sketch - UI callback not available' };
  }

  // Analysis Operation Implementations
  async executeAnalyzeError(args) {
    const { errorMessage, context } = args;

    // First, search memory for similar errors
    let memoryResults = [];
    if (this.aiMemory && this.aiMemory.searchSimilarErrors) {
      memoryResults = await this.aiMemory.searchSimilarErrors(errorMessage);
    }

    // Use error memory service for pattern extraction
    let analyzedError = { suggestions: [] };
    if (this.errorMemory) {
      const error = new Error(errorMessage);
      analyzedError = await this.errorMemory.analyzeError(error);
    }

    return {
      errorMessage,
      context,
      memoryMatches: memoryResults,
      patternAnalysis: analyzedError,
      suggestions: analyzedError.suggestions
    };
  }

  async executeSearchMemory(args) {
    const { query, limit = 10 } = args;

    if (this.aiMemory && this.aiMemory.searchSimilarErrors) {
      const results = await this.aiMemory.searchSimilarErrors(query, limit);
      return { results };
    }

    return { results: [] };
  }

  async executeRecordFix(args) {
    const { errorSignature, fix, context } = args;

    if (this.aiMemory && this.aiMemory.recordFix) {
      const record = await this.aiMemory.recordFix(errorSignature, fix, context);
      return { record };
    }

    return { success: false, error: 'Memory not available' };
  }

  // State Operations
  async executeGetCurrentState() {
    const state = {
      serialConnected: this.serialMonitor ? this.serialMonitor.isConnected : false,
      serialLines: this.serialMonitor?.lines?.length ?? 0,
      availableBaudRates: this.availableBaudRates,
      currentSerialBaudRate: this.serialMonitor ? this.serialMonitor.currentBaudRate : null
    };

    // Get UI state if available
    if (this.uiCallbacks) {
      if (this.uiCallbacks.getBaudRate) {
        state.currentBaudRate = await this.uiCallbacks.getBaudRate();
      }
      if (this.uiCallbacks.getCurrentSketchPath) {
        state.currentSketchPath = await this.uiCallbacks.getCurrentSketchPath();
      }
      if (this.uiCallbacks.getSelectedBoard) {
        state.selectedBoard = await this.uiCallbacks.getSelectedBoard();
      }
      if (this.uiCallbacks.getSelectedPort) {
        state.selectedPort = await this.uiCallbacks.getSelectedPort();
      }
      if (this.uiCallbacks.getLastCompileResult) {
        state.lastCompileResult = await this.uiCallbacks.getLastCompileResult();
      }
    }

    return state;
  }

  // Playground Operations
  async executeUpdatePlayground(args) {
    const { content, append = true } = args;

    if (!content || typeof content !== 'string') {
      return { success: false, error: 'Content is required and must be a string' };
    }

    if (this.uiCallbacks && this.uiCallbacks.setPlayground) {
      await this.uiCallbacks.setPlayground(content, append);
      return { success: true, message: 'Playground updated' };
    }

    return { success: false, error: 'Unable to update playground - UI callback not available' };
  }

}

/**
 * A failed build job as the model should see it: the code, what went wrong
 * and what to do, the diagnostics, and a bounded slice of the output. BUSY
 * means another build is running: the model must wait, not start another.
 */
function buildFailure(result, kind) {
  if (result.code === 'BUSY') {
    return {
      success: false,
      code: 'BUSY',
      error: result.title || result.error?.message || 'A build is already running.',
      note: 'Do not start another compile or upload. The running one finishes on its own; ask the user, or call get_current_state later.',
    };
  }
  return {
    success: false,
    code: result.code || null,
    error: [result.title || result.error?.message || result.error || (kind === 'upload' ? 'Upload failed' : 'Compilation failed'), result.hint].filter(Boolean).join(' '),
    excerpt: result.excerpt || '',
    diagnostics: (result.diagnostics || []).slice(0, 20),
    // Impulse's error decoder: the cause and the fix of the errors it knows (no guessing needed).
    ...(result.decoded?.length ? { decoded: result.decoded.slice(0, 3).map((d) => ({ error: d.title, cause: d.cause, fix: d.fix, line: d.line, proof: d.proof })) } : {}),
    summary: result.summary || [],
    output: boundedOutput(result.output || '', 2500),
  };
}

module.exports = ToolExecutor;
