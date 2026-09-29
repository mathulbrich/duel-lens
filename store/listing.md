# Duel Lens: Chrome Web Store listing (draft)

Status: draft for the first public release (0.9.0, the first public beta per
`docs/release/packaging.md`), prepared 2026-09-29, updated the same day for the **store
build** (`npm run release`). In that build:
- the popover and the side panel show the matched card's official picture, downloaded from YGOPRODeck and cached;
- new cards' artwork is downloaded for the self-updating index;
- a welcome page asks for consent before the first scan;
- there is no DRAW2. Its models never ship, and no bundle has its code either (confirmed in
  `a6-phase1-report.md`); the DRAW2 folder itself is now deleted from the repository too (`a6-phase2-report.md`,
  A6 phase 2), which never affected what ships. `npm run release` refuses any build that still has it, so
  no listing text relies on it.

Nothing is submitted. The user pastes these texts into the Developer Dashboard; the lead keeps them
in step with the build.

**The rule for every field: describe the build that is uploaded, nothing more.** "Click to scan" is in
the listing since the zip ships it: every build registers our card detector (`src/offscreen/index.ts`,
A4), and `npm run release` refuses a build without its model. Official card images are too: every build
shows YGOPRODeck's official card images by default (decision D2, decided 2026-09-29). Only the crop
build (`--no-remote-images`, kept for a one-flag rollback) shows the user's own selection instead. Where
a text here depends on a build decision, it says which one.

Sources (checked 2026-09-29):
- Listing fields and assets: https://developer.chrome.com/docs/webstore/cws-dashboard-listing
- Image specs: https://developer.chrome.com/docs/webstore/images
- Listing best practices: https://developer.chrome.com/docs/webstore/best-listing
- Title, summary, keyword-spam and testimonial rules: https://developer.chrome.com/docs/webstore/program-policies/listing-requirements
- Impersonation and IP: https://developer.chrome.com/docs/webstore/program-policies/impersonation-and-intellectual-property
- Categories: https://developer.chrome.com/docs/webstore/best_practices
- Manifest `name` (max 75 chars): https://developer.chrome.com/docs/extensions/reference/manifest/name
- Manifest `description` (max 132 chars, plain text): https://developer.chrome.com/docs/extensions/reference/manifest/description

---

## 1. Where each field comes from

