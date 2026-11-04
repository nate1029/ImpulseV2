/**
 * Accessibility Module
 * Adds ARIA roles, focus trapping, screen reader support,
 * and prefers-reduced-motion handling to the IDE.
 */

class AccessibilityManager {
  constructor() {
    this._focusTrapStack = []; // Stack of trapped modals
    this._announcer = null;
    this.init();
  }

  init() {
    this._createAnnouncer();
    this._applyAriaRoles();
    this._setupFocusTrapping();
    this._setupReducedMotion();
    this._setupKeyboardNavigation();
  }

  // ==================== Screen Reader Announcer ====================

  /**
   * Create a live region for dynamic announcements.
   * Screen readers will read content added to this element.
   */
  _createAnnouncer() {
    this._announcer = document.createElement('div');
    this._announcer.id = 'a11y-announcer';
    this._announcer.setAttribute('role', 'status');
    this._announcer.setAttribute('aria-live', 'polite');
    this._announcer.setAttribute('aria-atomic', 'true');
    // Visually hidden but readable by screen readers
    Object.assign(this._announcer.style, {
      position: 'absolute',
      width: '1px',
      height: '1px',
      padding: '0',
      margin: '-1px',
      overflow: 'hidden',
      clip: 'rect(0, 0, 0, 0)',
      whiteSpace: 'nowrap',
      border: '0'
    });
    document.body.appendChild(this._announcer);
  }

  /**
   * Announce a message to screen readers.
   * @param {string} message - Text to announce
   * @param {'polite'|'assertive'} priority - Urgency level
   */
  announce(message, priority = 'polite') {
    if (!this._announcer) return;
    this._announcer.setAttribute('aria-live', priority);
    // Clear then set to force re-announcement
    this._announcer.textContent = '';
    requestAnimationFrame(() => {
      this._announcer.textContent = message;
    });
  }

  // ==================== ARIA Roles ====================

  /**
   * Apply ARIA roles to all major interactive elements.
   * Called once on init, and can be called again after dynamic content loads.
   */
  _applyAriaRoles() {
    // Activity bar: the panel switchers form a tablist; the buttons below
    // them (theme, account) are ordinary buttons outside it.
    const activityTabs = document.querySelector('.activity-bar-top');
    if (activityTabs) {
      activityTabs.setAttribute('role', 'tablist');
      activityTabs.setAttribute('aria-label', 'Side panels');
      activityTabs.setAttribute('aria-orientation', 'vertical');
    }

    // Activity icons = tabs
    document.querySelectorAll('.activity-icon[data-panel]').forEach(icon => {
      icon.setAttribute('role', 'tab');
      const panelId = icon.dataset.panel;
      icon.setAttribute('aria-controls', `${panelId}Panel`);
      icon.setAttribute('aria-selected', icon.classList.contains('active') ? 'true' : 'false');
    });

    // Sidebar panels = tabpanels
    document.querySelectorAll('.sidebar-panel').forEach(panel => {
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-label', panel.querySelector('.sidebar-title')?.textContent || 'Panel');
    });

    // File list: a labelled region (its rows are buttons, not tree items).
    const fileTree = document.getElementById('fileTree');
    if (fileTree) {
      fileTree.setAttribute('role', 'region');
      fileTree.setAttribute('aria-label', 'Sketch files');
    }

    // File tabs = tablist
    const fileTabs = document.getElementById('fileTabs');
    if (fileTabs) {
      fileTabs.setAttribute('role', 'tablist');
      fileTabs.setAttribute('aria-label', 'Open files');
    }

    // Output tabs = tablist
    const outputTabs = document.querySelector('.output-tabs');
    if (outputTabs) {
      outputTabs.setAttribute('role', 'tablist');
      outputTabs.setAttribute('aria-label', 'Output panels');
      outputTabs.querySelectorAll('.output-tab').forEach(tab => {
        tab.setAttribute('role', 'tab');
        const tabId = tab.dataset.tab;
        tab.setAttribute('aria-controls', `${tabId}Output`);
        tab.setAttribute('aria-selected', tab.classList.contains('active') ? 'true' : 'false');
      });
    }

    // Output content areas = tabpanels
    document.querySelectorAll('.output-content').forEach(content => {
      content.setAttribute('role', 'tabpanel');
    });

    // Modals
    const modals = [
      { id: 'boardPortModal', label: 'Choose a board and port' },
      { id: 'examplesDropdown', label: 'Examples' }
    ];
    modals.forEach(({ id, label }) => {
      const modal = document.getElementById(id);
      if (modal) {
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-label', label);
      }
    });

    // AI panel
    const aiPanel = document.getElementById('aiPanel');
    if (aiPanel) {
      aiPanel.setAttribute('role', 'complementary');
      aiPanel.setAttribute('aria-label', 'Impulse AI');
    }

    // AI messages area
    const aiMessages = document.getElementById('aiMessages');
    if (aiMessages) {
      aiMessages.setAttribute('role', 'log');
      aiMessages.setAttribute('aria-label', 'Conversation with Impulse AI');
      aiMessages.setAttribute('aria-live', 'polite');
    }

    // Serial output = log
    const serialOutput = document.getElementById('serialOutput');
    if (serialOutput) {
      serialOutput.setAttribute('role', 'log');
      serialOutput.setAttribute('aria-label', 'Serial monitor output');
    }

    // Console output = log
    const consoleOutput = document.getElementById('consoleOutput');
    if (consoleOutput) {
      consoleOutput.setAttribute('role', 'log');
      consoleOutput.setAttribute('aria-label', 'Console output');
      consoleOutput.tabIndex = 0; // scrollable with the keyboard
    }

    // Notification container
    const notifContainer = document.getElementById('notification-container');
    if (notifContainer) {
      notifContainer.setAttribute('role', 'alert');
      notifContainer.setAttribute('aria-live', 'assertive');
    }

    // Toolbar buttons with labels
    const toolbarButtons = {
      'compileBtn': 'Verify (compile) the sketch',
      'uploadBtn': 'Upload sketch to board',
      'serialMonitorBtn': 'Open the serial monitor',
      'serialPlotterBtn': 'Open the serial plotter',
      'aiAgentTab': 'Open Impulse AI'
    };
    Object.entries(toolbarButtons).forEach(([id, label]) => {
      const btn = document.getElementById(id);
      if (btn && !btn.getAttribute('aria-label')) {
        btn.setAttribute('aria-label', label);
      }
    });
  }

