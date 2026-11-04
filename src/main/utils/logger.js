/**
 * Simple logger with DEBUG flag. When DEBUG is set, logs function entry/exit and variable values.
 * Set IMPULSE_IDE_DEBUG=1 in environment to enable.
 * @module main/utils/logger
 */

const fs = require('fs');
const path = require('path');

const DEBUG = process.env.IMPULSE_IDE_DEBUG === '1' || process.env.IMPULSE_IDE_DEBUG === 'true';
const MAX_LOG_BYTES = 1024 * 1024;

let logFile;
function getLogFile() {
  if (logFile !== undefined) return logFile;
  try {
    const { app } = require('electron');
    logFile = app && typeof app.getPath === 'function' ? path.join(app.getPath('logs'), 'impulse.log') : null;
    if (logFile) fs.mkdirSync(path.dirname(logFile), { recursive: true });
  } catch {
    logFile = null;
  }
  return logFile;
}

/** Warnings and errors also go to <logs>/impulse.log (rotated at 1 MB). */
function writeToFile(level, line) {
  const file = getLogFile();
  if (!file) return;
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${level.toUpperCase()} ${line}\n`);
  } catch { /* logging must never throw */ }
}

/**
 * Internal log helper. Always logs (respects level).
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} message
 * @param {Record<string, unknown>} [vars]
 */
function _log(level, message, vars = undefined) {
  let payload = '';
  if (vars) {
    try { payload = ` ${JSON.stringify(vars)}`; } catch { payload = ' [unserializable]'; }
  }
  const fn = console[level] || console.log;
  fn.call(console, `[ImpulseIDE] ${message}${payload}`);
  if (level === 'warn' || level === 'error') writeToFile(level, `${message}${payload}`);
}

/**
 * Log a debug message and optional payload. No-op when DEBUG is false.
 * @param {string} message - Log message (e.g. "ipc:arduino:compile entry")
 * @param {Record<string, unknown>} [vars] - Optional key/value object to log (e.g. { sketchPath, boardFQBN })
 */
function debug(message, vars = undefined) {
  if (!DEBUG) return;
  _log('debug', message, vars);
}

/**
 * Log an info message.
 */
function info(message, vars = undefined) {
  _log('info', message, vars);
}

/**
 * Log a warning message.
 */
function warn(message, vars = undefined) {
  _log('warn', message, vars);
}

/**
 * Log an error message. Always logs regardless of DEBUG flag.
 */
function error(message, vars = undefined) {
  _log('error', message, vars);
}

/**
 * Wrap an async handler to log entry/exit and elapsed time when DEBUG is set.
 * @param {string} label - Handler label (e.g. "arduino:compile")
 * @param {(...args: unknown[]) => Promise<{ success: boolean }>} handler - Async IPC handler
 * @returns {(...args: unknown[]) => Promise<{ success: boolean }>} Wrapped handler
 */
function withDebugLog(label, handler) {
  return async (...args) => {
    if (!DEBUG) {
      try {
        return await handler(...args);
      } catch (err) {
        error(`ipc ${label} threw`, { error: err?.message });
        throw err;
      }
    }
    const start = Date.now();
    debug(`${label} entry`, { args: args?.length });
    try {
      const result = await handler(...args);
      debug(`${label} exit`, { durationMs: Date.now() - start, success: result?.success });
      return result;
    } catch (err) {
      debug(`${label} error`, { durationMs: Date.now() - start, error: err?.message });
      throw err;
    }
  };
}

module.exports = { DEBUG, debug, info, warn, error, withDebugLog, getLogFile };
