# Duel Lens: Firefox Add-ons (AMO) submission guide (draft)

Status: draft, prepared 2026-10-16 with the Firefox port (`.superpowers/sdd/2026-09-28-duel-lens-v1/firefox-port.md`).
Firefox needs **its own package**. Unlike Edge (`store/edge.md`), it can't take the Chrome zip (Opera can't either, but only because its store refuses raw binary files: `store/opera.md`):
- Firefox has no offscreen document and no extension service worker: the background is an event page, and the recognition engine runs in it (`engine.js`);
- the side panel is Firefox's sidebar (`sidebar_action`);
- AMO requires an add-on id and a data-collection declaration in the manifest;
- AMO reviews the source code: the bundles are made by esbuild, so the source zip goes with the XPI.

Sources (checked 2026-10-16):
- Submitting an add-on: https://extensionworkshop.com/documentation/publish/submitting-an-add-on/
- Source code submission: https://extensionworkshop.com/documentation/publish/source-code-submission/
- Add-on policies: https://extensionworkshop.com/documentation/publish/add-on-policies/
- Built-in data consent (`data_collection_permissions`): https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/
- Third-party library usage: https://extensionworkshop.com/documentation/publish/third-party-library-usage/

---

## 1. The package: `npm run release -- --firefox`

It runs tsc, vitest and the Firefox E2E test (`test/e2e/firefox.ts`), then builds `release/build-firefox/` (`node build.mjs --target firefox`). It writes:

