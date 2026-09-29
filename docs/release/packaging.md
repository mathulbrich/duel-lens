# Packaging a release

`npm run release` turns the sources into the zip you upload to the Chrome Web Store:
1. it runs the checks;
2. it builds the **store build** into `release/build/`;
3. it verifies that build;
4. it writes `release/duel-lens-<version>.zip` with its SHA-256.

It never touches `dist/`, the build you have installed. The code is in `tools/release.mjs`.

Updated 2026-09-29 for A4 (our own card detector; OpenCV removed), A6 (DRAW2 gone), fix wave F2 and
decision D2 (official card images by default, decided 2026-09-29): a plain build is now the store build,
with YGOPRODeck's official card images, the host permission for `images.ygoprodeck.com`, and the card
detector included by default. `--no-remote-images` gives the older crop build back (no card images, no
host permission), kept for a one-flag rollback; `--remote-images` is still accepted but changes nothing,
since it's now the default. `--with-draw2` is gone (A6, 05:53); `--no-detector` is new (A4). Line numbers
are as of `fix-f2-report.md` (2026-09-29, ~10:18) and may have moved slightly since.

## Build modes and flags

`node build.mjs` with no flags builds the **store build** into `dist/`. The flags (`build.mjs:1-36`):

| Flag | What it does |
|---|---|
| (none) | **Store mode.** YGOPRODeck's official card images, by default (decision D2, decided 2026-09-29): the popover and the side panel show the matched card's picture, downloaded from `images.ygoprodeck.com` and cached, and the self-updating index downloads new cards' artwork. The manifest gets the host permission `https://images.ygoprodeck.com/*`, because that host sends no CORS headers. There is no developer UI. The card detector ships (see `--no-detector`, below): click to scan works, and every scan's card finding uses it. This is what `npm run release` builds. |
| `--dev` | The developer options (`__DUEL_LENS_DEV__`): Options' "Debug" section, which saves and exports crops for a test set. Still has remote images by default, unless you add `--no-remote-images`. Into `dist/`. |
| `--e2e` | The end-to-end test build, into `dist-e2e/`, named "Duel Lens (E2E)". It has the host permission `<all_urls>` (automated tests can't press the shortcut that grants `activeTab`), the `duelLensDebug` hook, the `data-duel-lens-*` state mirror, the developer options, and remote images by default unless `--no-remote-images`. **Never upload it**; the release verification refuses it. |
| `--no-remote-images` | **The crop build:** the popover and the side panel show the user's own crop instead, and each scan keeps a 160 px picture in the history. There are no card-image requests and no artwork downloads: that code is left out of the bundles. The manifest has **no `host_permissions`**. Kept as a one-flag rollback if YGOPRODeck ever objects to the default; also usable with `--e2e` or `--dev`, for example `--e2e --no-remote-images`, which `npx tsx test/e2e/run.ts --store-images` uses. It contradicts `--remote-images`; the build refuses both at once. |
| `--remote-images` | **A no-op:** official images are already the default, so this flag changes nothing. Still accepted so older commands keep working. |
| `--out <dir>` | Build into `<dir>` instead of `dist/` or `dist-e2e/`. The folder is emptied first, so it must be new, empty or a previous build (it has `manifest.json` and `background.js`). Anything else is refused. `npm run release` uses `--out release/build`. |
| `--sourcemap` | Linked source maps. Off by default. **Updated 2026-09-29 (A4):** now about 3.7 MB total, `offscreen.js.map` about 634 KB — down from about 40 MB (mostly `offscreen.js.map`) when OpenCV.js was inlined there. Verified this sync with a fresh `node build.mjs --out <scratch dir> --sourcemap`. |
| `--watch` | Rebuild on source changes. Static files are copied once. |
| `--no-detector` | **New (A4).** Builds without the card detector (`extension/models/detector/card-detector.onnx`; `tools/train-detector/README.md` rebuilds it): click to scan stays off ("no card detector in this build") and scans match the user's box as drawn, with no outlines. Every other build ships the detector, and `npm run release` refuses a build without it. |
| `--with-draw2` | **Removed** on 2026-09-29 at 05:53 (A6 phase 1); DRAW2 itself is now deleted from the repository too (A6 phase 2, `a6-phase2-report.md`). It used to copy DRAW2's AGPL-3.0 models into the build; those models now live only in the gitignored `data/draw2-archive/models/`. No build can include them: `models/` ships only the default model and the card detector (`build.mjs:115-116`), and the release verification refuses any file or code with DRAW2 in it. |

The flags become three compile-time constants (`build.mjs:52-57`, declared in `src/build-flags.d.ts`):
- `__DUEL_LENS_E2E__`: `--e2e`;
- `__DUEL_LENS_DEV__`: `--e2e` or `--dev`;
- `__DUEL_LENS_REMOTE_IMAGES__`: on by default (decision D2); off only with `--no-remote-images`.

esbuild drops the code behind a constant that is off, and the bundled privacy policy (`privacy.html`, `src/legal/policy.ts`) and the in-product texts (`src/welcome/copy.ts`) pick their wording by the same constants.

Every build also:
- **copies** `extension/`, keeping only the default model (`DEFAULT_MODEL_ID` in `src/shared/models.ts`: `dinov2-small-duel`), its index, and the card detector (`models/detector/card-detector.onnx`, unless `--no-detector`) (`build.mjs:113-142`). No other model or model folder ships: not the benchmark models or their indexes, not `models/draw2/`;
- **fails** if the default model or its index is missing (`build.mjs:91-107`), and fails if the card detector is missing unless `--no-detector` was passed (`assertDetectorModelExists`);
- **copies** ONNX Runtime's `.wasm` and `.mjs` loader into `ort/` (`build.mjs:122-130`);
- **copies** `THIRD_PARTY_NOTICES.md` without its `<!-- maintainer comments -->`, and `LICENSE` if the repository has one (`build.mjs:146-150`). The Licences page (`licenses.html`) shows them.

## Cut a release

1. **Once per machine:** run `npm install`, then `npm install` again in `test/e2e/` (Puppeteer and Chrome for Testing). Two things are gitignored and must be in place: the default model `extension/models/dinov2-small-duel.q8.onnx` (see [`docs/DEVELOPMENT.md`](../DEVELOPMENT.md), "Models") and the fixture card images in `test/fixtures/cards/`.
2. **Raise `version` in `extension/manifest.json`.** The store accepts only a higher version than the published one. The manifest's version is the only one that counts; `package.json`'s is not used.
3. **Check the image mode.** `npm run release` with no flags always builds store mode: YGOPRODeck's
   official card images by default (decision D2, decided 2026-09-29), with the host permission for
   `images.ygoprodeck.com`. **`npm run release -- --no-remote-images` builds the crop build instead**
   (`tools/release.mjs` `FLAGS`, passed through to `build.mjs --no-remote-images`) — the older behaviour,
   kept as a one-flag rollback if YGOPRODeck ever objects. It adds a warning to the summary reminding you
   to host the matching privacy text (`docs/release/privacy-policy.md`, Appendix C has the crop build's
   edits and Appendix D says how to print its variant). The extension's own texts follow the flag by
   themselves. (`--remote-images` is still accepted but is now a no-op, since it's the default.)
4. **Run `npm run release`.** Use `npm run release -- --skip-e2e` to leave out the end-to-end test; the summary then warns that it was skipped. The release stops at the first failure, and the summary lists every problem. Run it on an idle machine (see "If the release stops").
5. **Smoke-test the build.** In a fresh Chrome profile, open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and pick `release/build/`. Then check:
   - the welcome page opens on its own;
   - a scan before agreeing only brings you to its "Before your first scan" step;
   - after **Agree and start**, a card scans in a YouTube duel, and the popover shows the card's official picture, downloaded from YGOPRODeck (the crop build, `--no-remote-images`, shows your own crop instead);
   - the side panel shows the scan's small picture;
   - Options → About shows the date you agreed, and links to the Privacy policy and Licences pages.
6. **Upload the zip.** In the Chrome Web Store Developer Dashboard, go to Package, then Upload new package, and pick `release/duel-lens-<version>.zip`. Keep the `.sha256` file next to it. To confirm the zip is the one you tested, run `shasum -a 256 -c duel-lens-<version>.zip.sha256` in `release/`.

To run only the three checks (tsc, vitest and the E2E fixture test), use `npm run verify`, for example before a big merge.

## What `npm run release` does

| Step | Command or rule |
|---|---|
| 1. Checks | `npx tsc --noEmit`, `npx vitest run`, `npx tsx test/e2e/run.ts`. The E2E test builds its own `dist-e2e/` from the same sources, with the E2E-only `<all_urls>` permission and remote images; `run.ts --store-images` now tests the crop build (its name predates decision D2), but the release doesn't run it. The E2E run is skipped, with a warning, under `--skip-e2e`, and refused if Puppeteer or the fixture images are missing. |
| 2. Build | `node build.mjs --out release/build`: the store build. Pass `-- --sourcemap` to ship source maps. |
| 3. Verify | The checks in the next section. Errors stop the release; warnings are listed. OS clutter (`.DS_Store`, `Thumbs.db`, `desktop.ini`, `._*`) is deleted from `release/build/` first. |
| 4. Zip | Only when there are no errors. The build's files sit at the zip root, as the store expects. Entries are sorted, include their folders, are dated 2000-01-01 and use Unix modes 644/755. Files are deflated at level 9, or stored when that doesn't shrink them. The zip is tested with `unzip -t` when `unzip` is installed (a failing zip is deleted). The same build always gives the same zip, byte for byte, so the SHA-256 identifies the build. |
| 5. Summary | The checks' results; every file with its size, largest first; the manifest's version, Chrome floor, description, permissions, host permissions and optional host permissions; warnings; errors; and the zip and its SHA-256. |

## The verification

**Errors** (no zip is written):

- **Manifest.**
  - It must be MV3, with a valid Chrome `version`: 1 to 4 integers from 0 to 65535, with no leading zeros.
  - The name must be at most 75 characters, and the description at most 132.
  - It needs a 128 px icon.
  - It must have no `key` or `update_url`: those belong to unpacked or self-hosted builds, and the store manages both itself.
  - It must not be the E2E build: no "E2E" in the name, and no access to every site (`<all_urls>`, `*://*/*`), because the store build works through `activeTab`.
- **Missing files.** Every file the manifest names must exist: the service worker, icons, side panel, options page and any content scripts. Each `web_accessible_resources` pattern must match a file, and every local `src`/`href` in the HTML pages must exist. Pages must not load scripts from the network.
- **Dev files.** No source maps (unless `--sourcemap`), tests, fixtures, TypeScript, logs, package files, `.env`, `.git`, `node_modules` or symlinks, and no bundle that links a source map.
- **Dev code in the bundles.** esbuild names every bundled module in a `// path` comment. None of these may be bundled: `*.test.*`, `test-fixtures`, `__measure__`, `test/`, `tools/`, vitest, happy-dom, fake-indexeddb, puppeteer, onnxruntime-node or sharp.
- **The E2E hook.** No `duelLensDebug` anywhere. The message says where it is set.
- **DRAW2** (AGPL-3.0). No file with `draw2` in its path, and no DRAW2 code in the bundles (`src/offscreen/draw2/` modules, or the `models/draw2` string). Publishing DRAW2 code would make the whole extension AGPL-3.0.
- **Local paths.** No file may contain this project's absolute path. No module may be bundled from outside the project: esbuild would name it `../../…/node_modules/…`, which embeds your home folder. This happens when you build from a copy of the project whose `node_modules` is a symlink.

**Warnings** (the zip is still written):

- **Size budget.** The build is over 100 MB unpacked, or a file is over 30 MB (`WARN_TOTAL_MB` and `WARN_FILE_MB` in `tools/release.mjs`).
  - On the reviewed tree (`final-review.md`, 2026-09-29), the store build is **32 files and about
    62.5 MB unpacked** (62,517,512 B) — down from 74.0 MB before A4, even though it now includes the
    detector.
  - The biggest files are the card-artwork model (25.7 MB), ONNX Runtime's wasm (14.2 MB), the card data (8.6 MB), the card detector (6.2 MB) and the artwork index (6.2 MB). `offscreen.js` is no longer among them: about 189 KB, since OpenCV.js went (it was 17.9 MB).
  - The release zip is about 39.6 MB compressed. **Don't cite a fixed size or SHA-256 here**: no zip on
    disk is a reviewed build (the one from `fix-f2-report.md` predates the Genesys-points merge, and a
    later rebuild mixed in another workstream's in-progress engine code, `final-review.md` I5). **Re-run
    `npm run release` before submitting**, and read the exact size and SHA-256 from that run's own
    summary.
  - The store's own limit is 2 GB.
- **The E2E state mirror.** The popover state, including the scanned card's name, is copied onto `data-duel-lens-*` attributes that the page can read.
- **Code CDNs.** A bundle names a code CDN (jsdelivr, unpkg, cdnjs, esm.sh, skypack). The store bans remotely hosted code, so make sure nothing is loaded from it.
- **Icons and Chrome floor.** A PNG icon's pixel size differs from the size it's declared at, the 16 or 48 px icon is missing, or `minimum_chrome_version` is not set.
- **Flags.** `--skip-e2e` or `--sourcemap` was used.

**Not checked yet** (the compliance round's open point 6; `tools/release.mjs` would need new rules for
the notices/LICENSE half — the host checks are now covered by `verifyBuild`, `fix-f2-report.md`). Until
the notices check exists, check that part by hand on `release/build/`:
- `THIRD_PARTY_NOTICES.md`, `privacy.html` and `licenses.html` are in the build, and `LICENSE` too once decision D1 is made.

```sh
ls release/build/THIRD_PARTY_NOTICES.md release/build/privacy.html release/build/licenses.html release/build/LICENSE
node -p "require('./release/build/manifest.json').host_permissions"   # ["https://images.ygoprodeck.com/*"] in the default (store) build; [] in --no-remote-images
grep -c images.ygoprodeck.com release/build/*.js                      # >0 somewhere in the default build; 0 for every bundle in --no-remote-images
grep -a -c -i draw2 release/build/offscreen.js                        # 0 as of A4/A6 (was 3 comment-only hits at 06:00)
grep -a -c -i opencv release/build/offscreen.js                       # 0 since A4 (was the inlined WebAssembly string before)
ls -la release/build/models/detector/card-detector.onnx               # present in every build but --no-detector
```

**D2's own host and DRAW2/OpenCV checks are in `verifyBuild`** (`tools/release.mjs`, `fix-f2-report.md`):
the default build must ask for `https://images.ygoprodeck.com/*` and no other host; the crop build
(`--no-remote-images`) must ask for none; any file or bundled module with `draw2` or OpenCV.js fails the
release either way.

A store build checked this way after fix wave F2 (`fix-f2-report.md`, 2026-09-29 ~10:18, a real build via
`npm run release -- --skip-e2e`) passed the verification: **0 errors**. It had:
- `host_permissions`: `["https://images.ygoprodeck.com/*"]`; optional: `["https://api.anthropic.com/*"]`;
- **0 DRAW2 and 0 OpenCV hits in any bundle**;
- `models/detector/card-detector.onnx` present.

A `--no-remote-images` real build in the same run had `host_permissions` empty and 0 bundle mentions of
`images.ygoprodeck.com`, also 0 `verifyBuild` errors.

**No zip on disk is a reviewed build.** The one from that F2 run predates `genesys-report.md`'s later
card-database merge (Genesys points), and a later rebuild (once `tools/partial` compiled) mixed in
another workstream's in-progress engine code (`final-review.md` I5). **Re-run `npm run release`**
(with the E2E, not `--skip-e2e`) before submitting, once all in-flight work has landed and passed
review; that run's own summary gives the zip's exact size and SHA-256 — don't copy an old one here.

## If the release stops

- **A check failed.** Its own output is above the summary. Fix the failure and run the release again.
  - When the machine is busy, vitest can fail on timeouts alone. The compliance round saw `src/shared/names.test.ts`, `tools/lib/ort-node.test.ts` and `src/offscreen/detector/detector.int.test.ts` time out at load averages of 90 to 126 on 14 cores; they pass alone. (`src/offscreen/draw2/draw2.int.test.ts` was in this list too, before DRAW2 was deleted from the repository, A6 phase 2.)
  - The release stops at the first failed check, so run it when nothing else is running.
- **DRAW2 code.** Until about 06:00 on 2026-09-29 every release stopped here. A6 phase 1 decoupled the extension from `src/offscreen/draw2/`: no production module imports it, confirmed in `a6-phase1-report.md` (per-entry esbuild metafiles, 0 DRAW2 modules or identifiers in any bundle) and re-confirmed independently by this sync's own build. A6 phase 2 has since deleted DRAW2 from the repository entirely (`src/offscreen/draw2/`, `tools/train-detector/draw2-proposals.ts` and the rest; `extension/models/draw2/` moved to the gitignored `data/draw2-archive/models/`), confirmed in `a6-phase2-report.md`. The guard itself (`tools/release.mjs`) is kept deliberately, so it still fires: if the check fires again, something imports `draw2/` again.
- **`duelLensDebug`** (fixed on 2026-09-29, so this should not come back). The hook lives in `src/background/debug-hook.ts`. `index.ts` installs it only `if (__DUEL_LENS_E2E__)` (`src/background/index.ts:119`), and `build.mjs` defines the constant. If the check fires again, something set the hook outside that module. A hook written inline under `if (…)` stays in the bundle as dead code, because the build doesn't minify, and the check still finds it.
- **The state mirror** (fixed on 2026-09-29). `onState` is passed only when `__DUEL_LENS_E2E__` is set (`src/content/index.ts:144`), so esbuild drops `mirrorState`.
- **A size warning.** Look for the unexpected file in the summary's file list.

## The manifest

- **`version`: 0.9.0**, the first public beta.
- **`minimum_chrome_version`: 124**, the esbuild target in `build.mjs`. The code is compiled for Chrome 124 and tested only on newer versions. The APIs alone need 116:

  | API | Chrome | Used in |
  |---|---|---|
  | `runtime.getContexts` | 116 | `src/background/offscreen-client.ts:41`, `src/background/welcome-tab.ts` |
  | `sidePanel.open` (the side panel itself: 114) | 116 | `src/background/index.ts:89`, `router.ts` (case `show-in-panel`) |
  | Popover top layer (`popover`, `showPopover`) | 114 | `src/content/host.ts:40` |
  | `offscreen` | 109 | `src/background/offscreen-client.ts:61` |
  | `storage.local.setAccessLevel` (optional: without it, the worker only warns) | 102 | `src/background/index.ts:21` |
  | `alarms` | any | 5-minute and weekly alarms; none shorter than the 30 s that needs Chrome 120 |

- **`description`**: "Identify trading cards in duel videos and streams: select a Yu-Gi-Oh! card on screen to read its text in place. Unofficial fan tool." It is exactly 132 characters, the store's limit. Yu-Gi-Oh! appears once, only to say what the cards are, and "Unofficial fan tool" makes clear there is no link with Konami.
- **`icons`**: 16, 32, 48 and 128 px PNGs, each checked against the size it's declared at. The 128 px icon is 96×96 art with 16 px of transparent padding, as the store asks.
- **Permissions** of the store build, with where each is used:

  | Permission | Used for |
  |---|---|
  | `activeTab` | The shortcut and toolbar click (`src/background/index.ts:84-95`) grant access to the current tab only, for the screenshot (`scan.ts:34`) and the content script (`scan.ts:36-38`). Before the first-run consent, a scan only opens the welcome page's consent step (`scan.ts:131-134`). |
  | `scripting` | Injecting `content.js` on demand (`scan.ts:36-38`). |
  | `offscreen` | The recognition engine's document (`offscreen-client.ts:61-64`). |
  | `storage` | Settings, the consent date, the history with a small picture per scan, and the current card (`settings.ts`, `consent.ts`, `history.ts`). |
  | `unlimitedStorage` | The card database in IndexedDB (`card-store.ts:58-71`) and the history with its pictures in `chrome.storage.local`, safe from eviction. In builds with remote images, also the self-updating artwork index (`index-update.ts:341`, `src/offscreen/delta-index.ts:44`) and the image cache (`image-cache.ts:15`). It shows no install warning. |
  | `sidePanel` | The side panel (`src/background/index.ts:89`, and `router.ts`, case `show-in-panel`). |
  | `alarms` | The weekly card-data refresh and closing the idle engine (`src/background/index.ts:47-52`, `:66-82`; `offscreen-client.ts:109`). |
  | host permissions | **`https://images.ygoprodeck.com/*`** (decision D2, decided 2026-09-29): that host sends no CORS headers, so displaying its card images and downloading new cards' artwork needs host access. The weekly card-data refresh itself needs none: `db.ygoprodeck.com` answers `Access-Control-Allow-Origin: *`, checked with curl and with a real build with no host permissions in Chrome for Testing (`.superpowers/sdd/2026-09-28-duel-lens-v1/compliance-report.md`, "Decisions I took", 1). A unit test keeps its requests plain GETs that need no preflight (`src/background/card-store.test.ts:202-215`). The crop build (`--no-remote-images`) asks for no host at all, and the E2E build adds `<all_urls>`. |
  | optional host `api.anthropic.com` | The opt-in AI check, requested when the user turns it on (`src/options/app.tsx:157`). Ask AI and Test refuse without it (`router.ts`, cases `ask-ai` and `test-ai`). |

  None of these API permissions is on Chrome's warning list, but the host permission is: the store build's install warning reads "Read and change your data on images.ygoprodeck.com". Only the crop build (`--no-remote-images`) installs with no permission warning at all.
