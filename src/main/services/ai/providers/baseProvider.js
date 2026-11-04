/**
 * Base Provider Interface
 * All LLM providers must implement this interface
 */
class BaseProvider {
  constructor(apiKey, model = null) {
    this.apiKey = apiKey;
    this.model = model;
    this.name = 'base';
  }

  /**
   * Get available models for this provider
   * @returns {Array<string>} List of model names
   */
  getAvailableModels() {
    throw new Error('getAvailableModels() must be implemented by provider');
  }

  /**
   * Send a chat completion request
   * @param {Array} messages - Array of message objects {role, content}
   * @param {Object} options - Additional options (temperature, max_tokens, etc.)
   * @returns {Promise<Object>} Response with content and tool calls
   */
  async chat(messages, _options = {}) {
    throw new Error('chat() must be implemented by provider');
  }

  /**
   * Format tool definitions for provider-specific schema
   * @param {Array} _tools - Array of tool definitions
   * @returns {Object} Provider-specific tool format
   */
  formatTools(_tools) {
    throw new Error('formatTools() must be implemented by provider');
  }

  /**
   * Parse tool calls from provider response
   * @param {Object} _response - Provider response object
   * @returns {Array} Array of tool call objects
   */
  parseToolCalls(_response) {
    throw new Error('parseToolCalls() must be implemented by provider');
  }

  /**
   * Validate API key format
   * @param {string} apiKey - API key to validate
   * @returns {boolean} True if valid format
   */
  validateApiKey(apiKey) {
    return apiKey && apiKey.length > 0;
  }

  /**
   * Get provider name
   * @returns {string} Provider name
   */
  getName() {
    return this.name;
  }
}

module.exports = BaseProvider;

