import { describe, expect, it, vi } from 'vitest';
import { makeThumbnail, thumbnailSize, THUMB_MAX_SIDE, type ThumbnailDeps } from './thumbnail';

describe('thumbnailSize', () => {
  it(`fits the longer side into ${THUMB_MAX_SIDE} px, keeping the shape`, () => {
    expect(thumbnailSize(590, 860)).toEqual({ width: 110, height: 160 });
    expect(thumbnailSize(1600, 900)).toEqual({ width: 160, height: 90 });
  });

  it('never enlarges a small crop', () => {
    expect(thumbnailSize(120, 80)).toEqual({ width: 120, height: 80 });
  });

  it('keeps at least one pixel on each side', () => {
    expect(thumbnailSize(4000, 2)).toEqual({ width: 160, height: 1 });
  });
});

function fakeDeps(opts: { encode?: () => Promise<Blob> } = {}) {
  const bitmap = { width: 590, height: 860, close: vi.fn() };
  const ctx = { drawImage: vi.fn(), imageSmoothingQuality: 'low' as ImageSmoothingQuality };
  const convertToBlob = vi.fn(opts.encode ?? (async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' })));
  const canvas = vi.fn((_w: number, _h: number) => ({ getContext: () => ctx, convertToBlob }));
  const decode = vi.fn(async (_dataUrl: string) => bitmap);
  const deps: ThumbnailDeps = { decode, canvas };
  return { deps, bitmap, ctx, canvas, convertToBlob, decode };
}

describe('makeThumbnail', () => {
  it('draws the crop at thumbnail size and encodes it as a small JPEG data URL', async () => {
    const { deps, bitmap, ctx, canvas, convertToBlob, decode } = fakeDeps();

    const url = await makeThumbnail('data:image/png;base64,iVBORw0KGgo=', deps);

    expect(decode).toHaveBeenCalledWith('data:image/png;base64,iVBORw0KGgo=');
    expect(canvas).toHaveBeenCalledWith(110, 160);
    expect(ctx.drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 110, 160);
    expect(ctx.imageSmoothingQuality).toBe('high');
    expect(convertToBlob).toHaveBeenCalledWith({ type: 'image/jpeg', quality: expect.any(Number) });
    expect(url).toBe('data:image/jpeg;base64,/9j/'); // FF D8 FF: a JPEG's first bytes
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('releases the decoded crop even when encoding fails', async () => {
    const { deps, bitmap } = fakeDeps({ encode: async () => Promise.reject(new Error('encoder busy')) });

    await expect(makeThumbnail('data:image/png;base64,iVBORw0KGgo=', deps)).rejects.toThrow('encoder busy');
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });
});
