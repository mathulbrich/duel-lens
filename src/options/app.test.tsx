// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../background/card-store', () => ({ getAllCrops: vi.fn() }));

import { getAllCrops } from '../background/card-store';
import { ACCURACY, legalNotice } from '../welcome/copy';
import { DISCLAIMER } from '../welcome/links';
import { AI_DISCLOSURE, App, buildTestSetRecords, formatArtworksIndexed, formatIndexUpdateState } from './app';

type Msg = { type: string; [k: string]: unknown };
type Command = { name: string; description: string; shortcut: string };

/** What chrome.commands.getAll reports for a fresh install on Windows/Linux (the manifest's defaults). */
const DEFAULT_COMMANDS: Command[] = [
  { name: '_execute_action', description: '', shortcut: '' },
  { name: 'scan-card', description: 'Scan a card on this page', shortcut: 'Alt+Shift+Y' },
  { name: 'open-panel', description: 'Open the Duel Lens side panel', shortcut: 'Alt+Shift+U' },
];

/** Every key combination shown on the page, as its text ("Alt+Shift+Y"). */
function combos(root: ParentNode = document): string[] {
  return Array.from(root.querySelectorAll('kbd.combo')).map((k) => k.textContent ?? '');
}

function fakeStorageArea(initial: Record<string, unknown> = {}) {
  let data: Record<string, unknown> = { ...initial };
  return {
    get: vi.fn(async (key: string) => ({ [key]: data[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      data = { ...data, ...items };
    }),
  };
}

/** The count baked into extension/data/index-<model>.meta.json, which app.tsx fetches
 * directly (not through the background) for the "N bundled" half of "Artworks indexed". */
const BUNDLED_COUNT = 14700;

function setUpChrome(
  opts: {
    permissionsGranted?: boolean;
    sendMessageImpl?: (msg: Msg) => Promise<unknown>;
    bundledCount?: number | null;
    commands?: Command[];
  } = {},
) {
  const local = fakeStorageArea();
  const permissionsRequest = vi.fn().mockResolvedValue(opts.permissionsGranted ?? true);
  const permissionsRemove = vi.fn().mockResolvedValue(true);
  const defaultSendMessage = async (msg: Msg) => {
    if (msg.type === 'get-status') {
      return { dbVersion: '1.0', cardsUpdatedAt: Date.UTC(2026, 0, 1), cardCount: 42, modelId: 'dinov2-small' };
    }
    return { ok: true };
  };
  const sendMessage = vi.fn(opts.sendMessageImpl ?? defaultSendMessage);
  const tabsCreate = vi.fn();
  vi.stubGlobal('chrome', {
    storage: { local },
    permissions: { request: permissionsRequest, remove: permissionsRemove },
    runtime: {
      sendMessage,
      getURL: (p: string) => `chrome-extension://abc/${p}`,
      getManifest: () => ({ version: '1.2.3' }),
    },
    tabs: { create: tabsCreate },
    commands: { getAll: vi.fn(async () => opts.commands ?? DEFAULT_COMMANDS) },
  });
  const bundledCount = opts.bundledCount === undefined ? BUNDLED_COUNT : opts.bundledCount;
  const fetchMock = vi.fn(async () =>
    bundledCount === null ? new Response('not found', { status: 404 }) : new Response(JSON.stringify({ count: bundledCount })),
  );
  vi.stubGlobal('fetch', fetchMock);
  return { local, permissionsRequest, permissionsRemove, sendMessage, tabsCreate, fetchMock };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('model choices', () => {
  it('does not offer claude-haiku-4-5 (it cannot run the request ai.ts builds)', async () => {
    setUpChrome();
    render(<App />);

    const select = (await screen.findByLabelText('Model')) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);

    expect(values).toEqual(['claude-opus-5', 'claude-sonnet-5']);
  });
});

describe('refusal fallback notice', () => {
  it('is shown for the default model (claude-opus-5), which supports server-side fallbacks', async () => {
    setUpChrome();
    render(<App />);

    expect(await screen.findByText(/refusal fallback/i)).toBeTruthy();
  });

  it('is hidden once claude-sonnet-5 is selected, which does not support them', async () => {
    setUpChrome();
    render(<App />);
    const select = (await screen.findByLabelText('Model')) as HTMLSelectElement;
    await screen.findByText(/refusal fallback/i); // wait for the initial (shown) state first

    fireEvent.change(select, { target: { value: 'claude-sonnet-5' } });

    await waitFor(() => expect(screen.queryByText(/refusal fallback/i)).toBeNull());
  });
});

describe('buildTestSetRecords', () => {
  it('keeps only dataUrl and cardId from each crop record', () => {
    const records = buildTestSetRecords([
      { dataUrl: 'd1', cardId: 1, at: 111, entryId: 'x' },
      { dataUrl: 'd2', cardId: 2, at: 222 },
    ]);
    expect(records).toEqual([
      { dataUrl: 'd1', cardId: 1 },
      { dataUrl: 'd2', cardId: 2 },
    ]);
  });
});

describe('AI check toggle', () => {
  it('requests the api.anthropic.com permission when turned on', async () => {
    const { permissionsRequest, local } = setUpChrome();
    render(<App />);
    const checkbox = await screen.findByRole('checkbox', { name: /ask claude/i });

    fireEvent.click(checkbox);

    await waitFor(() => expect(permissionsRequest).toHaveBeenCalledWith({ origins: ['https://api.anthropic.com/*'] }));
    await waitFor(async () => {
      const stored = (await local.get('settings')) as { settings?: { ai?: { enabled?: boolean } } };
      expect(stored.settings?.ai?.enabled).toBe(true);
    });
  });

  it('leaves the toggle off, with a message, when the permission is denied', async () => {
    setUpChrome({ permissionsGranted: false });
    render(<App />);
    const checkbox = (await screen.findByRole('checkbox', { name: /ask claude/i })) as HTMLInputElement;

    fireEvent.click(checkbox);

    expect(await screen.findByText(/denied/i)).toBeTruthy();
    await waitFor(() => expect(checkbox.checked).toBe(false));
  });

  // Final review M12: the privacy texts present the grant as the user's consent to the AI check, so turning
  // the check off gives the permission back. The key stays (clearing its field deletes it), so turning the
  // check on again asks only for the permission.
  describe('turned off', () => {
    const ON = { ai: { enabled: true, apiKey: 'sk-ant-kept', model: 'claude-opus-5' }, debug: { saveCrops: false } };
    const storedAi = async (local: ReturnType<typeof setUpChrome>['local']) =>
      ((await local.get('settings')) as { settings?: { ai?: { enabled?: boolean; apiKey?: string } } }).settings?.ai;

    it('removes the api.anthropic.com permission and keeps the key', async () => {
      const { local, permissionsRemove, permissionsRequest } = setUpChrome();
      await local.set({ settings: ON });
      render(<App />);
      const checkbox = (await screen.findByRole('checkbox', { name: /ask claude/i })) as HTMLInputElement;
      await waitFor(() => expect(checkbox.checked).toBe(true));

      fireEvent.click(checkbox);

      await waitFor(() => expect(permissionsRemove).toHaveBeenCalledWith({ origins: ['https://api.anthropic.com/*'] }));
      expect(await storedAi(local)).toMatchObject({ enabled: false, apiKey: 'sk-ant-kept' });
      expect(permissionsRequest).not.toHaveBeenCalled();
      expect(checkbox.checked).toBe(false);
    });

    it('stays off when Chrome cannot remove the permission', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { local, permissionsRemove } = setUpChrome();
      permissionsRemove.mockRejectedValue(new Error('permissions API unavailable'));
      await local.set({ settings: ON });
      render(<App />);
      const checkbox = (await screen.findByRole('checkbox', { name: /ask claude/i })) as HTMLInputElement;
      await waitFor(() => expect(checkbox.checked).toBe(true));

      fireEvent.click(checkbox);

      await waitFor(() => expect(permissionsRemove).toHaveBeenCalled());
      await waitFor(() => expect(checkbox.checked).toBe(false));
      expect(await storedAi(local)).toMatchObject({ enabled: false, apiKey: 'sk-ant-kept' });
      warn.mockRestore();
    });
  });

  it('removes nothing when turned on', async () => {
    const { permissionsRequest, permissionsRemove } = setUpChrome();
    render(<App />);
    fireEvent.click(await screen.findByRole('checkbox', { name: /ask claude/i }));
    await waitFor(() => expect(permissionsRequest).toHaveBeenCalled());
    expect(permissionsRemove).not.toHaveBeenCalled();
  });
});

describe('API key', () => {
  it('is saved to chrome.storage.local.settings', async () => {
    const { local } = setUpChrome();
    render(<App />);
    const input = await screen.findByPlaceholderText('sk-ant-...');

    fireEvent.input(input, { target: { value: 'sk-ant-secret' } });

    await waitFor(async () => {
      const stored = (await local.get('settings')) as { settings?: { ai?: { apiKey?: string } } };
      expect(stored.settings?.ai?.apiKey).toBe('sk-ant-secret');
    });
  });
});

describe('Test button', () => {
  it('says the AI check works on success', async () => {
    setUpChrome({ sendMessageImpl: async (msg) => (msg.type === 'test-ai' ? { ok: true } : { cardCount: 0, modelId: 'm' }) });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));

    expect(await screen.findByText('It works: Claude answered using your key.')).toBeTruthy();
  });

  it('shows the mapped error on failure', async () => {
    setUpChrome({
      sendMessageImpl: async (msg) =>
        msg.type === 'test-ai' ? { ok: false, error: 'Anthropic rejected the API key.' } : { cardCount: 0, modelId: 'm' },
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));

    expect(await screen.findByText('Anthropic rejected the API key.')).toBeTruthy();
  });
});

