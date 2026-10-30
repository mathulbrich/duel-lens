# Duel Lens: Opera add-ons submission guide (draft)

Status: draft, prepared 2026-10-16, for the same store build and texts the Chrome Web Store listing
uses (`store/listing.md`, `store/privacy-practices.md`, `store/privacy-tab-answers.txt`). Opera is a
Chromium fork and accepts Chrome's Manifest V3 extensions largely unmodified, but **not the same zip**:
addons.opera.com rejected `duel-lens-0.9.3.zip` with "Invalid type on file:
data/index-dinov2-small-duel-v3b.bin", so Opera gets its own, `release/duel-lens-<version>-opera.zip`
from `npm run release -- --opera` (§2). The one real compatibility question this guide exists to answer is `chrome.sidePanel`
(§6 below); everything else Duel Lens uses (`chrome.offscreen`, `chrome.scripting`, `chrome.alarms`,
`chrome.storage` incl. `.session`, the COEP/COOP manifest keys) is either confirmed supported or, for
`offscreen`/`scripting`, not contradicted by anything found — see §6 and the compat report
(`compat-chromium.md`, this ledger) for what was actually checked versus merely not found documented.

Sources (checked 2026-10-16):
- Account/getting started: https://help.opera.com/en/extensions/getting-started/
- Publishing guidelines: https://help.opera.com/en/extensions/publishing-guidelines/
- Supported extension APIs: https://help.opera.com/en/extensions/apis/
- Icon guidelines: https://help.opera.com/en/extensions/effective-icons/
- Upload form: https://addons.opera.com/developer/upload/
- `chrome.sidePanel` landing in Opera 136: https://blogs.opera.com/desktop/2026/09/opera-136-stable/
- Community reports on review turnaround (unofficial, see §5): https://forums.opera.com/topic/88253/extension-review-pending-for-20-days-seeking-update , https://forums.opera.com/topic/16609/very-long-extension-moderation-process/74 , https://forums.opera.com/topic/88850/addon-validation-time , https://forums.opera.com/topic/85652/what-has-happened-to-extension-update-approval-times

---

## 1. Account creation

1. Create a free developer account at <https://addons.opera.com/developer/> (an Opera account is
   enough; no separate fee like Chrome's US$5 — Opera's docs don't mention one).
2. No separate "publisher" verification step is documented the way Chrome's trader declaration or
   Edge's MSA registration flow is — account creation and first upload are the same short form.

---

## 2. Upload the Opera zip

1. Build it: `npm run release -- --opera` (tsc, Vitest, the E2E test on the Opera build, then
   `node build.mjs --target opera --out release/build-opera`, its verification and the zip). Then go to
   <https://addons.opera.com/developer/upload/> and upload **`release/duel-lens-<version>-opera.zip`**,
   not the Chrome/Edge zip (check its SHA-256 against `release/duel-lens-<version>-opera.zip.sha256`
   first, same as the other two guides).

   **Why a separate zip.** Opera's validator refused 0.9.3's zip on its first raw binary file ("Invalid
   type on file: data/index-dinov2-small-duel-v3b.bin"). Opera publishes no list of allowed file types,
   and forum reports show it judging content as well as the extension (a `.less` file passed only once
   emptied), so every raw binary would fail the same way: the artwork index (`.bin`), both models
   (`.onnx`) and ONNX Runtime's two WebAssembly files (`.wasm`). The Opera build ships each of them as
   base64 text, `<file>.b64.txt`, plus `packed-assets.json` with every original's size and SHA-256 (the
   models' are the pins in `tools/release.mjs` `MODEL_SHA256`). JS, JSON, HTML, CSS, PNG and the woff2
   fonts stay as they are. Its offscreen document decodes each file when the engine first asks for it
   and checks the size and the SHA-256 first, so a damaged file stops the engine with an error rather
   than running something else. That costs about 0.1 s more at the engine's first load (measured: 5.7 MB
   index 17 ms, 25.7 MB embedder 69 ms, 6.2 MB detector 16 ms, the 26.8 MB WebGPU runtime 60 ms or the
   14.2 MB WASM one 31 ms, in Chrome for Testing on an Apple M-series Mac), and the zip is larger: 56.6 MB
   against Chrome's 46.4 MB for 0.9.3 (118.6 MB unpacked against 91.1 MB), because base64 text deflates
   less well than the binaries did. Everything else is Chrome's build, byte for byte. How it
   works: `docs/DEVELOPMENT.md`, "Opera".
   If Opera ever refuses another file type, add it to `PACKED_TYPES` (build.mjs, tools/release.mjs and
   `src/offscreen/packed-assets.ts`) and check that the engine still fetches it through `fetch`.
