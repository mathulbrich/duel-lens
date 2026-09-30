// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Welcome } from './app';
import { DISCLAIMER } from './links';

type Msg = { type: string };
type Command = { name?: string; description?: string; shortcut?: string };

/** What chrome.commands.getAll reports for a fresh install on Windows/Linux (the manifest's defaults). */
const DEFAULT_COMMANDS: Command[] = [
  { name: '_execute_action', description: '', shortcut: '' },
  { name: 'scan-card', description: 'Scan a card on this page', shortcut: 'Alt+Shift+Y' },
  { name: 'open-panel', description: 'Open the Duel Lens side panel', shortcut: 'Alt+Shift+U' },
];

const READY = { cardCount: 13462, modelId: 'dinov2-small-duel', dbVersion: '104.1', cardsUpdatedAt: Date.UTC(2026, 8, 1) };

function commandsWith(overrides: Record<string, string>): Command[] {
  return DEFAULT_COMMANDS.map((c) => (c.name! in overrides ? { ...c, shortcut: overrides[c.name!] } : c));
}

function setUpChrome(
  opts: { getAll?: () => Promise<Command[]>; sendMessage?: (msg: Msg) => Promise<unknown>; consentedAt?: number } = {},
) {
  const getAll = vi.fn(opts.getAll ?? (async () => DEFAULT_COMMANDS));
  const sendMessage = vi.fn(opts.sendMessage ?? (async (msg: Msg) => (msg.type === 'get-status' ? READY : { ok: true })));
  const tabsCreate = vi.fn(async () => ({}));
  const tabsRemove = vi.fn(async () => undefined);
  // What the service worker stored when the user agreed (src/background/consent.ts).
  const storageGet = vi.fn(async (key: string) => (key === 'consentedAt' && opts.consentedAt ? { consentedAt: opts.consentedAt } : {}));
  vi.stubGlobal('chrome', {
    commands: { getAll },
    runtime: {
      sendMessage,
      getURL: (p: string) => `chrome-extension://abc/${p}`,
      getManifest: () => ({
        version: '1.2.3',
        commands: {
          'scan-card': { suggested_key: { default: 'Alt+Shift+Y' } },
          'open-panel': { suggested_key: { default: 'Alt+Shift+U' } },
        },
      }),
    },
    storage: { local: { get: storageGet } },
    tabs: { create: tabsCreate, getCurrent: vi.fn(async () => ({ id: 3 })), remove: tabsRemove },
  });
  return { getAll, sendMessage, tabsCreate, tabsRemove };
}

/** Every key combination shown on the page, as its text ("Alt+Shift+Y"). */
function combos(): string[] {
  return Array.from(document.querySelectorAll('kbd.combo')).map((k) => k.textContent ?? '');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  history.replaceState(null, '', location.pathname); // no #consent left for the next test
});