| Dashboard field | Source | Limit | Our value |
|---|---|---|---|
| Title | manifest `name` ("Title from package"; can't be edited in the dashboard) | 75 chars | section 2 |
| Summary | manifest `description` ("Summary from package") | 132 chars, plain text | section 3 |
| Description | typed in the dashboard | long (the field shows a counter; ours is ~4,700 chars) | section 4 |
| Category | dashboard | one | section 5 |
| Language | dashboard | one | English |
| Store icon | uploaded | 128×128 PNG | `store/assets/icon-128-store.png` (96×96 art with 16 px transparent padding; see `store/screenshots-plan.md` section 6) |
| Screenshots | uploaded | 1–5, 1280×800 (or 640×400) | `store/screenshots/01…05` |
| Small promo tile | uploaded | 440×280 PNG/JPEG, required | `store/promo/small-440x280.png` |
| Marquee promo tile | uploaded | 1400×560, optional | skip for v1 (only used if the store features the item) |
| Promo video | YouTube link | the docs' wording lists it with the required assets; the dashboard has let listings go without one. Check when filling the form | optional plan in `store/screenshots-plan.md` |
| Homepage URL | dashboard | optional | the public repo, if the user publishes one |
| Support URL | dashboard | optional | the repo's Issues page, or a support email |
| Mature content | dashboard | yes/no | No |

Changing the title or summary means editing `extension/manifest.json` (packaging workstream), bumping
the version and uploading a new zip. So pick them before the first upload.

A missing description, icon or screenshot is an automatic rejection ("Yellow Zinc", listing requirements).

---

## 2. Name and subtitle

Keep **Duel Lens** as the product name. There is no separate subtitle field: a subtitle becomes part of
the title (the manifest `name`).

| Option | Title (manifest `name`) | Chars | Note |
|---|---|---|---|
| **A (recommended)** | `Duel Lens – Card Reader for Duel Videos` | 39 | Says what it does in search results; no third-party trademark |
| B | `Duel Lens – Read Cards in Duel Streams` | 38 | Leans on streams |
| C | `Duel Lens` | 9 | Cleanest; the summary carries the explanation |

Rules behind the options:
- **No "Yu-Gi-Oh!" in the title.** Konami's mark in the product's name is the thing most likely to read
  as "produced by or endorsed by Konami" (impersonation policy), and a rights holder can file an IP
  complaint. The trademark appears only descriptively ("reads Yu-Gi-Oh! cards") in the summary and
  description, next to the disclaimer.
- No keyword stuffing ("yugioh card scanner ygo tcg ocg…"). The best-listing guide asks for a short,
  memorable name.
- One name to be aware of: Konami's game "Yu-Gi-Oh! Duel Links" sounds close to "Duel Lens". The
  subtitle in option A makes the difference obvious (a card reader, not a game). The name itself is the
  user's call; this draft keeps it.

If option A or B is chosen: the packaging workstream sets the manifest `name`. The toolbar tooltip
(`action.default_title`, "Duel Lens: scan a card (Alt+Shift+Y)") can stay as it is.

---

## 3. Summary (manifest `description`, max 132 characters)

Plain text only. The manifest already holds the packaging workstream's text (below, 0.9.0). Keep it or
replace it with one of the three options; the packaging workstream edits `extension/manifest.json`.

| # | Text | Chars |
|---|---|---|
| In the manifest now | `Identify trading cards in duel videos and streams: select a Yu-Gi-Oh! card on screen to read its text in place. Unofficial fan tool.` | 132 |
| **1 (recommended)** | `Read the Yu-Gi-Oh! cards in duel videos and streams without leaving the page. Matching runs on your computer. Unofficial fan tool.` | 130 |
| 2 | `Press Alt+Shift+Y, draw a box around a Yu-Gi-Oh! card in a duel video, and read its name and full text right on the page.` | 121 |
| 3 | `Can't read the card that was just played? Box it on screen to see its name and full Yu-Gi-Oh! card text in place.` | 113 |

Why 1: it says what and where, adds the one thing that sets Duel Lens apart (matching on the user's
computer), and keeps the manifest text's "Unofficial fan tool", which answers the affiliation question
in search results. The current manifest text is fine too. Option 2 teaches the gesture but names a
shortcut the user may change; option 3 is the most playful. Options 2 and 3 have no room for
"Unofficial", so the description's disclaimer has to carry it.

Avoid "any card" (the 0.1.0 text said "any Yu-Gi-Oh! card on screen"): DRM video and chrome:// pages
can't be read.

---

## 4. Detailed description

Plain text: the store shows line breaks and the bullet character, not Markdown. Replace
`https://gist.github.com/mathulbrich/a72fdebc8363a86bd16679ba1cbbea4e` with the hosted policy's URL and `mathulbrich@gmail.com` with the contact address
(decisions D5 and D4) before pasting. Checked for the listing rules: "Yu-Gi-Oh!" appears 3 times and
"YouTube" 2 times (the spam rule is unnatural repetition of a keyword more than 5 times); no list of
sites, no testimonials, no "#1"-style claims. About 4,700 characters.

It describes the store build: the popover shows the matched card's official picture, downloaded from
YGOPRODeck. The last paragraph is `docs/release/disclaimers.md` §3.2, in its full "Card data and images"
form; its §3.3 and §8 give the shortened "Card data" wording for a build without card images (the crop
build, `--no-remote-images`).

```text
Duel Lens reads the Yu-Gi-Oh! cards in duel videos. When a player puts down a card you can't read on a tournament stream, press Alt+Shift+Y, drag a box around it, and its name, type and full text appear in a popover right beside it. No new tab, no typing card names into a search box.

HOW IT WORKS
1. After you install Duel Lens, its welcome page opens and explains what Duel Lens handles. Press "Agree and start": Duel Lens scans nothing until you do.
2. Press Alt+Shift+Y, or click the Duel Lens button in the toolbar. The frame freezes.
3. Every card on the frozen frame gets a thin gold outline: click the one you want. For a card without an outline, drag a box around it.
4. Read the card in the popover, next to its official picture. If Duel Lens isn't sure, it says so and shows the closest cards. Pick the right one with the ← and → keys or a click.

FEATURES
• Click to scan: Duel Lens outlines the cards it finds on the frozen frame, including tilted and sideways ones, so there's nothing to frame. Tab and the arrow keys step through them; Enter reads one.
• Reads the card from the video frame itself, at the video's own resolution, so small cards on the playmat stay readable.
• Cards in Defense Position (sideways), upside down or slightly tilted work too.
• Honest about doubt: an unclear match says "Not sure" and lists the closest cards instead of guessing.
• The whole card: effect text, type, attribute, Level, Rank or Link rating and arrows, ATK/DEF, Pendulum Scale, archetype, TCG ban-list status and Genesys points.
• Copy the card text with C. Keep the card in the side panel with K.
• Side panel (Alt+Shift+U): the last card in full, with its official picture, and the list of cards you scanned. On YouTube, a scan's time takes you back to that moment.
• Works over fullscreen video.
• Card text stays current: the card list is checked for updates every week. Newly released cards are recognised once Duel Lens downloads their artwork, usually within a week (Options → Update now does it at once).
• Optional AI check: when a match is unsure, "Ask AI" can send just that crop to Claude with your own Anthropic API key. Off unless you turn it on.

WHERE IT WORKS
Tested most on YouTube tournament streams and videos. It also works on other video sites and on web pages that show card images, wherever Chrome lets extensions run. It can't read DRM-protected video (it says "This video blocks screenshots"), Chrome's own pages, or the Chrome Web Store.

GOOD TO KNOW
• It needs a clear, face-up view of the card. Motion blur, glare, or a hand or another card covering it can prevent a match. Pausing on a clear frame helps.
• A card cut off by the edge of the picture gets a second look as a whole card. At best that's a "Not sure" guess, never a confident one.
• 720p or higher works best. At 480p or lower, Duel Lens suggests raising the video quality.
• Card names and text are in English.
• Face-down cards, sleeves and playmat art can't be read: Duel Lens says it couldn't match the box or isn't sure, and marks a card back as face-down.
• A brand-new card is recognised once Duel Lens downloads its artwork, usually within a week of release (Options → Update now does it at once).
• The first scan loads the recognition engine and takes a moment. After that, a scan usually takes under a second.

PRIVACY
• Before your first scan, Duel Lens shows what it handles and asks you to agree.
• Cards are recognized on your computer, in the browser, by Duel Lens's own models. Screenshots and crops stay on your computer unless you use Ask AI (below).
• Card data and card images (names, text and the official picture beside each card) are downloaded from YGOPRODeck and cached on your computer. Duel Lens sends it no personal information; like any website, it sees your IP address and which card pictures your browser asks for.
• Your scan history (the card, the page's address and title, and the time) stays on your computer. Clear it in the side panel.
• The AI check is off by default. If you turn it on and press "Ask AI", the crop and up to five candidate card names are sent to Anthropic's API with your own key.
• No account, no ads, no analytics.
Privacy policy: https://gist.github.com/mathulbrich/a72fdebc8363a86bd16679ba1cbbea4e

PERMISSIONS, IN PLAIN WORDS
• The page you are on, only when you press the shortcut or click the button: to take the screenshot and show the popover. Duel Lens has no standing access to any page you browse.
• images.ygoprodeck.com: to download and cache the official card image shown next to a recognised card, and new cards' artwork.
• api.anthropic.com: requested only when you turn on the AI check.

KEYBOARD
Alt+Shift+Y scan · Alt+Shift+U side panel · Esc close · ← → other matches · C copy · K keep. Change the shortcuts at chrome://extensions/shortcuts.

Unofficial fan tool. Duel Lens is not affiliated with, sponsored, endorsed or approved by Konami, Studio Dice, Shueisha or TV Tokyo. Yu-Gi-Oh! and the names, text and images of Yu-Gi-Oh! cards are trademarks and copyrights of their respective owners (© Studio Dice/SHUEISHA, TV TOKYO, KONAMI). Card data: YGOPRODeck (ygoprodeck.com). The optional AI check uses Anthropic's Claude with your own API key; Claude and Anthropic are trademarks of Anthropic, PBC, and Duel Lens is not affiliated with Anthropic.

Rights holders and questions: mathulbrich@gmail.com
```

Claims to re-check against the final build before pasting (the lead ticks these; line numbers as of
2026-09-29, re-checked against `final-review.md`):
- [x] The popover shows Level/Rank/LINK, arrows, ATK/DEF, Scale, archetype, the TCG ban status and Genesys points (`src/content/card-view.tsx:44-64`, `:99-103`).
- [x] "At 480p or lower, Duel Lens suggests raising the video quality" (`src/content/popover.tsx:57` the `lowQuality` text, `:291` `lowQualityTip`: unsure matches from a video of 480p or less).
- [x] A YouTube scan's time (e.g. 4:36 or 1:02:15) is itself the link back to that moment; there's no separate "Open at" label since F1/F3 (`src/sidepanel/app.tsx:44` `openAtHref`, `:208-224`).
- [x] "Under a second" after the first scan: the final review's E2E (click to scan, `test/e2e/run.ts --click`) measured a median of 257 ms from click to popover, comfortably under a second on the development Mac. Re-measure on a slower machine if this changes.
- [x] "Upside down or slightly tilted": the same fixture board (one card rotated 180°, one tilted 7°, one sideways) re-ran in the final review: `npx tsx test/e2e/run.ts` (drag) **8/8, all confident**, and `--click` **8/8**, 8 outlines on each shot.
- [x] The picture beside the card is the matched card's official image, downloaded from YGOPRODeck and cached (decision D2): `src/content/app.tsx:232-242` (the image-loading effect runs unless `!__DUEL_LENS_REMOTE_IMAGES__`), `:385` (the crop is used as the popover's own picture only in the crop build); `src/sidepanel/app.tsx:177-183`. The crop build (`--no-remote-images`) shows the user's own selection instead and requests no card image.
- [x] The welcome page opens on install and asks for consent before the first scan (`src/background/index.ts:30-38`, `src/background/scan.ts:131-134`).
- [x] No Options "Debug" section in the store build: it is compiled only into `--dev` and `--e2e` builds (`src/options/app.tsx:408`), so no PRIVACY bullet is needed for debug crops.
- [x] The store build asks for the host permission `https://images.ygoprodeck.com/*` (decision D2), and Chrome's install warning reads "Read and change your data on images.ygoprodeck.com"; PRIVACY and PERMISSIONS above disclose it. Only the crop build (`--no-remote-images`) has no host permissions and no install warning; if that build is ever submitted instead, update PRIVACY, PERMISSIONS, `store/privacy-practices.md` and the privacy policy together.
- [x] Click to scan is described (HOW IT WORKS step 3, the FEATURES bullet) because the zip ships the card detector: every build registers it (`src/offscreen/index.ts`), and `npm run release` refuses a build without `models/detector/card-detector.onnx` (A4). A `--no-detector` build must not use this text: advertising a feature the package doesn't have is misleading metadata ("Yellow Zinc" / "Red Nickel" in the violation reference: https://developer.chrome.com/docs/webstore/troubleshooting).

