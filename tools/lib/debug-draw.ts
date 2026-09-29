// Tiny drawing helpers for tools/debug-scan.ts. No canvas package is installed in this repo,
// so overlays are rendered as SVG and composited with sharp: an SVG whose root <svg width height>
// matches the raw buffer's pixel size renders 1:1 onto it (verified against sharp directly; no
// DPI rescaling), so corner coordinates in image pixels land exactly where drawn.
import sharp from 'sharp';
import type { RGBAImage } from '../../src/shared/preprocess';

function toBuffer(img: RGBAImage): Buffer {
  const d = img.data;
  return Buffer.from(d.buffer, d.byteOffset, d.byteLength);
}

/** Write an RGBAImage to a PNG file. */
export async function writePng(img: RGBAImage, filePath: string): Promise<void> {
  await sharp(toBuffer(img), { raw: { width: img.width, height: img.height, channels: 4 } }).png().toFile(filePath);
}

/**
 * Write `img` as a PNG with every outline traced (a polygon through its corners, labelled at its first
 * corner) and, dashed, the user's box: everything a detector found in an image, at a glance.
 */
export async function writeOutlinesPng(
  img: RGBAImage,
  outlines: readonly { pts: readonly [number, number][]; label: string; color: string }[],
  userBox: { x: number; y: number; w: number; h: number } | null,
  filePath: string,
): Promise<void> {
  const long = Math.max(img.width, img.height);
  const stroke = Math.max(2, Math.round(long / 400));
  const font = Math.max(12, Math.round(long / 45));
  const box = userBox
    ? `<rect x="${userBox.x}" y="${userBox.y}" width="${userBox.w}" height="${userBox.h}" fill="none" stroke="#5ac8fa" stroke-width="${stroke}" stroke-dasharray="${4 * stroke},${3 * stroke}"/>`
    : '';
  const polygons = outlines
    .map(({ pts, label, color }) => {
      const [lx, ly] = pts[0];
      // At the first corner, kept inside the image (monospace: about 0.6 em per character).
      const tx = Math.max(0, Math.min(lx, img.width - 0.6 * font * label.length));
      return (
        `<polygon points="${pts.map(([x, y]) => `${x},${y}`).join(' ')}" fill="none" stroke="${color}" stroke-width="${stroke}"/>` +
        `<text x="${tx}" y="${Math.max(font, ly - 3)}" fill="${color}" font-size="${font}" font-family="monospace" font-weight="bold">${label}</text>`
      );
    })
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${img.width}" height="${img.height}">${box}${polygons}</svg>`;
  await sharp(toBuffer(img), { raw: { width: img.width, height: img.height, channels: 4 } })
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }])
    .png()
    .toFile(filePath);
}

/**
 * Write `img` as a PNG with a polygon traced through `corners` (image pixels, in order) and
 * a numbered dot at each one, so a detected card's quad can be checked against the source frame.
 */
export async function writeQuadPng(img: RGBAImage, corners: readonly [number, number][], filePath: string): Promise<void> {
  const pts = corners.map(([x, y]) => `${x},${y}`).join(' ');
  const dots = corners
    .map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="6" fill="#ff2d55"/><text x="${x + 9}" y="${y - 6}" font-size="22" fill="#ff2d55" font-family="sans-serif" font-weight="bold">${i}</text>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${img.width}" height="${img.height}"><polygon points="${pts}" fill="none" stroke="#30d158" stroke-width="3"/>${dots}</svg>`;
  await sharp(toBuffer(img), { raw: { width: img.width, height: img.height, channels: 4 } })
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }])
    .png()
    .toFile(filePath);
}
