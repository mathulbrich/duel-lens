// Captures real YouTube frames at native resolution for the partial-card study: the watch page is
// opened at each moment, the best quality asked for (1080p by default), the video paused there, and the
// frame read by drawing the <video> into a canvas (the pixels the extension's crop comes from). Frames
// go to data/debug/partial/ (gitignored: real footage stays local).
//
//   npx tsx tools/partial/capture.ts --video nwcNiPwQE_8 --times 3305[,3306.5,...] [--height 1080]
//     [--prefix yt-nwcNiPwQE_8] [--out data/debug/partial] [--headful]
//
// It needs the network and talks to youtube.com (a throwaway profile; the cookie dialog is always
// answered "Reject all"). Each frame's metadata (served size and quality, the paused time) is appended
// to <out>/captures.json.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BotCheck, grabFrame, openVideo, puppeteer, seekAtQuality } from './lib/youtube';

const root = path.resolve(import.meta.dirname, '../..');
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const video = arg('--video');
  const times = (arg('--times') ?? '').split(',').filter(Boolean).map(Number);
  if (!video || times.length === 0 || times.some((t) => !Number.isFinite(t) || t < 0)) {
    throw new Error('Usage: npx tsx tools/partial/capture.ts --video <id> --times t1,t2,... [--height 1080] [--prefix name] [--out dir] [--headful]');
  }
  const height = Number(arg('--height') ?? 1080);
  const prefix = arg('--prefix') ?? `yt-${video}`;
  const out = path.resolve(root, arg('--out') ?? 'data/debug/partial');
  await mkdir(out, { recursive: true });
  const log = (m: string) => console.error(`[capture ${new Date().toISOString().slice(11, 19)}] ${m}`);

  const browser = await puppeteer.launch({
    headless: !process.argv.includes('--headful'),
    pipe: true,
    defaultViewport: { width: 1728, height: 1000, deviceScaleFactor: 1 },
    // --disable-audio-output: without an audio sink the media clock never starts (tools/live-check).
    args: ['--window-size=1728,1000', '--no-first-run', '--lang=en-US', '--autoplay-policy=no-user-gesture-required', '--disable-audio-output'],
  });
  const metaFile = path.join(out, 'captures.json');
  const meta: Record<string, unknown>[] = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : [];
  try {
    const page = await browser.newPage();
    for (const t of times) {
      log(`${video} at ${t} s`);
      try {
        await openVideo(page, video, t, log);
        const info = await seekAtQuality(page, t, height, log);
        const png = await grabFrame(page);
        const name = `${prefix}-t${String(t).replace('.', '_')}`;
        await writeFile(path.join(out, `${name}.png`), png);
        log(`${name}.png: ${info.videoWidth}x${info.videoHeight} (${info.quality}; offered ${info.available.join(' ')}) at ${info.currentTime.toFixed(3)} s${info.hung ? ' (seek hung)' : ''}`);
        meta.push({ name, video, url: `https://youtu.be/${video}?t=${Math.floor(t)}`, t, ...info, at: new Date().toISOString() });
        await writeFile(metaFile, JSON.stringify(meta, null, 2));
      } catch (e) {
        if (e instanceof BotCheck) throw e;
        log(`failed at ${t} s: ${(e as Error).message}`);
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
