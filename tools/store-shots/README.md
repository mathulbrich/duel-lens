# Store images

Renders the Chrome Web Store images that `store/screenshots-plan.md` plans: five 1280×800 screenshots
(`store/screenshots/`) and the 440×280 small promo tile (`store/promo/`).

```sh
npx tsx tools/store-shots/render.ts            # build, capture, compose (about 3 minutes)
npx tsx tools/store-shots/render.ts --no-build # reuse release/shots-build/ext
npx tsx tools/store-shots/render.ts --compose-only  # captions and promo tile only, from the last captures
npx tsx tools/store-shots/render.ts --only=live     # 01 and 04 alone (one Live check run); the others stay as they are
npx tsx tools/store-shots/render.ts --only=scan     # 02 and 03 alone (or --only=05-privacy)
```

It needs:
- **the network:** the card boxes and the side panel show the official card pictures, which the
  extension fetches from images.ygoprodeck.com;
- **`test/e2e`'s Puppeteer install** and its Chrome for Testing (`cd test/e2e && npm install`);
- **the fixture cards** in `test/fixtures/cards/`;
- **`sharp`** from the root `node_modules`.

`tools/readme-media` uses this folder's `scene.html` and `harness.ts` too: keep their options and
functions working for it.

## What it does

1. **Build:** `node build.mjs --e2e --out release/shots-build/ext`, which is the store build's UI plus
   the E2E-only debug hook and state attributes the script drives it with. Every build shows official
   card pictures (decision D2). Never `dist/` or `dist-e2e/`. The manifest's `name` is set back from
   "Duel Lens (E2E)" to the store's "Duel Lens – Card Reader".
