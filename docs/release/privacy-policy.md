# Duel Lens privacy policy (draft)

> **Draft for review, updated 2026-09-29 for the store build (decision D2: official card images by default). Not published.**
>
> **What to host (decision D5): Appendix D, word for word.** It is the text a store build shows on its bundled privacy page (`privacy.html`), so the public URL and the extension say the same thing. Put the heading "Duel Lens privacy policy" above it.
>
> **This file and the extension's page are one text.** `privacy.html` renders `src/legal/policy.ts`, which picks the variant for the build's flags. `src/legal/policy.test.ts` compares it with the policy below (from the effective date down to the appendices) and fails if they drift apart. Change the two together.
>
> The policy below is the **full** text. It describes a `node build.mjs --dev` build, which has YGOPRODeck's card images and the developer options. Since decision D2 (2026-09-29), every build shows YGOPRODeck's official card images by default, so a store build (the default: `npm run release`, or a plain `node build.mjs`) shows almost the same text, with only the one edit listed in Appendix C:
> - no debug "Save crops" option.
>
> The **crop build** (`--no-remote-images`, kept for a one-flag rollback) shows the older, text-only variant instead, with the edits Appendix C also lists:
> - no card images and no artwork downloads: the picture beside a card is the user's own selection, and a 160-pixel copy of it is kept with each scan in the history;
> - no access to any website (the manifest has no `host_permissions`).
>
> Every build has the first-run consent step: Duel Lens takes no screenshot and records no history until the user presses **Agree and start** on its welcome page.
>
> Before you host it:
> 1. ~~Fill in the developer name, contact email and effective date (decision D4).~~ Done on 29 September 2026: "the Duel Lens project", mathulbrich@gmail.com, 29 September 2026, in Appendix D, in the policy below and in `src/legal/policy.ts`.
> 2. Check that it still matches the build you ship. **Appendix A** lists the code behind every statement.
> 3. If you ever roll back to the crop build (`--no-remote-images`), host that build's text instead. Appendix D says how to print it.

**Effective date:** 29 September 2026
**Applies to:** the Duel Lens extension for Google Chrome, version 0.9.0 and later
**Contact:** mathulbrich@gmail.com

## Summary

- **Duel Lens recognises cards on your computer.** The screenshots and the images you select are processed inside your browser. They aren't sent to us or to anyone else, unless you use the optional AI check.
- **Card data and card images come from YGOPRODeck.** To show a card's text and picture, Duel Lens downloads them from YGOPRODeck's servers. These requests carry nothing from your screen. YGOPRODeck can see your IP address and which card images your browser asks for.
- **The AI check is optional and off by default.** If you turn it on and press **Ask AI**, Duel Lens sends the image you selected and the names of up to five possible cards to Anthropic. It uses your own Anthropic API key.
- **Your data stays in your browser.** Your scan history, settings and optional API key are stored in your browser, on your computer.
- **We collect nothing.** We have no server, and we don't collect, receive, sell or share any of your data. There are no analytics, no ads and no tracking.

## Who we are

Duel Lens is a free, unofficial browser extension made by the Duel Lens project ("we", "us"). It identifies Yu-Gi-Oh! cards that you select on your screen, for example in a duel video or a stream, and shows their text. It isn't affiliated with Konami, YGOPRODeck or Anthropic.

## 1. The page you're viewing

**Duel Lens can't see a page until you ask it to.** It has no access to your tabs until you press its keyboard shortcut (Alt+Shift+Y by default) or click its toolbar icon. Chrome then gives Duel Lens temporary access to that one tab, until you leave the page or close the tab. Chrome calls this permission "activeTab".

Before your first scan, Duel Lens shows what it handles and asks you to agree. It takes no screenshot and records no history until you do.

When you start a scan, Duel Lens:

- **takes a screenshot** of the visible part of the tab, to show the frozen frame and to find the cards on it;
- **copies the current frame of any video that is visible** on the page, at the video's own resolution, so that a card in a video can be cut out sharply;
- **cuts out the card you choose**: the part of the image you click or drag a box around, plus a small margin;
- **identifies the card with its own recognition models**, which run inside your browser.

The screenshot, the video frames and the cut-out image are kept in memory only while the scan is open. They aren't saved, except by the optional debug setting described in section 2. They aren't sent anywhere, except to Anthropic when you press **Ask AI** (section 3).

When a scan identifies a card, Duel Lens records the page's address and title, and the video's playback time, in your scan history on your computer, so you can find the card and the moment again. Apart from the screenshot, the video frames, and the page's address and title, Duel Lens doesn't read the page's content.

## 2. What is stored on your computer

Duel Lens stores the following in your browser's storage for the extension. Chrome keeps it on your computer. It isn't synced to your Google account, and we can't see it.

