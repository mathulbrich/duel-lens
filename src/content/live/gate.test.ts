import { describe, expect, it } from 'vitest';
import { createZones, detectReason, frameDiff, GATE, createThumbSampler, greyThumb, zoneDiffs } from './gate';

const SIZE = GATE.w * GATE.h;

function flat(v: number): Uint8Array {
  return new Uint8Array(SIZE).fill(v);
}

/** `base` with `delta` added to every pixel of one region of an 8x4 grid (2x2 of the gate's 16x8 zones). */
function bump(base: Uint8Array, col: number, row: number, delta: number): Uint8Array {
  const out = base.slice();
  const zw = GATE.w / 8;
  const zh = GATE.h / 4;
  for (let y = row * zh; y < (row + 1) * zh; y++) for (let x = col * zw; x < (col + 1) * zw; x++) out[y * GATE.w + x] += delta;
  return out;
}

describe('thumbnail maths', () => {
  it('zoneDiffs gives 128 zone means (16 x 8)', () => {
    const a = flat(100);
    const d = zoneDiffs(a, bump(a, 2, 1, 10)); // region (2, 1): zones 36, 37, 52 and 53
    expect(d).toHaveLength(128);
    const hit = [36, 37, 52, 53];
    expect(hit.map((i) => d[i])).toEqual([10, 10, 10, 10]);
    expect(d.filter((_, i) => !hit.includes(i)).every((v) => v === 0)).toBe(true);
  });

  it('frameDiff is the mean absolute difference', () => expect(frameDiff(Uint8Array.of(0, 10), Uint8Array.of(4, 0))).toBe(7));

  it('greyThumb weights RGB as luma', () => expect(greyThumb(Uint8ClampedArray.of(255, 0, 0, 255))[0]).toBe(76));

  it('the thumbnail sampler draws the source into a 128x72 canvas and greys it', () => {
    const drawn: unknown[][] = [];
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (...args: unknown[]) => drawn.push(args),
        getImageData: () => ({ data: new Uint8ClampedArray(SIZE * 4).fill(255) }),
      }),
      toDataURL: () => '',
    };
    const source = {} as CanvasImageSource;
    const t = createThumbSampler((w, h) => {
      canvas.width = w;
      canvas.height = h;
      return canvas as never;
    })(source);
    expect([canvas.width, canvas.height]).toEqual([GATE.w, GATE.h]);
    expect(drawn[0]).toEqual([source, 0, 0, GATE.w, GATE.h]);
    expect(t.grey).toHaveLength(SIZE);
    expect(t.grey[0]).toBe(255);
    expect(t.black).toBe(false);
  });

  it('reuses one canvas for every sample, and says when the frame is black', () => {
    let made = 0;
    let pixel = 0;
    const sample = createThumbSampler(() => {
      made++;
      return {
        width: GATE.w,
        height: GATE.h,
        getContext: () => ({ drawImage: () => undefined, getImageData: () => ({ data: new Uint8ClampedArray(SIZE * 4).fill(pixel) }) }),
        toDataURL: () => '',
      } as never;
    });
    const source = {} as CanvasImageSource;
    expect(sample(source).black).toBe(true);
    pixel = 200;
    expect(sample(source).black).toBe(false);
    expect(made).toBe(1);
  });
});

