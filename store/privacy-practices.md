# Duel Lens: Privacy practices tab (draft answers)

Status: draft, updated 2026-09-29 for the **store build**. That is what `npm run release` builds, and a plain `node build.mjs` too. In the store build:
- the manifest is 0.9.0 and asks for host access to `https://images.ygoprodeck.com/*` (decision D2, decided 2026-09-29: every build, the store build included, shows YGOPRODeck's official card images); the Anthropic origin stays optional;
- the pop-up and the side panel show the matched card's official picture, downloaded from YGOPRODeck once per card and cached;
- new cards' artwork is downloaded, fingerprinted and kept in the self-updating artwork index;
- a first-run consent step comes before any scan;
- there is no DRAW2: its models never shipped, no bundle has its code either (confirmed in `a6-phase1-report.md`), and it is now deleted from the repository too (`a6-phase2-report.md`, A6 phase 2 — see section 8);
- the zip ships click to scan (our own card detector runs on every scan, since A4): face-up cards are outlined on the frozen frame, and clicking one scans it; dragging a box still works too.

Nothing is submitted. Each answer below is written to be pasted into the Developer Dashboard's Privacy practices tab. Under each one is the code it relies on, so the lead can re-check it against the release zip. **If the code changes, these answers change with it**; "All information provided in the privacy fields … must be up to date and accurate" (listing requirements).

A build made with `--no-remote-images` is the **crop build** instead (kept for a one-flag rollback): the popover and side panel show the user's own crop, no card image or artwork is downloaded, and the manifest asks for no host permission. It needs the variant answers noted in sections 0, 2 and 4.

Sources (checked 2026-09-29):
- The tab itself: https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- User data policy FAQ (local-only data must be disclosed too; a privacy policy is required even then): https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
- Limited Use: https://developer.chrome.com/docs/webstore/program-policies/limited-use
- Disclosure requirements (prominent disclosure and consent): https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements
- Policy update of 2026-07-01, enforced from 2026-08-01 ("all data collection be prominently disclosed to the user"; data must be "strictly necessary" to the single purpose): https://developer.chrome.com/blog/cws-policy-updates-2026
- MV3 remote code rules: https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements and https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code
- Violation reference (Purple Lithium, Purple Nickel, Purple Copper, Purple Potassium, Red Titanium, Blue Argon): https://developer.chrome.com/docs/webstore/troubleshooting
- activeTab: https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
- captureVisibleTab ("either the <all_urls> permission or the activeTab permission"): https://developer.chrome.com/docs/extensions/reference/api/tabs
- Offscreen reasons: https://developer.chrome.com/docs/extensions/reference/api/offscreen
- Permission warnings (none for activeTab, scripting, offscreen, storage, unlimitedStorage, sidePanel, alarms): https://developer.chrome.com/docs/extensions/reference/permissions-list

---

## 0. What actually happens to data (the basis for every answer)

Line numbers were re-checked against the code for this pass (2026-09-29, against `final-review.md`).

| Data | What Duel Lens does with it | Leaves the computer? | Code |
|---|---|---|---|
| Consent | A fresh install opens the welcome page. Its "Before your first scan" step says what Duel Lens handles, and **Agree and start** stores the date. Until then, the scan shortcut and the toolbar button only open that step: no screenshot, no script in the page, no history. | No | `src/background/index.ts:34-38`; `src/background/scan.ts:131-134`; `src/background/consent.ts`; `src/welcome/consent.tsx` |
| Screenshot of the visible tab | Taken only when the user presses the scan shortcut or clicks the toolbar button, after consent. Shown as the frozen frame, and passed to the offscreen document, which runs Duel Lens's own card detector on it to outline the face-up cards it finds (`src/offscreen/index.ts`). Held in memory for that scan only. | No | `src/background/scan.ts:34`, `:127-148`; `src/content/index.ts:91-119` |
| The current frame of a `<video>` on the page | Drawn to an in-page canvas at the video's resolution when the scan starts, so the crop is sharp. Memory only. | No | `src/content/capture.ts:88` |
| The crop (the user's box plus a 4% margin, PNG) | Matched by the offscreen engine against the bundled and self-updating artwork index. Shown in the popover as the card's picture only in the crop build (`--no-remote-images`); the store build shows the matched card's official picture instead. | Only to Anthropic, and only when the user presses "Ask AI" | `src/content/capture.ts:13`, `:187-269`; `src/content/app.tsx:190`, `:315`; `src/background/router.ts:186` (`recognize`), `:311-348` (`ask-ai`) |
| A small copy of the crop | **Crop build only** (`--no-remote-images`): after each scan that identified a card, a JPEG at most 160 px on its longer side (about 6 kB), kept with the history entry so the side panel can show what was scanned. Removed with its entry (past 300 scans), by "Clear history" and on uninstall. The store build keeps no picture of its own; the side panel shows the card's official picture. | No | `src/background/router.ts:137-141`, `:252`; `src/background/thumbnail.ts:7-8`; `src/background/history.ts:11-14`, `:22-28`, `:43-46`, `:65-71`; `src/sidepanel/app.tsx:117-125`, `:164` |
| Page address, page title, video time of each scan, the matched card, its score, whether the user picked another card | Saved as the scan history shown in the side panel (newest 300). "Clear history" deletes it. | No | `src/content/app.tsx:154-156`; `src/background/router.ts:240-244`; `src/background/history.ts:10`, `:23-28`; `src/sidepanel/app.tsx:132-133` |
| Settings: AI check on/off, model, **the user's Anthropic API key** | Stored in `chrome.storage.local`, which is restricted to extension pages (`setAccessLevel TRUSTED_CONTEXTS`), so content scripts can't read the key. | The key goes to api.anthropic.com as the request's credential, only with the AI check on and when the user presses "Ask AI" or "Test" | `src/background/settings.ts`; `src/background/index.ts:22-28`; `src/background/ai.ts:46-49` |
| Candidate card names (up to 5) | Added to the AI prompt. | To Anthropic with the crop, as above | `src/background/router.ts:316`; `src/background/ai.ts` (`buildIdentifyRequest`, `buildPrompt`) |
| Card database | Public YGOPRODeck data (including each card's Genesys points) in IndexedDB, seeded from the bundled `data/cards.json` and replaced, with fresh Genesys points, when YGOPRODeck's database version changes. | Requests go to YGOPRODeck (below); nothing about the user is sent | `src/background/card-store.ts:66-79`, `:108-143`, `:227-290` |

**Not in the store build:**
- the debug "Save crops" option: `--dev` and `--e2e` builds only (`src/options/app.tsx:408`, `build.mjs:109`).

**Only in the store build (every build but the crop build, `--no-remote-images`):**
- the card-image cache and the artwork downloads (`src/background/router.ts:106`, `:115`; `src/background/index.ts:47`, `:67`, `:85`).

The store build's manifest and bundles name `images.ygoprodeck.com` (decision D2: `build.mjs`'s `IMAGES_HOST`, and the requests themselves). Only the crop build (`--no-remote-images`) has 0 hits for `images.ygoprodeck.com`, `cards_cropped` and `card-images-v1` in its bundles, and no host permission (`tools/release.mjs`'s `verifyBuild`, `fix-f2-report.md`).

Network requests in the store build, all over HTTPS:

| Host | Requests | When | What it learns |
|---|---|---|---|
| db.ygoprodeck.com | `api/v7/checkDBVer.php`, then `api/v7/cardinfo.php?misc=yes` and `api/v7/cardinfo.php?format=genesys&misc=yes` (the Genesys points) only if the version changed. Plain GETs with no custom header and no cookie; the same three URLs for every user, naming no card. | The weekly alarm (its first run is a week after install; `src/background/index.ts:53-58`), and "Check for updates now" in Options (`src/options/app.tsx:194`) | Standard request metadata: the IP address, the user agent, and which of the three files was requested. Not which cards the user scans. |
| images.ygoprodeck.com | `images/cards/<id>.jpg` and `cards_small/<id>.jpg`, to display cards, cached after the first view; `cards_cropped/<id>.jpg`, new cards' artwork, at most 8 per second | The first time each card or artwork is needed (section 3.1 of the privacy policy) | Which card pictures and artworks the user's browser asks for, so which cards the user looks at |
| api.anthropic.com | Messages API: the crop (base64 PNG), a fixed prompt with up to 5 candidate names, the chosen model; the user's key in the auth header | only with the AI check on, when the user presses "Ask AI" (or "Test", which sends the word "ping") | What the request contains; Anthropic's own terms apply to the user's key |

The images.ygoprodeck.com URLs name the card, so YGOPRODeck can see which cards the user looks at. Only the crop build (`--no-remote-images`) makes none of these requests, and asks for no host permission.

No analytics, no telemetry, no error reporting, no developer server, no account. The two outbound links (the card's YGOPRODeck page from the popover, a scan's YouTube time in the side panel) are ordinary links that open only when the user clicks them (`src/content/card-view.tsx:128`, `src/sidepanel/app.tsx:44`).

---

## 1. Single purpose description

Paste:

```text
Duel Lens identifies a Yu-Gi-Oh! trading card that the user points at on the current page, usually in a duel video or tournament stream, and shows that card's name and full text in place. The user presses a keyboard shortcut or the toolbar button, then clicks the card Duel Lens outlines on the frozen frame (or draws a box around it), and Duel Lens matches it against its bundled artwork index, on the user's computer. Everything else serves that one purpose: a side panel that keeps the cards the user looked up, an options page for card-data updates, and an optional AI check that asks Anthropic's Claude about an unclear card using the user's own API key.
```

Why this wording: the single-purpose FAQ accepts "a narrow focus area or subject matter" with several
functions related to it (https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq).
The side panel, options and AI check all act on the same scanned card, so the statement names them,
which heads off a "bundled unrelated functionality" reading ("Red Magnesium" family).

---

## 2. Permission justifications

One paste block per permission the dashboard lists (`extension/manifest.json:24-25`). Each text is
under 600 characters. The store build declares the host permission `https://images.ygoprodeck.com/*`
(decision D2), whose install warning reads "Read and change your data on images.ygoprodeck.com"; none
of its other permissions shows an install warning. Chrome asks for api.anthropic.com only when the
user turns the AI check on.

### activeTab

```text
Duel Lens only touches the tab where the user invokes it. When the user presses the scan shortcut (Alt+Shift+Y) or clicks the toolbar button, activeTab lets Duel Lens take one screenshot of the visible tab (chrome.tabs.captureVisibleTab), which becomes the frozen frame on which the user clicks a card (or draws a box around one), and inject the popover that shows the card. Before the user has agreed on Duel Lens's welcome page, the shortcut only opens that page. We chose activeTab instead of broad host access so that Duel Lens can't see any page until the user asks it to.
```

Code: `src/background/index.ts:90-101` (command and action click), `src/background/scan.ts:131-134` (the
consent gate), `:34` (captureVisibleTab), `:36-38` (executeScript). The store build has no `<all_urls>`:
only the E2E test build adds it (`build.mjs:210-213`, `--e2e` into `dist-e2e/`), and it must never be
uploaded; `npm run release` refuses it.

### scripting

```text
Used with activeTab to inject Duel Lens's own content script (content.js, packaged with the extension) into the current tab after the user presses the shortcut or clicks the toolbar button: chrome.scripting.executeScript({ files: ['content.js'] }). The content script draws the frozen frame, the selection box and the popover with the card's details. Nothing is injected into a page the user hasn't invoked Duel Lens on, and only packaged files are injected.
```

Code: `src/background/scan.ts:36-38`, called from `startScan` (`:127`) only after the consent check.

### offscreen

```text
Card recognition runs on the user's computer with ONNX Runtime Web (WebAssembly, multi-threaded with web workers). A Manifest V3 service worker can't create workers, so Duel Lens opens one offscreen document (reason WORKERS) that loads the packaged models and card index, finds the cards on the captured screenshot, and matches the one the user picks. It is closed automatically after 5 minutes without use to free its memory.
```

Code: `src/background/offscreen-client.ts:61-64` (createDocument, `Reason.WORKERS`, justification
string), `:27-29` and `:104-109` (idle close); `src/offscreen/web-runtime.ts:37-38` (ORT's own files
from `ort/`, worker threads when cross-origin isolated).

### storage

```text
chrome.storage.local keeps the user's settings (whether the optional AI check is on, the chosen model, and the user's own Anthropic API key), the date the user agreed to Duel Lens's data handling, and the scan history shown in the side panel (the newest 300 scans: card, page address and title, and time). chrome.storage.session remembers which scan the side panel shows. It all stays on the user's device, and web pages and content scripts can't read it.
```

Code: `src/background/settings.ts`, `src/background/consent.ts`, `src/background/history.ts:8-71`,
`src/background/index.ts:22-28` (setAccessLevel).

**Variant for the crop build** (`--no-remote-images`): the history also keeps a small picture (about
6 kB) of what the user selected with each entry, for the side panel (`src/background/history.ts`,
`src/background/thumbnail.ts`).

### unlimitedStorage

```text
Duel Lens keeps its card data on the user's computer, so recognition works offline and the card list isn't downloaded again and again: about 14,600 cards (roughly 9 MB of text) in IndexedDB. It also caches the official card images it has shown (capped at the most recent 1,500) and keeps the self-updating index it uses to recognise newly released cards' artwork. unlimitedStorage keeps all of this from being evicted when the disk is under pressure, which would otherwise force a full re-download from YGOPRODeck.
```

Code: `src/background/card-store.ts:66-79` (IndexedDB `duel-lens`), `src/background/image-cache.ts:4`, `:7`
(`CACHE_NAME`, `MAX_CACHED_IMAGES = 1500`), `src/background/index-update.ts` and `src/offscreen/delta-index.ts`
(the artwork index, IndexedDB `duel-lens-index`). In the crop build (`--no-remote-images`), also
`src/background/history.ts` (`chrome.storage.local`: the history's pictures, about 6 kB each, instead
of the image cache and the artwork downloads). Size of the seed: `extension/data/cards.json`, 8.6 MB,
14,590 cards (YGOPRODeck database version 147.20, 2026-09-28).

### sidePanel

```text
Duel Lens has a side panel (Alt+Shift+U, or "Keep in side panel" in the popover) that shows the looked-up card in full and the list of cards scanned, so the user can keep reading while the video plays. The permission declares the panel and lets Duel Lens open it with chrome.sidePanel.open in response to the user's shortcut or click.
```

Code: `extension/manifest.json:36`, `src/background/index.ts:90-96`, `src/background/router.ts:294-302` (`show-in-panel`).

### alarms

```text
Two alarms. A weekly one checks YGOPRODeck's card-database version and downloads the card list and its Genesys points only when it has changed, so card text, ban-list status and Genesys points stay current. A one-shot alarm closes the offscreen recognition engine after 5 minutes without scans to release its memory; a timer would not survive the service worker being stopped.
```

Code: `src/background/index.ts:13-14`, `:53-58`, `:72-88`; `src/background/offscreen-client.ts:27-29`,
`:104-109`.

### Host permissions

**The store build asks for `https://images.ygoprodeck.com/*`** (`extension/manifest.json`; `build.mjs`'s
`IMAGES_HOST`, added for every build but the crop build, decision D2). This server sends no CORS
headers, so reading its images needs host access, and Chrome's install warning reads "Read and change
your data on images.ygoprodeck.com". It needs no host permission for YGOPRODeck's card data: the API
answers `Access-Control-Allow-Origin: *`. The compliance round checked this with curl and with a real
build that had no host permissions in Chrome for Testing: the version check and the card list both
answered 200, and a control request to `images.ygoprodeck.com` failed
(`.superpowers/sdd/2026-09-28-duel-lens-v1/compliance-report.md`, "Decisions I took", 1); the Genesys
list answers the same way (curl, 2026-09-29). The refresh's three requests are plain GETs only, which
need no preflight; a unit test keeps it that way (`src/background/card-store.test.ts:202-215`).

Paste:

```text
images.ygoprodeck.com: to download and cache the official card image shown next to a recognised card, and new cards' artwork for the self-updating index. This server sends no CORS headers, so reading its images needs host access. The requests carry only public card IDs and nothing the user typed or captured; like any web request, they reveal the user's IP address and which images were requested. No page on this site is read or changed. (The card list itself comes from YGOPRODeck's public API, which allows cross-origin requests, so it needs no host permission.)
```

If the dashboard asks about the optional host permission, paste:

```text
api.anthropic.com (optional): requested only when the user turns on the AI check in Options. Then, only when the user presses "Ask AI" on an unsure match (or "Test"), Duel Lens sends that crop and up to five candidate card names to Anthropic's API with the user's own key. Without this permission, Duel Lens sends nothing to Anthropic.
```

Code: `src/options/app.tsx:154-173` (`chrome.permissions.request` for `https://api.anthropic.com/*`;
turning the check off calls `chrome.permissions.remove`); `src/background/router.ts:318`, `:365` (Ask AI
and Test refuse without the permission).

**Variant for the crop build** (`--no-remote-images`; kept for a one-flag rollback; not what
`npm run release` builds by default). Its manifest asks for no host permission at all
(`extension/manifest.json` has no `host_permissions` key), and it shows no picture from YGOPRODeck.
If the crop build is ever submitted instead: delete the images.ygoprodeck.com paragraph above, and
also change the listing's PRIVACY and PERMISSIONS paragraphs, section 4 below (the image cache under
unlimitedStorage) and the hosted privacy policy (`docs/release/privacy-policy.md`: Appendix C has the
crop build's edits; Appendix D's command, with the first flag set to `false`, reprints its text).

---

## 3. Remote code

Select: **"No, I am not using remote code."**

Why this is accurate (for our records; the field needs no text when "No" is selected):
- Every script and WebAssembly module is in the package. ONNX Runtime Web loads its `.mjs` and `.wasm`
  from the package's `ort/` folder, never from a CDN (`src/offscreen/web-runtime.ts:37`,
  `build.mjs`). No other WebAssembly ships (OpenCV.js was removed with A4).
- The CSP is `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` (`extension/manifest.json:38-40`):
  no remote script and no `unsafe-eval`, and no code in the package builds functions from strings.
- What comes from the network is data: card JSON and card images from YGOPRODeck, and JSON text from
  Anthropic. The JSON is parsed with `JSON.parse` and never executed (`src/background/ai.ts:199`); the
  images are decoded and drawn as pictures, never executed. The remote code guide says remotely hosted
  code "does not include data or things like JSON or CSS".
- Note for the reviewer: `background.js` bundles the official Anthropic TypeScript SDK (`@anthropic-ai/sdk`); only api.anthropic.com is contacted, and only after the user turns on the AI check and presses "Ask AI" or "Test". The other hosts named in the bundle are unused SDK code.
- The recognition model (`models/*.onnx`) and the index (`data/index-*`) ship in the package. They are
  weights and vectors run by the packaged runtime, not code. The store build downloads new cards'
  artwork (images, i.e. data) from YGOPRODeck to extend this index automatically; nothing downloaded is
  ever executed, only decoded as a picture and embedded by the packaged model. Only the crop build
  (`--no-remote-images`) downloads no artwork: there, newly released cards reach the index with
  extension updates instead.

---

## 4. Data usage

The form asks which user data the item collects "now or in the future". Per the user data FAQ, data
that is only processed or stored on the device counts as handled and must be disclosed, so the answer
covers local handling too.

| Category (dashboard examples) | Answer | Why |
|---|---|---|
| Personally identifiable information (name, address, email, age, ID number) | **No** | None is asked for or read. |
| Health information | **No** | |
| Financial and payment information | **No** | Duel Lens is free; Anthropic bills the user's own account, outside the extension. |
| Authentication information (passwords, credentials, PIN) | **Yes** | The user's own Anthropic API key: stored locally, sent only to api.anthropic.com to authenticate the user's AI check requests. Never sent anywhere else. |
| Personal communications (emails, texts, chat) | **No** | Nothing reads them. A screenshot can show whatever is on screen, but only the user's box around a card is ever matched or (on "Ask AI") sent; the crop build (`--no-remote-images`) also keeps a small picture of it in the history. |
| Location (region, IP address, GPS) | **No** | Duel Lens doesn't collect it. YGOPRODeck and Anthropic see the IP address of requests, as any server does; the privacy policy says so. |
| Web history (pages visited, their titles and times) | **Yes** | The scan history records the page address, page title and time of each scan, on the computer only, shown in the side panel and deletable there. |
| User activity (clicks, mouse position, scrolling, keystrokes) | **No** | No monitoring or logging. The drag and the popover's keys (K, C, ←, →, Esc) are handled in the moment and not recorded. The history's `corrected` flag records which card the user picked for a scan; it is part of the history entry, not activity tracking. |
| Website content (text, images, sounds, videos, hyperlinks) | **Yes** | The screenshot of the visible tab and the video frame are processed locally to cut out the card, and matched against the bundled and self-updating artwork index. With the optional AI check, the crop is sent to Anthropic when the user presses "Ask AI". In the crop build (`--no-remote-images`), a small copy (160 px) of the user's crop is also kept with each scan in the local history, shown in the side panel, and deleted with it. |

If the dashboard also asks what each checked category is used for, the answer for all three is **app
functionality** only: no analytics, advertising, personalisation or developer communications.

The store build's cached card images and artwork (from YGOPRODeck, decision D2) are public images, not user data, and don't change any of the boxes above.

---

## 5. Certifications

Tick all three. Each is true for the code above:

| Statement (dashboard wording) | True because |
|---|---|
| I do not sell or transfer user data to third parties, outside of the approved use cases | The only transfer is the crop, candidate names and key to Anthropic, which the user turns on and triggers per request, to provide the feature (Limited Use: transfer "necessary to providing or improving your single purpose"). YGOPRODeck receives no user-provided data, only the network metadata of ordinary requests: the IP address, the user agent, and which of its three public card-data files was requested (none names a card), plus, in the store build, which public card images and artwork were fetched. |
| I do not use or transfer user data for purposes that are unrelated to my item's single purpose | Everything above serves identifying the card on screen. |
| I do not use or transfer user data to determine creditworthiness or for lending purposes | Nothing of the kind. |

---

## 6. Privacy policy URL

- Field: **Privacy policy URL** → `https://gist.github.com/mathulbrich/a72fdebc8363a86bd16679ba1cbbea4e` (the user hosts it: decision D5).
- Text: host **Appendix D of `docs/release/privacy-policy.md`**, word for word. It is exactly what the
  store build's bundled `privacy.html` shows (rendered from `src/legal/policy.ts`, and a drift test keeps
  the doc and the code in step). It covers sections 0 and 4: the three data categories (card data and
  images, the AI check, the local storage), both third parties, retention (history until cleared, up to
  300 entries; everything removed on uninstall), the consent step, the permissions (including host
  access to `images.ygoprodeck.com`, decision D2) and a contact.
