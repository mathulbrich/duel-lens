import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANTHROPIC_ORIGIN, askAiPermissions } from './hosts';

afterEach(() => vi.unstubAllGlobals());

describe('askAiPermissions: what turning on the AI check asks for (decision D-FF4)', () => {
  it('is the api.anthropic.com host alone in Chrome, as before the Firefox port', () => {
    expect(askAiPermissions()).toEqual({ origins: [ANTHROPIC_ORIGIN] });
  });

  it('adds Firefox\'s optional "websiteContent" data collection in the Firefox build, which its manifest declares', () => {
    vi.stubGlobal('__DUEL_LENS_FIREFOX__', true);
    expect(askAiPermissions()).toEqual({ origins: [ANTHROPIC_ORIGIN], data_collection: ['websiteContent'] });
  });
});
