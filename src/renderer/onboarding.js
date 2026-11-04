/**
 * Onboarding System
 * Guides new users through initial setup
 */

class OnboardingManager {
  constructor() {
    this.steps = [
      {
        id: 'welcome',
        title: 'Welcome to Impulse IDE',
        content: 'An AI-powered Arduino development environment with intelligent compilation, upload, and error detection.',
        target: null,
        position: 'center'
      },
      {
        id: 'check-cli',
        title: 'Check Arduino CLI',
        content: 'First, let\'s verify that Arduino CLI is installed on your system.',
        target: '#cliStatus',
        position: 'right',
        action: () => this.checkArduinoCLI()
      },
      {
        id: 'open-sketch',
        title: 'Open a Sketch',
        content: 'Click here to open an Arduino sketch file (.ino) or create a new one.',
        target: '#openFolder',
        position: 'right'
      },
      {
        id: 'select-board',
        title: 'Choose a board',
        content: 'Choose your Arduino board from this dropdown. This tells the compiler what type of Arduino you\'re using.',
        target: '#boardPortDropdown',
        position: 'bottom'
      },
      {
        id: 'compile-upload',
        title: 'Compile & Upload',
        content: 'Use these buttons to verify (compile) your code and upload it to your Arduino board.',
        target: '#compileBtn',
        position: 'bottom'
      },
      {
        id: 'ai-assistant',
        title: 'Impulse AI',
        content: 'Stuck? Open Impulse AI here: it writes and fixes code, explains errors and answers questions about your board.',
        target: '#aiAgentTab',
        position: 'left'
      },
      {
        id: 'serial-monitor',
        title: 'Serial monitor',
        content: 'Monitor communication between your computer and Arduino using the serial monitor.',
        target: '#serialMonitorBtn',
        position: 'left'
      }
    ];
    
    this.currentStep = 0;
    this.isActive = false;
    this.overlay = null;
    this.tooltip = null;
  }

  start(force = false) {
    // Check if user has seen onboarding before
    const hasSeenOnboarding = localStorage.getItem('arduino-ide-onboarding-completed');
    if (hasSeenOnboarding && !force) {
      return;
    }

    this.isActive = true;
    this.currentStep = 0;
    this.createOverlay();
    this.showStep(this.currentStep);
  }

