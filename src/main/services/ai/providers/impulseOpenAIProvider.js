const OpenAIProvider = require('./openaiProvider');
const { cloudURL } = require('../../cloud/config');
const models = require('./cloudModels');
const { friendlyCloudError } = require('./cloudErrors');

/**
 * OpenAI models through Impulse Cloud: the same requests as OpenAIProvider,
 * sent to the gateway's OpenAI lane with the account's session token. The
 * gateway adds Impulse's own OpenAI key and charges the account's credits.
 */
class ImpulseOpenAIProvider extends OpenAIProvider {
  static PREFIX = models.PREFIX;
  static DEFAULT_MODEL = `${models.PREFIX}gpt-5.4`;

  static isModelId(id) {
    return models.isCloudId(id) && models.vendorOf(id) === 'openai';
  }

  static displayName(id) {
    return models.displayName(id);
  }

  /**
   * @param {string} token the account's session token
   * @param {string} [model] an impulse: model id of an OpenAI model
   */
  constructor(token, model = null, { version = '0.0.0', baseURL = cloudURL() } = {}) {
    const id = ImpulseOpenAIProvider.isModelId(model) ? model : ImpulseOpenAIProvider.DEFAULT_MODEL;
    super(token, models.bare(id), {
      baseURL: `${baseURL || 'http://impulse-cloud.invalid'}/ai/openai`,
      headers: { 'x-impulse-client': `Impulse IDE/${version}` },
    });
    this.name = 'impulse-openai';
    this.appModel = id;
  }

  getAvailableModels() {
    return models.modelsOf('openai');
  }

  async chat(messages, options = {}) {
    try {
      return await super.chat(messages, options);
    } catch (error) {
      throw friendlyCloudError(error);
    }
  }

  validateApiKey(token) {
    return typeof token === 'string' && token.length >= 16;
  }
}

module.exports = ImpulseOpenAIProvider;
