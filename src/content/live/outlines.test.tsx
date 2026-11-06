// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render } from '@testing-library/preact';
import type { RecognizeResponse } from '../../shared/messages';
import { trustEvents, untrusted } from '../test-events';
import { ASH } from '../test-fixtures';
import type { LiveView } from './controller';
import { cardAt, LiveHoverCard, LiveOutlines } from './outlines';

let distrust: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  distrust = trustEvents();
});
afterEach(() => {
  cleanup();
  distrust();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

type Cards = LiveView['cards'];
const rectOf = (left: number, top: number, width: number, height: number) =>
  ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

/** A 1280x720 video shown in a box at (left, top); `fit` is its object-fit. */
function videoIn(box: DOMRect, fit = 'fill'): HTMLVideoElement {
  const v = document.createElement('video');
  Object.defineProperty(v, 'videoWidth', { value: 1280, configurable: true });
  Object.defineProperty(v, 'videoHeight', { value: 720, configurable: true });
  v.style.objectFit = fit;
  v.getBoundingClientRect = () => box;
  document.body.append(v);
  return v;
}

const voting: Cards[number] = { trackId: 1, state: 'voting', box: { x: 0.1, y: 0.2, w: 0.1, h: 0.2 } };
const promoted: Cards[number] = { trackId: 2, state: 'promoted', cardId: ASH.id, imageId: ASH.imageIds[0], box: { x: 0.5, y: 0.5, w: 0.1, h: 0.2 } };

function draw(cards: Cards, pointed: number | null, video = videoIn(rectOf(100, 50, 960, 540))) {
  return { video, ...render(<LiveOutlines cards={cards} video={video} pointed={pointed} />) };
}
const sides = (o: HTMLElement) => [o.style.left, o.style.top, o.style.width, o.style.height];

describe('LiveOutlines', () => {
  it('outlines only the card under the pointer, at its viewport rect', () => {
    const { container, rerender, video } = draw([voting, promoted], 2);
    const outlines = container.querySelectorAll<HTMLElement>('.live-outline');
    expect(outlines).toHaveLength(1);
    expect(sides(outlines[0])).toEqual(['580px', '320px', '96px', '108px']); // 960x540 at (100, 50): scale 0.75
    rerender(<LiveOutlines cards={[voting, promoted]} video={video} pointed={null} />);
    expect(container.querySelector('.live-outline')).toBeNull();
  });

  it('keeps to the picture inside the box when the video is letterboxed (object-fit contain)', () => {
    // 960x720 box for a 16:9 picture: the picture is 960x540, centred, 90 px of bars above and below.
    const { container } = draw([promoted], 2, videoIn(rectOf(0, 0, 960, 720), 'contain'));
    expect(sides(container.querySelector<HTMLElement>('.live-outline')!)).toEqual(['480px', '360px', '96px', '108px']);
  });

  it('dashed while the card is being read, gold once listed; never a control', () => {
    const { container, rerender, video } = draw([voting], 1);
    const dashed = container.querySelector<HTMLElement>('.live-outline')!;
    expect(dashed.classList.contains('reading')).toBe(true);
    expect(dashed.getAttribute('aria-hidden')).toBe('true');
    rerender(<LiveOutlines cards={[{ ...voting, state: 'promoted', cardId: ASH.id, imageId: ASH.imageIds[0] }]} video={video} pointed={1} />);
    const gold = container.querySelector<HTMLElement>('.live-outline')!;
    expect(gold.classList.contains('promoted')).toBe(true);
    expect(gold.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('button')).toBeNull();
  });

  it('draws nothing for no cards, or a pointed track that is gone', () => {
    expect(draw([], null).container.querySelector('.live-outline')).toBeNull();
    cleanup();
    expect(draw([promoted], 9).container.querySelector('.live-outline')).toBeNull();
  });

  it('follows the video on resize, scroll, fullscreenchange and its own resizing', () => {
    const watchers: { cb: () => void; target?: Element }[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(public cb: () => void) {
          watchers.push(this);
        }
        observe(t: Element) {
          (this as unknown as { target: Element }).target = t;
        }
        disconnect() {}
      },
    );
    const video = videoIn(rectOf(100, 50, 960, 540));
    const { container } = draw([promoted], 2, video);
    const left = () => container.querySelector<HTMLElement>('.live-outline')!.style.left;
    expect(left()).toBe('580px');
    for (const [type, target, at] of [['resize', window, 200], ['scroll', window, 300], ['fullscreenchange', document, 400]] as const) {
      video.getBoundingClientRect = () => rectOf(at, 50, 960, 540);
      act(() => void fireEvent(target, new Event(type)));
      expect(left(), type).toBe(`${at + 480}px`);
    }
    video.getBoundingClientRect = () => rectOf(0, 50, 960, 540);
    act(() => void watchers.find((w) => w.target === video)!.cb());
    expect(left()).toBe('480px');
    vi.unstubAllGlobals();
  });
});

describe('cardAt', () => {
  it('finds the card under a viewport point, the smallest where they overlap, none off them', () => {
    const video = videoIn(rectOf(100, 50, 960, 540));
    const big: Cards[number] = { ...voting, trackId: 3, box: { x: 0.45, y: 0.45, w: 0.3, h: 0.4 } };
    expect(cardAt([big, promoted], video, 620, 370)?.trackId).toBe(2); // inside both: the smaller
    expect(cardAt([big, promoted], video, 560, 300)?.trackId).toBe(3);
    expect(cardAt([big, promoted], video, 110, 60)).toBeNull();
  });
});

const found = (): RecognizeResponse => ({
  result: { candidates: [{ cardId: ASH.id, imageId: ASH.imageIds[0], score: 0, source: 'name' }], confident: true, faceDown: false, modelId: '', timings: {} },
  cards: { [ASH.id]: ASH },
  aiEnabled: false,
});
const ANCHOR = { x: 580, y: 320, w: 96, h: 108 };

describe('LiveHoverCard', () => {
  const show = (reveal: 'preview' | 'full' | 'click') => {
    const h = { onEnter: vi.fn(), onLeave: vi.fn(), onPick: vi.fn(), onClose: vi.fn() };
    const view = render(<LiveHoverCard reveal={reveal} shown={{ response: found(), anchor: ANCHOR, images: {} }} {...h} />);
    return { ...h, ...view };
  };

  it('hover shows the quick preview for preview and click (the outline takes no click), the card box for full', () => {
    const preview = show('preview');
    expect(preview.container.querySelector('.pv')).not.toBeNull();
    expect(preview.container.querySelector('.pv-head')!.textContent).toBe(ASH.name);
    expect(preview.container.querySelector('.ov')).toBeNull();
    cleanup();
    const full = show('full');
    expect(full.container.querySelector('.ov')).not.toBeNull();
    expect(full.container.querySelector('.pv')).toBeNull();
    cleanup();
    const click = show('click');
    expect(click.container.querySelector('.pv')).not.toBeNull();
  });

  it('shows nothing when nothing is hovered', () => {
    const { container } = render(<LiveHoverCard reveal="preview" shown={null} onEnter={() => undefined} onLeave={() => undefined} onPick={() => undefined} onClose={() => undefined} />);
    expect(container.querySelector('.pv, .ov')).toBeNull();
  });

  it('a trusted click on the preview picks the card; the pointer on it holds it open', () => {
    const { container, onPick, onEnter, onLeave } = show('preview');
    const pv = container.querySelector<HTMLElement>('.pv')!;
    fireEvent.pointerEnter(pv);
    expect(onEnter).toHaveBeenCalled();
    fireEvent.pointerLeave(pv);
    expect(onLeave).toHaveBeenCalled();
    fireEvent(pv, untrusted(createEvent.click(pv, { bubbles: true })));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(pv);
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});