  // ==================== Focus Trapping ====================

  /**
   * Set up focus trapping for modals.
   * Listens for modal open/close and traps focus within.
   */
  _setupFocusTrapping() {
    // Observe modal visibility changes. A modal is "open" when it has the
    // .open class or aria-hidden="false". We trap on open and release on close
    // for BOTH class- and aria-driven modals (the old code never released
    // class-based modals like the board/port picker, and re-trapped on every
    // class mutation — leaking duplicate keydown handlers).
    const syncTrap = (el) => {
      if (!el || el.getAttribute('role') !== 'dialog') return;
      const isOpen = el.classList.contains('open') || el.getAttribute('aria-hidden') === 'false';
      if (isOpen) this.trapFocus(el);
      else this.releaseFocus(el);
    };

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          syncTrap(mutation.target);
        }
      }
    });

    // Observe all dialog elements
    document.querySelectorAll('[role="dialog"]').forEach(dialog => {
      observer.observe(dialog, { attributes: true, attributeFilter: ['aria-hidden', 'class', 'style'] });
    });
  }

  /**
   * Trap focus within a modal element.
   */
  trapFocus(modal) {
    // Idempotent: don't re-bind if this modal is already trapped (prevents
    // stacking duplicate keydown listeners on repeated mutations).
    if (modal._trapped) return;

    const focusableSelectors = [
      'a[href]', 'button:not([disabled])', 'input:not([disabled])',
      'select:not([disabled])', 'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])'
    ].join(',');

    const focusableElements = modal.querySelectorAll(focusableSelectors);
    if (focusableElements.length === 0) return;

    modal._trapped = true;

    const first = focusableElements[0];
    const last = focusableElements[focusableElements.length - 1];

    // Store the element that had focus before the modal opened
    const previousFocus = document.activeElement;

    const trapHandler = (e) => {
      if (e.key !== 'Tab') return;

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    modal._trapHandler = trapHandler;
    modal._previousFocus = previousFocus;
    modal.addEventListener('keydown', trapHandler);

    this._focusTrapStack.push(modal);

    // Focus the first focusable element
    requestAnimationFrame(() => first.focus());
  }

  /**
   * Release focus trap from a modal.
   */
  releaseFocus(modal) {
    if (!modal._trapped) return;
    modal._trapped = false;
    if (modal._trapHandler) {
      modal.removeEventListener('keydown', modal._trapHandler);
      modal._trapHandler = null;
    }

    // Restore focus to the element that was focused before
    if (modal._previousFocus && typeof modal._previousFocus.focus === 'function') {
      modal._previousFocus.focus();
      modal._previousFocus = null;
    }

    this._focusTrapStack = this._focusTrapStack.filter(m => m !== modal);
  }

  // ==================== Reduced Motion ====================

  _setupReducedMotion() {
    const updateMotion = () => {
      const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      document.documentElement.setAttribute('data-reduced-motion', prefersReduced ? 'true' : 'false');

      if (prefersReduced) {
        document.documentElement.style.setProperty('--transition-speed', '0s');
        document.documentElement.style.setProperty('--animation-speed', '0s');
      } else {
        document.documentElement.style.removeProperty('--transition-speed');
        document.documentElement.style.removeProperty('--animation-speed');
      }
    };

    updateMotion();
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', updateMotion);
  }

  // ==================== Keyboard Navigation ====================

  _setupKeyboardNavigation() {
    // Arrow key navigation within tablists
    document.addEventListener('keydown', (e) => {
      const target = e.target;
      if (!(target instanceof Element) || target.getAttribute('role') !== 'tab') return;

      const tablist = target.closest('[role="tablist"]');
      if (!tablist) return;

      const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
      const currentIndex = tabs.indexOf(target);
      if (currentIndex === -1) return;

      const isVertical = tablist.getAttribute('aria-orientation') === 'vertical';
      const prevKey = isVertical ? 'ArrowUp' : 'ArrowLeft';
      const nextKey = isVertical ? 'ArrowDown' : 'ArrowRight';

      let newIndex = -1;
      if (e.key === nextKey) {
        newIndex = (currentIndex + 1) % tabs.length;
      } else if (e.key === prevKey) {
        newIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      } else if (e.key === 'Home') {
        newIndex = 0;
      } else if (e.key === 'End') {
        newIndex = tabs.length - 1;
      }

      if (newIndex !== -1) {
        e.preventDefault();
        tabs[newIndex].focus();
        tabs[newIndex].click();
      }
    });
  }

  /**
   * Refresh ARIA roles after dynamic content changes (e.g., file tree update).
   */
  refresh() {
    this._applyAriaRoles();
  }
}

// Create global instance
window.a11y = new AccessibilityManager();

// Export for module use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AccessibilityManager;
}