| What | Contains | How long | How to delete it |
|---|---|---|---|
| **Scan history** | For each scan that identified a card: the card, how sure the match was, whether you picked a different card, the time, the page's address and title, the video's playback time (if the card was in a video), and whether the image came from a video or a screenshot | The latest 300 scans. Older ones are removed automatically. | **Clear history** in the side panel, or uninstall Duel Lens |
| **Current card** | Which history entry the side panel shows | Until you close Chrome | Automatic |
| **Settings** | Whether the AI check is on, the Claude model chosen, and the debug setting | Until you change them | Options, or uninstall |
| **Anthropic API key** (only if you add one) | The key you paste in Options | Until you delete it | Clear the key field in Options, or uninstall |
| **Card database** | Card names, text and statistics from YGOPRODeck | Replaced when YGOPRODeck publishes an update (checked weekly) | Uninstall |
| **Card images** | Pictures of the cards Duel Lens has shown you, downloaded from YGOPRODeck | The latest 1,500 pictures. Older ones are removed automatically. | Uninstall |
| **New cards' artwork index** | Numeric "fingerprints" of new cards' artwork, computed on your computer, plus technical records of the last update | Until you uninstall | Uninstall |
| **Saved crops** (debug setting, off by default) | If you turn on "Save crops for a test set": the images you selected (the latest 300) and the card each one turned out to be | Until you uninstall | Uninstall. **Export test set** creates a file only when you click it. |
| **Your agreement** | The date you agreed to this data handling | Until you uninstall | Uninstall |

Your API key is stored without encryption. Chrome lets only Duel Lens's own pages and background process read it, not websites and not the scripts Duel Lens runs on web pages. Anyone with access to your computer or Chrome profile could still find it. So use a key made just for Duel Lens, with a spending limit, and delete it when you stop using the AI check.

**Uninstalling Duel Lens deletes all of the data above from Chrome.**

## 3. What goes over the internet

### 3.1 YGOPRODeck: card data and images (always)

