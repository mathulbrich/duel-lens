# Duel Lens: screenshots, promo tile and icon (plan)

Status: **done, re-rendered 2026-09-29 (late morning) against the current UI.** Files:
`store/screenshots/{01-hero,02-click,03-not-sure,04-side-panel,05-privacy}.png` (1280×800) and
`store/promo/small-440x280.png` (440×280). They're rendered by `tools/store-shots/render.ts` from the
default build (official card images, which needs the network), and `npx tsx tools/store-shots/render.ts`
reproduces them. Evidence is in `.superpowers/sdd/2026-09-28-duel-lens-v1/store-shots-report.md`.
- 01 shows Ash Blossom with its highlighted Genesys chip and the "YGOPRODeck ↗" link.
- 02 shows the spotlight outlines.
- 03 shows a card in Defense Position (Number 39: Utopia, 97%), captioned "Sideways, upside down or tilted".
  After the click-path improvement, the render found no honest "Not sure" on the board, and it never stages one,
  so it used its planned fallback.
- 04 shows the side panel's full card details.
- 05 shows Windows keys and "Pick the card".
- Captions changed from the plan below: 01 "Press Alt+Shift+Y and click a card: its name and full text
  appear beside it."; 04 "On YouTube, click a scan's time to jump back to that moment."
- Also changed from the plan: `02-click.png` replaces `02-drag.png`, since the zip ships the card detector
  (A4).

The plan below is kept as the record of intent.

Originally: plan, 2026-09-29, rewritten the same day around 05:50 for the **store build**. Two things
changed:
- **The UI:** the popover shows the picture the user selected, not an official card image.
- **The scenes:** no Konami broadcast frames (`docs/release/RELEASE-CHECKLIST.md` S3; legal audit §7.7,
  decision D9).

The lead renders these later with the E2E harness (`test/e2e/`). Nothing here is rendered yet, and
every result shown must be the real output of the build being uploaded.

Sources: https://developer.chrome.com/docs/webstore/images (sizes, "square corners, no padding (full
bleed)", "demonstrate the actual user experience"), https://developer.chrome.com/docs/webstore/best-listing,
https://developer.chrome.com/docs/webstore/program-policies/impersonation-and-intellectual-property.

---

## 1. Deliverables

| File | Size | Required | Section |
|---|---|---|---|
| `store/screenshots/01-hero.png` | 1280×800 | yes (at least 1; we plan 5) | 4.1 |
| `store/screenshots/02-drag.png` (or `02-click.png`) | 1280×800 | | 4.2 |
| `store/screenshots/03-not-sure.png` | 1280×800 | | 4.3 |
| `store/screenshots/04-side-panel.png` | 1280×800 | | 4.4 |
| `store/screenshots/05-privacy.png` | 1280×800 | | 4.5 |
| `store/promo/small-440x280.png` | 440×280 | yes | 5 |
| `store/assets/icon-128-store.png` | 128×128 | yes | 6 (done) |
| `store/promo/marquee-1400x560.png` | 1400×560 | no, skip for v1 | 7 |
| Promo video (YouTube link) | | see `store/listing.md` section 1 | 8 |

Upload order in the dashboard = the file order above (01 is the first thing people see).

---

## 2. Rules for every image

**Honest:**
- Every popover, hint and panel is the real UI of the store build, with the result it really gave on
  that scene. No mock-ups, no retouched UI, no edited scores.
- **The store build's UI**, as built by `node build.mjs --e2e --no-remote-images` (section 3.1):
  - the popover's picture is the user's own crop (alt text "What you selected");
  - the "Not it?" and "Could also be" chips show names and percentages, with no pictures;
  - the side panel shows the scan's small picture.

  No image may show an official card image inside Duel Lens's UI: the store build has none.
- Only features the zip ships: drag scans. The click-to-scan variant of screenshot 2 exists only if
  the zip has a card detector (0.9.0 registers none: `src/offscreen/index.ts:25-28`).
