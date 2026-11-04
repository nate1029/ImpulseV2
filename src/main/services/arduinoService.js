const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const ErrorHandler = require('../utils/errorHandler');
const { BuildJobs } = require('./buildJobs');
const { LibraryService } = require('./libraryService');
const { decode: decodeErrors } = require('./ai/knowledge/errorDecoder');
const { parseMemory, summaryLines, parseDiagnostics, classifyFailure, firstErrorLine } = require('./buildOutput');
const { PlatformIO, projectRoot } = require('./platformio');
const { extraCoreFor } = require('./toolchain');

/**
 * Arduino CLI Service
 * Handles all Arduino CLI operations: compile, upload, board/port listing
 * 
 * Architecture Components:
 * 1️⃣ Command Builder - constructs CLI commands with correct flags
 * 2️⃣ Process Runner - executes commands, captures stdout/stderr
 * 3️⃣ Output Parser - interprets results, detects success/failure
 * 
 * SECURITY: All CLI commands use spawn() with argument arrays.
 * Never use shell string interpolation with user-controlled input.
 */
// A build is stopped when it prints nothing for this long (a first ESP32 build
// can legitimately take several minutes while the core compiles) or runs past the maximum.
const COMPILE_IDLE_MS = 180_000;
const COMPILE_MAX_MS = 20 * 60_000;
const UPLOAD_IDLE_MS = 90_000;
const UPLOAD_MAX_MS = 15 * 60_000;
// The whole output kept for parsing and the full log (the live view streams every line regardless).
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;

/** An Error with a stable code (and optionally a title and hint) for a failed job. */
function coded(message, code, { title = null, hint = '' } = {}) {
  const err = new Error(message);
  err.code = code;
  err.title = title || message;
  err.hint = hint;
  return err;
}

class ArduinoService {
  /**
   * @param {{ cliPath?: string|null, platformio?: PlatformIO }} [opts] the arduino-cli to run (see
   *   services/toolchain.js); sketches inside a PlatformIO project are built with `pio` instead
   */
  constructor({ cliPath = null, platformio = new PlatformIO() } = {}) {
    // GUI-launched apps on macOS don't inherit the shell PATH, so the
    // toolchain service resolves an absolute path; PATH lookup is the fallback.
    this.cliPath = cliPath || 'arduino-cli';
    /** Set by the main process: the upload closes and reopens this monitor's port. */
    this.serialMonitor = null;
    /** Libraries: search, install, and what provides a header the compiler missed. */
    this.libraries = new LibraryService((args, opts) => this.runCommand(args, opts));
    /** A build that fails on a missing header installs what provides it and builds again. */
    this.autoInstallLibraries = true;
    /** Set by the main process: checks the sketch's pins against the board. */
    this.pinInspector = null;
    // The hardware linter (set by main.js): what compiles but fails on the bench.
    this.sketchLinter = null;
    /** One compile or upload at a time, watched live (see buildJobs.js). */
    this.jobs = new BuildJobs();
    /** How long a build may stay silent, and run in all (tests shorten these). */
    this.timeouts = { compileIdleMs: COMPILE_IDLE_MS, compileMaxMs: COMPILE_MAX_MS, uploadIdleMs: UPLOAD_IDLE_MS, uploadMaxMs: UPLOAD_MAX_MS };
    this.coreIndexed = false;
    this.platformio = platformio;
  }

  /** The PlatformIO project a sketch path belongs to, or null for an Arduino sketch. */
  platformioRoot(sketchPath) {
    return this.platformio ? projectRoot(sketchPath) : null;
  }

  // ==================== 2️⃣ Process Runner ====================

  /**
   * Safe command runner using spawn() with argument arrays.
   * NEVER passes user input through a shell.
   * @param {string[]} args - Array of arguments for arduino-cli
   * @param {Object} options - spawn options (cwd, timeout, etc.)
   * @returns {Promise<{success: boolean, stdout: string, stderr: string, code?: number}>}
   */
  async runCommand(args, options = {}) {
    return new Promise((resolve) => {
      const { timeout = 60000, ...spawnOptions } = options;
      const proc = spawn(this.cliPath, args, {
        windowsHide: true,
        ...spawnOptions
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        finish(code === 0 ? { success: true, stdout, stderr } : { success: false, stdout, stderr, code });
      });

      proc.on('error', (error) => {
        finish({ success: false, stdout: '', stderr: error.message, code: error.code });
      });

      const timer = setTimeout(() => {
        proc.kill();
        finish({ success: false, stdout, stderr: 'Command timed out', code: 'TIMEOUT' });
      }, timeout);
    });
  }

  async checkCLI() {
    try {
      const result = await this.runCommand(['version']);
      return result.success && result.stdout.trim().length > 0;
    } catch (error) {
      return false;
    }
  }

  async ensureCoreIndexed() {
    if (this.coreIndexed) return;
    
    try {
      await this.runCommand(['core', 'update-index']);
      this.coreIndexed = true;
    } catch (error) {
      console.warn('Failed to update core index:', error.message);
    }
  }

  // ==================== 3️⃣ Output Parser ====================

  /**
   * Parse compile output to extract useful information
   */
  parseCompileOutput(stdout, stderr) {
    const combined = stdout + '\n' + stderr;
    const lines = combined.split('\n');
    
    const result = {
      success: false,
      programSize: null,
      maxSize: null,
      usagePercent: null,
      warnings: [],
      errors: [],
      message: ''
    };
    
    for (const line of lines) {
      const lowerLine = line.toLowerCase();
      
      // Parse success - "Sketch uses X bytes"
      const sizeMatch = line.match(/Sketch uses (\d+) bytes \((\d+)%\) of program storage space/);
      if (sizeMatch) {
        result.success = true;
        result.programSize = parseInt(sizeMatch[1]);
        result.usagePercent = parseInt(sizeMatch[2]);
      }
      
      // Parse max size
      const maxMatch = line.match(/Maximum is (\d+) bytes/);
      if (maxMatch) {
        result.maxSize = parseInt(maxMatch[1]);
      }
      
      // Collect errors
      if (lowerLine.includes('error:') || 
          lowerLine.includes('was not declared') ||
          lowerLine.includes('undefined reference')) {
        result.errors.push(line.trim());
      }
      
      // Collect warnings
      if (lowerLine.includes('warning:') && !lowerLine.includes('error:')) {
        result.warnings.push(line.trim());
      }
    }
    
    // Generate summary message
    if (result.success) {
      result.message = `Compilation successful. Uses ${result.programSize} bytes (${result.usagePercent}%)`;
    } else if (result.errors.length > 0) {
      result.message = result.errors[0];
    } else {
      result.message = 'Compilation failed';
    }
    
    return result;
  }