describe('Card data section', () => {
  it('shows the get-status values and refreshes them after "Check for updates now"', async () => {
    const { sendMessage } = setUpChrome();
    render(<App />);

    expect(await screen.findByText('1.0')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Check for updates now' }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'refresh-cards' }));
  });
});

describe('formatArtworksIndexed', () => {
  it('shows an em dash while the bundled count has not loaded yet', () => {
    expect(formatArtworksIndexed(null, 5)).toBe('—');
  });

  it('formats both counts, defaulting a missing delta to 0', () => {
    expect(formatArtworksIndexed(14700, 5)).toBe(
      `${(14700).toLocaleString()} bundled + ${(5).toLocaleString()} added on this computer`,
    );
    expect(formatArtworksIndexed(14700, undefined)).toBe(`${(14700).toLocaleString()} bundled + 0 added on this computer`);
  });
});

describe('formatIndexUpdateState', () => {
  it('shows "never" when there is no update info at all', () => {
    expect(formatIndexUpdateState(undefined)).toBe('Last updated: never');
  });

  it('shows the pending count (with correct pluralisation) while running', () => {
    expect(formatIndexUpdateState({ state: 'running', pending: 3 })).toBe('Updating: 3 artworks left…');
    expect(formatIndexUpdateState({ state: 'running', pending: 1 })).toBe('Updating: 1 artwork left…');
    expect(formatIndexUpdateState({ state: 'running', pending: 0 })).toBe('Updating: 0 artworks left…');
    expect(formatIndexUpdateState({ state: 'running' })).toBe('Updating…');
  });

  it('shows the last completed run time when idle', () => {
    const lastRun = Date.UTC(2026, 0, 1);
    expect(formatIndexUpdateState({ state: 'idle', lastRun })).toBe(`Last updated: ${new Date(lastRun).toLocaleString()}`);
  });

  it('shows the error (or a generic one) when the last run failed', () => {
    expect(formatIndexUpdateState({ state: 'failed', error: 'network error' })).toBe('network error');
    expect(formatIndexUpdateState({ state: 'failed' })).toBe('The last update failed.');
  });
});

describe('Self-updating artwork index', () => {
  it('shows the bundled and locally-added artwork counts once both load', async () => {
    setUpChrome({
      bundledCount: 100,
      sendMessageImpl: async (msg) =>
        msg.type === 'get-status'
          ? { cardCount: 1, modelId: 'dinov2-small', indexDeltaCount: 5, indexUpdate: { state: 'idle' } }
          : { ok: true },
    });
    render(<App />);

    expect(await screen.findByText('100 bundled + 5 added on this computer')).toBeTruthy();
  });

  it('sends update-index and refreshes status when "Update now" is pressed', async () => {
    const { sendMessage } = setUpChrome({
      sendMessageImpl: async (msg) => (msg.type === 'get-status' ? { cardCount: 1, modelId: 'dinov2-small' } : { ok: true }),
    });
    render(<App />);
    await screen.findByRole('button', { name: 'Update now' });

    fireEvent.click(screen.getByRole('button', { name: 'Update now' }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'update-index' }));
    await waitFor(() => {
      const statusCalls = sendMessage.mock.calls.filter((c) => (c[0] as Msg).type === 'get-status').length;
      expect(statusCalls).toBeGreaterThanOrEqual(2); // once on load, once more after the update starts
    });
  });

  it('disables the button and shows "Updating…" (with the pending count) while a run is in progress', async () => {
    setUpChrome({
      sendMessageImpl: async (msg) =>
        msg.type === 'get-status' ? { cardCount: 1, modelId: 'dinov2-small', indexUpdate: { state: 'running', pending: 4 } } : { ok: true },
    });
    render(<App />);

    const button = (await screen.findByRole('button', { name: 'Updating…' })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(await screen.findByText(/Updating: 4 artworks left/)).toBeTruthy();
  });

  it('shows an error message when starting the update fails', async () => {
    setUpChrome({
      sendMessageImpl: async (msg) => {
        if (msg.type === 'get-status') return { cardCount: 1, modelId: 'dinov2-small' };
        if (msg.type === 'update-index') return { ok: false, error: 'The offscreen document is unavailable.' };
        return { ok: true };
      },
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Update now' }));

    expect(await screen.findByText('The offscreen document is unavailable.')).toBeTruthy();
  });

  it('shows the last run error from get-status directly, without needing to press the button', async () => {
    setUpChrome({
      sendMessageImpl: async (msg) =>
        msg.type === 'get-status'
          ? { cardCount: 1, modelId: 'dinov2-small', indexUpdate: { state: 'failed', error: 'YGOPRODeck is unreachable.' } }
          : { ok: true },
    });
    render(<App />);

    expect(await screen.findByText(/YGOPRODeck is unreachable\./)).toBeTruthy();
  });
});

describe('Export test set', () => {
  it('builds a JSON blob of [{dataUrl, cardId}] from the crops store', async () => {
    setUpChrome();
    vi.mocked(getAllCrops).mockResolvedValue([
      { dataUrl: 'd1', cardId: 1, at: 1 },
      { dataUrl: 'd2', cardId: 2, at: 2, entryId: 'e' },
    ]);
    let capturedBlob: Blob | undefined;
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn((b: Blob) => {
        capturedBlob = b;
        return 'blob:fake';
      }),
      revokeObjectURL: vi.fn(),
    });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Export test set (JSON)' }));

    await waitFor(() => expect(capturedBlob).toBeDefined());
    const text = await capturedBlob!.text();
    expect(JSON.parse(text)).toEqual([
      { dataUrl: 'd1', cardId: 1 },
      { dataUrl: 'd2', cardId: 2 },
    ]);

    clickSpy.mockRestore();
  });
});

describe('Change shortcuts', () => {
  it('opens chrome://extensions/shortcuts', async () => {
    const { tabsCreate } = setUpChrome();
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: 'Change shortcuts' }));

    expect(tabsCreate).toHaveBeenCalledWith({ url: 'chrome://extensions/shortcuts' });
  });
});

