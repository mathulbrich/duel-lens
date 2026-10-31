// Live: which <video> to follow, and the identity of the page's video.
import { contentRect } from '../capture';
import { videoContentBox, type Rect } from '../geometry';
import type { NormBox } from './gate';

/**
 * A video-normalised box in viewport pixels, through the video's content box (object-fit aware): where a tracked card
 * is on the page. Null while the video has no size yet. The card box's anchor and the outlines both use it.
 */
export function viewportRectOf(video: HTMLVideoElement, box: NormBox, view: Window = window): Rect | null {
  if (!video.videoWidth || !video.videoHeight) return null;
  const c = videoContentBox(contentRect(video, view), video.videoWidth, video.videoHeight, view.getComputedStyle(video).objectFit);
  return { x: c.x + box.x * c.w, y: c.y + box.y * c.h, w: box.w * c.w, h: box.h * c.h };
}

/**
 * Whether `v` is on screen (any part of its box in the viewport) with its metadata loaded. A video still buffering
 * after a seek has no decoded frame yet (readyState 1) but is the page's video: the loop waits for its frames.
 */
function eligible(v: HTMLVideoElement, view: Window): boolean {
  if (v.readyState < 1) return false;
  const r = v.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.left < view.innerWidth && r.top < view.innerHeight && r.right > 0 && r.bottom > 0;
}

/** The largest visible video with its metadata loaded, a playing one before a paused one; null when none qualifies. */
export function pickLiveVideo(doc: Document): HTMLVideoElement | null {
  const view = doc.defaultView ?? window;
  let best: HTMLVideoElement | null = null;
  let bestPlaying = false;
  let bestArea = 0;
  for (const v of Array.from(doc.querySelectorAll('video'))) {
    if (!eligible(v, view)) continue;
    const r = v.getBoundingClientRect();
    const playing = !v.paused && !v.ended;
    const area = r.width * r.height;
    if (!best || (playing && !bestPlaying) || (playing === bestPlaying && area > bestArea)) [best, bestPlaying, bestArea] = [v, playing, area];
  }
  return best;
}

/**
 * What identifies the page's video: a YouTube watch page by its video id (the page changes video without a
 * reload), any other page by its URL without the hash.
 */
export function pageKey(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  const v = url.searchParams.get('v');
  if (/(^|\.)youtube\.com$/.test(url.hostname) && url.pathname === '/watch' && v) return `yt:${v}`;
  url.hash = '';
  return url.href;
}