Duel Lens gets its card information from YGOPRODeck (<https://ygoprodeck.com/>), a free Yu-Gi-Oh! card database. It makes three kinds of request:

- **Card data.**
  - Once a week, and when you press **Check for updates now** in Options, it asks YGOPRODeck (`db.ygoprodeck.com`) whether the card database has changed.
  - If it has, it downloads the updated card list.
  - With the card list, it downloads the list of Genesys points: how many points each card costs in the Genesys format.
- **Card images.**
  - The first time Duel Lens shows you a card, it downloads that card's picture from `images.ygoprodeck.com`.
  - It also downloads small pictures of up to three other possible matches.
  - It keeps the latest 1,500 pictures, so it doesn't download them again.
- **New cards' artwork.**
  - When new cards are released, it downloads their artwork from `images.ygoprodeck.com`.
  - It turns the artwork into numeric fingerprints on your computer, so it can recognise those cards, and then discards the images.
  - This happens when the weekly check finds new cards, after you install Duel Lens or start Chrome (at most once a day), and when you press **Update now** in Options.

These requests don't contain anything from your screen, and Duel Lens adds no identifier or account information to them. Like any website your browser contacts, YGOPRODeck receives your **IP address**, your browser's standard request information (such as its user agent), and **the address of each file requested**. So it can see which card pictures your browser downloads. See YGOPRODeck's privacy policy: <https://ygoprodeck.com/privacy-policy/>.

### 3.2 Anthropic: the AI check (only if you turn it on)

The AI check is **off by default**. To use it, you have to:

1. turn it on in Options;
2. allow Duel Lens to contact `api.anthropic.com` (Chrome asks you);
3. paste your own Anthropic API key.

When a match is unsure and you press **Ask AI**, Duel Lens sends one request **directly from your browser to Anthropic's API**, containing:

- the image you selected (the card, plus a small margin around it);
- the names of up to 5 cards Duel Lens thinks it might be;
- a fixed instruction asking Claude to name the card;
- the Claude model chosen in Options;
- your API key, which Anthropic uses to identify your account;
- technical information added by Anthropic's software library: the library's version, and your browser's name and version.

The **Test** button in Options sends only the word "ping", with your key.

Anthropic receives this data under **your own agreement with Anthropic**, and handles it under Anthropic's policies:
- privacy policy: <https://www.anthropic.com/legal/privacy>;
- how long Anthropic keeps API data: <https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data>.

We never receive your key, your images or Claude's answers. Anthropic charges your account for these requests.

### 3.3 Links you open

Duel Lens shows links to other websites: YGOPRODeck (a card's page, and its home page), YouTube (the moment a card appeared), and Anthropic's Console and price list. They open only when you click them, and those websites' own privacy policies apply.

### 3.4 Nothing else

Duel Lens has no server of its own and no user accounts. It has no analytics, crash reporting, advertising or tracking. It doesn't load code from the internet: its recognition models and software are inside the extension.

## 4. What we collect

**Nothing.** We don't operate any server that Duel Lens sends data to. We don't receive your history, your images, your settings or your API key. We don't sell, rent or share personal information, and we don't use any data for advertising or for any purpose other than the extension's features.

Because your data never reaches us, we can't look at it, export it or delete it for you. It's on your computer and under your control (section 2). For data that YGOPRODeck or Anthropic hold, contact them.

## 5. Why Duel Lens asks for its permissions

| Permission | Why |
|---|---|
| activeTab | To take a screenshot of the current tab and show the selection there, only after you press the shortcut or click the icon |
| scripting | To add Duel Lens's selection layer and card pop-up to that tab when you start a scan |
| offscreen | To run the recognition models in a hidden extension page |
| storage, unlimitedStorage | To keep your settings, history, the card database, card pictures and the artwork index on your computer |
| sidePanel | To show the scanned card and your history in Chrome's side panel |
| alarms | For the weekly card-data check, and to close the recognition engine when it's idle |
| Access to `images.ygoprodeck.com` | To download card pictures and new cards' artwork (section 3.1) |
| Optional access to `api.anthropic.com` | Only for the AI check, and requested only when you turn it on (section 3.2) |

## 6. Children

Duel Lens isn't directed at children under 13, and it doesn't collect personal information from anyone.

## 7. Where the data is processed

Everything described in sections 1 and 2 happens on your computer. YGOPRODeck and Anthropic may process the requests described in section 3 in other countries, including the United States. See their privacy policies.

## 8. Chrome Web Store User Data Policy

Duel Lens's use of information complies with the Chrome Web Store User Data Policy, including the Limited Use requirements (<https://developer.chrome.com/docs/webstore/program-policies/limited-use>).

## 9. Changes to this policy

We'll update this page, and its effective date, whenever Duel Lens's handling of data changes. If a new version would send more data off your computer, it will tell you in the extension before that happens.

## 10. Contact

Questions or requests: mathulbrich@gmail.com.

---

## Appendix A: evidence for each statement (delete before publishing)

Line numbers are as of 2026-09-29 around 06:05 and will move; the function and constant names are the stable references. Paths are under `src/` unless they say otherwise. Since decision D2 (2026-09-29), "store build" means the default build, which has `__DUEL_LENS_REMOTE_IMAGES__` on; "the crop build" means `node build.mjs --no-remote-images`, kept for a one-flag rollback.

| Statement | Code |
|---|---|
| No access to a page until the shortcut or icon | No `content_scripts` in `extension/manifest.json`; permissions `activeTab` and `scripting`. `background/index.ts:84-95`: `commands.onCommand` and `action.onClicked` call `startScan`. `background/scan.ts:36-38`: `injectContentScript` runs `chrome.scripting.executeScript` on demand. |
| Consent before the first scan | `background/scan.ts:131-134`: without a stored consent, `startScan` opens `welcome.html#consent` (`background/welcome-tab.ts`) and returns before any capture, message or injected script. `background/consent.ts`: `consentedAt` in `chrome.storage.local`. `background/index.ts:28-32`: a fresh install opens `welcome.html`. `welcome/consent.tsx`: **Agree and start** sends `grant-consent` (`background/router.ts:394`); **Not now** closes the tab. |
| Takes a screenshot of the visible tab | `background/scan.ts:34`: `chrome.tabs.captureVisibleTab(windowId, { format: 'png' })` |
| The screenshot goes to the page overlay and the local detector | `background/scan.ts`, `startScan`: `begin-selection` carries the screenshot, then `detectCards(screenshot)` (offscreen document) |
| Copies the frames of visible videos | `content/index.ts:101` → `grabVideoFrames()` (`content/capture.ts:88`: every visible `<video>`, drawn to a canvas at `videoWidth` × `videoHeight`) |
| Cuts out the box plus a small margin | `content/capture.ts:13`: `CROP_MARGIN = 0.04` |
| Frames and screenshot are released when the scan closes | `content/index.ts:119` ("Release the pixels rather than wait for GC") |
| Recognition runs locally; no code from the internet | `offscreen/web-runtime.ts:37`: `ort.env.wasm.wasmPaths = getURL('ort/')`; the model, the card detector and the index are all read from the package (`offscreen/loaders.ts`, `offscreen/index.ts`). Both the card-artwork model and the card detector run through ONNX Runtime Web; OpenCV.js was removed (A4) and is no longer bundled. The manifest's CSP is `script-src 'self' 'wasm-unsafe-eval'`. |
| History records the page's address and title, and the video time | `content/app.tsx:154-156`: the `recognize` message has `pageUrl: location.href`, `pageTitle: document.title` and `videoTime`. `background/router.ts:186`, case `recognize`: the `entry` (`:240-244`); `corrected` is set by case `correct` (`:284`). |
| A small picture of each scan (the crop build only) | `background/router.ts:252`: `if (!deps.remoteImages) keepThumbnail(…)`, made after the answer (`:137-141`). `background/thumbnail.ts:7-8`: at most 160 pixels on the longer side, JPEG quality 0.8. `background/history.ts:11-14`, `:43-46`: `chrome.storage.local` key `thumb:<entry id>`, kept only while its entry exists; `:22-28`: dropped with the entry past 300; `:65-71`: `clearHistory` removes them all. |
| The pop-up shows the user's own crop (the crop build only) | `content/app.tsx:190`: no card image is requested; `:315`: `cropImage` is the crop; `content/card-view.tsx:137-158`: shown whole, with the alt text "What you selected"; `content/popover.tsx:235`: no pictures on the other matches. `background/router.ts:279`: `get-image` answers `null`. |
| The latest 300 scans; Clear history | `background/history.ts:10`: `MAX_HISTORY = 300`; `addEntry`, `clearHistory`; `sidepanel/app.tsx:132-133`, `onClearHistory` |
| Current card until Chrome closes | `background/history.ts:54-56`: `setCurrent` → `chrome.storage.session` |
| Settings and API key in local storage, restricted to trusted contexts | `background/settings.ts` (key `settings`, `chrome.storage.local`); `background/index.ts:20-22`: `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`; `options/app.tsx:169`: `onApiKeyInput` → `setSettings` |
| Card database in IndexedDB, weekly check, Genesys points with the card list | `background/card-store.ts:15-18` (`CHECK_VERSION_URL`, `CARD_INFO_URL`, `GENESYS_URL`), `:66-79` (`openDb`, database `duel-lens`), `:227-290` (`refreshIfChanged`: the version check, then the card list, then `withGenesysPoints`); `background/index.ts:13-14`, `:47-52`, `:66-82` (`REFRESH_ALARM`, every `WEEKLY_MINUTES`); `background/router.ts:369`, case `refresh-cards` ("Check for updates now") |
| No website access is needed for the card data | YGOPRODeck's API answers `Access-Control-Allow-Origin: *`: checked with curl and with a real build that has no host permissions (`.superpowers/sdd/2026-09-28-duel-lens-v1/compliance-report.md`, "Decisions I took", 1); the Genesys list too (curl, 2026-09-29). `background/card-store.test.ts:202-215`: the refresh's three requests are plain GETs only (no headers, no credentials), which need no preflight. `build.mjs:131-144`: only builds with remote images (and the E2E build) get `host_permissions`. |
| Card images downloaded once and kept, the latest 1,500 (builds with remote images only) | `background/image-cache.ts`: `CACHE_NAME = 'card-images-v1'`, `imageUrl` (`cards/` and `cards_small/`), `getImageDataUrl` (`cache.match`, then `fetch`, then `cache.put`), then `evictOldest`: past `MAX_CACHED_IMAGES = 1500`, the oldest go first, in the order they were added (security review I3). `src/legal/policy.test.ts` fails if the policy's number and `MAX_CACHED_IMAGES` differ. `background/router.ts:106` wires it only when `__DUEL_LENS_REMOTE_IMAGES__` is on. |
| The main picture, plus up to 3 alternatives (builds with remote images only) | `content/app.tsx:176-185`: `load(…, 'full')` for the shown card and `load(…, 'small')` for up to three others; the effect returns at once in the crop build (`:190`) |
| New cards' artwork downloaded, fingerprinted, images discarded (builds with remote images only) | `background/index-update.ts:87`: `artworkUrl` (`cards_cropped/`), `downloadArtwork`, `DEFAULT_RATE_LIMIT_PER_SECOND = 8`, `STALE_RUN_MS` (24 h); `offscreen/index-updater.ts`: `embedArtworks` → `appendDelta` stores only `{ modelId, imageId, cardId, vector }` (`offscreen/delta-index.ts`, database `duel-lens-index`) |
| When artwork updates run (builds with remote images only) | `background/index.ts:39-43` (`onInstalled` → `runIndexUpdateIfStale`), `:58-64` (`onStartup`), `:79` (after a weekly refresh that found new cards); `background/router.ts:374` (`refresh-cards`), `:385-389` (`update-index`, "Update now", which the crop build refuses) |
| Saved crops (developer builds only; off by default; 300) | `options/app.tsx:408`: the Debug section is rendered only `if (__DUEL_LENS_DEV__)` (`build.mjs:55`: `--dev` and `--e2e` builds); `shared/types.ts:141`: `debug: { saveCrops: false }`; `background/router.ts:253`: `if (settings?.debug.saveCrops) …`; `background/card-store.ts:13`, `:293-302`: `MAX_CROPS = 300`, `saveCrop`; export: `options/app.tsx`, `onExportTestSet` (a local download) |
| The AI check is off by default and needs a permission, a key, and Ask AI | `shared/types.ts:140`: `ai.enabled: false`, `apiKey: ''`; `options/app.tsx:154-173`: `onToggleAi` → `chrome.permissions.request({ origins: [ANTHROPIC_ORIGIN] })` when turned on, and `chrome.permissions.remove` when turned off (the key stays until its field is cleared); `background/router.ts:318` and `:365`: cases `ask-ai` and `test-ai` refuse without the permission (`permissions.hasAnthropic` → `chrome.permissions.contains`); `background/ai.ts:174`, `identifyWithAi`: returns early unless `settings.ai.enabled` and `settings.ai.apiKey`; `content/popover.tsx:289-291`, `aiControls`: the **Ask AI** button only when `aiEnabled`, which needs the setting, the key and the permission (`background/router.ts:223-225`); `content/app.tsx`, `askAi` sends `ask-ai` on click |
| What goes to Anthropic | `background/router.ts:316`: `msg.candidates.slice(0, 5)` → names; `background/ai.ts`: `buildIdentifyRequest` (an image block from the crop's data URL, plus `buildPrompt(candidateNames)`), `buildModelRequest` (model, thinking, effort); `:46-49`, `buildAnthropicClient`: `new Anthropic({ apiKey, dangerouslyAllowBrowser: true })` |
| The library's technical headers | `node_modules/@anthropic-ai/sdk/internal/detect-platform.mjs`: `X-Stainless-Lang`, `-Package-Version`, `-OS: 'Unknown'`, `-Arch: 'unknown'`, `-Runtime: browser:<name>`, `-Runtime-Version` |
| Test sends "ping" | `background/ai.ts:166`: `buildTestRequest` → `messages: [{ role: 'user', content: 'ping' }]` |
| No other hosts, no analytics | All `fetch` calls in `src/` go to `chrome.runtime.getURL(...)`, `db.ygoprodeck.com`, `images.ygoprodeck.com` (builds with remote images only, the default since D2) or, through the SDK, `api.anthropic.com`. A default build's manifest and bundles name `images.ygoprodeck.com` (`build.mjs`'s `IMAGES_HOST`; `tools/release.mjs`'s `verifyBuild` requires the host permission). The crop build (`--no-remote-images`) names it nowhere and asks for no host permission (`tools/release.test.ts`). No analytics or tracking library is bundled (legal audit §2). |
| Links open only on click | `content/card-view.tsx`: `ygoprodeckUrl`; `sidepanel/app.tsx:44`: `openAtHref` (YouTube); `welcome/links.tsx:28`: `ExternalLink` (`target="_blank"`) |
| Uninstall deletes the data | Chrome removes an extension's `chrome.storage`, IndexedDB and Cache Storage when the extension is uninstalled. |

## Appendix B: the Chrome Web Store Privacy practices form (suggested answers; delete before publishing)

For the store build. The paste-ready version, with the code behind each answer, is `store/privacy-practices.md`; keep the two, and section 5 of Appendix D, saying the same thing.

**Single purpose:** "Duel Lens identifies Yu-Gi-Oh! cards that you select on your screen, in videos, streams or images, and shows their card text."

**Permission justifications:**

| Permission | Justification |
|---|---|
| activeTab | Takes a screenshot of the current tab and shows the card selection there, only after the user presses the shortcut or clicks the toolbar icon, and only once the user has agreed on the welcome page. |
| scripting | Injects the selection overlay and card pop-up into the current tab when the user starts a scan. |
| offscreen | Runs the WebAssembly recognition models (ONNX Runtime Web: the card-artwork model and the card detector) in an offscreen document, because a service worker can't host them. |
| storage | Saves settings, the optional Anthropic API key, the date the user agreed, and the scan history (the newest 300 scans: card, page address and title, and time) on the user's device. |
| unlimitedStorage | Keeps the card database (about 9 MB) and the scan history on the device, so recognition works offline and the card list isn't downloaded again. |
| sidePanel | Shows the scanned card and the scan history in Chrome's side panel. |
| alarms | Checks weekly for card-data updates, and closes the recognition engine when idle. |
| Host permissions | `images.ygoprodeck.com`, to download and cache the official card image shown next to a recognised card, and new cards' artwork for the self-updating index (decision D2). This server sends no CORS headers, so reading it needs host access. The card data itself comes from YGOPRODeck's public API, which allows cross-origin requests and needs none. |
| Optional host `api.anthropic.com` | Used only by the opt-in AI check, and requested when the user turns it on. |

**Remote code:** No. All JavaScript and WebAssembly is in the package, and the models and index are packaged files.

**Data types collected** (the store asks you to disclose data you handle even if it stays on the device):

| Category | Tick | Why |
|---|---|---|
| Personally identifiable information | No | |
| Health information | No | |
| Financial and payment information | No | |
| **Authentication information** | **Yes** | The user's Anthropic API key: stored locally, and sent only to Anthropic to authenticate the user's own requests |
| Personal communications | No | |
| Location | No | |
| **Web history** | **Yes** | The address and title of pages where the user scanned a card, stored locally in the scan history; never transmitted |
| User activity | No | No clicks, keystrokes or scrolling are recorded; keyboard shortcuts are handled, not logged |
| **Website content** | **Yes** | Screenshots and the selected image, processed locally to identify the card; the matched card's official picture is downloaded from YGOPRODeck and cached; the selected image is sent to Anthropic only when the user presses Ask AI |

**Certifications:** tick all three. You don't sell or transfer user data outside the approved uses. You don't use it for purposes unrelated to the single purpose. You don't use it for creditworthiness or lending.

**Privacy policy URL:** the hosted copy of Appendix D (decision D5).

## Appendix C: how each build differs from the full text, and edits for later changes (delete before publishing)

**Shipped** (in the code on 2026-09-29):
- **The first-run consent step** (`legal-audit.md`, B4; `disclaimers.md` §4a). Every build has it, so the full text above now includes it: the consent paragraph in section 1 and the "Your agreement" row in section 2.
- **No access to `db.ygoprodeck.com`,** in any build: its API allows cross-origin requests. Section 5 of the full text names only `images.ygoprodeck.com`, which every build but the crop build asks for (decision D2).
- **Official card images by default (D2, decided 2026-09-29):** every build, the store build included, shows YGOPRODeck's official card images and downloads new cards' artwork, and asks for host access to `images.ygoprodeck.com`. That is exactly the full text above, so it needs no edit here.
- **The debug "Save crops" option (D8)** is in developer builds only (`__DUEL_LENS_DEV__`). The store text (the default, `--dev` off) has no "Saved crops" row, and section 1 has no debug clause: that is the *only* edit from the full text above, printed with Appendix D's command and the first flag left `true`. **Appendix D is the result.**

**The crop build** (`--no-remote-images`; the default build until D2 was decided on 2026-09-29; kept now for a one-flag rollback). Against the full text, the crop text (the `OWN_CROP` variant in `src/legal/policy.ts`) changes:
- the summary: "Card data comes from YGOPRODeck", with no card images, and the history's small picture;
- section 1: a small copy of the cut-out image is kept with the history, and the cut-out image is shown in the pop-up in place of a picture of the card;
- section 2: the Scan history row adds "a small picture (160 pixels) of what you selected"; no "Card images" and no "New cards' artwork index" rows;
- section 3.1: card data only, "It downloads no card images and no artwork";
- section 5: the storage row without card pictures; no host-access row, and a line saying Duel Lens asks to access no website.

If you ever roll back to this build, print and host its text instead: Appendix D's command, with the first flag set to `false`.

**Not shipped** (edit the full text, `policy.ts` and Appendix D together when one happens):
- **Card images re-hosted (D2 b):** replace `images.ygoprodeck.com` with your host in the summary, 3.1, 5 and Appendix B. Say that the host sees which card images are requested.
- **Card data and new artworks from your own feed (D3, R1):**
  - In the summary and in 3.1, replace the weekly YGOPRODeck check and the artwork downloads with your feed's host, which then receives the IP address and request information.
  - Say that artwork fingerprints arrive ready-made, so no artwork is downloaded.
  - Update the host permissions in 5 and in Appendix B, if the feed needs one.
- **The "Remember the page for each scan" switch ships (D13):** add to the Scan history row: "(the page's address and title only if 'Remember the page for each scan' is on in Options; it is on by default)".
- **Anything new leaves the computer** (a new host, analytics, error reports): update 3 and Appendix B, and ask again in the extension before it happens (`disclaimers.md` §4a, "When a later version handles data in a new way"; the store's disclosure rules require this).

## Appendix D: the text to host (the store build's policy, word for word)

This is what a store build's `privacy.html` shows: `src/legal/policy.ts` with `__DUEL_LENS_REMOTE_IMAGES__` on and `__DUEL_LENS_DEV__` off, printed on 2026-09-29 from the current sources (decision D2: official card images by default). Host it as it is, under the heading "Duel Lens privacy policy", once the brackets are filled in (D4).

To print it again after any change to `policy.ts` (including filling in the brackets), run this from the repository root. For the crop build (`--no-remote-images`, kept for a one-flag rollback), set the first flag to `false`.

```sh
npx tsx -e "globalThis.__DUEL_LENS_REMOTE_IMAGES__ = true; globalThis.__DUEL_LENS_DEV__ = false; import('./src/legal/policy.ts').then((m) => process.stdout.write(m.privacyPolicy()))"
```

```markdown
**Effective date:** 29 September 2026
**Applies to:** the Duel Lens extension for Google Chrome, version 0.9.0 and later
**Contact:** mathulbrich@gmail.com

## Summary

- **Duel Lens recognises cards on your computer.** The screenshots and the images you select are processed inside your browser. They aren't sent to us or to anyone else, unless you use the optional AI check.
- **Card data and card images come from YGOPRODeck.** To show a card's text and picture, Duel Lens downloads them from YGOPRODeck's servers. These requests carry nothing from your screen. YGOPRODeck can see your IP address and which card images your browser asks for.
- **The AI check is optional and off by default.** If you turn it on and press **Ask AI**, Duel Lens sends the image you selected and the names of up to five possible cards to Anthropic. It uses your own Anthropic API key.
- **Your data stays in your browser.** Your scan history, settings and optional API key are stored in your browser, on your computer.
- **We collect nothing.** We have no server, and we don't collect, receive, sell or share any of your data. There are no analytics, no ads and no tracking.

## Who we are

Duel Lens is a free, unofficial browser extension made by the Duel Lens project ("we", "us"). It identifies Yu-Gi-Oh! cards that you select on your screen, for example in a duel video or a stream, and shows their text. It isn't affiliated with Konami, YGOPRODeck or Anthropic.

## 1. The page you're viewing

**Duel Lens can't see a page until you ask it to.** It has no access to your tabs until you press its keyboard shortcut (Alt+Shift+Y by default) or click its toolbar icon. Chrome then gives Duel Lens temporary access to that one tab, until you leave the page or close the tab. Chrome calls this permission "activeTab".

Before your first scan, Duel Lens shows what it handles and asks you to agree. It takes no screenshot and records no history until you do.

When you start a scan, Duel Lens:

- **takes a screenshot** of the visible part of the tab, to show the frozen frame and to find the cards on it;
- **copies the current frame of any video that is visible** on the page, at the video's own resolution, so that a card in a video can be cut out sharply;
- **cuts out the card you choose**: the part of the image you click or drag a box around, plus a small margin;
- **identifies the card with its own recognition models**, which run inside your browser.

The screenshot, the video frames and the cut-out image are kept in memory only while the scan is open. They aren't saved. They aren't sent anywhere, except to Anthropic when you press **Ask AI** (section 3).

When a scan identifies a card, Duel Lens records the page's address and title, and the video's playback time, in your scan history on your computer, so you can find the card and the moment again. Apart from the screenshot, the video frames, and the page's address and title, Duel Lens doesn't read the page's content.

## 2. What is stored on your computer

Duel Lens stores the following in your browser's storage for the extension. Chrome keeps it on your computer. It isn't synced to your Google account, and we can't see it.

| What | Contains | How long | How to delete it |
|---|---|---|---|
| **Scan history** | For each scan that identified a card: the card, how sure the match was, whether you picked a different card, the time, the page's address and title, the video's playback time (if the card was in a video), and whether the image came from a video or a screenshot | The latest 300 scans. Older ones are removed automatically. | **Clear history** in the side panel, or uninstall Duel Lens |
| **Current card** | Which history entry the side panel shows | Until you close Chrome | Automatic |
| **Settings** | Whether the AI check is on, the Claude model chosen, and the debug setting | Until you change them | Options, or uninstall |
| **Anthropic API key** (only if you add one) | The key you paste in Options | Until you delete it | Clear the key field in Options, or uninstall |
| **Card database** | Card names, text and statistics from YGOPRODeck | Replaced when YGOPRODeck publishes an update (checked weekly) | Uninstall |
| **Card images** | Pictures of the cards Duel Lens has shown you, downloaded from YGOPRODeck | The latest 1,500 pictures. Older ones are removed automatically. | Uninstall |
| **New cards' artwork index** | Numeric "fingerprints" of new cards' artwork, computed on your computer, plus technical records of the last update | Until you uninstall | Uninstall |
| **Your agreement** | The date you agreed to this data handling | Until you uninstall | Uninstall |

Your API key is stored without encryption. Chrome lets only Duel Lens's own pages and background process read it, not websites and not the scripts Duel Lens runs on web pages. Anyone with access to your computer or Chrome profile could still find it. So use a key made just for Duel Lens, with a spending limit, and delete it when you stop using the AI check.

**Uninstalling Duel Lens deletes all of the data above from Chrome.**

## 3. What goes over the internet

### 3.1 YGOPRODeck: card data and images (always)

Duel Lens gets its card information from YGOPRODeck (<https://ygoprodeck.com/>), a free Yu-Gi-Oh! card database. It makes three kinds of request:

- **Card data.**
  - Once a week, and when you press **Check for updates now** in Options, it asks YGOPRODeck (`db.ygoprodeck.com`) whether the card database has changed.
  - If it has, it downloads the updated card list.
  - With the card list, it downloads the list of Genesys points: how many points each card costs in the Genesys format.
- **Card images.**
  - The first time Duel Lens shows you a card, it downloads that card's picture from `images.ygoprodeck.com`.
  - It also downloads small pictures of up to three other possible matches.
  - It keeps the latest 1,500 pictures, so it doesn't download them again.
- **New cards' artwork.**
  - When new cards are released, it downloads their artwork from `images.ygoprodeck.com`.
  - It turns the artwork into numeric fingerprints on your computer, so it can recognise those cards, and then discards the images.
  - This happens when the weekly check finds new cards, after you install Duel Lens or start Chrome (at most once a day), and when you press **Update now** in Options.

These requests don't contain anything from your screen, and Duel Lens adds no identifier or account information to them. Like any website your browser contacts, YGOPRODeck receives your **IP address**, your browser's standard request information (such as its user agent), and **the address of each file requested**. So it can see which card pictures your browser downloads. See YGOPRODeck's privacy policy: <https://ygoprodeck.com/privacy-policy/>.

### 3.2 Anthropic: the AI check (only if you turn it on)

The AI check is **off by default**. To use it, you have to:

1. turn it on in Options;
2. allow Duel Lens to contact `api.anthropic.com` (Chrome asks you);
3. paste your own Anthropic API key.

When a match is unsure and you press **Ask AI**, Duel Lens sends one request **directly from your browser to Anthropic's API**, containing:

- the image you selected (the card, plus a small margin around it);
- the names of up to 5 cards Duel Lens thinks it might be;
- a fixed instruction asking Claude to name the card;
- the Claude model chosen in Options;
- your API key, which Anthropic uses to identify your account;
- technical information added by Anthropic's software library: the library's version, and your browser's name and version.

The **Test** button in Options sends only the word "ping", with your key.

Anthropic receives this data under **your own agreement with Anthropic**, and handles it under Anthropic's policies:
- privacy policy: <https://www.anthropic.com/legal/privacy>;
- how long Anthropic keeps API data: <https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data>.

We never receive your key, your images or Claude's answers. Anthropic charges your account for these requests.

### 3.3 Links you open

Duel Lens shows links to other websites: YGOPRODeck (a card's page, and its home page), YouTube (the moment a card appeared), and Anthropic's Console and price list. They open only when you click them, and those websites' own privacy policies apply.

### 3.4 Nothing else

Duel Lens has no server of its own and no user accounts. It has no analytics, crash reporting, advertising or tracking. It doesn't load code from the internet: its recognition models and software are inside the extension.

## 4. What we collect

**Nothing.** We don't operate any server that Duel Lens sends data to. We don't receive your history, your images, your settings or your API key. We don't sell, rent or share personal information, and we don't use any data for advertising or for any purpose other than the extension's features.

Because your data never reaches us, we can't look at it, export it or delete it for you. It's on your computer and under your control (section 2). For data that YGOPRODeck or Anthropic hold, contact them.

## 5. Why Duel Lens asks for its permissions

| Permission | Why |
|---|---|
| activeTab | To take a screenshot of the current tab and show the selection there, only after you press the shortcut or click the icon |
| scripting | To add Duel Lens's selection layer and card pop-up to that tab when you start a scan |
| offscreen | To run the recognition models in a hidden extension page |
| storage, unlimitedStorage | To keep your settings, history, the card database, card pictures and the artwork index on your computer |
| sidePanel | To show the scanned card and your history in Chrome's side panel |
| alarms | For the weekly card-data check, and to close the recognition engine when it's idle |
| Access to `images.ygoprodeck.com` | To download card pictures and new cards' artwork (section 3.1) |
| Optional access to `api.anthropic.com` | Only for the AI check, and requested only when you turn it on (section 3.2) |

## 6. Children

Duel Lens isn't directed at children under 13, and it doesn't collect personal information from anyone.

## 7. Where the data is processed

Everything described in sections 1 and 2 happens on your computer. YGOPRODeck and Anthropic may process the requests described in section 3 in other countries, including the United States. See their privacy policies.

## 8. Chrome Web Store User Data Policy

Duel Lens's use of information complies with the Chrome Web Store User Data Policy, including the Limited Use requirements (<https://developer.chrome.com/docs/webstore/program-policies/limited-use>).

## 9. Changes to this policy

We'll update this page, and its effective date, whenever Duel Lens's handling of data changes. If a new version would send more data off your computer, it will tell you in the extension before that happens.

## 10. Contact

Questions or requests: mathulbrich@gmail.com.
```