describe('Sections', () => {
  it('has How to use, Keyboard shortcuts, Show card details, AI check, Data and About', async () => {
    setUpChrome();
    render(<App />);

    for (const name of ['How to use', 'Keyboard shortcuts', 'Show card details', 'AI check', 'Data', 'About']) {
      expect(await screen.findByRole('heading', { level: 2, name })).toBeTruthy();
    }
  });
});

describe('How to use', () => {
  const howTo = async () => (await screen.findByRole('heading', { level: 2, name: 'How to use' })).closest('section')!;

  it('sums up a scan with the live shortcut and links to the welcome guide', async () => {
    setUpChrome({ commands: DEFAULT_COMMANDS.map((c) => (c.name === 'scan-card' ? { ...c, shortcut: 'Ctrl+Shift+K' } : c)) });
    render(<App />);

    const section = await howTo();
    await waitFor(() => expect(combos(section)).toEqual(['Ctrl+Shift+K']));
    const guide = within(section).getByRole('link', { name: 'Open the welcome guide' });
    expect(guide.getAttribute('href')).toBe('welcome.html');
  });

  it('says a hover previews an outlined card and a click shows it in full, with dragging for the rest (the default)', async () => {
    setUpChrome();
    render(<App />);

    const text = (await howTo()).textContent ?? '';
    expect(text).toMatch(/rest the pointer on one for a quick preview, and click it for the full details/i);
    expect(text).toMatch(/drag a box around it/i);
  });

  it('says only a click shows a card when "Click" is chosen', async () => {
    const { local } = setUpChrome();
    await local.set({ settings: { display: { reveal: 'click' } } });
    render(<App />);

    const section = await howTo();
    await waitFor(() => expect(section.textContent).toMatch(/click one for its details/i));
    expect(section.textContent).not.toMatch(/preview/i);
  });

  it('says Duel Lens stays open after a card, and how to leave', async () => {
    setUpChrome();
    render(<App />);

    const text = (await howTo()).textContent ?? '';
    expect(text).toMatch(/stays open/i);
    expect(text).toMatch(/Esc closes a card, and Esc again or ✕ leaves\. Space or K resumes the video\./);
  });
});

