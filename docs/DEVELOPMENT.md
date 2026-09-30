# Duel Lens

A Chrome extension: press **Alt+Shift+Y**, point at any Yu-Gi-Oh! card on screen (a YouTube duel, a stream, a screenshot, a deck list) for a quick preview, click it or draw a box around it, and read the card right there; scan mode stays open until you leave it. Everything runs on your computer. An optional AI check sends the crop to Claude only when the match is unsure and you've turned it on.

- Design study (mockups and research): https://claude.ai/artifact/GyYh8rePhF38biGVKLz3cP
- Spec: `docs/superpowers/specs/2026-09-28-duel-lens-design.md`
- Plan: `docs/superpowers/plans/2026-09-28-duel-lens-v1.md`

## Install (personal use)

```bash
npm install
# the build needs both models in extension/models/ (see "Models"): dinov2-small-duel-v3b.q8.onnx and detector/card-detector.onnx
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
| Scan a card | **Alt+Shift+Y** (or click the toolbar icon). The frame freezes and, after a moment ("Finding cards…"), every card on it gets a thin gold outline, and a bar at the top of the viewport counts them ("Duel Lens · N cards · Esc to exit", with a ✕). Point at a card to light it up, click it to read it. A tilted or sideways card is outlined as it lies, so there is nothing to frame. |
| Read the next card | Scan mode stays open after a read: the frozen frame, every outline and the bar stay, and the card just read is marked as the current one. Click another outline (or drag, or set two corners) and its popover replaces the first. Every read goes to the history. |
| Preview on hover | Options → **Show card details**: **Hover or click** (the default) or **Click**. With Hover or click, resting the pointer on an outline for about 250 ms, or focusing it, shows a compact preview beside it: the name, the type line, ATK/DEF and the banlist and Genesys chips, no picture and no buttons ("Not sure: <name>", "Low match: click for options", "No match: click to try" when unsure). Esc hides it; the pointer can move onto it; a click opens the full popover. A preview records nothing: no history entry, no correction, never the AI. Click mode shows no preview. |
| Scan by drawing a box | Drag a box around the card instead; the artwork alone is enough. Or click two opposite corners: a click beside the cards (where there's nothing to pick) sets the first corner, and the next click, anywhere, finishes the box. Dragging always works: before the outlines appear, over an outline, and for a card that has none. While a popover is open, a click on an empty area only closes it (no corner). |
| Pick a card from the keyboard | **Tab** / **Shift+Tab** or the arrow keys step through the outlined cards; the one in focus shows its preview (Hover or click); **Enter** reads it. |
| Close a card | **Esc**, the popover's **×** ("Close card details") or a click on an empty area of the frozen frame closes the popover; the outlines stay, and focus goes back to that card's outline. With a first corner set (above), **Esc** or a click back on that corner drops the corner first. |
| Leave scan mode | **Esc** with no popover open, the bar's **✕** ("Exit Duel Lens"), a right-click on the frozen frame, or the shortcut or toolbar icon again (no new capture). **Space** or **K** resumes the video: it leaves and plays the videos Duel Lens paused. A resize (other than the side panel opening after S) or a fullscreen change leaves too. |
| Other matches | **←** / **→**, or click a "Not it?" chip |
| Copy the card text | **C** |
| Keep the card in the side panel | **S**, or **Alt+Shift+U** to open the panel. Scan mode stays open: the page's resize as the panel opens after S doesn't count as a reason to leave. With the panel open, every read card becomes its card; a preview doesn't |
| AI check (optional) | Options → turn on the AI check and paste your Claude API key. "Ask AI" then appears in the popover when a match is unsure (never in a preview). |

While scan mode is open, Duel Lens takes its keys from the page (a capture-phase listener, `src/content/keys.ts`), so YouTube doesn't toggle captions, seek or change its layout underneath. Space and K, YouTube's play/pause keys, leave scan mode and resume the video; YouTube never sees them, so it doesn't toggle playback a second time.

Any video playing on the page pauses for as long as scan mode is open (the frozen frame is a picture of the moment you pressed the shortcut) and plays again when you leave, unless you had already paused it yourself: Duel Lens resumes only the videos it paused. The frozen frame stays up for the whole session, so no click reaches the page underneath.

The outlines come from Duel Lens's own card detector, which finds every face-up card on the frozen frame in one pass. Face-down cards, piles and sleeves are not outlined: there is nothing to read on them. A card it misses can still be dragged. A build made with `--no-detector` has no outlines: the hint says "Drag a box around a card", and you drag as before.

## How it works

- **Background service worker** (`src/background`): the shortcut grants `activeTab`. The worker first sends `prepare-capture`: the content script hides its UI and answers `{ ok: true }`, or, while scan mode is open, leaves it and answers `{ ok: true, closed: true }`, and then nothing is captured (so the shortcut and the toolbar icon toggle scan mode off). Otherwise the worker takes a screenshot of the tab, injects the content script, sends `begin-selection` with the screenshot and `reveal` (`Settings.display.reveal`: `'hover'` by default, or `'click'`), and routes messages. A `recognize` with `record: false` is a hover peek: the answer comes back without a history entry (no `entry`), and with no correction, no saved crops, no image prefetch and never the AI. It also keeps:
  - the card data (IndexedDB, re-checked weekly)
  - the card image cache
  - scan history
  - the AI client
- **Content script** (`src/content`): a frozen-frame selection layer and the popover. They live in a closed shadow root in the browser's top layer, so they also show over fullscreen video. When the box is over a `<video>`, the crop comes from the video frame at native resolution.
  - **Scan mode** lasts from the shortcut until the user leaves: the frozen frame, the outlines and the bar stay mounted, and each read (a click, Enter, a drag, two corners) goes `selecting → scanning → result`, back to `selecting` when its popover closes. Leaving (Esc with nothing else open, the bar's ✕, a right-click, Space or K, the shortcut again, a resize or a fullscreen change; not the resize of the side panel opening after S) unmounts it all and resumes only the videos Duel Lens paused (`playback.ts`).
  - **Hover previews** (`reveal: 'hover'`): the pointer resting on an outline for about 250 ms, or focus on it, sends one peek at a time (the latest wins; one that comes back after the pointer moved on is dropped) and caches its answer per outline for the session. The compact preview follows WCAG 1.4.13: Esc dismisses it, the pointer can move onto it, and it stays until the pointer or focus leaves. A click on a previewed card shows the cached answer at once and sends `recognize` with `record: true` in the background for its history entry, which is attached when it comes.
- **Offscreen document** (`src/offscreen`), one queued scan at a time:
  1. Find the card. The card detector (the one that outlines the cards for click to scan) looks at the crop; the engine takes the card inside your box, or the one you clicked, preferring a face-up card over a face-down one, and straightens it by its 4 corners, so a card seen by a tilted camera comes out square. Its outline is first fitted to the card's edges (`src/offscreen/detector/refine.ts`), and the card is also straightened from that outline's box and from the box grown by 8%. When the detector finds no card there, or the build has none (`--no-detector`), the engine reads your box as drawn. A click also searches its own crop again (`CLICK_REDETECT` in `engine.ts`): a card found there replaces the outline only when it holds the clicked point, overlaps the outline by IoU 0.5 or more and lies more than 20° apart from it, and the crop doesn't also show the outline's own card. That reads the top card of a stack whose single outline came out tilted the wrong way. For a drag, a weak detection that fits your box much better than the card picked (`COVERED`) caps the answer at "Not sure": the box was drawn around a card lying under another (`.superpowers/sdd/2026-09-28-duel-lens-v1/click-stack-report.md`).
  2. Cut out the artwork: the straightened card's art box, in each view, when the detector found a face-up card; otherwise your box as a whole card or the artwork alone (a face-down pick is read both ways, and the model decides). Upside-down readings are tried only when the upright ones aren't sure.
  3. Embed the artwork with ONNX Runtime Web (WASM).
  4. Search the bundled int8 index of about 15k artworks (YGOPRODeck's, plus Konami's for the artworks YGOPRODeck lacks: see "Data").
- **Models:** only our own. The embedding model is `dinov2-small-duel-v3b` (25.7 MB, 8-bit weights), our fine-tune of DINOv2 ViT-S/14 for duel video, set in `src/shared/models.ts`; the card detector is `card-detector` (6.2 MB), on a MobileNetV3-Large backbone, in `src/offscreen/detector/` (see "Models"). An earlier prototype used a third-party AGPL detector and classifier; it was replaced by our own models on 2026-09-29, and none of its code or models is in this repository. OpenCV.js, which looked for a dragged card's outline until our detector took over, was removed the same day, with 17.7 MB of `offscreen.js`.

## Models

The extension ships two models, both our own: one embedding model and the card detector.

The embedding model is `DEFAULT_MODEL_ID` in `src/shared/models.ts` (`build.mjs` copies only that model and its index): **`dinov2-small-duel-v3b`**, `extension/models/dinov2-small-duel-v3b.q8.onnx` (25.7 MB), the default since 2026-09-30. It replaced `dinov2-small-duel` (`extension/models/dinov2-small-duel.q8.onnx`, SHA-256 `02d9720530ff488397ad7db66423199dbd7a406b264b866eb695cdc59c638bee`), which stays registered and committed.

- **Provenance:** trained locally by [`tools/train`](../tools/train/README.md), from `facebook/dinov2-small`, in two stages.
  - `dinov2-small-duel` (run r2): each artwork's synthetic duel-video renderings are pulled onto its clean embedding. Cards released in 2026 and a random 5% of older ones were held out of training, and it finds them as well as the rest, so a new card needs only its index vector, never retraining.
  - `dinov2-small-duel-v3b` (runs r6-real and r6-real-b): `dinov2-small-duel` further fine-tuned on real card crops from 51 public tournament videos (15,167 card tracks, 68,632 crops, 2026-09-30), next to the synthetic renderings, with `dinov2-small-duel` as a frozen teacher on clean artwork. The crops are cards only: each is one card cut tightly from a frame, the frames themselves were never saved, and crops showing people were removed. The recipe and its numbers: `.superpowers/sdd/2026-09-28-duel-lens-v1/overnight-plan.md` and `overnight-p5-report.md`. The crops stay on the machine that made them (`data/overnight/`, not in git).
- **Licence:** Apache-2.0, like its base model.
- **In git:** unlike every other model, `.gitignore` re-includes this exact file (`extension/models/dinov2-small-duel-v3b.q8.onnx`), so it's meant to be committed with the source, not left for each clone to supply. Its index (`extension/data/index-dinov2-small-duel-v3b.*`) is committed too, and matches only this exact file: SHA-256 `4be9cf627538cbf5a352872670404cf81fca93ddcee7e039bfb5a110035936c9`.

Until that commit exists (or on a clone made before it), get the model one of two ways:

1. **Copy it** (a minute) from a machine that has it into `extension/models/dinov2-small-duel-v3b.q8.onnx`, and check it with `shasum -a 256` against the value above.
2. **Rebuild it** with `tools/train`: follow [its README](../tools/train/README.md). It needs an Apple Silicon Mac (training runs on MPS) and Python 3.13, and takes about 3 hours: the data below (about 45 minutes, mostly artworks), then preparation, about 2 hours of training (`train.py --minutes 100`), export and quantisation. That rebuilds `dinov2-small-duel`; `dinov2-small-duel-v3b`'s second stage also needs the real card crops, which aren't in git, so a clone can't rebuild it exactly. A retrained model is a different model, so rebuild its index (below) and recalibrate its thresholds on the real test set (the method is in the comment by its thresholds in `models.ts`).

**The card detector,** `extension/models/detector/card-detector.onnx` (6.2 MB): it finds every card on a screenshot, each card's 4 corners (a keystone quad under a tilted camera) and whether it lies face up or face down.

- **Provenance:** trained locally by [`tools/train-detector`](../tools/train-detector/README.md), on synthetic duel-stream frames only (rendered from the card images and artworks under `data/`; no video frame). The network is a CenterNet-style oriented-box detector of our own design on a MobileNetV3-Large backbone, fine-tuned from `timm/mobilenetv3_large_100.ra_in1k` (pretrained on ImageNet-1k, whose images have their own research terms). The detector's report: `.superpowers/sdd/2026-09-28-duel-lens-v1/detector-report.md`.
- **Licence:** Apache-2.0, like its backbone's weights (THIRD_PARTY_NOTICES.md, 2.2).
- **In git:** unlike the other models it is kept with the source (`.gitignore` re-includes it), SHA-256 `542a03b523cb1398a1b5437dae665908b3bdf61be9b30a2a52e7bcea25dce03c`. `node build.mjs` stops when it is missing (`--no-detector` builds without it: no click to scan), and `npm run release` refuses a build without it.
- **Rebuild it** with `tools/train-detector`: follow [its README](../tools/train-detector/README.md) ("Pipeline"; about 2.5 hours of training on an Apple Silicon Mac), then `final-eval.sh` installs it. The extension keeps its detections at confidence 0.4 or above (`CARD_DETECTOR.minConfidence`, `src/offscreen/detector/spec.ts`).

The embedding model's thresholds (`score` / `margin` / `floor`) are calibrated on real footage. Don't let `tools/benchmark.ts --apply` or `--write` overwrite them: the benchmark calibrates on synthetic `video`, which is too easy for this model to separate right answers from wrong ones.

The other entries in `MODELS` are benchmark candidates that don't ship: `dinov3-small-q4` (the previous default, Meta's DINOv3 licence), `dinov3-small`, `dinov2-small`, `dinov2-small-q4`, `mobileclip-s0` (research-only licence) and `mobilenetv3-large`. Fetch them with `npx tsx tools/fetch-models.ts --models <id>` (needs Python with the `onnx` package). `benchmark.ts --apply <report>` rewrites their thresholds; afterwards set `dinov3-small-q4`'s `floor` back to `0.5`, which was lowered by hand so that low-quality video shows "Not sure" with alternatives instead of "nothing found".

## Data

The card data (`extension/data/cards.json`) and the default model's index (`extension/data/index-dinov2-small-duel-v3b.*`) are already built. To rebuild them:

```bash
npx tsx tools/fetch-cards.ts                     # YGOPRODeck card data (seconds)
npx tsx tools/fetch-artworks.ts                  # ~15k artwork crops into data/artworks (~30–45 min, resumable)
npx tsx tools/fetch-card-back.ts                 # the card back, from Yugipedia
npx tsx tools/build-index.ts --model dinov2-small-duel-v3b   # needs the model (see "Models"); ~8 min
```

`fetch-cards.ts` also merges in each card's Genesys points (YGOPRODeck's `format=genesys` list). To refresh only the points, and keep the card list in step with the committed index, run `npx tsx tools/fetch-cards.ts --merge-genesys`.

The index leaves out YGOPRODeck's placeholder artworks (the card back, served as a new card's art until the real one is uploaded). The extension's self-updating index adds those cards once their art is up.

**Artworks YGOPRODeck lacks.** Some cards have more official artworks than YGOPRODeck has images (Artemis, the Magistus Moon Maiden's second artwork, Ash Blossom's third…). Both committed indexes (`dinov2-small-duel-v3b` and `dinov2-small-duel`) also hold vectors of those artworks, computed from Konami's own card renders as mirrored by ygoresources (`data/raw/ygoresources-artworks-manifest.json`). Build time only: the renders stay in `data/alt-artworks/` (not in git), no picture ships, and the extension never contacts ygoresources. At runtime a match on one of them shows the card's own YGOPRODeck image (`src/shared/alt-artwork.ts`).

```bash
npx tsx tools/fetch-alt-artworks.ts               # Konami's renders into data/alt-artworks (1 request/s, ~12 min, resumable; --all: OCG-only artworks too)
npx tsx tools/add-alt-artworks.ts --models dinov2-small-duel-v3b,dinov2-small-duel   # decides which are missing, appends them to both indexes
```

- **Which cards:** those whose Konami artworks (Rush Duel prints aside) outnumber their YGOPRODeck images. By default only the artworks printed in the TCG are fetched. The renders are the clean Neuron ones, never the watermarked "SAMPLE" copies; the English render first, else the Japanese one of the same artwork.
- **Which artworks are missing** is decided by similarity, not by artwork number: each render's art box is cut as `fetch-artworks.ts` cuts a full card image, embedded, and compared with its card's YGOPRODeck vectors (with the default model). An artwork at cosine 0.95 or more to one of them is that image: covered. Below that, a YGOPRODeck image covers only the one Konami artwork closest to it, at 0.85 or more (the same image, scanned differently or rendered with a blank Pendulum box): the card's other versions of it, such as a TCG print with an edited detail or a recoloured print, are prints YGOPRODeck lacks. Then:
  - **Near-duplicates within a card:** missing artworks of one card linked at 0.95 or more, directly or through another, keep one per group (the lowest artwork number).
  - **Shared with another card:** a missing artwork at 0.95 or more to another card's YGOPRODeck image is left out.
  - **Look-alikes across cards:** missing artworks of different cards at 0.95 or more to each other stop the run, unless `LOOKALIKES_KEPT` in `tools/add-alt-artworks.ts` lists their cards, with why. Keeping only one of such a group would make the other cards' prints read as it, confidently. Today it lists one group: the TCG prints of Spirit Message "I", "N", "A", "L" and Destiny Board.
  - The decisions and every score go to `data/alt-artworks/report.json`.
- **The extras** come after every YGOPRODeck entry, with synthetic image ids (`-(konamiId × 100 + artwork)`: negative, so never a YGOPRODeck id) and their provenance in the `.meta.json` (`source: "konami"`, `konamiId`, `artwork`; the summary in `altArtworks`). The tool keeps every other vector and entry byte for byte (it prints the hashes), and `builtAt` and `dbVersion` too. It prints the extras it adds and removes against each index, and a run with nothing new changes no byte.
- **Missing renders stop it.** When an artwork in scope has no usable render (not fetched, or not a whole card), or an index holds extras outside the run's scope (made with `--all`), `add-alt-artworks.ts` writes nothing and exits 1. `--allow-missing` writes anyway, without those extras.
- **The manifest** (`data/raw/ygoresources-artworks-manifest.json`, 21.5 MB) is ygoresources' index of Konami's card renders, `https://artworks.ygoresources.com/manifest.json`. It is keyed by Konami card id, then artwork number, with the render paths per language. The copy in `data/raw/` was downloaded on 2026-09-28 (the server's Last-Modified: 2026-09-28 09:01 GMT). To refresh it, download it once, then run both commands:

  ```bash
  curl -fsS -A 'DuelLens/0.1 (personal project; +https://github.com/mathulbrich/duel-lens)' \
    -o data/raw/ygoresources-artworks-manifest.json.part https://artworks.ygoresources.com/manifest.json \
    && mv data/raw/ygoresources-artworks-manifest.json.part data/raw/ygoresources-artworks-manifest.json
  ```
