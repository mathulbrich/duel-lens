import { APIConnectionError, APIError } from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { CropPayload, Settings } from '../shared/types';
import { identifyWithAi, supportsRefusalFallback, testAi, type AnthropicLike } from './ai';

const crop: CropPayload = { dataUrl: 'data:image/png;base64,AAAA', width: 100, height: 145, source: 'screenshot' };
const candidateNames = ['Pot of Greed', 'Pot of Desires', 'Dark Hole'];

function settingsWith(ai: Partial<Settings['ai']>): Settings {
  return { ai: { enabled: true, apiKey: 'sk-test', model: 'claude-opus-5', ...ai }, debug: { saveCrops: false }, display: { reveal: 'hover' } };
}

const identifiedOk = { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ name: 'Pot of Greed', confident: true }) }] };

/** Both `messages.create` and `beta.messages.create` share one mock, so a test can
 * assert on `client.messages.create` without caring which path identifyWithAi/testAi
 * actually dispatched to (that dispatch itself is covered by the dedicated tests
 * below, which need to tell the two paths apart and so use `fakeDualClient`). */
function fakeClient(response: unknown): AnthropicLike {
  const create = vi.fn().mockResolvedValue(response);
  return { messages: { create }, beta: { messages: { create } } };
}

function fakeRejectingClient(err: unknown): AnthropicLike {
  const create = vi.fn().mockRejectedValue(err);
  return { messages: { create }, beta: { messages: { create } } };
}

function fakeDualClient(response: unknown) {
  const plainCreate = vi.fn().mockResolvedValue(response);
  const betaCreate = vi.fn().mockResolvedValue(response);
  const client: AnthropicLike = { messages: { create: plainCreate }, beta: { messages: { create: betaCreate } } };
  return { client, plainCreate, betaCreate };
}

describe('supportsRefusalFallback', () => {
  it('is true only for claude-opus-5 and claude-fable-5-1', () => {
    expect(supportsRefusalFallback('claude-opus-5')).toBe(true);
    expect(supportsRefusalFallback('claude-fable-5-1')).toBe(true);
    expect(supportsRefusalFallback('claude-sonnet-5')).toBe(false);
    expect(supportsRefusalFallback('claude-haiku-4-5')).toBe(false);
  });
});

