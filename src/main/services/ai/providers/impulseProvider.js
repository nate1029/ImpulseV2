const { Anthropic } = require('@anthropic-ai/sdk');
const ClaudeProvider = require('./claudeProvider');
const { cloudURL } = require('../../cloud/config');
const models = require('./cloudModels');
const { friendlyCloudError } = require('./cloudErrors');

/**
 * Claude through Impulse Cloud: the same requests as ClaudeProvider, sent to
 * the Impulse AI gateway with the account's session token. The gateway adds
 * Impulse's API key and charges the account's credits. Model ids carry an
 * "impulse:" prefix; the OpenAI models share it and take the other lane
 * (impulseOpenAIProvider.js).
 */

const PREFIX = models.PREFIX;

class ImpulseProvider extends ClaudeProvider {
  static PREFIX = PREFIX;
  static DEFAULT_MODEL = `${PREFIX}claude-opus-5-5`;

  static isModelId(id) {
    return models.isCloudId(id) && models.vendorOf(id) === 'anthropic';
  }

  /** Shown until the server's catalog arrives (GET /v1/models). */
  static catalog() {
    return models.CATALOG.filter((m) => m.vendor === 'anthropic');
  }

  static displayName(id) {
    return models.displayName(id);
  }

  /**
   * @param {string} token the account's session token
   * @param {string} [model] an impulse: model id
   */
  constructor(token, model = null, { version = '0.0.0', baseURL = cloudURL() } = {}) {
    const id = ImpulseProvider.isModelId(model) ? model : ImpulseProvider.DEFAULT_MODEL;
    super(token, id.slice(PREFIX.length));
    this.name = 'impulse';
    this.appModel = id;
    // apiKey: null so an ANTHROPIC_API_KEY in the environment is never sent to the gateway.
    this.client = new Anthropic({
      apiKey: null,
      authToken: token,
      baseURL: `${baseURL || 'http://impulse-cloud.invalid'}/ai`,
      maxRetries: 2,
      defaultHeaders: { 'x-impulse-client': `Impulse IDE/${version}` },
    });
  }

  getAvailableModels() {
    return models.modelsOf('anthropic');
  }

  async chat(messages, options = {}) {
    try {
      return await super.chat(messages, options);
    } catch (error) {
      throw ImpulseProvider.toFriendly(error);
    }
  }

  /** ClaudeProvider already turned SDK errors into text; recover the status from the cause. */
  static toFriendly(error) {
    if (error?.cause instanceof Anthropic.APIConnectionError) {
      return friendlyCloudError(Object.assign(new Error(error.message), { cause: { offline: true } }));
    }
    return friendlyCloudError(error);
  }

  validateApiKey(token) {
    return typeof token === 'string' && token.length >= 16;
  }
}

module.exports = ImpulseProvider;
