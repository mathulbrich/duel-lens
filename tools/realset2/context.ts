// realset2 context: frames a few seconds before and after a set frame, to identify a card that a hand
// (or glare) hides in the set frame from the same card seen uncovered a moment earlier or later (the
// feature-match camera is fixed, so the card is at the same place). Context frames are for a person's
// identification only: they are saved under data/realset2/context/ (local, like every realset2 frame)
// and are never part of the set.
//
//   npx tsx tools/realset2/context.ts --pids <frame>#<i>,... [--offsets -6,-3,3,6,10]
//
// For each set frame: one page load a little before the earliest offset (tools/live-check/lib/youtube.ts),
// 1080p forced, a frame grabbed at each offset; the card detector's face-up box overlapping the proposal
// most (IoU of the axis-aligned boxes) is read by the engine. Appends to data/realset2/context.jsonl:
// {pid, frame, ctx: [{dt, file, iou, userBox, confident, top: [{cardId, name, score}]}]}.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { puppeteer, type Page } from '../live-check/lib/harness';
import { BotCheck, grabFrame, openVideo, seekAndPause, seekAtQuality } from '../live-check/lib/youtube';
import { loadRGBA } from '../lib/image';
import { makeRig } from '../partial/lib/engine';
import { buildCrop } from '../realset/lib/crop';
import { cardById } from './lib/refs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'data/realset2');
const CTX = path.join(OUT, 'context');

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const pids = (arg('--pids') ?? '').split(',').filter(Boolean);
const offsets = (arg('--offsets') ?? '-6,-3,3,6,10').split(',').map(Number);

interface Box {
  pid: string;
  userBox: { x: number; y: number; w: number; h: number };
}
type AB = Box['userBox'];
const iou = (a: AB, b: AB) => {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return i / (a.w * a.h + b.w * b.h - i);
};

async function main() {
  mkdirSync(CTX, { recursive: true });
  const frames = new Map<string, { video: string; t: number; boxes: Box[] }>();
  for (const line of readFileSync(path.join(OUT, 'proposals.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    const p = JSON.parse(line) as { frame: string; video: string; t: number; boxes: Box[] };
    frames.set(p.frame, p);
  }
  const byFrame = new Map<string, Box[]>();
  for (const pid of pids) {
    const f = pid.split('#')[0];
    const p = frames.get(f);
    const b = p?.boxes.find((x) => x.pid === pid);
    if (!p || !b) throw new Error(`unknown proposal ${pid}`);
    byFrame.set(f, [...(byFrame.get(f) ?? []), b]);
  }
  const rig = await makeRig('dinov2-small-duel');
  const browser = await puppeteer.launch({
    headless: true,
    pipe: true,
    defaultViewport: { width: 1728, height: 1000, deviceScaleFactor: 2 },
    args: ['--window-size=1728,1000', '--force-device-scale-factor=2', '--no-first-run', '--lang=en-US', '--autoplay-policy=no-user-gesture-required', '--disable-audio-output'],
  });
  const log = (m: string) => console.error(`[context] ${m}`);
  try {
    const page: Page = await browser.newPage();
    for (const [frame, boxes] of byFrame) {
      const { video, t } = frames.get(frame)!;
      const start = t + Math.min(...offsets) - 2;
      try {
        await openVideo(page, video, start, log);
      } catch (e) {
        if (e instanceof BotCheck) throw e;
        log(`could not open ${video} at ${start}: ${(e as Error).message}`);
        continue;
      }
      const out = new Map<string, unknown[]>(boxes.map((b) => [b.pid, []]));
      for (const [k, dt] of offsets.entries()) {
        const at = t + dt;
        const seek = k === 0 ? (await seekAtQuality(page, at, 1080, log)).seek : await seekAndPause(page, at);
        if (seek.hung || !seek.videoWidth) {
          log(`${frame}: seek to ${at} hung`);
          continue;
        }
        const png = await grabFrame(page, 'image/png');
        const file = path.join(CTX, `${frame}-d${dt >= 0 ? '+' : ''}${dt}.jpg`);
        await sharp(png).jpeg({ quality: 90 }).toFile(file);
        const img = await loadRGBA(png);
        const found = (await rig.det.findCards(img, { refine: true })).filter((b) => b.conf >= 0.3 && b.kind === 'face-up');
        for (const b of boxes) {
          let best: { u: AB; v: number } | null = null;
          for (const c of found) {
            const xs = c.pts.map((p) => p[0]);
            const ys = c.pts.map((p) => p[1]);
            const u = { x: Math.max(0, Math.floor(Math.min(...xs))), y: Math.max(0, Math.floor(Math.min(...ys))), w: 0, h: 0 };
            u.w = Math.min(img.width, Math.ceil(Math.max(...xs))) - u.x;
            u.h = Math.min(img.height, Math.ceil(Math.max(...ys))) - u.y;
            const v = iou(u, b.userBox);
            if (!best || v > best.v) best = { u, v };
          }
          if (!best || best.v < 0.3) {
            out.get(b.pid)!.push({ dt, file: path.relative(ROOT, file), iou: best ? Math.round(best.v * 100) / 100 : 0, userBox: null, confident: false, top: [] });
            continue;
          }
          const { cropImg, inner } = buildCrop(img, best.u);
          const r = await rig.engine.recognize(cropImg, inner);
          out.get(b.pid)!.push({
            dt,
            file: path.relative(ROOT, file),
            iou: Math.round(best.v * 100) / 100,
            userBox: best.u,
            confident: r.confident,
            top: r.candidates.slice(0, 3).map((c) => ({ cardId: c.cardId, name: cardById.get(c.cardId)?.name ?? String(c.cardId), score: Math.round(c.score * 10000) / 10000 })),
          });
        }
      }
      for (const [pid, ctx] of out) {
        appendFileSync(path.join(OUT, 'context.jsonl'), JSON.stringify({ pid, frame, ctx }) + '\n');
        const sure = (ctx as { confident: boolean; top: { name: string }[]; dt: number }[]).filter((c) => c.confident);
        log(`${pid}: ${sure.length ? sure.map((c) => `${c.dt}s ${c.top[0].name}`).join('; ') : 'no confident context read'}`);
      }
    }
  } finally {
    await browser.close();
    await rig.release();
  }
  if (!existsSync(path.join(OUT, 'context.jsonl'))) console.error('[context] nothing written');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