// UX-2: "Show card details" (Settings.display.reveal). Hover or click is the default; there is no
// hover-only mode, since a click always works (touch, keyboard, the popover's buttons).
describe('Show card details', () => {
  const group = async () => screen.findByRole('radiogroup', { name: 'Show card details' });
  const radio = (name: RegExp) => screen.getByRole('radio', { name }) as HTMLInputElement;
  const storedSettings = async (local: ReturnType<typeof setUpChrome>['local']) =>
    ((await local.get('settings')) as { settings?: { ai?: { apiKey?: string }; display?: { reveal?: string } } }).settings;

  it('offers Hover or click (the default, chosen) and Click, each with one line of help', async () => {
    setUpChrome();
    render(<App />);

    const choices = within(await group()).getAllByRole('radio') as HTMLInputElement[];
    expect(choices.map((c) => c.value)).toEqual(['hover', 'click']);
    await waitFor(() => expect(radio(/^hover or click/i).checked).toBe(true));
    expect(radio(/^hover or click/i).closest('label')?.textContent).toMatch(/default/i);
    expect(radio(/^click$/i).closest('label')?.textContent).not.toMatch(/default/i);
    expect(radio(/^click$/i).checked).toBe(false);
    for (const choice of choices) {
      const help = document.getElementById(choice.getAttribute('aria-describedby') ?? '');
      expect(help?.textContent?.length).toBeGreaterThan(20);
    }
    expect(document.getElementById(radio(/^hover or click/i).getAttribute('aria-describedby')!)?.textContent).toMatch(/preview/i);
  });

  it('shows the stored choice', async () => {
    const { local } = setUpChrome();
    await local.set({ settings: { display: { reveal: 'click' } } });
    render(<App />);

    await group();
    await waitFor(() => expect(radio(/^click$/i).checked).toBe(true));
    expect(radio(/^hover or click/i).checked).toBe(false);
  });

  it('saves a new choice, keeping the other settings', async () => {
    const { local } = setUpChrome();
    await local.set({ settings: { ai: { enabled: false, apiKey: 'sk-ant-kept', model: 'claude-opus-5' } } });
    render(<App />);
    await group();

    fireEvent.click(radio(/^click$/i));

    await waitFor(async () => expect((await storedSettings(local))?.display?.reveal).toBe('click'));
    expect((await storedSettings(local))?.ai?.apiKey).toBe('sk-ant-kept');
    await waitFor(() => expect(radio(/^click$/i).checked).toBe(true));

    fireEvent.click(radio(/^hover or click/i));

    await waitFor(async () => expect((await storedSettings(local))?.display?.reveal).toBe('hover'));
  });
});

