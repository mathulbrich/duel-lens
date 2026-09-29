// Grabbing real YouTube frames for the partial-card study (tools/partial/capture.ts).
//
// COPIED, trimmed, from tools/live-check/lib/youtube.ts and tools/live-check/lib/harness.ts (another
// agent owns tools/live-check/, so they are copied rather than imported): the consent dialog (always
// "Reject all"), ads, the player API (#movie_player: setPlaybackQualityRange, seekTo, pauseVideo) and
// grabbing the current frame at its native size by drawing the <video> into a canvas. Code evaluated in
// the page is written as strings (tsx's keepNames adds a __name() helper the page doesn't have).
// Puppeteer lives in the E2E harness's own install (test/e2e/package.json) and is imported by path, as
// tools/store-shots and tools/live-check do.
import puppeteerDefault from '../../../test/e2e/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
import type { Browser, Page } from '../../../test/e2e/node_modules/puppeteer/lib/puppeteer/puppeteer.js';

export const puppeteer = puppeteerDefault;
export type { Browser, Page };

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BotCheck extends Error {}

export type Log = (msg: string) => void;

/** YouTube's quality labels by frame height. */
export const QUALITY_LABEL: Record<number, string> = { 2160: 'hd2160', 1440: 'hd1440', 1080: 'hd1080', 720: 'hd720', 480: 'large', 360: 'medium', 240: 'small', 144: 'tiny' };

/** The most privacy-preserving answer to YouTube's cookie dialog, in the languages it may use. */
const REJECT = /^(reject all|rejeitar tudo|recusar tudo|alle ablehnen|tout refuser|rechazar todo|rifiuta tutto)$/i;

/** Clicks "Reject all" on a consent page or dialog, if one is showing. */
async function handleConsent(page: Page, log: Log): Promise<void> {
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
    log('consent dialog: clicking "Reject all"');
    await (el as any).click();
    await handle.dispose();
    await sleep(2500);
  }
}

async function botCheck(page: Page): Promise<boolean> {
  return (await page.evaluate(`/not a bot|confirm you.re not a bot|unusual traffic/i.test(document.body ? document.body.innerText.slice(0, 5000) : '')`)) as boolean;
}

async function dismissPopups(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const re = /^(no thanks|not now|dismiss|skip trial|não, obrigado|agora não)$/i;
    for (const b of Array.from(document.querySelectorAll('tp-yt-paper-dialog button, ytd-popup-container button, ytd-mealbar-promo-renderer button, yt-mealbar-promo-renderer button'))) {
      const text = (b.getAttribute('aria-label') || b.textContent || '').replace(/\\s+/g, ' ').trim();
      if (re.test(text) && b.offsetParent) b.click();
    }
  })()`);
}

async function adShowing(page: Page): Promise<boolean> {
  return (await page.evaluate(
    `(() => { const p = document.getElementById('movie_player'); return !!p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')); })()`,
  )) as boolean;
}

/** Plays through ads (they only run while playing), clicking "Skip" when it shows; up to `maxMs`. */
async function waitForAds(page: Page, log: Log, maxMs = 120000): Promise<void> {
  const start = Date.now();
  let seen = false;
  while (Date.now() - start < maxMs) {
    if (!(await adShowing(page))) return;
    if (!seen) log('an ad is playing; waiting it out (skipping when possible)');
    seen = true;
    await page.evaluate(`(() => { const p = document.getElementById('movie_player'); try { if (p.getPlayerState() !== 1) p.playVideo(); } catch (e) {} })()`);
    const skip = await page.$('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, button[id^="skip-button"]');
    if (skip) {
      await skip.click().catch(() => {});
      await skip.dispose();
    }
    await sleep(1000);
  }
  throw new Error(`an ad was still playing after ${maxMs / 1000} s`);
}

/**
 * Opens the watch page at `t`, answers the consent dialog, waits for the player, any pre-roll ad and the
 * first frame, and pauses. YouTube serves an automated browser only the first stretch of video after a
 * page load (tools/live-check/lib/youtube.ts), so every moment gets its own page load.
 */
export async function openVideo(page: Page, videoId: string, t: number, log: Log): Promise<void> {
  const url = `https://www.youtube.com/watch?v=${videoId}&t=${Math.max(0, Math.floor(t))}s`;
  await page.bringToFront();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(1500);
  await handleConsent(page, log);
  if (!page.url().includes('youtube.com/watch')) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await sleep(1500);
  }
  try {
    await page.waitForFunction(
      `(() => { const p = document.getElementById('movie_player'); return !!p && typeof p.getPlayerState === 'function' && typeof p.seekTo === 'function' && !!p.querySelector('video'); })()`,
      { timeout: 45000 },
    );
  } catch {
    if (await botCheck(page)) throw new BotCheck('YouTube asks to confirm this is not a bot');
    throw new Error('the YouTube player did not appear within 45 s');
  }
  if (await botCheck(page)) throw new BotCheck('YouTube asks to confirm this is not a bot');
  await page.evaluate(`(() => { const p = document.getElementById('movie_player'); try { p.mute(); } catch (e) {} })()`);
  await dismissPopups(page);
  await waitForAds(page, log);
  await page.waitForFunction(`(() => { const v = document.querySelector('#movie_player video'); return !!v && v.readyState >= 2 && v.videoWidth > 0 && !v.seeking; })()`, { timeout: 45000 });
  await page.evaluate(`(() => { try { document.getElementById('movie_player').pauseVideo(); } catch (e) {} })()`);
}

export interface SeekInfo {
  currentTime: number;
  videoWidth: number;
  videoHeight: number;
  quality: string;
  available: string[];
  hung: boolean;
}

/** Forces `height`p and seeks to `t`, re-seeking until the served frame is that tall (up to `tries`). */
export async function seekAtQuality(page: Page, t: number, height: number, log: Log, tries = 5): Promise<SeekInfo> {
  const label = QUALITY_LABEL[height] ?? 'hd1080';
  let info: SeekInfo | null = null;
  for (let i = 0; i < tries; i++) {
    if (await adShowing(page)) await waitForAds(page, log);
    info = (await page.evaluate(`(async () => {
      const p = document.getElementById('movie_player');
      const v = p.querySelector('video');
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      let available = [];
      try { available = p.getAvailableQualityLevels(); } catch (e) {}
      try { p.setPlaybackQualityRange(${JSON.stringify(label)}, ${JSON.stringify(label)}); } catch (e) {}
      try { p.setPlaybackQuality(${JSON.stringify(label)}); } catch (e) {}
      try { p.pauseVideo(); } catch (e) {}
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        v.addEventListener('seeked', finish, { once: true });
        p.seekTo(${t + (i % 2 ? 0.04 : 0)}, true);
        setTimeout(finish, 8000);
      });
      for (let k = 0; k < 60 && (v.readyState < 2 || v.seeking); k++) await wait(100);
      try { p.pauseVideo(); } catch (e) {}
      await wait(300);
      let quality = '';
      try { quality = p.getPlaybackQuality(); } catch (e) {}
      return { currentTime: v.currentTime, videoWidth: v.videoWidth, videoHeight: v.videoHeight, quality, available, hung: v.seeking || v.readyState < 2 };
    })()`)) as SeekInfo;
    if (info.videoHeight >= height && !info.hung) break;
    await sleep(1500);
  }
  return info!;
}

/** The current frame at its native size, as PNG bytes (the <video> drawn into a canvas). */
export async function grabFrame(page: Page): Promise<Buffer> {
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
