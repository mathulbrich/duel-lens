// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetectedCardBox } from '../../shared/messages';
import type { CanvasLike } from '../capture';
import { PICTURE, createPictureReader, type PictureDeps } from './pictures';

/** A canvas that draws nothing; its data URL says its size, so a test can tell the frame from a crop. */
const canvas = (width: number, height: number): CanvasLike => {
  const c: CanvasLike = {
    width,
    height,
    getContext: () => ({ drawImage: () => undefined, getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }) }),
    toDataURL: () => `data:${c.width}x${c.height}`,
  };
  return c;
};

/** A deck-list picture: 1000 x 800 px shown at 500 x 400 CSS px at (100, 50). */
let img: HTMLImageElement;
beforeEach(() => {
  vi.useFakeTimers();
  img = document.createElement('img');
  Object.defineProperty(img, 'complete', { value: true });
  Object.defineProperty(img, 'naturalWidth', { value: 1000 });
  Object.defineProperty(img, 'naturalHeight', { value: 800 });
  img.getBoundingClientRect = () => ({ x: 100, y: 50, left: 100, top: 50, right: 600, bottom: 450, width: 500, height: 400, toJSON: () => ({}) }) as DOMRect;
  document.body.append(img);
  (document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint = (x, y) =>
    x >= 100 && x <= 600 && y >= 50 && y <= 450 ? [img] : [];
});
afterEach(() => {
  vi.useRealTimers();
  img.remove();
});

/** A card at image px (200..300, 100..240): a box in the detector's frame, which is the image at 1000 x 800. */
const CARD: DetectedCardBox = { cx: 250, cy: 170, w: 100, h: 140, angle: 0, conf: 0.9, kind: 'face-up', pts: [[200, 100], [300, 100], [300, 240], [200, 240]] };

function reader(over: Partial<PictureDeps> = {}) {
  const send = vi.fn(async (msg: { type: string }) => {
    if (msg.type === 'live-detect') return { detection: { boxes: [CARD], width: 1000, height: 800, ms: 5 } };
    return { result: { candidates: [{ cardId: 46986414, imageId: 46986414, score: 0.9 }], confident: true, faceDown: false, modelId: 'm', timings: {} }, cards: {} };
  });
  const show = vi.fn();
  const r = createPictureReader({ doc: document, send: send as never, shot: async () => null, ours: () => false, show, leave: vi.fn(), createCanvas: canvas, ...over });
  r.setOn(true);
  return { r, send, show };
}
const settle = async () => {
  vi.advanceTimersByTime(PICTURE.dwellMs);
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('Live check on pictures', () => {
  it("reads the picture's own pixels, finds the cards once, reads the one under a resting pointer and shows it over the card", async () => {
    const { r, send, show } = reader();
    // The card is at CSS (100 + 200/2, 50 + 100/2) .. (100 + 300/2, 50 + 240/2) = (200, 100) .. (250, 170).
    r.pointer(220, 130);
    await settle();
    expect(send.mock.calls.map((c) => c[0].type)).toEqual(['live-detect', 'recognize']);
    expect(show).toHaveBeenCalledWith({ cardId: 46986414, imageId: 46986414, anchor: { x: 200, y: 100, w: 50, h: 70 } });
    r.pointer(230, 140); // the same card again: nothing more is sent
    await settle();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('a pointer on the picture but off any card reads nothing; off the picture nothing is looked at', async () => {
    const { r, send, show } = reader();
    r.pointer(500, 400);
    await settle();
    expect(send.mock.calls.map((c) => c[0].type)).toEqual(['live-detect']);
    r.pointer(800, 600);
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(show).not.toHaveBeenCalled();
  });

  it('a read that is not sure shows nothing, and is not asked again', async () => {
    const send = vi.fn(async (msg: { type: string }) =>
      msg.type === 'live-detect'
        ? { detection: { boxes: [CARD], width: 1000, height: 800, ms: 5 } }
        : { result: { candidates: [{ cardId: 1, imageId: 1, score: 0.5 }], confident: false, faceDown: false, modelId: 'm', timings: {} }, cards: {} },
    );
    const { r, show } = reader({ send: send as never });
    r.pointer(220, 130);
    await settle();
    r.pointer(221, 131);
    await settle();
    expect(show).not.toHaveBeenCalled();
    expect(send.mock.calls.filter((c) => c[0].type === 'recognize')).toHaveLength(1);
  });

  it('a fitted picture (object-fit) is read from a screenshot, where each card really is', async () => {
    img.style.objectFit = 'contain';
    const shot = vi.fn(async () => null);
    const { r, send } = reader({ shot });
    r.pointer(220, 130);
    await settle();
    expect(shot).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled(); // no screenshot here: nothing to detect
  });

  it('the page moving (gone) while a card is read shows nothing', async () => {
    const { r, show } = reader();
    r.pointer(220, 130);
    vi.advanceTimersByTime(PICTURE.dwellMs);
    r.gone();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(show).not.toHaveBeenCalled();
  });

  it('switched off, the pointer reads nothing', async () => {
    const { r, send } = reader();
    r.setOn(false);
    r.pointer(220, 130);
    await settle();
    expect(send).not.toHaveBeenCalled();
  });

  it('reads at the Speed it is given: Light with the Light model, Best every view', async () => {
    const { r, send } = reader({ speed: () => 'light' });
    r.pointer(220, 130);
    await settle();
    const crop = (send.mock.calls.find((c) => c[0].type === 'recognize')![0] as unknown as { crop: { light?: boolean; thorough?: boolean } }).crop;
    expect(crop).toMatchObject({ light: true });
    expect(crop.thorough).toBeUndefined();
  });

  it('a clear card cut by the picture\'s edge (a sure cut answer, as a video counts it) shows', async () => {
    const send = vi.fn(async (msg: { type: string }) =>
      msg.type === 'live-detect'
        ? { detection: { boxes: [CARD], width: 1000, height: 800, ms: 5 } }
        : { result: { candidates: [{ cardId: 7, imageId: 7, score: 0.9 }, { cardId: 8, imageId: 8, score: 0.6 }], confident: false, truncated: true, faceDown: false, modelId: 'm', timings: {} }, cards: {} },
    );
    const { r, show } = reader({ send: send as never });
    r.pointer(220, 130);
    await settle();
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ cardId: 7, imageId: 7 }));
  });

  it('a read that found nothing is tried again when the Speed changes, not before', async () => {
    let speed: 'light' | 'best' = 'light';
    const send = vi.fn(async (msg: { type: string }) =>
      msg.type === 'live-detect'
        ? { detection: { boxes: [CARD], width: 1000, height: 800, ms: 5 } }
        : { result: { candidates: [{ cardId: 1, imageId: 1, score: 0.5 }], confident: false, faceDown: false, modelId: 'm', timings: {} }, cards: {} },
    );
    const { r } = reader({ send: send as never, speed: () => speed });
    r.pointer(220, 130);
    await settle();
    r.pointer(221, 131);
    await settle();
    expect(send.mock.calls.filter((c) => c[0].type === 'recognize')).toHaveLength(1);
    speed = 'best';
    r.pointer(222, 132);
    await settle();
    expect(send.mock.calls.filter((c) => c[0].type === 'recognize')).toHaveLength(2);
  });
});