describe('identifyWithAi', () => {
  it('returns the parsed name and confidence from a structured response', async () => {
    const client = fakeClient(identifiedOk);

    const result = await identifyWithAi(crop, candidateNames, settingsWith({}), client);

    expect(result).toEqual({ name: 'Pot of Greed', confident: true });
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it('sends an image block with the crop and a prompt listing the candidate names', async () => {
    const client = fakeClient({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ name: 'Dark Hole', confident: false }) }],
    });

    await identifyWithAi(crop, candidateNames, settingsWith({}), client);

    const create = client.messages.create as unknown as { mock: { calls: unknown[][] } };
    const call = create.mock.calls[0][0] as {
      model: string;
      max_tokens: number;
      messages: [{ content: Array<{ type: string; source?: unknown; text?: string }> }];
    };
    expect(call.model).toBe('claude-opus-5');
    expect(call.max_tokens).toBe(8192); // review Important 2: 2048 still left no headroom for adaptive thinking
    const userContent = call.messages[0].content;
    const image = userContent.find((b) => b.type === 'image');
    expect(image?.source).toEqual({ type: 'base64', media_type: 'image/png', data: 'AAAA' });
    const text = userContent.find((b) => b.type === 'text')?.text ?? '';
    for (const name of candidateNames) expect(text).toContain(name);
  });

  it('makes no call when the AI check is disabled', async () => {
    const client = fakeClient({});

    const result = await identifyWithAi(crop, candidateNames, settingsWith({ enabled: false }), client);

    expect(result).toEqual({ error: expect.stringContaining('turned off') });
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it('makes no call when the API key is empty', async () => {
    const client = fakeClient({});

    const result = await identifyWithAi(crop, candidateNames, settingsWith({ apiKey: '' }), client);

    expect(result).toEqual({ error: expect.stringContaining('API key') });
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it('maps a refusal stop reason to a readable error instead of throwing', async () => {
    const client = fakeClient({
      stop_reason: 'refusal',
      stop_details: { category: 'cyber', explanation: 'nope' },
      content: [],
    });

    const result = await identifyWithAi(crop, candidateNames, settingsWith({}), client);

    expect(result).toEqual({ error: expect.stringContaining('declined') });
  });

  it('gives a max_tokens cutoff its own readable error, not "not valid JSON"', async () => {
    const client = fakeClient({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"name": "Pot of Gr' }] });

    const result = await identifyWithAi(crop, candidateNames, settingsWith({}), client);

    expect(result).toEqual({ error: expect.stringMatching(/ran out of tokens|cut off/i) });
  });

  it('reports an error instead of throwing when the response is not valid JSON', async () => {
    const client = fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] });

    const result = await identifyWithAi(crop, candidateNames, settingsWith({}), client);

    expect(result).toHaveProperty('error');
  });

  // Important 1
  it('uses client.beta.messages.create with the server-side refusal fallback for claude-opus-5', async () => {
    const { client, plainCreate, betaCreate } = fakeDualClient(identifiedOk);

    await identifyWithAi(crop, candidateNames, settingsWith({ model: 'claude-opus-5' }), client);

    expect(betaCreate).toHaveBeenCalledTimes(1);
    expect(plainCreate).not.toHaveBeenCalled();
    const params = betaCreate.mock.calls[0][0] as { betas?: string[]; fallbacks?: string };
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(params.fallbacks).toBe('default');
  });

  it('does not send fallbacks for claude-sonnet-5, and uses the plain (non-beta) client', async () => {
    const { client, plainCreate, betaCreate } = fakeDualClient(identifiedOk);

    await identifyWithAi(crop, candidateNames, settingsWith({ model: 'claude-sonnet-5' }), client);

    expect(plainCreate).toHaveBeenCalledTimes(1);
    expect(betaCreate).not.toHaveBeenCalled();
    const params = plainCreate.mock.calls[0][0] as { betas?: string[]; fallbacks?: string };
    expect(params.betas).toBeUndefined();
    expect(params.fallbacks).toBeUndefined();
  });

  // Important 5: reject with the real SDK error hierarchy, not a plain Error with a
  // `status` field bolted on (which never matches `instanceof AuthenticationError` and
  // so never actually exercises ai.ts's mapping branches), and assert exact strings.
  describe('maps real SDK error classes to exact readable messages', () => {
    it('AuthenticationError (401)', async () => {
      const err = APIError.generate(401, { error: { message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers());
      const client = fakeRejectingClient(err);

      const result = await identifyWithAi(crop, candidateNames, settingsWith({}), client);

      expect(result).toEqual({ error: 'Anthropic rejected the API key. Check it in Options.' });
    });

    it('RateLimitError (429)', async () => {
      const err = APIError.generate(429, { error: { message: 'rate limited' } }, 'rate limited', new Headers());
      const client = fakeRejectingClient(err);

      const result = await identifyWithAi(crop, candidateNames, settingsWith({}), client);

      expect(result).toEqual({ error: 'Rate limited by Anthropic. Try again in a moment.' });
    });

    it('APIConnectionError (network failure, no HTTP status at all)', async () => {
      const err = new APIConnectionError({ message: 'getaddrinfo ENOTFOUND api.anthropic.com' });
      const client = fakeRejectingClient(err);

      const result = await identifyWithAi(crop, candidateNames, settingsWith({}), client);

      expect(result).toEqual({ error: 'Could not reach the Anthropic API (network error).' });
    });

    it('a generic APIError (e.g. 400) falls back to the status + message', async () => {
      // A flat { message } body, matching what the SDK's own APIError.makeMessage
      // reads (a nested { error: { message } } - the real API's actual body shape -
      // isn't picked up by `error?.message` there, and gets JSON.stringify'd whole).
      const err = APIError.generate(400, { message: 'bad request body' }, 'bad request body', new Headers());
      const client = fakeRejectingClient(err);

      const result = await identifyWithAi(crop, candidateNames, settingsWith({}), client);

      expect(result).toEqual({ error: 'Anthropic API error 400: 400 bad request body' });
    });
  });
});

describe('testAi', () => {
  it('reports ok on a successful ping', async () => {
    const client = fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'pong' }] });

    expect(await testAi(settingsWith({}), client)).toEqual({ ok: true });
  });

  it('reports the exact mapped error (real SDK class) on failure, not just a truthy string', async () => {
    const err = APIError.generate(401, { error: { message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers());
    const client = fakeRejectingClient(err);

    const result = await testAi(settingsWith({}), client);

    expect(result).toEqual({ ok: false, error: 'Anthropic rejected the API key. Check it in Options.' });
  });

  it('reports ok:false when the reply is cut off (max_tokens) rather than a false ok', async () => {
    const client = fakeClient({ stop_reason: 'max_tokens', content: [] });

    const result = await testAi(settingsWith({}), client);

    expect(result.ok).toBe(false);
  });

  it('does not call the API when disabled or keyless', async () => {
    const client = fakeClient({});
    expect((await testAi(settingsWith({ enabled: false }), client)).ok).toBe(false);
    expect((await testAi(settingsWith({ apiKey: '' }), client)).ok).toBe(false);
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  // Review Important 2: 64 could be exhausted by adaptive thinking's preamble alone, so a
  // working key/model reported "cut off (ran out of tokens)" for a bare ping.
  it('sends a max_tokens with real headroom for adaptive thinking, not just enough for "pong"', async () => {
    const client = fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'pong' }] });

    await testAi(settingsWith({}), client);

    const create = client.messages.create as unknown as { mock: { calls: unknown[][] } };
    const call = create.mock.calls[0][0] as { max_tokens: number };
    expect(call.max_tokens).toBeGreaterThanOrEqual(512);
  });

  // Important 2: same builder as identifyWithAi, so an incompatible model+settings
  // combination that would fail for real also fails in "Test" - not a bare ping that
  // always reports ok regardless of the chosen model.
  it('sends the same thinking/effort/fallbacks fields as the real request for the same model', async () => {
    const settings = settingsWith({ model: 'claude-opus-5' });
    const identify = fakeDualClient(identifiedOk);
    const test = fakeDualClient({ stop_reason: 'end_turn', content: [] });

    await identifyWithAi(crop, candidateNames, settings, identify.client);
    await testAi(settings, test.client);

    const identifyParams = identify.betaCreate.mock.calls[0][0] as Record<string, unknown>;
    const testParams = test.betaCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(testParams.thinking).toEqual(identifyParams.thinking);
    expect(testParams.output_config).toEqual({ effort: 'low' }); // identify's also carries `format`; effort must still match
    expect(testParams.betas).toEqual(identifyParams.betas);
    expect(testParams.fallbacks).toEqual(identifyParams.fallbacks);
  });
});