describe('Keyboard shortcuts', () => {
  it("lists Chrome's current bindings, and says when one isn't set", async () => {
    setUpChrome({
      commands: DEFAULT_COMMANDS.map((c) =>
        c.name === 'scan-card' ? { ...c, shortcut: 'Ctrl+Shift+K' } : c.name === 'open-panel' ? { ...c, shortcut: '' } : c,
      ),
    });
    render(<App />);

    const section = (await screen.findByRole('heading', { level: 2, name: 'Keyboard shortcuts' })).closest('section')!;
    await waitFor(() => expect(combos(section)).toContain('Ctrl+Shift+K'));
    expect(within(section).getByText('Scan a card')).toBeTruthy();
    expect(within(section).getByText('Open the side panel')).toBeTruthy();
    expect(within(section).getByText('Not set')).toBeTruthy();
    // The toolbar icon's own command is only listed once the user has given it a shortcut.
    expect(within(section).queryByText(/toolbar icon/i)).toBeNull();
  });

  // Lead's ruling (UX-CORE): Space and K, YouTube's play keys, always leave scan mode and resume the
  // video, so "Keep in side panel" moved from K to S.
  it('names the keys on the frozen picture (Tab, Enter, Esc; Space or K resumes the video) and in the card view (S keeps)', async () => {
    setUpChrome();
    render(<App />);

    const section = (await screen.findByRole('heading', { level: 2, name: 'Keyboard shortcuts' })).closest('section')!;
    expect(section.textContent).toMatch(/Tab moves between the outlined cards, Enter reads one, and Esc leaves\. Space or K resumes the video/);
    expect(section.textContent).toMatch(/In the card view: Esc closes it/);
    expect(section.textContent).toMatch(/S keeps the card in the side panel/);
    expect(document.body.textContent).not.toMatch(/K keeps|K to keep/);
  });

  it('lists the toolbar icon command when the user gave it a shortcut', async () => {
    setUpChrome({ commands: DEFAULT_COMMANDS.map((c) => (c.name === '_execute_action' ? { ...c, shortcut: 'Alt+Shift+J' } : c)) });
    render(<App />);

    const section = (await screen.findByRole('heading', { level: 2, name: 'Keyboard shortcuts' })).closest('section')!;
    await waitFor(() => expect(combos(section)).toContain('Alt+Shift+J'));
    expect(within(section).getByText(/toolbar icon/i)).toBeTruthy();
  });
});

