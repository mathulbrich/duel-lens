// Synthetic degradations of an artwork crop: how the art box looks when cut out of a website
// screenshot ('mild') or a low-quality duel video ('video', 'extreme'). Used by
// tools/benchmark.ts and the engine's integration test. Deterministic for a given seed.
//
//   clean         the input itself
//   mild          shift and crop 3%, JPEG 70, brightness ±10%
//   video         in the brief's order: the card is 64–128 px wide, so the art is scaled down to
//                 that × ART_BOX.w (≈ 49–98 px) and back up; Gaussian blur σ 0.6–1.5; JPEG 25–45;
//                 ±6° rotation with 5–10% misframing (the card frame shows at the edges); colour
//                 jitter ±20%; a glare blob (α 0.25–0.5) with probability 0.5
//   extreme       as video, but the card is 40–64 px wide, JPEG 15 and blur σ 2
//   video-lowres  stress level, not part of the brief: the same scene as 'video', but blur and
//                 JPEG hit the art at its small capture size, as a low-bitrate video codec would
import sharp, { type KernelEnum, type Sharp } from 'sharp';
import { ART_BOX } from '../../src/shared/card-layout';
import type { RGBAImage } from '../../src/shared/preprocess';

/** The brief's levels, easiest first. */
export const DEGRADE_LEVELS = ['clean', 'mild', 'video', 'extreme'] as const;
/** Harsher levels the benchmark reports but does not gate on. */
export const STRESS_LEVELS = ['video-lowres'] as const;
export type DegradeLevel = (typeof DEGRADE_LEVELS)[number] | (typeof STRESS_LEVELS)[number];

type Rng = () => number;
type RGB = [number, number, number];

/** mulberry32, seeded from (seed, level) so each level draws independently ('video-lowres' shares 'video''s scene). */
function rngFor(seed: number, level: DegradeLevel): Rng {
  const stream = DEGRADE_LEVELS.indexOf(level === 'video-lowres' ? 'video' : level);
  let a = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(stream + 1, 0x85ebca6b)) | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (r: Rng, lo: number, hi: number) => lo + (hi - lo) * r();
const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

// Card frame colours around the art box (effect, normal, spell, trap, fusion, synchro, xyz,
// link, ritual) and the pale text box just below it.
const FRAMES: RGB[] = [
  [196, 118, 64], [214, 180, 96], [28, 150, 120], [180, 80, 130], [150, 120, 180],
  [215, 215, 215], [40, 40, 40], [30, 90, 160], [100, 140, 200],
];
const TEXT_BOX: RGB = [226, 214, 186];

const toSharp = (img: RGBAImage) =>
  sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), {
    raw: { width: img.width, height: img.height, channels: 4 },
  });

async function fromSharp(s: Sharp): Promise<RGBAImage> {
  const { data, info } = await s.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

const resize = (img: RGBAImage, width: number, height: number, kernel: keyof KernelEnum = 'lanczos3') =>
  fromSharp(toSharp(img).resize(width, height, { fit: 'fill', kernel }));

const blur = (img: RGBAImage, sigma: number) => fromSharp(toSharp(img).blur(sigma));

async function jpeg(img: RGBAImage, quality: number): Promise<RGBAImage> {
  const buf = await toSharp(img).removeAlpha().jpeg({ quality: Math.round(quality) }).toBuffer();
  return fromSharp(sharp(buf));
}

/**
 * Re-frame the image as if the crop box were rotated by `angle` degrees, scaled by `zoom` and
 * shifted by (dx, dy) pixels. Areas outside the artwork show the card frame (the text box below).
 */
function reframe(img: RGBAImage, angle: number, zoom: number, dx: number, dy: number, frame: RGB): RGBAImage {
  const { width: w, height: h, data: src } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  const cos = Math.cos((angle * Math.PI) / 180) * zoom;
  const sin = Math.sin((angle * Math.PI) / 180) * zoom;
  const cx = w / 2 + dx;
  const cy = h / 2 + dy;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x + 0.5 - w / 2;
      const v = y + 0.5 - h / 2;
      const sx = cx + cos * u - sin * v - 0.5;
      const sy = cy + sin * u + cos * v - 0.5;
      const o = (y * w + x) * 4;
      if (sx < -0.5 || sy < -0.5 || sx > w - 0.5 || sy > h - 0.5) {
        const c = sy > h - 0.5 ? TEXT_BOX : frame;
        out[o] = c[0];
        out[o + 1] = c[1];
        out[o + 2] = c[2];
        out[o + 3] = 255;
        continue;
      }
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(sx)));
      const y0 = Math.max(0, Math.min(h - 1, Math.floor(sy)));
      const x1 = Math.min(w - 1, x0 + 1);
      const y1 = Math.min(h - 1, y0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const fy = Math.max(0, Math.min(1, sy - y0));
      for (let c = 0; c < 3; c++) {
        const a = src[(y0 * w + x0) * 4 + c] * (1 - fx) + src[(y0 * w + x1) * 4 + c] * fx;
        const b = src[(y1 * w + x0) * 4 + c] * (1 - fx) + src[(y1 * w + x1) * 4 + c] * fx;
        out[o + c] = a * (1 - fy) + b * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

/** Saturation, then contrast around mid-grey, then brightness (factors near 1). In place. */
function colourJitter(img: RGBAImage, brightness: number, contrast: number, saturation: number): RGBAImage {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const luma = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    for (let c = 0; c < 3; c++) {
      const s = luma + saturation * (d[i + c] - luma);
      d[i + c] = clamp255(((s - 128) * contrast + 128) * brightness);
    }
  }
  return img;
}

/** A soft white highlight (sleeve or lamp reflection). In place. */
function glare(img: RGBAImage, cx: number, cy: number, radius: number, alpha: number): RGBAImage {
  const { width: w, height: h, data: d } = img;
  const k = 1 / (2 * radius * radius);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = alpha * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) * k);
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) d[o + c] = d[o + c] * (1 - a) + 255 * a;
    }
  }
  return img;
}

