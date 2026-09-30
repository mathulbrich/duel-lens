# README pictures

Renders the GIFs and stills that the project's `README.md` shows, into `docs/media/`, from the real
extension on a synthetic scene.

```sh
npx tsx tools/readme-media/render.ts                      # build, record, encode everything (a few minutes)
npx tsx tools/readme-media/render.ts --no-build           # reuse release/readme-build
npx tsx tools/readme-media/render.ts --only=not-sure,options   # just these pictures; the others stay as they are
npx tsx tools/readme-media/render.ts --encode-only        # re-encode the GIFs from the last recordings, no browser
```

| Picture | What it shows |
|---|---|
| `click-to-scan.gif` | The shortcut, every card outlined and scan mode's bar; the pointer rests on Ash Blossom (its preview), a click opens its popover (Genesys chip); then Accesscode Talker's preview beside the pinned popover, and a click replaces the popover with Talker's |
| `hover-preview.gif` | Previews: Infinite Impermanence, then Accesscode Talker; the pointer parked, Tab shows Accesscode Talker's, Tab again Dark Magician's, Enter opens Dark Magician |
| `leave-scan-mode.gif` | The video's clock runs; the shortcut stops it; Dark Magician's popover; Esc closes it (outlines stay), Esc again leaves and the clock runs; the shortcut again, then the bar's ✕ leaves |
| `drag-a-box.gif` | A box dragged around Infinite Impermanence (lying tilted), and its answer |
| `two-clicks.gif` | A click beside Blue-Eyes sets a corner (the bar says "Click the opposite corner"), the box follows the pointer, a second click reads it |
| `not-sure.gif` | Blue-Eyes caught mid-motion: "Not sure" with other matches; → shows the next, a chip goes back. Then, in the same scan, Accesscode Talker, blurred more: "Low match" |
| `keep-and-side-panel.gif` | S on Pot of Greed's popover: the side panel opens with the card in full, then scrolls to the scans |
| `cut-card.gif` | Two cards cut by the picture's top edge: "Not sure" with the right card, then, clicked next in the same scan, "Part of this card is outside the picture…" |
| `popover-anatomy.png` | The popover with a callout for each part |
| `welcome-consent.png` | The welcome page's consent step, before agreeing |
| `options.png` | Options → AI check, as a new install has it (off, no key) |

It needs:
- **the network:** the popover and the side panel show the official card pictures, which the extension
  fetches from images.ygoprodeck.com;
- **`test/e2e`'s Puppeteer install** and its Chrome for Testing (`cd test/e2e && npm install`);
- **the fixture cards** in `test/fixtures/cards/`, and **`data/bench/cards-small/`** (YGOPRODeck's small
  card images, local like all of `data/`) for the cards the fixtures lack: the anatomy's card and the cut
  cards;
- **Python with Pillow** for the GIFs: `data/venv-train/bin/python` by default, or `PYTHON=/path/to/python`.
  No ffmpeg or gifski.

## How it works

1. **Build:** `node build.mjs --e2e --out release/readme-build`, the store build's UI plus the E2E-only
   debug hook (Puppeteer can't press the shortcut: `duelLensDebug.startScan()` does exactly what
   Alt+Shift+Y does). Never plain `node build.mjs`, which rebuilds `dist/`, the installed build. The
   manifest's "Duel Lens (E2E)" is set back to "Duel Lens", and each still checks that "E2E" is nowhere
   in it.
2. **Scene:** `tools/store-shots/scene.html`, used as it is: a plain playmat with the E2E fixture cards,
   played through a real `<video>`, so Duel Lens reads it from the video frame. `?add=` puts more cards on
   it (served from `data/bench/cards-small`), `?fx=` blurs one, and `?clock=<seconds>` shows the video's
   time in the player bar, running only while the video plays (`leave-scan-mode.gif`: the video pauses in
   scan mode and plays again on leaving). No broadcast frames, logos or people.
