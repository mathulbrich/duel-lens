// Crop payloads arrive as PNG data URLs; the engine wants raw RGBA pixels.
import type { RGBAImage } from '../shared/preprocess';

function dataUrlToBlob(dataUrl: string): Blob {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(dataUrl);
  if (!m) throw new Error('The crop is not a data URL');
  const type = m[1] || 'text/plain';
  if (!type.startsWith('image/')) throw new Error(`The crop is not an image (${type})`);
  let bytes: Uint8Array<ArrayBuffer>;
  if (/;base64/i.test(m[2])) {
    const bin = atob(m[3]);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(m[3]));
  }
  return new Blob([bytes], { type });
}

/** Decode an image data URL (PNG, JPEG, …) into RGBA pixels. */
export async function decodeDataUrl(dataUrl: string): Promise<RGBAImage> {
  const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('No 2D canvas context to read the crop');
    ctx.drawImage(bitmap, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { data, width, height };
  } finally {
    bitmap.close();
  }
}