- Build from the same sources as the zip. It has no DRAW2 (deleted from the repository, A6 phase 2;
  `npm run release` refuses any build that still has it). Re-check every expected result below on that
  build before capture.

**Clean** (IP, impersonation, other people's data):
- **No frames from Konami's broadcasts, in any form.** That means the whole real test set: the
  YCS Paris 2026, World Championship 2026 and WCQ Stuttgart 2026 frames in `data/debug/frames/`,
  `data/debug/fullview/` and `data/realset/`, and the other productions' frames in staging-C. Not
  cropped to the playmat, not with logos painted out: the frames themselves are the broadcaster's video
  (legal audit §7.7). The earlier version of this plan used `native-*` playmat crops; that is withdrawn.
- **Use a synthetic scene** (section 3.2): a plain page with a few card images on a playmat-coloured
  background, built from the E2E board (`test/e2e/page.html`, the 8 images in `test/fixtures/cards/`).
  The legal audit names this board as acceptable (§7.7).
- **Or the user's own footage** (D9, better once it exists): the user's own cards on the user's own mat,
  filmed by the user.
- Show only as much card art as the demonstration needs: a few cards, no card as decoration. No
  Konami, Yu-Gi-Oh!, event or sponsor logos, no people, no player names, no webcams.
- No retouching of anything.

**Format:** PNG, exactly 1280×800, sRGB, square corners, no transparency, no border or padding
("full bleed"). Keep each file under about 2 MB (the lead can switch to high-quality JPEG if needed).

---

## 3. Pipeline (the same for every screenshot)

### 3.1 Build and browser

1. `node build.mjs --e2e --no-remote-images` → `dist-e2e/`: the store build's UI, plus the E2E-only
   `<all_urls>` permission and debug hook that let the harness drive it. This is exactly what
   `npx tsx test/e2e/run.ts --store-images` builds (`test/e2e/run.ts:259-265`), and its last run read
   all 8 board cards confidently, showing the crop each time
   (`.superpowers/sdd/2026-09-28-duel-lens-v1/compliance-evidence/e2e-store-3.txt`).
2. Chrome for Testing via the harness's Puppeteer, `--lang=en-US`, a fresh profile. No network is
   needed for the popover: the store build requests no image, and the card data is bundled.
3. Installing opens the welcome page. Capture screenshot 5 there first (section 4.5), then agree:
   press **Agree and start**, or call `duelLensDebug.grantConsent()` in the service worker, as the harness
   does (`test/e2e/harness.ts`, `grantConsent`). Until then a scan only opens the consent step.

### 3.2 Scenes

**Scene A, the board.** A copy of `test/e2e/page.html` for the store shots:
- no "Duel Lens E2E board" heading;
- the background `#0f2a29` (a dark playmat green);
- served the way the harness serves the board, with the fixture images from `test/fixtures/cards/`.

Arrange the cards like a playmat, larger and fewer if that reads better, but keep the board's
orientations. In the last store-mode run each of these read confidently (`e2e-store-3.txt`):

| id | Card | On the board |
|---|---|---|
| `dm` | Dark Magician | 210 px wide, upright |
| `ash-upside` | Ash Blossom & Joyous Spring | 190 px, rotated 180° |
| `pog-small` | Pot of Greed | 90 px, small |
| `link` | Accesscode Talker | 170 px |
| `pend` | Odd-Eyes Pendulum Dragon | 170 px |
| `imp-tilt` | Infinite Impermanence | 170 px, tilted −7° |
| `xyz-def` | Number 39: Utopia | 140 px, sideways (Defense Position) |
| `vid` | Blue-Eyes White Dragon | inside a playing `<video>` at 2× its displayed resolution |

Any change to sizes or positions changes the crops: re-check the result of every card you capture.

**Scene B, the user's own footage** (D9, optional). A clip the user records of their own cards on their
own mat, played in a local page through a `<video>` element so the video-frame path shows. The same
rules apply: no logos, no people.

### 3.3 The page

- Viewport **1280×720 CSS px at deviceScaleFactor 1**, as in the E2E runs. Don't raise the scale for
  sharper text: the scan crops from the tab's screenshot, and at scale 2 the results could differ from
  the run that checked them.
- Trigger a scan as the E2E does: `duelLensDebug.startScan(tabId)` in the service worker (it does exactly
  what Alt+Shift+Y does), wait for `data-duel-lens-state="selecting"`, then drag with `page.mouse` from
  the box's top-left to its bottom-right in about 12 steps. Wait for `data-duel-lens-state="result"`,
  check `data-duel-lens-card` and `data-duel-lens-confident`, wait two animation frames, then capture.
  These state attributes exist only in the E2E build (`src/content/index.ts:144`); use them for these
  checks only.

### 3.4 Compose

With `sharp` (already a dev dependency):
1. Take the 1280×720 capture as it is (no resizing).
2. Make a 1280×800 canvas: an 80 px caption band on top, the 1280×720 shot below.
3. Caption band: background `#17151E`; a 3 px foil line along its bottom edge, using the popover's own
   gradient (`linear-gradient(100deg,#ffd1f4,#c3e4ff 22%,#c8ffe0 42%,#fff0b8 62%,#ffc9c9 80%,#ffd1f4)`,
   `src/content/styles.ts:17`); headline 27 px Archivo 650, `#F4F1F9`, at x 40, baseline 38;
   subline 15 px Archivo 400, `#B8B2C7`, baseline 63. Fonts: `extension/fonts/` (OFL). Render the
   band as HTML in Puppeteer at the same scale, or as SVG through sharp.
4. Save as PNG and check with `sharp(file).metadata()` that it is 1280×800.

---

## 4. The five screenshots

### 4.1 `01-hero.png`: a confident read

- **Caption:** "Read the card without leaving the stream"
- **Subline:** "Press Alt+Shift+Y and click a card: its name and full text appear beside it." (It was "drag a box" before click to scan became the main path.)
- **Scene:** A. **Card:** Dark Magician (`dm`), a box snug around the card.
- **UI state:** the confident layout, as in
  `.superpowers/sdd/2026-09-28-duel-lens-v1/compliance-shots/store-popover-dm.png`. From top to bottom:
  - the crop as a small picture beside "DARK MAGICIAN", [SPELLCASTER / NORMAL], DARK, Level 7,
    ATK 2500 / DEF 2100;
  - the card's text, then its passcode and archetype;
  - "NN% match · whole box · screenshot";
  - the "Not it?" chips, with names and percentages;
  - Keep in side panel / Copy text / Yugipedia, and the key hints.
- **Accept when:** the state says `Dark Magician`, confident `true`; the popover's picture is the crop;
  no toast.
- **Alternative:** the video card (`vid`, Blue-Eyes White Dragon). It shows the video-frame path ("…
  video" in the match line; see `compliance-shots/store-popover-video.png`).

### 4.2 `02-drag.png`: how a scan starts

- **Caption:** "Freeze the frame. Box the card."
- **Subline:** "Cards in Defense Position, upside down or slightly tilted are read too."
- **Scene:** A. **Card:** Number 39: Utopia, sideways (`xyz-def`).
- **UI state:** mid-drag. Mouse down at the card's top-left, move in 12 steps to its bottom-right,
  **don't release**, wait two animation frames, capture. This shows the frozen frame dimmed around the
  gold selection box. Before the drag, the hint reads "Drag a box around a card · Esc cancels"
  (`src/content/selection.tsx:337`; "Finding cards…" shows for a moment first). Make sure the capture
  shows the hint or the box as intended.
- **Honesty check:** release the mouse after the capture and confirm the scan really returns Utopia,
  confident. If it doesn't, use Ash Blossom upside down (`ash-upside`) or Infinite Impermanence tilted
  (`imp-tilt`), and re-check.
- **Variant `02-click.png`, only if the zip ships a card detector:** same scene, after detection.
  - Caption: "Every card outlined. Click one."
  - Subline: "Duel Lens finds the cards on the frozen frame. Dragging a box still works."
  - State: thin gold outlines on the detected cards, the pointer hovering one card (lit), hint "Click a
    card, or drag a box". Check that there is an outline on every card and none on the background. Use
    this variant instead of the drag one, not in addition.

### 4.3 `03-not-sure.png`: honest doubt

- **Caption:** "Not sure? It says so."
- **Subline:** "The closest matches are a click (or ← →) away. Optional: ask AI with your own key."
- **Scene:** A, with a genuinely hard case. Every board card reads confidently at its board size, so
  make one harder without faking anything, for example:
  - Pot of Greed shrunk to about 60 px;
  - a card half covered by another card;
  - a box around only part of the artwork.

  Try candidates on the release build and keep the first one whose real answer is "Not sure" **with
  the right card on screen** (as the top guess or among the chips).
- **Settings before the scan:** turn the AI check on with a placeholder key, so the popover offers
  "Ask AI" (it appears only when the check is on, a key is set and the api.anthropic.com permission is
  granted: `aiEnabled`, in the `recognize` case of `src/background/router.ts`). In the service worker: `chrome.storage.local.set({ settings: { ai:
  { enabled: true, apiKey: 'sk-ant-placeholder', model: 'claude-opus-5' }, debug: { saveCrops: false } } })`.
  **Never click Ask AI, and never use a real key.** Reset the settings afterwards. The E2E build's
  `<all_urls>` also covers the api.anthropic.com permission that Ask AI checks.
- **UI state:** the unsure layout: "Not sure · NN% match · …"; "Could also be" with its chips (names and
  percentages, no pictures in the store build); the gold "Ask AI" button; then the card, with the crop
  as its picture.
- **Accept when:** state `result`, confident `false`, the right card visible; at least two chips.
- **If no honest "Not sure" turns up:** ship four screenshots. Don't stage one.

### 4.4 `04-side-panel.png`: history

- **Caption:** "Keep what you looked up"
- **Subline:** "The side panel keeps your scans. On YouTube, a scan's time takes you back to that moment."
- **Scans first** (scene A), in this order so Dark Magician ends up newest and current: Accesscode
  Talker, Odd-Eyes Pendulum Dragon, Infinite Impermanence, Ash Blossom & Joyous Spring, Dark Magician.
  All are confident in the last store-mode run. Press Esc after each. Optionally wait about a minute
  between scans, so the list's clock times differ.
- **Left, 900×720:** the scene at viewport 900×720 (scale 1), no popover open.
- **Right, 379×720:** `chrome-extension://<id>/sidepanel.html` opened as a page at 379×720 (scale 1). It
  shows the current card with the small picture kept for that scan (alt text "What you scanned: …"),
  its name, type line and text, then "This session", "Clear history" and the five entries. Scroll so
  the picture, the name and all five entries show if they don't fit at once.
- **Compose:** left + a 1 px `#2A2733` divider + right = 1280×720, then the caption band. Don't draw
  Chrome's side-panel header or any other browser UI around it.
- **Honest limits:** the scene isn't YouTube and has no video time, so every entry shows a clock time,
  not a link. The subline describes that feature in words; the image doesn't fake it.
- **Accept when:** five entries, the newest Dark Magician, marked active; its picture shown (a
  `data:image/jpeg` thumbnail); no "Unknown card".

### 4.5 `05-privacy.png`: where the data goes

- **Caption:** "Runs on your computer"
- **Subline:** "No account, no analytics. It asks before its first scan."
- **Scene:** the welcome page in a fresh profile, **before agreeing**
  (`chrome-extension://<id>/welcome.html`), at 1280×720 (scale 1). Scroll so the "Before your first
  scan" step is in view, with its four points:
  - Screenshots;
  - History, "with the address and title of each page and a small picture of what you selected";
  - Card data, "YGOPRODeck, which can see your IP address. The picture it shows beside a card is the
    one you selected";
  - AI check (off);

  then the **Agree and start** button. `compliance-shots/welcome-store-top.png` shows the page's first
  screen in a store build.
- **Accept when:** the text on screen matches the privacy policy (`docs/release/privacy-policy.md`,
  Appendix D) and `store/privacy-practices.md` section 7. If they disagree, fix the words first, then
  capture.

### Captions at a glance

| # | Headline | Subline |
|---|---|---|
| 1 | Read the card without leaving the stream | Press Alt+Shift+Y and click a card: its name and full text appear beside it. |
| 2 | Freeze the frame. Box the card. | Cards in Defense Position, upside down or slightly tilted are read too. |
| 2 (click variant) | Every card outlined. Click one. | Duel Lens finds the cards on the frozen frame. Dragging a box still works. |
| 3 | Not sure? It says so. | The closest matches are a click (or ← →) away. Optional: ask AI with your own key. |
| 4 | Keep what you looked up | The side panel keeps your scans. On YouTube, a scan's time takes you back to that moment. |
| 5 | Runs on your computer | No account, no analytics. It asks before its first scan. |

If the user changes the default shortcut before release, update caption 1 and the listing together.

---

## 5. Small promo tile, 440×280 (required)

The store's guidance: avoid text, make it work at half size (220×140), use saturated colours, fill the
whole area.

- **Background:** `#17151E`, with a soft gold glow (`#E7B955` at about 12% opacity, radial, about 180 px)
  behind the mark.
- **Mark, left half:** the Duel Lens mark (a card under a magnifier) drawn as vector from
  `src/content/icons.tsx` (24×24 viewBox) at about 150×150, centred at (125, 140). Card outline in gold
  `#E7B955` (the icon's 1.8/24 stroke scales to about 11 px; go thinner if it looks heavy); the lens
  filled with the foil gradient from
  `src/content/styles.ts:17`; the handle in `#F4F1F9`. It should read as the same mark as the toolbar
  icon (`extension/icons/icon-128.png`: gold card, foil lens; the full-bleed original is
  `store/assets/icon-128-fullbleed.png`).
- **Wordmark, right half:** "Duel Lens" in Spectral SC 700 (`extension/fonts/spectral-sc-latin-700.woff2`),
  about 46 px, `#F4F1F9`, left edge at x 238, vertically centred. No tagline: at half size it would be
  unreadable, and the guidance says to avoid text.
- **Foil line:** 4 px along the top edge, the same gradient (the popover's signature).
- **Never:** card art, card backs, Konami or Yu-Gi-Oh! logos, screenshots, "#1"-style claims.
- **Render:** an HTML page at 440×280, dpr 2, captured by Puppeteer and downscaled with sharp, or
  SVG to sharp. Then view it at 220×140 and check that the mark and the name still read.

---

## 6. Store icon, 128×128 (required): done

- The store's spec: 128×128 PNG, **96×96 artwork with 16 px of transparent padding on each side**, no
  edge around the image, works on light and dark backgrounds.
- Done on 2026-09-29: `extension/icons/icon-128.png` is now the 96×96 art centred with 16 px of
  transparent padding. `store/assets/icon-128-store.png` is the same file (byte for byte), for the
  upload. The full-bleed original is kept as `store/assets/icon-128-fullbleed.png`, for promo art.
- Still worth a look before upload: check it on white and on `#202124` (Chrome's dark UI).

---

## 7. Marquee tile, 1400×560 (optional, skip for v1)

Used only if the store features the item. If ever made: the promo tile's layout widened, plus a crop of
screenshot 01's popover on the right. Same rules: no card art as decoration, no Konami marks.

---

## 8. Promo video (optional)

- Only if the user wants one: it is uploaded to the user's own YouTube account (the user's step).
- 20 to 40 seconds, no voice-over, captions burned in with the screenshot headlines: the welcome page's
  **Agree and start** → Alt+Shift+Y → drag → confident popover → "Not it?" with ← → → K → the side panel.
- Record the store build on scene A with the harness, or on the user's own footage of their own cards
  (D9). **Never on a Konami stream:** the footage is theirs (legal audit §7.7), and Content ID may match
  it too.
