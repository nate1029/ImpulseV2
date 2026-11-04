/**
 * Client-side Validation Utilities
 * Provides real-time validation for user inputs
 */

class ValidationManager {
  constructor() {
    this.validators = new Map();
    this.init();
  }

  init() {
    // Set up validation for common inputs
    this.setupFilePathValidation();
    this.setupBoardValidation();
    this.setupPortValidation();
    this.setupSerialValidation();
  }

  setupFilePathValidation() {
    // Validate sketch file paths
    const validateSketchPath = (input) => {
      const value = input.value.trim();
      const errors = [];

      if (!value) {
        errors.push('Sketch path is required');
      } else {
        if (!value.endsWith('.ino')) {
          errors.push('Sketch file must have .ino extension');
        }
        if (value.includes('\\\\') || value.includes('//')) {
          errors.push('Invalid path format');
        }
        if (value.length > 260) {
          errors.push('Path is too long (max 260 characters)');
        }
      }

      this.showValidationResult(input, errors);
      return errors.length === 0;
    };

    // Opt-in only: validate elements that explicitly request it via
    // data-validate. (Previously this also matched by placeholder/id, which
    // pinned stray error tooltips and red/green outlines onto normal inputs.)
    document.addEventListener('input', (e) => {
      if (e.target.matches('input[data-validate="sketch-path"]')) {
        validateSketchPath(e.target);
      }
    });
  }

  setupBoardValidation() {
    const validateBoard = (select) => {
      const value = select.value;
      const errors = [];

      if (!value) {
        errors.push('Please select a board');
      } else {
        // Validate FQBN format
        const fqbnPattern = /^[^:]+:[^:]+:[^:]+$/;
        if (!fqbnPattern.test(value)) {
          errors.push('Invalid board format');
        }
      }

      this.showValidationResult(select, errors);
      return errors.length === 0;
    };

    // Opt-in only (data-validate="board").
    document.addEventListener('change', (e) => {
      if (e.target.matches('select[data-validate="board"]')) {
        validateBoard(e.target);
      }
    });
  }

  setupPortValidation() {
    const validatePort = (select) => {
      const value = select.value;
      const errors = [];

      if (!value) {
        errors.push('Please select a port');
      } else {
        // Basic port format validation (platform-agnostic)
        const isWindowsPort = /^COM\d+$/i.test(value);
        const isUnixPort = value.startsWith('/dev/');
        if (!isWindowsPort && !isUnixPort) {
          errors.push('Port should be in format COM1, COM2, etc. (Windows) or /dev/tty... (Mac/Linux)');
        }
      }

      this.showValidationResult(select, errors);
      return errors.length === 0;
    };

    // Opt-in only (data-validate="port").
    document.addEventListener('change', (e) => {
      if (e.target.matches('select[data-validate="port"]')) {
        validatePort(e.target);
      }
    });
  }

  setupSerialValidation() {
    const validateBaudRate = (select) => {
      const value = parseInt(select.value);
      const errors = [];
      const validRates = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

      if (!value || !validRates.includes(value)) {
        errors.push('Please select a valid baud rate');
      }

      this.showValidationResult(select, errors);
      return errors.length === 0;
    };

    // Opt-in only (data-validate="baud-rate").
    document.addEventListener('change', (e) => {
      if (e.target.matches('select[data-validate="baud-rate"]')) {
        validateBaudRate(e.target);
      }
    });
  }

  showValidationResult(element, errors) {
    // Remove existing validation UI
    this.clearValidationUI(element);

    if (errors.length > 0) {
      // Add error styling
      element.classList.add('validation-error');
      
      // Create error tooltip
      const tooltip = document.createElement('div');
      tooltip.className = 'validation-tooltip error';
      tooltip.innerHTML = `
        <div class="validation-tooltip-content">
          ${errors.map(error => `<div class="validation-error-item">• ${error}</div>`).join('')}
        </div>
      `;
      
      // Position tooltip
      element.parentNode.style.position = 'relative';
      element.parentNode.appendChild(tooltip);
      
      // Store reference for cleanup
      element._validationTooltip = tooltip;
    } else {
      // Add success styling
      element.classList.add('validation-success');
      
      // Auto-remove success styling after 2 seconds
      setTimeout(() => {
        element.classList.remove('validation-success');
      }, 2000);
    }
  }

  clearValidationUI(element) {
    element.classList.remove('validation-error', 'validation-success');
    
    if (element._validationTooltip) {
      element._validationTooltip.remove();
      element._validationTooltip = null;
    }
  }

  // Manual validation methods
  validateSketch(sketchPath) {
    const errors = [];
    
    if (!sketchPath) {
      errors.push('Sketch path is required');
      return { valid: false, errors };
    }

    if (!sketchPath.endsWith('.ino')) {
      errors.push('Sketch file must have .ino extension');
    }

    if (sketchPath.length > 260) {
      errors.push('Path is too long');
    }

    return { valid: errors.length === 0, errors };
  }

  validateCompileInputs(sketchPath, boardFQBN) {
    const errors = [];
    
    const sketchValidation = this.validateSketch(sketchPath);
    if (!sketchValidation.valid) {
      errors.push(...sketchValidation.errors);
    }

    if (!boardFQBN) {
      errors.push('Board selection is required');
    } else if (!/^[^:]+:[^:]+:[^:]+$/.test(boardFQBN)) {
      errors.push('Invalid board format');
    }

    return { valid: errors.length === 0, errors };
  }

  validateUploadInputs(sketchPath, boardFQBN, port) {
    const compileValidation = this.validateCompileInputs(sketchPath, boardFQBN);
    const errors = [...compileValidation.errors];

    if (!port) {
      errors.push('Port selection is required for upload');
    }

    return { valid: errors.length === 0, errors };
  }

  // Show validation summary
  showValidationSummary(errors) {
    if (errors.length === 0) return;

    const message = `Please fix the following issues:\n${errors.map(e => `• ${e}`).join('\n')}`;
    
    if (window.notifications) {
      window.notifications.warning(message, { duration: 8000 });
    } else {
      alert(message);
    }
  }

  // Validate before operations
  async validateBeforeCompile() {
    const sketchPath = window.state?.currentSketch;
    const boardFQBN = window.state?.selectedBoard;
    
    const validation = this.validateCompileInputs(sketchPath, boardFQBN);
    
    if (!validation.valid) {
      this.showValidationSummary(validation.errors);
      return false;
    }

    // Additional async validations
    try {
      if (sketchPath && window.electronAPI) {
        const fileExists = await window.electronAPI.file.exists(sketchPath);
        if (!fileExists) {
          this.showValidationSummary(['Sketch file does not exist']);
          return false;
        }
      }
    } catch (error) {
      console.warn('Could not verify file existence:', error);
    }

    return true;
  }

  async validateBeforeUpload() {
    const sketchPath = window.state?.currentSketch;
    const boardFQBN = window.state?.selectedBoard;
    const port = window.state?.selectedPort;
    
    const validation = this.validateUploadInputs(sketchPath, boardFQBN, port);
    
    if (!validation.valid) {
      this.showValidationSummary(validation.errors);
      return false;
    }

    // Check if port is available
    try {
      if (window.electronAPI) {
        const ports = await window.electronAPI.serial.listPorts();
        const portExists = ports.some(p => p.path === port);
        if (!portExists) {
          this.showValidationSummary(['Selected port is not available']);
          return false;
        }
      }
    } catch (error) {
      console.warn('Could not verify port availability:', error);
    }

    return true;
  }
}

// Create global instance
window.validation = new ValidationManager();

// Export for module use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ValidationManager;
}