2. **Scene** (`scene.html`): a synthetic duel, not a broadcast frame.
   - It is a neutral playmat with zone outlines, the 8 E2E fixture cards (one upside down, one tilted,
     one in Defense Position) and three face-down cards in plain, unbranded sleeves (two piles and a
     set card).
   - It is drawn into a 1920×1080 canvas and played through a real `<video>`, so Duel Lens reads it as
     it reads a video: from the frame, at "1080p".
   - The plain player bar has no brand. Its button follows the video, which scan mode pauses while it
     is open (Live check doesn't).
   - It has no logos, people, names or overlays, and it is deterministic.
3. **Captures:** Chrome for Testing, a fresh profile, viewport 1280×720 at scale 1, `--lang=en-US`,
   dark colour scheme and reduced motion (so the box's foil edge doesn't animate between runs). Every
   setting is the default (Full details on hover, Small card text, the TCG list, Live check's Speed
   Light) except the two below. The shortcut is the E2E hook `duelLensDebug.startScan()`, which does
   exactly what Alt+Shift+Y does.
   - `05`: the welcome page the install opened, before agreeing, as on Windows. It shows the whole
     consent step (which now names Live check), from the card data's "Ready" line down to the
     "How to use it" heading: since 0.10 the step is too tall for the step titles to fit under it too.
     Then a real click on **Agree and start**.
   - `02`: the outlines after the shortcut, in the spotlight state (pointer on no card), with scan
     mode's bar ("8 cards", Read all cards, Find card). The hovered state (Number 39: Utopia lit) is
     captured too, as `raw/02-click-other.png`; `SHOT_02` picks one. Then the click on Utopia is made,
     to check that it reads Utopia sure and pins 0.10's box.
   - `03`: the AI check is turned on with a placeholder key (never used), so "Ask AI" shows.
     - The candidates in `NOT_SURE_CANDIDATES` are tried until one gives a real "Not sure", with the
       right card on screen and at least two "Could also be" chips.
     - The settings are removed afterwards.
     - If none does, a Defense Position card is used instead, with its own caption. A "Not sure" is
       never staged.
   - `01` (the hero): Live check is turned on as its switch turns it on (`settings.live.check`). The
     pointer comes to rest on Pot of Greed (`HERO_CARD`: Forbidden in the TCG, 20 Genesys points, so
     its box shows the red ban frame and both legality marks) in the playing video: Live starts there,
     outlines the card in gold and opens its box beside it. The pointer stays until Live has listed
     every face-up card, so the pill reads "LIVE CHECK 8".
   - `04`: the pointer goes to the empty mat, and the side panel (379×720, opened in a window of its
     own so the scene stays in front and Live keeps watching) is switched to its **Live check** view by
     a click: the eight cards it found, their times, "Watching". The scene beside it, at 900×720, shows
     the pill counting the same eight.
4. **Compose** (with sharp): an 80 px caption band (plan §3.4, in the bundled Archivo) above each
   1280×720 capture, with no resizing. In `01` the mouse pointer is drawn where the mouse rested
   (`DRAW_POINTER_01`): headless Chrome's screenshots leave it out, and Live check answers a pointer at
   rest. It is the plain system arrow, as `tools/readme-media` draws it; nothing of Duel Lens is drawn.
   The PNGs are sRGB, have no alpha and are under 2 MB. The promo tile is drawn at 2× and scaled down,
   and a 220×140 preview goes to the raw folder. Its name is lettered as the card box's top row letters
   it ("DUEL LENS").

Every result shown is checked before it is kept, and the run stops on any failed check. Checked:
- the card and whether it is sure;
- the official picture and every chip's picture loaded;
- 0.10's box: the brand row, no Copy button, no match line on a sure card, "Not sure" with its
  percentage only in the tooltip and "Could also be" chips on an unsure one, the PASSCODE / ARCHETYPE
  column labels and the links only on a pinned box, none on a hovered (unpinned) one;
- the hero's ban frame (forbidden), "Forbidden · TCG" and "Genesys 20 pts";
- Live check: nothing runs before the pointer rests; the pill at the video's corner, counting what the
  log lists; one gold outline, around the pointer; the box not over the pointer; every card Live listed
  is on the mat; the video playing;
- every face-up card outlined, with the spotlight, and nothing else; the bar's text;
- the side panel's Live check view: the rows the log lists, in its order, all in view, their pictures
  loaded, "Watching", and the scene still in front;
- the consent text and step titles;
- "E2E" nowhere on screen.

The results are in `release/shots-build/raw/checks.json`, next to the raw captures.

## Things to know

- **Windows keys in screenshot 5.** It is rendered as on Windows, so its keys read
  "Alt + Shift + Y" like caption 2 (since 0.10 the view ends above the steps, so no key is in it, but
  the check stays for when one is). The page doesn't read the user agent: it shows the shortcut
  `chrome.commands.getAll()` returns, which Chrome formats for its own OS ("⌥⇧Y" on a Mac). So
  `render.ts` sets a Windows user agent and platform (`Emulation.setUserAgentOverride`), and its
  `WINDOWS_COMMANDS` converts that answer to Windows' format in the welcome page before the page's own
  scripts run.
- **Screenshot 3's hard case** is motion blur: Odd-Eyes caught while being put down. On 0.10.3 a click
  on it reads it sure up to 16 px of blur and gives "Not sure" with a single chip at 17-18 px; a box
  around it at 14 px gives "Not sure" (76%) with three chips. Every other hard case tried on 0.9 gave
  either a confident answer or "Couldn't match":
  - shrinking a card (down to 33 px);
  - covering half of it;
  - boxing part of its art;
  - sleeve glare;
  - 480p or 360p video.

  `?fx=` and `?add=` in `scene.html` are the knobs for trying others.
- **No player clock in the Live shots.** `scene.html ?clock=` draws a made-up time in the player bar;
  Live's list shows the video's own times (seconds since the scene started), which it would contradict.
- **Live's pace.** The side panel's status says how many frames a second Live may read at Speed Light on
  the machine that renders it (about 0.5 in headless Chrome without a GPU): it is that machine's, shown
  as it is.
