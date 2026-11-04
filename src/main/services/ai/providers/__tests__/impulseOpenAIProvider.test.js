const ImpulseOpenAIProvider = require('../impulseOpenAIProvider');
const OpenAIProvider = require('../openaiProvider');

beforeAll(() => { OpenAIProvider.sleep = async () => {}; });

const gatewayError = (status, message, headers = { 'x-should-retry': 'false' }) => jest.fn(async () => new Response(
  JSON.stringify({ error: { message, type: 'x', code: 'y' } }), { status, headers: { 'content-type': 'application/json', ...headers } },
));

describe('ImpulseOpenAIProvider', () => {
  test('talks to the gateway\'s OpenAI lane with the session token and the app version', () => {
    const provider = new ImpulseOpenAIProvider('session-token-0123456789', 'impulse:gpt-5.5', { version: '2.1.0', baseURL: 'https://cloud.impulse.test' });
    expect(provider.name).toBe('impulse-openai');
    expect(provider.model).toBe('gpt-5.5');
    expect(provider.appModel).toBe('impulse:gpt-5.5');
    expect(provider.baseURL).toBe('https://cloud.impulse.test/ai/openai');
    expect(provider.apiKey).toBe('session-token-0123456789');
    expect(provider.headers).toEqual({ 'x-impulse-client': 'Impulse IDE/2.1.0' });
    expect(provider.validateApiKey('session-token-0123456789')).toBe(true);
    expect(provider.validateApiKey('short')).toBe(false);
  });

  test('model ids carry the impulse: prefix, are OpenAI models only, and default to GPT-5.4', () => {
    expect(ImpulseOpenAIProvider.isModelId('impulse:gpt-5.4-mini')).toBe(true);
    expect(ImpulseOpenAIProvider.isModelId('impulse:claude-opus-5-5')).toBe(false);
    expect(ImpulseOpenAIProvider.isModelId('gpt-5.4')).toBe(false);
    const provider = new ImpulseOpenAIProvider('session-token-0123456789', 'impulse:claude-opus-5-5', { baseURL: 'https://cloud.impulse.test' });
    expect(provider.appModel).toBe('impulse:gpt-5.4');
    expect(provider.getAvailableModels()).toEqual(['impulse:gpt-5.4', 'impulse:gpt-5.5', 'impulse:gpt-5.4-mini', 'impulse:gpt-5.4-nano']);
    expect(ImpulseOpenAIProvider.displayName('impulse:gpt-5.4-nano')).toBe('GPT-5.4 nano');
  });

  test.each([
    [402, 'insufficient_credits', 'You are out of credits for this month.'],
    [401, 'signed_out', null],
    [403, 'forbidden', 'GPT-5.5 is part of the Pro plan.'],
    [429, 'rate_limited', 'Too many requests at once.'],
    [503, 'unavailable', 'Impulse AI is down for maintenance.'],
  ])('a %i from the gateway becomes %s', async (status, code, message) => {
    const provider = new ImpulseOpenAIProvider('session-token-0123456789', 'impulse:gpt-5.4', { baseURL: 'https://cloud.impulse.test' });
    provider.fetch = gatewayError(status, message || 'whatever');
    const error = await provider.chat([{ role: 'user', content: 'hi' }], { tools: [] }).catch((e) => e);
    expect(error.code).toBe(code);
    if (message) expect(error.message).toBe(message);
    else expect(error.message).toMatch(/Sign in again/);
  });

  test('a connection failure says to check the internet', async () => {
    const provider = new ImpulseOpenAIProvider('session-token-0123456789', 'impulse:gpt-5.4', { baseURL: 'https://cloud.impulse.test' });
    provider.fetch = jest.fn(async () => { throw new TypeError('fetch failed'); });
    const error = await provider.chat([{ role: 'user', content: 'hi' }], { tools: [] }).catch((e) => e);
    expect(error.code).toBe('offline');
  });
});
