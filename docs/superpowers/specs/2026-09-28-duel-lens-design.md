# Duel Lens: design spec

> **Historical record (2026-09-28).** This is the design as it was planned that day. Parts are superseded: the
> third-party DRAW2 detector it mentions was replaced by Duel Lens's own card detector and removed from the
> repository, and click to scan, official card images and Genesys points came later. For how Duel Lens works now,
> see [README.md](../../../README.md) and [docs/DEVELOPMENT.md](../../DEVELOPMENT.md).

Date: 2026-09-28 · Status: approved to implement ("follow your recommendations and proceed")
Design study (mockups + research): https://claude.ai/artifact/GyYh8rePhF38biGVKLz3cP

## 1. Goal and scope

A Chrome (Manifest V3) extension. The user presses a shortcut, draws a box around a Yu-Gi-Oh! card anywhere on screen, and reads the matched card (image + full text) in an overlay on the same page. Nothing opens in a new tab.

- **Primary use:** YouTube videos of duels, mostly physical cards filmed on a mat and often at low quality. Also Master Duel footage, websites and screenshots.
- **Audience:** personal use for now (load unpacked), but built so it can be published later. That means no remotely hosted code and respecting data-source policies.
- **Displays in v1:** a popover next to the selection, plus a Chrome side panel for session history. Spotlight and Pins come later.
- **AI fallback:** opt-in, off by default. It uses the user's own Claude API key and runs only when the match is unsure.
- **Out of scope for v1:**
  - Recognizing several cards in one box.
  - Rush Duel cards.
  - Card text in other languages.
  - Price data.
  - Fine-tuning the embedding model. That happens only if the benchmark shows it is needed (milestone M4).

**Success criteria**
1. On clean digital images (website or Master Duel crops), the top-1 match is right at least 95% of the time.
2. On the synthetic "bad video" benchmark, the right card is in the top 5 at least 90% of the time and first at least 75% of the time. This is the gate for choosing a model.
3. From finishing the drag to seeing the popover takes under 1 s on the developer's M4 Pro, once the model is warm.
4. No broad host permissions. Capturing the page happens only after a user gesture (`activeTab`).

## 2. Architecture

```
            shortcut (Alt+Shift+Y) / toolbar click
                          │ activeTab
┌─────────────────────────▼─────────────────────────┐
│ Background service worker                          │
│  capture tab → inject content → route messages     │
│  card store (IndexedDB) · image cache (Cache API)  │
│  history (storage.local) · AI client · alarms      │
└───────┬───────────────────────┬───────────────────┘
        │ begin-selection        │ recognize(crop)
┌───────▼────────┐      ┌────────▼──────────────────┐
│ Content script │      │ Offscreen document         │
│ frozen frame   │      │ detect card → art crops →  │
│ selection box  │      │ embed (ONNX Runtime Web) → │
│ video frame    │      │ search index → candidates  │
│ popover (UI)   │      └───────────────────────────┘
└────────────────┘      Side panel (history) · Options page
```

**Tech:**
- TypeScript, bundled with esbuild (`build.mjs`) into `dist/`.
- Preact for UI.
- Vitest for tests.
- Node tools run with `tsx`.

The same TypeScript preprocessing and search code runs in Node (index build, benchmarks) and in the extension (runtime).

### Directory ownership (for parallel work)

| Path | Owner | Contents |
|---|---|---|
| `src/shared/` | lead | Contracts: types, messages, index format, model registry, preprocessing, search, geometry, name matching |
| `tools/`, `data/` | A: data & index | Fetch card data and artworks, build the embedding index, synthetic benchmark, pick the model |
| `src/offscreen/` | B: recognition engine | Card detection, straightening, art-crop hypotheses, ORT embedding, search, confidence |
| `src/content/` | C: page UI | Frozen-frame selection, top-layer host, popover, video-frame capture, fullscreen |
| `src/background/`, `src/sidepanel/`, `src/options/` | D: extension shell | Service worker, stores, AI client, side panel, options |
| `extension/`, `build.mjs`, `package.json` | lead | Manifest, static HTML, build and dependencies |

