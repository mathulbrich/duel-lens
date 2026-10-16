// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import type { OkResponse, SearchCardsResponse, ToBackground } from '../shared/messages';
import { trustEvents } from './test-events';
import { WrongCardPanel } from './wrong-card';

let sendMessage: Mock<(msg: ToBackground) => Promise<unknown>>;
let searchReply: (msg: Extract<ToBackground, { type: 'search-cards' }>) => SearchCardsResponse;
let correctReply: (msg: Extract<ToBackground, { type: 'correct' }>) => OkResponse;
let distrust: () => void;

const rest = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  distrust = trustEvents(); // the user's own clicks and keys
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  searchReply = () => ({ matches: [] });
  correctReply = () => ({ ok: true });
  sendMessage = vi.fn(async (msg: ToBackground) => {
    if (msg.type === 'search-cards') return searchReply(msg);
    if (msg.type === 'correct') return correctReply(msg);
    throw new Error(`unexpected message: ${msg.type}`);
  });
  vi.stubGlobal('chrome', { runtime: { id: 'test-extension-id', sendMessage } });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  distrust();
});

function type(value: string) {
  fireEvent.input(screen.getByRole('textbox', { name: 'Search for the right card' }), { target: { value } });
}

describe('WrongCardPanel', () => {
  it('searches only once the query reaches 2 characters, after a short debounce', async () => {
    render(<WrongCardPanel entryId="e1" />);
    type('a');
    await rest(500);
    expect(sendMessage).not.toHaveBeenCalled();

    type('as');
    await rest(199);
    expect(sendMessage).not.toHaveBeenCalled(); // still debouncing
    await rest(1);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'search-cards', query: 'as' });
  });

  it('shows the matches, best first, as the background answers them', async () => {
    searchReply = () => ({ matches: [{ cardId: 1, name: 'Ash Blossom & Joyous Spring', imageId: 1 }] });
    render(<WrongCardPanel entryId="e1" />);
    type('ash');
    await rest(200);

    expect(screen.getByRole('button', { name: 'Ash Blossom & Joyous Spring' })).toBeTruthy();
  });

  it('says so when nothing matches', async () => {
    render(<WrongCardPanel entryId="e1" />);
    type('zzzzz');
    await rest(200);

    expect(screen.getByText('No matching cards.')).toBeTruthy();
  });

  it('sends the pick as a normal "correct", with this panel\'s entryId, and confirms it by name', async () => {
    searchReply = () => ({ matches: [{ cardId: 42, name: 'Dark Hole', imageId: 99 }] });
    render(<WrongCardPanel entryId="entry-7" />);
    type('dark');
    await rest(200);

    fireEvent.click(screen.getByRole('button', { name: 'Dark Hole' }));
    await act(async () => {});

    expect(sendMessage).toHaveBeenCalledWith({ type: 'correct', entryId: 'entry-7', cardId: 42, imageId: 99 });
    expect(screen.getByText('Saved. Marked as Dark Hole.')).toBeTruthy();
    // The search box is gone once saved: nothing left to pick.
    expect(screen.queryByRole('textbox', { name: 'Search for the right card' })).toBeNull();
  });

  it('shows an error, and keeps the search box, when saving the pick fails', async () => {
    correctReply = () => ({ ok: false, error: 'storage full' });
    searchReply = () => ({ matches: [{ cardId: 42, name: 'Dark Hole', imageId: 99 }] });
    render(<WrongCardPanel entryId="e1" />);
    type('dark');
    await rest(200);

    fireEvent.click(screen.getByRole('button', { name: 'Dark Hole' }));
    await act(async () => {});

    expect(screen.getByText("Couldn't save that. Try again.")).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Search for the right card' })).toBeTruthy();
  });

  it('ignores a stale search answer that resolves after a newer query was typed', async () => {
    let resolveFirst: ((r: SearchCardsResponse) => void) | undefined;
    sendMessage = vi.fn((msg: ToBackground) => {
      if (msg.type !== 'search-cards') return Promise.resolve(correctReply(msg as Extract<ToBackground, { type: 'correct' }>));
      if (msg.query === 'as') return new Promise((resolve) => (resolveFirst = resolve));
      return Promise.resolve({ matches: [{ cardId: 2, name: 'Second Query Card', imageId: 2 }] });
    });
    vi.stubGlobal('chrome', { runtime: { id: 'test-extension-id', sendMessage } });

    render(<WrongCardPanel entryId="e1" />);
    type('as');
    await rest(200); // fires the first (still-pending) search
    type('ash');
    await rest(200); // fires the second search, which resolves first

    expect(screen.getByRole('button', { name: 'Second Query Card' })).toBeTruthy();

    await act(async () => {
      resolveFirst?.({ matches: [{ cardId: 1, name: 'Stale Card', imageId: 1 }] });
    });
    expect(screen.queryByRole('button', { name: 'Stale Card' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Second Query Card' })).toBeTruthy();
  });
});
