// Driving a real YouTube watch page for the live check: the consent dialog (always "Reject all"), ads,
// the player API (#movie_player: setPlaybackQualityRange, seekTo, pauseVideo), the served quality,
// grabbing the current frame at its native size, and where the picture sits on the page.
// Code evaluated in the page is written as strings (tsx's keepNames adds a __name() helper the page
// doesn't have).
import { sleep, type Page } from './harness';

export class BotCheck extends Error {}

export type Log = (msg: string) => void;

/** YouTube's quality labels by frame height. */
export const QUALITY_LABEL: Record<number, string> = { 2160: 'hd2160', 1440: 'hd1440', 1080: 'hd1080', 720: 'hd720', 480: 'large', 360: 'medium', 240: 'small', 144: 'tiny' };

/** The most privacy-preserving answer to YouTube's cookie dialog, in the languages it may use. */
const REJECT = /^(reject all|rejeitar tudo|recusar tudo|alle ablehnen|tout refuser|rechazar todo|rifiuta tutto)$/i;

/** Clicks "Reject all" on a consent page or dialog, if one is showing. Returns what it did. */
export async function handleConsent(page: Page, log: Log): Promise<string | null> {
  for (let i = 0; i < 3; i++) {
    const handle = await page.evaluateHandle(`(() => {
      const re = ${REJECT.toString()};
      const buttons = Array.from(document.querySelectorAll('button, tp-yt-paper-button, ytd-button-renderer a, [role="button"]'));
      return buttons.find((b) => re.test((b.getAttribute('aria-label') || b.textContent || '').replace(/\\s+/g, ' ').trim())) || null;
    })()`);
    const el = handle.asElement();
    if (!el) {
      await handle.dispose();
      return i === 0 ? null : 'rejected';
    }
    const label = (await page.evaluate('(el) => (el.getAttribute("aria-label") || el.textContent || "").trim()', el as never)) as unknown;
    log(`consent dialog: clicking "${String(label).slice(0, 40)}"`);
    await (el as any).click();
    await handle.dispose();
    await sleep(2500);
  }
  return 'rejected';
}

async function botCheck(page: Page): Promise<boolean> {
  return (await page.evaluate(`/not a bot|confirm you.re not a bot|unusual traffic/i.test(document.body ? document.body.innerText.slice(0, 5000) : '')`)) as boolean;
}

/**
 * Opens the watch page at `t`, answers the consent dialog, waits for the player, any pre-roll ad and the
 * first frame at `t`, and pauses there. In an automated browser YouTube serves only the first stretch of
 * video after a page load (about 20–40 s from `t`); seeks further away never finish, so every moment
 * the check needs is opened with its own page load (seekAndPause reports a seek that hangs).
 */