## 3. Recognition

1. **Pixels.**
   - When the box is over a `<video>` whose frame can be read, the crop comes from that frame at native resolution. The content script draws the video into a canvas at `videoWidth × videoHeight` when the shortcut is pressed, and maps the box through the `object-fit: contain` letterbox.
   - Otherwise the crop comes from the `captureVisibleTab` PNG taken when the shortcut is pressed. Its scale is `bitmap.width / innerWidth`, which covers both devicePixelRatio and page zoom.
   - The box gets a 4% margin before cropping.
2. **Card detection** (OpenCV.js in the offscreen document):
   - Grayscale → blur → Canny → contours → 4-point polygons.
   - Keep the largest quad whose aspect ratio is card-like: 59:86 ≈ 0.686 ± 0.12, or landscape for defense position.
   - Warp it to a canonical 590×860 portrait card.
3. **Art-crop hypotheses.** Each one is also tried rotated 180°, because the opponent's cards face the other way:
   - H1: the art box of the detected card, at fixed proportions measured from YGOPRODeck full and cropped images.
   - H2: the selection treated as a whole card, if its aspect ratio is card-like, with the art box at the same fixed proportions.
   - H3: the selection treated as artwork only, as a centre square.
   - Defense-position quads try both 90° and 270°.
4. **Embedding.**
   - `preprocess.ts` works on RGBA pixels: area-average resize (squash) to the model's input size, then normalise mean/std into CHW Float32.
   - ONNX Runtime Web runs the model, WebGPU if available, otherwise WASM. Hypotheses are batched where possible.
   - Output vectors are L2-normalised.
5. **Search.**
   - Brute-force dot product against an int8 index (vectors × 127).
   - Results are grouped by card: keep the best-scoring artwork per card, so a matched alternate artwork can be shown.
   - Candidates are merged across hypotheses by max score, and the top 10 are returned.
6. **Confidence.**
   - `confident = s1 ≥ T_score && (s1 − s2) ≥ T_margin`, where s2 is the best other *card*.
   - Thresholds come from the benchmark and live in `src/shared/models.ts` per model.
7. **Special entries.** The index includes the card back (cardId −1). A face-down match gives the message "Face-down card".
8. **Fallbacks.**
   - Low confidence: alternatives lead, and "Ask AI" appears if it is enabled.
   - OCR name tie-breaker: Tesseract.js on the name strip of a straightened card of at least 250 px. Milestone M3.

**Index artefacts** (built by `tools/build-index.ts`, shipped in `extension/data/`):
- `index-<modelId>.bin`: magic `YGIX`, version 1, dim, count, quant (1 = int8), then count × dim int8 values.
- `index-<modelId>.meta.json`: `{modelId, dim, count, quant, builtAt, dbVersion, entries:[{imageId, cardId}]}`.
- `cards.json`: trimmed card records (see `CardRecord`).

**Models:**
- Candidates: MobileNetV3-S, MobileCLIP-S0 and DINOv2-small as ONNX; Agent A adds more if useful.
- The registry `src/shared/models.ts` holds each model's input size, mean/std, output name and pooling, dimension and thresholds.
- The winner of the benchmark becomes `DEFAULT_MODEL_ID`.
- Models, ORT `.wasm` and OpenCV.js are all bundled under `extension/`, with no CDN at runtime.

## 4. User interface

**Selection:**
- On the shortcut, the page freezes on the snapshot: a full-viewport screenshot is shown in a top-layer overlay, dimmed.
- The cursor becomes a crosshair and the user drags a box. `Esc` cancels.
- The overlay host is a closed shadow root on an element with `popover="manual"`, re-shown on `fullscreenchange` so it stays above fullscreen video.
- While matching, the box shows a foil sweep and the label "Matching artwork…".

**Popover:** follows the design study, as a dark overlay with a foil top edge. From top to bottom:
1. Brand row with a close button.
2. The card image (the matched artwork, fetched once and cached).
3. Name, type line, and facts: Attribute, Level / Rank / Link, ATK/DEF, TCG banlist status.
4. Effect text in a serif font. Pendulum cards show the Pendulum Effect and Monster Effect separately.
5. Passcode and archetype.
6. Match meter showing score, method and source.
7. "Not it?" with the next three matches as thumbnails.
8. Actions: *Keep in side panel*, *Copy text* and *Yugipedia ↗*, plus *Ask AI* when unsure.