  createOverlay() {
    // Create overlay
    this.overlay = document.createElement('div');
    this.overlay.className = 'onboarding-overlay';
    document.body.appendChild(this.overlay);

    // Create tooltip
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'onboarding-tooltip';
    document.body.appendChild(this.tooltip);

    // Add event listener (bound so we can remove it later)
    this._keyHandler = (e) => {
      if (this.isActive) {
        if (e.key === 'Escape') {
          this.skip();
        } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
          this.next();
        } else if (e.key === 'ArrowLeft') {
          this.previous();
        }
      }
    };
    document.addEventListener('keydown', this._keyHandler);
  }

  showStep(stepIndex) {
    if (stepIndex < 0 || stepIndex >= this.steps.length) {
      this.complete();
      return;
    }

    const step = this.steps[stepIndex];
    
    // Clear previous highlights
    document.querySelectorAll('.onboarding-highlight').forEach(el => {
      el.classList.remove('onboarding-highlight');
    });

    // Highlight target element
    if (step.target) {
      const targetElement = document.querySelector(step.target);
      if (targetElement) {
        targetElement.classList.add('onboarding-highlight');
        this.positionTooltip(targetElement, step);
      } else {
        console.warn(`Onboarding target not found: ${step.target}`);
        this.positionTooltip(null, step);
      }
    } else {
      this.positionTooltip(null, step);
    }

    // Update tooltip content
    this.updateTooltipContent(step, stepIndex);

    // Execute step action if any
    if (step.action) {
      setTimeout(() => step.action(), 500);
    }
  }

  positionTooltip(targetElement, step) {
    if (!targetElement || step.position === 'center') {
      // Center the tooltip
      this.tooltip.style.position = 'fixed';
      this.tooltip.style.top = '50%';
      this.tooltip.style.left = '50%';
      this.tooltip.style.transform = 'translate(-50%, -50%)';
      return;
    }

    const rect = targetElement.getBoundingClientRect();
    const tooltipRect = this.tooltip.getBoundingClientRect();
    
    this.tooltip.style.position = 'fixed';
    
    switch (step.position) {
      case 'top':
        this.tooltip.style.top = `${rect.top - tooltipRect.height - 10}px`;
        this.tooltip.style.left = `${rect.left + (rect.width - tooltipRect.width) / 2}px`;
        break;
      case 'bottom':
        this.tooltip.style.top = `${rect.bottom + 10}px`;
        this.tooltip.style.left = `${rect.left + (rect.width - tooltipRect.width) / 2}px`;
        break;
      case 'left':
        this.tooltip.style.top = `${rect.top + (rect.height - tooltipRect.height) / 2}px`;
        this.tooltip.style.left = `${rect.left - tooltipRect.width - 10}px`;
        break;
      case 'right':
        this.tooltip.style.top = `${rect.top + (rect.height - tooltipRect.height) / 2}px`;
        this.tooltip.style.left = `${rect.right + 10}px`;
        break;
    }

    // Ensure tooltip stays within viewport
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    const currentLeft = parseInt(this.tooltip.style.left);
    const currentTop = parseInt(this.tooltip.style.top);
    
    if (currentLeft < 10) {
      this.tooltip.style.left = '10px';
    } else if (currentLeft + tooltipRect.width > viewportWidth - 10) {
      this.tooltip.style.left = `${viewportWidth - tooltipRect.width - 10}px`;
    }
    
    if (currentTop < 10) {
      this.tooltip.style.top = '10px';
    } else if (currentTop + tooltipRect.height > viewportHeight - 10) {
      this.tooltip.style.top = `${viewportHeight - tooltipRect.height - 10}px`;
    }
  }

  updateTooltipContent(step, stepIndex) {
    const isFirst = stepIndex === 0;
    const isLast = stepIndex === this.steps.length - 1;
    
    // NOTE: No inline onclick handlers — the app's CSP (script-src 'self')
    // blocks them. Buttons are wired with addEventListener below.
    this.tooltip.innerHTML = `
      <div class="onboarding-tooltip-content">
        <div class="onboarding-tooltip-header">
          <h3>${step.title}</h3>
          <button class="onboarding-close" data-onboard-action="skip">×</button>
        </div>
        <div class="onboarding-tooltip-body">
          <p>${step.content}</p>
        </div>
        <div class="onboarding-tooltip-footer">
          <div class="onboarding-progress">
            <span>${stepIndex + 1} of ${this.steps.length}</span>
            <div class="onboarding-progress-bar">
              <div class="onboarding-progress-fill" style="width: ${((stepIndex + 1) / this.steps.length) * 100}%"></div>
            </div>
          </div>
          <div class="onboarding-actions">
            <button class="onboarding-btn secondary" data-onboard-action="skip">Skip Tour</button>
            ${!isFirst ? '<button class="onboarding-btn secondary" data-onboard-action="previous">Previous</button>' : ''}
            <button class="onboarding-btn primary" data-onboard-action="${isLast ? 'complete' : 'next'}">
              ${isLast ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    `;

    // Wire button actions (CSP-safe).
    this.tooltip.querySelectorAll('[data-onboard-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-onboard-action');
        if (action === 'skip') this.skip();
        else if (action === 'previous') this.previous();
        else if (action === 'next') this.next();
        else if (action === 'complete') this.complete();
      });
    });
  }

  next() {
    this.currentStep++;
    this.showStep(this.currentStep);
  }

  previous() {
    this.currentStep--;
    this.showStep(this.currentStep);
  }

  skip() {
    this.complete();
  }

  complete() {
    this.isActive = false;
    
    // Remove event listener to prevent memory leak
    if (this._keyHandler) {
      document.removeEventListener('keydown', this._keyHandler);
      this._keyHandler = null;
    }

    // Remove overlay and tooltip
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
    
    if (this.tooltip) {
      this.tooltip.remove();
      this.tooltip = null;
    }

    // Clear highlights
    document.querySelectorAll('.onboarding-highlight').forEach(el => {
      el.classList.remove('onboarding-highlight');
    });

    // Mark as completed
    localStorage.setItem('arduino-ide-onboarding-completed', 'true');

    // Show completion notification
    if (window.notifications) {
      window.notifications.success('Welcome tour completed! You\'re ready to start coding with Arduino.');
    }
  }

  async checkArduinoCLI() {
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.arduino.checkCLI();
        // result.success only means the check ran; result.installed is the real status.
        if (result.success && result.installed) {
          window.notifications?.success('Arduino CLI is installed and ready!');
        } else {
          window.notifications?.warning('Arduino CLI not found. Please install it to continue.');
        }
      }
    } catch (error) {
      window.notifications?.error('Failed to check Arduino CLI status.');
    }
  }

  // Reset onboarding (for testing or user request)
  reset() {
    localStorage.removeItem('arduino-ide-onboarding-completed');
    this.start(true);
  }

  // Add tour trigger to help menu
  addHelpMenuOption() {
    // Add to help menu if it exists
    const helpMenu = document.querySelector('[data-menu="help"]');
    if (helpMenu) {
      const tourOption = document.createElement('button');
      tourOption.textContent = 'Take Tour';
      tourOption.onclick = () => this.start(true);
      helpMenu.appendChild(tourOption);
    }
  }
}

