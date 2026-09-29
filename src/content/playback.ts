// The video under Duel Lens (live check m1): once the frame is frozen, the videos playing on screen
// are paused, so the stream doesn't run on under the frozen frame and the popover; when Duel Lens
// closes, only the videos it paused play again (one the user had paused stays paused).

/** Pauses every video playing on screen, and returns them. */
export function pausePlaying(doc: Document = document): HTMLVideoElement[] {
  const view = doc.defaultView ?? window;
  const paused: HTMLVideoElement[] = [];
  for (const video of Array.from(doc.querySelectorAll('video'))) {
    if (video.paused || video.ended) continue;
    const r = video.getBoundingClientRect();
    const onScreen = r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < view.innerWidth && r.top < view.innerHeight;
    if (!onScreen) continue;
    video.pause();
    paused.push(video);
  }
  return paused;
}

/** Plays again the videos Duel Lens paused, when they are still on the page and still paused. */
export function resume(videos: HTMLVideoElement[]): void {
  for (const video of videos) {
    if (!video.isConnected || !video.paused) continue;
    try {
      video.play()?.catch(() => undefined); // refused (autoplay rules): the user can press play
    } catch {
      // Not playable any more.
    }
  }
}