- It includes the Limited Use affirmative statement: "Duel Lens's use of information complies with the
  Chrome Web Store User Data Policy, including the Limited Use requirements."
- D4 is filled in (29 September 2026): "the Duel Lens project", mathulbrich@gmail.com, effective
  29 September 2026, in the doc and in `src/legal/policy.ts`.
- **Hosted (D5, 29 September 2026):** a public GitHub gist, https://gist.github.com/mathulbrich/a72fdebc8363a86bd16679ba1cbbea4e, printed from
  `src/legal/policy.ts` with Appendix D's reprint command (so it equals the bundled `privacy.html`).
- Hosting (user): a public HTTPS page with no login and no redirect, e.g. GitHub Pages or a public
  repository file. A broken, private or off-topic URL is "Purple Lithium".
- The extension itself needs no URL: its welcome page, Options and consent step link to the bundled
  `privacy.html` (`src/welcome/links.tsx:24`). The hosted URL goes only in this field and in the
  listing's `https://gist.github.com/mathulbrich/a72fdebc8363a86bd16679ba1cbbea4e` (`store/listing.md`, `store/faq.md`).
- If a data practice changes after publishing, the policy, this tab and an in-product notice must
  change with it (disclosure requirements, and the 2026-07 update).

---

## 7. Prominent disclosure: where users see each practice before it happens