---

## 5. Category and language

- **Category: Entertainment** (recommended). People use Duel Lens while watching duel videos and
  streams, next to other extensions for watching video.
- Alternative: **Games**. It fits the subject (a card game) but sits among actual games; choose it if
  the user would rather be found by players browsing that category.
- Current category list (2023 re-categorisation): Accessibility, Art & Design, Communication, Developer
  Tools, Education, Entertainment, Functionality & UI, Games, Household, Just for Fun, News & Weather,
  Privacy & Security, Shopping, Social Media & Networking, Tools, Travel, Well-being, Workflow & Planning.
- **Language: English.** The UI and the card data (YGOPRODeck's English names and text) are English
  only. The manifest has no `default_locale`, so there is nothing to localise in v1.

---

## 6. Disclaimer

`docs/release/disclaimers.md` (legal workstream) holds the reviewed release wording, and that file
wins. Duel Lens's own pages already use it: `src/welcome/copy.ts` has its texts word for word, in the
default (official-images) variant ("Card data and images", decision D2), and `src/welcome/copy.test.ts`
fails if they drift.

Store listing, last paragraph (as in section 4): disclaimers.md §3.2, default variant.

```text
Unofficial fan tool. Duel Lens is not affiliated with, sponsored, endorsed or approved by Konami, Studio Dice, Shueisha or TV Tokyo. Yu-Gi-Oh! and the names, text and images of Yu-Gi-Oh! cards are trademarks and copyrights of their respective owners (© Studio Dice/SHUEISHA, TV TOKYO, KONAMI). Card data and images: YGOPRODeck (ygoprodeck.com). The optional AI check uses Anthropic's Claude with your own API key; Claude and Anthropic are trademarks of Anthropic, PBC, and Duel Lens is not affiliated with Anthropic.

Rights holders and questions: mathulbrich@gmail.com
```

If the crop build (`--no-remote-images`) is ever submitted instead, shorten this to "Card data:
YGOPRODeck (ygoprodeck.com)." as disclaimers.md §3.2's text-only variant has it.

Short form (disclaimers.md §1), in the footers of the welcome, Options, privacy and licences pages
(`src/welcome/app.tsx:150`, `src/options/app.tsx:432`, `src/legal/pages.tsx:27`). The side panel's
footer credit ends with the same words ("Card data and images: YGOPRODeck · Unofficial fan tool, not
affiliated with or endorsed by Konami.", `src/welcome/copy.ts:36`).

```text
Duel Lens is an unofficial fan tool, not affiliated with or endorsed by Konami.
```

What the disclaimer can't fix, so the listing avoids it:
- Konami, Yu-Gi-Oh!, event (YCS, WCQ, World Championship) and sponsor logos in the icon, promo tile or
  screenshots;
- a card back or official artwork in the icon or promo tile;
- words like "official", "Konami-approved", "the Yu-Gi-Oh! extension".

---

## 7. Test instructions tab (optional)

The dashboard's Test instructions tab is optional and meant for items that need credentials. Duel Lens
needs none, but a short note can spare the reviewer a question about the bundled WebAssembly. Paste if
the tab is used:

```text
No account or login is needed. The AI check is optional and needs the tester's own Anthropic API key; everything else works without it.

1. Installing opens Duel Lens's welcome page. Press "Agree and start" in its "Before your first scan" section. Until you do, the shortcut and the toolbar button only bring you back to that section: Duel Lens asks for consent before it handles any data.
2. Open a Yu-Gi-Oh! duel video, for example https://www.youtube.com/watch?v=bBbjafm1u2Q&t=5200s, and pause where face-up cards are visible on the playmat.
3. Press Alt+Shift+Y (Option+Shift+Y on a Mac) or click the Duel Lens toolbar button. The frame freezes and, after a brief "Finding cards…", the face-up cards get thin gold outlines.
4. Click an outlined card (or drag a box around any face-up card). A popover shows the card's name and text next to its official picture, downloaded from YGOPRODeck. ← and → show other matches; Esc closes.
5. Press Alt+Shift+U to open the side panel with the cards scanned so far.
6. Options: card data status, "Check for updates now", the optional AI check, and links to the bundled privacy policy and licences.

About the package:
- All code is in the package; nothing downloaded is ever executed. Network use: db.ygoprodeck.com (card data, JSON; its API allows cross-origin requests, so it needs no host permission), images.ygoprodeck.com (official card pictures and new cards' artwork; the manifest asks for host access, since this server sends no CORS headers), and api.anthropic.com only after the user turns on the AI check and presses "Ask AI".
- ort/ holds ONNX Runtime Web 1.30.0's WebAssembly runtime. models/*.onnx and models/detector/card-detector.onnx are model weights it runs (the card-artwork embedder and the card detector, both our own); data/* is the card data and the artwork index. Neither is code.
- fonts/* are web-accessible (with use_dynamic_url) because the popover, drawn inside the page by the content script, loads them.
```

`{{TEST_VIDEO_URL}}` is filled in with a public video the lead has checked, with a `&t=` at a moment where
upright, face-up cards are clearly visible. A candidate from the ledger: the YCS Paris 2026 Day 1 main
stream, `https://www.youtube.com/watch?v=bBbjafm1u2Q`. Its known moment, t=26191, has a tilted card
(a hard case), so the lead picked an easier one: t=5200 (1:26:40), where Aerial Eater (tilted about 6°) read right at
0.92 by click at 1080p, 720p and 480p in the live YouTube check (live-check-report.md, pick 13). (The OpenCV.js paragraph that used to be here is gone with OpenCV.js itself: the build
no longer inlines any WebAssembly in a script, a4-report.md.)

---

## 8. Other dashboard settings (suggested; the user decides)

- **Distribution → Visibility:** Public. Unlisted is the fallback for a quiet first week (installable
  by link only).
- **Distribution → Regions:** all.
- **Pricing:** free; no in-app purchases, no ads.
- **Publishing:** untick "publish automatically after review" (deferred publishing). The user then
  publishes by hand, within 30 days of approval, after a last check of the approved build.
  Source: https://developer.chrome.com/docs/webstore/publish
- **Mature content:** No.
