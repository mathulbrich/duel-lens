# Duel Lens

A Chrome extension: press **Alt+Shift+Y**, click any Yu-Gi-Oh! card on screen (a YouTube duel, a stream, a screenshot, a deck list) or draw a box around it, and read the card right there. Everything runs on your computer. An optional AI check sends the crop to Claude only when the match is unsure and you've turned it on.

- Design study (mockups and research): https://claude.ai/artifact/GyYh8rePhF38biGVKLz3cP
- Spec: `docs/superpowers/specs/2026-09-28-duel-lens-design.md`
- Plan: `docs/superpowers/plans/2026-09-28-duel-lens-v1.md`

## Install (personal use)

```bash
npm install
# the build needs both models in extension/models/ (see "Models"): dinov2-small-duel.q8.onnx and detector/card-detector.onnx
node build.mjs                  # builds dist/ (node build.mjs --no-detector: without the card detector, drag only)
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `dist/` folder.
3. Pin the Duel Lens icon if you like.
4. Optional: change the shortcuts at `chrome://extensions/shortcuts`.

After rebuilding, click the reload icon on the extension's card in `chrome://extensions`.

## Use it

| Action | How |
|---|---|
| Scan a card | **Alt+Shift+Y** (or click the toolbar icon). The frame freezes and, after a moment ("Finding cards…"), every card on it gets a thin gold outline: point at one to light it up, click it to read it. A tilted or sideways card is outlined as it lies, so there is nothing to frame. |
| Scan by drawing a box | Drag a box around the card instead; the artwork alone is enough. Or click two opposite corners: a click beside the cards (where there's nothing to pick) sets the first corner, and the next click, anywhere, finishes the box. Dragging always works: before the outlines appear, over an outline, and for a card that has none. |
| Pick a card from the keyboard | **Tab** / **Shift+Tab** or the arrow keys step through the outlined cards; **Enter** reads the one in focus. |
| Close | **Esc**, or click outside the popover. On the frozen frame: **Esc** or a right-click closes it, except that with a first corner already set (above), **Esc** or a click back on that corner drops the corner first. |
| Other matches | **←** / **→**, or click a "Not it?" chip |
| Copy the card text | **C** |
| Keep the card in the side panel | **K**, or **Alt+Shift+U** to open the panel |
| AI check (optional) | Options → turn on the AI check and paste your Claude API key. "Ask AI" then appears when a match is unsure. |

While the popover is open, K, C and the arrow keys are captured, so YouTube doesn't pause, toggle captions or seek.

Any video playing on the page pauses for as long as Duel Lens is open (the frozen frame is a picture of the moment you pressed the shortcut) and plays again once you close it, unless you had already paused it yourself. Clicking outside the popover closes it and still reaches the page — except on the video itself, where the click only closes the popover.

The outlines come from Duel Lens's own card detector, which finds every face-up card on the frozen frame in one pass. Face-down cards, piles and sleeves are not outlined: there is nothing to read on them. A card it misses can still be dragged. A build made with `--no-detector` has no outlines: the hint says "Drag a box around a card", and you drag as before.

## How it works

- **Background service worker** (`src/background`): the shortcut grants `activeTab`. The worker hides any old popover (`prepare-capture`), takes a screenshot of the tab, injects the content script, and routes messages. It also keeps:
  - the card data (IndexedDB, re-checked weekly)
  - the card image cache
  - scan history
  - the AI client
- **Content script** (`src/content`): a frozen-frame selection layer and the popover. They live in a closed shadow root in the browser's top layer, so they also show over fullscreen video. When the box is over a `<video>`, the crop comes from the video frame at native resolution.
- **Offscreen document** (`src/offscreen`), one queued scan at a time:
  1. Find the card. The card detector (the one that outlines the cards for click to scan) looks at the crop; the engine takes the card inside your box, or the one you clicked, preferring a face-up card over a face-down one, and straightens it by its 4 corners, so a card seen by a tilted camera comes out square. Its outline is first fitted to the card's edges (`src/offscreen/detector/refine.ts`), and the card is also straightened from that outline's box and from the box grown by 8%. When the detector finds no card there, or the build has none (`--no-detector`), the engine reads your box as drawn.
  2. Cut out the artwork: the straightened card's art box, in each view, when the detector found a face-up card; otherwise your box as a whole card or the artwork alone (a face-down pick is read both ways, and the model decides). Upside-down readings are tried only when the upright ones aren't sure.
  3. Embed the artwork with ONNX Runtime Web (WASM).
  4. Search the bundled int8 index of about 15k artworks.
- **Models:** only our own. The embedding model is `dinov2-small-duel` (25.7 MB, 8-bit weights), our fine-tune of DINOv2 ViT-S/14 for duel video, set in `src/shared/models.ts`; the card detector is `card-detector` (6.2 MB), on a MobileNetV3-Large backbone, in `src/offscreen/detector/` (see "Models"). An earlier prototype used a third-party AGPL detector and classifier; it was replaced by our own models on 2026-09-29, and none of its code or models is in this repository. OpenCV.js, which looked for a dragged card's outline until our detector took over, was removed the same day, with 17.7 MB of `offscreen.js`.

## Models

The extension ships two models, both our own: one embedding model and the card detector.

The embedding model is `DEFAULT_MODEL_ID` in `src/shared/models.ts` (`build.mjs` copies only that model and its index): **`dinov2-small-duel`**, `extension/models/dinov2-small-duel.q8.onnx` (25.7 MB).

- **Provenance:** trained locally by [`tools/train`](../tools/train/README.md), from `facebook/dinov2-small`. Each artwork's synthetic duel-video renderings are pulled onto its clean embedding. Cards released in 2026 and a random 5% of older ones were held out of training, and it finds them as well as the rest, so a new card needs only its index vector, never retraining.
- **Licence:** Apache-2.0, like its base model.
- **In git:** unlike every other model, `.gitignore` re-includes this exact file (`extension/models/dinov2-small-duel.q8.onnx`), so it's meant to be committed with the source, not left for each clone to supply. Its index (`extension/data/index-dinov2-small-duel.*`) is committed too, and matches only this exact file: SHA-256 `02d9720530ff488397ad7db66423199dbd7a406b264b866eb695cdc59c638bee`.

Until that commit exists (or on a clone made before it), get the model one of two ways:

1. **Copy it** (a minute) from a machine that has it into `extension/models/dinov2-small-duel.q8.onnx`, and check it with `shasum -a 256` against the value above.
2. **Rebuild it** with `tools/train`: follow [its README](../tools/train/README.md). It needs an Apple Silicon Mac (training runs on MPS) and Python 3.13, and takes about 3 hours: the data below (about 45 minutes, mostly artworks), then preparation, about 2 hours of training (`train.py --minutes 100`), export and quantisation. A retrained model is a different model, so rebuild its index (below) and recalibrate its thresholds on the real test set (the method is in the comment by its thresholds in `models.ts`).

**The card detector,** `extension/models/detector/card-detector.onnx` (6.2 MB): it finds every card on a screenshot, each card's 4 corners (a keystone quad under a tilted camera) and whether it lies face up or face down.

- **Provenance:** trained locally by [`tools/train-detector`](../tools/train-detector/README.md), on synthetic duel-stream frames only (rendered from the card images and artworks under `data/`; no video frame). The network is a CenterNet-style oriented-box detector of our own design on a MobileNetV3-Large backbone, fine-tuned from `timm/mobilenetv3_large_100.ra_in1k` (pretrained on ImageNet-1k, whose images have their own research terms). The detector's report: `.superpowers/sdd/2026-09-28-duel-lens-v1/detector-report.md`.
- **Licence:** Apache-2.0, like its backbone's weights (THIRD_PARTY_NOTICES.md, 2.2).
- **In git:** unlike the other models it is kept with the source (`.gitignore` re-includes it), SHA-256 `542a03b523cb1398a1b5437dae665908b3bdf61be9b30a2a52e7bcea25dce03c`. `node build.mjs` stops when it is missing (`--no-detector` builds without it: no click to scan), and `npm run release` refuses a build without it.
- **Rebuild it** with `tools/train-detector`: follow [its README](../tools/train-detector/README.md) ("Pipeline"; about 2.5 hours of training on an Apple Silicon Mac), then `final-eval.sh` installs it. The extension keeps its detections at confidence 0.4 or above (`CARD_DETECTOR.minConfidence`, `src/offscreen/detector/spec.ts`).

The embedding model's thresholds (`score` / `margin` / `floor`) are calibrated on real footage. Don't let `tools/benchmark.ts --apply` or `--write` overwrite them: the benchmark calibrates on synthetic `video`, which is too easy for this model to separate right answers from wrong ones.

The other entries in `MODELS` are benchmark candidates that don't ship: `dinov3-small-q4` (the previous default, Meta's DINOv3 licence), `dinov3-small`, `dinov2-small`, `dinov2-small-q4`, `mobileclip-s0` (research-only licence) and `mobilenetv3-large`. Fetch them with `npx tsx tools/fetch-models.ts --models <id>` (needs Python with the `onnx` package). `benchmark.ts --apply <report>` rewrites their thresholds; afterwards set `dinov3-small-q4`'s `floor` back to `0.5`, which was lowered by hand so that low-quality video shows "Not sure" with alternatives instead of "nothing found".

