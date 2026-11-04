/**
 * Auto-Updater Service
 * Uses electron-updater for seamless in-app updates from GitHub Releases.
 * 
 * Flow:
 * 1. On app start, checks for updates silently
 * 2. If update found, notifies user via renderer
 * 3. Downloads in background
 * 4. Prompts user to restart when download completes
 */

const { autoUpdater } = require('electron-updater');
const { info, error: logError } = require('../utils/logger');

class AutoUpdaterService {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.updateAvailable = false;
    this.updateDownloaded = false;

    // Configure electron-updater
    autoUpdater.autoDownload = false; // Let user decide
    autoUpdater.autoInstallOnAppQuit = true;
    // Beta builds follow the beta channel; stable builds only see stable releases.
    autoUpdater.allowPrerelease = /-/.test(require('electron').app.getVersion());

    this._bindEvents();
  }

  _bindEvents() {
    autoUpdater.on('checking-for-update', () => {
      info('Checking for updates...');
      this._sendToRenderer('updater:checking');
    });

    autoUpdater.on('update-available', (info) => {
      this.updateAvailable = true;
      this._sendToRenderer('updater:available', {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes
      });
    });

    autoUpdater.on('update-not-available', () => {
      this._sendToRenderer('updater:not-available');
    });

    autoUpdater.on('download-progress', (progress) => {
      this._sendToRenderer('updater:progress', {
        percent: Math.round(progress.percent),
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      this.updateDownloaded = true;
      this._sendToRenderer('updater:downloaded', {
        version: info.version
      });
    });

    autoUpdater.on('error', (err) => {
      logError('Auto-updater error:', { message: err?.message });
      this._sendToRenderer('updater:error', {
        message: err?.message || 'Update check failed'
      });
    });
  }

  /**
   * Check for updates (called on app start and periodically)
   */
  /** Release builds ship app-update.yml; unpacked dev/test builds don't. */
  static canUpdate() {
    const { app } = require('electron');
    if (!app.isPackaged) return false;
    return require('fs').existsSync(require('path').join(process.resourcesPath, 'app-update.yml'));
  }

  async checkForUpdates() {
    if (!AutoUpdaterService.canUpdate()) return { available: false, reason: 'not-a-release-build' };
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      // Silently fail — user is not blocked
      logError('Update check failed:', { message: err?.message });
    }
  }

  /**
   * Start downloading the update
   */
  async downloadUpdate() {
    if (!this.updateAvailable) return;
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      logError('Update download failed:', { message: err?.message });
    }
  }

  /**
   * Quit and install the downloaded update
   */
  quitAndInstall() {
    if (this.updateDownloaded) {
      autoUpdater.quitAndInstall(false, true);
    }
  }

  _sendToRenderer(channel, data = {}) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }
}

module.exports = AutoUpdaterService;