2. Opera's uploader validates the manifest. Per Chromium's own manifest-parsing behaviour (every
   Chromium-based browser's extensions system, Opera's included, treats an unrecognized top-level
   manifest key as a parse **warning**, not a load failure — see `compat-chromium.md` §3), an unused or
   not-yet-implemented key like `side_panel` should not block the upload or the install even on an Opera
   version that doesn't act on it. This wasn't verified on a real Opera install (none is on this
   machine) — see §7's manual check.
3. Fill in the multi-step listing form: name, version, category, icon, screenshots, description — see
   §3 below for what to paste from `store/`.

---

## 3. Listing fields — reuse from `store/`

| Opera upload-form field | Reuse | Note |
|---|---|---|
| Name | manifest `name` | Same title as Chrome/Edge |
| Description | `store/listing.md` §4 (the long description) | Opera's form is a single description field, not split short/long — paste the full text (it describes the 0.9.4 features: find a card by name with Alt+Shift+F and the toolbar icon's right-click menu, Report issue, the three "Show card details" choices) |
| Changelog / what's new (if the form asks) | 0.9.4: Find a card by name (Alt+Shift+F, the toolbar icon's right-click menu, the side panel's search box). Report issue on a wrong, unsure or unmatched card (nothing is sent until Send report; it becomes a public GitHub issue). Three "Show card details" choices. More "Not sure" answers and faster scans on slower computers. |
| Category | `store/listing.md` §5 — **Entertainment** if Opera's list has it, else pick the closest (Opera's category list, per its docs, includes Entertainment, Games, Pictures, Productivity, Reference, among others — check the live dropdown; it's close enough to Chrome's list that Entertainment should exist) |
| Icon | `store/assets/icon-128-store.png` | Opera's icon guidance (effective-icons doc) asks that it not be all-white and stay legible on both light and dark toolbar backgrounds — same icon used for Chrome/Edge should already satisfy this; eyeball it in Opera's own toolbar once installed (§7) |
| Screenshots | `store/screenshots/01-hero.png` … `05-privacy.png`, **resized** | Opera's preferred size is 612×408, maximum 800×600 — ours are 1280×800 (`store/listing.md` §1), which exceeds Opera's cap. **Downscale** (e.g. to 800×500, keeping the 1280:800 ≈ 1.6:1 ratio close enough) before upload; don't upload the originals unresized |
| Privacy policy link | the hosted gist (same URL as Chrome's/Edge's) | Opera's publishing guidelines ask for one when the extension handles user data, same spirit as Chrome's requirement |

No separate small/large promo tile fields are documented for Opera the way Chrome and Edge have them;
skip.

---

## 4. Privacy answers

Opera's submission flow doesn't have Chrome's/Edge's structured multi-tab privacy questionnaire (single
purpose / per-permission justification / remote code / data-usage checkboxes / certifications) as a
separate gated step — it asks for a privacy policy link and relies on the description and the
permissions Opera's own install-time prompt derives from the manifest. Still reuse the same underlying
answers if Opera's form (or a reviewer's question) asks for specifics:

- **What it does / single purpose**: `store/privacy-tab-answers.txt` §1, verbatim.
- **Why each permission**: §2 — same justifications (activeTab, scripting, offscreen, storage,
  unlimitedStorage, sidePanel, alarms, contextMenus, the `images.ygoprodeck.com` host permission, the optional
  `api.anthropic.com` one). `contextMenus` adds one item, "Find a card by name…", to the toolbar icon's
  right-click menu; it opens the side panel's search box, as the Alt+Shift+F command does.
- **Data handling, if asked**: the scan history and the screenshot stay on the computer; a card report is
  sent only when the user presses **Send report** after **Report issue**, becomes a public issue on
  github.com/mathulbrich/duel-lens/issues through Duel Lens's report service (image kept 90 days, no IP
  address), and holds the shrunk crop, the cards shown, the page link and an optional comment
  (`store/privacy-practices.md` §0 and §4).
