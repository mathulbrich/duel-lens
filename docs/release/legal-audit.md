# Legal and licensing audit: Duel Lens public release

- **Date:** 2026-09-29, overnight. Written by the legal workstream (an AI agent) for the owner's morning review.
- **Scope:**
  - every file in `dist/`;
  - the npm packages and native libraries bundled into it;
  - the model and the data;
  - Konami's trademarks and copyrights;
  - YGOPRODeck's API rules;
  - the Anthropic API;
  - the Chrome Web Store's policies;
  - the project's own licence.
- **Companion files:**
  - [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md)
  - [`privacy-policy.md`](privacy-policy.md)
  - [`disclaimers.md`](disclaimers.md)
- **Not legal advice.** This is an engineering audit, done carefully and with sources, but it isn't a lawyer's opinion. If a takedown notice, a cease-and-desist letter or money is ever involved, ask a lawyer.

## Status update, 2026-09-29 around 06:00

Sections 0 to 15 and Appendix A below are the original audit, written around 01:00, and are left as they were. This section records what changed since, with the evidence. The compliance round is `.superpowers/sdd/2026-09-28-duel-lens-v1/compliance-report.md`. Line numbers are as of around 06:05; the DRAW2 removal (A6) is still moving code in `src/offscreen/`, `src/content/popover.tsx`, `src/background/router.ts` and `build.mjs`.

**The blockers:**

| # | Blocker | Status | Evidence |
|---|---|---|---|
| **B1** | DRAW2's AGPL-derived code in `offscreen.js` | **In progress** (A6, dispatched around 05:20). The bundle has been clean since about 06:00; A6 hasn't reported yet. | See below the table. |
| **B2** | Card images and artwork fetched from `images.ygoprodeck.com` in every user's browser | **Addressed by store mode; the final call is D2.** The default build (and so `npm run release`) is text-only with the user's own crop, R2 (c), and downloads no artwork. `--remote-images` brings YGOPRODeck's images back, for use only after a written OK. | See below the table. |
| **B3** | No notices or licence in the package | **Notices bundled; `LICENSE` pending D1.** Every build carries `THIRD_PARTY_NOTICES.md`, without its maintainer comments, and `LICENSE` once the repository has one (`build.mjs:146-150`). The bundled `licenses.html` shows them, `LICENSE` first, and the welcome page and Options → About link to it. | The notices were re-checked against the 05:30 and 06:00 store builds, and one fix was needed: Preact is also in the new `legal.js`. `src/legal/pages.tsx`; `src/welcome/markdown.test.tsx` checks that every contents link of the notices resolves. `npm run release` doesn't yet fail when the notices or `LICENSE` are missing (`packaging.md`, "Not checked yet"). |
| **B4** | No in-product consent before the first scan | **Done.** | See below the table. |

**B1, in detail.**
- A store build made at 05:30 (`node build.mjs --out` into a scratch folder) still failed the release verification. It bundled `src/offscreen/draw2/` (`labels.ts`, `geometry.ts`, `spec.ts`, `tensors.ts`, `recognizer.ts`, `web.ts`), and "draw2" appears 76 times in its `offscreen.js`.
- **A new store build of the live tree at 06:00 passed: 0 errors, 0 warnings.**
  - No production module imports `src/offscreen/draw2/` any more; the folder and its tests are still there.
  - The 3 "draw2" left in `offscreen.js` are calibration notes in `src/shared/models.ts` comments. §4.6's `grep` therefore prints 3, not 0.
  - A6's report will be `.superpowers/sdd/2026-09-28-duel-lens-v1/a6-phase1-report.md`. Treat B1 as closed only when it confirms the deletion and a full `npm run release` passes.
- The geometry helpers were rewritten from the maths, as §4.2 asks (`src/offscreen/geometry.ts`: "Provenance: written from scratch from the mathematical definitions; not derived from DRAW2"; `geometry-report.md`).
- DRAW2's models haven't shipped by default since `build.mjs` made them opt-in, and the `--with-draw2` flag was removed at 05:53.
- Recognition now runs on our own fine-tuned model (Apache-2.0 base, `facebook/dinov2-small`; §5.1) with OpenCV.js for card finding. Our own card detector is still in training and doesn't ship: `build.mjs` copies only the default model, and `src/offscreen/index.ts` registers no detector.

**B2, in detail.**
- In a store build:
  - the popover and the side panel show the user's crop (`src/content/app.tsx:190`, `:315`; `src/sidepanel/app.tsx:164`);
  - `get-image` answers nothing, and `update-index` refuses (`src/background/router.ts`);
  - no artwork run starts (`src/background/index.ts:41`, `:61`, `:79`);
  - the manifest has **no host permissions at all**: `db.ygoprodeck.com` works without one, because its API answers `Access-Control-Allow-Origin: *` (curl, a real build in Chrome for Testing, and `src/background/card-store.test.ts:194-206`);
  - a 160 px picture of each scan is kept locally with the history, and disclosed.
- Checks: the store build's seven bundles have 0 hits for `images.ygoprodeck.com`, and the store-mode E2E run made 0 requests to it (`compliance-evidence/e2e-store-3.txt`).
- `build.mjs:21-24` and `:131-145` hold the switch. Appendix A's email describes the old behaviour; the release checklist ("USER MUST DO", D2) has an updated draft for the store build.

**B4, in detail.**
- A fresh install opens the welcome page (`src/background/index.ts:28-32`).
- Its "Before your first scan" step shows the `disclaimers.md` §4a text, in its text-only variant, with **Agree and start**, **Not now** and a Privacy policy link (`src/welcome/consent.tsx`, `src/welcome/copy.ts`).
- Until the user agrees, the shortcut and the toolbar button only open that step: no capture, no message and no script reach the page (`src/background/scan.ts:131-134`).
- Options → About shows the date of the agreement.
- Every E2E run checks the gate (`compliance-evidence/e2e-board-2.txt`, `e2e-store-3.txt`).
- The policy itself is bundled as `privacy.html`, and `docs/release/privacy-policy.md` Appendix D is the same text to host (D5).

**Other points of this audit, now:**
- **§1, what ships.** A store build has 31 files, 74.0 MB unpacked. New since the audit:
  - `welcome.html`, `welcome.js`, `privacy.html`, `licenses.html` and `legal.js`: ours, plus Preact;
  - `THIRD_PARTY_NOTICES.md`.

  The detector's model (`extension/models/detector/`) is filtered out like the benchmark models.
- **§8, Anthropic.**
  - Done: Ask AI and Test refuse without the `api.anthropic.com` permission.
  - Still open: a "Remove key" button; clearing the key and calling `permissions.remove` when the check is turned off; and the popover's "Ask AI" button, which `aiEnabled` still offers without the permission (it checks only the setting and the key).
- **§10, privacy.**
  - A store build contacts only `db.ygoprodeck.com`: the version check and, when it changed, the full card list. Its URLs name no card, so YGOPRODeck no longer learns which cards a user looks at. The only other host is `api.anthropic.com`, and only for the opt-in AI check.
  - §10's "YGOPRODeck: always. It also learns which card images are requested" now applies only to `--remote-images` builds. §12's replacement for "None of this sends anything from your screen" is in (`src/welcome/copy.ts`, `online`).
- **§11, decisions.**
  - D8 is done: "Save crops" is compiled only into `--dev` and `--e2e` builds (`src/options/app.tsx:408`).
  - D2 has a safe default built in (R2 c).
  - D9 is reflected in `store/screenshots-plan.md`: no broadcast frames, synthetic scenes or the user's own footage.
  - D13's switch isn't built (optional in §4a).
  - D1 to D7 and D10 to D12 are still the user's.
  - `docs/release/RELEASE-CHECKLIST.md` now uses this audit's D-numbers, and numbers its store-only decisions D14 to D20, so the numbering table in §11 is obsolete.
- **§12, changes for other workstreams.**
  - Done: the consent gate and step; the short disclaimer (`DISCLAIMER`); the bundled privacy and licences pages, in place of hosted URLs inside the extension; the notices in the build; the debug hook, the page-readable state mirror and the Debug section out of store builds.
  - Open: a release check for missing notices and `LICENSE`; "Remove key"; sender checks (final review, item 10); ONNX metadata at the next model export.
  - R3's items (client identification, image-cache cap, `Retry-After`) now matter only for `--remote-images` builds. Dropping `misc=yes` would still shrink the weekly download.
- **§13, risks.**
  - Down: risk 2 (YGOPRODeck blocking), with no image or artwork traffic from store builds; 4b (no consent), mitigated; 5 (notices), mitigated; 12 (EU third-party requests), down to one host and no card IDs.
  - Risk 1 (AGPL): the bundle has been clean since about 06:00; the risk closes when A6 lands and a full release run passes.