- **Keys:** `Esc` closes, `K` keeps, `C` copies, `←/→` cycle alternatives.
- **Placement:** right of the box, else left, else below, clamped to the viewport.
- **Low-quality video:** a video source of 480p or lower with low confidence shows a tip: "Raise the video quality for a better match".

**Side panel:**
- The current or last card, large, with full text.
- "This session" history with thumbnails, names and times. YouTube entries link back to the moment in the video (`&t=`).
- Clear history.

**Options:**
- AI check: toggle, API key, model (default `claude-opus-5`), and a *Test* button.
- Card data version, with *Check for updates now*.
- A link to change keyboard shortcuts.
- Debug: *Save crops for a test set* and *Export test set (JSON)*.

## 5. Data

- **YGOPRODeck** `cardinfo.php?misc=yes`:
  - It is trimmed into `CardRecord`s and bundled as `extension/data/cards.json`.
  - At runtime it is loaded into IndexedDB.
  - A weekly `chrome.alarms` job calls `checkDBVer.php` and re-downloads the data only when the version changes.
  - Rate limit: at most 20 requests per second. The tools use at most 8.
- **Artwork crops** (`image_url_cropped`, 624×624) are downloaded once by the tools into `data/artworks/` (gitignored) and never bundled.
- **Display images:**
  - The background worker fetches `images.ygoprodeck.com/images/cards[_small]/<imageId>.jpg` once per image.
  - Images are cached in the Cache API and passed to pages as data URLs, because the image host sends no CORS headers.
- **Permissions:**
  - `activeTab`, `scripting`, `offscreen`, `storage`, `unlimitedStorage`, `sidePanel`, `alarms`.
  - Hosts: `https://db.ygoprodeck.com/*` and `https://images.ygoprodeck.com/*`.
  - Optional host: `https://api.anthropic.com/*`.

## 6. Errors and edge cases

- **Capture fails** (e.g. a `chrome://` page or the Web Store): the toolbar badge shows the error, with the message "Duel Lens can't read this page".
- **Video frame can't be read** (tainted or DRM): fall back to the screenshot. A DRM black frame gets a very low score, and the popover says "This video blocks screenshots".
- **Model or index fails to load:** the popover explains the error and links to the options page.
- **No card found** (s1 below the floor): "Couldn't match this. Frame the whole card, or just its artwork."
- **AI errors:** show them inline and keep the local result.
- **Missing image:** fall back to the small image, then to a text-only view.

## 7. Testing

- **Vitest units** in `src/**/*.test.ts` and `tools/**/*.test.ts`:
  - preprocess determinism
  - geometry mapping, including letterbox and DPR
  - index format round-trip
  - top-k search
  - name fuzzy matching
  - card trimming
  - message guards
  - popover placement
- **Engine test (Node):** run the recognition core with onnxruntime-node on synthetic degraded crops from real artworks. Accuracy must meet the benchmark gate.
- **Benchmark:** `tools/benchmark.ts` measures top-1 and top-5 accuracy under each degradation, per model. It also accepts a real test-set JSON exported from the extension.
- **End-to-end (M2):**
  - Puppeteer with Chrome for Testing and `--load-extension`.
  - A local page with card images, and a video if ffmpeg is available.
  - The test triggers a scan through the service worker, simulates the drag, and asserts that the popover shows the expected card.

## 8. Milestones

- **M0** (lead): scaffold, contracts, build and dependencies.
- **M1** (parallel):
  - A: data, index and benchmark
  - B: engine
  - C: content UI
  - D: extension shell
- **M2:** integrate, pick the model from the benchmark, end-to-end test, review.
- **M3:** OCR tie-breaker and collecting a real test set.
- **M4:** fine-tune the encoder on degraded artworks if M2's real-video accuracy falls short.
- **M5:** publishing prep (store listing, image re-hosting).
