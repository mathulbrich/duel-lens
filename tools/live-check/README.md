# tools/live-check: Duel Lens on real YouTube pages

A manual check of the built extension on live YouTube videos. It **needs the network**, it talks to
youtube.com, and it is **not part of CI** or `npm run release`. Run it by hand before a release, or after
a change to capture, detection, the popover or the engine.

It has two scripts:

- `run.ts` is the quantitative check. The extension scans labelled cards from the real set
  (`data/realset/set.json`) on the live videos their frames came from, the way a user would, and each
  answer is scored against the label.
- `ux.ts` is a UX walk-through. It captures screenshots and measurements of the situations a user runs
  into, for a person to look at.

## Before you run it

1. Build both extension variants into their own folders. They are E2E builds, so they carry the
   `duelLensDebug` hook that starts a scan.

   ```bash
   node build.mjs --e2e --out release/live-build                           # default: YGOPRODeck images
   node build.mjs --e2e --no-remote-images --out release/live-build-store  # --store: the crop build, the user's own crop
   ```

2. Install Puppeteer for the E2E harness (`test/e2e/package.json`). The scripts import it from
   `test/e2e/node_modules`, the same way `tools/store-shots` does.
3. Make sure the real-set frames are on this machine: `data/debug/frames/` and
   `data/debug/fullview/fv-ycsm-t26191.png`. They are local only (see `tools/realset/README.md`).

## Commands

```bash
npx tsx tools/live-check/run.ts [--store] [--limit N] [--only id,id] [--mode default|theater|fullscreen]
                                [--quality 720|480] [--no-drag] [--controls] [--headful] [--dpr N]
                                [--viewport WxH] [--name run-name]
npx tsx tools/live-check/ux.ts  [--store] [--only modes,controls,playing,dismiss,second,edges,tiny,nocards,outlines,panel,sidepanel,layout]
                                [--viewport WxH --dpr N] [--headful --real-window]
```

- The defaults match the user's machine: a 1728×1000 viewport at devicePixelRatio 2 (a 16-inch
  MacBook Pro), YouTube's default view, and the player controls hidden before each scan. `--controls`
  leaves the pointer on the picture instead, so the controls show.
- `--quality` serves that frame height instead of the one the frame was captured at.
- Fullscreen needs a real window. Headless fullscreen shrinks the page to an 800×600 "screen", so run
  `ux.ts --headful --real-window --only modes,edges,layout`.
- `ux.ts --only …` adds its results to the folder's existing `ux.json` rather than replacing it.

## What `run.ts` does for each pick

The picks are in `lib/picks.ts`: about 26 labelled cards from 8 productions, plus 4 cards from the
user's own test video (`bBbjafm1u2Q`, t=26191), which is not in the set. The script:

1. **Opens the video at the capture time.** It clicks "Reject all" on any cookie dialog, never signs in
   (the profile is throwaway), and waits out ads.
2. **Forces the captured quality** with `#movie_player.setPlaybackQualityRange` and records what
   YouTube served. It also records the quality YouTube picked by itself before that.
3. **Finds the exact moment and place of the real-set frame.** It template-matches the frame against
   the live picture (zero-mean NCC, `lib/match.ts`), whole seconds around the capture time and then
   ±0.5 s, and pauses on the best match. The NCC score is recorded. A low score means a different
   moment, such as a hand-held camera that moved.
4. **Scans.** It calls `duelLensDebug.startScan()`, waits for the outlines, and clicks the centre of the
   labelled box, mapped from frame pixels to the page through the video's box. Picks marked `drag` are
   also scanned by dragging the box.
5. **Records the result** from the closed shadow root and the service worker: the answer, the verdict
   (right, not sure, nothing, wrong, no outline, or "by eye" for unlabelled picks), the timings
   (shortcut → outlines, the detector, click → answer, the engine), and the crop.

## Output

Everything goes to `test/e2e/out/live/<run>/`: `results.json`, `log.txt` and `shots/`. The shots are
the frozen frame with its outlines, the answer, the crop, and the aligned frame. `ux.ts` writes to
`test/e2e/out/live/ux-<build>[-window]/` (`ux.json` and PNGs). That folder is gitignored.

**Real footage stays on this machine.** Nothing is uploaded, and no frame goes into a tracked folder.

## Quirks of an automated browser on YouTube

These were found on 2026-09-29 with Chrome for Testing 154.

- **YouTube stops after 20–40 s.** In an automated browser it serves only that much video from the
  point where the page loaded. Later requests stall, and a seek outside that range never finishes, in
  headless and headful mode alike. The scripts therefore load the page again for every moment they
  need (`openVideo`), and `seekAndPause` reports a seek that hangs.
- **Playback needs `--disable-audio-output`.** Without it the media clock never starts (the automated
  browser has no audio device), so a playing video never advances. Paused seeking works either way.
- **A background tab never loads its video.** The page must be the active tab. The extension's welcome
  tab takes the focus at install, so the scripts close it first (`settleInstall`).
- **Fullscreen needs `--headful --real-window`** (see Commands).
- **Keys do not behave exactly like real keys.** A key sent by Puppeteer reaches the page but not
  Chrome itself, so Esc in fullscreen closes the popover without leaving fullscreen. A real Esc may
  also leave fullscreen.
