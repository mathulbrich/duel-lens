// Opt-in AI check: asks Claude to name the card in the crop, as a fallback when the
// local embedding match is unsure. Uses the user's own Anthropic API key (see the
// options page), and only ever runs when `settings.ai.enabled` and a key are set.
//
// Per the claude-api skill (typescript/claude-api/README.md + tool-use.md, read before
// writing this file, and re-read for the fix-round-1 review): the official
// @anthropic-ai/sdk with `dangerouslyAllowBrowser` (this runs in the service worker,
// not Node); structured output via `output_config.format`; and, for claude-opus-5 /
// claude-fable-5-1, the server-side refusal `fallbacks` the skill recommends by
// default. Zod is not a project dependency, so this still uses a raw JSON Schema
// `json_schema` format and parses the returned text itself, rather than the
// `zodOutputFormat()` helper or `client.messages.parse()` (whose auto-parsing only
// kicks in for formats built with the zod helper - see the report for detail).
import Anthropic, {
  APIConnectionError,
  APIError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import type { OkResponse } from '../shared/messages';
import type { CropPayload, Settings } from '../shared/types';

/** One Claude/Messages-API-shaped response, whichever of the two client methods below
 * produced it - just enough of the real `Message`/`BetaMessage` shape for this file. */
export interface AnthropicMessageLike {
  content: Array<{ type: string; text?: string }>;
  stop_reason?: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
}

/** The minimal shape of an Anthropic client this module needs, so tests can fake it.
 * `beta.messages.create` is required (not just `messages.create`) because the
 * server-side refusal `fallbacks` parameter is beta-only. */
export interface AnthropicLike {
  messages: {
    create(params: Record<string, unknown>): Promise<AnthropicMessageLike>;
  };
  beta: {
    messages: {
      create(params: Record<string, unknown>): Promise<AnthropicMessageLike>;
    };
  };
}

export function buildAnthropicClient(apiKey: string): AnthropicLike {
  // The service worker has no server to proxy through, so this necessarily talks to
  // api.anthropic.com directly with the user's own key (optional host permission).
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true }) as unknown as AnthropicLike;
}

export type AiIdentifyResult = { name: string; confident: boolean } | { error: string };

// Review Important 1: "the recommended refusal fallback settings" (D4 brief) means
// this beta flag + `fallbacks: 'default'`, but only for the models the skill documents
// it for - sending it to a model that doesn't support it is itself a 400.
const REFUSAL_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const REFUSAL_FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1']);

export function supportsRefusalFallback(model: string): boolean {
  return REFUSAL_FALLBACK_MODELS.has(model);
}

// Review Important 3, then Important 2 (final review): max_tokens on these models is a
// hard cap on thinking *plus* response text, not just the visible reply - even 2048 could
// be exhausted by adaptive thinking alone on a hard, blurry crop. 8192 leaves generous
// room for both at `effort: 'low'`; non-streaming stays fine below ~16k.
const IDENTIFY_MAX_TOKENS = 8192;
// testAi's ping does not need much room, but it must stay well above what adaptive
// thinking's preamble alone can consume - unlike the original literal "1-token ping",
// which predates thinking/effort being sent at all (see buildModelRequest below). 64 was
// still tight enough that thinking alone could exhaust it and report a working key as
// "cut off (ran out of tokens)".
const TEST_MAX_TOKENS = 512;

interface ModelRequestBase {
  model: string;
  thinking: { type: 'adaptive' };
  output_config: { effort: 'low' };
  betas?: string[];
  fallbacks?: 'default';
}

/**
 * The fields every request for a given model shares: `thinking`, `output_config.effort`
 * and (only for models that support it) the refusal `fallbacks`. `identifyWithAi` and
 * `testAi` both build their request from this - review Important 2: if a chosen model
 * can't take one of these fields (e.g. it errors on `effort`), the same 400 now shows
 * up in "Test" too, instead of Test sending a bare ping that always reports ok.
 */
function buildModelRequest(model: string): ModelRequestBase {
  const base: ModelRequestBase = { model, thinking: { type: 'adaptive' }, output_config: { effort: 'low' } };
  if (supportsRefusalFallback(model)) {
    base.betas = [REFUSAL_FALLBACK_BETA];
    base.fallbacks = 'default';
  }
  return base;
}

/** Routes to `client.beta.messages.create` only for models that need the beta
 * `fallbacks` field; every other model uses the plain (non-beta) endpoint. */
function createMessage(client: AnthropicLike, params: Record<string, unknown> & { model: string }): Promise<AnthropicMessageLike> {
  return supportsRefusalFallback(params.model) ? client.beta.messages.create(params) : client.messages.create(params);
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: "The card's exact printed English name" },
    confident: { type: 'boolean', description: 'true only if you are sure of the identification' },
  },
  required: ['name', 'confident'],
  additionalProperties: false,
};