describe('zones', () => {
  it('a zone that moved settles after 2 quiet samples, reported once', () => {
    const z = createZones();
    const base = flat(100);
    const moved = bump(base, 2, 1, 8);
    z.sample(base);
    z.sample(moved);
    expect(z.takeSettled()).toBe(false);
    z.sample(moved);
    expect(z.takeSettled()).toBe(false);
    z.sample(moved);
    expect(z.takeSettled()).toBe(true);
    expect(z.takeSettled()).toBe(false);
  });

  it("a diff between 3 and 6 keeps the zone's state", () => {
    const z = createZones();
    const base = flat(100);
    z.sample(base);
    z.sample(bump(base, 2, 1, 8)); // zone 10 moving
    // alternate by 4: neither quiet nor moving, so the settle count keeps resetting
    let cur = bump(base, 2, 1, 8);
    for (let i = 0; i < 6; i++) {
      cur = bump(cur, 2, 1, i % 2 ? -4 : 4);
      z.sample(cur);
    }
    expect(z.takeSettled()).toBe(false);
    expect(z.quiet({ x: 0.25, y: 0.25, w: 0.1, h: 0.1 })).toBe(false);
    // a quiet zone hit by 4 stays quiet
    const q = createZones();
    q.sample(base);
    q.sample(bump(base, 2, 1, 4));
    expect(q.quiet({ x: 0.25, y: 0.25, w: 0.1, h: 0.1 })).toBe(true);
    expect(q.takeSettled()).toBe(false);
  });

  it('a break in the quiet streak restarts the settle count', () => {
    const z = createZones();
    const base = flat(100);
    z.sample(base);
    z.sample(bump(base, 2, 1, 8)); // moving
    z.sample(bump(base, 2, 1, 8)); // quiet 1
    z.sample(bump(base, 2, 1, 12)); // diff 4: resets
    z.sample(bump(base, 2, 1, 12)); // quiet 1
    expect(z.takeSettled()).toBe(false);
    z.sample(bump(base, 2, 1, 12)); // quiet 2
    expect(z.takeSettled()).toBe(true);
  });

  it('quiet(box) is false while any zone under the box moves', () => {
    const z = createZones();
    const base = flat(100);
    z.sample(base);
    z.sample(bump(base, 2, 1, 8)); // zone 10: col 2 (x .25-.375), row 1 (y .25-.5)
    expect(z.quiet({ x: 0.26, y: 0.3, w: 0.2, h: 0.1 })).toBe(false); // over zones 10 and 11
    expect(z.quiet({ x: 0, y: 0, w: 0.1, h: 0.1 })).toBe(true); // zone 0
  });

  it('a box edge exactly on a zone boundary does not pull in the neighbouring zone', () => {
    const z = createZones();
    const base = flat(100);
    z.sample(base);
    z.sample(bump(base, 2, 1, 8)); // zone 10 starts at x .25, y .25
    expect(z.quiet({ x: 0, y: 0.25, w: 0.25, h: 0.25 })).toBe(true); // right edge at .25 stays in col 0-1
    expect(z.quiet({ x: 0.375, y: 0.25, w: 0.2, h: 0.25 })).toBe(true); // left edge at .375 starts in col 3
    expect(z.quiet({ x: 0.25, y: 0, w: 0.125, h: 0.25 })).toBe(true); // bottom edge at .25 stays in row 0
    expect(z.quiet({ x: 0.25, y: 0.25, w: 0.125, h: 0.25 })).toBe(false); // exactly zone 10
    expect(z.quiet({ x: 0.1, y: 0.1, w: 0.15, h: 0.15 })).toBe(true); // 0.1 + 0.15 is 0.25 up to rounding
  });

  it('a box past the video is clamped to its edge zones', () => {
    const z = createZones();
    const base = flat(100);
    z.sample(base);
    z.sample(bump(base, 7, 3, 8));
    expect(z.quiet({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 })).toBe(false);
    expect(z.quiet({ x: -0.5, y: -0.5, w: 0.6, h: 0.6 })).toBe(true);
  });

  it('a whole-frame diff of 40 or more is a cut and makes every zone moving', () => {
    const z = createZones();
    z.sample(flat(50));
    expect(z.sample(flat(95))).toBe('cut');
    expect(z.quiet({ x: 0.5, y: 0.5, w: 0.01, h: 0.01 })).toBe(false);
    expect(z.quiet({ x: 0, y: 0, w: 1, h: 1 })).toBe(false);
    z.sample(flat(95));
    expect(z.takeSettled()).toBe(false);
    z.sample(flat(95));
    expect(z.takeSettled()).toBe(true);
    expect(z.quiet({ x: 0, y: 0, w: 1, h: 1 })).toBe(true);
  });

  it('cut() from outside marks every zone moving', () => {
    const z = createZones();
    z.sample(flat(50));
    z.cut();
    expect(z.quiet({ x: 0, y: 0, w: 1, h: 1 })).toBe(false);
    z.sample(flat(50));
    z.sample(flat(50));
    expect(z.takeSettled()).toBe(true);
  });

  it('movedSince is true only for zones under the box that moved after the given sample', () => {
    const z = createZones();
    const base = flat(100);
    const moved = bump(base, 2, 1, 8); // zone 10
    const zone10 = { x: 0.25, y: 0.25, w: 0.125, h: 0.25 };
    const elsewhere = { x: 0, y: 0, w: 0.1, h: 0.1 };
    z.sample(base);
    z.sample(moved);
    const at = z.sampleIndex();
    expect(z.movedSince(zone10, at - 1)).toBe(true);
    expect(z.movedSince(elsewhere, at - 1)).toBe(false);
    z.sample(moved);
    z.sample(moved); // settled
    expect(z.quiet(zone10)).toBe(true);
    expect(z.movedSince(zone10, at - 1)).toBe(true); // it moved after sample at - 1
    expect(z.movedSince(zone10, at)).toBe(false); // motion before the given sample does not count
    expect(z.movedSince(zone10, z.sampleIndex())).toBe(false);
  });

  it('a cut counts as motion for every box', () => {
    const z = createZones();
    z.sample(flat(50));
    z.sample(flat(50));
    const at = z.sampleIndex();
    expect(z.movedSince({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, at)).toBe(false);
    z.sample(flat(250)); // a cut
    expect(z.movedSince({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, at)).toBe(true);
    const later = z.sampleIndex();
    z.cut(); // from outside, at the current sample
    expect(z.movedSince({ x: 0, y: 0, w: 0.1, h: 0.1 }, later - 1)).toBe(true);
    expect(z.movedSince({ x: 0, y: 0, w: 0.1, h: 0.1 }, later)).toBe(true); // still moving
    z.sample(flat(250));
    z.sample(flat(250)); // settled
    expect(z.movedSince({ x: 0, y: 0, w: 0.1, h: 0.1 }, later)).toBe(false);
  });

  it('rebase makes the next sample compare nothing', () => {
    const z = createZones();
    z.sample(flat(0));
    z.rebase();
    expect(z.sample(flat(200))).toBe('ok');
    expect(z.quiet({ x: 0, y: 0, w: 1, h: 1 })).toBe(true);
    expect(z.takeSettled()).toBe(false);
    // and the sample after that compares against the rebased one
    expect(z.sample(flat(195))).toBe('ok');
    expect(z.quiet({ x: 0, y: 0, w: 1, h: 1 })).toBe(true);
  });

  it('the first sample compares nothing', () => {
    const z = createZones();
    expect(z.sample(flat(200))).toBe('ok');
    expect(z.quiet({ x: 0, y: 0, w: 1, h: 1 })).toBe(true);
  });
});

describe('detectReason', () => {
  it('first, settled, refresh at 10 s, else null', () => {
    expect(detectReason({ first: true, settled: false, sinceDetectMs: 0 })).toBe('first');
    expect(detectReason({ first: false, settled: true, sinceDetectMs: 600 })).toBe('settled');
    expect(detectReason({ first: false, settled: false, sinceDetectMs: 10_000 })).toBe('refresh');
    expect(detectReason({ first: false, settled: false, sinceDetectMs: 9_999 })).toBeNull();
  });
});
