import { describe, expect, it } from 'vitest';
import type { RGBAImage } from '../../src/shared/preprocess';
import { degrade, DEGRADE_LEVELS, STRESS_LEVELS } from './degrade';

// A synthetic "artwork": gradients plus a few hard-edged shapes, 160×120.
function artwork(): RGBAImage {
  const width = 160;
  const height = 120;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const inBox = x > 30 && x < 80 && y > 20 && y < 70;
      const inDisc = (x - 115) ** 2 + (y - 75) ** 2 < 25 ** 2;
      data[i] = inBox ? 230 : (x * 255) / width;
      data[i + 1] = inDisc ? 20 : (y * 255) / height;
      data[i + 2] = (x + y) % 32 < 16 ? 200 : 60;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

const differs = (a: RGBAImage, b: RGBAImage) => a.data.some((v, i) => v !== b.data[i]);

describe('degrade', () => {
  it("returns the input itself for 'clean'", async () => {
    const img = artwork();
    expect(await degrade(img, 'clean', 1)).toBe(img);
  });

  it.each(['mild', 'video', 'extreme', 'video-lowres'] as const)("keeps the size but changes the pixels at '%s'", async (level) => {
    const img = artwork();
    const out = await degrade(img, level, 1);
    expect(out.width).toBe(img.width);
    expect(out.height).toBe(img.height);
    expect(out.data).toHaveLength(img.width * img.height * 4);
    expect(differs(out, img)).toBe(true);
  });

  it.each(['mild', 'video', 'extreme', 'video-lowres'] as const)("is deterministic for a seed at '%s'", async (level) => {
    const img = artwork();
    const a = await degrade(img, level, 42);
    const b = await degrade(img, level, 42);
    const c = await degrade(img, level, 43);
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
    expect(differs(a, c)).toBe(true);
  });

  it('does not modify its input', async () => {
    const img = artwork();
    const copy = Uint8ClampedArray.from(img.data);
    await degrade(img, 'video', 5);
    expect(Buffer.from(img.data).equals(Buffer.from(copy))).toBe(true);
  });

  it("lists the brief's levels from easiest to hardest, and the stress level apart", () => {
    expect(DEGRADE_LEVELS).toEqual(['clean', 'mild', 'video', 'extreme']);
    expect(STRESS_LEVELS).toEqual(['video-lowres']);
  });

  it("draws the same scene for 'video' and 'video-lowres' and only changes where blur and JPEG apply", async () => {
    const img = artwork();
    const a = await degrade(img, 'video', 9);
    const b = await degrade(img, 'video-lowres', 9);
    expect(differs(a, b)).toBe(true);
    // Same geometry: the misframed border colour lands in the same corner region.
    const corner = (x: typeof a) => Array.from(x.data.subarray(0, 4));
    expect(Math.abs(corner(a)[0] - corner(b)[0])).toBeLessThan(80);
  });
});