function buildPrompt(candidateNames: string[]): string {
  const guesses = candidateNames.length
    ? `A local image match found these possibilities, best first (they may be wrong, incomplete, or missing the right card):\n${candidateNames.map((n, i) => `${i + 1}. ${n}`).join('\n')}`
    : 'No local match was confident enough to suggest anything.';
  return (
    `This is a cropped photo or screenshot of a single Yu-Gi-Oh! trading card. It may be angled, rotated, ` +
    `partly obscured, or low quality.\n\n${guesses}\n\nName the exact printed English card name. Use one of the ` +
    `guesses above only if it actually matches the image; otherwise give your own best answer from the artwork ` +
    `and any visible text. Set confident to true only if you are genuinely sure.`
  );
}

function parseDataUrl(dataUrl: string): { mediaType: 'image/png' | 'image/jpeg'; data: string } {
  const match = /^data:(image\/png|image\/jpeg);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error('Expected a PNG or JPEG data URL crop');
  return { mediaType: match[1] as 'image/png' | 'image/jpeg', data: match[2] };
}

function mapAnthropicError(err: unknown): string {
  // Most-specific first: a single broad `catch` loses the distinction that matters to
  // the user (bad key vs. rate limited vs. a transient network blip).
  if (err instanceof AuthenticationError) return 'Anthropic rejected the API key. Check it in Options.';
  if (err instanceof PermissionDeniedError) return "This API key doesn't have permission for this request.";
  if (err instanceof RateLimitError) return 'Rate limited by Anthropic. Try again in a moment.';
  if (err instanceof APIConnectionError) return 'Could not reach the Anthropic API (network error).';
  if (err instanceof APIError) return `Anthropic API error ${err.status ?? ''}: ${err.message}`.trim();
  if (err instanceof Error) return err.message;
  return 'Unknown error talking to the Anthropic API.';
}

function buildIdentifyRequest(crop: CropPayload, candidateNames: string[], model: string) {
  const { mediaType, data } = parseDataUrl(crop.dataUrl);
  const base = buildModelRequest(model);
  return {
    ...base,
    max_tokens: IDENTIFY_MAX_TOKENS,
    output_config: { ...base.output_config, format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
          { type: 'text', text: buildPrompt(candidateNames) },
        ],
      },
    ],
  };
}

function buildTestRequest(model: string) {
  return { ...buildModelRequest(model), max_tokens: TEST_MAX_TOKENS, messages: [{ role: 'user', content: 'ping' }] };
}

/**
 * Asks Claude to identify the card in `crop`, given the local top candidate names.
 * Never throws: disabled/keyless settings, API errors and a malformed response all
 * come back as `{ error }` so the router can show them inline and keep the local result.
 */
export async function identifyWithAi(
  crop: CropPayload,
  candidateNames: string[],
  settings: Settings,
  client: AnthropicLike,
): Promise<AiIdentifyResult> {
  if (!settings.ai.enabled) return { error: 'The AI check is turned off. Enable it in Options.' };
  if (!settings.ai.apiKey) return { error: 'No Anthropic API key is set. Add one in Options.' };

  try {
    const response = await createMessage(client, buildIdentifyRequest(crop, candidateNames, settings.ai.model));

    if (response.stop_reason === 'refusal') {
      const category = response.stop_details?.category;
      return { error: `Claude declined to answer${category ? ` (${category})` : ''}.` };
    }
    if (response.stop_reason === 'max_tokens') {
      return { error: "Claude's answer was cut off before finishing (ran out of tokens). Try again." };
    }

    const textBlock = response.content.find((b) => b.type === 'text' && typeof b.text === 'string');
    if (!textBlock?.text) return { error: 'Claude did not return an answer.' };

    let parsed: { name?: unknown; confident?: unknown };
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      return { error: "Claude's answer was not valid JSON." };
    }
    if (typeof parsed.name !== 'string' || typeof parsed.confident !== 'boolean') {
      return { error: "Claude's answer was not in the expected shape." };
    }
    return { name: parsed.name, confident: parsed.confident };
  } catch (err) {
    return { error: mapAnthropicError(err) };
  }
}

/** A minimal, cheap request used by the options page's "Test" button. Built from the
 * same per-model fields as the real request (see `buildModelRequest`), so a model +
 * settings combination that would fail for real also fails here. */
export async function testAi(settings: Settings, client: AnthropicLike): Promise<OkResponse> {
  if (!settings.ai.enabled) return { ok: false, error: 'The AI check is turned off.' };
  if (!settings.ai.apiKey) return { ok: false, error: 'No Anthropic API key is set.' };
  try {
    const response = await createMessage(client, buildTestRequest(settings.ai.model));
    if (response.stop_reason === 'refusal') {
      const category = response.stop_details?.category;
      return { ok: false, error: `Claude declined to answer${category ? ` (${category})` : ''}.` };
    }
    if (response.stop_reason === 'max_tokens') {
      return { ok: false, error: "Claude's reply was cut off before finishing (ran out of tokens)." };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: mapAnthropicError(err) };
  }
}