  /**
   * Parse upload output - improved detection for multiple board types
   */
  parseUploadOutput(stdout, stderr) {
    const combined = stdout + '\n' + stderr;
    const lines = combined.split('\n');
    
    const result = {
      success: false,
      progress: 0,
      errors: [],
      warnings: [],
      message: ''
    };
    
    // Success indicators for various board types
    const successPatterns = [
      /100%/,                                          // General progress completion
      /avrdude.*done/i,                                // AVR boards (Uno, Nano, Mega)
      /avrdude.*verified/i,                            // AVR verification
      /avrdude.*flash verified/i,                      // AVR flash verified
      /writing.*done/i,                                // Generic writing done
      /hard resetting via rts pin/i,                   // ESP32/ESP8266 reset after upload
      /leaving.*hard reset/i,                          // ESP32 variant
      /hash of data verified/i,                        // ESP32 hash verification
      /compressed \d+ bytes to \d+/i,                  // ESP32 compression success
      /wrote \d+ bytes/i,                              // Generic write success
      /flash written and target reset/i,              // STM32 boards
      /upload.*complete/i,                             // Generic upload complete
      /successfully/i,                                 // Generic success
      /programming.*ok/i,                              // Some programmers
    ];
    
    // Error patterns - more specific to avoid false positives
    const errorPatterns = [
      { pattern: /error:/i, type: 'error' },
      { pattern: /fatal error/i, type: 'error' },
      { pattern: /upload failed/i, type: 'error' },
      { pattern: /timeout/i, type: 'error' },
      { pattern: /permission denied/i, type: 'error' },
      { pattern: /access denied/i, type: 'error' },
      { pattern: /port.*not found/i, type: 'error' },
      { pattern: /no such file or directory/i, type: 'error' },
      { pattern: /device not found/i, type: 'error' },
      { pattern: /programmer.*not responding/i, type: 'error' },
      { pattern: /sync error/i, type: 'error' },
      { pattern: /stk500.*not in sync/i, type: 'error' },
      { pattern: /espcomm_upload_mem failed/i, type: 'error' },
      { pattern: /a]fatal error occurred/i, type: 'error' },
      { pattern: /serial port.*busy/i, type: 'error' },
    ];
    
    for (const line of lines) {
      const lowerLine = line.toLowerCase();
      
      // Check for success indicators
      for (const pattern of successPatterns) {
        if (pattern.test(line)) {
          result.success = true;
          result.progress = 100;
          break;
        }
      }
      
      // Parse progress percentage
      const progressMatch = line.match(/(\d+)%/);
      if (progressMatch) {
        const progress = parseInt(progressMatch[1]);
        result.progress = Math.max(result.progress, progress);
        if (progress >= 100) {
          result.success = true;
        }
      }
      
      // Check for errors (but not false positives like "error correction")
      for (const { pattern } of errorPatterns) {
        if (pattern.test(line)) {
          // Exclude false positives
          if (!lowerLine.includes('error correction') && 
              !lowerLine.includes('no error')) {
            result.errors.push(line.trim());
          }
        }
      }
      
      // Collect warnings
      if (lowerLine.includes('warning:') && !lowerLine.includes('error:')) {
        result.warnings.push(line.trim());
      }
    }
    
    // If we found errors but also success indicators, check if it's a fatal error
    if (result.errors.length > 0) {
      const hasFatalError = result.errors.some(e => 
        /fatal|failed|cannot|unable/i.test(e)
      );
      if (hasFatalError) {
        result.success = false;
      }
    }
    
    // Generate message
    if (result.success) {
      result.message = 'Upload complete';
    } else if (result.errors.length > 0) {
      // Get the most relevant error message
      const relevantError = result.errors.find(e => 
        /error:|failed|timeout|denied|not found/i.test(e)
      ) || result.errors[0];
      result.message = relevantError;
    } else {
      result.message = 'Upload status unknown - check output for details';
    }
    
