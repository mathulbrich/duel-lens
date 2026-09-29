# Store images

Renders the Chrome Web Store images that `store/screenshots-plan.md` plans: five 1280×800 screenshots
(`store/screenshots/`) and the 440×280 small promo tile (`store/promo/`).

```sh
npx tsx tools/store-shots/render.ts            # build, capture, compose (about 2.5 minutes)
npx tsx tools/store-shots/render.ts --no-build # reuse release/shots-build/ext
npx tsx tools/store-shots/render.ts --compose-only  # captions and promo tile only, from the last captures
npx tsx tools/store-shots/render.ts --gap=5    # shorter waits between the side panel's scans (default 20 s)
npx tsx tools/store-shots/render.ts --only=01-hero    # screenshot 1 alone (or --only=05-privacy); the others stay as they are
```

It needs:
- **the network:** the popover and the side panel show the official card pictures, which the
  extension fetches from images.ygoprodeck.com;
- **`test/e2e`'s Puppeteer install** and its Chrome for Testing (`cd test/e2e && npm install`);
- **the fixture cards** in `test/fixtures/cards/`;
- **`sharp`** from the root `node_modules`.

## What it does

1. **Build:** `node build.mjs --e2e --out release/shots-build/ext`, which is the store build's UI plus
   the E2E-only debug hook and state attributes the script drives it with. Every build shows official
   card pictures (decision D2). Never `dist/` or `dist-e2e/`. The manifest's `name` is set back from
   "Duel Lens (E2E)" to "Duel Lens".
2. **Scene** (`scene.html`): a synthetic duel, not a broadcast frame.
   - It is a neutral playmat with zone outlines, the 8 E2E fixture cards (one upside down, one tilted,
     one in Defense Position) and three face-down cards in plain, unbranded sleeves (two piles and a
     set card).
   - It is drawn into a 1920×1080 canvas and played through a real `<video>`, so Duel Lens reads it as
     it reads a video: from the frame, at "1080p".
   - The plain player bar has no brand. Its button follows the video, which Duel Lens pauses while it
     is open.
   - It has no logos, people, names or overlays, and it is deterministic.
3. **Captures:** Chrome for Testing, a fresh profile, viewport 1280×720 at scale 1, `--lang=en-US`,
   dark colour scheme and reduced motion (so the popover's foil edge doesn't animate between runs).
   The shortcut is the E2E hook `duelLensDebug.startScan()`, which does exactly what Alt+Shift+Y does.
   - `05`: the welcome page the install opened, before agreeing, as on Windows. It shows the whole
     consent step and the three "How to use it" titles. Then a real click on **Agree and start**.
   - `01`: Accesscode Talker, Odd-Eyes and Infinite Impermanence are clicked. Then Ash Blossom
     (upside down in the GY) is clicked too, as caption 1 says, and its popover is the hero: official
     picture, facts with "Genesys 20 pts", full text, "99% match".
   - `04`: Dark Magician is clicked last, so the side panel (379×720, beside the scene at 900×720)
     shows it. Its full-width picture leaves no room for the list below it, so the panel is scrolled:
     the picture's lower part, the card, and the five entries.
   - `02`: the outlines after the shortcut, in the spotlight state (pointer on no card). The hovered
     state (Number 39: Utopia lit) is captured too, as `raw/02-click-other.png`; `SHOT_02` picks one.
     Then the click on Utopia is made, to check that it reads Utopia.
   - `03`: the AI check is turned on with a placeholder key (never used), so "Ask AI" shows.
     - The candidates in `NOT_SURE_CANDIDATES` are tried until one gives a real "Not sure", with the
       right card on screen and at least two chips.
     - The settings are removed afterwards.
     - If none does, a Defense Position card is used instead, with its own caption. A "Not sure" is
       never staged.
4. **Compose** (with sharp): an 80 px caption band (plan §3.4, in the bundled Archivo) above each
   1280×720 capture, with no resizing. The PNGs are sRGB, have no alpha and are under 2 MB. The promo
   tile is drawn at 2× and scaled down, and a 220×140 preview goes to the raw folder.

Every result shown is checked before it is kept, and the run stops on any failed check. Checked:
- the card and its confidence;
- the official picture and every chip's picture loaded;
- the Genesys chip on the hero;
- no toast;
- every face-up card outlined, with the spotlight, and nothing else;
- the hint's text;
- the five history entries, the active one, and what the scrolled panel shows;
- the consent text and step titles;
- "E2E" nowhere on screen.

The results are in `release/shots-build/raw/checks.json`, next to the raw captures.

## Things to know

- **Windows keys in screenshot 5.** It is rendered as on Windows, so its keys read
  "Alt + Shift + Y" like caption 1. The page doesn't read the user agent: it shows the shortcut
  `chrome.commands.getAll()` returns, which Chrome formats for its own OS ("⌥⇧Y" on a Mac). So
  `render.ts` sets a Windows user agent and platform (`Emulation.setUserAgentOverride`), and its
  `WINDOWS_COMMANDS` converts that answer to Windows' format in the welcome page before the page's own
  scripts run.
- **Screenshot 3's hard case** is motion blur: Odd-Eyes caught while being put down. Every other hard
  case tried gave either a confident answer or "Couldn't match":
  - shrinking a card (down to 33 px);
  - covering half of it;
  - boxing part of its art;
  - sleeve glare;
  - 480p or 360p video.

  The engine's window for "Not sure" is narrow: a top score of 0.74–0.80 with a lead under 0.10.
  `?fx=` and `?add=` in `scene.html` are the knobs for trying others.
- **History times** are the video's own playback times. The scene is a video, not YouTube, so they are
  plain text. On YouTube each time is a link back to that moment.
