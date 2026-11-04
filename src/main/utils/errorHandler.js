/**
 * Comprehensive Error Handling Utility
 * Provides consistent error handling across the application
 */

const { dialog } = require('electron');
const logger = require('./logger');

class ErrorHandler {
  /**
   * Handle errors with user-friendly messages and logging
   * @param {Error} error - The error object
   * @param {string} context - Context where error occurred
   * @param {Object} options - Additional options
   * @returns {Object} Standardized error response
   */
  static handle(error, context = 'Unknown', options = {}) {
    const {
      showDialog = false,
      logLevel = 'error',
      userMessage = null,
      window = null
    } = options;

    // Log the error
    logger[logLevel](`[${context}] ${error.message}`, { 
      stack: error.stack,
      code: error.code,
      ...options.metadata 
    });

    // Create user-friendly message
    const friendlyMessage = userMessage || this.getFriendlyMessage(error, context);
    
    // Show dialog if requested
    if (showDialog && window) {
      this.showErrorDialog(window, friendlyMessage, error);
    }

    // Return standardized error response
    return {
      success: false,
      error: {
        message: friendlyMessage,
        code: error.code || 'UNKNOWN_ERROR',
        context,
        timestamp: new Date().toISOString(),
        technical: error.message
      }
    };
  }

  /**
   * Generate user-friendly error messages
   * @param {Error} error - The error object
   * @param {string} context - Context where error occurred
   * @returns {string} User-friendly message
   */
  static getFriendlyMessage(error, context) {
    const message = error.message.toLowerCase();
    
    // Arduino CLI specific errors
    if (context.includes('arduino') || context.includes('compile') || context.includes('upload')) {
      if (message.includes('not found') || message.includes('command not found')) {
        return 'Arduino CLI is not installed or not found in PATH. Please install Arduino CLI and restart the application.';
      }
      if (message.includes('permission denied') || message.includes('access denied')) {
        return 'Permission denied. Please check if another program is using the port or if you have sufficient permissions.';
      }
      if (message.includes('port') && message.includes('busy')) {
        return 'The selected port is busy. Please close other applications using this port and try again.';
      }
      if (message.includes('board') && message.includes('not found')) {
        return 'The selected board is not recognized. Please check your board selection or install the required board package.';
      }
      if (message.includes('sketch') && message.includes('not found')) {
        return 'Sketch file not found. Please check the file path and ensure the file exists.';
      }
    }

    // Serial port errors
    if (context.includes('serial')) {
      if (message.includes('port not found') || message.includes('no such file')) {
        return 'Serial port not found. Please check if your device is connected and the port is available.';
      }
      if (message.includes('access denied') || message.includes('permission denied')) {
        return 'Cannot access serial port. Please check permissions or close other applications using this port.';
      }
    }

    // File system errors
    if (context.includes('file') || context.includes('folder')) {
      if (message.includes('enoent') || message.includes('not found')) {
        return 'File or folder not found. Please check the path and ensure it exists.';
      }
      if (message.includes('eacces') || message.includes('permission denied')) {
        return 'Permission denied. Please check file permissions or run as administrator if needed.';
      }
      if (message.includes('enospc')) {
        return 'Not enough disk space. Please free up some space and try again.';
      }
    }

    // AI/Network errors
    if (context.includes('ai') || context.includes('api')) {
      if (message.includes('api key') || message.includes('unauthorized')) {
        return 'Invalid API key. Please check your API key configuration.';
      }
      if (message.includes('network') || message.includes('timeout')) {
        return 'Network error. Please check your internet connection and try again.';
      }
      if (message.includes('rate limit') || message.includes('quota')) {
        return 'API rate limit exceeded. Please wait a moment and try again.';
      }
    }

    // Generic fallback
    return `An error occurred: ${error.message}. Please check the console for more details.`;
  }

  /**
   * Show error dialog to user
   * @param {BrowserWindow} window - Electron window
   * @param {string} message - User-friendly message
   * @param {Error} error - Original error
   */
  static async showErrorDialog(window, message, error) {
    const options = {
      type: 'error',
      title: 'Error',
      message: message,
      detail: `Technical details: ${error.message}`,
      buttons: ['OK', 'Copy Error Details'],
      defaultId: 0,
      cancelId: 0
    };

    const result = await dialog.showMessageBox(window, options);
    
    if (result.response === 1) {
      // Copy error details to clipboard
      const { clipboard } = require('electron');
      const errorDetails = `Error: ${error.message}\nStack: ${error.stack}\nTimestamp: ${new Date().toISOString()}`;
      clipboard.writeText(errorDetails);
    }
  }

  /**
   * Validate input parameters
   * @param {Object} params - Parameters to validate
   * @param {Object} schema - Validation schema
   * @returns {Object} Validation result
   */
  static validateInput(params, schema) {
    const errors = [];
    
    for (const [key, rules] of Object.entries(schema)) {
      const value = params[key];
      
      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push(`${key} is required`);
        continue;
      }
      
      if (value !== undefined && value !== null) {
        if (rules.type && typeof value !== rules.type) {
          errors.push(`${key} must be of type ${rules.type}`);
        }
        
        if (rules.minLength && value.length < rules.minLength) {
          errors.push(`${key} must be at least ${rules.minLength} characters`);
        }
        
        if (rules.pattern && !rules.pattern.test(value)) {
          errors.push(`${key} format is invalid`);
        }
      }
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Wrap async functions with error handling
   * @param {Function} fn - Async function to wrap
   * @param {string} context - Context for error handling
   * @param {Object} options - Error handling options
   * @returns {Function} Wrapped function
   */
  static wrapAsync(fn, context, options = {}) {
    return async (...args) => {
      try {
        return await fn(...args);
      } catch (error) {
        return this.handle(error, context, options);
      }
    };
  }

  /**
   * Create a retry wrapper for operations
   * @param {Function} fn - Function to retry
   * @param {Object} options - Retry options
   * @returns {Function} Retry wrapper
   */
  static createRetryWrapper(fn, options = {}) {
    const { maxRetries = 3, delay = 1000, backoff = 2 } = options;
    
    return async (...args) => {
      let lastError;
      let currentDelay = delay;
      
      for (let i = 0; i <= maxRetries; i++) {
        try {
          return await fn(...args);
        } catch (error) {
          lastError = error;
          
          if (i === maxRetries) {
            throw error;
          }
          
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, currentDelay));
          currentDelay *= backoff;
        }
      }
      
      throw lastError;
    };
  }
}

module.exports = ErrorHandler;