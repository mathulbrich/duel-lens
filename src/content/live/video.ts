// Live: which <video> to follow, and the identity of the page's video.

/** Whether `v` is on screen (any part of its box in the viewport) with a decoded frame to read. */
function eligible(v: HTMLVideoElement, view: Window): boolean {
  if (v.readyState < 2) return false;
  const r = v.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.left < view.innerWidth && r.top < view.innerHeight && r.right > 0 && r.bottom > 0;
}

/** The largest visible video with a decoded frame, a playing one before a paused one; null when none qualifies. */
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
