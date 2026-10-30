// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import type { ToBackground } from '../shared/messages';
import type { ReportCardResponse, ReportDraft } from '../shared/report';
import { ReportPanel } from './report-panel';
import { trustEvents } from './test-events';

let sendMessage: Mock<(msg: ToBackground) => Promise<unknown>>;
let reply: ReportCardResponse;
let distrust: () => void;

const DRAFT: Omit<ReportDraft, 'comment'> = {
  kind: 'not-sure',
  dataUrl: 'data:image/png;base64,AAAA',
  shown: { cardId: 14558127, name: 'Ash Blossom & Joyous Spring', score: 0.61, confident: false },
  others: [{ cardId: 73642296, name: 'Ghost Belle & Haunted Mansion', score: 0.58 }],
  userCard: null,
  pageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=4',
  videoTime: 3735.4,
  modelId: 'dinov2-small-duel-v3b',
};

beforeEach(() => {
  distrust = trustEvents();
  reply = { ok: true, issue: { number: 12, url: 'https://github.com/mathulbrich/duel-lens/issues/12' } };
  sendMessage = vi.fn(async (msg: ToBackground) => {
    if (msg.type === 'report-card') return reply;
    throw new Error(`unexpected message: ${msg.type}`);
  });
  vi.stubGlobal('chrome', { runtime: { id: 'test-extension-id', sendMessage } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  distrust();
});

const send = () => act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Send report' })));

describe('ReportPanel', () => {
  it('lists what goes before anything is sent: the picture, the card, the video at its moment (no other parameters)', () => {
    render(<ReportPanel draft={DRAFT} />);
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([
      'the picture you selected',
      'the card shown: Ash Blossom & Joyous Spring',
      'the video at 1:02:15: https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      "Duel Lens's version, your browser and system",
    ]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('sends the draft with the trimmed comment on the user’s click, then links the issue', async () => {
    render(<ReportPanel draft={DRAFT} />);
    fireEvent.input(screen.getByRole('textbox', { name: "What's wrong? (optional)" }), { target: { value: "  It's Ghost Ogre  " } });
    await send();
    expect(sendMessage).toHaveBeenCalledWith({ type: 'report-card', report: { ...DRAFT, comment: "It's Ghost Ogre" } });
    expect(screen.getByRole('status').textContent).toContain('Reported as issue #12');
    expect(screen.getByRole('link', { name: 'View on GitHub' }).getAttribute('href')).toBe('https://github.com/mathulbrich/duel-lens/issues/12');
  });

  it("sends nothing on a script's click", async () => {
    distrust();
    render(<ReportPanel draft={DRAFT} />);
    await send();
    expect(sendMessage).not.toHaveBeenCalled();
    distrust = trustEvents();
  });

  it('says what went wrong, and offers Options when Firefox still needs the consent', async () => {
    const onOpenOptions = vi.fn();
    reply = { ok: false, error: 'consent' };
    render(<ReportPanel draft={DRAFT} onOpenOptions={onOpenOptions} />);
    await send();
    expect(screen.getByRole('alert').textContent).toMatch(/permission/);
    fireEvent.click(screen.getByRole('button', { name: 'Open Options' }));
    expect(onOpenOptions).toHaveBeenCalled();
    reply = { ok: false, error: 'rate-limited' };
    await send();
    expect(screen.getByRole('alert').textContent).toMatch(/Too many reports/);
  });

  it("keeps the comment's keys from the page (a video page's own shortcuts)", () => {
    render(<ReportPanel draft={DRAFT} />);
    const onPage = vi.fn();
    document.addEventListener('keydown', onPage);
    fireEvent.keyDown(screen.getByRole('textbox', { name: "What's wrong? (optional)" }), { key: 'f' });
    document.removeEventListener('keydown', onPage);
    expect(onPage).not.toHaveBeenCalled();
  });

  it('says nothing matched when no card was shown', () => {
    render(<ReportPanel draft={{ ...DRAFT, kind: 'no-match', shown: null, others: [] }} />);
    expect(screen.getByText('that nothing matched')).toBeTruthy();
  });
});