The Disclosure Requirements policy asks for a prominent disclosure and "affirmative and informed
consent", and the FAQ says it "must not be located only in a privacy policy" and "must occur within the
Product's user interface". Since 2026-08-01, "all data collection" must be prominently disclosed.

| Practice | Consent | In-product disclosure | Status |
|---|---|---|---|
| Everything a scan handles | **Agree and start** in the welcome page's "Before your first scan" step (opened on install). A scan before that opens this step instead of scanning. | Four points, the default (official-images) variant of `docs/release/disclaimers.md` §4a (`src/welcome/copy.ts:66-99`): Screenshots; History ("with the address and title of each page"); Card data and pictures ("It downloads them from YGOPRODeck, which can see your IP address and which card pictures your browser asks for"); AI check (off). The crop build (`--no-remote-images`) shows the older text instead: History adds "and a small picture of what you selected", and Card data reads "The picture it shows beside a card is the one you selected, not one from the internet." | **Done** (`src/welcome/consent.tsx`, `src/background/scan.ts:131-134`). Every E2E run checks the gate (`compliance-report.md`, "E2E"). |
| Screenshot and crop, processed locally | The user presses the shortcut or the button for each scan | The consent step, and the welcome page's "On this computer" (`src/welcome/copy.ts:102-117`) | Done |
| Local scan history (page address, title, time; a small picture too, in the crop build) | Shown in the side panel with "Clear history" | The consent step's History point, and "Your history and settings…" on the welcome page (`src/welcome/copy.ts:110-116`) | Done |
| AI check: the crop and up to 5 names go to Anthropic with the user's key | The Options toggle, then Chrome's permission prompt, then "Ask AI" per crop | The text below, shown above the toggle (`src/options/app.tsx:48-51`, `:276`); a test fails if it drifts from this file (`src/options/app.test.tsx:425-428`) | Done |
| Debug crops | Not in the store build | None needed | N/A (developer builds only) |