describe('AI check section', () => {
  it('discloses what is sent, to whom and at whose cost, above the toggle (before it can be turned on)', async () => {
    setUpChrome();
    render(<App />);

    const section = (await screen.findByRole('heading', { level: 2, name: 'AI check' })).closest('section')!;
    const disclosure = within(section).getByText(AI_DISCLOSURE);
    const toggle = within(section).getByRole('checkbox', { name: /ask claude/i });
    expect(disclosure.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(AI_DISCLOSURE).toMatch(/cropped image of that card and up to five candidate card names to Anthropic/);
    expect(AI_DISCLOSURE).toMatch(/billed to your key/);
    expect(within(section).getByText(/US cents? per check/i)).toBeTruthy();
    const keyLink = within(section).getByRole('link', { name: /get an api key/i });
    expect(keyLink.getAttribute('href')).toMatch(/^https:\/\//);
  });

  it("uses the store listing's disclosure word for word (store/privacy-practices.md, section 7)", () => {
    const doc = readFileSync(path.join(process.cwd(), 'store/privacy-practices.md'), 'utf8');
    const words = (t: string) => t.replace(/\s+/g, ' ');
    expect(words(doc)).toContain(words(AI_DISCLOSURE));
  });

  it('names the models in plain words, keeping their ids as values', async () => {
    setUpChrome();
    render(<App />);

    const select = (await screen.findByLabelText('Model')) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'Claude Opus 5 (recommended)',
      'Claude Sonnet 5 (lower cost)',
    ]);
  });
});