- **Refresh the extras** (a new manifest, new cards): run both commands again. The fetch skips the renders it has; `add-alt-artworks.ts` replaces the extras. The committed-index test (`tools/lib/alt-artworks.test.ts`) pins their count: update it with the refresh, on purpose.
- **After a full `build-index.ts` rebuild,** run `add-alt-artworks.ts` again: `build-index.ts` writes YGOPRODeck's artworks only, and warns when the index it overwrites held extras.
- **The self-updating index** only ever asks about and downloads YGOPRODeck ids; it keeps the extras, and never fetches them.

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
- **ygoresources** (a fan site that mirrors Konami's official card data and card renders): build time only, at most 1 request per second, one at a time, with a descriptive User-Agent; download each render once and keep it.

## Tests

```bash
npm test                          # unit tests (Vitest)
npx tsc --noEmit                  # type check
npx tsx test/e2e/run.ts           # end-to-end: headless Chrome for Testing + the extension on a board of real cards
```

The end-to-end harness builds `dist-e2e/`, a test-only build that adds the `<all_urls>` permission because automation can't press the shortcut. It has its own Puppeteer install in `test/e2e/` (run `npm install` there once) and needs the card images in `test/fixtures/cards/`.

**Click to scan:** `npx tsx test/e2e/run.ts --click` clicks each fixture card's outline instead of dragging, and `--real --click` clicks the centre of every real-set box (a click that lands on no outline is a miss for a card and a pass for a negative). Both report shortcut → outlines and click → popover times. `--fake-detect` feeds fake outlines, to test the click UI on its own. A build without a card detector (`--no-detector`) makes them print SKIPPED and exit 0.

**Scan mode and hover previews:** the board run also drives the session flows. Scan mode staying open: a click on one card shows its popover, a click on a second card replaces it, Esc closes the popover, a second Esc leaves, and the video plays again. A hover preview: the preview shows, the pointer moves onto it, Esc hides it, a hover shows it again, and a click pins the card, after which the history holds exactly one entry. The **Click** setting: no preview shows. The same a11y checks (focus, no shadow-root leak) run on each.

**The crop build's image mode:** `npx tsx test/e2e/run.ts --store-images` builds and drives the crop build (`build.mjs --no-remote-images`) on the board: each popover must show the user's own crop, the service worker must request nothing from `images.ygoprodeck.com`, and every scan must keep its small picture for the side panel.

**Retina/HiDPI:** `--dpr=N` (the board only) runs the browser at devicePixelRatio N, checked on the first card, so the capture → outline → crop chain is tested at scale too.

**Real footage:** `npx tsx test/e2e/run.ts --real [--limit N] [--only cards|negatives] [--compare FILE|none]` shows each frame of the real test set (see "Data") at 1:1 and devicePixelRatio 1, drags the extension's selection over every box, and reads the popover. A card passes when the popover's top card is right (sure or "Not sure") and no sure answer is wrong; a negative passes unless the popover is sure of a card. It compares each row with `tools/eval-real.ts`'s results file (default `data/realset/results-engine-<DEFAULT_MODEL_ID>.json`, today `results-engine-dinov2-small-duel-v3b.json`, so run the engine eval first) and writes `test/e2e/out/real-results.json`.

## Before publishing to the Chrome Web Store

- **Licences:** the shipped embedder (`dinov2-small-duel-v3b`) is Apache-2.0, from `facebook/dinov2-small`, and the card detector is Apache-2.0, from timm's MobileNetV3-Large weights: include the licence and the attributions (`THIRD_PARTY_NOTICES.md` does, and every build carries it). The other candidate models (DINOv3 under Meta's licence, research-only MobileCLIP) don't ship, and neither does OpenCV.js or the earlier prototype's AGPL code or models (`npm run release` refuses a build with any).
- **Images:** DONE (decision D2, 2026-09-29). Every build, the store build included, fetches YGOPRODeck's official card images and artwork from the user's own browser — once per image, then cached — rather than re-hosting them. The manifest asks for host access to `images.ygoprodeck.com`, since it sends no CORS headers. `node build.mjs --no-remote-images` builds the older, text-only crop variant instead (the user's own selection as the picture, no host permission), kept as a one-flag rollback.
- **Test build:** remove the E2E-only `<all_urls>` build. The store build must stay limited to `activeTab` plus the `images.ygoprodeck.com` host permission, as a plain `node build.mjs` produces today.

Yu-Gi-Oh! card names, text and images belong to Konami. This is an unofficial personal project.
