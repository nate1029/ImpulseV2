// Shortcuts are native menu accelerators (CmdOrCtrl): on a Mac they read ⌘ and ⇧.
const TOOLTIP_MAC = /Mac/i.test(navigator.platform || navigator.userAgent);
function macKeys(text) {
  if (!TOOLTIP_MAC || typeof text !== 'string') return text;
  return text.replace(/Ctrl\+Shift\+/g, '⇧⌘').replace(/Ctrl\+/g, '⌘');
}

/**
 * Tooltip System
 * Provides contextual help and information
 */

class TooltipManager {
  constructor() {
    this.activeTooltip = null;
    this.currentElement = null;
    this.showDelay = 800; // ms
    this.hideDelay = 200; // ms
    this.showTimer = null;
    this.hideTimer = null;
    this.init();
  }

  init() {
    // Create tooltip element
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'tooltip';
    this.tooltip.style.display = 'none';
    document.body.appendChild(this.tooltip);

    // Set up event listeners
    this.setupEventListeners();
    
    // Add default tooltips
    this.addDefaultTooltips();
  }

  setupEventListeners() {
    // Use mouseenter/mouseleave on individual elements instead of document
    // Capture-phase listeners also see the document itself and text nodes,
    // which have no closest(); only elements can carry a tooltip.
    const tooltipHost = (target) => (target instanceof Element ? target.closest('[title], [data-tooltip]') : null);

    document.addEventListener('mouseenter', (e) => {
      const element = tooltipHost(e.target);
      if (element && element !== this.currentElement) {
        this.hide(); // Hide any existing tooltip first
        this.currentElement = element;
        this.scheduleShow(element, e);
      }
    }, true);

    document.addEventListener('mouseleave', (e) => {
      const element = tooltipHost(e.target);
      if (element && element === this.currentElement) {
        this.scheduleHide();
        this.currentElement = null;
      }
    }, true);

    // Only update position if tooltip is visible and we're still over the same element
    document.addEventListener('mousemove', (e) => {
      if (this.activeTooltip && this.currentElement) {
        const elementUnderMouse = tooltipHost(e.target);
        if (elementUnderMouse === this.currentElement) {
          this.updatePosition(e);
        } else {
          // Mouse left the element, hide tooltip
          this.hide();
        }
      }
    });

    // Hide on scroll or window events
    document.addEventListener('scroll', () => this.hide(), true);
    window.addEventListener('resize', () => this.hide());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide();
    });

    // Hide tooltip when clicking anywhere
    document.addEventListener('click', () => this.hide());
  }

  scheduleShow(element, event) {
    this.clearTimers();
    
    this.showTimer = setTimeout(() => {
      this.show(element, event);
    }, this.showDelay);
  }

  scheduleHide() {
    this.clearTimers();
    
    this.hideTimer = setTimeout(() => {
      this.hide();
    }, this.hideDelay);
  }

  clearTimers() {
    if (this.showTimer) {
      clearTimeout(this.showTimer);
      this.showTimer = null;
    }
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  show(element, event) {
    const content = this.getTooltipContent(element);
    if (!content) return;

    // Hide any existing tooltip first
    this.hide();

    this.activeTooltip = element;
    this.tooltip.textContent = macKeys(content);
    this.tooltip.style.display = 'block';
    
    // Position tooltip after content is set
    requestAnimationFrame(() => {
      this.updatePosition(event);
      this.tooltip.classList.add('show');
    });
  }

  hide() {
    this.clearTimers();
    
    if (this.activeTooltip) {
      this.tooltip.classList.remove('show');
      
      setTimeout(() => {
        this.tooltip.style.display = 'none';
        this.activeTooltip = null;
        this.currentElement = null;
      }, 200);
    }
  }

  updatePosition(event) {
    if (!this.activeTooltip || !this.tooltip) return;

    // Get fresh dimensions each time
    const tooltipRect = this.tooltip.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    let x = event.clientX + 10;
    let y = event.clientY - tooltipRect.height - 10;
    
    // Adjust if tooltip goes off screen
    if (x + tooltipRect.width > viewportWidth - 10) {
      x = event.clientX - tooltipRect.width - 10;
    }
    
    if (y < 10) {
      y = event.clientY + 20;
    }
    
    if (y + tooltipRect.height > viewportHeight - 10) {
      y = viewportHeight - tooltipRect.height - 10;
    }
    
    // Ensure coordinates are valid numbers
    if (!isNaN(x) && !isNaN(y)) {
      this.tooltip.style.left = `${Math.max(0, x)}px`;
      this.tooltip.style.top = `${Math.max(0, y)}px`;
    }
  }

  getTooltipContent(element) {
    // Check for data-tooltip attribute first (plain text only)
    if (element.hasAttribute('data-tooltip')) {
      return element.getAttribute('data-tooltip');
    }
    
    // Fall back to title attribute (plain text). Migrate it into data-tooltip
    // (not data-original-title) so subsequent hovers still find content — and
    // remove the native title to avoid a duplicate browser tooltip.
    if (element.hasAttribute('title')) {
      const title = element.getAttribute('title');
      element.setAttribute('data-tooltip', title);
      element.removeAttribute('title');
      return title;
    }
    
    return null;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  addDefaultTooltips() {
    // Add helpful tooltips to common elements
    const tooltips = {
      '#compileBtn': 'Compile (verify) your Arduino sketch without uploading (Ctrl+R).',
      '#uploadBtn': 'Compile and upload your sketch to the connected Arduino board (Ctrl+U).',
      '#serialMonitorBtn': 'Open the serial monitor to communicate with your Arduino (Ctrl+Shift+M).',
      '#serialPlotterBtn': 'Open the serial plotter to visualize numeric data from your Arduino.',
      '#aiAgentTab': 'Open Impulse AI for help with code, errors and your board (Ctrl+Shift+A).',
      '#boardPortDropdown': 'Select your Arduino board type and connection port. Both are required for uploading.',
      '#themeToggleBtn': 'Switch between light and dark themes.',
      '#openFolder': 'Open a folder containing Arduino sketches (.ino files).',
      '#refreshPortsSidebar': 'Refresh the list of available serial ports.',
      '#coreSearchBtn': 'Search for Arduino board packages (cores) to install.',
      '#libSearchBtn': 'Search for Arduino libraries to install.',
      '#libUpdateIndex': 'Update the library index to get the latest available libraries.',
      '#baudRate': 'Set the communication speed for the serial monitor. Must match your Arduino code.',
      '#toggleSerial': 'Connect or disconnect the serial monitor.',
      '#sendSerial': 'Send the typed message to your Arduino via serial.',
      '#aiSend': 'Send your message to Impulse AI.',
      '#aiModeSelect': 'Agent builds and changes the project, Plan lays out parts, wiring and steps without changing anything, Debug finds out why something fails and fixes it.',
      '#aiModelSelect': 'Select the AI model to use for assistance.'
    };

    // Apply tooltips
    Object.entries(tooltips).forEach(([selector, tooltip]) => {
      const element = document.querySelector(selector);
      if (element && !element.hasAttribute('title') && !element.hasAttribute('data-tooltip')) {
        element.setAttribute('data-tooltip', tooltip);
      }
    });

    // Add contextual tooltips based on state
    this.addContextualTooltips();
  }

  addContextualTooltips() {
    // Add tooltips that change based on application state
    // Use a stored reference so we can clear it on cleanup
    this._contextualInterval = setInterval(() => {
      this.updateContextualTooltips();
    }, 5000); // Reduced frequency: 5s instead of 2s
  }

  /**
   * Stop the contextual tooltip polling interval
   */
  destroy() {
    if (this._contextualInterval) {
      clearInterval(this._contextualInterval);
      this._contextualInterval = null;
    }
    this.hide();
    if (this.tooltip && this.tooltip.parentNode) {
      this.tooltip.parentNode.removeChild(this.tooltip);
    }
  }

  updateContextualTooltips() {
    // Update CLI status tooltip
    const cliStatus = document.querySelector('#cliStatus');
    if (cliStatus) {
      // The status element shows "Arduino CLI Ready" on success (never "installed").
      const isInstalled = cliStatus.textContent.includes('Ready');
      const tooltip = isInstalled 
        ? 'Arduino CLI is installed and ready to use.'
        : 'Arduino CLI is not installed. Please install it from arduino.github.io/arduino-cli/';
      cliStatus.setAttribute('data-tooltip', tooltip);
    }

    // Update serial status tooltip
    const serialStatus = document.querySelector('#serialStatusText');
    if (serialStatus) {
      const isConnected = serialStatus.textContent.includes('Connected');
      const tooltip = isConnected
        ? 'Serial monitor is connected and receiving data.'
        : 'The serial monitor is not connected. Choose a port, then click "Open serial monitor".';
      serialStatus.setAttribute('data-tooltip', tooltip);
    }

    // Update board/port selection tooltip
    const boardPortDisplay = document.querySelector('#boardPortDisplay');
    if (boardPortDisplay && boardPortDisplay.textContent !== 'Choose a board') {
      boardPortDisplay.setAttribute('data-tooltip', 
        'Current selection: ' + boardPortDisplay.textContent + '. Click to change.');
    }
  }

  // Manual tooltip methods
  showCustomTooltip(element, content, options = {}) {
    const { 
      position = 'auto',
      delay = 0,
      duration = 0,
      className = ''
    } = options;

    if (delay > 0) {
      setTimeout(() => {
        this.displayCustomTooltip(element, content, { position, className, duration });
      }, delay);
    } else {
      this.displayCustomTooltip(element, content, { position, className, duration });
    }
  }

  displayCustomTooltip(element, content, options) {
    this.hide(); // Hide any existing tooltip
    
    this.activeTooltip = element;
    this.tooltip.textContent = macKeys(content);
    this.tooltip.className = `tooltip ${options.className || ''}`;
    this.tooltip.style.display = 'block';
    
    // Position relative to element
    const rect = element.getBoundingClientRect();
    const tooltipRect = this.tooltip.getBoundingClientRect();
    
    let x, y;
    
    switch (options.position) {
      case 'top':
        x = rect.left + (rect.width - tooltipRect.width) / 2;
        y = rect.top - tooltipRect.height - 10;
        break;
      case 'bottom':
        x = rect.left + (rect.width - tooltipRect.width) / 2;
        y = rect.bottom + 10;
        break;
      case 'left':
        x = rect.left - tooltipRect.width - 10;
        y = rect.top + (rect.height - tooltipRect.height) / 2;
        break;
      case 'right':
        x = rect.right + 10;
        y = rect.top + (rect.height - tooltipRect.height) / 2;
        break;
      default: // auto
        x = rect.right + 10;
        y = rect.top;
    }
    
    // Keep within viewport
    x = Math.max(10, Math.min(x, window.innerWidth - tooltipRect.width - 10));
    y = Math.max(10, Math.min(y, window.innerHeight - tooltipRect.height - 10));
    
    this.tooltip.style.left = `${x}px`;
    this.tooltip.style.top = `${y}px`;
    
    requestAnimationFrame(() => {
      this.tooltip.classList.add('show');
    });
    
    // Auto-hide if duration specified
    if (options.duration > 0) {
      setTimeout(() => {
        this.hide();
      }, options.duration);
    }
  }

  // Help system integration
  showHelp(topic) {
    const helpContent = this.getHelpContent(topic);
    if (helpContent) {
      // Show help in a more prominent way
      if (window.notifications) {
        window.notifications.info(helpContent, { 
          duration: 10000,
          persistent: true,
          actions: [
            { id: 'close', label: 'Close' }
          ]
        });
      }
    }
  }

  getHelpContent(topic) {
    const helpTopics = {
      'compile': 'Compilation checks your code for errors without uploading. Fix any red errors before uploading.',
      'upload': 'Upload sends your compiled code to the Arduino. Make sure the correct board and port are selected.',
      'serial': 'The serial monitor shows messages from your Arduino. Use Serial.println() in your code to send messages.',
      'boards': 'Select the exact Arduino model you\'re using. This affects how the code is compiled.',
      'ports': 'The port is how your computer connects to the Arduino. Usually COM3, COM4 on Windows or /dev/ttyUSB0 on Linux.',
      'ai': 'Impulse AI writes and fixes code, explains errors and answers questions about your board.',
      'libraries': 'Libraries add extra functions to Arduino. Install them here and include them in your code with #include.'
    };
    
    return helpTopics[topic] || null;
  }
}

// Create global instance
window.tooltips = new TooltipManager();

// Export for module use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TooltipManager;
}