async function mild(img: RGBAImage, r: Rng): Promise<RGBAImage> {
  const cw = Math.max(1, Math.round(img.width * 0.97));
  const ch = Math.max(1, Math.round(img.height * 0.97));
  const left = Math.round(between(r, 0, img.width - cw));
  const top = Math.round(between(r, 0, img.height - ch));
  const shifted = await fromSharp(
    toSharp(img).extract({ left, top, width: cw, height: ch }).resize(img.width, img.height, { fit: 'fill' }),
  );
  const b = between(r, 0.9, 1.1);
  return jpeg(colourJitter(shifted, b, 1, 1), 70);
}

interface VideoParams {
  cardWidth: [number, number];
  jpeg: [number, number];
  blur: [number, number];
}

/** Every random choice of a video-like degradation, drawn in a fixed order. */
function drawScene(img: RGBAImage, r: Rng, p: VideoParams) {
  const artW = Math.max(8, Math.round(between(r, ...p.cardWidth) * ART_BOX.w));
  return {
    artW,
    artH: Math.max(8, Math.round((artW * img.height) / img.width)),
    angle: between(r, -6, 6),
    miss: between(r, 0.05, 0.1),
    dir: between(r, 0, 2 * Math.PI),
    zoom: between(r, 0.95, 1.05),
    frame: FRAMES[Math.floor(r() * FRAMES.length)],
    colour: [between(r, 0.8, 1.2), between(r, 0.8, 1.2), between(r, 0.8, 1.2)] as const,
    glare: { on: r() < 0.5, x: r(), y: r(), radius: between(r, 0.15, 0.4), alpha: between(r, 0.25, 0.5) },
    sigma: between(r, ...p.blur),
    quality: between(r, ...p.jpeg),
  };
}

type Scene = ReturnType<typeof drawScene>;

/** Misframing, colour jitter and glare at the image's current size (in place where possible). */
function lookOf(img: RGBAImage, s: Scene): RGBAImage {
  const { width: w, height: h } = img;
  const out = reframe(img, s.angle, s.zoom, Math.cos(s.dir) * s.miss * w, Math.sin(s.dir) * s.miss * h, s.frame);
  colourJitter(out, ...s.colour);
  if (s.glare.on) glare(out, s.glare.x * w, s.glare.y * h, s.glare.radius * w, s.glare.alpha);
  return out;
}

/** The brief's order: resolution loss (down and back up), blur, JPEG, then framing and colour. */
async function video(img: RGBAImage, s: Scene): Promise<RGBAImage> {
  let out = await resize(await resize(img, s.artW, s.artH), img.width, img.height, 'cubic');
  out = await blur(out, s.sigma);
  out = await jpeg(out, s.quality);
  return lookOf(out, s);
}

/** Blur and JPEG at the capture size, before scaling back up (a low-bitrate codec). */
async function videoLowres(img: RGBAImage, s: Scene): Promise<RGBAImage> {
  let out = lookOf(await resize(img, s.artW, s.artH), s);
  out = await blur(out, s.sigma);
  out = await jpeg(out, s.quality);
  return resize(out, img.width, img.height, 'cubic');
}

const VIDEO: VideoParams = { cardWidth: [64, 128], jpeg: [25, 45], blur: [0.6, 1.5] };
const EXTREME: VideoParams = { cardWidth: [40, 64], jpeg: [15, 15], blur: [2, 2] };

/** Degrade an artwork crop. Returns a new image of the same size (or the input for 'clean'). */
export async function degrade(img: RGBAImage, level: DegradeLevel, seed: number): Promise<RGBAImage> {
  if (level === 'clean') return img;
  const r = rngFor(seed, level);
  switch (level) {
    case 'mild':
      return mild(img, r);
    case 'video':
      return video(img, drawScene(img, r, VIDEO));
    case 'extreme':
      return video(img, drawScene(img, r, EXTREME));
    case 'video-lowres':
      return videoLowres(img, drawScene(img, r, VIDEO));
  }
}
