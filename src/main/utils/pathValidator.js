/**
 * Path Validator Utility
 * Restricts filesystem access to directories the user approved through a
 * native dialog (or the app approved itself, e.g. library examples).
 * Default is deny: with nothing approved, nothing is accessible.
 * @module main/utils/pathValidator
 */

const path = require('path');
const fs = require('fs');

/** root (real path) -> { readOnly } */
const approvedRoots = new Map();
const changeListeners = new Set();

/**
 * Resolve symlinks so a link inside an approved folder can't point outside it.
 * For paths that don't exist yet (new files), resolve the nearest existing parent.
 */
function realResolve(p) {
  const resolved = path.resolve(p);
  let current = resolved;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function notify() {
  for (const fn of changeListeners) {
    try { fn(getApprovedRoots()); } catch { /* listener errors must not break approval */ }
  }
}

/**
 * Register a directory as approved.
 * @param {string} dirPath - Absolute path to approve
 * @param {{ readOnly?: boolean, silent?: boolean }} [options]
 */
function approveDirectory(dirPath, options = {}) {
  if (!dirPath || typeof dirPath !== 'string') return;
  const root = realResolve(dirPath);
  const existing = approvedRoots.get(root);
  const readOnly = !!options.readOnly && (!existing || existing.readOnly);
  approvedRoots.set(root, { readOnly });
  if (!options.silent) notify();
}

/**
 * Remove an approved directory.
 * @param {string} dirPath - Absolute path to revoke
 */
function revokeDirectory(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return;
  approvedRoots.delete(realResolve(dirPath));
  approvedRoots.delete(path.resolve(dirPath));
  notify();
}

/** @returns {string[]} */
function getApprovedDirectories() {
  return Array.from(approvedRoots.keys());
}

/** @returns {{ path: string, readOnly: boolean }[]} */
function getApprovedRoots() {
  return Array.from(approvedRoots, ([p, v]) => ({ path: p, readOnly: v.readOnly }));
}

/** @param {(roots: {path: string, readOnly: boolean}[]) => void} fn */
function onApprovedRootsChange(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Validate that a path is safe and within an approved directory.
 * @param {string} filePath - Path to validate
 * @param {{ write?: boolean }} [options] - write access needs a writable root
 * @returns {{ valid: boolean, resolved: string, error?: string }}
 */
function validatePath(filePath, options = {}) {
  if (!filePath || typeof filePath !== 'string') {
    return { valid: false, resolved: '', error: 'Path is required' };
  }
  if (filePath.includes('\0')) {
    return { valid: false, resolved: '', error: 'Path must not contain null bytes' };
  }

  const resolved = realResolve(filePath);

  for (const [root, { readOnly }] of approvedRoots) {
    if (!isInside(root, resolved)) continue;
    if (options.write && readOnly) continue;
    return { valid: true, resolved };
  }

  if (options.write && getApprovedRoots().some(r => r.readOnly && isInside(r.path, resolved))) {
    return { valid: false, resolved, error: 'This file is read-only (library example). Use Save As to keep a copy.' };
  }
  return {
    valid: false,
    resolved,
    error: `Access denied: "${resolved}" is outside the folders you opened. Open its folder first.`
  };
}

module.exports = {
  approveDirectory,
  revokeDirectory,
  getApprovedDirectories,
  getApprovedRoots,
  onApprovedRootsChange,
  validatePath
};
