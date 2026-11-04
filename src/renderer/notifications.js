/**
 * Notification UI Component for Renderer Process
 * Handles displaying notifications to the user
 */

class NotificationUI {
  constructor() {
    this.notifications = new Map();
    this.container = null;
    this.init();
  }

  init() {
    // Create notification container
    this.container = document.createElement('div');
    this.container.id = 'notification-container';
    this.container.className = 'notification-container';
    document.body.appendChild(this.container);

    // Listen for notification events from main process
    if (window.electronAPI) {
      window.electronAPI.onNotification('notification:show', (notification) => {
        this.show(notification);
      });

      window.electronAPI.onNotification('notification:update', (notification) => {
        this.update(notification);
      });

      window.electronAPI.onNotification('notification:dismiss', ({ id }) => {
        this.dismiss(id);
      });

      window.electronAPI.onNotification('notification:dismissAll', () => {
        this.dismissAll();
      });
    }
  }

  show(notification) {
    // Chat mode has its own toast: plain messages go there. Cards with
    // actions or progress (a crash report, the tour, a download) keep this one.
    if (document.documentElement.dataset.shell === 'vibe' && !notification.actions?.length && !notification.persistent && notification.type !== 'progress') {
      window.dispatchEvent(new CustomEvent('impulse:notify', { detail: notification }));
      return;
    }
    const element = this.createElement(notification);
    this.notifications.set(notification.id, { ...notification, element });
    this.container.appendChild(element);

    // Animate in
    requestAnimationFrame(() => {
      element.classList.add('show');
    });

    // Auto-dismiss if not persistent
    if (!notification.persistent && notification.duration > 0) {
      setTimeout(() => {
        this.dismiss(notification.id);
      }, notification.duration);
    }
  }

  update(notification) {
    const existing = this.notifications.get(notification.id);
    if (existing) {
      // Update content
      const messageEl = existing.element.querySelector('.notification-message');
      if (messageEl) {
        messageEl.textContent = notification.message;
      }

      // Update progress if it's a progress notification
      if (notification.type === 'progress') {
        const progressEl = existing.element.querySelector('.notification-progress-fill');
        if (progressEl) {
          progressEl.style.width = `${notification.progress}%`;
        }
      }

      // Update stored notification
      this.notifications.set(notification.id, { ...existing, ...notification });
    }
  }

  dismiss(id) {
    const notification = this.notifications.get(id);
    if (notification) {
      // Animate out
      notification.element.classList.add('hide');
      
      setTimeout(() => {
        if (notification.element.parentNode) {
          notification.element.parentNode.removeChild(notification.element);
        }
        this.notifications.delete(id);
      }, 300);
    }
  }

  dismissAll() {
    this.notifications.forEach((_, id) => {
      this.dismiss(id);
    });
  }

  escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  }

  createElement(notification) {
    const element = document.createElement('div');
    element.className = `notification notification-${this.escapeHtml(notification.type)}`;
    element.setAttribute('data-id', notification.id);

    const icon = notification.icon || this.getDefaultIcon(notification.type);
    
    let progressBar = '';
    if (notification.type === 'progress') {
      const progress = parseInt(notification.progress, 10) || 0;
      progressBar = `
        <div class="notification-progress">
          <div class="notification-progress-fill" style="width: ${Math.min(100, Math.max(0, progress))}%"></div>
        </div>
      `;
    }

    let actions = '';
    if (notification.actions && notification.actions.length > 0) {
      actions = `
        <div class="notification-actions">
          ${notification.actions.map(action => 
            `<button class="notification-action" data-action="${this.escapeHtml(action.id)}">${this.escapeHtml(action.label)}</button>`
          ).join('')}
        </div>
      `;
    }

    element.innerHTML = `
      <div class="notification-content">
        <div class="notification-header">
          <span class="notification-icon">${icon}</span>
          <span class="notification-title">${this.escapeHtml(notification.title)}</span>
          <button class="notification-close" data-action="close" aria-label="Dismiss">×</button>
        </div>
        <div class="notification-message">${this.escapeHtml(notification.message)}</div>
        ${progressBar}
        ${actions}
      </div>
    `;

    // Add event listeners
    element.addEventListener('click', (e) => {
      const action = e.target.getAttribute('data-action');
      if (action === 'close') {
        this.dismiss(notification.id);
      } else if (action && notification.actions) {
        const actionConfig = notification.actions.find(a => a.id === action);
        if (actionConfig && actionConfig.callback) {
          actionConfig.callback();
        }
        if (!actionConfig || !actionConfig.persistent) {
          this.dismiss(notification.id);
        }
      }
    });

    return element;
  }

  getDefaultIcon(type) {
    const icons = {
      success: '✓',
      error: '✗',
      warning: '⚠',
      info: 'ℹ',
      progress: '⏳'
    };
    return icons[type] || 'ℹ';
  }

  // Client-side notification methods
  success(message, options = {}) {
    return this.show({
      id: `client_${Date.now()}`,
      type: 'success',
      title: 'Success',
      message,
      duration: 3000,
      ...options
    });
  }

  error(message, options = {}) {
    return this.show({
      id: `client_${Date.now()}`,
      type: 'error',
      title: 'Error',
      message,
      duration: 5000,
      ...options
    });
  }

  warning(message, options = {}) {
    return this.show({
      id: `client_${Date.now()}`,
      type: 'warning',
      title: 'Warning',
      message,
      duration: 4000,
      ...options
    });
  }

  info(message, options = {}) {
    return this.show({
      id: `client_${Date.now()}`,
      type: 'info',
      title: 'Information',
      message,
      duration: 3000,
      ...options
    });
  }
}

// Create global instance
window.notifications = new NotificationUI();

// Export for module use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = NotificationUI;
}