3. **Recording** (`recorder.ts`): a CDP screencast of the page (`Page.startScreencast`, PNG frames with
   the browser's frame times), and a timeline of what the "user" does: pointer moves at a human pace
   (with the pointer's look under it: crosshair on the frozen frame, hand over a card or a button),
   presses and keys, on the same clock. Nothing is drawn in the page: Duel Lens screenshots the tab and
   runs its card detector on it, so a drawn pointer would end up in the frozen frame.
4. **Encoding** (`make_gif.py`): samples the frames at 10 fps, crops them, draws the pointer, a gold
   ripple on each click, a dot while the button is held, and a key badge ("Alt + Shift + Y", "S", "Tab",
   "Enter", "→", "Esc") when a key is pressed (the badges and pointers are rendered once by the browser, in the
   extension's own Archivo font). Then one adaptive palette for the whole clip, no dithering, identical
   frames merged (still moments become one long frame) and Pillow's `optimize`.
5. **Stills:** page screenshots at 2× (`welcome-consent.png`, `options.png`); the anatomy's popover is
   read for real, each part's box is read from it, and the callouts are drawn around its screenshot on a
   page of their own, like the store images' captions.

Every answer shown is the engine's own and is checked before it is kept (card, confidence, chips,
pictures loaded, the popover fully in view), and the run stops on a failed check. The results are in
`release/readme-raw/checks.json`, with the raw frames, the plans (`<gif>/plan.json`) and, in
`release/readme-raw/review/`, four frames of each GIF to look at. The raw frames take about 450 MB
(gitignored, like all of `release/`); only `--encode-only` needs them, so delete the folder when done.

## Things to know

- **"Not sure", "Low match" and cut cards are never staged.** The engine's windows for them are narrow
  and move when the engine changes, so `NOT_SURE_SCENES` and `CUT_PAIRS` list setups to try in order;
  the first that gives the honest answers is recorded, and a "Low match" (the engine's suggestions) is
  told apart from a "Not sure" by its line. On the engine of 2026-09-29, where a click straightens the
  card from its outline, Blue-Eyes blurred 26 px reads "Not sure · 76%" and Accesscode Talker blurred
  32 px "Low match" (lighter blurs read confidently, heavier ones lose the outline). If a change moves
  them, the run stops: search again with blur levels and cards (`?fx=<card>:blur:<px>:<degrees>`). The
  unsure popover needs more than 720 px, so that GIF's page is 760 px tall.
- **Scan mode stays open** after a read, and "Hover or click" (the default) shows a preview when the
  pointer rests on an outline. So the scenes read a second card with a click on its outline (Esc first
  only when the open popover covers it), wait for the answer to change (`Scene.nextResult`), rest the
  pointer on the open popover rather than on a neighbouring card, and leave with as many Escapes as it
  takes (`leave`). The preview and the bar's ✕ are found by `PREVIEW` and `EXIT_BUTTON` in `render.ts`;
  when they match nothing, the run stops and lists the classes it did find. The pointer's look is the
  CSS cursor under it (`recorder.ts`, `duelLensCursor`).
- **The side panel** can't be captured headless, so `sidepanel.html` runs in a window of its own and the
  GIF puts it beside the page, as Chrome does. Every scan already becomes the panel's card
  (`src/background/router.ts`): what S does is open the panel on it. So the GIF shows the page at full
  width with the popover, then, after S, the page narrowed and the panel beside it. Keeping no longer
  ends scan mode, so the check is `show-in-panel`'s own `chrome.sidePanel.open()` call, counted in the
  service worker, with no failure toast.
- **The budget:** each GIF at most 4 MB, `docs/media/` at most 25 MB; the run stops over either.
- **The clips run in real time.** Pointer moves keep their pace, but on a busy machine (other builds or
  test runs) scans answer later and the clips get longer: render on a quiet one. They show whatever the
  build does, so render again once a change to the popover, the panel or the engine has landed.
- **Times in the side panel** are the scene video's own. The scene isn't YouTube, so they are plain
  text; on YouTube each one is a link back to that moment.
