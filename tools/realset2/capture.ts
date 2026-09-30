// realset2 capture: native frames from the HELD-OUT test videos (data/overnight/videos.json, split
// 'heldout-realset2', or 'heldout-realset1' with --allow-realset1; never 'train'), for the held-out
// real test set data/realset2 (tools/realset2/README.md). Test use only: the frames stay on this
// machine (data/ is gitignored) and are never trained on.
//
//   npx tsx tools/realset2/capture.ts --videos id,id [--every 600] [--start 900] [--end-margin 600]
//        [--offsets 0,9] [--min-faceup 2] [--max-frames N] [--tag name]
//
// For each moment (every --every seconds, with a small jitter, from --start to the end minus
// --end-margin): one page load at the moment (an automated browser is served only ~20-40 s after a
// load; tools/live-check/lib/youtube.ts), 1080p forced, a frame grabbed at each --offsets second, the
// card detector run on it, and the frame with the most face-up cards kept (at least --min-faceup) as
// data/realset2/frames/<frame>.jpg (JPEG q90), with a line in data/realset2/capture.jsonl.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { puppeteer, sleep, type Page } from '../live-check/lib/harness';
import { BotCheck, grabFrame, openVideo, seekAtQuality, seekAndPause } from '../live-check/lib/youtube';
import { loadRGBA } from '../lib/image';
import { createNodeCardDetector } from '../../src/offscreen/detector/node';
import { CARD_DETECTOR } from '../../src/offscreen/detector/spec';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'data/realset2');
const FRAMES = path.join(OUT, 'frames');

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

interface VideoRow {
  id: string;
  hours: number;
  event: string;
  eventKey: string;
  split: string;
}

const videos = (JSON.parse(readFileSync(path.join(ROOT, 'data/overnight/videos.json'), 'utf8')) as { videos: VideoRow[] }).videos;
const allowed = new Set(['heldout-realset2', ...(process.argv.includes('--allow-realset1') ? ['heldout-realset1'] : [])]);
const wanted = (arg('--videos') ?? '').split(',').filter(Boolean);
const every = Number(arg('--every') ?? 600);
const start = Number(arg('--start') ?? 900);
const endMargin = Number(arg('--end-margin') ?? 600);
const offsets = (arg('--offsets') ?? '0,9').split(',').map(Number);
const minFaceUp = Number(arg('--min-faceup') ?? 2);
const maxFrames = Number(arg('--max-frames') ?? 1e9);
const tag = arg('--tag') ?? 'cap';
const phase = Number(arg('--phase') ?? 0);

const logFile = path.join(OUT, `capture-${tag}.log`);
const log = (m: string) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`;
  appendFileSync(logFile, line + '\n');
  console.log(line);
};

/** A short, file-safe event tag: "Sydney 2026 D1" -> "syd26d1". */
function eventTag(v: VideoRow): string {
  const e = v.event.toLowerCase();
  const day = /\bd(\d)\b/.exec(e)?.[1] ?? '';
  const year = /20(\d\d)/.exec(e)?.[1] ?? '';
  const place = e.replace(/20\d\d|\bd\d\b|genesys|\s+/g, '').slice(0, 5);
  return `${place}${year}${day ? `d${day}` : ''}`;
}

async function main() {
  const picked = wanted.map((id) => {
    const v = videos.find((x) => x.id === id);
    if (!v) throw new Error(`video ${id} is not in data/overnight/videos.json`);
    if (!allowed.has(v.split)) throw new Error(`video ${id} has split "${v.split}": realset2 may only use held-out videos`);
    return v;
  });
  if (picked.length === 0) throw new Error('--videos id,id (held-out videos only)');
  await mkdir(FRAMES, { recursive: true });
  const detector = (await createNodeCardDetector()).asCardDetector({ minConfidence: CARD_DETECTOR.minConfidence });
  const browser = await puppeteer.launch({
    headless: true,
    pipe: true,
    defaultViewport: { width: 1728, height: 1000, deviceScaleFactor: 2 },
    args: ['--window-size=1728,1000', '--force-device-scale-factor=2', '--no-first-run', '--lang=en-US', '--autoplay-policy=no-user-gesture-required', '--disable-audio-output'],
  });
  let saved = 0;
  try {
    const page: Page = await browser.newPage();
    for (const v of picked) {
      const durationS = Math.round(v.hours * 3600);
      const moments: number[] = [];
      for (let t = start + phase; t < durationS - endMargin; t += every) moments.push(Math.round(t + (Math.random() - 0.5) * 60));
      log(`video ${v.id} (${v.event}, ${v.split}): ${moments.length} moments every ${every} s`);
      let savedHere = 0;
      for (const t of moments) {
        if (saved >= maxFrames) break;
        const frameName = `r2-${eventTag(v)}-${v.id}-t${t}`;
        if (existsSync(path.join(FRAMES, `${frameName}.jpg`))) continue;
        const t0 = Date.now();
        try {
          await openVideo(page, v.id, t, log);
        } catch (e) {
          if (e instanceof BotCheck) {
            log(`BOT CHECK at ${v.id} t=${t}: stopping`);
            throw e;
          }
          log(`  could not open ${v.id} at ${t}: ${(e as Error).message}`);
          continue;
        }
        let best: { png: Buffer; faceUp: number; faceDown: number; t: number; w: number; h: number; quality: string } | null = null;
        for (const [k, dt] of offsets.entries()) {
          try {
            const { seek } = k === 0 ? await seekAtQuality(page, t + dt, 1080, log) : { seek: await seekAndPause(page, t + dt) };
            if (seek.hung || !seek.videoWidth) {
              log(`  seek to ${t + dt} hung (${seek.videoWidth}x${seek.videoHeight})`);
              continue;
            }
            const png = await grabFrame(page, 'image/png');
            const img = await loadRGBA(png);
            const boxes = await detector.detect(img);
            const faceUp = boxes.filter((b) => b.kind !== 'face-down').length;
            const faceDown = boxes.length - faceUp;
            if (!best || faceUp > best.faceUp) best = { png, faceUp, faceDown, t: Math.round(seek.currentTime * 100) / 100, w: img.width, h: img.height, quality: seek.quality };
          } catch (e) {
            log(`  grab at ${t + dt} failed: ${(e as Error).message}`);
          }
        }
        if (!best) continue;
        const keep = best.faceUp >= minFaceUp;
        log(`  t=${t}: best ${best.t}s ${best.w}x${best.h} (${best.quality}) face-up ${best.faceUp} face-down ${best.faceDown} ${keep ? 'KEEP' : 'skip'} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
        if (!keep) continue;
        const name = `r2-${eventTag(v)}-${v.id}-t${Math.round(best.t)}`;
        await sharp(best.png).jpeg({ quality: 90 }).toFile(path.join(FRAMES, `${name}.jpg`));
        appendFileSync(
          path.join(OUT, 'capture.jsonl'),
          JSON.stringify({ frame: name, video: v.id, event: v.event, split: v.split, t: best.t, width: best.w, height: best.h, quality: best.quality, faceUp: best.faceUp, faceDown: best.faceDown, at: new Date().toISOString() }) + '\n',
        );
        saved++;
        savedHere++;
        await sleep(500);
      }
      log(`video ${v.id}: saved ${savedHere}`);
    }
  } finally {
    await browser.close();
    await detector.release?.();
  }
  log(`done: ${saved} frames`);
}

main().catch((e) => {
  log(`FAILED: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
