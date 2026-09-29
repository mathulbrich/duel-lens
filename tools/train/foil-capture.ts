// Frames of full-card foil prints for the foil test set (foil-report.md): native-size PNG frames of a YouTube
// duel stream at the best quality it serves. A copy of tools/diag-t21820/capture.ts (itself copied from
// tools/live-check/lib/youtube.ts: openVideo, handleConsent, waitForAds, forceQuality, seekAndPause, grabFrame)
// with the video and the output folder as options; headless Chrome for Testing, a throwaway profile, the cookie
// dialog answered "Reject all".
//
//   npx tsx tools/train/foil-capture.ts --video bBbjafm1u2Q --groups "3600:3602;5400:5402" [--out data/train/foil/frames] [--height 1080]
//
// Each group is "loadAt:t1,t2,...": one page load at loadAt, then a paused seek to each t.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from '../../test/e2e/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
import type { Page } from '../../test/e2e/node_modules/puppeteer/lib/puppeteer/puppeteer.js';

const root = path.resolve(import.meta.dirname, '../..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const VIDEO = arg('--video') ?? 'bBbjafm1u2Q';
const log = (m: string) => console.error(`[cap ${new Date().toISOString().slice(11, 19)}] ${m}`);

const QUALITY_LABEL: Record<number, string> = { 2160: 'hd2160', 1440: 'hd1440', 1080: 'hd1080', 720: 'hd720', 480: 'large', 360: 'medium' };
const LABEL_HEIGHT: Record<string, number> = { hd2160: 2160, hd1440: 1440, hd1080: 1080, hd720: 720, large: 480, medium: 360, small: 240, tiny: 144 };
const REJECT = /^(reject all|rejeitar tudo|recusar tudo|alle ablehnen|tout refuser|rechazar todo|rifiuta tutto)$/i;

async function handleConsent(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const handle = await page.evaluateHandle(`(() => {
      const re = ${REJECT.toString()};
      const buttons = Array.from(document.querySelectorAll('button, tp-yt-paper-button, ytd-button-renderer a, [role="button"]'));
      return buttons.find((b) => re.test((b.getAttribute('aria-label') || b.textContent || '').replace(/\\s+/g, ' ').trim())) || null;
    })()`);
    const el = handle.asElement();
    if (!el) {
      await handle.dispose();
      return;
    }
    log('consent dialog: Reject all');
    await (el as any).click();
    await handle.dispose();
    await sleep(2500);
  }
}

async function adShowing(page: Page): Promise<boolean> {
  return (await page.evaluate(`(() => { const p = document.getElementById('movie_player'); return !!p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')); })()`)) as boolean;
}

async function waitForAds(page: Page, maxMs = 120000): Promise<void> {
  const start = Date.now();
  let seen = false;
  while (Date.now() - start < maxMs) {
    if (!(await adShowing(page))) {
      if (seen) log(`ad over after ${Math.round((Date.now() - start) / 1000)} s`);
      return;
    }
    if (!seen) log('ad playing; waiting');
    seen = true;
    await page.evaluate(`(() => { const p = document.getElementById('movie_player'); try { if (p.getPlayerState() !== 1) p.playVideo(); } catch (e) {} })()`);
    const skip = await page.$('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, button[id^="skip-button"]');
    if (skip) {
      await skip.click().catch(() => {});
      await skip.dispose();
    }
    await sleep(1000);
  }
  throw new Error('ad still playing');
}

async function openVideo(page: Page, t: number): Promise<void> {
  const url = `https://www.youtube.com/watch?v=${VIDEO}&t=${Math.max(0, Math.floor(t))}s`;
  await page.bringToFront();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(1500);
  await handleConsent(page);
  if (!page.url().includes('youtube.com/watch')) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await sleep(1500);
  }
  await page.waitForFunction(
    `(() => { const p = document.getElementById('movie_player'); return !!p && typeof p.getPlayerState === 'function' && typeof p.seekTo === 'function' && !!p.querySelector('video'); })()`,
    { timeout: 45000 },
  );
  await page.evaluate(`(() => { const p = document.getElementById('movie_player'); try { p.mute(); } catch (e) {} })()`);
  await waitForAds(page);
  await page.waitForFunction(`(() => { const v = document.querySelector('#movie_player video'); return !!v && v.readyState >= 2 && v.videoWidth > 0 && !v.seeking; })()`, { timeout: 45000 });
  await page.evaluate(`(() => { const p = document.getElementById('movie_player'); try { p.pauseVideo(); } catch (e) {} })()`);
}

async function available(page: Page): Promise<string[]> {
  return (await page.evaluate(`(() => { const p = document.getElementById('movie_player'); try { return p.getAvailableQualityLevels(); } catch (e) { return []; } })()`)) as string[];
}

