// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveLog } from '../shared/live';
import type { CardRecord } from '../shared/types';
import { LiveView, liveStatusText } from './live-view';

afterEach(cleanup);

const log = (over: Partial<LiveLog> = {}): LiveLog => ({
  tabId: 7,
  pageKey: 'yt:abc',
  pageUrl: 'https://www.youtube.com/watch?v=abc',
  pageTitle: 'A duel',
  startedAt: 1,
  status: 'watching',
  intervalMs: 500,
  voting: 0,
  entries: [],
  ...over,
});
const card = (id: number, name: string): CardRecord => ({ id, name, type: 'Spell Card', frameType: 'spell', desc: '', imageIds: [id] });
const CARDS = { 1: card(1, 'Pot of Greed'), 2: card(2, 'Ash Blossom & Joyous Spring') };

function setup(l: LiveLog | null, hint: string | null = null) {
  const fns = { onOpen: vi.fn(), onSeek: vi.fn(), onStart: vi.fn(), onStop: vi.fn() };
  render(<LiveView log={l} cards={CARDS} images={{ 1: 'data:image/jpeg;base64,AAA' }} hint={hint} {...fns} />);
  return fns;
}

describe('liveStatusText', () => {
  it('says watching at about 2 frames a second for 500 ms', () => {
    expect(liveStatusText(log({ status: 'watching', intervalMs: 500 }))).toContain('about 2 frames a second');
  });

  it('rounds the rate to one decimal', () => {
    expect(liveStatusText(log({ status: 'watching', intervalMs: 800 }))).toContain('about 1.3 frames a second');
  });

  it('gives the seconds between frames when slow', () => {
    expect(liveStatusText(log({ status: 'slow', intervalMs: 2000 }))).toContain('one frame every 2 s');
  });

  it('explains a stop caused by leaving the video', () => {
    expect(liveStatusText(log({ status: 'stopped', stopReason: 'left' }))).toContain('you moved to another video');
  });

  it('explains a blocked video, a plain stop, starting and paused', () => {
    expect(liveStatusText(log({ status: 'stopped', stopReason: 'blocked' }))).toContain('blocks screenshots');
    expect(liveStatusText(log({ status: 'blocked' }))).toContain('blocks screenshots');
    expect(liveStatusText(log({ status: 'stopped', stopReason: 'user' }))).toMatch(/^Live stopped\. This list stays/);
    expect(liveStatusText(log({ status: 'starting', intervalMs: undefined }))).toContain('loading the card reader');
    expect(liveStatusText(log({ status: 'paused' }))).toContain('Paused with the video');
  });

  it('is empty before any session', () => {
    expect(liveStatusText(null)).toBe('');
  });
});

describe('LiveView', () => {
  const entries = [
    { cardId: 2, imageId: 2, firstVideoTime: 100, lastVideoTime: 131, appearances: 3 },
    { cardId: 1, imageId: 1, firstVideoTime: 20, lastVideoTime: 65, appearances: 1 },
  ];

  it('lists entries newest first with the seen chip only above 1', () => {
    setup(log({ entries }));
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Ash Blossom & Joyous Spring')).toBeTruthy();
    expect(within(rows[0]).getByText('seen 3×')).toBeTruthy();
    expect(within(rows[1]).getByText('Pot of Greed')).toBeTruthy();
    expect(within(rows[1]).queryByText(/seen/)).toBeNull();
    expect(rows[1].querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAA');
    expect(screen.getByText(/Only cards Duel Lens is sure of are listed\. Click a name to see the card on the video, or a time to jump the video back there\./)).toBeTruthy();
  });

  it('the time button seeks and the name opens the card', () => {
    const fns = setup(log({ entries }));
    fireEvent.click(screen.getByRole('button', { name: 'Jump the video to 2:11' }));
    expect(fns.onSeek).toHaveBeenCalledWith(131);
    expect(fns.onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pot of Greed' }));
    expect(fns.onOpen).toHaveBeenCalledWith(1);
    expect(fns.onSeek).toHaveBeenCalledTimes(1);
  });

  it('shows Start Live, the idle text and no status with no log', () => {
    const fns = setup(null);
    expect(screen.getByText('Seen in this video')).toBeTruthy();
    expect(screen.getByText('Live lists every card a playing video shows clearly, without pausing it.')).toBeTruthy();
    expect(screen.queryByText(/Watching/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start Live' }));
    expect(fns.onStart).toHaveBeenCalled();
  });

  it('shows Stop Live and the running empty text while it runs', () => {
    const fns = setup(log());
    expect(screen.getByText('Cards show up here once Duel Lens has seen them clearly for a moment.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop Live' }));
    expect(fns.onStop).toHaveBeenCalled();
  });

  it('shows Start again after it stopped, keeping the list', () => {
    const fns = setup(log({ status: 'stopped', stopReason: 'user', entries }));
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    expect(fns.onStart).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Stop Live' })).toBeNull();
  });

  it('shows "Checking 2 more cards…" while two tracks vote, and the singular for one', () => {
    setup(log({ voting: 2 }));
    expect(screen.getByText('Checking 2 more cards…')).toBeTruthy();
    cleanup();
    setup(log({ voting: 1 }));
    expect(screen.getByText('Checking 1 more card…')).toBeTruthy();
  });

  it('shows the hint after a refused start', () => {
    setup(null, 'sidepanel_live_needs_shortcut');
    expect(screen.getByText("Press Alt+Shift+L on the video's tab to start Live.")).toBeTruthy();
  });
});
