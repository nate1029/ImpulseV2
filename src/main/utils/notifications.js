/**
 * Notification System
 * Provides consistent user notifications across the application
 */

class NotificationManager {
  constructor() {
    this.notifications = new Map();
    this.nextId = 1;
  }

  /**
   * Show a notification to the user
   * @param {Object} options - Notification options
   * @returns {string} Notification ID
   */
  show(options = {}) {
    const {
      type = 'info',
      title = 'Notification',
      message = '',
      duration = 5000,
      actions = [],
      persistent = false,
      icon = null
    } = options;

    const id = `notification_${this.nextId++}`;
    
    const notification = {
      id,
      type,
      title,
      message,
      duration,
      actions,
      persistent,
      icon,
      timestamp: Date.now()
    };

    this.notifications.set(id, notification);

    // Send to renderer
    this.sendToRenderer('notification:show', notification);

    // Auto-dismiss if not persistent
    if (!persistent && duration > 0) {
      setTimeout(() => {
        this.dismiss(id);
      }, duration);
    }

    return id;
  }

  /**
   * Show success notification
   * @param {string} message - Success message
   * @param {Object} options - Additional options
   * @returns {string} Notification ID
   */
  success(message, options = {}) {
    return this.show({
      type: 'success',
      title: 'Success',
      message,
      icon: '✓',
      ...options
    });
  }

  /**
   * Show error notification
   * @param {string} message - Error message
   * @param {Object} options - Additional options
   * @returns {string} Notification ID
   */
  error(message, options = {}) {
    return this.show({
      type: 'error',
      title: 'Error',
      message,
      icon: '✗',
      duration: 8000, // Longer duration for errors
      ...options
    });
  }

  /**
   * Show warning notification
   * @param {string} message - Warning message
   * @param {Object} options - Additional options
   * @returns {string} Notification ID
   */
  warning(message, options = {}) {
    return this.show({
      type: 'warning',
      title: 'Warning',
      message,
      icon: '⚠',
      duration: 6000,
      ...options
    });
  }

  /**
   * Show info notification
   * @param {string} message - Info message
   * @param {Object} options - Additional options
   * @returns {string} Notification ID
   */
  info(message, options = {}) {
    return this.show({
      type: 'info',
      title: 'Information',
      message,
      icon: 'ℹ',
      ...options
    });
  }

  /**
   * Show progress notification
   * @param {string} message - Progress message
   * @param {number} progress - Progress percentage (0-100)
   * @param {Object} options - Additional options
   * @returns {string} Notification ID
   */
  progress(message, progress = 0, options = {}) {
    return this.show({
      type: 'progress',
      title: 'Progress',
      message,
      progress,
      persistent: true,
      ...options
    });
  }

  /**
   * Update progress notification
   * @param {string} id - Notification ID
   * @param {number} progress - New progress percentage
   * @param {string} message - Optional new message
   */
  updateProgress(id, progress, message = null) {
    const notification = this.notifications.get(id);
    if (notification && notification.type === 'progress') {
      notification.progress = progress;
      if (message) {
        notification.message = message;
      }
      this.sendToRenderer('notification:update', notification);
    }
  }

  /**
   * Dismiss a notification
   * @param {string} id - Notification ID
   */
  dismiss(id) {
    if (this.notifications.has(id)) {
      this.notifications.delete(id);
      this.sendToRenderer('notification:dismiss', { id });
    }
  }

  /**
   * Dismiss all notifications
   */
  dismissAll() {
    this.notifications.clear();
    this.sendToRenderer('notification:dismissAll');
  }

  /**
   * Get all active notifications
   * @returns {Array} Array of notifications
   */
  getAll() {
    return Array.from(this.notifications.values());
  }

  /**
   * Send notification to renderer process
   * @param {string} channel - IPC channel
   * @param {Object} data - Data to send
   */
  sendToRenderer(channel, data = {}) {
    // This will be set by the main process
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  /**
   * Set the main window reference
   * @param {BrowserWindow} window - Main window
   */
  setMainWindow(window) {
    this.mainWindow = window;
  }
}

// Create singleton instance
const notificationManager = new NotificationManager();

module.exports = notificationManager;