    return result;
  }

  // ==================== Board/Port Management ====================

  /**
   * List all installed boards using JSON output
   * Uses spawn for large outputs to avoid buffer overflow
   */
  async listBoards() {
    await this.ensureCoreIndexed();
    
    try {
      // Use spawn for large outputs to handle buffer issues
      const boards = await this.listBoardsWithSpawn();
      
      if (boards.length === 0) {
        return this.getCommonBoards();
      }
      
      // Limit to first 150 boards to prevent UI slowdown
      const limitedBoards = boards.slice(0, 150);
      
      // Add common boards at the top if they exist
      const commonFQBNs = [
        'arduino:avr:uno',
        'arduino:avr:nano',
        'arduino:avr:nano:cpu=atmega328old',
        'arduino:avr:mega',
        'arduino:avr:leonardo',
        'esp32:esp32:esp32',
        'esp32:esp32:esp32s3',
        'esp8266:esp8266:nodemcuv2',
        'esp8266:esp8266:generic'
      ];
      
      const sortedBoards = [];
      
      // Add common boards first
      for (const fqbn of commonFQBNs) {
        const found = limitedBoards.find(b => b.fqbn === fqbn);
        if (found && !sortedBoards.some(b => b.fqbn === found.fqbn)) {
          sortedBoards.push(found);
        }
      }
      
      // Add remaining boards
      for (const board of limitedBoards) {
        if (!sortedBoards.some(b => b.fqbn === board.fqbn)) {
          sortedBoards.push(board);
        }
      }
      
      return sortedBoards;
    } catch (error) {
      console.error('Failed to list boards:', error.message);
      return this.getCommonBoards();
    }
  }

  /**
   * List boards using spawn to handle large outputs
   */
  async listBoardsWithSpawn() {
    return new Promise((resolve, _reject) => {
      const args = ['board', 'listall', '--format', 'json'];
      const boardProcess = spawn(this.cliPath, args);
      
      let stdout = '';
      let stderr = '';
      
      boardProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      boardProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      boardProcess.on('close', (code) => {
        if (code !== 0) {
          console.error('Board list error:', stderr);
          resolve([]); // Return empty array, will fall back to common boards
          return;
        }
        
        try {
          const data = JSON.parse(stdout);
          const boards = [];
          
          // Handle different JSON structures from different CLI versions
          const boardList = data.boards || data;
          
          if (Array.isArray(boardList)) {
            for (const board of boardList) {
              if (board.fqbn && board.name) {
                boards.push({
                  name: board.name,
                  fqbn: board.fqbn
                });
              }
            }
          }
          
          resolve(boards);
        } catch (parseError) {
          console.error('Failed to parse board list:', parseError.message);
          resolve([]);
        }
      });
      
      boardProcess.on('error', (error) => {
        console.error('Failed to spawn board list process:', error.message);
        resolve([]);
      });
      
      // Timeout after 30 seconds
      setTimeout(() => {
        boardProcess.kill();
        resolve([]);
      }, 30000);
    });
  }

  getCommonBoards() {
    return [
      { name: 'Arduino Uno', fqbn: 'arduino:avr:uno' },
      { name: 'Arduino Nano', fqbn: 'arduino:avr:nano' },
      { name: 'Arduino Nano (Old Bootloader)', fqbn: 'arduino:avr:nano:cpu=atmega328old' },
      { name: 'Arduino Mega 2560', fqbn: 'arduino:avr:mega' },
      { name: 'Arduino Leonardo', fqbn: 'arduino:avr:leonardo' },
      { name: 'ESP32 Dev Module', fqbn: 'esp32:esp32:esp32' },
      { name: 'ESP8266 NodeMCU', fqbn: 'esp8266:esp8266:nodemcuv2' },
      { name: 'ESP8266 Generic', fqbn: 'esp8266:esp8266:generic' }
    ];
  }

  /**
   * List connected boards/ports using JSON output
   */
  /**
   * Connected ports. Throws when arduino-cli fails, so callers can tell
   * "no boards plugged in" apart from "couldn't ask".
   */
  async listPorts() {
    let result = await this.runCommand(['board', 'list', '--format', 'json']);
    if (!result.success) {
      // board list can fail transiently while another CLI call holds the lock.
      await new Promise(resolve => setTimeout(resolve, 400));
      result = await this.runCommand(['board', 'list', '--format', 'json']);
    }
    if (!result.success) throw new Error(result.stderr.trim() || 'arduino-cli board list failed');

    const data = JSON.parse(result.stdout);
    const portList = data.detected_ports || data.ports || data;
    const ports = [];
    if (Array.isArray(portList)) {
      for (const item of portList) {
        const port = item.port || item;
        if (port && port.address) {
          const boardName = item.matching_boards && item.matching_boards[0]
            ? item.matching_boards[0].name
            : (port.protocol_label || 'Unknown');
          const props = port.properties || {};
          // Boards arduino-cli recognised by USB id (from the installed cores),
          // so the IDE can select the one that was just plugged in.
          const boards = (item.matching_boards || []).filter(b => b && b.fqbn).map(b => ({ name: b.name, fqbn: b.fqbn }));
          ports.push({ port: port.address, protocol: port.protocol || 'serial', board: boardName, vid: props.vid || null, pid: props.pid || null, boards });
        }
      }
    }
    return ports;
  }

  /**
   * Validate FQBN format
   */
  validateFQBN(fqbn) {
    if (typeof fqbn !== 'string' || /\s/.test(fqbn)) return false;
    // vendor:architecture:board[:option=value,...], e.g. arduino:avr:uno
    const parts = fqbn.split(':');
    return parts.length >= 3 && parts.length <= 4 && parts.every(p => p.length > 0);
  }

  // ==================== Compile/Upload Operations ====================

  // ==================== Build jobs ====================

  /**
   * Compile an Arduino sketch as a build job: one at a time, every output
   * line streamed to the window, the result parsed into Arduino IDE's memory
   * summary and structured diagnostics. Resolves with the result, or with
   * `{ success: false, code, title, hint, ... }` (never throws).
   */
  async compile(sketchPath, boardFQBN) {
    try {
      return await this.jobs.run({ kind: 'compile', sketchPath, fqbn: boardFQBN }, (job) => this._compileJob(job, sketchPath, boardFQBN));
    } catch (error) {
      return this._handled(error, 'Arduino Compile', { sketchPath, boardFQBN });
    }
  }

  /**
   * Spawn arduino-cli for a job and feed its output to the job line by line
   * (stages, progress and the live view come from the lines). Resolves with
   * the exit code and the whole output. The process is stopped when it prints
   * nothing for `idleMs`, runs longer than `maxMs`, or the job is cancelled.
   * @returns {Promise<{ code: number|string|null, output: string, reason: null|'IDLE'|'MAX'|'CANCELLED'|'SPAWN' }>}
   */
  _runStreaming(job, args, { cwd, idleMs, maxMs }) {
    return new Promise((resolve) => {
      let child;
      let output = '';
      const rest = { out: '', err: '' };
      let reason = null;
      let finished = false;
      let idle = null;
      let max = null;
      const finish = (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(idle);
        clearTimeout(max);
        job.signal.removeEventListener('abort', onAbort);
        for (const key of ['out', 'err']) if (rest[key]) job.line(rest[key]);
        resolve({ code, output, reason });
      };
      const onAbort = () => { reason = 'CANCELLED'; try { child?.kill(); } catch { /* gone */ } };
      const armIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { reason = reason || 'IDLE'; try { child?.kill(); } catch { /* gone */ } }, idleMs);
      };
      try {
        child = spawn(this.cliPath, args, { cwd });
      } catch (error) {
        output = error.message;
        reason = 'SPAWN';
        return finish(error.code || -1);
      }
      job.attach(child);
      job.signal.addEventListener('abort', onAbort, { once: true });
      max = setTimeout(() => { reason = reason || 'MAX'; try { child.kill(); } catch { /* gone */ } }, maxMs);
      const onData = (key) => (data) => {
        const text = data.toString();
        if (output.length < MAX_OUTPUT_CHARS) output += text;
        rest[key] += text;
        const parts = rest[key].split('\n');
        rest[key] = parts.pop();
        for (const line of parts) job.line(line);
        armIdle();
      };
      child.stdout.on('data', onData('out'));
      child.stderr.on('data', onData('err'));
      child.on('close', (code) => finish(code));
      child.on('error', (error) => {
        output += `\n${error.message}`;
        reason = reason || 'SPAWN';
        finish(error.code === 'ENOENT' ? 'ENOENT' : -1);
      });
      armIdle();
    });
  }

  /** The compile half of a job. Resolves with the parsed result; throws a coded Error on failure. */
  async _compileJob(job, sketchPath, boardFQBN) {
    const pioRoot = this.platformioRoot(sketchPath);
    if (pioRoot) {
      job.stage('compiling');
      const res = await this.platformio.build(pioRoot);
      for (const line of String(res.output || '').split('\n')) job.line(line);
      const memory = parseMemory(res.output || '');
      if (!res.success) {
        throw this._failure(res.output || res.error || '', 'compile', { memory, override: { code: 'COMPILE_FAILED', title: res.error || 'The PlatformIO build failed', hint: 'The output below says why.' }, errors: res.errors });
      }
      const summary = summaryLines(memory);
      return {
        success: true, output: res.output, warnings: [], memory, summary, diagnostics: parseDiagnostics(res.output || ''),
        programSize: res.programSize ?? memory?.flash?.used ?? null, usagePercent: res.usagePercent ?? memory?.flash?.percent ?? null,
        message: `Built PlatformIO environment ${res.env}`,
      };
    }
    const validation = ErrorHandler.validateInput(
      { sketchPath, boardFQBN },
      { sketchPath: { required: true, type: 'string', minLength: 1 }, boardFQBN: { required: true, type: 'string', minLength: 5 } }
    );
    if (!validation.valid) throw coded(`Invalid input: ${validation.errors.join(', ')}`, 'INVALID');
    if (!this.validateFQBN(boardFQBN)) throw coded(`Invalid FQBN format: "${boardFQBN}". Expected format: vendor:architecture:board (e.g., arduino:avr:uno)`, 'INVALID');
    try {
      await fs.access(sketchPath);
    } catch {
      throw coded(`Sketch file not found: ${sketchPath}. Please check the file path.`, 'SKETCH_MISSING', { hint: 'Save the sketch, then build again.' });
    }
    if (!await this.checkCLI()) {
      throw coded('Arduino CLI is not available. Impulse installs it on first start; open Tools › Toolchain setup to repair it.', 'TOOLCHAIN');
    }
    await this.ensureCoreIndexed();
    const run = async () => {
      job.stage('compiling');
      return this._runStreaming(job, ['compile', '--fqbn', boardFQBN, '--verbose', sketchPath], {
        cwd: path.dirname(sketchPath), idleMs: this.timeouts.compileIdleMs, maxMs: this.timeouts.compileMaxMs,
      });
    };
    // Libraries the sketch needs are installed first (from the index), and any
    // the compiler still misses are installed and the build run again.
    const attempt = async () => {
      const r = await run();
      return { success: r.code === 0 && !r.reason, error: r.output, ...r };
    };
    const built = await this._withLibraries(attempt, { fqbn: boardFQBN, sketchPath, onLine: (text) => job.line(text) });
    const installedLibraries = built.installedLibraries || [];
    const { code, output, reason } = built;
    const memory = parseMemory(output);
    const diagnostics = parseDiagnostics(output);
    const warnings = diagnostics.filter((d) => d.level === 'warning').map((d) => `${path.basename(d.file)}:${d.line}: ${d.message}`);
    if (code === 0) {
      const summary = summaryLines(memory);
      if (installedLibraries.length) summary.unshift(`Installed ${[...new Set(installedLibraries.map((l) => l.name))].join(', ')} to build this sketch.`);
      // It compiles; whether the pins exist on this board is another question.
      const pins = this.pinInspector ? await this.pinInspector({ sketchPath, fqbn: boardFQBN }).catch(() => null) : null;
      if (pins?.report) summary.push(...pins.report.split('\n'));
      const linted = this.sketchLinter ? await this.sketchLinter({ sketchPath, fqbn: boardFQBN }).catch(() => null) : null;
      const lint = (linted?.findings || []).filter((f) => f.level !== 'info');
      if (lint.length) summary.push(`Impulse found ${lint.length === 1 ? 'one thing that compiles' : `${lint.length} things that compile`} but will fail on the board: ${lint.slice(0, 2).map((f) => `line ${f.line}: ${f.message}`).join(' ')}`);
      return {
        success: true, output, warnings, memory, summary, diagnostics, installedLibraries,
        pinIssues: pins?.issues || [], pinReport: pins?.report || null, lint,
        programSize: memory?.flash?.used ?? null, usagePercent: memory?.flash?.percent ?? null,
        message: summary[0] || 'Compiled.',
      };
    }
    throw this._failure(output, 'compile', { reason, code, memory, diagnostics, installedLibraries, fqbn: boardFQBN });
  }

  /**
   * True once `port` is listed, waiting up to `maxMs` for a board that is
   * asleep or resetting (its USB port comes and goes); true at once when the
   * list itself cannot be read, so the upload reports the real problem.
   * @private
   */
  async _waitForPort(port, job, { maxMs = 20000, everyMs = 500 } = {}) {
    const listed = async () => {
      const ports = await this.listPorts().catch(() => null);
      return ports === null || ports.some((p) => p.port === port);
    };
    if (await listed()) return true;
    job.line(`Waiting for ${port} to come back (a board that sleeps or is resetting shows its port only part of the time)…`);
    const until = Date.now() + maxMs;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, everyMs));
      if (await listed()) {
        job.line(`${port} is back.`);
        return true;
      }
    }
    return false;
  }

  /** The upload half of a job (the sketch is compiled already). Throws a coded Error on failure. */
  async _uploadJob(job, sketchPath, boardFQBN, port, compiled = null) {
    const pioRoot = this.platformioRoot(sketchPath);
    if (pioRoot) {
      job.stage('uploading');
      const res = await this.platformio.upload(pioRoot, port);
      for (const line of String(res.output || '').split('\n')) job.line(line);
      if (!res.success) {
        throw this._failure(res.output || res.error || '', 'upload', { memory: compiled?.memory, override: { code: 'UPLOAD_FAILED', title: res.error || 'The PlatformIO upload failed', hint: 'The output below says why.' } });
      }
      return { success: true, output: res.output, port, message: `Uploaded PlatformIO environment ${res.env}`, warnings: [], memory: compiled?.memory || parseMemory(res.output || ''), summary: compiled?.summary || [] };
    }
    const validation = ErrorHandler.validateInput(
      { sketchPath, boardFQBN, port },
      { sketchPath: { required: true, type: 'string', minLength: 1 }, boardFQBN: { required: true, type: 'string', minLength: 5 }, port: { required: true, type: 'string', minLength: 1 } }
    );
    if (!validation.valid) throw coded(`Invalid input: ${validation.errors.join(', ')}`, 'INVALID');
    if (!this.validateFQBN(boardFQBN)) throw coded(`Invalid FQBN format: "${boardFQBN}". Expected format: vendor:architecture:board`, 'INVALID');
    // The port must still be there (when listing itself fails, let the upload report it precisely).
    // A board in deep sleep, or one still resetting, shows its port only part of
    // the time: wait for it a while before giving up.
    if (!(await this._waitForPort(port, job))) {
      throw coded(`Port ${port} is not available. Please check if your device is connected.`, 'PORT_GONE', { title: 'The port is gone', hint: 'Plug the board back in and pick its port again. A board in deep sleep wakes only now and then: press RESET as the upload starts.' });
    }
    job.stage('uploading');
    const { code, output, reason } = await this._runStreaming(job, ['upload', '--fqbn', boardFQBN, '--port', port, '--verbose', sketchPath], {
      cwd: path.dirname(sketchPath), idleMs: this.timeouts.uploadIdleMs, maxMs: this.timeouts.uploadMaxMs,
    });
    if (code === 0) {
      return {
        success: true, output, port, message: `Uploaded to ${port}`,
        warnings: compiled?.warnings || [], memory: compiled?.memory || null, summary: compiled?.summary || [], diagnostics: compiled?.diagnostics || [],
      };
    }
    throw this._failure(output, 'upload', { reason, code, memory: compiled?.memory, fqbn: boardFQBN });
  }

  /**
   * A coded Error for a failed job: what went wrong (title), what to do
   * (hint), the first line worth quoting, the diagnostics and the output.
   */
  _failure(output, kind, { reason = null, code = null, memory = null, diagnostics = null, override = null, errors = null, installedLibraries = [], fqbn = '' } = {}) {
    let f;
    if (reason === 'CANCELLED') f = { code: 'CANCELLED', title: 'Stopped', hint: '' };
    else if (reason === 'IDLE') f = { code: 'TIMEOUT', title: kind === 'upload' ? 'The upload stopped responding' : 'The build stopped responding', hint: `Nothing was printed for ${Math.max(1, Math.round((kind === 'upload' ? this.timeouts.uploadIdleMs : this.timeouts.compileIdleMs) / 60000))} minutes, so Impulse stopped it. Try again; if it happens again, check the cable and the port.` };
    else if (reason === 'MAX') f = { code: 'TIMEOUT', title: kind === 'upload' ? 'The upload took too long' : 'The build took too long', hint: 'Impulse stopped it. Try again.' };
    else if (reason === 'SPAWN' || code === 'ENOENT') f = { code: 'TOOLCHAIN', title: 'The build tools could not be started', hint: 'Impulse installs them on first start; open Tools › Toolchain setup to repair them.' };
    else f = override || classifyFailure(output, kind, { memory });
    const legacy = ArduinoService.explainToolchainError(output);
    if (legacy && (f.code === 'COMPILE_FAILED' || f.code === 'UPLOAD_FAILED')) f = { ...f, title: legacy };
    // The error decoder knows the common compile errors: its cause and fix
    // replace the generic "the sketch has a compile error".
    const decoded = ['CODE_ERROR', 'LINK_ERROR', 'LIBRARY_MISSING', 'COMPILE_FAILED'].includes(f.code) ? decodeErrors(output, { fqbn }) : [];
    if (decoded.length) f = { ...f, title: decoded[0].title, hint: `${decoded[0].cause} Fix: ${decoded[0].fix}` };
    const diag = diagnostics || parseDiagnostics(output);
    const err = new Error(f.title);
    err.code = f.code;
    err.title = f.title;
    err.hint = f.hint || '';
    err.excerpt = firstErrorLine(output);
    err.diagnostics = diag;
    err.errors = errors || diag.filter((d) => d.level === 'error').map((d) => `${d.file}:${d.line}:${d.col ?? 0}: error: ${d.message}`);
    if (!err.errors.length && err.excerpt) err.errors = [err.excerpt];
    err.output = String(output || '').trim();
    err.memory = memory;
    err.summary = summaryLines(memory);
    err.installedLibraries = installedLibraries;
    err.decoded = decoded;
    return err;
  }

  /** The `{ success: false, ... }` object compile and upload resolve with when a job fails. */
  _handled(error, context, metadata) {
    if (error?.code === 'BUSY') {
      return { success: false, code: 'BUSY', title: error.message, hint: '', error: { message: error.message, code: 'BUSY' }, busy: error.job || null };
    }
    const handled = ErrorHandler.handle(error, context, { userMessage: error?.title || error?.message, metadata });
    return {
      ...handled,
      code: error?.code || handled?.error?.code || 'UNKNOWN',
      title: error?.title || error?.message || 'Failed',
      hint: error?.hint || '',
      excerpt: error?.excerpt || '',
      output: error?.output || '',
      errors: Array.isArray(error?.errors) ? error.errors : [],
      diagnostics: Array.isArray(error?.diagnostics) ? error.diagnostics : [],
      memory: error?.memory || null,
      summary: Array.isArray(error?.summary) ? error.summary : [],
      decoded: Array.isArray(error?.decoded) ? error.decoded : [],
    };
  }

  /**
   * Compile sketch and return the generated .hex file content for simulation.
   */
  /**
   * @param {string} sketchPath
   * @param {string} boardFQBN
   * @param {{ properties?: Record<string, string> }} [options]  build properties the simulator
   *   needs (only build.f_cpu: 8 MHz boards compile for its 16 MHz clock)
   */
  /**
   * Compile for the simulator (a hex, a UF2 or an ESP32 flash image). Like a
   * build for the board, it installs the libraries the sketch needs and
   * compiles again, so a sketch that needs DHT.h simulates on the first try
   * instead of failing a check with "No such file or directory".
   */
  async compileHex(sketchPath, boardFQBN, options = {}) {
    const pioRoot = this.platformioRoot(sketchPath);
    if (pioRoot) {
      const res = await this.platformio.build(pioRoot, { fqbn: boardFQBN });
      if (!res.success) return { success: false, error: res.error };
      return res.hex ? { success: true, hex: res.hex } : { success: false, error: 'PlatformIO produced no firmware.hex' };
    }
    if (!this.validateFQBN(boardFQBN)) {
      return { success: false, error: `Invalid board: "${boardFQBN}"` };
    }
    return this._withLibraries(() => this._compileHexOnce(sketchPath, boardFQBN, options), { fqbn: boardFQBN, sketchPath });
  }

  /**
   * Run a compile; when it fails on a header some library provides, install
   * the library and compile again. The sketch's own #includes are checked
   * against the index first, so several missing libraries install in one go;
   * the compiler's "No such file" then catches what a secondary file includes.
   * @param {() => Promise<{ success: boolean, error?: string }>} compile
   * @returns {Promise<object>} the compile result, with `installedLibraries` when any were
   */
  async _withLibraries(compile, { fqbn, sketchPath, onLine = null } = {}) {
    const installed = [];
    const say = (text) => { if (onLine) onLine(text); };
    const canInstall = this.autoInstallLibraries && this.libraries;
    if (canInstall && sketchPath) {
      try {
        const code = await fs.readFile(sketchPath, 'utf8');
        const missing = await this.libraries.missingFor(code, { fqbn });
        // Several headers can come from one library (OneWireNg_CurrentPlatform.h and drivers/DSTherm.h): install it once.
        const unique = missing.filter((m, i) => missing.findIndex((o) => o.suggestion.name === m.suggestion.name) === i);
        for (const m of unique.slice(0, 6)) {
          say(`Installing ${m.suggestion.name} for ${m.header}…`);
          try {
            await this.libraries.install(m.suggestion.name);
            installed.push({ header: m.header, name: m.suggestion.name, version: m.suggestion.version });
          } catch (error) {
            say(`Could not install ${m.suggestion.name}: ${error.message}`);
          }
        }
      } catch { /* the index or the sketch could not be read: the compiler decides */ }
    }
    let result = await compile();
    for (let round = 0; round < 3 && canInstall && result && !result.success; round++) {
      const found = await this.libraries.installForMissingHeaders(result.error || '', { fqbn, max: 2, onOutput: onLine || undefined })
        .catch(() => ({ installed: [], unresolved: [] }));
      if (!found.installed.length) break;
      for (const lib of found.installed) say(`Installed ${lib.name}${lib.version ? ` ${lib.version}` : ''} for ${lib.header}.`);
      installed.push(...found.installed);
      result = await compile();
    }
    return installed.length && result ? { ...result, installedLibraries: installed } : result;
  }

  /** One compile for the simulator, no library handling. */
  _compileHexOnce(sketchPath, boardFQBN, options = {}) {
    const os = require('os');
    const fs = require('fs');
    // ESP32 boards run in Espressif's QEMU: a flash image built with the simulator bridge.
    if (/^(esp32|arduino):esp32:/.test(boardFQBN) && this.esp32sim) {
      return this.esp32sim.build(this.sketchDir(sketchPath), boardFQBN).then((res) => {
        if (res.success || !res.missingCore) return res;
        return { ...res, error: ArduinoService.explainToolchainError(res.error) || res.error, missingCore: extraCoreFor(boardFQBN) || undefined };
      });
    }
    const outputDir = path.join(os.tmpdir(), `impulse-hex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(outputDir, { recursive: true });
    const properties = Object.entries(options?.properties || {})
      .filter(([k, v]) => k === 'build.f_cpu' && /^\d{6,9}L?$/.test(String(v)))
      .flatMap(([k, v]) => ['--build-property', `${k}=${v}`]);

    return new Promise((resolve) => {
      const args = [
        'compile',
        '--fqbn', boardFQBN,
        ...properties,
        '--output-dir', outputDir,
        sketchPath,
      ];

      // The first build for a Pico compiles its whole core.
      const proc = spawn(this.cliPath, args, { cwd: path.dirname(sketchPath), timeout: /^rp2040:/.test(boardFQBN) ? 600000 : 120000 });
      let stderr = '';

      proc.stderr.on('data', d => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code !== 0) {
          fs.rmSync(outputDir, { recursive: true, force: true });
          // A simulated board whose core isn't installed yet: the simulator offers to install it.
          const missingCore = /platform not installed|Platform '.+' not found/i.test(stderr) ? extraCoreFor(boardFQBN) || undefined : undefined;
          resolve({ success: false, error: ArduinoService.explainToolchainError(stderr) || stderr, missingCore });
          return;
        }
        const files = fs.readdirSync(outputDir);
        // RP2040 boards: the UF2 flash image.
        if (/^rp2040:/.test(boardFQBN)) {
          const uf2File = files.find(f => f.endsWith('.uf2'));
          const uf2 = uf2File ? new Uint8Array(fs.readFileSync(path.join(outputDir, uf2File))) : null;
          fs.rmSync(outputDir, { recursive: true, force: true });
          resolve(uf2 ? { success: true, uf2 } : { success: false, error: 'No .uf2 output found' });
          return;
        }
        // The application image, not the copy merged with the bootloader.
        const hexFile = files.find(f => f.endsWith('.hex') && !f.endsWith('.with_bootloader.hex'));
        if (!hexFile) {
          fs.rmSync(outputDir, { recursive: true, force: true });
          resolve({ success: false, error: 'No .hex output found' });
          return;
        }
        const hex = fs.readFileSync(path.join(outputDir, hexFile), 'utf8');
        fs.rmSync(outputDir, { recursive: true, force: true });
        resolve({ success: true, hex });
      });

      proc.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });
    });
  }

  /**
   * Compile for the simulator's debugger: -Og without link-time optimization,
   * so every sketch line keeps its code and variables keep their locations.
   * Builds in a folder of its own so these objects never mix with normal
   * (LTO) builds of the same sketch.
   * @returns {Promise<{ success: boolean, hex?: string, elf?: Uint8Array, sketchDirs?: string[],
   *   buildSketchDirs?: string[], error?: string }>}
   */
  async compileDebug(sketchPath, boardFQBN) {
    const os = require('os');
    const fsSync = require('fs');
    const crypto = require('crypto');
    // Both spellings of each folder: the compiler records real paths (/private/var/… for /var/… on macOS).
    const both = (p) => { try { return [...new Set([p, fsSync.realpathSync.native(p)])]; } catch { return [p]; } };
    const pioRoot = this.platformioRoot(sketchPath);
    if (pioRoot) {
      const res = await this.platformio.build(pioRoot, { fqbn: boardFQBN, debug: true });
      if (!res.success) return { success: false, error: res.error };
      if (!res.hex || !res.elf) return { success: false, error: 'PlatformIO produced no firmware' };
      return { success: true, hex: res.hex, elf: res.elf, sketchDirs: both(pioRoot), buildSketchDirs: [] };
    }
    if (!this.validateFQBN(boardFQBN)) return { success: false, error: `Invalid board: "${boardFQBN}"` };
    if (!/^(arduino|ATTinyCore):avr:/.test(boardFQBN)) return { success: false, error: 'The debugger runs the simulated AVR boards (Uno, Nano, Mega, ATtiny85).' };
    const dir = this.sketchDir(sketchPath);
    const key = crypto.createHash('sha1').update(`${dir}\n${boardFQBN}`).digest('hex').slice(0, 16);
    const buildPath = path.join(os.tmpdir(), 'impulse-debug-builds', key);
    const outputDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'impulse-debug-'));
    const properties = [
      'compiler.c.extra_flags=-Og -fno-lto',
      'compiler.cpp.extra_flags=-Og -fno-lto',
      'compiler.S.extra_flags=-fno-lto',
      'compiler.c.elf.extra_flags=-Og',
    ];
    try {
      const result = await this.runCommand([
        'compile', '--fqbn', boardFQBN, '--build-path', buildPath,
        ...properties.flatMap(p => ['--build-property', p]),
        '--output-dir', outputDir, dir,
      ], { cwd: dir, timeout: 180000 });
      if (!result.success) {
        const missingCore = /platform not installed|Platform '.+' not found/i.test(result.stderr) ? extraCoreFor(boardFQBN) || undefined : undefined;
        return { success: false, error: ArduinoService.explainToolchainError(result.stderr) || result.stderr.trim() || 'Compile failed', missingCore };
      }
      const files = fsSync.readdirSync(outputDir);
      const hexFile = files.find(f => f.endsWith('.hex') && !f.endsWith('.with_bootloader.hex'));
      const elfFile = files.find(f => f.endsWith('.elf'));
      if (!hexFile || !elfFile) return { success: false, error: 'The compiler produced no program' };
      return {
        success: true,
        hex: fsSync.readFileSync(path.join(outputDir, hexFile), 'utf8'),
        elf: new Uint8Array(fsSync.readFileSync(path.join(outputDir, elfFile))),
        sketchDirs: both(dir),
        buildSketchDirs: both(path.join(buildPath, 'sketch')),
      };
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      fsSync.rmSync(outputDir, { recursive: true, force: true });
    }
  }

  /**
   * Translate known toolchain failures into an actionable message.
   * @returns {string|null}
   */
  static explainToolchainError(text) {
    if (!text) return null;
    if (/bad CPU type in executable/i.test(text)) {
      return 'The installed board toolchain is built for Intel Macs and needs Rosetta 2. ' +
        'Install it with: softwareupdate --install-rosetta --agree-to-license, then try again.';
    }
    if (/platform not installed|Platform '.+' not found/i.test(text)) {
      return 'The core for this board is not installed. Open Board Manager and install it, then try again.';
    }
    return null;
  }

  sketchDir(sketchPath) {
    return sketchPath.toLowerCase().endsWith('.ino') ? path.dirname(sketchPath) : sketchPath;
  }

  /**
   * Compile and export the .hex/.bin/.elf next to the sketch (sketch/build/<fqbn>/).
   */
  async exportBinaries(sketchPath, boardFQBN) {
    const pioRoot = this.platformioRoot(sketchPath);
    if (pioRoot) {
      const res = await this.platformio.build(pioRoot);
      if (!res.success) return { success: false, error: res.error };
      const outputDir = await this.platformio.buildOutputDir(pioRoot, res.env);
      const files = require('fs').readdirSync(outputDir).filter(f => /^firmware\./.test(f));
      return { success: true, outputDir, files };
    }
    if (!this.validateFQBN(boardFQBN)) return { success: false, error: 'Select a board first.' };
    const dir = this.sketchDir(sketchPath);
    const result = await this.runCommand(['compile', '--fqbn', boardFQBN, '--export-binaries', dir], { cwd: dir, timeout: 180000 });
    if (!result.success) {
      return { success: false, error: ArduinoService.explainToolchainError(result.stderr) || result.stderr.trim() || 'Export failed' };
    }
    const outputDir = path.join(dir, 'build', boardFQBN.split(':').slice(0, 3).join('.'));
    let files = [];
    try { files = (await fs.readdir(outputDir)).filter(f => /\.(hex|bin|elf|eep|uf2)$/i.test(f)); } catch { /* listed below as empty */ }
    return { success: true, outputDir, files };
  }

  /**
   * Zip the sketch folder with `arduino-cli sketch archive`.
   */
  async archiveSketch(sketchPath, destinationZip) {
    const dir = this.sketchDir(sketchPath);
    const result = await this.runCommand(['sketch', 'archive', dir, destinationZip], { timeout: 120000 });
    if (!result.success) return { success: false, error: result.stderr.trim() || 'Archive failed' };
    return { success: true, archivePath: destinationZip };
  }

  /**
   * A board's menu options (USB CDC On Boot, Flash Size, PSRAM, CPU…), as
   * Arduino IDE shows them under Tools.
   * @returns {Promise<{ option: string, label: string, values: { value: string, label: string, isDefault: boolean }[] }[]>}
   */
  async boardOptions(boardFQBN) {
    const base = String(boardFQBN || '').split(':').slice(0, 3).join(':');
    if (!this.validateFQBN(base)) return [];
    this._optionCache = this._optionCache || new Map();
    if (this._optionCache.has(base)) return this._optionCache.get(base);
    const result = await this.runCommand(['board', 'details', '-b', base, '--format', 'json']);
    if (!result.success) return [];
    try {
      const data = JSON.parse(result.stdout);
      const options = (data.config_options || []).filter(o => o && o.option && Array.isArray(o.values)).map(o => ({
        option: o.option,
        label: o.option_label || o.option,
        values: o.values.map(v => ({ value: v.value, label: v.value_label || v.value, isDefault: !!v.selected }))
      }));
      this._optionCache.set(base, options);
      return options;
    } catch {
      return [];
    }
  }

  /**
   * Programmers available for a board (e.g. AVRISP mkII, USBasp).
   * @returns {Promise<{id: string, name: string}[]>}
   */
  async listProgrammers(boardFQBN) {
    if (!this.validateFQBN(boardFQBN)) return [];
    const result = await this.runCommand(['board', 'details', '-b', boardFQBN, '--format', 'json']);
    if (!result.success) return [];
    try {
      const data = JSON.parse(result.stdout);
      return (data.programmers || []).filter(p => p && p.id).map(p => ({ id: p.id, name: p.name || p.id }));
    } catch {
      return [];
    }
  }

  /**
   * Compile and upload through an external programmer (ISP).
   */
  async uploadWithProgrammer(sketchPath, boardFQBN, programmerId, port) {
    if (!this.validateFQBN(boardFQBN)) return { success: false, error: 'Select a board first.' };
    const dir = this.sketchDir(sketchPath);
    const args = ['compile', '--fqbn', boardFQBN, '--upload', '--programmer', programmerId, '--verbose'];
    if (port) args.push('--port', port);
    args.push(dir);
    try {
      return await this.jobs.run({ kind: 'upload', sketchPath, fqbn: boardFQBN, port: port || null, label: `programmer ${programmerId}` }, async (job) => {
        job.stage('compiling');
        const { code, output, reason } = await this._runStreaming(job, args, { cwd: dir, idleMs: this.timeouts.uploadIdleMs, maxMs: this.timeouts.uploadMaxMs });
        const memory = parseMemory(output);
        if (code === 0) return { success: true, output, memory, summary: summaryLines(memory), message: `Uploaded with ${programmerId}` };
        throw this._failure(output, 'upload', { reason, code, memory, fqbn: boardFQBN });
      });
    } catch (error) {
      const handled = this._handled(error, 'Arduino Upload (programmer)', { sketchPath, boardFQBN, programmerId });
      return { success: false, error: [handled.title, handled.hint].filter(Boolean).join(' '), code: handled.code, output: handled.output };
    }
  }

  /**
   * Hardware details for a connected port (VID/PID, serial number, matching boards).
   */
  async boardInfo(port) {
    const result = await this.runCommand(['board', 'list', '--format', 'json']);
    if (!result.success) return { success: false, error: result.stderr.trim() || 'Could not list boards' };
    try {
      const data = JSON.parse(result.stdout);
      const list = data.detected_ports || data.ports || data;
      const entry = (Array.isArray(list) ? list : []).find(item => (item.port || item)?.address === port);
      if (!entry) return { success: false, error: `No device found on ${port}. Is it still plugged in?` };
      const p = entry.port || entry;
      const props = p.properties || {};
      return {
        success: true,
        info: {
          port: p.address,
          protocol: p.protocol_label || p.protocol || 'serial',
          vid: props.vid || null,
          pid: props.pid || null,
          serialNumber: props.serialNumber || null,
          boards: (entry.matching_boards || []).map(b => ({ name: b.name, fqbn: b.fqbn }))
        }
      };
    } catch {
      return { success: false, error: 'Could not read board list output' };
    }
  }

  /**
   * Compile and upload as one build job (a compiling stage, then an uploading
   * stage), so nothing announces "compiled" while the upload is still to come
   * and a second request joins the running one. Resolves with the result or
   * with `{ success: false, code, title, hint, ... }` (never throws).
   */
  async upload(sketchPath, boardFQBN, port) {
    try {
      return await this.jobs.run({ kind: 'upload', sketchPath, fqbn: boardFQBN, port }, async (job) => {
        const compiled = this.platformioRoot(sketchPath) ? null : await this._compileJob(job, sketchPath, boardFQBN);
        // The monitor holds the same port: close it here and reopen afterwards,
        // so every upload path (IDE, chat, agent) behaves like Arduino IDE.
        const held = this.serialMonitor ? await this.serialMonitor.holdForUpload() : false;
        try {
          return await this._uploadJob(job, sketchPath, boardFQBN, port, compiled);
        } finally {
          if (held) this.serialMonitor.resumeAfterUpload({ port }).catch(() => {});
        }
      });
    } catch (error) {
      return this._handled(error, 'Arduino Upload', { sketchPath, boardFQBN, port });
    }
  }

  /**
   * Upload without compiling first (the sketch was compiled already). Throws on failure.
   */
  async uploadOnly(sketchPath, boardFQBN, port) {
    if (!sketchPath || !boardFQBN || !port) throw new Error('Sketch path, board FQBN, and port are required');
    return this.jobs.run({ kind: 'upload', sketchPath, fqbn: boardFQBN, port }, (job) => this._uploadJob(job, sketchPath, boardFQBN, port));
  }

  // ==================== Library Operations ====================

  /**
   * Update the library index (call before search for fresh results)
   */
  async libUpdateIndex() {
    const result = await this.runCommand(['lib', 'update-index']);
    return result.success;
  }

  /**
   * Search for libraries. Returns { libraries: [{ name, author, version, sentence, paragraph, category, available_versions }] }
   */
  async libSearch(query) {
    const q = query != null ? String(query).trim() : '';
    if (!q) return { libraries: [] };
    return new Promise((resolve, reject) => {
      const args = ['lib', 'search', '--format', 'json', '--omit-releases-details', q];
      const proc = spawn(this.cliPath, args);
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', code => {
        if (code !== 0) {
          reject(new Error(stderr || 'Library search failed'));
          return;
        }
        try {
          const data = JSON.parse(stdout);
          const libs = (data.libraries || []).slice(0, 100).map(lib => ({
            name: lib.name,
            author: lib.latest?.author || '',
            version: lib.latest?.version || (lib.available_versions && lib.available_versions[0]) || '',
            sentence: lib.latest?.sentence || '',
            paragraph: lib.latest?.paragraph || '',
            category: lib.latest?.category || 'Uncategorized',
            website: lib.latest?.website || '',
            available_versions: lib.available_versions || []
          }));
          resolve({ libraries: libs });
        } catch (e) {
          reject(new Error(`Failed to parse lib search: ${e.message}`));
        }
      });
      proc.on('error', err => reject(new Error(`Failed to run: ${err.message}`)));
    });
  }

  /**
   * Install a library. libSpec = "Name" or "Name@1.0.0"
   */
  async libInstall(libSpec) {
    const spec = String(libSpec || '').trim();
    if (!spec) throw new Error('Library name is required');
    return new Promise((resolve, reject) => {
      const args = ['lib', 'install', '--format', 'json', spec];
      const proc = spawn(this.cliPath, args);
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', code => {
        if (code === 0) {
          resolve({ success: true, output: stdout + stderr });
        } else {
          reject(new Error(stderr || stdout || `Install failed with code ${code}`));
        }
      });
      proc.on('error', err => reject(new Error(`Failed to run: ${err.message}`)));
    });
  }

  /**
   * List installed libraries. Returns { installed_libraries: [{ name, author, version, sentence, ... }] }
   */
  async libList() {
    const result = await this.runCommand(['lib', 'list', '--format', 'json']);
    if (!result.success) {
      throw new Error(result.stderr || 'Library list failed');
    }
    try {
      const data = JSON.parse(result.stdout);
      const libs = (data.installed_libraries || []).map(item => {
        const lib = item.library || item;
        return {
          name: lib.name,
          author: lib.author || '',
          version: lib.version || '',
          sentence: lib.sentence || '',
          paragraph: lib.paragraph || '',
          category: lib.category || 'Uncategorized',
          website: lib.website || '',
          install_dir: lib.install_dir
        };
      });
      return { installed_libraries: libs };
    } catch (e) {
      throw new Error(`Failed to parse lib list: ${e.message}`);
    }
  }

  /**
   * Uninstall a library by name
   */
  async libUninstall(libName) {
    const name = String(libName || '').trim();
    if (!name) throw new Error('Library name is required');
    const result = await this.runCommand(['lib', 'uninstall', name]);
    if (!result.success) {
      throw new Error(result.stderr || result.stdout || 'Uninstall failed');
    }
    return { success: true };
  }

  // ==================== Core / Board Manager ====================

  /**
   * Search installable cores (Boards Manager). Keyword optional.
   * Returns [{ id, name, latest, installed }] or similar.
   */
  async coreSearch(keyword = '') {
    await this.ensureCoreIndexed();
    const args = ['core', 'search', '--format', 'json'];
    if (keyword && String(keyword).trim()) args.push(String(keyword).trim());
    const result = await this.runCommand(args);
    if (!result.success) {
      throw new Error(result.stderr || 'Core search failed');
    }
    try {
      const data = JSON.parse(result.stdout);
      const raw = Array.isArray(data) ? data : (data?.platforms || data?.cores || data?.results || []);
      return this._normalizeCoreSearchResults(raw);
    } catch (e) {
      throw new Error(`Parse core search: ${e.message}`);
    }
  }

  _normalizeCoreSearchResults(platforms) {
    if (!Array.isArray(platforms)) return [];
    return platforms.map(p => {
      const id = p.id || p.platform?.id || '';
      const releases = p.releases || {};
      const versions = Object.keys(releases);
      const latestVer = versions.length ? versions[versions.length - 1] : '';
      const release = latestVer ? releases[latestVer] : null;
      const name = release?.name || p.name || p.platform?.name || id;
      return { id, name, latest: latestVer };
    }).filter(p => p.id);
  }

  /**
   * List installed cores. Returns array of { id, name, installed, latest }.
   */
  async coreList() {
    const result = await this.runCommand(['core', 'list', '--format', 'json']);
    if (!result.success) {
      return [];
    }
    try {
      const data = JSON.parse(result.stdout);
      const raw = Array.isArray(data) ? data : (data?.installed_platforms || data?.platforms || []);
      return Array.isArray(raw) ? raw.map(p => ({
        id: p.id || p.platform?.id || p.name,
        name: p.name || p.platform?.name || p.id,
        installed: p.installed || p.version || ''
      })) : [];
    } catch (e) {
      console.warn('Parse core list:', e.message);
      return [];
    }
  }

  /**
   * Install a core. coreId e.g. "arduino:avr", "esp32:esp32"
   */
  async coreInstall(coreId) {
    const id = String(coreId || '').trim();
    if (!id) throw new Error('Core ID is required (e.g. arduino:avr or esp32:esp32)');
    return new Promise((resolve, reject) => {
      const args = ['core', 'install', '--format', 'json', id];
      const proc = spawn(this.cliPath, args);
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', code => {
        if (code === 0) {
          this.coreIndexed = true;
          resolve({ success: true, output: stdout + stderr });
        } else {
          reject(new Error(stderr || stdout || `Core install failed with code ${code}`));
        }
      });
      proc.on('error', err => reject(new Error(`Failed to run: ${err.message}`)));
    });
  }

  /**
   * Uninstall a core. coreId e.g. "arduino:avr", "esp32:esp32"
   */
  async coreUninstall(coreId) {
    const id = String(coreId || '').trim();
    if (!id) throw new Error('Core ID is required');
    const result = await this.runCommand(['core', 'uninstall', id]);
    if (!result.success) {
      throw new Error(result.stderr || result.stdout || 'Core uninstall failed');
    }
    return { success: true };
  }

  /**
   * List example sketches. If libraryName is given, only that library's examples.
   * Returns array of { name, library, path } or similar (path to example folder).
   */
  async libExamples(libraryName = '') {
    const args = ['lib', 'examples'];
    if (libraryName && String(libraryName).trim()) args.push(String(libraryName).trim());
    args.push('--format', 'json');
    const result = await this.runCommand(args);
    if (!result.success) {
      try {
        const text = (result.stdout || result.stderr || '').trim();
        if (!text) return [];
        return this._parseLibExamplesText(text);
      } catch (_) {
        return [];
      }
    }
    try {
      const data = JSON.parse(result.stdout);
      if (Array.isArray(data)) return data;
      if (data.examples && Array.isArray(data.examples)) return data.examples;
      return [];
    } catch (e) {
      return this._parseLibExamplesText(result.stdout || '');
    }
  }

  _parseLibExamplesText(text) {
    const out = [];
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let currentLib = '';
    for (const line of lines) {
      if (line.includes(' ') && (line.endsWith('.ino') || line.includes('/') || line.includes('\\'))) {
        const path = line.replace(/^[\s\S]*?\s+/, '').trim();
        if (path) out.push({ name: path.split(/[/\\]/).pop() || path, library: currentLib, path });
      } else if (line) {
        currentLib = line;
      }
    }
    return out;
  }

  /**
   * Get all library examples with full paths (using install_dir from lib list + fs).
   * Returns [{ name, library, path }] where path is the example folder.
   */
  async libExamplesWithPaths(libraryFilter = '') {
    const libList = await this.libList();
    const libs = libList.installed_libraries || [];
    const results = [];
    for (const lib of libs) {
      const installDir = lib.install_dir || lib.installDir;
      if (!installDir || (libraryFilter && !lib.name.toLowerCase().includes(String(libraryFilter).toLowerCase()))) continue;
      const examplesDir = path.join(installDir, 'examples');
      try {
        const entries = await fs.readdir(examplesDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) {
            const examplePath = path.join(examplesDir, e.name);
            results.push({ name: e.name, library: lib.name, path: examplePath });
          }
        }
      } catch (_) {
        // no examples folder or not readable
      }
    }
    return results.sort((a, b) => (a.library + a.name).localeCompare(b.library + b.name));
  }
}

module.exports = ArduinoService;