describe('Data section status', () => {
  it('says the card database is loading until get-status answers', async () => {
    setUpChrome({ sendMessageImpl: () => new Promise(() => {}) });
    render(<App />);

    expect(await screen.findByText(/loading the card database/i)).toBeTruthy();
  });

  it('says the card database is ready once it has cards', async () => {
    setUpChrome();
    render(<App />);

    expect(await screen.findByText('Ready: 42 cards loaded.')).toBeTruthy();
  });

  it('reports a failed load, with a retry that asks the background again', async () => {
    let reachable = false;
    const { sendMessage } = setUpChrome({
      sendMessageImpl: async (msg) => {
        if (msg.type !== 'get-status') return { ok: true };
        if (!reachable) throw new Error('Could not establish connection.');
        return { cardCount: 42, modelId: 'dinov2-small' };
      },
    });
    render(<App />);

    expect(await screen.findByText(/couldn't load the card database/i)).toBeTruthy();
    reachable = true;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Ready: 42 cards loaded.')).toBeTruthy();
    expect(sendMessage.mock.calls.filter(([m]) => (m as Msg).type === 'get-status').length).toBeGreaterThanOrEqual(2);
  });

  it('keeps asking for the status while the artwork index updates, until the run ends', async () => {
    let statusCalls = 0;
    setUpChrome({
      sendMessageImpl: async (msg) => {
        if (msg.type !== 'get-status') return { ok: true };
        statusCalls++;
        return statusCalls < 3
          ? { cardCount: 1, modelId: 'dinov2-small', indexUpdate: { state: 'running', pending: 3 - statusCalls } }
          : { cardCount: 1, modelId: 'dinov2-small', indexUpdate: { state: 'idle', lastRun: Date.UTC(2026, 0, 2) } };
      },
    });
    render(<App pollMs={20} />);

    await screen.findByRole('button', { name: 'Updating…' });
    expect(await screen.findByText(`Last updated: ${new Date(Date.UTC(2026, 0, 2)).toLocaleString()}`)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Update now' }) as HTMLButtonElement).disabled).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(statusCalls).toBe(3); // no more polling once the run is over
  });
});

describe('About', () => {
  const about = async () => (await screen.findByRole('heading', { level: 2, name: 'About' })).closest('section')!;

  it('shows the version from the manifest, the disclaimer, and links to the privacy policy and licences in the extension', async () => {
    setUpChrome();
    render(<App />);

    const section = await about();
    expect(within(section).getByText('Version 1.2.3')).toBeTruthy();
    expect(within(section).getByText(DISCLAIMER)).toBeTruthy();
    expect(within(section).getByRole('link', { name: 'Privacy policy' }).getAttribute('href')).toBe('privacy.html');
    expect(within(section).getByRole('link', { name: 'Licences' }).getAttribute('href')).toBe('licenses.html');
  });

  it('carries the full legal notice and the accuracy notice (docs/release/disclaimers.md §2 and §6)', async () => {
    setUpChrome();
    render(<App />);

    const section = await about();
    expect(section.textContent).toContain(legalNotice(true));
    expect(section.textContent).toContain(ACCURACY);
    expect(section.textContent).toMatch(/Card data and images come from YGOPRODeck/);
  });

  it('says when the user gave the first-run consent', async () => {
    const at = Date.UTC(2026, 8, 29, 9, 30);
    setUpChrome({
      sendMessageImpl: async (msg) => (msg.type === 'get-status' ? { cardCount: 42, modelId: 'dinov2-small', consentedAt: at } : { ok: true }),
    });
    render(<App />);

    const section = await about();
    expect(await within(section).findByText(`You agreed on ${new Date(at).toLocaleDateString(undefined, { dateStyle: 'long' })}.`)).toBeTruthy();
  });

  it("says scans stay off until the user agrees, with the way to the consent step", async () => {
    setUpChrome();
    render(<App />);

    const section = await about();
    expect(await within(section).findByText(/You haven't agreed yet/)).toBeTruthy();
    expect(within(section).getByRole('link', { name: /review and agree/i }).getAttribute('href')).toBe('welcome.html#consent');
  });

  it('says only "Card data" comes from YGOPRODeck in a build without remote images', async () => {
    vi.stubGlobal('__DUEL_LENS_REMOTE_IMAGES__', false);
    setUpChrome();
    render(<App />);

    const section = await about();
    expect(section.textContent).toMatch(/Card data comes from YGOPRODeck\./);
    expect(section.textContent).toContain(legalNotice(false));
    expect(section.textContent).not.toMatch(/images come from/);
  });
});

// The crop build (`--no-remote-images`: __DUEL_LENS_REMOTE_IMAGES__ off) downloads no artwork: the
// bundled index only, and new cards come with Duel Lens's updates (legal-audit.md B2 and D3).
describe('Artwork index without remote images (the crop build, --no-remote-images)', () => {
  it('explains that new cards come with updates, and offers no download', async () => {
    vi.stubGlobal('__DUEL_LENS_REMOTE_IMAGES__', false);
    const { sendMessage } = setUpChrome({ bundledCount: 14627 });
    render(<App />);

    const section = (await screen.findByRole('heading', { level: 2, name: 'Data' })).closest('section')!;
    expect(await within(section).findByText(`${(14627).toLocaleString()} bundled with Duel Lens`)).toBeTruthy();
    expect(section.textContent).toMatch(/doesn't download artwork/);
    expect(section.textContent).toMatch(/new cards come with its updates/i);
    expect(within(section).queryByRole('button', { name: 'Update now' })).toBeNull();
    expect(within(section).getByRole('button', { name: 'Check for updates now' })).toBeTruthy(); // card data still updates
    expect(sendMessage).not.toHaveBeenCalledWith({ type: 'update-index' });
  });
});