The AI check's disclosure (in Options, above the toggle, word for word):

```text
Off by default. When you press "Ask AI" on an unsure match, Duel Lens sends the cropped image of that card and up to five candidate card names to Anthropic (api.anthropic.com) with your API key. Nothing is sent until you press Ask AI. Anthropic's terms and privacy policy apply to those requests, and they are billed to your key.
```

---

## 8. Things in the code that would make these answers wrong, or draw a rejection

Each is also an item in `docs/release/RELEASE-CHECKLIST.md`. Status as of 2026-09-29, around 05:45.

1. **AI disclosure missing in the UI.** Done: see section 7.
2. **Optional permission not enforced.** Done (2026-09-29, around 12:00; checklist C5):
   - Ask AI and Test refuse without the permission (`src/background/router.ts:318`, `:365`), so nothing is sent to Anthropic after the user revokes it.
   - The popover offers "Ask AI" only with the permission too: `aiEnabled` needs the setting, the key and the permission (`src/background/router.ts:223-225`).
   - Switching the AI check off gives the permission back (`chrome.permissions.remove`, `src/options/app.tsx:154-173`). The key stays, so switching the check on again asks only for the permission; clearing the key field deletes the key (there is no separate "Remove key" button).
3. **Test-only surfaces in the store build.** Done: each is compiled only into the builds that need it.
   - `duelLensDebug`: E2E builds only (`src/background/index.ts:141`).
   - The `data-duel-lens-*` state mirror: E2E builds only (`src/content/index.ts:144`).
   - The Options Debug section: `--dev` and `--e2e` builds only (`src/options/app.tsx:408`).

   Evidence: `npm run release`'s verification of store builds (2026-09-29, 05:30 and 06:00) gives 0 warnings, and 0 hits for `duelLensDebug` and `data-duel-lens-state` in every bundle.
