// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeDataUrl } from './decode';

// 3×2 RGBA pixels the fake canvas hands back.
const PIXELS = new Uint8ClampedArray(Array.from({ length: 3 * 2 * 4 }, (_, i) => (i * 11) % 256));
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
const DATA_URL = `data:image/png;base64,${btoa(String.fromCharCode(...PNG_BYTES))}`;

let blobs: Blob[];
let drawn: { bitmap: unknown; x: number; y: number }[];
let canvasSizes: [number, number][];
let closed: number;

beforeEach(() => {
  blobs = [];
  drawn = [];
  canvasSizes = [];
  closed = 0;
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
    blobs.push(blob);
    return { width: 3, height: 2, close: () => closed++ };
  });
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor(w: number, h: number) {
        canvasSizes.push([w, h]);
      }
      getContext() {
        return {
          drawImage: (bitmap: unknown, x: number, y: number) => drawn.push({ bitmap, x, y }),
          getImageData: (x: number, y: number, w: number, h: number) => {
            expect([x, y, w, h]).toEqual([0, 0, 3, 2]);
            return { data: PIXELS, width: w, height: h, colorSpace: 'srgb' };
          },
        };
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('decodeDataUrl', () => {
  it('returns the width, height and pixels of the decoded image', async () => {
    const img = await decodeDataUrl(DATA_URL);
    expect(img.width).toBe(3);
    expect(img.height).toBe(2);
    expect(Array.from(img.data)).toEqual(Array.from(PIXELS));
  });

  it('hands the decoder the bytes of the data URL, drawn once at the origin on a canvas of the same size', async () => {
    await decodeDataUrl(DATA_URL);
    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe('image/png');
    expect(Array.from(new Uint8Array(await blobs[0].arrayBuffer()))).toEqual(PNG_BYTES);
    expect(canvasSizes).toEqual([[3, 2]]);
    expect(drawn).toHaveLength(1);
    expect([drawn[0].x, drawn[0].y]).toEqual([0, 0]);
  });

  it('releases the bitmap', async () => {
    await decodeDataUrl(DATA_URL);
    expect(closed).toBe(1);
  });

  it('rejects something that is not an image data URL', async () => {
    await expect(decodeDataUrl('https://example.com/card.png')).rejects.toThrow(/data URL/i);
    await expect(decodeDataUrl('data:text/plain,hello')).rejects.toThrow(/image/i);
  });
});