describe('the scan shortcut', () => {
  it('shows the shortcut Chrome reports, not the manifest default', async () => {
    setUpChrome({ getAll: async () => commandsWith({ 'scan-card': 'Ctrl+Shift+K' }) });
    render(<Welcome />);

    await waitFor(() => expect(combos()).toContain('Ctrl+Shift+K'));
    expect(combos()).not.toContain('Alt+Shift+Y');
  });

  it('names the macOS modifier symbols Chrome reports there', async () => {
    setUpChrome({ getAll: async () => commandsWith({ 'scan-card': '⌥⇧Y' }) });
    render(<Welcome />);

    await waitFor(() => expect(combos()).toContain('⌥ Option+⇧ Shift+Y'));
  });

  it('says when no shortcut is set, and offers to set one or use the toolbar icon', async () => {
    const { tabsCreate } = setUpChrome({ getAll: async () => commandsWith({ 'scan-card': '' }) });
    render(<Welcome />);

    expect(await screen.findByText(/no shortcut is set/i)).toBeTruthy();
    expect(screen.getAllByText(/toolbar/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Set a shortcut' }));
    expect(tabsCreate).toHaveBeenCalledWith({ url: 'chrome://extensions/shortcuts' });
  });

  it('reads the shortcut again when the user comes back to the page (after changing it)', async () => {
    let shortcut = 'Alt+Shift+Y';
    setUpChrome({ getAll: async () => commandsWith({ 'scan-card': shortcut }) });
    render(<Welcome />);
    await waitFor(() => expect(combos()).toContain('Alt+Shift+Y'));

    shortcut = 'Ctrl+Shift+L';
    window.dispatchEvent(new Event('focus'));

    await waitFor(() => expect(combos()).toContain('Ctrl+Shift+L'));
  });

  it('falls back to the default shortcut, marked as such, when Chrome cannot say', async () => {
    setUpChrome({ getAll: async () => Promise.reject(new Error('no commands API')) });
    render(<Welcome />);

    await waitFor(() => expect(combos()).toContain('Alt+Shift+Y'));
    expect(screen.getByText(/the default shortcut/i)).toBeTruthy();
  });

  it('shows the side panel shortcut too', async () => {
    setUpChrome({ getAll: async () => commandsWith({ 'open-panel': 'Ctrl+Shift+P' }) });
    render(<Welcome />);

    await waitFor(() => expect(combos()).toContain('Ctrl+Shift+P'));
  });

  it('links to chrome://extensions/shortcuts, opened in a new tab (a plain link to it is blocked)', async () => {
    const { tabsCreate } = setUpChrome();
    render(<Welcome />);

    const link = await screen.findByRole('link', { name: 'chrome://extensions/shortcuts' });
    expect(link.getAttribute('href')).toBe('chrome://extensions/shortcuts');
    fireEvent.click(link);

    expect(tabsCreate).toHaveBeenCalledWith({ url: 'chrome://extensions/shortcuts' });
  });
});

describe('the card database status', () => {
  it('says the database is loading while get-status is pending', async () => {
    setUpChrome({ sendMessage: () => new Promise(() => {}) });
    render(<Welcome />);

    expect(await screen.findByText(/loading the card database/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('says it is ready, with the number of cards, once get-status answers', async () => {
    const { sendMessage } = setUpChrome();
    render(<Welcome />);

    expect(await screen.findByText(`Ready: ${(13462).toLocaleString()} cards loaded.`)).toBeTruthy();
    expect(sendMessage).toHaveBeenCalledWith({ type: 'get-status' });
  });

  it('reports a failure (no cards) with a retry that asks again', async () => {
    let answer: unknown = { cardCount: 0, modelId: 'dinov2-small-duel' };
    const { sendMessage } = setUpChrome({ sendMessage: async () => answer });
    render(<Welcome />);

    expect(await screen.findByText(/couldn't load the card database/i)).toBeTruthy();
    answer = READY;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText(`Ready: ${(13462).toLocaleString()} cards loaded.`)).toBeTruthy();
    expect(sendMessage.mock.calls.filter(([m]) => (m as Msg).type === 'get-status')).toHaveLength(2);
  });

  it('reports a failure when the background cannot be reached', async () => {
    setUpChrome({ sendMessage: async () => Promise.reject(new Error('Could not establish connection.')) });
    render(<Welcome />);

    expect(await screen.findByText(/couldn't load the card database/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('how to use it', () => {
  it('explains the three steps, with the live shortcut in the first', async () => {
    setUpChrome({ getAll: async () => commandsWith({ 'scan-card': 'Ctrl+Shift+K' }) });
    render(<Welcome />);

    const steps = await screen.findByRole('list', { name: 'Three steps' });
    const items = within(steps).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    await waitFor(() => expect(within(items[0]).getByText('Ctrl').closest('kbd.combo')?.textContent).toBe('Ctrl+Shift+K'));
    expect(within(items[1]).getByText(/just its artwork/i)).toBeTruthy();
    expect(within(items[2]).getByText(/side panel/i)).toBeTruthy();
  });

  it('gives the tips for a good match', async () => {
    setUpChrome();
    render(<Welcome />);

    expect(await screen.findByText(/pause on a clear frame/i)).toBeTruthy();
    expect(screen.getByText(/720p or higher/i)).toBeTruthy();
    expect(screen.getByText(/drawing a box\? whole card or just the art/i)).toBeTruthy();
  });

  // UX-1 and UX-2: resting the pointer on an outlined card previews it, a click reads it in full, and
  // Duel Lens stays open for the next card until the user leaves (Esc, the ✕, or Space).
  it('leads with pointing at an outlined card for a preview, and keeps dragging for the rest', async () => {
    setUpChrome();
    render(<Welcome />);

    const step = (await screen.findByText('Point at a card')).closest('li')!;
    expect(step.textContent).toMatch(/Cards Duel Lens finds get a gold outline: rest the pointer on one for a quick preview\./);
    expect(step.textContent).toMatch(/For a card without one, or just its artwork, drag a box around it\./);
  });

  it('says where to turn the previews off (Options, Show card details)', async () => {
    setUpChrome();
    render(<Welcome />);

    const step = (await screen.findByText('Point at a card')).closest('li')!;
    expect(step.textContent).toMatch(/only when you click it\? Choose Click in Options/);
    expect(within(step).getByRole('link', { name: 'Options' }).getAttribute('href')).toBe('options.html#card-details');
  });

  it('reads a card with a click, and says Duel Lens stays open until the user leaves', async () => {
    setUpChrome({ getAll: async () => commandsWith({ 'open-panel': 'Ctrl+Shift+P' }) });
    render(<Welcome />);

    const step = (await screen.findByText('Click to read it')).closest('li')!;
    expect(step.textContent).toMatch(/Its name, type and full text appear beside the card\./);
    expect(step.textContent).toMatch(/Duel Lens stays open, so you can click the next card right away\./);
    expect(step.textContent).toMatch(/Esc closes the card, and Esc again or ✕ leaves\. Space or K resumes the video\./);
    await waitFor(() => expect(step.querySelector('kbd.combo')?.textContent).toBe('Ctrl+Shift+P'));
  });

  // Lead's ruling (UX-CORE): Space and K, YouTube's play keys, always leave scan mode and resume the
  // video, so "Keep in side panel" moved from K to S.
  it('says S keeps the card in the side panel, not K', async () => {
    setUpChrome();
    render(<Welcome />);

    const step = (await screen.findByText('Click to read it')).closest('li')!;
    expect(step.textContent).toMatch(/Press S to keep the card in the side panel/);
    expect(document.body.textContent).not.toMatch(/K to keep|K keeps/);
  });

  it('says the video stays paused until the user leaves', async () => {
    setUpChrome();
    render(<Welcome />);

    const steps = await screen.findByRole('list', { name: 'Three steps' });
    expect(within(steps).getAllByRole('listitem')[0].textContent).toMatch(/The picture freezes and the video pauses until you leave/);
  });

  it('shows an illustration with a text description', async () => {
    setUpChrome();
    render(<Welcome />);

    const figure = await screen.findByRole('figure');
    expect(within(figure).getByText(/made up/i)).toBeTruthy();
  });

  it("draws scan mode's bar in the illustration, and says in words that Duel Lens stays open", async () => {
    setUpChrome();
    render(<Welcome />);

    const figure = await screen.findByRole('figure');
    expect(figure.querySelector('.demo-scanbar')?.textContent).toMatch(/Duel Lens · 1 card · Esc to exit/);
    expect(figure.querySelector('figcaption')?.textContent).toMatch(/stays open/i);
  });
});

describe('privacy and the small print', () => {
  it("says what stays on this computer and what goes online", async () => {
    setUpChrome();
    render(<Welcome />);

    const local = await screen.findByRole('region', { name: 'On this computer' });
    // The legal workstream's wording (docs/release/disclaimers.md §4; copy.test.ts checks it word for word).
    expect(local.textContent).toMatch(/the matching stay on this computer/);
    // What the local history holds, not just that it exists (store/privacy-practices.md, section 7).
    expect(local.textContent).toMatch(/with the address of the page each came from, until you clear it/);
    const online = screen.getByRole('region', { name: 'Online' });
    expect(online.textContent).toMatch(/Card data and pictures come from YGOPRODeck/);
    expect(online.textContent).toMatch(/YGOPRODeck can see which card pictures your browser asks for/);
    expect(online.textContent).toMatch(/only if you turn it on/i);
    expect(online.textContent).toMatch(/your own API key/i);
  });

  it('says in a build without remote images that no card pictures are downloaded, and that each scan keeps a small picture', async () => {
    vi.stubGlobal('__DUEL_LENS_REMOTE_IMAGES__', false);
    setUpChrome();
    render(<Welcome />);

    const local = await screen.findByRole('region', { name: 'On this computer' });
    expect(local.textContent).toMatch(/and a small picture of what you selected/);
    const online = screen.getByRole('region', { name: 'Online' });
    expect(online.textContent).toMatch(/Card data comes from YGOPRODeck/);
    expect(online.textContent).toMatch(/downloads no card pictures/);
    expect(online.textContent).not.toMatch(/pictures come from|card pictures your browser asks for/);
    expect(screen.getByText(/^Card data from/)).toBeTruthy();
    expect(document.body.textContent).toContain('Card data comes from YGOPRODeck (ygoprodeck.com)'); // the legal notice
  });

  it('shows the Konami disclaimer', async () => {
    setUpChrome();
    render(<Welcome />);

    expect(await screen.findByText(DISCLAIMER)).toBeTruthy();
    expect(DISCLAIMER).toMatch(/not affiliated with or endorsed by Konami/);
  });

  it('links to the options page and to YGOPRODeck', async () => {
    setUpChrome();
    render(<Welcome />);

    await screen.findByText(DISCLAIMER);
    const options = screen.getAllByRole('link', { name: /options/i });
    expect(options.some((a) => a.getAttribute('href') === 'options.html')).toBe(true);
    const ygoprodeck = screen.getAllByRole('link', { name: /YGOPRODeck/ });
    expect(ygoprodeck.every((a) => a.getAttribute('href') === 'https://ygoprodeck.com/')).toBe(true);
  });

  it('links to the privacy policy and the licences in the extension, and shows the version from the manifest', async () => {
    setUpChrome();
    render(<Welcome />);

    const footer = (await screen.findByText(DISCLAIMER)).closest('footer')!;
    expect(within(footer).getByRole('link', { name: 'Privacy policy' }).getAttribute('href')).toBe('privacy.html');
    expect(within(footer).getByRole('link', { name: 'Licences' }).getAttribute('href')).toBe('licenses.html');
    expect(within(footer).getByText('Version 1.2.3')).toBeTruthy();
    expect(within(footer).queryByText(/link coming soon/)).toBeNull();
  });

  it('carries the full legal notice in the footer, and the YGOPRODeck credit', async () => {
    setUpChrome();
    render(<Welcome />);

    const footer = (await screen.findByText(DISCLAIMER)).closest('footer')!;
    expect(footer.textContent).toContain('It is not produced, sponsored, endorsed or approved by, or affiliated with, Konami');
    expect(footer.textContent).toContain('Card data and card images come from YGOPRODeck (ygoprodeck.com)');
    expect(within(footer).getByText(/^Card data and images from/)).toBeTruthy();
  });
});

describe('the headline', () => {
  it('leads with what Duel Lens does, and names the game only to say what it works with', async () => {
    setUpChrome();
    render(<Welcome />);

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Read any card in a duel video');
    expect(document.querySelector('.lede')?.textContent).toMatch(/for the Yu-Gi-Oh! TRADING CARD GAME/);
  });
});

// The Chrome Web Store's rule (2026-07-01): a prominent disclosure, and the user's own "Agree", before
// Duel Lens first handles their data (legal-audit.md B4; the text is docs/release/disclaimers.md §4a).
describe('the first-run consent', () => {
  const consentRegion = () => screen.findByRole('region', { name: /before your first scan|needs your OK/i });

  it('shows the disclosure with Agree and start before the first use, above how to use it', async () => {
    setUpChrome();
    render(<Welcome />);

    const region = await consentRegion();
    expect(within(region).getByRole('heading', { name: 'Before your first scan' })).toBeTruthy();
    expect(region.textContent).toContain('Duel Lens needs your OK to handle this data:');
    expect([...region.querySelectorAll('li b')].map((b) => b.textContent)).toEqual([
      'Screenshots.',
      'History.',
      'Card data and pictures.',
      'AI check (off).',
    ]);
    expect(within(region).getByRole('button', { name: 'Agree and start' })).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Not now' })).toBeTruthy();
    expect(within(region).getByRole('link', { name: 'Privacy policy' }).getAttribute('href')).toBe('privacy.html');
    const how = screen.getByRole('heading', { level: 2, name: 'How to use it' });
    expect(region.compareDocumentPosition(how) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('uses the text-only disclosure in a build without remote images', async () => {
    vi.stubGlobal('__DUEL_LENS_REMOTE_IMAGES__', false);
    setUpChrome();
    render(<Welcome />);

    const region = await consentRegion();
    expect([...region.querySelectorAll('li b')].map((b) => b.textContent)).toContain('Card data.');
    expect(region.textContent).toMatch(/a small picture of what you selected/);
    expect(region.textContent).not.toMatch(/which card pictures/);
  });

  it('Agree and start records the consent, then says the user is all set, with the live shortcut', async () => {
    const { sendMessage } = setUpChrome({ getAll: async () => commandsWith({ 'scan-card': 'Ctrl+Shift+K' }) });
    render(<Welcome />);

    fireEvent.click(within(await consentRegion()).getByRole('button', { name: 'Agree and start' }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'grant-consent' }));
    const done = await screen.findByText(/You're all set: press/);
    expect(done.textContent).toMatch(/on a video/);
    expect(done.querySelector('kbd.combo')?.textContent).toBe('Ctrl+Shift+K');
    expect(screen.queryByRole('button', { name: 'Agree and start' })).toBeNull();
  });

  it('says so, and keeps the button, when the consent could not be saved', async () => {
    setUpChrome({ sendMessage: async (msg) => (msg.type === 'grant-consent' ? { ok: false, error: 'quota exceeded' } : READY) });
    render(<Welcome />);

    fireEvent.click(within(await consentRegion()).getByRole('button', { name: 'Agree and start' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/quota exceeded/);
    expect(screen.getByRole('button', { name: 'Agree and start' })).toBeTruthy();
  });

  it('Not now closes the page without agreeing', async () => {
    const { sendMessage, tabsRemove } = setUpChrome();
    render(<Welcome />);

    fireEvent.click(within(await consentRegion()).getByRole('button', { name: 'Not now' }));

    await waitFor(() => expect(tabsRemove).toHaveBeenCalledWith(3));
    expect(sendMessage).not.toHaveBeenCalledWith({ type: 'grant-consent' });
  });

  it('opened by a scan before agreeing (#consent): the consent step is in focus, and says why', async () => {
    history.replaceState(null, '', '#consent');
    setUpChrome();
    render(<Welcome />);

    const region = await consentRegion();
    expect(within(region).getByRole('heading', { name: 'Duel Lens needs your OK before its first scan.' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(region));
  });

  it('once agreed, says when instead of asking again', async () => {
    const at = Date.UTC(2026, 8, 29, 9, 30);
    setUpChrome({ consentedAt: at });
    render(<Welcome />);

    expect(await screen.findByText(`You agreed on ${new Date(at).toLocaleDateString(undefined, { dateStyle: 'long' })}.`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Agree and start' })).toBeNull();
  });
});