export async function openVideo(page: Page, videoId: string, t: number, log: Log): Promise<{ autoQuality: string; autoHeight: number }> {
  const url = `https://www.youtube.com/watch?v=${videoId}&t=${Math.max(0, Math.floor(t))}s`;
  await page.bringToFront();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sleep(1500);
  await handleConsent(page, log);
  if (!page.url().includes('youtube.com/watch')) {
    log(`after consent the page is ${page.url()}; reloading the video`);
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
  await page.bringToFront();
  await page.evaluate(`(() => { const p = document.getElementById('movie_player'); try { p.mute(); } catch (e) {} })()`);
  await dismissPopups(page, log);
  await waitForAds(page, log);
  // The first frame at t (the video starts playing on its own).
  try {
    await page.waitForFunction(`(() => { const v = document.querySelector('#movie_player video'); return !!v && v.readyState >= 2 && v.videoWidth > 0 && !v.seeking; })()`, { timeout: 45000 });
  } catch {
    throw new Error(`the video never showed a frame (${await page.evaluate("JSON.stringify((() => { const v = document.querySelector('#movie_player video'); return v && { rs: v.readyState, t: v.currentTime, w: v.videoWidth }; })())")})`);
  }
  const auto = (await page.evaluate(`(() => { const p = document.getElementById('movie_player'); const v = p.querySelector('video'); try { p.pauseVideo(); } catch (e) {} return { autoQuality: p.getPlaybackQuality(), autoHeight: v.videoHeight }; })()`)) as {
    autoQuality: string;
    autoHeight: number;
  };
  return auto;
}

/** "YouTube Premium" and similar promos that cover the page. */
export async function dismissPopups(page: Page, log: Log): Promise<void> {
  const clicked = (await page.evaluate(`(() => {
    const re = /^(no thanks|not now|dismiss|skip trial|não, obrigado|agora não)$/i;
    const out = [];
    for (const b of Array.from(document.querySelectorAll('tp-yt-paper-dialog button, ytd-popup-container button, ytd-mealbar-promo-renderer button, yt-mealbar-promo-renderer button'))) {
      const text = (b.getAttribute('aria-label') || b.textContent || '').replace(/\\s+/g, ' ').trim();
      if (re.test(text) && b.offsetParent) { b.click(); out.push(text); }
    }
    return out;
  })()`)) as string[];
  if (clicked.length) log(`dismissed: ${clicked.join(', ')}`);
}

/** Whether an ad is playing in the player. */
export async function adShowing(page: Page): Promise<boolean> {
  return (await page.evaluate(
    `(() => { const p = document.getElementById('movie_player'); return !!p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')); })()`,
  )) as boolean;
}

/** Plays through ads (they only run while playing), clicking "Skip" when it shows; up to `maxMs`. */
export async function waitForAds(page: Page, log: Log, maxMs = 120000): Promise<number> {
  const start = Date.now();
  let seen = false;
  while (Date.now() - start < maxMs) {
    if (!(await adShowing(page))) {
      if (seen) log(`ad over after ${Math.round((Date.now() - start) / 1000)} s`);
      return Date.now() - start;
    }
    if (!seen) log('an ad is playing; waiting it out (skipping when possible)');
    seen = true;
    await page.evaluate(`(() => { const p = document.getElementById('movie_player'); try { if (p.getPlayerState() !== 1) p.playVideo(); } catch (e) {} })()`);
    const skip = await page.$('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, button[id^="skip-button"]');
    if (skip) {
      const visible = (await page.evaluate('(el) => !!el.offsetParent && getComputedStyle(el).opacity !== "0"', skip as never)) as boolean;
      if (visible) {
        await skip.click().catch(() => {});
        log('clicked Skip');
      }
      await skip.dispose();
    }
    await sleep(1000);
  }
  throw new Error(`an ad was still playing after ${maxMs / 1000} s`);
}

export interface QualityInfo {
  requested: string;
  available: string[];
  reported: string;
}

/** Asks the player for one quality only (setPlaybackQualityRange plus the older setPlaybackQuality). */
export async function forceQuality(page: Page, label: string): Promise<QualityInfo> {
  return (await page.evaluate(`(() => {
    const p = document.getElementById('movie_player');
    let available = [];
    try { available = p.getAvailableQualityLevels(); } catch (e) {}
    try { p.setPlaybackQualityRange(${JSON.stringify(label)}, ${JSON.stringify(label)}); } catch (e) {}
    try { p.setPlaybackQuality(${JSON.stringify(label)}); } catch (e) {}
    let reported = '';
    try { reported = p.getPlaybackQuality(); } catch (e) {}
    return { requested: ${JSON.stringify(label)}, available, reported };
  })()`)) as QualityInfo;
}

export interface SeekInfo {
  currentTime: number;
  paused: boolean;
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  quality: string;
  ms: number;
  /** The seek never finished (outside what YouTube served after the page load). */
  hung: boolean;
}

/** Seeks to `t` and pauses there, waiting for the frame (seeked, readyState ≥ 2). */
export async function seekAndPause(page: Page, t: number): Promise<SeekInfo> {
  const started = Date.now();
  const info = (await page.evaluate(`(async () => {
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
    for (let i = 0; i < 40 && (v.readyState < 2 || v.seeking); i++) await wait(100);
    try { p.pauseVideo(); } catch (e) {}
    await wait(150);
    let quality = '';
    try { quality = p.getPlaybackQuality(); } catch (e) {}
    return { currentTime: v.currentTime, paused: v.paused, readyState: v.readyState, videoWidth: v.videoWidth, videoHeight: v.videoHeight, quality, hung: v.seeking || v.readyState < 2 };
  })()`)) as Omit<SeekInfo, 'ms'>;
  return { ...info, ms: Date.now() - started };
}

/**
 * Forces `height`p and seeks to `t`, re-seeking (up to `tries` times) until the served frame is that
 * tall: after a quality change, the buffer at the new quality arrives with the next seek.
 */
export async function seekAtQuality(page: Page, t: number, height: number, log: Log, tries = 4): Promise<{ seek: SeekInfo; quality: QualityInfo }> {
  const label = QUALITY_LABEL[height] ?? 'hd1080';
  let quality = await forceQuality(page, label);
  let seek = await seekAndPause(page, t);
  for (let i = 1; i < tries && seek.videoHeight !== height; i++) {
    if (await adShowing(page)) await waitForAds(page, log);
    await sleep(1200);
    quality = await forceQuality(page, label);
    seek = await seekAndPause(page, t + (i % 2 ? 0.04 : 0));
  }
  return { seek, quality };
}

/** The current frame at its native size, as image bytes (JPEG by default; PNG for evidence). */
export async function grabFrame(page: Page, type: 'image/jpeg' | 'image/png' = 'image/jpeg'): Promise<Buffer> {
  const url = (await page.evaluate(`(() => {
    const v = document.querySelector('#movie_player video');
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL(${JSON.stringify(type)}, 0.95);
  })()`)) as string;
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
}

export interface VideoBox {
  /** The picture's box on the page (CSS px), inside any letterboxing. */
  x: number;
  y: number;
  w: number;
  h: number;
  videoWidth: number;
  videoHeight: number;
  currentTime: number;
  paused: boolean;
  viewport: { w: number; h: number; dpr: number };
  mode: 'default' | 'theater' | 'fullscreen';
  controlsHidden: boolean;
}

export async function videoBox(page: Page): Promise<VideoBox> {
  return (await page.evaluate(`(() => {
    const v = document.querySelector('#movie_player video');
    const p = document.getElementById('movie_player');
    const r = v.getBoundingClientRect();
    const cs = getComputedStyle(v);
    const n = (s) => parseFloat(s) || 0;
    const bx = r.left + n(cs.borderLeftWidth) + n(cs.paddingLeft);
    const by = r.top + n(cs.borderTopWidth) + n(cs.paddingTop);
    const bw = r.width - n(cs.borderLeftWidth) - n(cs.paddingLeft) - n(cs.borderRightWidth) - n(cs.paddingRight);
    const bh = r.height - n(cs.borderTopWidth) - n(cs.paddingTop) - n(cs.borderBottomWidth) - n(cs.paddingBottom);
    let x = bx, y = by, w = bw, h = bh;
    const fit = cs.objectFit;
    if ((fit === 'contain' || fit === 'scale-down') && v.videoWidth && v.videoHeight) {
      const s = Math.min(bw / v.videoWidth, bh / v.videoHeight, fit === 'scale-down' ? 1 : Infinity);
      w = v.videoWidth * s; h = v.videoHeight * s; x = bx + (bw - w) / 2; y = by + (bh - h) / 2;
    }
    const flexy = document.querySelector('ytd-watch-flexy');
    const mode = document.fullscreenElement ? 'fullscreen' : flexy && (flexy.hasAttribute('theater') || flexy.hasAttribute('theater-requested_')) ? 'theater' : 'default';
    return { x, y, w, h, videoWidth: v.videoWidth, videoHeight: v.videoHeight, currentTime: v.currentTime, paused: v.paused,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio }, mode, controlsHidden: p.classList.contains('ytp-autohide') };
  })()`)) as VideoBox;
}

/** Switches the page to the default view, theater mode or fullscreen, with the player's own buttons. */
export async function setMode(page: Page, mode: 'default' | 'theater' | 'fullscreen', log: Log): Promise<VideoBox> {
  let box = await videoBox(page);
  if (box.mode === mode) return box;
  if (box.mode === 'fullscreen') {
    await page.evaluate('document.exitFullscreen().catch(() => {})');
    await sleep(800);
    box = await videoBox(page);
  }
  const button = async (sel: string) => {
    // Show the controls first: the buttons don't take clicks while hidden.
    const b = await videoBox(page);
    await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2);
    await sleep(300);
    const el = await page.$(sel);
    if (!el) throw new Error(`no ${sel} on the page`);
    await el.click();
    await el.dispose();
    await sleep(1200);
  };
  if (mode === 'theater' && box.mode !== 'theater') await button('.ytp-size-button');
  if (mode === 'default' && box.mode === 'theater') await button('.ytp-size-button');
  if (mode === 'fullscreen') await button('.ytp-fullscreen-button');
  box = await videoBox(page);
  if (box.mode !== mode) log(`asked for ${mode}, the page is in ${box.mode}`);
  return box;
}

/**
 * Moves the pointer off the picture and waits for the player to hide its controls (ytp-autohide), up
 * to `maxMs`. Returns whether they hid. In fullscreen there is nowhere else to go: the pointer stays
 * still at the bottom-right corner.
 */
export async function hideControls(page: Page, maxMs = 5000): Promise<boolean> {
  const box = await videoBox(page);
  if (box.mode === 'fullscreen') await page.mouse.move(box.viewport.w - 2, 2);
  else if (box.mode === 'theater') await page.mouse.move(4, Math.min(box.viewport.h - 4, box.y + box.h + 40));
  else await page.mouse.move(Math.max(2, box.x - 12), box.y + box.h / 2);
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if ((await videoBox(page)).controlsHidden) return true;
    await sleep(250);
  }
  return false;
}

/** Shows the controls: the pointer rests on the picture's centre. */
export async function showControls(page: Page): Promise<void> {
  const box = await videoBox(page);
  await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
  await page.mouse.move(box.x + box.w / 2 + 3, box.y + box.h / 2 + 2);
  await sleep(400);
}
