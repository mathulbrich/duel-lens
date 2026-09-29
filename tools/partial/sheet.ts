// A contact sheet for eyeballing the partial-card study's images: each image scaled to one height,
// tiled in rows, captioned with its file name (or `label=path`).
//
//   npx tsx tools/partial/sheet.ts --out sheet.png [--height 240] [--cols 6] <img|label=img> ...
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function contactSheet(items: { label: string; file: string }[], out: string, height = 240, cols = 6): Promise<void> {
  const caption = 18;
  const pad = 6;
  const tiles = await Promise.all(
    items.map(async ({ label, file }) => {
      const img = sharp(file).resize({ height, fit: 'inside', withoutEnlargement: false });
      const buf = await img.png().toBuffer();
      const meta = await sharp(buf).metadata();
      return { label, buf, w: meta.width ?? height, h: meta.height ?? height };
    }),
  );
  const rows: (typeof tiles)[] = [];
  for (let i = 0; i < tiles.length; i += cols) rows.push(tiles.slice(i, i + cols));
  const rowW = rows.map((r) => r.reduce((s, t) => s + t.w + pad, pad));
  const W = Math.max(...rowW, 100);
  const H = rows.length * (height + caption + pad) + pad;
  const composites: OverlayOptions[] = [];
  const texts: string[] = [];
  rows.forEach((r, ri) => {
    let x = pad;
    const y = pad + ri * (height + caption + pad);
    for (const t of r) {
      composites.push({ input: t.buf, left: x, top: y + caption });
      texts.push(`<text x="${x}" y="${y + caption - 4}" font-size="13" font-family="monospace" fill="#fff">${esc(t.label.slice(0, Math.max(8, Math.floor(t.w / 7.5))))}</text>`);
      x += t.w + pad;
    }
  });
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${texts.join('')}</svg>`);
  await sharp({ create: { width: W, height: H, channels: 4, background: { r: 30, g: 30, b: 30, alpha: 1 } } })
    .composite([...composites, { input: svg, left: 0, top: 0 }])
    .png()
    .toFile(out);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const out = arg('--out') ?? 'sheet.png';
  const height = Number(arg('--height') ?? 240);
  const cols = Number(arg('--cols') ?? 6);
  const skip = new Set(['--out', '--height', '--cols']);
  const items = process.argv
    .slice(2)
    .filter((a, i, all) => !skip.has(a) && !skip.has(all[i - 1]))
    .map((a) => {
      const eq = a.indexOf('=');
      return eq > 0 && !a.slice(0, eq).includes('/') ? { label: a.slice(0, eq), file: a.slice(eq + 1) } : { label: path.basename(a), file: a };
    });
  contactSheet(items, out, height, cols).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