- **Remote code**: §3 — none; only data (card JSON/images) is fetched, never executed.
- **Privacy policy URL**: the same hosted gist Chrome and Edge use.

If a reviewer's rejection email asks a specific data-handling question not covered by the pasted
description, answer from `store/privacy-practices.md` directly (it's the fuller source document both
`privacy-tab-answers.txt` and this section summarize).

---

## 5. Review time

Opera's own help pages describe a moderation step ("Extension moderators test the extension... or
reject it if there are issues") without giving a numeric SLA. Unofficial reports from Opera's own
developer forum vary widely and should be read as anecdotes, not a guarantee: some threads describe
roughly 1–2 weeks, others describe pending reviews stuck for 20+ days, 1.5 months, or (for some MV3
submissions) several months during backlogs. **Budget for Opera's review taking meaningfully longer,
and less predictably, than Chrome's or Edge's**, and don't resubmit or edit while a review is pending
(same caution as Chrome's P1, `RELEASE-CHECKLIST.md` §9) — there's no documented "contact support after
N weeks" rule for Opera the way there is for Chrome, so if it stalls, the forum (linked above) is where
other developers have gotten attention from Opera staff.

---

## 6. Compatibility: `chrome.sidePanel` (why `src/background/panel.ts` exists)

- As of **Opera 136 Stable (September 2026)**, Opera added support for `chrome.sidePanel`
  (blogs.opera.com, cited above). That's very recent relative to Chrome's (2023, Chrome 114) and Edge's.
- Duel Lens doesn't gate on an Opera version number (that would be sniffing the browser, which this
  project avoids on principle — see `compat-chromium.md` §1). Instead, `openPanel()`
  (`src/background/panel.ts`) feature-detects `chrome.sidePanel?.open` at call time: on any Opera build
  that already has it (136+), Duel Lens's side panel behaves exactly like it does in Chrome/Edge; on an
  older Opera (or any future Chromium fork without it), it falls back automatically to a small popup
  window on `sidepanel.html`, reused and focused rather than reopened. Either way, "Keep in side panel",
  "Read the whole board" (B) and Alt+Shift+U all keep working — see `compat-chromium.md` §1 for the
  implementation and its tests.
- Opera's own "Extension APIs" reference page (help.opera.com/en/extensions/apis/) predates this and
  other newer MV3 additions: it documents `chrome.alarms`, `chrome.commands` (plus an Opera-only
  `_execute_sidebar_action` manifest field) and `chrome.storage` (noting Opera does **not** support
  `storage.sync()`/`storage.managed()` — irrelevant to Duel Lens, which only uses `storage.local` and
  `storage.session`), but says nothing about `chrome.offscreen`, `chrome.sidePanel` or `chrome.scripting`
  one way or the other. That's a gap in Opera's documentation, not evidence either API is missing —
  treat `chrome.offscreen` (the recognition engine's host) as the other thing worth confirming by hand
  (§7), since Duel Lens has no fallback for it the way it now does for `chrome.sidePanel`.

---

## 7. What the user should check by hand (Opera isn't installed on this machine)

1. Load `release/build-opera/` (the unpacked folder the Opera zip is built from) as an unpacked extension in
   Opera (`opera://extensions` → Developer mode → Load unpacked) and check for any manifest warnings,
   especially around `side_panel`, `sidePanel` permission, or the COEP/COOP keys.
2. Press Alt+Shift+Y on a real duel video; confirm the welcome/consent page, the frozen-frame card
   outlines, and the popover work.
3. **Specifically check the offscreen document loads** (the WASM recognition engine): the first scan
   should produce a match, not a "recognize failed" error. If `chrome.offscreen` isn't available on the
   installed Opera version, this is where it would show up.
4. Press Alt+Shift+U / "Keep in side panel" / "Read the whole board" (B) and watch which path Duel Lens
   takes:
   - **Opera 136+**: a real Opera side panel opens, same as Chrome/Edge.
   - **Older Opera**: a separate ~420×640 popup window opens instead, titled "Duel Lens", showing the
     same side-panel page. Confirm a second press reuses and focuses that popup instead of opening
     another one.
5. After publishing, install from the live Opera add-ons listing in a clean profile and repeat the smoke
   test (mirrors Chrome's P4, `RELEASE-CHECKLIST.md` §9).
