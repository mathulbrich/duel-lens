// A small JPEG of the user's crop, kept with its history entry so the side panel can show the card
// the user scanned. The crop build (`--no-remote-images`) uses it in place of YGOPRODeck's card image
// (__DUEL_LENS_REMOTE_IMAGES__ off; router.ts): about 3-6 kB each, so 300 entries stay well under a
// couple of MB. Runs in the service worker: createImageBitmap and OffscreenCanvas, no DOM.

/** The thumbnail's longer side, in pixels. */
export const THUMB_MAX_SIDE = 160;
const JPEG_QUALITY = 0.8;

interface Decoded {
  width: number;
  height: number;
  close(): void;
}

export interface ThumbnailDeps {
  decode: (dataUrl: string) => Promise<Decoded>;
  canvas: (
    width: number,
    height: number,
  ) => {
    getContext(contextId: '2d'): { drawImage(image: never, dx: number, dy: number, dw: number, dh: number): void; imageSmoothingQuality: ImageSmoothingQuality } | null;
    convertToBlob(options: { type: string; quality: number }): Promise<Blob>;
  };
}

/** A data URL's bytes, without fetch(). */
function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const mime = dataUrl.slice(5, comma).split(';')[0] || 'application/octet-stream';
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

const defaultDeps: ThumbnailDeps = {
  decode: (dataUrl) => createImageBitmap(dataUrlToBlob(dataUrl)),
  canvas: (width, height) => new OffscreenCanvas(width, height) as unknown as ReturnType<ThumbnailDeps['canvas']>,
};

/** The thumbnail's size for a `width` x `height` crop: at most THUMB_MAX_SIDE, never enlarged. */
export function thumbnailSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, THUMB_MAX_SIDE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The crop (a PNG data URL) as a JPEG data URL at most THUMB_MAX_SIDE pixels on its longer side. */
export async function makeThumbnail(dataUrl: string, deps: ThumbnailDeps = defaultDeps): Promise<string> {
  const image = await deps.decode(dataUrl);
  try {
    const size = thumbnailSize(image.width, image.height);
    const canvas = deps.canvas(size.width, size.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2D canvas for the thumbnail');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image as never, 0, 0, size.width, size.height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    return `data:image/jpeg;base64,${base64(new Uint8Array(await blob.arrayBuffer()))}`;
  } finally {
    image.close();
  }
}