| File | What it is |
|---|---|
| `release/duel-lens-<version>-firefox.xpi` | the add-on to upload (about 47 MB; AMO's limit is 200 MB) |
| `release/duel-lens-<version>-source.zip` | the source AMO's reviewers rebuild it from (about 36 MB): `src/`, `build.mjs`, `package.json`, `package-lock.json`, the two shipped models and the card data, and `README-AMO.md` with the build steps |
| `.sha256` beside each | their checksums |

Before writing them, the release checks:
- the Firefox manifest (`verifyBuild` with `target: 'firefox'`);
- Firefox itself loads the build with **0 warnings** (it needs Firefox installed, or `FIREFOX_BIN`);
- the source zip rebuilds every file of the XPI byte for byte (`rebuildFromSource`).

**Version:** AMO refuses a version number it has seen before. The Firefox and Chrome packages share `extension/manifest.json`'s version. Bump it for the first Firefox upload if the Chrome store already has that number with different contents.

---

## 2. Account (once)

1. Sign in at https://addons.mozilla.org/developers/ with a Mozilla account. AMO asks you to turn on two-step authentication before the first submission.
2. Accept the Firefox Add-on Distribution Agreement. There is no fee.
3. Developer profile: display name "Duel Lens", contact mathulbrich@gmail.com (the same as the Chrome listing).

---

## 3. Submit

1. **Submit a New Add-on**, then **On this site** (listed on AMO).
2. **Upload** `duel-lens-<version>-firefox.xpi`. AMO's automatic validation runs. Expected results:
   - 0 errors;
   - possibly warnings, none blocking:
     - `new Function` in ONNX Runtime's Emscripten code (`engine.js`, `ort/*.mjs`). It is never reached under the add-on's CSP;
     - `innerHTML` in Preact's code.
   - The reviewer notes below explain each one.
3. **Do you need to submit source code?** Yes. Upload `duel-lens-<version>-source.zip`.
4. **Describe the add-on** (section 4), then **Submit Version**. Review takes days to weeks for a first listed version with source code.

---

## 4. Listing fields

Reuse `store/listing.md`, with these Firefox changes.

| Field | Value |
|---|---|
| Name | Duel Lens – Card Reader for Duel Videos (the manifest's) |
| Add-on URL | `duel-lens` |
| Summary (250 characters at most) | The manifest's description (`extDescription`, 132 characters at most), as in Chrome |
| Description | `store/listing.md`'s, with: "side panel" → "sidebar"; "Keep in side panel" opens a small window in Firefox (Firefox opens its sidebar only from the shortcut or the toolbar); Firefox 140 or later |
| Categories | Games & Entertainment |
| Support email | mathulbrich@gmail.com |
| Support website | https://github.com/mathulbrich/duel-lens |
| License | Apache License 2.0 |
| Privacy policy | Yes: paste the hosted text (Appendix D of `docs/release/privacy-policy.md`, the same as the public gist). It covers Firefox from the 16 October 2026 version |
| Screenshots | `store/screenshots/` (AMO shows them at 1280×800) |
| Tags | yugioh, cards, video, recognition |

---

## 5. Data collection: what the manifest declares, and what to answer

The Firefox manifest (`build.mjs` `firefoxManifest`, decision D-FF4):

```json
"browser_specific_settings": { "gecko": {
  "id": "duel-lens@mathulbrich.github.io",
  "strict_min_version": "140.0",
  "data_collection_permissions": { "required": ["none"], "optional": ["websiteContent"] }
} }
```

- **Required: none.** Duel Lens collects nothing. The screenshot, the selected card, the history and the settings stay in the browser. The card data and card images come from YGOPRODeck: those requests carry nothing from the user's screen. They name the card image, which is the card the user looked at; we count this as fetching public content, not as collection, because nothing reaches us.
- **Optional: websiteContent**, for the opt-in AI check. When the user presses **Ask AI**, the selected image (part of the web page) goes to Anthropic with the user's own API key. Options asks Firefox for `websiteContent` together with `api.anthropic.com` when the user turns the AI check on, and gives both back when it is turned off (`src/shared/hosts.ts` `askAiPermissions`).
- If AMO's form asks, answer the same: no data collected by the developer; the optional website content sharing is the user's own AI request to Anthropic, under the user's own Anthropic account.
- **Open question for the reviewers:** do the YGOPRODeck image requests count as `websiteContent`? We think not. If the reviewers say they do, the change is one word in `firefoxManifest` (and `FIREFOX_DATA_COLLECTION` in `tools/release.mjs`), plus the policy's section 3.2.

---

## 6. Notes for reviewers (paste into "Notes to Reviewer")

```
Duel Lens identifies Yu-Gi-Oh! cards the user selects on screen (mostly in duel videos) and shows their text, entirely in the browser.

BUILD: the source zip has README-AMO.md. In short: npm ci && node build.mjs --target firefox --out dist-firefox. It rebuilds every file in the XPI byte for byte (checked by our release script).

THIRD-PARTY CODE (official npm releases, unmodified; versions in package-lock.json):
- onnxruntime-web (MIT): ort/*.mjs and ort/*.wasm are copied as published. https://github.com/microsoft/onnxruntime/releases
- preact (MIT): https://github.com/preactjs/preact/releases
- @anthropic-ai/sdk (MIT), used only by the opt-in AI check.

MODELS: models/*.onnx are our own trained models (weights, not code), run by ONNX Runtime Web. data/ is the card database and an artwork index (data).

LINTER WARNINGS:
- "new Function" is in ONNX Runtime's Emscripten glue (engine.js, ort/*.mjs). It is never reached under the CSP (script-src 'self' 'wasm-unsafe-eval').
- innerHTML is in Preact's bundled code; the add-on renders only its own components.

NO REMOTE CODE: everything that runs is packaged. Network requests: db.ygoprodeck.com (card data, JSON), images.ygoprodeck.com (card images, host permission), and api.anthropic.com only for the optional AI check (optional host permission plus the optional websiteContent data collection, requested when the user turns it on).

PERMISSIONS: activeTab + scripting (the scan starts only from the shortcut Alt+Shift+Y or the toolbar button); storage, unlimitedStorage (card database, history, settings); alarms (weekly card-data check).

HOW TO TEST: press Alt+Shift+Y on any page that shows a card image (for example https://ygoprodeck.com/card-database/), agree on the welcome page once, then click a card or drag a box around it. Alt+Shift+U opens the sidebar.
```

---

## 7. Manual checks before each Firefox release (about 15 minutes)

The E2E test can't press browser shortcuts or the toolbar, or open `moz-extension://` pages. Check these by hand on `release/build-firefox/` (about:debugging → This Firefox → Load Temporary Add-on → `manifest.json`):

1. **0 warnings** on about:debugging (the release checked it too).
2. **The shortcut:** on a page with a card image, Alt+Shift+Y shows the outlines; a click shows the popover. This proves activeTab and the screenshot from a command, without host access.
3. **The toolbar button:** a click starts a scan the same way.
4. **Alt+Shift+U** opens the sidebar on the side panel's page (a command is a user action, so Firefox allows it).
5. **S on a popover**, or "Keep in side panel": a small window opens on the panel (Firefox refuses the sidebar without a user action).
6. **The sidebar's width:** Firefox's default sidebar is narrow (about 216 px); the panel must stay readable.
7. **Idle:** leave the tab for over 30 s, then scan again. It works, about 0.4 s slower (the engine reloads).
8. **The AI check:** turning it on in Options makes Firefox ask for website content sharing and api.anthropic.com; turning it off withdraws them (about:addons → Duel Lens → Permissions).
9. **The welcome page** opens on a fresh install, and its "Agree and start" lets the first scan run.