## Data

The card data (`extension/data/cards.json`) and the default model's index (`extension/data/index-dinov2-small-duel.*`) are already built. To rebuild them:

```bash
npx tsx tools/fetch-cards.ts                     # YGOPRODeck card data (seconds)
npx tsx tools/fetch-artworks.ts                  # ~15k artwork crops into data/artworks (~30–45 min, resumable)
npx tsx tools/fetch-card-back.ts                 # the card back, from Yugipedia
npx tsx tools/build-index.ts --model dinov2-small-duel   # needs the model (see "Models"); ~8 min
```

`fetch-cards.ts` also merges in each card's Genesys points (YGOPRODeck's `format=genesys` list). To refresh only the points, and keep the card list in step with the committed index, run `npx tsx tools/fetch-cards.ts --merge-genesys`.

The index leaves out YGOPRODeck's placeholder artworks (the card back, served as a new card's art until the real one is uploaded). The extension's self-updating index adds those cards once their art is up.

**Real test set.** Real frames from nine productions judge every recogniser: YCS Paris 2026 (two streams), World Championship 2026, WCQ Stuttgart 2026, Team Solemn Circus locals, the Houston regional (and a 720p rendition), YCS Columbus, a hand-held deck-profile close-up and DarkLaw locals (an oblique camera). They are local only, like all of `data/`: the frames are in `data/debug/frames/`, the labels in `data/realset/` (formats in [`tools/realset/README.md`](../tools/realset/README.md)):
- `set.json`: 120 labelled cards (80 identified by a person, 40 pseudo-labelled by that earlier prototype's classifier and checked against the artwork);
- `excluded.json`: 32 detections left out (hands, sleeves, cards too small to identify);
- `negatives.json`: 70 boxes around things that are not a face-up card (deck piles, sleeves, empty zones, artwork printed on the mat).

```bash
npx tsx tools/eval-real.ts --recognizer engine --negatives data/realset/negatives.json   # the extension's engine, with its card detector
npx tsx tools/eval-real.ts --recognizer engine --no-detector --negatives data/realset/negatives.json   # as a --no-detector build
npx tsx tools/train/eval-synth.ts --models dinov2-small-duel --n 300      # synthetic levels, seen vs unseen cards
npx tsx tools/benchmark.ts --n 1000 --seed 1 --web                        # every candidate model, synthetic levels
```

`eval-real.ts` reports each production and each label source separately, and writes `data/realset/results-engine-<model>.json`. Add `--raw` to record every row's scores before any threshold, for calibration.

Data sources and their rules:
- **YGOPRODeck API:** at most 20 requests per second (the tools use 8). Download the data and images once and keep them.
- **Yugipedia:** at most 1 request per second, with a descriptive User-Agent.

## Tests

```bash
npm test                          # unit tests (Vitest)
npx tsc --noEmit                  # type check
npx tsx test/e2e/run.ts           # end-to-end: headless Chrome for Testing + the extension on a board of real cards
```

The end-to-end harness builds `dist-e2e/`, a test-only build that adds the `<all_urls>` permission because automation can't press the shortcut. It has its own Puppeteer install in `test/e2e/` (run `npm install` there once) and needs the card images in `test/fixtures/cards/`.

**Click to scan:** `npx tsx test/e2e/run.ts --click` clicks each fixture card's outline instead of dragging, and `--real --click` clicks the centre of every real-set box (a click that lands on no outline is a miss for a card and a pass for a negative). Both report shortcut → outlines and click → popover times. `--fake-detect` feeds fake outlines, to test the click UI on its own. A build without a card detector (`--no-detector`) makes them print SKIPPED and exit 0.

**The crop build's image mode:** `npx tsx test/e2e/run.ts --store-images` builds and drives the crop build (`build.mjs --no-remote-images`) on the board: each popover must show the user's own crop, the service worker must request nothing from `images.ygoprodeck.com`, and every scan must keep its small picture for the side panel.

**Retina/HiDPI:** `--dpr=N` (the board only) runs the browser at devicePixelRatio N, checked on the first card, so the capture → outline → crop chain is tested at scale too.

**Real footage:** `npx tsx test/e2e/run.ts --real [--limit N] [--only cards|negatives] [--compare FILE|none]` shows each frame of the real test set (see "Data") at 1:1 and devicePixelRatio 1, drags the extension's selection over every box, and reads the popover. A card passes when the popover's top card is right (sure or "Not sure") and no sure answer is wrong; a negative passes unless the popover is sure of a card. It compares each row with `tools/eval-real.ts`'s results file (default `data/realset/results-engine-dinov2-small-duel.json`, so run the engine eval first) and writes `test/e2e/out/real-results.json`.

## Before publishing to the Chrome Web Store

- **Licences:** the shipped embedder (`dinov2-small-duel`) is Apache-2.0, from `facebook/dinov2-small`, and the card detector is Apache-2.0, from timm's MobileNetV3-Large weights: include the licence and the attributions (`THIRD_PARTY_NOTICES.md` does, and every build carries it). The other candidate models (DINOv3 under Meta's licence, research-only MobileCLIP) don't ship, and neither does OpenCV.js or the earlier prototype's AGPL code or models (`npm run release` refuses a build with any).
- **Images:** DONE (decision D2, 2026-09-29). Every build, the store build included, fetches YGOPRODeck's official card images and artwork from the user's own browser — once per image, then cached — rather than re-hosting them. The manifest asks for host access to `images.ygoprodeck.com`, since it sends no CORS headers. `node build.mjs --no-remote-images` builds the older, text-only crop variant instead (the user's own selection as the picture, no host permission), kept as a one-flag rollback.
- **Test build:** remove the E2E-only `<all_urls>` build. The store build must stay limited to `activeTab` plus the `images.ygoprodeck.com` host permission, as a plain `node build.mjs` produces today.

Yu-Gi-Oh! card names, text and images belong to Konami. This is an unofficial personal project.
