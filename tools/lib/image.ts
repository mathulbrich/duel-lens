// Decoding images into the RGBAImage shape the shared preprocessing expects.
import sharp from 'sharp';
import type { RGBAImage } from '../../src/shared/preprocess';

/** Decode a JPEG/PNG (path or bytes) into 8-bit sRGB RGBA pixels. */
export async function loadRGBA(input: string | Buffer | Uint8Array): Promise<RGBAImage> {
  const { data, info } = await sharp(input).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error(`Expected 4 channels after decoding, got ${info.channels}`);
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

/** Decode a data: URL (e.g. "data:image/png;base64,…"). */
export function loadDataUrl(dataUrl: string): Promise<RGBAImage> {
  const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error('Not a data URL');
  return loadRGBA(m[1] ? Buffer.from(m[2], 'base64') : Buffer.from(decodeURIComponent(m[2])));
}