// Create global instance
window.onboarding = new OnboardingManager();

// Auto-start onboarding when page loads (only for new users)
document.addEventListener('DOMContentLoaded', () => {
  // Wait until the UI is up and any first-run setup dialog is closed.
  const whenIdle = (fn) => (document.querySelector('.setup-dialog') ? setTimeout(() => whenIdle(fn), 1000) : fn());
  // The tour is of the IDE. In chat mode it waits until the IDE is opened, and
  // if the person goes back to chat while the offer is up, the offer goes too
  // (and comes back the next time the IDE opens).
  const inIde = () => document.documentElement.dataset.shell !== 'vibe';
  const whenIde = (fn) => {
    if (inIde()) return fn();
    const onShell = (e) => {
      if (e.detail?.mode !== 'ide') return;
      window.removeEventListener('impulse:shell-changed', onShell);
      setTimeout(fn, 800);
    };
    window.addEventListener('impulse:shell-changed', onShell);
  };
  const offerTour = () => {
    // Only on the first visit.
    if (localStorage.getItem('arduino-ide-onboarding-completed')) return;
    if (!inIde()) return whenIde(offerTour);
    if (!window.notifications) {
      // Fallback if notifications aren't available
      window.onboarding.start();
      return;
    }
    const id = `welcome-${Date.now()}`;
    window.notifications.info('New here? A two-minute tour shows where everything is.', {
      id,
      title: 'Welcome to Impulse',
      duration: 8000,
      actions: [
        {
          id: 'start-tour',
          label: 'Start tour',
          callback: () => window.onboarding.start(true)
        },
        {
          id: 'skip-tour',
          label: 'Skip',
          callback: () => localStorage.setItem('arduino-ide-onboarding-completed', 'true')
        }
      ]
    });
    const back = (e) => {
      if (e.detail?.mode !== 'vibe') return;
      window.removeEventListener('impulse:shell-changed', back);
      window.notifications.dismiss(id);
      whenIde(offerTour);
    };
    window.addEventListener('impulse:shell-changed', back);
    setTimeout(() => window.removeEventListener('impulse:shell-changed', back), 8500);
  };
  setTimeout(() => whenIdle(offerTour), 2000);
});

// Export for module use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = OnboardingManager;
}