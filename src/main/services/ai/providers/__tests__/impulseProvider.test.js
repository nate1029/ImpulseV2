const { Anthropic } = require('@anthropic-ai/sdk');
const ImpulseProvider = require('../impulseProvider');

describe('ImpulseProvider', () => {
  test('talks to the gateway with the session token, never an API key', () => {
    const provider = new ImpulseProvider('session-token-0123456789', 'impulse:claude-sonnet-5-5', { version: '2.1.0', baseURL: 'https://cloud.impulse.test' });
    expect(provider.model).toBe('claude-sonnet-5-5');
    expect(provider.appModel).toBe('impulse:claude-sonnet-5-5');
    expect(provider.client.baseURL).toBe('https://cloud.impulse.test/ai');
    expect(provider.client.authToken).toBe('session-token-0123456789');
    expect(provider.client.apiKey).toBeNull();
  });

  test('model ids carry the impulse: prefix and default to Opus 5.5', () => {
    const provider = new ImpulseProvider('session-token-0123456789', 'not-a-model', { baseURL: 'https://cloud.impulse.test' });
    expect(provider.appModel).toBe('impulse:claude-opus-5-5');
    expect(provider.getAvailableModels().every((id) => id.startsWith('impulse:'))).toBe(true);
    expect(ImpulseProvider.displayName('impulse:claude-haiku-5-5')).toBe('Haiku 5.5');
  });

  test('requests cache the conversation prefix', () => {
    const provider = new ImpulseProvider('session-token-0123456789', 'impulse:claude-opus-5-5', { baseURL: 'https://cloud.impulse.test' });
    const request = provider.buildRequest([{ role: 'user', content: 'hi' }], { tools: [] });
    expect(request.cache_control).toEqual({ type: 'ephemeral' });
  });

  const apiError = (status, message) => new Error('wrapped', {
    cause: Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message } }, message, new Headers()),
  });

  test.each([
    [402, 'insufficient_credits', 'You are out of credits for this month.'],
    [401, 'signed_out', null],
    [403, 'forbidden', 'Fable 5.1 is part of the Pro plan.'],
    [429, 'rate_limited', 'Too many requests at once.'],
    [503, 'unavailable', 'Impulse AI is down for maintenance.'],
  ])('a %i from the gateway becomes %s', (status, code, message) => {
    const friendly = ImpulseProvider.toFriendly(apiError(status, message || 'whatever'));
    expect(friendly.code).toBe(code);
    if (message) expect(friendly.message).toBe(message);
    else expect(friendly.message).toMatch(/Sign in again/);
  });

  test('a connection failure says to check the internet', () => {
    const error = new Error('wrapped', { cause: new Anthropic.APIConnectionError({ message: 'fetch failed' }) });
    expect(ImpulseProvider.toFriendly(error)).toMatchObject({ code: 'offline' });
  });
});
