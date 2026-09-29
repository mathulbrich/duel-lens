// The click-to-scan E2E's verdict on a scan's detection (harness.ts): it may skip the run only when
// the build says it has no card detector, word for word (click-review.md I2).
import { describe, expect, it } from 'vitest';
import { NO_CARD_DETECTOR } from '../../src/background/offscreen-client';
import { checkDetection, checkFakeDetection, insideQuad, welcomeKind } from './harness';

const WAIT = 20_000;

describe('checkDetection (--click without --fake-detect)', () => {
  it('skips only when the detection says exactly that this build has no card detector', () => {
    expect(checkDetection(0, { boxes: 0, error: NO_CARD_DETECTOR }, WAIT)).toEqual({ skip: `the detection said: "${NO_CARD_DETECTOR}"` });
  });

  it('fails on every other detection error, naming it', () => {
    for (const error of [
      "Duel Lens couldn't reach its card detector (Could not establish connection. Receiving end does not exist.)",
      "Duel Lens couldn't load its card detector: models/detector.onnx is missing from the extension",
      "Duel Lens couldn't read the screenshot: not a PNG",
      "Duel Lens couldn't find the cards: it took too long",
      "The recognition engine didn't answer detect-cards.",
      'No card detector: the model is not in this build', // close, but not the build's own words
    ]) {
      expect(checkDetection(0, { boxes: 0, error }, WAIT)).toEqual({ fail: `the card detection failed: "${error}"` });
    }
  });

  it('fails when no detection reached the tab at all', () => {
    expect(checkDetection(null, null, WAIT)).toEqual({ fail: 'no cards-detected reached the tab within 20 s of the shortcut' });
    expect(checkDetection(null, undefined, 5_000)).toEqual({ fail: 'no cards-detected reached the tab within 5 s of the shortcut' });
  });

  it('fails when the detection came but the tab never outlined it', () => {
    expect(checkDetection(null, { boxes: 4, error: null }, WAIT)).toEqual({
      fail: 'the detection found 4 cards, but the tab showed no outlines within 20 s',
    });
  });

  it('goes on when the detector answered and the tab outlined what it found, none included', () => {
    expect(checkDetection(4, { boxes: 4, error: null }, WAIT)).toBeNull();
    expect(checkDetection(0, { boxes: 0, error: null }, WAIT)).toBeNull();
  });
});

describe('checkFakeDetection (--click --fake-detect)', () => {
  it("fails when the harness's own detection never reached the tab, and goes on when it did", () => {
    expect(checkFakeDetection(null, WAIT)).toEqual({ fail: "the harness's detection never reached the tab: no outlines within 20 s" });
    expect(checkFakeDetection(0, WAIT)).toBeNull();
    expect(checkFakeDetection(3, WAIT)).toBeNull();
  });
});

describe('insideQuad', () => {
  it('tells a point inside a turned quad from one in its bounding box but outside it', () => {
    const diamond: [number, number][] = [
      [500, 400],
      [600, 500],
      [500, 600],
      [400, 500],
    ];
    expect(insideQuad(diamond, 540, 530)).toBe(true);
    expect(insideQuad(diamond, 580, 420)).toBe(false);
    expect(insideQuad(diamond, 600, 500)).toBe(true); // a corner counts
    expect(insideQuad([...diamond].reverse(), 540, 530)).toBe(true); // either way round
  });
});

describe('welcomeKind (the first-run consent in the E2E)', () => {
  it("tells the welcome page's consent step from the page itself", () => {
    expect(welcomeKind('chrome-extension://abcdefghijklmnop/welcome.html')).toBe('welcome');
    expect(welcomeKind('chrome-extension://abcdefghijklmnop/welcome.html#consent')).toBe('consent');
    expect(welcomeKind('chrome-extension://abcdefghijklmnop/options.html')).toBeNull();
    expect(welcomeKind('http://127.0.0.1:5000/welcome.html')).toBeNull();
  });
});