- **§14, the metafile script.** Add `legal: 'src/legal/index.tsx'` to its `entries`, and define `__DUEL_LENS_REMOTE_IMAGES__: 'false'` and `__DUEL_LENS_DEV__: 'false'`, as a store build does. Without those two defines esbuild keeps both branches of each flag. That doesn't add an npm package, but the inputs list includes the remote-image code.
- **Wording for the legal owner to check** (the compliance round's open point 2): the store-mode variants in `src/welcome/copy.ts` and `src/legal/policy.ts` are the compliance agent's. One nit: the store policy's permission row says `storage, unlimitedStorage` keep "the artwork index on your computer", but a store build stores no artwork index in the browser. The index ships inside the extension, and the local delta database is only read, and stays empty.

## Status update, 2026-09-29 around 09:00 (final overnight sync)

Since the 06:00 update above: A4 (our own card detector, OpenCV's removal) reported done, and A6 phase 1
(the extension side of the DRAW2 removal) reported done. This section's evidence is `a4-report.md` and
`a6-phase1-report.md`, plus an independent re-check this sync ran itself (a fresh `node build.mjs --out`
scratch build, and the release zip already on disk).

**B1 (DRAW2's AGPL-derived code), updated: extension DONE, repository DOING.**
- **The extension no longer ships DRAW2 in any form.** `a6-phase1-report.md`: no extension entry point
  imports `src/offscreen/draw2/`, directly or indirectly, proven per entry with esbuild metafiles; the
  bundles carry none of DRAW2's modules or identifiers. This sync's own scratch build and a check of the
  release zip on disk (`release/duel-lens-0.9.0.zip`) both independently confirm **0 "draw2" hits**, case
  insensitive, in every shipped `.js` file — including the 3 comment-only hits the 06:00 update still
  counted (they were in `src/shared/models.ts` comments, since cleaned up along with everything else A4/A6
  touched there).
- **Not yet done: deleting DRAW2 from the repository.** `src/offscreen/draw2/` and its tests,
  `extension/models/draw2/` (`detector.onnx` 39,016,336 B, `classifier.onnx` 98,128,635 B, `labels.json`,
  `LICENSE`, `README.md`), and the DRAW2-only tools (`tools/train-detector/draw2-proposals.ts` and
  similar) are all still on disk. This is A6 phase 2, dispatched and running now, per the task brief; its
  report (`a6-phase2-report.md`) had not appeared in the SDD folder as of this update. None of it ships
  either way — `npm run release` refuses any build with DRAW2 code or the `models/draw2` string — but the
  repository isn't clean of AGPL-3.0 code yet, which matters for D7 (publishing the source).
- **Treat B1 as: shippability resolved, repository hygiene open.** Don't publish the source (D7) until
  A6 phase 2 reports and the deletion is confirmed.

**OpenCV.js: removed, not just deferred.** The 06:00 update above (line 40) said recognition "runs on our
own fine-tuned model … with OpenCV.js for card finding" and that "our own card detector is still in
training and doesn't ship." Both are now superseded: OpenCV.js is gone from the code and from
`package.json` (`@techstark/opencv-js` is only an extraneous `node_modules` leftover until the next
install), and our own detector ships and does the card finding OpenCV used to do. `offscreen.js` dropped
from 17.9 MB (one 17,540,593-character string, OpenCV's inlined WebAssembly — the "Red Titanium"
obfuscation look-alike, §9/RELEASE-CHECKLIST C7) to 188,327 B. Re-verified this sync: 0 "opencv" hits in
any shipped bundle.

**The detector's licence.** `extension/models/detector/card-detector.onnx` (6,184,172 B) is Duel Lens's
own model: a CenterNet-style oriented-box detector (project-original neck and heads) on a MobileNetV3-Large
backbone. Backbone weights `timm/mobilenetv3_large_100.ra_in1k` (Hugging Face; Apache-2.0), pretrained on
ImageNet-1k (its own research-use terms apply to the checkpoint, not to Duel Lens's redistribution of it).
Fine-tuned by the Duel Lens authors on **synthetic duel-stream frames only** (rendered from YGOPRODeck
artwork and the official card back; no video frame was used for training) and exported to ONNX with 16-bit
weights. **Licence: Apache-2.0**, same as the card-artwork embedder, so it adds no new licence to track —
see `THIRD_PARTY_NOTICES.md` §2.2 (now current) and §1's summary row. No change needed to §3 (licence
compatibility) or §11 D1's recommendation.

**Numbers, for the record** (real-footage evaluation, `tools/eval-real.ts` on `data/realset`: 120 cards,
70 non-card boxes, 9 productions): 116/120 right, 115 confident, 0 confident wrong; 0/70 non-card boxes
confident; click-to-scan E2E 115/120, 0 wrong. Release zip: 39,567,291 B (39.6 MB), SHA-256
`53c7a8131fb61436f7f1f78d128daef89cf46656295f5908e06c0c6e34e8aa05`, re-verified this sync (recomputed hash
matches; `unzip -t` clean).

**Stale text from the 06:00 update, not rewritten above it (that section is left as a historical record;
this note is the correction):** line 40's "OpenCV.js for card finding" and "still in training and doesn't
ship," and §13's risk-1 line 85 ("the risk closes when A6 lands and a full release run passes") — A6 phase
1 has landed and `npm run release -- --skip-e2e` has passed on the current tree, but see B1 above: the
repository-deletion half of A6 (phase 2) is still open, so don't mark risk 1 fully closed until it reports.

**Two more stale cross-references, in the original audit (sections 0–15, left as they were per this
file's own rule — not edited here, flagged for whoever next touches section 14 or the D1 table):**
- **Line 309** ("(a) include the licence text | Done: notices §9.1") should read **§8.1**: removing
  OpenCV's section renumbered `THIRD_PARTY_NOTICES.md`'s old §6–§9 to §5–§8 (its own maintainer comment
  says so).
- **Line 744** ("4. After an OpenCV.js upgrade: … update notices §5") is now **obsolete**: there is no
  OpenCV.js left to upgrade, and notices §5 today is "Emscripten runtime, musl and LLVM," unrelated to
  OpenCV. Delete that maintenance step next time section 14 is touched.

**B1, now fully closed: A6 phase 2 has reported.** `a6-phase2-report.md`
(`.superpowers/sdd/2026-09-28-duel-lens-v1/`, 2026-09-29): DRAW2 is deleted from the repository, not only
decoupled from the bundles.
- **Deleted:** `src/offscreen/draw2/` (24 source files, 92 tests), the art check
  (`tools/lib/art-check.ts`, `tools/calibrate-art-check.ts`, `src/offscreen/art-check.ts`), and the
  DRAW2-only tools (`tools/detect-frame.ts`, `tools/train-detector/draw2-proposals.ts`,
  `tools/realset/label.ts`).
- **Moved, not deleted:** `extension/models/draw2/` (`LICENSE`, `README.md`, both `.onnx` files) into the
  gitignored `data/draw2-archive/models/`.
- **§4's list above is now historical**: everything it names to delete or move has been, as just
  described. **§4.4's `draw2_warp`** (`tools/train/prepare.py`) wasn't only removed: it's **replaced** by
  a from-scratch `warp_quad`, using OpenCV's `warpPerspective` with `geometry.ts`'s half-pixel convention
  rather than any DRAW2-derived maths. Checked against the old function's output on 10 real rows: 9 match
  to a mean difference of 0.000 (at most 1 level), and the tenth (a card cut by the frame edge) differs
  only in its 1-px border ring.
- **The grep proof:** `grep -rni draw2 src tools test build.mjs package.json README.md` now gives 25
  lines in 6 files, none in `src/`, `test/`, `build.mjs`, `package.json` or `README.md`. What remains is
  data provenance (`tools/realset/`, `tools/train-detector/label_fullview.py`,
  `tools/train/common.py`'s gitignored data path) and the release guard itself (`tools/release.mjs`,
  `tools/release.test.ts`), kept deliberately — §4.6's check still stands, now with its own
  mutation-tested guard test.
- **Unit tests: 69 files, 955 passed, 8 skipped, 0 failed** (the prior 78 files/1046 tests minus the 9
  deleted DRAW2 files' 92 tests, plus 1 new guard test). eval-real and the end-to-end suites are
  unchanged: the same 116/120 cards and 0/70 confident negatives, row for row identical to A4.
- **The release gate didn't complete this run, but not over DRAW2:** `npm run release -- --skip-e2e`
  stopped at `tsc`, on errors confined to another agent's in-progress `tools/live-check/` folder (an
  unresolved `puppeteer` import). Run directly, the release's own build-and-verify functions produced a
  store build byte-identical to A4's, and the same zip SHA-256
  (`53c7a8131fb61436f7f1f78d128daef89cf46656295f5908e06c0c6e34e8aa05`). Re-run `npm run release` once
  `tools/live-check` compiles.
- **Risk 1 (AGPL) is now fully down**, not just the shippability half: no DRAW2-derived code remains
  anywhere in the repository outside the gitignored archive and the two exceptions above.

## Status update, 2026-09-29 around 10:35 (D2 decided; Genesys points added)

Since the 09:00 update above: the user decided **D2** (official card images from `images.ygoprodeck.com`
in every build, including the store build), and two more waves landed — fix wave F2
(`.superpowers/sdd/2026-09-28-duel-lens-v1/fix-f2-report.md`, 09:48–10:18) and the Genesys-points
addition (`genesys-report.md`, ~10:26). As before, sections 0–15 and Appendix A below are left as they
were; this section is the correction, not a rewrite of them.

**D2: official card images, decided.** Every build — the store build included — now shows YGOPRODeck's
official card images and downloads new cards' artwork by default (`build.mjs`: `remoteImages =
!cli.flags.has('--no-remote-images')`, true unless that flag is passed). Each image is downloaded once
per user and cached indefinitely (Cache Storage, now capped at the 1,500 most recently used images,
`fix-f2-report.md` item 4). The manifest's `host_permissions` is `https://images.ygoprodeck.com/*` by
default, because that server sends no CORS headers; the Anthropic origin stays optional.
`--no-remote-images` gives back the old crop build — the user's own selection as the picture, no card
image or artwork traffic, no host permission — kept as a one-flag rollback.

**B2 (§13 risk 2, `images.ygoprodeck.com` hotlinking) is now an accepted risk, not a blocker.** The user
chose to launch with official images rather than wait for YGOPRODeck's answer or launch text-only. The
mitigations in place:
- **per-user caching**, already the design (`image-cache.ts`): each image is fetched once per user and
  kept, not re-fetched on every view, and the cache is now capped (above) so it can't grow without bound;
- **a courtesy email to YGOPRODeck before submission**: `RELEASE-CHECKLIST.md`'s USER MUST DO now points
  at this file's own Appendix A as the email to send — a courtesy and not a precondition, since the
  release no longer waits on an answer; it stays a draft until the user sends it themselves, and that
  must happen before submitting to the store, not before shipping the build;
- **a one-flag rollback**: `--no-remote-images` is a real, tested build (`fix-f2-report.md`'s D2 tests: a
  real `--no-remote-images` build with 0 hosts and 0 `images.ygoprodeck.com` bundle mentions, `verifyBuild`
  0 errors), so reverting to the text-only build if YGOPRODeck ever objects is a single flag, not new
  engineering.

**Genesys points.** A card-database refresh now makes a third request to `db.ygoprodeck.com`:
`cardinfo.php?format=genesys&misc=yes`, merged into the stored cards by id, then artwork, then exact
name; the popover shows a "Genesys N pts" chip. This request needs no host permission either — its CORS
answer was checked the same way as the others (curl, 2026-09-29, `genesys-report.md`). The bundled
`extension/data/cards.json` was regenerated with the merge (761 of 14,590 cards got points; the file is
otherwise byte-identical) and `src/legal/policy.ts` §3.1 now lists the Genesys request in every build's
text, store included.

**Stale cross-references in this file, now superseded (left in place, per this file's own rule):**
- **Line 28** (the B2 status-table row, "Addressed by store mode; the final call is D2 … `--remote-images`
  brings YGOPRODeck's images back, for use only after a written OK") and **line 44** ("the popover and the
  side panel show the user's crop") describe the pre-D2 default; see above for the current one.
- **Line 47**'s citation `src/background/card-store.test.ts:194-206` is now `:202-215` (the file grew with
  the Genesys tests).
- **Line 50**'s `build.mjs:21-24` and `:131-145` citations are now that file's header comment (lines 1-24)
  and its `copyStatic` host-permission block (lines 203-216).
- **Lines 70–71** ("A store build contacts only `db.ygoprodeck.com` … The only other host is
  `api.anthropic.com`") predate D2 and the Genesys request: a default build also contacts
  `images.ygoprodeck.com`, and `db.ygoprodeck.com` now answers two card-list requests, not one, when the
  version changes.
- **§6.2's request table (around line 402) and §6.4's scale illustration** describe the *pre-D2, pre-
  Genesys* traffic pattern (one client's worth, opt-in images). With D2 decided, every user's browser now
  makes the image and artwork requests §6.2 lists as hypothetical; add a third `db.ygoprodeck.com` row for
  `cardinfo.php?format=genesys&misc=yes` (sent only when the version changed, about 25 MB of JSON, 3.5 MB
  brotli — `genesys-report.md`).
- **§6.5's R2 recommendation ("Launch with (c) unless you have a written OK")** was not followed as
  written: the user launched with official images now, accepting the risk R2 describes, with a courtesy
  email before submission rather than a precondition on YGOPRODeck's answer.
- **The D2 row in §11's decision table (around line 675)** ("TODO … my recommendation: (a) now, launch
  with (c) unless (a) comes back yes") is superseded: D2 is decided — official images.
- **§12's "Manifest (P): Once D2/D3 are settled, update `host_permissions`" (around line 735)**: D2 is
  settled; `build.mjs` and `tools/release.mjs` already add `https://images.ygoprodeck.com/*` by default
  (`fix-f2-report.md`).

**Evidence:** `fix-f2-report.md` (D2's implementation, tests and the release zip:
`release/duel-lens-0.9.0.zip`, 39,571,762 B, SHA-256
`c7600013bf93327660df6b10c43ff70519db3c3e32715f5f0de934cccdbc14f0`) and `genesys-report.md` (the
Genesys-points implementation, tests and the regenerated `cards.json`). `docs/release/RELEASE-CHECKLIST.md`'s
Verification snapshot and D2 row carry the same numbers.

## Status update, 2026-09-29 around 12:10 (the AI permission fully enforced; the release checks the legal files)

Since the 10:35 update above: the post-click fix round
(`.superpowers/sdd/2026-09-28-duel-lens-v1/final-fixes-x-report.md`, items M10 and M12, 11:34–12:08)
closed two items this audit still had open. As before, sections 0–15 and Appendix A are left as they
were; this section is the correction.

**§8, Anthropic (line 68 above, now stale).** That line's "Still open" no longer holds except for the
"Remove key" button. `aiEnabled` now checks the permission as well as the setting and the key, so the
popover's "Ask AI" button is offered only once the permission is granted (`src/background/router.ts:223-225`);
turning the AI check off in Options calls `chrome.permissions.remove` (`src/options/app.tsx:154-173`), so
the permission doesn't linger once revoked. The key itself still isn't cleared by that toggle — clearing
its field remains the only way, as `disclaimers.md` §5 already tells the user, and no separate "Remove
key" button is planned. `RELEASE-CHECKLIST.md`'s C5 is now DONE.

**§12 (line 81 above, now stale).** "A release check for missing notices and `LICENSE`" is no longer
open: `tools/release.mjs`'s `verifyBuild` errors when `THIRD_PARTY_NOTICES.md`, `privacy.html` or
`licenses.html` is missing, and warns (not yet an error, pending D1) when `LICENSE` is missing. The
store-host checks it mentions in the same breath (`images.ygoprodeck.com`) already existed before this
change. `RELEASE-CHECKLIST.md`'s C19 is now DONE, apart from the LICENSE warning becoming an error once
D1 is chosen. "Remove key", sender checks (final review, item 10) and ONNX metadata at the next model
export are still open.

## Status update, 2026-09-30 around 06:15 (the embedder retrained on real card crops)

Since the 12:10 update, the default embedding model is `dinov2-small-duel-v3b`. That change is local: nothing is committed, and it is not in any submitted release (v0.9.0 ships `dinov2-small-duel`). It is `dinov2-small-duel` (§5.1) fine-tuned further on real card crops from tournament videos. So for this model, two statements below no longer hold:
- §1's model row;
- §5.1's "Real broadcast frames were only looked at … Their labels were never used."

As before, sections 0 to 15 are left as they were; this section is the correction. `THIRD_PARTY_NOTICES.md` 2.1 already states the new training data.

**The new training data** (details: `.superpowers/sdd/2026-09-28-duel-lens-v1/overnight-plan.md`, `overnight-p5-report.md`):
- **What:** 68,632 images of single cards (15,167 card tracks) from 51 publicly available Yu-Gi-Oh! tournament videos on YouTube, mostly the official channel's event broadcasts from 2024 to 2026.
- **How they were read:** overnight on 2026-09-30, by a headless Chrome (Puppeteer) that was not signed in. It opened each video at sampled moments and captured 5 frames per moment, about 3,300 moments in all.
- **Cards only:**
  - Each image is one card, cut tightly around its outline (at most a 4% margin) and straightened, about 256 px.
  - Frames were processed in memory and discarded. No full frame, face, logo or overlay from a training video was saved.
  - Images showing people were removed: Apple Vision face and person scans (on-device), a size guard (no crop of 110 px or more), and manual checks. One video, with people walking past giant display cards, was excluded entirely.
- **Where the data lives:** the crops stay on the machine that made them (`data/overnight/`, gitignored). Full frames were kept only for held-out TEST videos (`data/realset2/`, gitignored, never trained on). Players may be visible in those frames.

**Risk (my estimate, not legal advice):**
- **Copyright: low, unchanged (§7.5).**
  - The crops show Konami's card art, which the model already learned from YGOPRODeck's images. The model stores no images and can't reproduce them.
  - A tightly cut card carries almost nothing of the broadcast's own expression (camera work, overlays, commentary).
- **YouTube's Terms of Service ("Permissions and Restrictions", as served on 2026-09-30; in effect since 5 January 2022).** They don't allow:
  - downloading or otherwise using any Content without YouTube's express authorisation or written permission (and the rights holder's);
  - accessing the Service "using any automated means (such as robots, botnets or scrapers)", except public search engines following robots.txt, or with YouTube's prior written permission.

  The harvest did both, at a small scale. This is a question of YouTube's contract terms rather than copyright. No account was involved, and the realistic consequence is YouTube blocking the harvester. Still, a release with v3b would put a model trained this way on the Chrome Web Store.
- **Owner's decision (new, D21; RELEASE-CHECKLIST.md numbers its own D14 to D20):**
  - ship `dinov2-small-duel-v3b` (better on real footage; the notices state its training data);
  - or keep shipping `dinov2-small-duel` and use v3b only locally;
  - and, for future harvests, whether to use only videos whose owners allow it (for example, the owner's own recordings, or with written permission).

## Status update, 2026-09-30 around 12:30 (artworks YGOPRODeck lacks, from Konami's renders, at build time only)

Since the 06:15 update: some cards have official artworks that YGOPRODeck has no image of. The trigger was Artemis, the Magistus Moon Maiden's second artwork, which the owner met in a video; others include Ash Blossom's third and Called by the Grave's second (`.superpowers/sdd/2026-09-28-duel-lens-v1/artemis-report.md`). On the owner's decision of 2026-09-30, both artwork indexes, the default `dinov2-small-duel-v3b`'s and `dinov2-small-duel`'s, now also hold 267 vectors of such artworks, for 234 cards (`altart-report.md`; 268 until the review's fix round dropped a near-duplicate recolour). As before, sections 0 to 15 are left as they were and this section is the correction: §1's index row and §5.2 describe an index computed from YGOPRODeck's images alone. `THIRD_PARTY_NOTICES.md` 2.3 already states the new source.

**The second build-time source:**
- **What:** YGOResources (`ygoresources.com`), a fan site that mirrors Konami's official card data, including Konami's own card renders (its "Neuron" renders). Its manifest of those renders has been in `data/raw/` since 2026-09-28. Its API page asks callers to query only what they need, cache it locally and not query the whole database; I found no licence, copyright notice or terms for its images.
- **How it was used:** `tools/fetch-alt-artworks.ts` downloaded 691 renders (256 × 372 px) once, on 2026-09-30:
  - only the cards whose Konami artworks outnumber their YGOPRODeck images, and only the artworks printed in the TCG;
  - one request at a time, at most one per second, with an identifying User-Agent (`DuelLens/0.1 (personal project)`; since the review's fix round, the tools' User-Agent also names the project's repository as a contact);
  - only the clean renders, never the watermarked "SAMPLE" copies.

  The renders stay on the machine that made them (`data/alt-artworks/`, not in git). `tools/add-alt-artworks.ts` computed a vector from each render's artwork area and kept the 267 artworks that no YGOPRODeck image already covers.
- **What ships:** 267 more vectors per index (384 numbers, 8-bit), exactly like the ones computed from YGOPRODeck's images. No image ships. The `.meta.json` records each vector's provenance: source "konami", Konami's card id and the artwork number.

**Nothing changes at runtime:**
- No new host, permission or request. The extension never contacts YGOResources.
- A match on one of these artworks shows the card's own YGOPRODeck image, the same `images.ygoprodeck.com` request as for any other match.
- The self-updating index still downloads only YGOPRODeck's artwork, and never these.
- `extension/manifest.json`'s permissions and host permissions are unchanged.
- **The privacy policy needs no change, and I made none.** `privacy-policy.md` and `src/legal/policy.ts` describe only what happens at runtime (the hosts contacted, what is stored), and say that the models and the index are packaged files. That all still holds.

**Risk (my estimate, not legal advice):**
- **Copyright: low, unchanged (§7.5).** These are the same kind of derived vectors as before. The artwork is Konami's either way, no image is stored, and the vectors can't reproduce it.
- **The source:** a one-time, rate-limited, cached download of 691 files is well within what YGOResources asks of API callers.
- **An alternative that drops this source:** ask YGOPRODeck to add the missing artworks (`artemis-report.md`, option B). The self-updating index would then pick them up, and these extras could be removed in a later release.

## 0. Read this first

**Verdict: not ready to publish yet.** Nothing I found is fatal. Four things block a public release, and each has a clear fix.

| # | Blocker | Fix |
|---|---|---|
| **B1** | **DRAW2's AGPL-derived code still ships.** `dist/offscreen.js` bundles `src/offscreen/draw2/*`, a port of DRAW2's AGPL-3.0 browser pipeline ("draw2" appears 66 times in the bundle; the entry point still wires `loadDraw2: () => createWebDraw2()`). The build now leaves DRAW2's models out by default (`build.mjs` needs `--with-draw2`), but the code stays until it is deleted. Publishing it would oblige you to release the whole extension under AGPL-3.0. | Delete it, as planned (section 4). Don't *move* the geometry helpers out of `draw2/`: they are ported code too. Rewrite them. |
| **B2** | **Card images and artwork are fetched from `images.ygoprodeck.com` in every user's browser.** YGOPRODeck's API guide says not to hotlink its images, to download and re-host them yourself, and that it blacklists IPs that pull many images. That is fine for you alone, but not for a public extension. | Pick an option in section 6.5 (decisions D2 and D3). The cleanest: your own update feed for data and index vectors, plus a written OK from YGOPRODeck, re-hosting, or text-only for the display images. |
| **B3** | **No notices or licence in the package.** `dist/` has no third-party notices, no Apache-2.0 text for the model or the other Apache components, no BSD notices for protobuf and RE2, and no `LICENSE` for Duel Lens itself. Only the fonts' `OFL.txt` is there. | Ship `THIRD_PARTY_NOTICES.md` (written tonight) and your `LICENSE` inside the zip, and link them from the Options "Licences" link (section 12). |
| **B4** | **The store's privacy requirements.** Duel Lens handles user data: screenshots, page addresses in its history, an API key. So the Chrome Web Store needs three things, even though everything is stored locally:<br>1. a privacy policy at a public URL;<br>2. the Privacy practices form;<br>3. **a prominent disclosure inside the extension, with affirmative consent before the data is first handled.** The store description doesn't count. "By using you agree" doesn't count. Since the 2026-07-01 policy update (enforced from 2026-08-01), this applies to *all* data handling, even when it's closely related to the feature. **Today nothing asks for consent before the first scan.** | 1. Host [`privacy-policy.md`](privacy-policy.md) after filling in your name and contact, and use its Appendix B for the store form.<br>2. Add a consent step before the first scan. The text is in [`disclaimers.md`](disclaimers.md) §4a, and the implementation notes are in §12. |

**The top risks once those are fixed** (section 13 has the full register):

1. **Konami.** Card text is bundled in `cards.json`, card images are shown, and a model was trained on the card art. The realistic worst case is a takedown request through Google, which would remove the listing. Stay non-commercial, keep the disclaimers, use no Konami logos and no Konami broadcast footage in the listing, and answer takedown requests quickly.
2. **YGOPRODeck** blocking users' IPs or the extension, if B2 is left as it is.
3. **The Anthropic key.** It is stored unencrypted in the browser, which is normal for a bring-your-own-key extension. It needs clear wording and a "Remove key" control.

**Decisions only you can make** (details in section 11):

| # | Decision | My recommendation |
|---|---|---|
| D1 | The project's licence | Apache-2.0 |
| D2 | Card images at public scale | Ask YGOPRODeck now; if there's no answer, launch text-only |
| D3 | Card data and index updates | Your own update feed |
| D4 | The publisher name and contact email | A dedicated address |
| D5 | Where to host the privacy policy | Your repo's GitHub Pages |
| D6 | Monetisation | None |
| D7 | Whether to publish the source | Yes, after a clean-up |
| D8 | The debug "Save crops" option in the store build | Remove it or put it behind a flag |
| D9 | Store screenshots | Your own footage, never Konami's broadcasts |
| D10 | The model's licence and metadata | Apache-2.0, as `docs/DEVELOPMENT.md` says |
| D11 | Whether to send the draft email to YGOPRODeck | Yes (Appendix A) |
| D12 | An optional trademark search for "Duel Lens" | Low priority |
| D13 | Page addresses in the history | Keep them, behind the consent step, with an off switch |

## 1. What ships: `dist/` file by file

`dist/` as built on 2026-09-29 at 00:08: the interim build without DRAW2's models, 25 files, about 73 MB. Hashes were checked for the model (`02d97205…`, which matches `docs/DEVELOPMENT.md`) and the ORT wasm (`3398c10d…`, identical to `node_modules`).

| File | Size | What it is | Owner and licence | Verdict |
|---|---|---|---|---|
| `manifest.json` | 1.6 KB | Extension manifest | Ours | **OK.** The source manifest is now v0.9.0, and its description ends "Unofficial fan tool." (exactly 132 characters, the limit). |
| `background.js` | 590 KB | Service worker: ours, plus the Anthropic SDK 0.128.0 (492 KB; MIT, © Anthropic, PBC). The SDK vendors `qs` (BSD-3-Clause) and `partial-json-parser` (ISC). Also standardwebhooks 1.1.1 (MIT, © Svix), @stablelib/base64 1.0.1 (MIT) and fast-sha256 1.3.0 (Unlicense). | Mixed, all permissive | **OK with notices** (notices §3). The SDK is only used for the opt-in AI check. |
| `content.js` | 88 KB | Selection layer and popover: ours, plus Preact 10.29.8 | Ours; Preact MIT | **OK with notice.** |
| `offscreen.html`, `options.html`, `sidepanel.html` | < 1 KB each | Page shells | Ours | **OK.** |
| `offscreen.js` | 17.9 MB | Recognition engine: ours, plus OpenCV.js 5.0.0 (17.7 MB, Apache-2.0) and ONNX Runtime Web's JS (MIT). OpenCV.js carries protobuf 3.19.1 (BSD-3), zlib 1.3.2, FlatBuffers 25.9.23 (Apache-2.0) and Emscripten, musl and LLVM runtimes. **Also DRAW2's ported pipeline.** | Mixed | **BLOCKER (B1)** until the DRAW2 code is gone; then **OK with notices** (notices §4–6). |
| `options.js`, `sidepanel.js` | 32 KB, 28 KB | Pages: ours, plus Preact | Ours; MIT | **OK with notice.** |
| `ort/ort-wasm-simd-threaded.mjs` | 24 KB | ONNX Runtime's Emscripten loader | MIT | **OK with notice.** |
| `ort/ort-wasm-simd-threaded.wasm` | 14.2 MB | ONNX Runtime 1.30.0 with ONNX 1.22.0, protobuf 33.6, RE2, Abseil, FlatBuffers 23.5.26, Eigen, GSL, nlohmann/json, SafeInt, date, Boost.Mp11, and the Emscripten, musl and LLVM runtimes | MIT, Apache-2.0, BSD-3, MPL-2.0, BSL-1.0 | **OK with notices.** Eigen's MPL-2.0 needs a pointer to its source, which the notices give. |
| `models/dinov2-small-duel.q8.onnx` | 25.7 MB | Our fine-tune of Meta's DINOv2 ViT-S/14, trained on YGOPRODeck images of Konami card art | Apache-2.0 (base © Meta) | **OK with the Apache notice and the change statement** (notices §2.1). The training-data risk is low (§7.5). |
| `data/cards.json` | 8.6 MB | 14,590 cards (YGOPRODeck database 147.20): names, full card text, stats, banlist, ids | Konami's text, compiled by YGOPRODeck | **Accepted risk.** Konami's copyright covers the card text. YGOPRODeck's "download and store locally" rule supports keeping a copy. Ship it with attribution and the disclaimer (§6, §7). |
| `data/index-dinov2-small-duel.bin`, `.meta.json` | 5.6 MB, 0.6 MB | 14,627 int8 vectors: 14,626 computed from artwork crops, plus the card back (from Yugipedia's `Back-EN.png`) | Ours; derived from Konami art | **OK, low risk.** No image is stored, and vectors can't reproduce the artwork. |
| `fonts/*.woff2` (5 files), `fonts/OFL.txt` | 0.4 MB | Archivo, Spectral SC, Source Serif 4 (roman and italic), JetBrains Mono, as Google Fonts' Latin subsets | OFL-1.1 | **OK.** The copyright lines match Google Fonts' `OFL.txt` for each family, and none has a Reserved Font Name. |
| `icons/icon-{16,32,48,128}.png` | < 6 KB | A card outline under a magnifier (the design study's mark) | Ours | **OK.** No Konami marks, no card back, no card frame. |

**Expected in the release but not in this `dist/`:**
- `welcome.html` and `welcome.js`: ours plus Preact, fine.
- `THIRD_PARTY_NOTICES` and `LICENSE`: B3.
- Our card detector's model, once it lands (§5.3).

**Correctly not shipped** (verified in `build.mjs`'s copy filter):
- DRAW2's models (only with `--with-draw2`);
- the benchmark models: DINOv3, under Meta's custom DINOv3 licence, and MobileCLIP, under Apple's research-only licence;
- their indexes;
- `data/`, including the real test frames from Konami's own broadcasts;
- test fixtures.

## 2. Method (so you can trust it, or redo it)

1. **What's bundled where.** I ran esbuild with `metafile: true, write: false` and `build.mjs`'s exact options on all five entry points. That lists every input module per output file, with its bytes. Result:

   | Output | Inputs |
   |---|---|
   | `background.js` | `@anthropic-ai/sdk` (including `internal/qs` and `_vendor/partial-json-parser`), `standardwebhooks`, `@stablelib/base64`, `fast-sha256` |
   | `content.js`, `options.js`, `sidepanel.js` | `preact` |
   | `offscreen.js` | `@techstark/opencv-js`, `onnxruntime-web/dist/ort.wasm.bundle.min.mjs`, and our sources, including `src/offscreen/draw2/*` |

   `json-schema-to-ts` and `@babel/runtime` contribute 0 bytes (types only).
2. **Licences.** Each package's `package.json` and `LICENSE`, checked against `package-lock.json`. Two gaps were resolved upstream:
   - standardwebhooks ships no licence file: its `libraries/LICENSE` on GitHub is MIT, © 2023 Svix. The repository root's `LICENSE` is Apache-2.0, for the spec.
   - partial-json-parser: the npm metadata says ISC, author "gov", with no copyright year.
3. **Native code inside the WebAssembly.**
   - **ONNX Runtime:** the binary's strings name source paths (`_deps/onnx-src`, `_deps/protobuf-src`, `_deps/re2-src`, `_deps/abseil_cpp-src`) and symbols (Eigen, gsl, SafeInt, nlohmann, flatbuffers, date's `year_month_day`). Versions come from ONNX Runtime v1.30.0's `cmake/deps.txt`.
   - **OpenCV.js:** it embeds its own build information: "General configuration for OpenCV 5.0.0", built with Emscripten, "3rdparty dependencies: libprotobuf zlib", "Protobuf: build (3.19.1)", "Flatbuffers: builtin/3rdparty (25.9.23)", "ZLib: build (ver 1.3.2)".
4. **Upstream licence files** were fetched at those exact tags and inserted verbatim into the notices by a script, not retyped.
5. **Data flows** were read from the source for the privacy policy. Its Appendix A cites the code for every statement.
6. **The web** (section 15): YGOPRODeck's API guide and footer, the Chrome Web Store policies, Konami's terms of use and fan-use statement, and Anthropic's retention documentation.

## 3. Licence compatibility and the project's own licence

**What's in the package, by licence family:**

| Licence | Components | What it asks of you |
|---|---|---|
| MIT, BSD-3-Clause, ISC, Zlib, Unlicense, BSL-1.0 | Preact, the Anthropic SDK and its dependencies, ONNX Runtime, GSL, json, SafeInt, date, Emscripten, musl, protobuf, RE2, qs, zlib, Mp11 | Keep their copyright and licence text with the distribution; the notices do this. (Zlib and BSL-1.0 don't even ask for it in compiled code, and the Unlicense asks for nothing.) |
| Apache-2.0 | OpenCV, ONNX, Abseil, FlatBuffers, the DINOv2 base model, our fine-tune | §4(a): include the licence text. §4(b): state changes to modified files (the model). §4(c): keep notices. §4(d): pass on NOTICE files (only ONNX has one; its relevant line is quoted). |
| Apache-2.0 WITH LLVM-exception | LLVM's libc++ and compiler-rt | Nothing for compiled code; listed anyway. |
| MPL-2.0 | Eigen, inside ONNX Runtime's wasm | File-level copyleft. You may ship the binary under any terms if recipients learn where Eigen's source is (MPL 2.0 §3.2). The notices give the exact revision. |
| OFL-1.1 | The fonts | Can be bundled with any software. The fonts stay under the OFL and can't be sold on their own. |

**Nothing left in the package forces a licence on Duel Lens.** DRAW2 (AGPL-3.0) was the only strong copyleft, and it's being removed. Every option below is compatible with everything shipped.

**The model.** The fine-tune is a derivative of Apache-2.0 weights. You may license it under Apache-2.0 or add your own terms, but you must keep Apache §4(a) to (c) either way. Apache-2.0, as `docs/DEVELOPMENT.md` already says, is the simplest.

**Not yours to license.** Card data (`cards.json`), card images and anything derived from Konami's artwork are Konami's content, compiled by YGOPRODeck. Carve them out of whatever licence you pick.

**Recommendation: Apache-2.0 for the code and the model.**
1. It's the licence of the base model, OpenCV, ONNX, Abseil and FlatBuffers. You already have to ship its text, so one licence covers the most ground.
2. It has an explicit patent licence and patent-retaliation clause. That matters more for computer-vision and ML code than for most web code.
3. It's permissive: anyone can fork, contribute or reuse, and every bundled component is compatible with it.
4. Its §6 grants no rights to your name. "Duel Lens" stays yours even when people fork the code.
5. Its NOTICE convention fits the `THIRD_PARTY_NOTICES` file you now have.

**Alternatives:**
- **MIT.** Shorter and just as permissive, but with no patent clause. You'd still ship the Apache text for the dependencies and the model. A fine choice if you value simplicity.
- **GPL-3.0 or AGPL-3.0.** Only if you want every fork to stay open source, or plan to bring AGPL components such as DRAW2 back one day.
- **Closed source.** Allowed by every dependency. But a store package is readable JavaScript anyway, and an extension that screenshots pages earns trust by being inspectable.

**To apply it:**
- add a root `LICENSE` naming the copyright holder (your name or a pseudonym: D4);
- set `"license"` in `package.json` (another workstream's file);
- add a README paragraph listing what the licence doesn't cover. The text is in [`disclaimers.md`](disclaimers.md), §7.

## 4. DRAW2 removal: what must be gone before publishing

The plan (progress ledger, A6) already covers most of this. These are the licence-relevant items:

1. **Bundled today, blocking:**
   - `src/offscreen/draw2/`: `geometry.ts`, whose header reads "Ported from DRAW2's browser pipeline (docs/scripts/pipeline.js)", plus `spec.ts`, `tensors.ts`, `recognizer.ts`, `labels.ts`, `web.ts`, `node.ts`, `make-labels.ts` and their tests.
   - Everything that imports them: `engine.ts`, `load-engine.ts`, `loaders.ts`, `handler.ts`, `web-runtime.ts`, `index.ts` (`loadDraw2`), `art-check.ts`, and `detect-cards.ts`.
2. **Don't move the geometry helpers; rewrite them.** `detect-cards.ts` says: "The geometry helpers imported from draw2/geometry.ts are generic; they move out of draw2/ with it." Those helpers (for example `xywhrToCorners` and `nmsOBB`) are ported from DRAW2. Moving them keeps AGPL-derived code in the bundle under a new path, where the release check's `draw2` path test won't see it. Write fresh implementations from the maths (rotated-box corners, polygon IoU, NMS), without copying the ported code. Neither operation is creative, but a clean rewrite removes the question.
3. **The DRAW2 folder:** `extension/models/draw2/`, with its `LICENSE`, `README.md`, `labels.json` (built from DRAW2's class list) and the `.onnx` files. Also the `--with-draw2` path in `build.mjs`.
4. **Developer tools.** These are not shipped, but they matter if you publish the repository under a non-AGPL licence (D7):
   - `tools/train/prepare.py` has `draw2_warp`, "DRAW2's warpPerspective (docs/scripts/pipeline.js)";
   - `tools/train-detector/draw2-proposals.ts` imports `src/offscreen/draw2/*`;
   - `tools/eval-real.ts`, `tools/calibrate-art-check.ts`, `tools/detect-frame.ts`, `tools/debug-scan.ts` and `tools/realset/*` reference DRAW2 or the gitignored Node port `data/debug/exp-draw2/draw2-lib.mjs`.

   Remove them, or keep them out of the public repository.
5. **Data made with DRAW2 is fine.** 40 of the 57 real-set labels came from DRAW2's classifier, the calibration thresholds were measured on them, and the detector's evaluation labels started from DRAW2's proposals (checked by eye). These are labels and numbers, not DRAW2's code or weights. The output of running a GPL/AGPL program generally isn't covered by its licence. None of it ships, and `data/` is gitignored. Low risk.
6. **Verify after deleting:**
   - `grep -a -c -i draw2 release/build/offscreen.js` should be `0`;
   - `ls release/build/models` should list only our model(s);
   - re-run the metafile check (§14).

   The packaging workstream's `npm run release` already fails on `draw2` paths and strings (`docs/release/packaging.md`).

## 5. Models

### 5.1 The embedder (`dinov2-small-duel`)

**Provenance, verified:**
- `tools/train/model.py`: `BASE = "facebook/dinov2-small"`, loaded with `Dinov2Model.from_pretrained` (Transformers 5.17.0, Apache-2.0).
- `tools/train/README.md` and `phase2-finetune-report.md` agree.
- The file's SHA-256 matches `docs/DEVELOPMENT.md` ("Models").

**Licence:**
- The Hugging Face model card says `license: apache-2.0`.
- The DINOv2 README says "DINOv2 code and model weights are released under the Apache License 2.0" (it was relicensed from CC-BY-NC in 2023).
- DINOv2 has no NOTICE file.

**Obligations:**

| Apache §4 | Status |
|---|---|
| (a) include the licence text | Done: notices §9.1 |
| (b) state your changes | Done: notices §2.1 lists them |
| (c) keep Meta's copyright notice | Done |
| (d) NOTICE file | None exists |

**Belt and braces:** at the next export, write `metadata_props` into the ONNX file, for example `license=Apache-2.0`, `base_model=facebook/dinov2-small (Meta)`, `modified_by=Duel Lens` and the date. `tools/train/export.py` belongs to the model owner (section 12).

**Training data:**
- YGOPRODeck artwork crops and `cards_small` images: Konami's art.
- Procedurally generated sleeves, mats and negatives.
- Real broadcast frames were only looked at, to tune the synthetic generator by eye. Their labels were never used.

§7.5 has the risk analysis.

### 5.2 The artwork index

Vectors (384 int8 values each) computed by our model from artwork crops, plus the card back. They can't be turned back into images. Low risk. The index's `.meta.json` records YGOPRODeck database version 147.20.

### 5.3 Our card detector (pending: `detector-report.md` didn't exist at 01:10)

A pre-audit of `tools/train-detector/`, in progress:
- **Backbone.** Built with `timm` (Apache-2.0, © Ross Wightman) with ImageNet-1k weights: `mobilenetv3_large_100.ra_in1k`, `mobilenetv3_small_100.lamb_in1k`, `mobilenetv4_conv_small.e2400_r224_in1k`, `efficientnet_lite0.ra_in1k`. `model.py` notes "Apache-2.0 ImageNet weights (license checked on the Hugging Face hub)".
  - ImageNet's own terms are research-oriented. Using weights released under Apache-2.0 is standard industry practice, but it is a known grey area. Low risk; mention it in the notices.
- **Training data.** Synthetic frames (`scene.py`) built from YGOPRODeck card images, the card back and procedural mats and overlays. The same Konami-art analysis as the embedder applies (§7.5).
- **DRAW2.** Used only offline, to propose evaluation labels that were checked by eye, "never used for training" (`draw2-proposals.ts`, `label_fullview.py`). Fine; but see §4.4 for the repository.
- **No Ultralytics.** None imported, as required.

**When the detector lands:** confirm the report says the same. Then add a notices entry under §2: the model file, "backbone initialised from timm `<id>` (Apache-2.0)", "trained by the Duel Lens authors on synthetic frames", and the Konami-art note.

## 6. YGOPRODeck: API terms, images and caching

### 6.1 Their published rules

From <https://ygoprodeck.com/api-guide/>, read 2026-09-29. The page's API changelog says "last update 3rd September 2026". The quotes came through a page-to-text fetch, so check the live page before quoting them to anyone.

- **Rate limit:** "The rate limit is 20 requests per 1 second. If you exceed this, you are blocked from accessing the API for 1 hour."
- **Caching:** "Please download and store all data pulled from this API locally to keep the amount of API calls used to a minimum. Failure to do so may result in either your IP address being blacklisted or the API being rolled back."
- **Images:**
  - "NOTE ON IMAGES: Do not continually hotlink images directly from this site. Please download and re-host the images yourself. Failure to do so will result in an IP blacklist."
  - "Images are pulled from our image server `images.ygoprodeck.com`. You must download and store these images yourself!"
  - "Please only pull an image once and then store it locally. If we find you are pulling a very high volume of images per second then your IP will be blacklisted and blocked."
- **Cache and versioning:** the `cardinfo` endpoint is cached for "2 days (172800 seconds)". `checkDBVer.php` changes when "New card is added to the database" or "Card information is updated/modified".
- **Attribution:** the guide asks for none, and I found no terms-of-service page (the footer links are Site Help, Server Status, API Guide and Changelog).
  - The site's privacy policy names no operator company. Its footer credits a developer, Alan O'Connor.
  - The footer disclaimer: "The literal and graphical information presented on this site about Yu-Gi-Oh!, including card images, the attribute, level/rank and type symbols, and card text, is copyright 4K Media Inc, a subsidiary of Konami Digital Entertainment, Inc. This website is not produced by, endorsed by, supported by, or affiliated with 4k Media or Konami Digital Entertainment."
  - 4K Media was renamed Konami Cross Media NY in April 2019, so don't copy that wording.

### 6.2 What Duel Lens does today

| Request | URL | When | Per user | Stored as |
|---|---|---|---|---|
| Database version | `db.ygoprodeck.com/api/v7/checkDBVer.php` | Weekly alarm (`background/index.ts`, `WEEKLY_MINUTES`), and "Check for updates now" | About 1 a week | — |
| Full card list | `db.ygoprodeck.com/api/v7/cardinfo.php?misc=yes` | Only when the version changed (`card-store.ts`, `refreshIfChanged`) | At most weekly, plus manual checks. 24.9 MB of JSON (3.5 MB gzipped, measured on the 2026-09-28 download) | IndexedDB `duel-lens` → `cards` |
| Card image, full size | `images.ygoprodeck.com/images/cards/<id>.jpg` | The first time a card is shown (`image-cache.ts`) | One per new card seen; about 166 KB each (sample of 8) | Cache Storage `card-images-v1`, with **no size cap and no expiry** |
| Card image, small | `images.ygoprodeck.com/images/cards_small/<id>.jpg` | The first time up to 3 alternatives are shown (`content/app.tsx`, `load`), or when the full image fails | About 29 KB each | Same cache |
| Artwork crop | `images.ygoprodeck.com/images/cards_cropped/<id>.jpg` | The self-updating index (`index-update.ts`): after install and on Chrome start (if the last run was over 24 h ago), after a weekly refresh that found new cards, and "Update now" | Every artwork missing from the bundled index, capped at 8 per second, with 3 retries. A 404 or placeholder art waits 7 days | Only the vector (IndexedDB `duel-lens-index`); the image is discarded |

On a fresh install today, only 3 artworks are missing from the bundled index (placeholder art). The number grows with every card released after the build: 538 cards came out between 2026-01-01 and 2026-09-28, about 60 a month.

The API calls themselves are nowhere near the rate limit.

### 6.3 Verdicts

| Behaviour | For one user (today) | As a public extension |
|---|---|---|
| Weekly version check and full download | Complies: downloads once per version and stores locally | **Allowed, but heavy.** Every user pulls the whole database each week it changes. It's within the letter of "download and store", but against the spirit of "keep the amount of API calls used to a minimum". Improve it (R1). |
| Display images from `images.ygoprodeck.com` | Tolerable | **Doesn't comply.** Each install is another IP hotlinking their image server. The guide tells apps to re-host images themselves. Per-user caching ("pull an image once") helps, but it doesn't turn hotlinking into re-hosting. |
| Artwork crops for the index | Tolerable | **Doesn't comply,** for the same reason. It also comes in bursts of 8 images a second whenever new cards appear. |

**If nothing changes:**
- YGOPRODeck could blacklist users' IPs. Depending on how they block, that could cut users off from ygoprodeck.com itself.
- They could block the extension's traffic altogether: they may be able to identify it by its request pattern or `Origin` header. Images, and possibly card-data updates, would then break for every user at once.

### 6.4 Scale, for a feel of it (an illustration, not a forecast)

The assumptions:
- 10,000 weekly users, each seeing 30 new cards a week (about 0.25 MB each with the alternatives);
- a database version that changes every week;
- about 60 new artworks a month.

| Traffic to YGOPRODeck | Volume |
|---|---|
| Images | About 75 GB a week |
| Card data | About 35 GB a week, compressed |
| Artworks | About 20 GB a week |
| **Total** | **About 130 GB a week, to a free community service** |

With your own update feed (R1) and your own images or text-only (R2), this falls to one polite client a week.

### 6.5 Recommendations

**R1. Data and index: your own update feed (recommended; decision D3).**
1. A scheduled job, such as a weekly GitHub Actions workflow or your own machine, does once what every extension does today:
   - check `checkDBVer`;
   - download `cardinfo` (with an identifying User-Agent such as `DuelLens-updater/1.0 (+<repo URL>)`, as `tools/lib/http.ts` already does);
   - trim it;
   - download only the new `cards_cropped` artworks;
   - embed them with the same model (`tools/build-index.ts` logic);
   - publish `cards.json` and a small index-delta file of vectors (about 400 bytes per artwork) to GitHub Releases or Pages.
2. The extension checks your feed weekly instead of YGOPRODeck.
3. The result:
   - YGOPRODeck sees one client, not thousands;
   - users' browsers never download artwork;
   - users' machines skip the embedding work;
   - `host_permissions` shrink from both YGOPRODeck hosts to your own host (or to just `images.ygoprodeck.com` if R2(a) applies), which also means a smaller install warning.

   You'd redistribute only what you already ship (card text) and vectors, not images.
4. **Simpler alternative:** no runtime updates at all. New data and index vectors arrive with extension updates (each goes through store review). New cards appear a few days later.

**R2. Display images (decision D2).** Pick one.
- **(a) Ask YGOPRODeck.** Explain the pattern: each image fetched once per user and cached, with a client identifier, at an expected volume. Ask whether that's acceptable, or whether they'd prefer re-hosting or a paid or Premium arrangement, and how they want to be credited. There's a draft email in Appendix A. **Do this first whatever you choose.**
- **(b) Re-host the images** on your own static host or CDN:
  - `cards_small` for about 14.8k cards is about 0.43 GB;
  - full size is about 2.4 GB.

  This complies with YGOPRODeck's rule. But it makes you a public distributor of about 15,000 Konami images, the same exposure as every fan database, yours instead of theirs (§7.5). There are also bandwidth costs.
- **(c) Text-only,** plus the user's own crop as the picture. This means no third-party image traffic and no image redistribution. The popover and side panel become a little less rich.

**My recommendation:**
1. Send (a) now.
2. Launch with (c) unless you have a written OK.
3. Move to the OK'd pattern, or to (b), afterwards.

(c) is also the fallback build if Konami ever objects to images.

**R3. If any browser-side requests to YGOPRODeck remain** (for example with their OK):
- **Identify the client.** Chrome silently drops a `User-Agent` set on `fetch()`. Either:
  - use `declarativeNetRequest` `modifyHeaders` (needs the `declarativeNetRequestWithHostAccess` permission; it works on requests from extension service workers), or
  - send a custom header such as `X-Client: DuelLens/<version> (+<homepage>)`, after checking with YGOPRODeck that it doesn't break their CDN.
- **Cap the image cache:** keep the most recently used 500 images or 50 MB. Today `card-images-v1` grows forever under `unlimitedStorage`.
- **Drop `misc=yes`** unless you need `konamiId` at runtime. Today it's stored but not used by any UI, and dropping it takes the download from 24.9 MB to 21.3 MB.
- **Be gentler in the background:**
  - honour `Retry-After` in `index-update.ts` (the Node tools already do);
  - slow background artwork runs to about 2 a second;
  - add a random delay to the weekly check so installs don't align.

**R4. Credit YGOPRODeck** wherever their data or images show: welcome, options, side panel footer, store listing and README. The welcome and options pages already do. You could also ask to be listed in their "API Showcase".

**Database rights.** YGOPRODeck's compilation may carry database rights (in the EU, for example). Their "download and store locally" instruction is the basis for bundling a copy. A written OK (a) would cover redistribution in the package too.

## 7. Konami: trademarks and copyright

### 7.1 Who owns what

**Trademarks:**
- Konami's terms of use say its trademarks include "KONAMI" and "YU-GI-OH!" and the associated logos. The terms also forbid using its marks "in connection with any product or service that is not ours, or in any manner that is likely to cause confusion".
- In the United States, the "YU-GI-OH!" registrations are held by Shueisha, for example reg. no. 2995656.

**Copyright:**
- The rights line Konami uses on its own product page is "©2020 Studio Dice / SHUEISHA, TV TOKYO, KONAMI". Fan and third-party usage drops the year: "© Studio Dice/SHUEISHA, TV TOKYO, KONAMI".
- 4K Media Inc. is now Konami Cross Media NY (since April 2019).

### 7.2 What Duel Lens uses

- **The name "Yu-Gi-Oh!",** in text only: the manifest description and the pages.
- **Card names and full card text,** bundled in `cards.json`.
- **Card images,** downloaded at runtime and not bundled.
- **A model and an index** derived from the artwork.

**What it doesn't use:**
- No logos.
- No card frames, and no attribute, level or type symbols. The card view uses text and Unicode glyphs (`content/card-view.tsx`), and the icon is original (`content/icons.tsx`, `extension/icons`).
- No official fonts.

### 7.3 Fan-tool norms and enforcement history

**Konami's stated position.** Konami Digital Entertainment B.V.'s support page on copyrights (EU) says Konami "generally does not object to fans using copyrighted materials for non-commercial purposes". "Non-commercial" there means you don't use the material to promote a product you sell or profit from, "nor can you use it to monetise a website or a media channel". Konami keeps the right to have material taken down at any time. (Quoted from search excerpts: the page returned HTTP 403 to my fetcher.)

**Established fan tools** run openly, with disclaimers:
- YGOPRODeck, with the footer disclaimer quoted in §6.1;
- App Store apps: "This app is not affiliated with, sponsored, endorsed, or approved by Studio Dice, Shueisha, TV Tokyo, or Konami" (Yugipedia Deck Builder), and "Yugidex is not endorsed by, nor affiliated with Konami or the Yu-Gi-Oh Trading Card Game".

**Enforcement** has targeted unofficial duel *simulators*. In 2016 Dueling Network received a cease-and-desist from Nihon Ad Systems, which manages Yu-Gi-Oh! rights for Konami, and shut down. I found no action against reference or lookup tools.

**Official overlap.** Konami's own **Yu-Gi-Oh! NEURON** app recognises cards with a phone camera (up to 20 at a time), and since 1 April 2026 it's required for store tournament registration.
- Duel Lens is a different product (videos and streams on a computer).
- Don't position it as an alternative to NEURON, and don't use "NEURON", "Master Duel" or "Duel Links" anywhere.

### 7.4 Chrome Web Store policy

"Impersonation & Intellectual Property" (last updated 2022-11-01):
- "Don't pretend to be someone else, and don't represent that your product is authorized by, endorsed by, or produced by another company or organization, if that is not the case."
- "Don't infringe on the intellectual property rights of others, including patent, trademark, trade secret, copyright, and other proprietary rights."

Google acts on DMCA and trademark complaints. The usual result is that the listing comes down, and repeated violations can affect the developer account.

### 7.5 Copyright, component by component

My risk estimate for each piece (not legal advice):

- **Card text in `cards.json`: low to medium.**
  - Each text is short and largely functional (game rules), so it has thin protection. But about 14,600 verbatim texts is a substantial copy of Konami's expression.
  - US fair-use factors:
    - for: a non-commercial reference use; functional material; no market Konami licenses for this (it gives the same text away through its official database and NEURON);
    - against: the texts are copied whole.
  - In practice, fan databases have carried the full text for years without action.
  - The consequence, if it ever came, would be a takedown request.
- **Card images (runtime): low as they are, higher if you re-host.**
  - Displaying images the user's browser fetches from YGOPRODeck makes YGOPRODeck the distributor.
  - Re-hosting (R2 b) makes you one.
  - Text-only (R2 c) removes the question.
- **The model and index: low.**
  - The vectors and weights don't store the artwork and can't reproduce it. The use is non-generative retrieval, like a search index.
  - **UK:** *Getty Images v Stability AI* [2025] EWHC 2863 (Ch), 4 November 2025, held that the model's weights "are not themselves an infringing copy, nor do they store or reproduce an infringing copy" of the training images.
  - **Japan (Konami's home jurisdiction):** Copyright Act Article 30-4 permits exploiting a work for information analysis, including machine-learning training, when the purpose isn't to enjoy the work's expression, unless that would unreasonably prejudice the rights holder.
  - **US:** AI training is still being litigated, but a retrieval index sits closer to search-engine precedents than generative models do.
- **Listing screenshots and promo images: medium, and avoidable.** See §7.7.

### 7.6 Naming and icon

- **Keep "Duel Lens."**
  - A web search (2026-09-29) found no product or trademark called "Duel Lens". This wasn't a clearance search; see D12.
  - "Duel" is generic. Konami's marks are "Duel Monsters", "Duel Links", "Master Duel" and "Duelist", and "Duel Lens" copies none of them.
  - Don't compare it with Google Lens in the listing.
- **Keep Yu-Gi-Oh! out of the name, the store title, the icon, the promo tile's headline and the developer name.** In the description, use it only to say what the tool works with, in plain text. For example: "for Yu-Gi-Oh! cards", or "for the Yu-Gi-Oh! TRADING CARD GAME", which matches Konami's own styling and is still descriptive. Pair it with the "Unofficial fan tool" line.
- **The icon is fine as it is.** Avoid the card back's oval swirl, Millennium items, the Yu-Gi-Oh! logo lettering, the Konami logo, or anything that looks like a card frame.

### 7.7 Store listing assets

- **Don't use frames from Konami's broadcasts** (YCS Paris 2026, World Championship 2026, WCQ Stuttgart 2026: the real test set). Those frames are Konami's video, with Konami and event branding and real, identifiable players and commentators.
  - The store kit plans "1280×800 screenshots from E2E on real frames". Please use other footage.
- **Use your own recording** of your own cards on a mat, or the E2E fixture board. Show only as much card art as you need to demonstrate the tool, and no event logos or people.
- **Promo tile (440×280):** the icon, the name and a line of text. No card art needed.

### 7.8 Monetisation and conduct

- **Stay non-commercial:** no ads, no paid tier, no in-extension donation links at launch (D6). This is the condition in Konami's stated fan policy.
- **Keep a working contact address** in the listing (D4).
- **If Konami or its agent asks for a change, act quickly.** Text-only (R2 c) or withdrawing is a matter of hours.

## 8. Anthropic API (the optional AI check)

**Model: bring your own key.**
- The user pastes their own key.
- The service worker calls `api.anthropic.com` directly through the official SDK with `dangerouslyAllowBrowser: true` (`background/ai.ts`, `buildAnthropicClient`).
- You never see the key, the images or the answers.
- The user is Anthropic's customer: their usage falls under their agreement with Anthropic and its usage policy, and they pay for it.

**What is sent, and only when** (the code is cited in the privacy policy's Appendix A):
- **When:** only when the check is on and a key is set (`identifyWithAi` returns early otherwise), and the user presses **Ask AI** (`content/popover.tsx`, `aiControls`).
- **The request contains:**
  - the crop (the box plus a margin) as a base64 PNG or JPEG;
  - the names of up to 5 candidate cards (`router.ts`, `ask-ai`);
  - a fixed prompt;
  - the chosen model;
  - the key.
- **The SDK also sends** `X-Stainless-*` headers: the SDK version, and the browser's name and version.
- **"Test"** sends the word "ping".

**Anthropic's retention**, as published: "we automatically delete inputs and outputs on our backend within 30 days of receipt or generation" (Privacy Center, updated 2026-07-01). Flagged content is kept up to 2 years, and trust-and-safety scores up to 7. "Retained data is never used for model training without your express permission" (platform docs).
- The privacy policy links to Anthropic's policies instead of restating them, because they change.

**Issues to fix** (from the final review, item 11; the files belong to other workstreams):
- **Being fixed.** As of about 01:15, `router.ts` refuses `ask-ai` and `test-ai` without the `api.anthropic.com` permission (`permissions.hasAnthropic`, `NO_AI_PERMISSION`). Before this, a revoked permission didn't stop calls, because Anthropic allows CORS.
- **Still open:**
  - Turning the check off keeps the key and the host permission.
  - Add a **"Remove key"** button.
  - On disable, clear the key (or ask) and call `permissions.remove`.

**Key storage.**
- The key is stored unencrypted in `chrome.storage.local`, restricted to the extension's own pages and worker (`setAccessLevel('TRUSTED_CONTEXTS')`, `background/index.ts`). That's the usual design for bring-your-own-key tools.
- The UI should say so, and suggest a dedicated key with a spending limit. The text is in [`disclaimers.md`](disclaimers.md), §5.

**Branding.**
- "Claude" and "Anthropic" in plain text only, no logos, and nothing that suggests a partnership.
- The options page's cost estimate ("about 1–2 US cents per check…") should stay approximate and link to Anthropic's prices, as it does, because prices change.

## 9. Chrome Web Store requirements

| Requirement | Source | Status |
|---|---|---|
| **A privacy policy at a public URL.** Required even for local-only data. FAQ: "Does an extension need to disclose user data handling if the data is only processed or stored locally on a user's device?" "Yes." And: "This policy requires all Products that handle user information to post a privacy policy." | User Data FAQ | Draft ready (`privacy-policy.md`). You host it (D5). |
| **Prominent disclosure and consent before collecting.**<br>- Policy: "Prominently disclose what user data will be collected and how it will be used" and "obtain the user's affirmative and informed consent".<br>- FAQ, question 10: "The prominent disclosure and consent must occur within the Product's user interface. Disclosures in the Chrome Web Store description or inline installation page do not satisfy this requirement." And: "the Product must ask the user to agree to the prominent disclosure in a manner that requires them to take a specific action clearly agreeing to the disclosure before collecting or handling user data."<br>- The 2026-07-01 update (enforced from 2026-08-01) requires "all data collection be prominently disclosed to the user—regardless of whether the data is closely related", and that developers "proactively disclose to users if their data handling practices change". | Disclosure Requirements; User Data FAQ; the 2026-07-01 policy update | **Not met yet (B4).**<br>- The welcome page discloses, but it has no agree step, and scans work without one.<br>- The AI check is fine: the disclosure sits above an opt-in toggle, and Chrome shows a permission prompt.<br>- Add a first-run consent step covering the screenshot processing, the history (page addresses) and the YGOPRODeck requests, and don't scan or record history until it's accepted (§12; text in `disclaimers.md` §4a). |
| **Limited Use: "strictly necessary".** Since the 2026-07-01 update, "user data collected by an extension must now be strictly necessary to the extension's disclosed single purpose". | 2026-07-01 policy update | Most of it is plainly necessary: the screenshot, the crop, and the key for the AI check. **The page address and title in the history are the weakest case.** They serve "open at this moment" and let you find a card again. Keep them, but disclose them and let the user switch them off, or store less: for example, only the video id and time for YouTube. (§11, D13.) |
| **AI guardrails.** The 2026-07-01 update also disallows "extensions designed to circumvent safety guardrails, usage restrictions, or other protective measures implemented by AI-powered services". | 2026-07-01 policy update | **OK.** Duel Lens makes ordinary API calls with the user's key. The refusal `fallbacks` it requests is Anthropic's own server-side feature, not a way around it. |
| **Limited Use statement on your website.** "An affirmative statement that your use of the data complies with the Limited Use restrictions must be disclosed on a website belonging to your extension." | Limited Use | Included in the privacy policy. |
| **Privacy practices form:** single purpose, permission justifications, remote code, data types and certifications | Dashboard | Suggested answers in the privacy policy's Appendix B. Keep them consistent with the store kit (`store/`). |
| **No remote code.** "The full functionality of an extension must be easily discernible from its submitted code." | MV3 requirements | **OK.** The ORT `.mjs`/`.wasm`, OpenCV.js, the model and the index are all packaged (`web-runtime.ts` sets `wasmPaths = getURL('ort/')`). |
| **Keyword spam.** "Unnatural repetition of the same keyword more than 5 times". | Program policies | Don't list card names in the description. Use "Yu-Gi-Oh!" a few times at most. |
| **Impersonation and IP** | §7.4 | Covered by §7.6 to 7.8 and the disclaimers. |

## 10. Privacy and data protection

**What the developer holds:** nothing. There is no server, no account, no analytics, no crash reporting, and no remote configuration.
- I verified this: there are no fetch calls to any other host, and the bundles contain no analytics SDKs.
- The only hosts contacted are the two YGOPRODeck hosts and, optionally, `api.anthropic.com`.

**What stays on the device:**
- the history, with page addresses and titles;
- settings and the key;
- the card database, the image cache and the index delta;
- optional debug crops.

The table is in the privacy policy.

**Third parties that see the user's IP address:**
- **YGOPRODeck:** always. It also learns which card images are requested, and so which cards the user looked at. The current welcome text says "None of this sends anything from your screen", which is literally true but incomplete. The replacement wording is in [`disclaimers.md`](disclaimers.md) §4, and §12 asks the welcome page's owner to use it.
- **Anthropic:** only with the AI check on.

**EU users.** EU courts have held that websites which make visitors' browsers contact a third party's server hand that party the visitor's IP address. See, for example, LG München I, 20 January 2022, 3 O 17493/20 (Google Fonts). The same logic could apply to the extension's YGOPRODeck requests. Disclose them (done), and prefer your own feed or self-hosting (R1, R2).

**Children.** The extension isn't directed at children, and collects nothing. The policy says so.

**Defence in depth,** from final-review item 10: check message senders in the router and the offscreen handler. It isn't a disclosure issue, but it protects the key and the data.

## 11. Actions: decisions only you can make

**Numbering.** The release checklist (`docs/release/RELEASE-CHECKLIST.md`) numbers some of these differently:

| This audit | Checklist |
|---|---|
| D1 (licence) | D1 |
| D2 (images) | D5 |
| D5 (policy hosting) | D7 |
| D7 (publish the source) | D6 |
| D8 (debug crops) | D12 |

**The checklist's own legal items:**
- **Its D11 (EU "trader" status):** non-trader fits a free hobby project with no monetisation, which is consistent with D6 here.
- **Its D2 (store title):** "Duel Lens – Card Reader for Duel Videos" is fine by §7.6. It keeps Yu-Gi-Oh! out of the title.

| # | Decision | Options | My recommendation | What depends on it |
|---|---|---|---|---|
| **D1** | The project's licence | Apache-2.0 / MIT / GPL-3.0 / closed | **Apache-2.0** for the code and the model, with the Konami and YGOPRODeck content carved out (§3) | A `LICENSE` file, the `package.json` `license` field, the README "Legal" section, the copyright holder's name |
| **D2** | Card images once public | (a) ask YGOPRODeck and keep fetching only with a written OK; (b) re-host; (c) text-only plus the user's crop | **(a) now, launch with (c) unless (a) comes back yes,** then (a) or (b) | `image-cache.ts`, the popover and side panel, host permissions, privacy policy §3 |
| **D3** | Card data and index updates | Your own feed / extension updates only / keep calling YGOPRODeck | **Your own feed** (R1). "Extension updates only" is the simplest acceptable fallback. | `card-store.ts`, `index-update.ts`, the manifest's host permissions, the privacy policy |
| **D4** | Publisher identity and contact | Your name or a pseudonym; an email address | **A dedicated address** (not a personal one) for the listing, the policy, and takedown or abuse notices | The privacy policy, the listing, `LICENSE` |
| **D5** | Where the privacy policy lives | GitHub Pages / a gist / your own site | **GitHub Pages** of the public repository, beside the notices | `PRIVACY_POLICY_URL` and `LICENCES_URL` in `src/welcome/links.tsx`, and the store form |
| **D6** | Monetisation | None / donations / paid | **None at launch** (Konami's fan-use condition) | The listing and README |
| **D7** | Publish the source | Yes, after clean-up / no | **Yes.** First remove the DRAW2-derived tools (§4.4), keep `data/` and the test fixtures out (already gitignored), and don't commit the DINOv3 and MobileCLIP benchmark indexes (`extension/data/index-dinov3-*`, `index-mobileclip-s0*`: vectors from models under restrictive licences, not needed) | `.gitignore`, the commit plan |
| **D8** | Debug "Save crops" in the store build | Keep / hide behind a dev flag / remove | **Hide or remove.** If you keep it, add "Delete saved crops" (there's no way to delete them today short of uninstalling). | The privacy policy's storage table |
| **D9** | Listing screenshots | Your own footage / fixtures / Konami broadcast frames | **Your own footage**, never Konami's broadcasts | The store kit |
| **D10** | Model licence and metadata | Apache-2.0 / other | **Apache-2.0** (as `docs/DEVELOPMENT.md` says). Add ONNX metadata at the next export. | Notices §2.1, `tools/train/export.py` |
| **D11** | Contact YGOPRODeck | Send the Appendix A email / don't | **Send it** (it costs nothing, and their answer settles D2) | D2 |
| **D12** | Trademark clearance for "Duel Lens" | A USPTO or EUIPO class 9 search / skip | **Optional, low priority** | Renaming later is cheap before launch and expensive after |
| **D13** | Page addresses in the history (the store's "strictly necessary" test) | Keep the address and title / keep only a YouTube video id and time / keep none | **Keep them**, disclosed in the consent step, with a "Remember the page for each scan" switch in Options (on by default) | The consent text (`disclaimers.md` §4a), `router.ts`, the side panel's "open at" link, the privacy policy §1 and §2 |

## 12. Changes for other workstreams

I haven't edited any of these files. Each owner should apply these changes.

**Lead / A6: `src/offscreen/**`, `build.mjs`**
- Delete DRAW2 (§4). Rewrite the geometry helpers rather than moving them.
- Verify with the bundle checks.

**Packaging (P): `build.mjs`, `tools/release.mjs`, `docs/release/packaging.md`**
- Copy `THIRD_PARTY_NOTICES.md` and your `LICENSE` into the build: for example as `THIRD_PARTY_NOTICES.txt` and `LICENSE.txt`, or rendered to a `licenses.html` page. The `<!-- … -->` maintainer comments can be left out of the shipped copy.
- Make the release check fail if they're missing.
- Keep `fonts/OFL.txt`.
- Keep `models/draw2` excluded always.

**Onboarding (O): `src/welcome/links.tsx`, `src/welcome/app.tsx`, `src/options/app.tsx`**
- **Add a consent step (B4).** On the welcome page (opened at install), show the disclosure from `disclaimers.md` §4a with an **Agree and start** button, and store the time of agreement (for example `consentedAt` in `chrome.storage.local`). If the user scans before agreeing, show the same disclosure in the page overlay with the same button, and don't take the screenshot or record history until they agree. When a later version handles data in a new way, ask again (the 2026 update requires proactive disclosure).
- Set `DISCLAIMER` to the short text in [`disclaimers.md`](disclaimers.md) §1. It still matches the test's `/not affiliated with or endorsed by Konami/`.
- Point `LICENCES_URL` at the packaged notices (for example `chrome.runtime.getURL('THIRD_PARTY_NOTICES.txt')`) and `PRIVACY_POLICY_URL` at the hosted policy.
- Replace "None of this sends anything from your screen" with the wording in `disclaimers.md` §4. YGOPRODeck can see which card images are requested.
- In Options:
  - add the key-storage note (`disclaimers.md` §5);
  - add a "Remove key" button;
  - if D8 keeps the debug option, add "Delete saved crops";
  - consider a "Delete all Duel Lens data" button.

**Background: `src/background/*`**
- **Consent gate (B4).** In `startScan`, if `consentedAt` isn't set, open the welcome page (or tell the content script to show the consent overlay) instead of calling `captureVisibleTab`. Record history entries only after consent. Per D13, respect the "Remember the page for each scan" switch when building the `entry`.
- Per D2/D3: your own feed; the image-cache cap; `Retry-After`; no `misc=yes`; client identification if calls remain (R3).
- Keep the new `permissions.hasAnthropic` gate on `ask-ai` and `test-ai`, and clear the key on disable (§8).
- Add sender checks (final review, item 10).

**README**
- Replace "Everything runs on your computer" (line 3) with "Recognition runs on your computer", because card data and images come from YGOPRODeck. The final review (item 12) found the same.
- Replace the "Before publishing" DRAW2 lines.
- Add the "Legal" section from `disclaimers.md` §7.

**Store kit (S): `store/`**
- Add the listing disclaimer paragraph (`disclaimers.md` §3).
- **Screenshots per D9.** The checklist's S3 plans screenshots "from real frames with the E2E harness". The real frames are Konami's YCS, WCS and WCQ broadcasts. L5's hygiene (no logos, no faces) doesn't fix that: the frames themselves are Konami's video (§7.7). Use your own footage.
- In `store/privacy-practices.md` §5, "YGOPRODeck receives no user data" is too absolute. Say it receives only standard request information (the IP address and the file requested, which reveals which card pictures are viewed), and nothing from the screen or the history.
- Privacy-practices answers must match the privacy policy's Appendix B.
- Permission justifications: the packaging doc's table and Appendix B agree.

**Model owner: `tools/train/export.py`**
- Add ONNX `metadata_props` (licence, base model, changes) at the next export.

**Manifest (P)**
- Once D2/D3 are settled, update `host_permissions`.
- Optionally add `homepage_url` (the repository or the policy page).

## 13. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | AGPL code ships (DRAW2's port, or helpers moved out of it) | High if not removed | High: licence violation; forced to AGPL or to withdraw | §4 deletion and rewrite; the release check; the §14 metafile check |
| 2 | YGOPRODeck blacklists users' IPs or blocks the extension | Medium at scale | Medium to high: images and data break, and users may lose access to ygoprodeck.com | R1, R2; ask first (Appendix A) |
| 3 | Konami (or its agent) files a takedown with Google | Low to medium | High: the listing comes down | Non-commercial; disclaimers; no logos, no broadcast frames, no "official"; fast response; a text-only fallback build |
| 4 | Store rejection over a privacy or disclosure mismatch | Medium on first submission | Low to medium: a delay | Policy, form and listing say the same thing (Appendix B); precise permission justifications |
| 4b | Store rejection or later enforcement for having no in-product consent (FAQ question 10; 2026-07-01 update) | High if shipped without the consent step | Medium: rejection, or removal after August 2026 enforcement | The consent step before the first scan (B4, §12) |
| 5 | Missing or inaccurate third-party notices | High now (B3) | Medium: licence non-compliance | Ship `THIRD_PARTY_NOTICES`; re-check per release (§14) |
| 6 | The API key leaks from the user's profile, or the user is surprised by the bill | Low | Medium, for the user | A dedicated key with a limit; "Remove key"; clear cost wording |
| 7 | Users unaware that crops go to Anthropic | Low | Low to medium | Opt-in, a permission prompt, an explicit Ask AI press, and the consent text (disclaimers §5) |
| 8 | A training-data claim against the model or index | Low | Medium: retrain or withdraw | Retrieval only, non-reproducing; Art. 30-4, Getty v Stability; keep the provenance documented |
| 9 | A trademark conflict over "Duel Lens" | Low | Medium: a rename | Optional clearance (D12) |
| 10 | Surprises in the detector's licence | Low | Medium | Pre-audit (§5.3); check the report when it lands |
| 11 | Users trust wrong or outdated card data (banlist, errata) | Medium | Low | The accuracy disclaimer (disclaimers §6); weekly updates |
| 12 | An EU complaint about third-party requests (IP addresses) | Low | Low | Disclosure; R1 and R2 reduce it |

## 14. Keeping `THIRD_PARTY_NOTICES.md` current

Re-run these checks before each release, and whenever `package-lock.json`, the model, the fonts or the card data change.

**1. What each bundle contains.** Save this as a temporary `.mjs` file in the repository root, so that `esbuild` resolves from `node_modules`. Run it with `node`, then delete it. It writes nothing. Tested 2026-09-29: it lists the Anthropic SDK and its three dependencies for `background`, OpenCV.js and ONNX Runtime Web for `offscreen`, and Preact for the pages.

```js
import * as esbuild from 'esbuild';
const entries = { background: 'src/background/index.ts', content: 'src/content/index.ts', offscreen: 'src/offscreen/index.ts',
  sidepanel: 'src/sidepanel/index.tsx', options: 'src/options/index.tsx', welcome: 'src/welcome/index.tsx' };
for (const [out, entry] of Object.entries(entries)) {
  const r = await esbuild.build({ bundle: true, write: false, metafile: true, outdir: 'x', format: 'esm', target: 'chrome124',
    jsx: 'automatic', jsxImportSource: 'preact', external: ['fs', 'path', 'crypto'], logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"', __DUEL_LENS_E2E__: 'false' }, entryPoints: { [out]: entry } }).catch(() => null);
  if (!r) continue;
  const pkgs = {};
  for (const [inp, i] of Object.entries(Object.values(r.metafile.outputs)[0].inputs)) {
    const m = inp.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/); if (m && i.bytesInOutput) pkgs[m[1]] = (pkgs[m[1]] ?? 0) + i.bytesInOutput;
  }
  console.log(out, pkgs);
}
```

**2. A new dependency, or a changed version.** Add or update its row in §1 of the notices, and its licence text.

**3. After an `onnxruntime-web` upgrade:**
- read `cmake/deps.txt` at the new tag;
- run `strings -n 6 node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm | grep -o -E "_deps/[a-z0-9_]+-src" | sort -u`;
- update notices §4.

**4. After an OpenCV.js upgrade:** print its embedded "General configuration for OpenCV" block (search `opencv.js` for that string) and update notices §5.

**5. DRAW2 must stay gone:** `grep -a -c -i draw2` on the built `offscreen.js` should print `0`.

## 15. Sources (all read 2026-09-29)

**YGOPRODeck**
- API guide: <https://ygoprodeck.com/api-guide/>
- Home page footer: <https://ygoprodeck.com/>
- Privacy policy: <https://ygoprodeck.com/privacy-policy/>

**Chrome Web Store policies**
- Program policies (last updated 2025-05-22): <https://developer.chrome.com/docs/webstore/program-policies/policies>
- Policy update, 2026-07-01 (enforced from 2026-08-01): <https://developer.chrome.com/blog/cws-policy-updates-2026>
- Impersonation & Intellectual Property: <https://developer.chrome.com/docs/webstore/program-policies/impersonation-and-intellectual-property>
- User Data FAQ: <https://developer.chrome.com/docs/webstore/program-policies/user-data-faq>
- Disclosure Requirements: <https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements>
- Limited Use: <https://developer.chrome.com/docs/webstore/program-policies/limited-use>
- MV3 requirements: <https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements>
- Privacy fields: <https://developer.chrome.com/docs/webstore/cws-dashboard-privacy>
- Package size (2 GB): <https://developer.chrome.com/docs/webstore/publish>
- `declarativeNetRequest`: <https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest>
- Forbidden header names (User-Agent is no longer forbidden in the spec, but Chrome drops it from `fetch`): <https://developer.mozilla.org/en-US/docs/Glossary/forbidden_header_name>

**Konami**
- Terms of use (KDE US, updated 2024-06-01): <https://legal.konami.com/kdeus/btob/terms/tou/en/>
- Yu-Gi-Oh! card store terms: <https://legal.konami.com/kdeus/yugioh/terms/tou/en/>
- Product page with the rights line: <https://www.konami.com/games/us/en/products/yugioh_tcg/>
- Copyright lines: <https://www.konami.com/siteinfo/en/license.html>
- EU support, fan use (via search excerpts; HTTP 403 to my fetcher): <https://eu-support.konami.com/hc/en-gb/articles/9648771731479-Copyrights-Career-Opportunities-Goodies>
- 4K Media renamed Konami Cross Media NY: <https://licensinginternational.org/news/4k-media-renamed-konami-cross-media-ny/>
- YU-GI-OH! trademark (Shueisha): <https://www.trademarkia.com/yu-gi-oh-76977468>
- Dueling Network shutdown: <https://www.vice.com/en/article/yu-gi-oh-online/>
- Yu-Gi-Oh! NEURON: <https://play.google.com/store/apps/details?id=jp.konami.YugiohOcgSupports&hl=en_US>
- Third-party app disclaimers:
  - <https://apps.apple.com/mx/app/yugipedia-deck-builder/id1026470546>
  - <https://apps.apple.com/us/app/-/id1512626489>

**Anthropic**
- Commercial retention: <https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data>
- API and data retention: <https://platform.claude.com/docs/en/manage-claude/api-and-data-retention>

**Models**
- DINOv2 model card: <https://huggingface.co/facebook/dinov2-small>
- DINOv2 code and licence: <https://github.com/facebookresearch/dinov2>

**Case law and statute**
- Getty v Stability: <https://www.mayerbrown.com/en/insights/publications/2025/11/getty-images-v-stability-ai-what-the-high-courts-decision-means-for-rights-holders-and-ai-developers>
- Japan, Article 30-4 (Agency for Cultural Affairs overview): <https://www.bunka.go.jp/english/policy/copyright/pdf/94055801_01.pdf>

**Licence files** (at the pinned tags)
- ONNX Runtime: <https://github.com/microsoft/onnxruntime/tree/v1.30.0> (`LICENSE`, `ThirdPartyNotices.txt`, `cmake/deps.txt`)
- OpenCV: <https://github.com/opencv/opencv/tree/5.0.0> (`COPYRIGHT`, `3rdparty/{protobuf,zlib,flatbuffers}`)
- Emscripten: <https://github.com/emscripten-core/emscripten> (`LICENSE`, `system/lib/libc/musl/COPYRIGHT`)
- Components:
  - protobuf v33.6
  - RE2 2024-07-02
  - Abseil 20250814.0
  - FlatBuffers v23.5.26
  - ONNX v1.22.0 (`LICENSE`, `NOTICE`)
  - Eigen `1d8b82b0`
  - GSL v4.2.1
  - nlohmann/json v3.11.3
  - SafeInt 3.0.28
  - date v3.0.1
  - Boost `LICENSE_1_0.txt`
  - LLVM `libcxx/LICENSE.TXT`
  - standardwebhooks `libraries/LICENSE`
  - Google Fonts `ofl/{archivo,spectralsc,sourceserif4,jetbrainsmono}/OFL.txt`

## Appendix A: draft email to YGOPRODeck (decision D11; don't send without reading it)

> **Subject:** Permission question: free Chrome extension using the YGOPRODeck API
>
> Hi,
>
> I'm building Duel Lens, a free, non-commercial Chrome extension. It lets you select a Yu-Gi-Oh! card in a video or stream and shows its name and text. Recognition runs on the user's computer. Card data comes from your API, and I'd like to do this properly before publishing it on the Chrome Web Store.
>
> What it does today:
>
> - It bundles a trimmed copy of `cardinfo.php` and checks `checkDBVer.php` once a week.
> - It shows the card's image, fetched once per user from `images.ygoprodeck.com` and then cached in the browser.
>
> I've read your API guide, and I know you ask people to re-host images rather than hotlink them. So, two questions:
>
> 1. Is it acceptable for each user's browser to fetch each card image once and cache it? I would send an identifying header, for example `DuelLens/<version>`. Or would you rather I re-host the images myself, or use a different arrangement (Premium, a partner key…)?
> 2. I plan to serve card-data updates from my own server, updated weekly with one request to your API, so users won't call your API at all. Is redistributing that trimmed data OK with you?
>
> I credit YGOPRODeck on the extension's pages and in the store listing. If you'd like a specific wording or link, just tell me.
>
> Thanks for the API. It's a great resource.
>
> [Your name] · [contact email] · [link to the project]

### Status update, 2026-09-29 (afternoon): D1 decided

- **D1 is DONE:** the user chose **Apache-2.0**. `LICENSE` (the official text from apache.org) is at the repository root, `package.json` says `"license": "Apache-2.0"`, and README.md's License section reads "Copyright 2026 the Duel Lens authors".
- `build.mjs` ships `LICENSE` in every build, and `licenses.html` shows it first. `npm run release` now **refuses** a build without it (it was a warning while D1 was open; `tools/release.test.ts`).
- Still open for the user: D4 (the publisher's name and contact in the privacy policy), D5 (hosting the privacy policy), the courtesy email to YGOPRODeck, and the store submission.