async function forceQuality(page: Page, label: string): Promise<string> {
  return (await page.evaluate(`(() => {
    const p = document.getElementById('movie_player');
    try { p.setPlaybackQualityRange(${JSON.stringify(label)}, ${JSON.stringify(label)}); } catch (e) {}
    try { p.setPlaybackQuality(${JSON.stringify(label)}); } catch (e) {}
    try { return p.getPlaybackQuality(); } catch (e) { return ''; }
  })()`)) as string;
}

interface SeekInfo {
  currentTime: number;
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  quality: string;
  hung: boolean;
}

async function seekAndPause(page: Page, t: number): Promise<SeekInfo> {
  return (await page.evaluate(`(async () => {
    const p = document.getElementById('movie_player');
    const v = p.querySelector('video');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    try { p.pauseVideo(); } catch (e) {}
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      v.addEventListener('seeked', finish, { once: true });
      p.seekTo(${t}, true);
      setTimeout(finish, 8000);
    });
    for (let i = 0; i < 60 && (v.readyState < 2 || v.seeking); i++) await wait(100);
    try { p.pauseVideo(); } catch (e) {}
    await wait(250);
    let quality = '';
    try { quality = p.getPlaybackQuality(); } catch (e) {}
    return { currentTime: v.currentTime, readyState: v.readyState, videoWidth: v.videoWidth, videoHeight: v.videoHeight, quality, hung: v.seeking || v.readyState < 2 };
  })()`)) as SeekInfo;
}

async function seekAtQuality(page: Page, t: number, height: number, tries = 5): Promise<SeekInfo> {
  const label = QUALITY_LABEL[height] ?? 'hd1080';
  await forceQuality(page, label);
  let seek = await seekAndPause(page, t);
  for (let i = 1; i < tries && seek.videoHeight !== height; i++) {
    if (await adShowing(page)) await waitForAds(page);
    await sleep(1500);
    await forceQuality(page, label);
    seek = await seekAndPause(page, t + (i % 2 ? 0.04 : 0));
  }
  if (seek.videoHeight === height && Math.abs(seek.currentTime - t) > 0.02) seek = await seekAndPause(page, t); // settle back on t
  return seek;
}

async function grabPng(page: Page): Promise<Buffer> {
  const url = (await page.evaluate(`(() => {
    const v = document.querySelector('#movie_player video');
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  })()`)) as string;
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
}

async function main() {
  const groups = (arg('--groups') ?? '3600:3602')
    .split(';')
    .map((g) => {
      const [load, list] = g.split(':');
      return { load: Number(load), times: list.split(',').map(Number) };
    });
  let height = arg('--height') ? Number(arg('--height')) : 0; // 0: the best offered
  const out = path.resolve(root, arg('--out') ?? 'data/train/foil/frames');
  await mkdir(out, { recursive: true });
  const metaFile = path.join(out, 'captures.json');
  const meta: Record<string, unknown>[] = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : [];
  const browser = await puppeteer.launch({
    headless: !process.argv.includes('--headful'),
    pipe: true,
    defaultViewport: { width: 1728, height: 1000, deviceScaleFactor: 1 },
    args: ['--window-size=1728,1000', '--no-first-run', '--lang=en-US', '--autoplay-policy=no-user-gesture-required', '--disable-audio-output'],
  });
  try {
    const page = await browser.newPage();
    for (const g of groups) {
      log(`load at ${g.load} s`);
      try {
        await openVideo(page, g.load);
      } catch (e) {
        log(`open failed at ${g.load}: ${(e as Error).message}`);
        continue;
      }
      const offered = await available(page);
      if (!height) height = Math.max(...offered.map((q) => LABEL_HEIGHT[q] ?? 0));
      log(`offered: ${offered.join(' ')}; asking ${height}p`);
      for (const t of g.times) {
        try {
          const info = await seekAtQuality(page, t, height);
          const png = await grabPng(page);
          const name = `yt-${VIDEO}-t${String(t).replace('.', '_')}`;
          await writeFile(path.join(out, `${name}.png`), png);
          log(`${name}.png ${info.videoWidth}x${info.videoHeight} ${info.quality} at ${info.currentTime.toFixed(3)} s${info.hung ? ' (HUNG)' : ''}`);
          meta.push({ name, video: VIDEO, url: `https://youtu.be/${VIDEO}?t=${Math.floor(t)}`, t, loadAt: g.load, offered, ...info, at: new Date().toISOString() });
          await writeFile(metaFile, JSON.stringify(meta, null, 2));
        } catch (e) {
          log(`failed at ${t}: ${(e as Error).message}`);
        }
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