4. **Obfuscation look-alike** ("Red Titanium": "base64 encoding, character encoding, or other
   obfuscation techniques to conceal code"). **Done (A4, a4-report.md).** Store builds made on
   2026-09-29 up to 06:00 had, at line 188 of `offscreen.js`, a single string literal of 17,540,593
   characters: OpenCV.js's WebAssembly module, embedded by its Emscripten single-file build. Our own card
   detector replaced OpenCV, which is gone from the code and from `package.json`: `offscreen.js` is now
   188 KB and its longest line 1,063 characters, and `npm run release` refuses any bundle that contains
   OpenCV.js.
5. **AGPL code bundled** (not a store rule, but "don't infringe IP"). **Extension: done (A6 phase 1).
   Repository: done too (A6 phase 2).**
   - DRAW2's models never shipped by default, and `--with-draw2` is gone from `build.mjs` (05:53).
   - A store build made 2026-09-29 at 05:30 still bundled DRAW2's ported pipeline ("draw2" 76 times in
     `offscreen.js`).
   - The 06:00 build no longer did, and `a6-phase1-report.md` confirms it for good: no extension entry
     point imports `src/offscreen/draw2/`, directly or indirectly (proven per entry with esbuild
     metafiles), and no bundle carries any of DRAW2's modules or identifiers — 0 "draw2" hits, not even
     the 3 comment-only ones the 06:00 build still had.

   A6 phase 2 has since deleted `src/offscreen/draw2/` and its tests, and the DRAW2-only tools, from the
   repository, and moved `extension/models/draw2/` into the gitignored `data/draw2-archive/models/`
   (`a6-phase2-report.md`). `grep -rni draw2 src tools test build.mjs package.json README.md` now gives
   25 lines in 6 files, none in `src/`, `test/`, `build.mjs`, `package.json` or `README.md` — only data
   provenance and the release guard remain. That never changed what ships: `npm run release` refuses any
   build with DRAW2 code in it, and this was independently re-checked against the release zip already on
   disk (0 DRAW2 and 0 OpenCV hits).
6. **The crop build** (`--no-remote-images`, a one-flag rollback if it's ever needed) needs the variant
   answers in sections 0, 2 and 4: no host permission and no install warning, no image cache, no artwork
   downloads, and YGOPRODeck never seeing which card images are requested (it downloads none). The
   privacy policy changes with it too (`docs/release/privacy-policy.md`, Appendix C and D).
