const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { approveDirectory, onApprovedRootsChange } = require('../utils/pathValidator');

const MAX_ROOTS = 40;
const MAX_RECENT = 10;

/**
 * Remembers folders the user approved through native dialogs so a restored
 * session can reopen them without widening access. Only the main process
 * writes to this store; the renderer can never add a folder to it.
 */
class WorkspaceStore extends EventEmitter {
  /** @param {{ get: Function, set: Function }} [store] electron-store compatible */
  constructor(store) {
    super();
    this.store = store || new (require('electron-store'))({ name: 'workspace' });
  }

  restore() {
    const roots = this.store.get('approvedRoots', []);
    for (const root of Array.isArray(roots) ? roots : []) {
      if (root && typeof root.path === 'string' && fs.existsSync(root.path)) {
        approveDirectory(root.path, { readOnly: !!root.readOnly, silent: true });
      }
    }
    onApprovedRootsChange((all) => this.store.set('approvedRoots', all.slice(-MAX_ROOTS)));
  }

  addRecent(folderPath) {
    if (!folderPath || typeof folderPath !== 'string') return;
    const resolved = path.resolve(folderPath);
    const recent = this.getRecent().filter(p => p !== resolved);
    recent.unshift(resolved);
    this.store.set('recentFolders', recent.slice(0, MAX_RECENT));
    this.emit('recent-changed', this.getRecent());
  }

  getRecent() {
    const list = this.store.get('recentFolders', []);
    return (Array.isArray(list) ? list : []).filter(p => typeof p === 'string' && fs.existsSync(p));
  }

  clearRecent() {
    this.store.set('recentFolders', []);
    this.emit('recent-changed', []);
  }

  /**
   * One-time bridge for sessions saved by versions before folder approval was
   * persisted: approve those folders once, then never accept this again.
   * @param {string[]} folderPaths
   * @returns {string[]} folders that were approved
   */
  migrateLegacySession(folderPaths) {
    if (this.store.get('legacySessionMigrated', false)) return [];
    this.store.set('legacySessionMigrated', true);
    const approved = [];
    for (const p of (Array.isArray(folderPaths) ? folderPaths : []).slice(0, 20)) {
      if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
      try {
        if (!fs.statSync(p).isDirectory()) continue;
      } catch {
        continue;
      }
      approveDirectory(p);
      approved.push(p);
    }
    if (approved[0]) this.addRecent(approved[0]);
    return approved;
  }

  /** A folder may be reopened from the menu only if it's on the recent list. */
  isRecent(folderPath) {
    return this.getRecent().includes(path.resolve(folderPath));
  }
}

module.exports = WorkspaceStore;
