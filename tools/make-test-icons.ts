// The local test builds' icons (build.mjs --local): the store icons with their dark ground turned orange, and a "TEST"
// band on the 48 and 128 px ones, so a test build is told apart from the store one at a glance (the toolbar, the
// extensions page). Writes extension/icons/test/icon-<size>.png from extension/icons/icon-<size>.png.
// Usage: npx tsx tools/make-test-icons.ts
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..');
const SIZES = [16, 32, 48, 128];
const ORANGE = [0xff, 0x7a, 0x1a];

await mkdir(path.join(root, 'extension/icons/test'), { recursive: true });
for (const size of SIZES) {
  const { data, info } = await sharp(path.join(root, `extension/icons/icon-${size}.png`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // The dark ground (and its anti-aliased edge, by how dark it is) becomes orange; the gold card and the lens stay.
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    if (data[i + 3] === 0 || lum > 90) continue;
    const t = Math.min(1, (90 - lum) / 60); // 1 on the ground (and anything as dark), 0 at the glyphs' edge
    for (let c = 0; c < 3; c++) data[i + c] = Math.round(ORANGE[c] * t + data[i + c] * (1 - t));
  }
  if (size >= 48) {
    // The visible square's bottom (the icon has a transparent margin): the band ends there.
    let bottom = size - 1;
    while (bottom > 0 && data[(bottom * size + size / 2) * 4 + 3] < 128) bottom--;
    const bandH = Math.round(size * 0.24);
    const top = bottom + 1 - bandH;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <rect x="0" y="${top}" width="${size}" height="${bandH}" fill="#1b1222"/>
      <text x="${size / 2}" y="${top + bandH * 0.78}" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="${Math.round(bandH * 0.72)}" fill="#ffffff" text-anchor="middle" letter-spacing="${size >= 128 ? 2 : 0}">TEST</text>
    </svg>`;
    // Painted over the colours only: the icon keeps its own alpha (its rounded corners).
    const band = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
    for (let i = 0; i < data.length; i += 4) {
      const a = band[i + 3] / 255;
      for (let c = 0; c < 3; c++) data[i + c] = Math.round(band[i + c] * a + data[i + c] * (1 - a));
    }
  }
  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(path.join(root, `extension/icons/test/icon-${size}.png`));
  console.log(`extension/icons/test/icon-${size}.png`);
}
