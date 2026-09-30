// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/preact';
import type { ComponentProps } from 'preact';
import { alternativeIndices, announcement, COPY, Popover, type PopoverHandle, type PopoverState } from './popover';
import { cardText } from './card-view';
import { trustEvents, untrusted } from './test-events';
import { ASH, BELLE, DROLL, ODD_EYES_HEAVENLY, OGRE, VEILER, VIDEO_CROP, response } from './test-fixtures';

let distrust: () => void;

beforeEach(() => {
  distrust = trustEvents(); // the user's own clicks and keys
  // installKeyHandler checks chrome.runtime.id (a live, non-invalidated context, as real
  // content scripts always have) before handling a key.
  vi.stubGlobal('chrome', { runtime: { id: 'test-extension-id' } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  distrust();
});

const ANCHOR = { x: 100, y: 100, w: 120, h: 175 };

function setup(state: PopoverState, extra: Partial<ComponentProps<typeof Popover>> = {}) {
  const handle: { current: PopoverHandle | null } = { current: null };
  const props = {
    onClose: vi.fn(),
    onKeep: vi.fn(),
    onCorrect: vi.fn(),
    onAskAi: vi.fn(),
    onOpenOptions: vi.fn(),
    handle,
    ...extra,
  };
  render(<Popover anchor={ANCHOR} state={state} {...props} />);
  return props;
}

/** A confident match whose other matches are all far below it (none within 0.10). */
const confident = (): PopoverState => ({
  kind: 'result',
  response: response([ASH, BELLE, OGRE, DROLL], [0.96, 0.71, 0.64, 0.52]),
  crop: VIDEO_CROP,
  selected: 0,
});

/** A confident match with two other matches within 0.10 of it (Belle, Ogre), and one further off (Droll). */
const close = (): PopoverState => ({
  kind: 'result',
  response: response([ASH, BELLE, OGRE, DROLL], [0.96, 0.93, 0.9, 0.84]),
  crop: VIDEO_CROP,
  selected: 0,
});

const unsure = (crop = VIDEO_CROP, aiEnabled = true): PopoverState => ({
  kind: 'result',
  response: response([VEILER, DROLL, OGRE, BELLE], [0.74, 0.69, 0.52, 0.4], { confident: false, aiEnabled }),
  crop,
  selected: 0,
});

function key(k: string) {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  document.body.dispatchEvent(e);
  return e;
}

describe('Popover: a confident match', () => {
  it('shows the card, the match meter, the close alternatives and the actions', () => {
    setup(close());
    expect(screen.getByRole('heading', { name: 'Ash Blossom & Joyous Spring' })).toBeTruthy();
    expect(screen.getByText('96% match')).toBeTruthy();
    const alts = within(screen.getByRole('group', { name: 'Other matches' })).getAllByRole('button');
    expect(alts.map((b) => b.textContent)).toEqual(['Ghost Belle & Haunted Mansion93%', 'Ghost Ogre & Snow Rabbit90%']);
    expect(screen.getByText('Not it?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep in side panel' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy text' })).toBeTruthy();
    // Credit where the data comes from: the card's YGOPRODeck page (the user's ask).
    const page = screen.getByRole('link', { name: 'YGOPRODeck ↗' });
    expect(page.getAttribute('href')).toBe('https://ygoprodeck.com/card/?search=14558127');
    expect(page.getAttribute('target')).toBe('_blank');
    expect(page.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.queryByText(/Not sure/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ask AI' })).toBeNull();
  });

  // Live check p2: "card outline" and "whole box" mean nothing to users; they go in a tooltip.
  it('keeps how and from what it matched in a tooltip, off the match line', () => {
    setup(confident());
    // best = { hypothesis: 'quad', rotation: 180 }, crop from a 720p video frame
    const line = document.querySelector('.dv-match')!;
    expect(line.getAttribute('title')).toBe('card outline, upside-down · 720p video');
    expect(line.textContent).toBe('96% match');
  });

  it('shows the video quality on the match line when it is 480p or less, as a hint', () => {
    setup({ ...(confident() as Extract<PopoverState, { kind: 'result' }>), crop: { ...VIDEO_CROP, videoHeight: 480 } });
    expect(document.querySelector('.dv-match')!.textContent).toBe('96% match · 480p video');
  });

  // Live check p1: under a confident 86%, "Not it?" listed unrelated cards at about 60%.
  it('offers, under a confident match, only the matches within 0.10 of it, and no "Not it?" at all when none is', () => {
    setup(close());
    const alts = within(screen.getByRole('group', { name: 'Other matches' })).getAllByRole('button');
    expect(alts.map((b) => b.querySelector('em')!.textContent)).toEqual([BELLE.name, OGRE.name]); // not Droll (0.84)
    cleanup();
    setup(confident());
    expect(screen.queryByRole('group', { name: 'Other matches' })).toBeNull();
    expect(screen.queryByText('Not it?')).toBeNull();
  });

  it('still steps through every match with ← and → when the far ones are not offered', () => {
    const p = setup(confident());
    p.handle.current!.step(1); // → (scan mode's key handler, selection.tsx)
    expect(p.onCorrect).toHaveBeenLastCalledWith(BELLE.id, BELLE.imageIds[0]);
  });

  it('picks an alternative on click', () => {
    const p = setup(close());
    fireEvent.click(screen.getByRole('button', { name: /Ghost Ogre/ }));
    expect(p.onCorrect).toHaveBeenCalledWith(OGRE.id, OGRE.imageIds[0]);
  });

  it('marks a picked alternative as the user’s choice', () => {
    setup({ ...(confident() as Extract<PopoverState, { kind: 'result' }>), selected: 2 });
    expect(screen.getByRole('heading', { name: 'Ghost Ogre & Snow Rabbit' })).toBeTruthy();
    expect(screen.getByText('You picked this')).toBeTruthy();
    // The top match is now one of the alternatives.
    expect(screen.getByRole('button', { name: /Ash Blossom/ })).toBeTruthy();
  });

  it('shows the matched artwork and the alternatives’ thumbnails', () => {
    const { container } = render(
      <Popover
        anchor={ANCHOR}
        state={close()}
        images={{ [ASH.imageIds[0]]: 'data:image/jpeg;base64,MAIN' }}
        thumbs={{ [BELLE.imageIds[0]]: 'data:image/jpeg;base64,THUMB' }}
        onClose={vi.fn()}
        onKeep={vi.fn()}
        onCorrect={vi.fn()}
        onAskAi={vi.fn()}
      />,
    );
    const srcs = [...container.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(srcs).toContain('data:image/jpeg;base64,MAIN');
    expect(srcs).toContain('data:image/jpeg;base64,THUMB');
  });

  it('shows the small image while the full one is still loading', () => {
    const { container } = render(
      <Popover
        anchor={ANCHOR}
        state={confident()}
        images={{}}
        thumbs={{ [ASH.imageIds[0]]: 'data:image/jpeg;base64,SMALL' }}
        onClose={vi.fn()}
        onKeep={vi.fn()}
        onCorrect={vi.fn()}
        onAskAi={vi.fn()}
      />,
    );
    expect(container.querySelector('.dv-card img')?.getAttribute('src')).toBe('data:image/jpeg;base64,SMALL');
  });

  // The crop build (`--no-remote-images`: __DUEL_LENS_REMOTE_IMAGES__ off) shows no card image from
  // YGOPRODeck: the picture is the user's own crop (legal-audit.md B2, option c).
  it('shows the user’s own crop where the card image would be, and no thumbnails for the other matches', () => {
    const { container } = render(
      <Popover anchor={ANCHOR} state={close()} cropImage={VIDEO_CROP.dataUrl} onClose={vi.fn()} onKeep={vi.fn()} onCorrect={vi.fn()} onAskAi={vi.fn()} />,
    );
    const img = container.querySelector('.dv-card img');
    expect(img?.getAttribute('src')).toBe(VIDEO_CROP.dataUrl);
    expect(img?.getAttribute('alt')).toBe('What you selected');
    expect(container.querySelector('.dv-card.crop')).not.toBeNull();
    expect(container.querySelectorAll('.alt img, .alt .thumb')).toHaveLength(0);
    expect(within(screen.getByRole('group', { name: 'Other matches' })).getAllByRole('button')).toHaveLength(2);
  });

  it('keeps showing the crop when the user picks another match', () => {
    const picked = { ...(confident() as Extract<PopoverState, { kind: 'result' }>), selected: 2 };
    const { container } = render(
      <Popover anchor={ANCHOR} state={picked} cropImage={VIDEO_CROP.dataUrl} onClose={vi.fn()} onKeep={vi.fn()} onCorrect={vi.fn()} onAskAi={vi.fn()} />,
    );
    expect(screen.getByRole('heading', { name: 'Ghost Ogre & Snow Rabbit' })).toBeTruthy();
    expect(container.querySelector('.dv-card img')?.getAttribute('src')).toBe(VIDEO_CROP.dataUrl);
  });

  it('labels a card the AI named from outside the matches as the AI’s pick, without a score', () => {
    const base = unsure() as Extract<PopoverState, { kind: 'result' }>;
    const res = base.response;
    const withAsh = {
      ...res,
      cards: { ...res.cards, [ASH.id]: ASH },
      result: { ...res.result, candidates: [...res.result.candidates, { cardId: ASH.id, imageId: ASH.imageIds[0], score: 0 }] },
    };
    setup({ ...base, response: withAsh, selected: 4 }, { ai: { status: 'answered', answer: ASH.name, cardId: ASH.id } });
    expect(screen.getByRole('heading', { name: ASH.name })).toBeTruthy();
    expect(screen.getByText('AI pick')).toBeTruthy();
    expect(screen.queryByText(/0% match/)).toBeNull();
  });
});

describe('Popover: keys', () => {
  // Scan mode's one key handler (selection.tsx) reads the keys and calls these (app.test.tsx has them end to end).
  it('hands its key actions over: S keeps, ←/→ cycle the matches, and it takes no key from the page itself', () => {
    const page = vi.fn();
    document.addEventListener('keydown', page);
    const p = setup(confident());

    p.handle.current!.keep();
    expect(p.onKeep).toHaveBeenCalledTimes(1);
    p.handle.current!.step(1);
    expect(p.onCorrect).toHaveBeenLastCalledWith(BELLE.id, BELLE.imageIds[0]);
    p.handle.current!.step(-1); // wraps from the top match to the last one
    expect(p.onCorrect).toHaveBeenLastCalledWith(DROLL.id, DROLL.imageIds[0]);
    expect(p.handle.current!.element()).toBe(screen.getByRole('dialog'));
    for (const k of ['k', 's', 'c', 'ArrowRight', 'Escape']) key(k);
    expect(page).toHaveBeenCalledTimes(5);
    expect(p.onClose).not.toHaveBeenCalled();

    cleanup(); // a popover that goes away clears its actions
    expect(p.handle.current).toBeNull();
    document.removeEventListener('keydown', page);
  });

  it('keeps nothing without a history entry (a card shown from its preview, until its entry comes)', () => {
    const pending = close() as Extract<PopoverState, { kind: 'result' }>;
    const p = setup({ ...pending, response: { ...pending.response, entry: undefined } }, { keepPending: true });
    const keepButton = screen.getByRole('button', { name: 'Keep in side panel' }) as HTMLButtonElement;
    expect(keepButton.disabled).toBe(true); // there, disabled: no jump once the entry comes
    p.handle.current!.keep();
    fireEvent.click(keepButton);
    expect(p.onKeep).not.toHaveBeenCalled();
  });

  it('C copies the card text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const p = setup(confident());
    p.handle.current!.copy();
    expect(writeText).toHaveBeenCalledWith(cardText(ASH));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('↑ and ↓ scroll the card text while it can scroll that way, else the popover', () => {
    const p = setup(confident());
    const text = document.querySelector<HTMLElement>('.dv-text')!;
    const scroller = document.querySelector<HTMLElement>('.pop-scroll')!;
    const size = (el: HTMLElement, scroll: number, client: number) => {
      Object.defineProperty(el, 'scrollHeight', { value: scroll, configurable: true });
      Object.defineProperty(el, 'clientHeight', { value: client, configurable: true });
    };
    size(text, 400, 176);
    size(scroller, 900, 600);
    p.handle.current!.scroll(1);
    expect([text.scrollTop, scroller.scrollTop]).toEqual([40, 0]);
    p.handle.current!.scroll(-1);
    p.handle.current!.scroll(-1); // the text is at its top: the popover scrolls instead (not above its own top)
    expect([text.scrollTop, scroller.scrollTop]).toEqual([0, 0]);
    size(text, 176, 176); // a short text: the popover scrolls
    p.handle.current!.scroll(1);
    expect(scroller.scrollTop).toBe(40);
  });

  it('says so when copying is blocked', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true });
    setup(confident());
    fireEvent.click(screen.getByRole('button', { name: 'Copy text' }));
    expect(await screen.findByText('Copying is blocked here. Select the text instead.')).toBeTruthy();
  });
});

describe('Popover: unsure', () => {
  it('leads with "Not sure" and offers Ask AI', () => {
    const p = setup(unsure());
    const notSure = screen.getByText(/Not sure/);
    const name = screen.getByRole('heading', { name: 'Effect Veiler' });
    expect(notSure.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    expect(p.onAskAi).toHaveBeenCalledTimes(1);
    // The alternatives lead too, ahead of the card text.
    const alts = screen.getByRole('group', { name: 'Other matches' });
    expect(alts.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('points to Options when the response says the AI check is off', () => {
    const p = setup(unsure(VIDEO_CROP, false));
    expect(screen.queryByRole('button', { name: 'Ask AI' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on AI check in Options' }));
    expect(p.onOpenOptions).toHaveBeenCalledTimes(1);
  });

  it('suggests raising the quality of a video at 480p or lower', () => {
    setup(unsure({ ...VIDEO_CROP, videoHeight: 480 }));
    expect(screen.getByText('Raise the video quality for a better match')).toBeTruthy();
  });

  it('does not show the quality tip for HD video or screenshots', () => {
    setup(unsure({ ...VIDEO_CROP, videoHeight: 720 }));
    expect(screen.queryByText('Raise the video quality for a better match')).toBeNull();
    cleanup();
    setup(unsure({ ...VIDEO_CROP, source: 'screenshot', videoHeight: undefined }));
    expect(screen.queryByText('Raise the video quality for a better match')).toBeNull();
  });

  it('shows the AI check while it runs, its answer, and its errors', () => {
    setup(unsure(), { ai: { status: 'asking' } });
    const asking = screen.getByRole('button', { name: 'Asking AI…' }) as HTMLButtonElement;
    expect(asking.disabled).toBe(true);
    cleanup();

    setup(unsure(), { ai: { status: 'answered', answer: 'Effect Veiler', cardId: VEILER.id } });
    expect(screen.getByText('AI says: Effect Veiler')).toBeTruthy();
    // The AI confirmed the top match: the match line no longer reads "Not sure".
    expect(screen.getByText('AI agrees')).toBeTruthy();
    expect(screen.queryByText(/Not sure/)).toBeNull();
    cleanup();

    // The AI names the top match but isn't sure itself: never "AI agrees", keep "Not sure".
    setup(unsure(), { ai: { status: 'answered', answer: 'Effect Veiler', cardId: VEILER.id, confident: false } });
    expect(screen.getByText("AI isn't sure: Effect Veiler")).toBeTruthy();
    expect(screen.queryByText('AI agrees')).toBeNull();
    expect(screen.queryByText('AI says: Effect Veiler')).toBeNull();
    expect(screen.getByText(/Not sure/)).toBeTruthy();
    cleanup();

    setup(unsure(), { ai: { status: 'answered', answer: 'Some Unknown Card' } });
    expect(screen.getByText('AI says "Some Unknown Card", which isn\'t in the card data.')).toBeTruthy();
    cleanup();

    setup(unsure(), { ai: { status: 'failed', message: 'Invalid API key' } });
    expect(screen.getByText('AI check failed: Invalid API key')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ask AI' })).toBeTruthy(); // can retry
  });
});

// click-regression-report.md: no reading cleared the floor, but a face-up card was picked (a click, or the
// detector's card in the box): the engine offers its closest cards, and the popover says they're a low match.
describe('Popover: suggestions (a low match)', () => {
  const suggested = (): PopoverState => ({
    kind: 'result',
    response: response([VEILER, DROLL, OGRE], [0.69, 0.66, 0.63], { confident: false, suggested: true }),
    crop: VIDEO_CROP,
    selected: 0,
  });

  it('says it is a low match that could be one of these, ahead of "Not sure", the card and the other matches', () => {
    setup(suggested(), { picked: true });
    const low = screen.getByText(COPY.suggested);
    expect(COPY.suggested).toBe('Low match: could be one of these.');
    const notSure = screen.getByText(/Not sure/);
    const name = screen.getByRole('heading', { name: 'Effect Veiler' });
    expect(low.compareDocumentPosition(notSure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notSure.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const alts = within(screen.getByRole('group', { name: 'Other matches' }));
    expect(alts.getAllByRole('button').map((b) => b.getAttribute('title'))).toEqual([DROLL.name, OGRE.name]);
    // Never the "couldn't read" copy: there is something to show.
    expect(screen.queryByText(/Couldn't (match|read) this/)).toBeNull();
  });

  it('says "this could be it" when the engine suggests a single card', () => {
    setup({ kind: 'result', response: response([VEILER], [0.69], { confident: false, suggested: true }), crop: VIDEO_CROP, selected: 0 }, { picked: true });
    expect(COPY.suggestedOne).toBe('Low match: this could be it.');
    expect(screen.getByText(COPY.suggestedOne)).toBeTruthy();
    expect(screen.queryByText(COPY.suggested)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Effect Veiler' })).toBeTruthy();
  });

  it('says nothing of a low match on an ordinary "Not sure" or a confident match', () => {
    setup(unsure());
    expect(screen.queryByText(COPY.suggested)).toBeNull();
    cleanup();
    setup(close());
    expect(screen.queryByText(COPY.suggested)).toBeNull();
  });
});

describe('Popover: nothing to show', () => {
  it('says a face-down card has nothing to read', () => {
    setup({
      kind: 'result',
      response: response([], [], { faceDown: true, confident: true, candidates: [{ cardId: -1, imageId: -1, score: 0.9 }] }),
      crop: VIDEO_CROP,
      selected: 0,
    });
    expect(screen.getByText('Face-down card: nothing to read yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Keep in side panel' })).toBeNull();
  });

  it('says when nothing matched a box the user drew', () => {
    setup({ kind: 'result', response: response([], [], { confident: false }), crop: VIDEO_CROP, selected: 0 });
    expect(screen.getByText("Couldn't match this. Frame the whole card, or just its artwork.")).toBeTruthy();
  });

  // Live check m6: after a click on an outline, "Frame the whole card" is advice for a box the user never drew.
  it('says what to try next when nothing matched a card picked from the outlines', () => {
    setup({ kind: 'result', response: response([], [], { confident: false }), crop: { ...VIDEO_CROP, videoHeight: 360 }, selected: 0 }, { picked: true });
    expect(
      screen.getByText("Couldn't read this card. Pause on a sharper moment, raise the video quality, or drag a box around just its artwork."),
    ).toBeTruthy();
    expect(screen.queryByText("Couldn't match this. Frame the whole card, or just its artwork.")).toBeNull();
    expect(screen.queryByText(COPY.lowQuality)).toBeNull(); // the copy already says so
  });

  // partial-report.md "UX": a card cut by the picture's edge that matched nothing, clicked or boxed.
  it('says the card runs off the picture when a cut card matched nothing', () => {
    for (const picked of [true, false]) {
      setup(
        { kind: 'result', response: response([], [], { confident: false, truncated: true }), crop: { ...VIDEO_CROP, videoHeight: 360 }, selected: 0 },
        { picked },
      );
      expect(
        screen.getByText("Part of this card is outside the picture. Try when it's fully in view, or box just its artwork."),
      ).toBeTruthy();
      expect(screen.queryByText(/Couldn't (match|read) this/)).toBeNull();
      expect(screen.queryByText(COPY.lowQuality)).toBeNull(); // quality isn't what went wrong
      cleanup();
    }
  });

  it('leaves the floor to the engine: any non-empty candidate list is shown', () => {
    // Below the floor the engine returns no candidates (types.ts); the UI doesn't re-decide.
    setup({ kind: 'result', response: response([ASH], [0.12], { confident: false }), crop: VIDEO_CROP, selected: 0 }, { picked: true });
    expect(screen.getByRole('heading', { name: ASH.name })).toBeTruthy();
    expect(screen.queryByText("Couldn't match this. Frame the whole card, or just its artwork.")).toBeNull();
    expect(screen.queryByText(/Couldn't read this card/)).toBeNull();
  });
});

describe('Popover: scanning and errors', () => {
  it('shows a placeholder while matching, and can be closed', () => {
    const p = setup({ kind: 'scanning' });
    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true');
    // "Matching artwork…" is announced by the overlay's one status region (app.tsx), which stays.
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close card details' }));
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows an error, with a way to Options when it helps', () => {
    const p = setup({ kind: 'error', message: 'The card matcher failed to load.', showOptions: true });
    expect(screen.getByText('The card matcher failed to load.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Options' }));
    expect(p.onOpenOptions).toHaveBeenCalledTimes(1);
  });
});

describe('Popover: placement', () => {
  it('sits right of the box, clamped inside the viewport, with the arrow on the box', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 372,
      bottom: 400,
      width: 372,
      height: 400,
      toJSON() {},
    } as DOMRect);
    setup(confident());
    const pop = screen.getByRole('dialog');
    expect(pop.getAttribute('data-side')).toBe('right');
    expect(pop.style.left).toBe('232px'); // 100 + 120 + 12
    expect(pop.style.top).toBe('8px'); // centred would be -12.5, clamped to the 8 px margin
    expect(pop.style.getPropertyValue('--arrow')).toBe('179.5px'); // box centre 187.5 - 8
  });
});

describe('Popover: a long alternative name', () => {
  it('truncates it in the confident "Not it?" list, keeping the full name as the title', () => {
    setup({
      kind: 'result',
      response: response([ASH, ODD_EYES_HEAVENLY, OGRE, DROLL], [0.96, 0.91, 0.64, 0.52]),
      crop: VIDEO_CROP,
      selected: 0,
    });
    expect(screen.getByText('Not it?')).toBeTruthy();
    const chip = screen.getByTitle(ODD_EYES_HEAVENLY.name);
    expect(chip.tagName).toBe('BUTTON');
    const name = chip.querySelector('em');
    const score = chip.querySelector('b');
    expect(name).not.toBeNull();
    expect(score).not.toBeNull();
    expect(name).not.toBe(score); // the name and the score are separate elements
    expect(name!.textContent).toBe(ODD_EYES_HEAVENLY.name);
    expect(score!.textContent).toBe('91%');
  });

  it('truncates it in the unsure "Could also be" list, keeping the full name as the title', () => {
    setup({
      kind: 'result',
      response: response([VEILER, ODD_EYES_HEAVENLY, OGRE, BELLE], [0.74, 0.69, 0.52, 0.4], { confident: false }),
      crop: VIDEO_CROP,
      selected: 0,
    });
    expect(screen.getByText('Could also be')).toBeTruthy();
    const chip = screen.getByTitle(ODD_EYES_HEAVENLY.name);
    const name = chip.querySelector('em');
    const score = chip.querySelector('b');
    expect(name).not.toBe(score); // the name and the score are separate elements
    expect(name!.textContent).toBe(ODD_EYES_HEAVENLY.name);
    expect(score!.textContent).toBe('69%');
  });
});

describe('Popover: scores', () => {
  it('says the AI agrees with the artwork match, and its score', () => {
    setup(unsure(), { ai: { status: 'answered', answer: 'Effect Veiler', cardId: VEILER.id } });
    expect(screen.getByText('AI agrees')).toBeTruthy();
    expect(document.querySelector('.dv-match')!.textContent).toMatch(/74% artwork match/);
  });

  it('numbers every match on one scale from the displayed top match on (the first candidate may have no card data)', () => {
    setup({
      kind: 'result',
      response: response([OGRE, BELLE, DROLL], [], {
        confident: false,
        candidates: [
          { cardId: 999, imageId: 999, score: 0.85, source: 'embedding' },
          { cardId: OGRE.id, imageId: OGRE.imageIds[0], score: 0.81, source: 'embedding' },
          { cardId: BELLE.id, imageId: BELLE.imageIds[0], score: 0.62, source: 'embedding' },
          { cardId: DROLL.id, imageId: DROLL.imageIds[0], score: 0.3 },
        ],
      }),
      crop: VIDEO_CROP,
      selected: 1,
    });
    expect(screen.getByRole('heading', { name: OGRE.name })).toBeTruthy();
    expect(screen.getByText(/Not sure · 81% match/)).toBeTruthy();
    const alts = within(screen.getByRole('group', { name: 'Other matches' })).getAllByRole('button');
    expect(alts.map((b) => b.textContent)).toEqual([`${BELLE.name}62%`, `${DROLL.name}30%`]);
  });

  it("gives a picked card its own score, on the same scale", () => {
    setup({ ...(unsure() as Extract<PopoverState, { kind: 'result' }>), selected: 1 });
    expect(screen.getByRole('heading', { name: DROLL.name })).toBeTruthy();
    const line = document.querySelector('.dv-match')!;
    expect(line.textContent).toMatch(/You picked this · 69% match/);
    expect(line.querySelector('.meter')!.classList.contains('neutral')).toBe(false);
  });
});

// ---------- a11y review B2: the answer takes focus ----------

describe('Popover: focus', () => {
  it('takes focus, without scrolling the page, once the answer is placed', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    setup(close());
    const pop = screen.getByRole('dialog', { name: 'Duel Lens card details' });
    expect(pop.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(pop);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('takes focus for an error too, but not while it is still matching', () => {
    const props = { onClose: vi.fn(), onKeep: vi.fn(), onCorrect: vi.fn(), onAskAi: vi.fn() };
    const { rerender } = render(<Popover anchor={ANCHOR} state={{ kind: 'scanning' }} {...props} />);
    const pop = screen.getByRole('dialog');
    expect(document.activeElement).not.toBe(pop);
    rerender(<Popover anchor={ANCHOR} state={{ kind: 'error', message: "Duel Lens didn't answer. Try again." }} {...props} />);
    expect(document.activeElement).toBe(pop);
  });
});

describe('Popover: focus stays in it', () => {
  it('when the control that had it goes away (Ask AI, once the AI has answered)', () => {
    const props = { onClose: vi.fn(), onKeep: vi.fn(), onCorrect: vi.fn(), onAskAi: vi.fn() };
    const { rerender } = render(<Popover anchor={ANCHOR} state={unsure()} ai={{ status: 'idle' }} {...props} />);
    screen.getByRole('button', { name: 'Ask AI' }).focus();
    rerender(<Popover anchor={ANCHOR} state={unsure()} ai={{ status: 'answered', answer: 'Effect Veiler', cardId: VEILER.id }} {...props} />);
    expect(screen.queryByRole('button', { name: /Ask AI/ })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('but never takes it back from the page', () => {
    const props = { onClose: vi.fn(), onKeep: vi.fn(), onCorrect: vi.fn(), onAskAi: vi.fn() };
    const { rerender } = render(<Popover anchor={ANCHOR} state={unsure()} ai={{ status: 'idle' }} {...props} />);
    const page = document.createElement('input');
    document.body.append(page);
    page.focus(); // the user tabbed out to the page
    rerender(<Popover anchor={ANCHOR} state={unsure()} ai={{ status: 'answered', answer: 'Effect Veiler', cardId: VEILER.id }} {...props} />);
    expect(document.activeElement).toBe(page);
    page.remove();
  });
});

// ---------- a11y review m4: the matches offered say which one is shown ----------

describe('Popover: the shown match among the chips', () => {
  const pressed = () =>
    within(screen.getByRole('group', { name: 'Other matches' }))
      .getAllByRole('button')
      .map((b) => `${b.querySelector('em')!.textContent}:${b.getAttribute('aria-pressed')}`);

  it('marks every offered match as not pressed while the top match is shown', () => {
    setup(close());
    expect(pressed()).toEqual([`${BELLE.name}:false`, `${OGRE.name}:false`]);
  });

  it('once the user picked another match, keeps it among the chips, pressed, with the top match to go back to', () => {
    setup({ ...(close() as Extract<PopoverState, { kind: 'result' }>), selected: 2 });
    expect(pressed()).toEqual([`${ASH.name}:false`, `${BELLE.name}:false`, `${OGRE.name}:true`]);
  });

  it('keeps focus on the chip the user pressed (it no longer vanishes under the keyboard)', () => {
    let state = close() as Extract<PopoverState, { kind: 'result' }>;
    const props = {
      onClose: vi.fn(),
      onKeep: vi.fn(),
      onAskAi: vi.fn(),
      onCorrect: (cardId: number) => {
        state = { ...state, selected: state.response.result.candidates.findIndex((c) => c.cardId === cardId) };
        rerender(<Popover anchor={ANCHOR} state={state} {...props} />);
      },
    };
    const { rerender } = render(<Popover anchor={ANCHOR} state={state} {...props} />);
    const ogre = screen.getByRole('button', { name: /Ghost Ogre/ });
    ogre.focus();
    fireEvent.click(ogre);
    expect(screen.getByRole('heading', { name: OGRE.name })).toBeTruthy();
    expect(ogre.isConnected).toBe(true);
    expect(ogre.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(ogre);
  });
});

// ---------- a11y review m5: the single-key shortcuts, for screen readers too ----------

describe('Popover: the keys', () => {
  // UX-1 (the lead's ruling): K plays the video again (it leaves scan mode); S keeps the card in the side panel.
  it('says the shortcuts, and in words for screen readers, S only when Keep is there', () => {
    setup(close());
    expect(document.querySelector('.note.keys')!.textContent).toBe('C copy · S side panel · ← → other matches · Esc close');
    expect(screen.getByText('Keyboard: C copies, S keeps it in the side panel, left and right arrows show other matches, Escape closes').className).toBe('sr-only');
    expect(document.querySelector('.note.keys')!.getAttribute('aria-hidden')).toBe('true'); // the visible glyphs
    cleanup();
    const noEntry = close() as Extract<PopoverState, { kind: 'result' }>;
    setup({ ...noEntry, response: { ...noEntry.response, entry: undefined } });
    expect(document.querySelector('.note.keys')!.textContent).toBe('C copy · ← → other matches · Esc close');
    expect(screen.getByText('Keyboard: C copies, left and right arrows show other matches, Escape closes')).toBeTruthy();
    expect(screen.queryByText(/S keeps|K keep/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Keep in side panel' })).toBeNull();
  });

  it('closes on its ×, "Close card details", saying whether a pointer or the keyboard pressed it', () => {
    const onClose = vi.fn();
    setup(close(), { onClose });
    const x = screen.getByRole('button', { name: 'Close card details' });
    fireEvent.click(x, { detail: 1 });
    fireEvent.click(x, { detail: 0 }); // Enter or Space on it
    expect(onClose.mock.calls).toEqual([['pointer'], ['key']]);
  });
});

// ---------- security review M1: only the user's own clicks ----------

describe('Popover: only real input', () => {
  const fakeClick = (el: Element) => fireEvent(el, untrusted(createEvent.click(el)));

  it('ignores clicks a script made on Close, the chips, Keep, Copy and the AI and Options buttons', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const p = setup(close());
    for (const name of ['Close card details', /Ghost Ogre/, 'Keep in side panel', 'Copy text']) fakeClick(screen.getByRole('button', { name }));
    expect(p.onClose).not.toHaveBeenCalled();
    expect(p.onCorrect).not.toHaveBeenCalled();
    expect(p.onKeep).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    cleanup();
    const q = setup(unsure());
    fakeClick(screen.getByRole('button', { name: 'Ask AI' }));
    expect(q.onAskAi).not.toHaveBeenCalled();
    cleanup();
    const r = setup(unsure(VIDEO_CROP, false));
    fakeClick(screen.getByRole('button', { name: 'Turn on AI check in Options' }));
    cleanup();
    const e = setup({ kind: 'error', message: 'The card matcher failed to load.', showOptions: true });
    fakeClick(screen.getByRole('button', { name: 'Open Options' }));
    expect(r.onOpenOptions).not.toHaveBeenCalled();
    expect(e.onOpenOptions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open Options' })); // the user's own click still works
    expect(e.onOpenOptions).toHaveBeenCalledTimes(1);
  });

  it('opens YGOPRODeck only for the user’s own click', () => {
    setup(close());
    const wiki = screen.getByRole('link', { name: 'YGOPRODeck ↗' });
    const fake = untrusted(createEvent.click(wiki));
    fireEvent(wiki, fake);
    expect(fake.defaultPrevented).toBe(true);
    const real = createEvent.click(wiki);
    fireEvent(wiki, real);
    expect(real.defaultPrevented).toBe(false);
  });
});

// ---------- a11y review B2: what the overlay's status region says ----------

describe('announcement', () => {
  const result = (s: PopoverState) => s as Extract<PopoverState, { kind: 'result' }>;

  it('names a confident match, and a match the user picked', () => {
    expect(announcement(close())).toBe('Ash Blossom & Joyous Spring.');
    expect(announcement({ ...result(close()), selected: 2 })).toBe('Ghost Ogre & Snow Rabbit.');
  });

  it('says "Not sure", the closest match and how many more are offered', () => {
    expect(announcement(unsure())).toBe('Not sure. Closest: Effect Veiler, 3 more possible matches.');
    const one = response([VEILER, DROLL], [0.74, 0.69], { confident: false });
    expect(announcement({ kind: 'result', response: one, crop: VIDEO_CROP, selected: 0 })).toBe('Not sure. Closest: Effect Veiler, 1 more possible match.');
    const alone = response([VEILER], [0.74], { confident: false });
    expect(announcement({ kind: 'result', response: alone, crop: VIDEO_CROP, selected: 0 })).toBe('Not sure. Closest: Effect Veiler.');
  });

  it('says "Low match" instead of "Not sure" when the engine only suggests the closest cards', () => {
    const low = response([VEILER, DROLL], [0.69, 0.66], { confident: false, suggested: true });
    expect(announcement({ kind: 'result', response: low, crop: VIDEO_CROP, selected: 0 })).toBe('Low match. Closest: Effect Veiler, 1 more possible match.');
  });

  it('says "No card found.", the face-down note, the error, or that it is matching', () => {
    expect(announcement({ kind: 'result', response: response([], [], { confident: false }), crop: VIDEO_CROP, selected: 0 })).toBe('No card found.');
    const faceDown = response([], [], { faceDown: true, candidates: [{ cardId: -1, imageId: -1, score: 0.9 }] });
    expect(announcement({ kind: 'result', response: faceDown, crop: VIDEO_CROP, selected: 0 })).toBe(COPY.faceDown);
    expect(announcement({ kind: 'error', message: 'This video blocks screenshots' })).toBe('This video blocks screenshots');
    expect(announcement({ kind: 'scanning' })).toBe('Matching artwork…');
  });

  it('says what the AI check answered', () => {
    expect(announcement(unsure(), { status: 'asking' })).toBe('Asking AI…');
    expect(announcement(unsure(), { status: 'answered', answer: 'Droll & Lock Bird', cardId: DROLL.id })).toBe('AI says: Droll & Lock Bird.');
    expect(announcement(unsure(), { status: 'answered', answer: 'Droll & Lock Bird', cardId: DROLL.id, confident: false })).toBe(
      "AI isn't sure: Droll & Lock Bird.",
    );
    expect(announcement(unsure(), { status: 'answered', answer: 'Some Unknown Card' })).toBe('AI says "Some Unknown Card", which isn\'t in the card data.');
    expect(announcement(unsure(), { status: 'failed', message: 'Invalid API key' })).toBe('AI check failed: Invalid API key');
  });
});

describe('alternativeIndices (the matches offered as chips)', () => {
  it('offers, on a confident answer, the next matches within 0.10 of the top one, up to three', () => {
    expect(alternativeIndices((close() as Extract<PopoverState, { kind: 'result' }>).response)).toEqual([1, 2]);
    expect(alternativeIndices((confident() as Extract<PopoverState, { kind: 'result' }>).response)).toEqual([]);
  });

  it('offers, on an unsure answer, the next three whatever their scores', () => {
    expect(alternativeIndices((unsure() as Extract<PopoverState, { kind: 'result' }>).response)).toEqual([1, 2, 3]);
  });
});
