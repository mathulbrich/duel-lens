// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DROLL, IMPERM, ODD_EYES, POT, TALKER } from '../content/test-fixtures';
import { altArtworkId, isAltArtwork } from '../shared/alt-artwork';
import type { CardRecord, HistoryEntry } from '../shared/types';
import { App, formatClockTime, formatVideoTime } from './app';

function fakeStorageArea(initial: Record<string, unknown> = {}) {
  let data: Record<string, unknown> = { ...initial };
  return {
    get: vi.fn(async (key: string | null) => (key === null ? { ...data } : { [key]: data[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      data = { ...data, ...items };
    }),
    remove: vi.fn(async (key: string) => {
      delete data[key];
    }),
  };
}

const ashBlossom: CardRecord = {
  id: 1,
  name: 'Ash Blossom & Joyous Spring',
  type: 'Tuner Monster',
  humanType: 'Tuner Effect Monster',
  frameType: 'effect',
  desc: 'Negate that effect; then, if this card is in your GY...',
  imageIds: [1],
};
const potOfGreed: CardRecord = {
  id: 2,
  name: 'Pot of Greed',
  type: 'Spell Card',
  frameType: 'spell',
  desc: 'Draw 2 cards.',
  imageIds: [2],
};
// Real records (trimCard() output, src/content/test-fixtures.ts) with their Genesys points from the
// bundled card data (extension/data/cards.json).
const droll: CardRecord = { ...DROLL, genesysPoints: 20 };
const pot: CardRecord = { ...POT, genesysPoints: 30 };
const imperm: CardRecord = { ...IMPERM, genesysPoints: 11 };
/** What get-cards answers, by id. */
const CARDS: Record<number, CardRecord> = Object.fromEntries(
  [ashBlossom, potOfGreed, droll, pot, imperm, ODD_EYES, TALKER].map((c) => [c.id, c]),
);

const videoEntry: HistoryEntry = {
  id: 'e1',
  cardId: 1,
  imageId: 1,
  score: 0.9,
  confident: true,
  at: Date.UTC(2026, 0, 1, 12, 0, 0),
  pageUrl: 'https://www.youtube.com/watch?v=abc123',
  pageTitle: 'A duel video',
  videoTime: 1458, // 24:18
  source: 'video',
};
const clockAt = new Date(2026, 0, 1, 15, 4, 0).getTime(); // 3:04 PM local time
const screenshotEntry: HistoryEntry = {
  id: 'e2',
  cardId: 2,
  imageId: 2,
  score: 0.4,
  confident: false,
  at: clockAt,
  pageUrl: 'https://example.com/cards',
  pageTitle: 'A card site',
  source: 'screenshot',
};

function setUpChrome(history: HistoryEntry[], currentEntryId?: string, extra: Record<string, unknown> = {}) {
  const local = fakeStorageArea({ history, ...extra });
  const session = fakeStorageArea(currentEntryId ? { currentEntryId } : {});
  const sendMessage = vi.fn(async (msg: { type: string; ids?: number[]; imageId?: number }) => {
    if (msg.type === 'get-cards') {
      const cards: Record<number, CardRecord> = {};
      for (const id of msg.ids ?? []) {
        if (CARDS[id]) cards[id] = CARDS[id];
      }
      return { cards };
    }
    if (msg.type === 'get-image') {
      return { dataUrl: msg.imageId === 1 ? 'data:image/jpeg;base64,AAA' : null };
    }
    return {};
  });
  const onChanged = { addListener: vi.fn(), removeListener: vi.fn() };
  vi.stubGlobal('chrome', {
    storage: { local, session, onChanged },
    runtime: { sendMessage },
  });
  /** What chrome.storage.onChanged would do after a write (the side panel re-reads). */
  const changed = () => act(() => onChanged.addListener.mock.calls.forEach(([fn]) => fn({}, 'local')));
  return { local, session, sendMessage, changed };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('time formatting', () => {
  it('formats a video time as m:ss', () => {
    expect(formatVideoTime(1458)).toBe('24:18');
    expect(formatVideoTime(5)).toBe('0:05');
    expect(formatVideoTime(3599)).toBe('59:59');
  });

  // live-check m3: streams run 8+ hours, and "436:32" isn't how YouTube shows 7:16:32.
  it('formats a video time of an hour or more as h:mm:ss, as YouTube does', () => {
    expect(formatVideoTime(26192)).toBe('7:16:32');
    expect(formatVideoTime(26192.9)).toBe('7:16:32');
    expect(formatVideoTime(7200)).toBe('2:00:00');
    expect(formatVideoTime(3600)).toBe('1:00:00');
    expect(formatVideoTime(36061)).toBe('10:01:01');
  });

  it('formats a clock time deterministically from the local hour/minute', () => {
    expect(formatClockTime(clockAt)).toBe('3:04 PM');
  });
});

describe('App', () => {
  it('shows the empty state when nothing has been scanned', async () => {
    setUpChrome([]);
    render(<App />);
    expect(await screen.findByText('Nothing scanned yet. Press Alt+Shift+Y, then click a card (or drag a box around one).')).toBeTruthy();
  });

  it('renders the current entry (image and text) and the history list newest first, each with a name and a time', async () => {
    setUpChrome([videoEntry, screenshotEntry], 'e1');
    render(<App />);

    // Current card: the video entry, shown large with its full text.
    expect(await screen.findByRole('heading', { name: 'Ash Blossom & Joyous Spring' })).toBeTruthy();
    expect(screen.getByText(/Negate that effect/)).toBeTruthy();
    const img = (await screen.findByAltText('Ash Blossom & Joyous Spring')) as HTMLImageElement;
    expect(img.src).toBe('data:image/jpeg;base64,AAA');

    // History list, newest first.
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Ash Blossom & Joyous Spring');
    expect(rows[0].textContent).toContain('24:18');
    expect(rows[1].textContent).toContain('Pot of Greed');
    expect(rows[1].textContent).toContain(formatClockTime(clockAt));
  });

  // ALT-ART: an entry naming an artwork YGOPRODeck lacks (a synthetic id, src/shared/alt-artwork.ts). The background
  // records the card's image instead; an entry that still has one shows the card's own first image all the same.
  it("shows the card's own YGOPRODeck image for an entry naming an artwork YGOPRODeck lacks, and never asks for that id", async () => {
    const { sendMessage } = setUpChrome([{ ...videoEntry, imageId: altArtworkId(12950, 3) }], 'e1');
    render(<App />);

    const img = (await screen.findByAltText('Ash Blossom & Joyous Spring')) as HTMLImageElement;
    expect(img.src).toBe('data:image/jpeg;base64,AAA');
    const asked = sendMessage.mock.calls.filter(([m]) => m.type === 'get-image').map(([m]) => m.imageId);
    expect(asked).toEqual([ashBlossom.imageIds[0]]);
    expect(asked.filter((id) => isAltArtwork(id!))).toEqual([]);
  });

  it('gets an "Open at 24:18" YouTube link for a video entry', async () => {
    setUpChrome([videoEntry, screenshotEntry], 'e1');
    render(<App />);

    const link = (await screen.findByRole('link', { name: /Open at 24:18/ })) as HTMLAnchorElement;
    expect(link.href).toBe('https://www.youtube.com/watch?v=abc123&t=1458s');
    expect(screen.queryByRole('link', { name: /Open at/ })).toBe(link); // only one such link (screenshot entry has none)
  });

  // live-check p3: a row read "436:32 · Open at 436:32". The time itself is the link now, once.
  it('makes a video entry’s time the link, shown once; other entries keep a plain time', async () => {
    setUpChrome([{ ...videoEntry, videoTime: 26192 }, screenshotEntry], 'e1');
    render(<App />);

    const link = (await screen.findByRole('link', { name: 'Open at 7:16:32' })) as HTMLAnchorElement;
    expect(link.textContent).toBe('7:16:32');
    expect(link.href).toBe('https://www.youtube.com/watch?v=abc123&t=26192s');
    expect(link.target).toBe('_blank');
    const [videoRow, screenshotRow] = screen.getAllByRole('listitem');
    expect(videoRow.textContent?.split('7:16:32')).toHaveLength(2); // the time appears once
    expect(videoRow.textContent).not.toMatch(/Open at/);
    expect(link.closest('button')).toBeNull(); // a link of its own, not inside the entry's button
    expect(within(screenshotRow).queryByRole('link')).toBeNull();
    expect(within(screenshotRow).getByText(formatClockTime(clockAt))).toBeTruthy();
  });

  it('makes an entry current when clicked', async () => {
    const { session } = setUpChrome([videoEntry, screenshotEntry], 'e1');
    render(<App />);
    await screen.findByRole('heading', { name: 'Ash Blossom & Joyous Spring' });

    fireEvent.click(screen.getByText('Pot of Greed'));

    expect(await screen.findByRole('heading', { name: 'Pot of Greed' })).toBeTruthy();
    expect(session.set).toHaveBeenCalledWith({ currentEntryId: 'e2' });
  });

  it('empties the list when "Clear history" is clicked', async () => {
    setUpChrome([videoEntry, screenshotEntry], 'e1');
    render(<App />);
    await screen.findByRole('heading', { name: 'Ash Blossom & Joyous Spring' });

    fireEvent.click(screen.getByRole('button', { name: 'Clear history' }));

    expect(await screen.findByText('Nothing scanned yet. Press Alt+Shift+Y, then click a card (or drag a box around one).')).toBeTruthy();
  });

  // Review Minor (ledger M11): an unhandled rejection here used to leave the current
  // card stuck on "Loading…" forever, with no way for the user to tell what happened.
  it('shows a readable message instead of "Loading…" forever when get-cards fails', async () => {
    const { sendMessage } = setUpChrome([videoEntry], 'e1');
    sendMessage.mockImplementation(async (msg: { type: string }) => {
      if (msg.type === 'get-cards') throw new Error('disconnected');
      return {};
    });

    render(<App />);

    expect(await screen.findByText("Couldn't load this card. Try again.")).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('shows a readable note instead of silently failing when the card image fails to load', async () => {
    const { sendMessage } = setUpChrome([videoEntry], 'e1');
    sendMessage.mockImplementation(async (msg: { type: string; ids?: number[] }) => {
      if (msg.type === 'get-cards') return { cards: { 1: ashBlossom } };
      if (msg.type === 'get-image') throw new Error('disconnected');
      return {};
    });

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Ash Blossom & Joyous Spring' })).toBeTruthy();
    expect(await screen.findByText("Couldn't load the card image.")).toBeTruthy();
  });
});

// a11y review m2 and m3: which entry is current, and which card is shown, reach a screen reader.
describe('accessibility', () => {
  const entryButton = (name: string) => screen.getByText(name, { selector: '.entry .name' }).closest('button') as HTMLButtonElement;

  it('marks the current entry with aria-current, and moves it with the selection', async () => {
    setUpChrome([videoEntry, screenshotEntry], 'e1');
    render(<App />);
    await screen.findByRole('heading', { name: 'Ash Blossom & Joyous Spring' });
    await screen.findByText('Pot of Greed');

    expect(entryButton('Ash Blossom & Joyous Spring').getAttribute('aria-current')).toBe('true');
    expect(entryButton('Pot of Greed').hasAttribute('aria-current')).toBe(false);

    fireEvent.click(entryButton('Pot of Greed'));

    await screen.findByRole('heading', { name: 'Pot of Greed' });
    expect(entryButton('Pot of Greed').getAttribute('aria-current')).toBe('true');
    expect(entryButton('Ash Blossom & Joyous Spring').hasAttribute('aria-current')).toBe(false);
  });

  it('marks the entry it shows when none was made current yet (the newest)', async () => {
    setUpChrome([videoEntry, screenshotEntry]);
    render(<App />);
    await screen.findByRole('heading', { name: 'Ash Blossom & Joyous Spring' });

    expect(entryButton('Ash Blossom & Joyous Spring').getAttribute('aria-current')).toBe('true');
    expect(entryButton('Pot of Greed').hasAttribute('aria-current')).toBe(false);
  });

  it('announces "Showing <card>" in a small status region when the shown card changes, not the whole card text', async () => {
    setUpChrome([videoEntry, screenshotEntry], 'e1');
    render(<App />);
    await screen.findByRole('heading', { name: 'Ash Blossom & Joyous Spring' });

    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Showing Ash Blossom & Joyous Spring');
    expect(status.classList.contains('sr-only')).toBe(true);
    // No live region on the card itself: it would read out the whole card text.
    const current = document.querySelector('section.current') as HTMLElement;
    expect(current.hasAttribute('aria-live')).toBe(false);
    expect(current.hasAttribute('role')).toBe(false);

    fireEvent.click(entryButton('Pot of Greed'));

    await screen.findByRole('heading', { name: 'Pot of Greed' });
    expect(screen.getByRole('status')).toBe(status); // the same live region, updated: not a new node
    expect(status.textContent).toBe('Showing Pot of Greed');
  });

  it('keeps its status region in place from the empty panel to the first scan, so that scan is announced', async () => {
    const { local, changed } = setUpChrome([]);
    render(<App />);
    await screen.findByText(/Nothing scanned yet/);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');

    await local.set({ history: [videoEntry] });
    await changed();

    await screen.findByRole('heading', { name: 'Ash Blossom & Joyous Spring' });
    expect(screen.getByRole('status')).toBe(status);
    expect(status.textContent).toBe('Showing Ash Blossom & Joyous Spring');
  });

  it('announces a face-down card too', async () => {
    setUpChrome([{ ...videoEntry, id: 'fd', cardId: -1 }], 'fd');
    render(<App />);
    await screen.findByText('Face-down card', { selector: 'p' });

    expect(screen.getByRole('status').textContent).toBe('Showing a face-down card');
  });
});

// The user's report (F3): the panel showed only the picture, the name, the type and the text. It now shows
// the popover's card details (src/content/card-view.tsx), facts included.
describe('card details, as in the popover', () => {
  const entryFor = (card: CardRecord): HistoryEntry => ({ ...screenshotEntry, id: `e-${card.id}`, cardId: card.id, imageId: card.imageIds[0] });
  const current = () => document.querySelector('section.current') as HTMLElement;
  const chips = () => [...current().querySelectorAll('.dv-facts .fact')].map((f) => f.textContent);
  const show = async (name: string) => {
    fireEvent.click(screen.getByText(name, { selector: '.entry .name' }));
    await screen.findByRole('heading', { name, level: 3 });
  };

  it('shows a monster’s Attribute, Level, ATK/DEF, TCG banlist status and Genesys points', async () => {
    setUpChrome([entryFor(droll)], `e-${droll.id}`);
    render(<App />);
    await screen.findByRole('heading', { name: 'Droll & Lock Bird' });

    expect(chips()).toEqual(['WIND', 'Level 1', 'ATK 0 / DEF 0', 'Semi-Limited · TCG', 'Genesys 20 pts']);
    expect(within(current()).getByText('Genesys 20 pts').hasAttribute('aria-label')).toBe(false); // read as shown (final review M11)
    expect(within(current()).getByText('[Spellcaster / Effect]')).toBeTruthy();
    expect(within(current()).getByText(/^If a card\(s\) is added from the Main Deck/)).toBeTruthy();
    expect(within(current()).getByText('Passcode 94145021')).toBeTruthy();
  });

  it('shows a Spell’s and a Trap’s banlist status and Genesys points, and no monster facts', async () => {
    setUpChrome([entryFor(pot), entryFor(imperm)], `e-${pot.id}`);
    render(<App />);
    await screen.findByRole('heading', { name: 'Pot of Greed' });

    expect(chips()).toEqual(['SPELL', 'Forbidden · TCG', 'Genesys 30 pts']);
    expect(within(current()).getByText('[Normal Spell]')).toBeTruthy();
    expect(current().textContent).not.toMatch(/ATK|DEF|Level|Rank|LINK-|Scale/);

    await show('Infinite Impermanence');
    expect(chips()).toEqual(['TRAP', 'Genesys 11 pts']);
    expect(within(current()).getByText('[Normal Trap]')).toBeTruthy();
    expect(current().textContent).not.toMatch(/ATK|DEF|Level|Rank|LINK-|Scale/);
  });

  it('gives a Pendulum its Scale and its two effects apart, and a Link its rating, arrows and ATK only', async () => {
    setUpChrome([entryFor(ODD_EYES), entryFor(TALKER)], `e-${ODD_EYES.id}`);
    render(<App />);
    await screen.findByRole('heading', { name: 'Odd-Eyes Pendulum Dragon' });

    expect(chips()).toEqual(['DARK', 'Level 7', 'Scale 4', 'ATK 2500 / DEF 2000']);
    const pend = within(current()).getByRole('heading', { name: 'Pendulum Effect' }).closest('section');
    const mon = within(current()).getByRole('heading', { name: 'Monster Effect' }).closest('section');
    expect(pend?.textContent).toMatch(/You can reduce the battle damage you take/);
    expect(mon?.textContent).toMatch(/any battle damage this card inflicts to your opponent is doubled/);

    await show('Accesscode Talker');
    expect(chips()).toEqual(['DARK', 'LINK-4', '↑←→↓', 'ATK 2300']);
    expect(within(current()).getByLabelText('Link arrows: Top, Left, Right, Bottom')).toBeTruthy();
    expect(current().textContent).not.toMatch(/DEF/);
    expect(within(current()).getByText('Passcode 86066372 · Archetype: Code Talker')).toBeTruthy();
  });

  it('keeps its own picture: the official image, named, and no second picture or placeholder from the details', async () => {
    setUpChrome([videoEntry], 'e1');
    render(<App />);

    const img = (await screen.findByAltText('Ash Blossom & Joyous Spring')) as HTMLImageElement;
    expect(current().querySelectorAll('img')).toHaveLength(1);
    expect(screen.queryByLabelText('Loading card image')).toBeNull();
    // The picture first, then the details.
    expect(img.compareDocumentPosition(current().querySelector('.dv') as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps a heading outline with no skipped level: Current card › the card › This session', async () => {
    setUpChrome([videoEntry, screenshotEntry], 'e1');
    render(<App />);
    await screen.findByRole('heading', { name: 'Ash Blossom & Joyous Spring' });

    const outline = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => `${h.tagName} ${h.textContent}`);
    expect(outline).toEqual(['H2 Current card', 'H3 Ash Blossom & Joyous Spring', 'H2 This session']);
    // "Current card" is for screen readers only: the picture and the name say it on screen.
    expect(screen.getByRole('heading', { name: 'Current card', level: 2 }).classList.contains('sr-only')).toBe(true);
  });
});

// The crop build (`--no-remote-images`: __DUEL_LENS_REMOTE_IMAGES__ off) shows no card image from
// YGOPRODeck: the panel shows the small picture of the user's own crop that the background keeps with
// each entry (history.ts).
describe('without remote images (the crop build, --no-remote-images)', () => {
  beforeEach(() => {
    vi.stubGlobal('__DUEL_LENS_REMOTE_IMAGES__', false);
  });

  const THUMB = 'data:image/jpeg;base64,/9j/THUMB';

  it("shows the picture of the user's scan, and asks for no card image", async () => {
    const { sendMessage } = setUpChrome([videoEntry, screenshotEntry], 'e1', { 'thumb:e1': THUMB });
    render(<App />);

    const img = (await screen.findByAltText('What you scanned: Ash Blossom & Joyous Spring')) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(THUMB);
    expect(sendMessage.mock.calls.filter(([m]) => m.type === 'get-image')).toEqual([]);
  });

  it('shows the picture of the scan for an entry naming an artwork YGOPRODeck lacks too, and asks for no card image', async () => {
    const { sendMessage } = setUpChrome([{ ...videoEntry, imageId: altArtworkId(12950, 3) }], 'e1', { 'thumb:e1': THUMB });
    render(<App />);

    const img = (await screen.findByAltText('What you scanned: Ash Blossom & Joyous Spring')) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(THUMB);
    expect(sendMessage.mock.calls.filter(([m]) => m.type === 'get-image')).toEqual([]);
  });

  it('shows the full card details under the picture of the user’s scan', async () => {
    const entry: HistoryEntry = { ...screenshotEntry, id: 'e-droll', cardId: droll.id, imageId: droll.imageIds[0] };
    setUpChrome([entry], 'e-droll', { 'thumb:e-droll': THUMB });
    render(<App />);

    const img = await screen.findByAltText('What you scanned: Droll & Lock Bird');
    const facts = [...document.querySelectorAll('section.current .dv-facts .fact')].map((f) => f.textContent);
    expect(facts).toEqual(['WIND', 'Level 1', 'ATK 0 / DEF 0', 'Semi-Limited · TCG', 'Genesys 20 pts']);
    expect([...document.querySelectorAll('section.current img')]).toEqual([img]); // the crop is the only picture
  });

  it('shows the card without a picture when none was kept, and no error', async () => {
    setUpChrome([screenshotEntry], 'e2');
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Pot of Greed' })).toBeTruthy();
    expect(document.querySelector('.current img')).toBeNull();
    expect(screen.queryByText("Couldn't load the card image.")).toBeNull();
  });

  it('shows the picture once it is kept, a moment after the scan', async () => {
    const { local, changed } = setUpChrome([videoEntry], 'e1');
    render(<App />);
    await screen.findByRole('heading', { name: 'Ash Blossom & Joyous Spring' });

    await local.set({ 'thumb:e1': THUMB });
    changed();

    expect(((await screen.findByAltText(/What you scanned/)) as HTMLImageElement).getAttribute('src')).toBe(THUMB);
  });

  it('credits YGOPRODeck for the card data only', async () => {
    setUpChrome([videoEntry], 'e1');
    render(<App />);

    const foot = await screen.findByText(/Unofficial fan tool, not affiliated with or endorsed by Konami/);
    expect(foot.textContent).toMatch(/^Card data: YGOPRODeck/);
  });
});

describe('credit', () => {
  it('credits YGOPRODeck for the card data and images, with the short disclaimer', async () => {
    setUpChrome([videoEntry], 'e1');
    render(<App />);

    const foot = await screen.findByText(/Unofficial fan tool, not affiliated with or endorsed by Konami/);
    expect(foot.textContent).toMatch(/^Card data and images: YGOPRODeck/);
    expect(foot.querySelector('a')?.getAttribute('href')).toBe('https://ygoprodeck.com/');
  });
});
