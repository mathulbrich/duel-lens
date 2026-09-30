# Duel Lens: release checklist (Chrome Web Store)

Everything needed before and at submission of the first public version (0.9.0). The lead (Claude)
keeps this file current; each row says who does it.

- **Owner:** **Lead** = Claude, working in this repo. **User** = the project owner. Nothing that
  spends money, creates an account, commits, pushes, publishes or submits is done by the lead.
- **Status:** `TODO`, `DOING`, `DONE`, `BLOCKED`, `N/A`. Change a status only with a pointer to the
  evidence (a file, a command's output, a ledger entry).
- Started 2026-09-29 by the store-kit workstream; **statuses re-checked against the code on 2026-09-29
  around 09:00** (the final overnight sync), after A4 (our own card detector; OpenCV removed) landed and
  A6 phase 1 (the extension no longer imports DRAW2) reported done. **A6 phase 2 (deleting DRAW2 from the
  repository) has since reported done too** (`a6-phase2-report.md`); see the Verification snapshot below
  and item C1.
  - Store texts: `store/`. Packaging: `docs/release/packaging.md`.
  - Legal: `docs/release/legal-audit.md` (start with its "Status update"), `privacy-policy.md`, `disclaimers.md`.
  - Evidence folder: `.superpowers/sdd/2026-09-28-duel-lens-v1/` (gitignored; "the SDD folder" below),
    with `compliance-report.md`, `compliance-evidence/` and `progress.md` (the ledger).
- **Decision numbers are the legal audit's** (D1 to D13, `legal-audit.md` §11), and the store-only
  decisions continue as D14 to D20. Before 06:00 this file numbered them differently. The old numbers
  map as D2→D14, D3→D15, D4→D16, D5→D2, D6→D7, D7→D5, D8→D17, D9→D18, D10→D19, D11→D20, D12→D8.

---

## USER MUST DO

The lead can't do these. In order:

1. ~~**D1, the project's licence.**~~ **DONE 2026-09-29:** the user chose **Apache-2.0**; `LICENSE` is at the repository root, and `npm run release` now refuses a build without it. (Was: **D1, the project's licence.** Recommended: Apache-2.0 for the code and the model (`legal-audit.md` §3).)
   - Tell the lead your choice. The lead writes `LICENSE`, and `build.mjs` then copies it into every build.
   - **The release waits for it:** the bundled notices point to that file.
2. **D2, card images: DONE.** You chose official images from YGOPRODeck on 2026-09-29: every build,
   including the store build, shows them by default and caches each one on the user's computer
   (`fix-f2-report.md`). The crop build (`--no-remote-images`) stays available as a one-flag rollback.
   - **Courtesy email to YGOPRODeck: SENT by the user on 2026-09-29** (to admin@ygoprodeck.com, the address on
     ygoprodeck.com/help; rewritten from `legal-audit.md` Appendix A for what ships: cached official images,
     the weekly card-data check, new cards' artwork, and the YGOPRODeck link on every card). Any answer they
     send may change the image setup (the crop build is a one-flag rollback). (Was: **Before submitting, send YGOPRODeck the courtesy email in `legal-audit.md` Appendix A.**) It's a
     courtesy and one of B2's risk mitigations, not a precondition: the release doesn't wait on an
     answer. It stays a draft until you send it yourself — the lead sends no email.
   - If they ever object, or you want to stop asking for the host permission, release with
     `--no-remote-images` (`packaging.md`, "Cut a release") and switch the listing, the privacy answers
     and the policy to match.
3. **D4: DONE 2026-09-29.** Publisher "Duel Lens" (the policy says "the Duel Lens project"), contact mathulbrich@gmail.com, effective date 29 September 2026, filled in everywhere below. (Was: **D4, the publisher name and a contact email.** Use a dedicated address. The lead then fills it in:)
   - the privacy policy's `[DEVELOPER NAME]`, `[CONTACT EMAIL]` and `[EFFECTIVE DATE]`, in
     `docs/release/privacy-policy.md` and `src/legal/policy.ts` together (a test compares the two);
   - the listing's `{{CONTACT_EMAIL}}`;
   - optionally, README.md's copyright line ("Copyright 2026 the Duel Lens authors"); the Apache-2.0 `LICENSE` text itself has none.

   You enter it in the dashboard yourself.
4. **D5: DONE 2026-09-29.** The policy is hosted as a public gist, https://gist.github.com/mathulbrich/a72fdebc8363a86bd16679ba1cbbea4e, printed from `src/legal/policy.ts` (equal to the bundled `privacy.html`); the URL is in `store/listing.md`, `store/faq.md` and `store/privacy-practices.md`. (Was: **D5, host the privacy policy and send the lead its URL.**)
   - Host `docs/release/privacy-policy.md` **Appendix D**, after D4, at a public HTTPS page with no login
     and no redirect (recommended: GitHub Pages). **Host the current Appendix D:** it was reprinted on
     2026-09-29 for D2's official-images default and for the Genesys-points bullet, so an older saved
     copy is stale.
   - Appendix D is exactly what the extension's own `privacy.html` shows.
   - The lead then fills `{{PRIVACY_POLICY_URL}}` in `store/listing.md` and `store/faq.md`. The URL also
     goes in the dashboard's Privacy practices tab.
5. **The developer account: CREATED by the user on 2026-09-29 (fee paid).** Still to do in its settings: the publisher name, the contact email's verification and the trader declaration (below).
   - A Google account with 2-Step Verification.
   - Register at <https://chrome.google.com/webstore/devconsole> and pay the one-time US$5 fee.
   - Verify the contact email, and set the publisher name.
   - Declare trader or non-trader (D20).

   Details: section 5.
6. **Submission.** The reviewed zip is `release/duel-lens-0.9.0.zip` from the lead's final run on
   2026-09-29 (with E2E, no warnings): 39.6 MB, SHA-256
   `1e8b95e33ebd8e347ed230431cdaef9fc3be49cd2efd794eeeb9db0e6570eea2` (row B2). **After D4 fills in the
   publisher details, re-run `npm run release`** (the privacy page inside the extension changes) and take
   the SHA from that run. Section 8, steps U1 to U7:
   - upload the zip;
   - fill the listing (`store/listing.md`) and the Privacy practices tab (`store/privacy-practices.md`);
   - set distribution, and untick automatic publishing if you want to publish by hand;
   - submit.
7. **Commit and push: DONE by the lead on 2026-09-29, at the user's request.** The first commit went to
   `main` in the repository `github.com/mathulbrich/duel-lens`, after a scan for secrets and personal data.
   **Public since 2026-09-29** (the user's choice, D7; the full history was scanned again first: no secrets or
   local paths, and the only email is the chosen contact). The listing's homepage URL is the repository, and
   its support URL is the repository's Issues page.

Also yours, but quick: the store title (D14), summary (D15), category (D16), support channel (D17) and
visibility (D18), in section 1. Optional: your own footage for the screenshots (D9), a promo video
(D19), a trademark search (D12).

### Courtesy email to YGOPRODeck (D2 is decided; this is no longer a precondition)

D2 is decided: Duel Lens ships YGOPRODeck's official images by default (2026-09-29), accepting B2's risk
(`legal-audit.md`'s dated status entry). Sending an email is now a courtesy and one of the risk's
mitigations, not a gate — the release doesn't wait on an answer, and nothing changes if YGOPRODeck says
no or doesn't reply: `--no-remote-images` is the one-flag rollback if they ever object.

**Send the draft in `legal-audit.md` Appendix A**, from the D4 address, before submitting to the store.
Read it first — it predates this build (for example, the Genesys-points request to `db.ygoprodeck.com`)
— and update anything that's since changed. It stays a draft until you send it yourself; the lead sends
no email.

---

Store facts this list relies on (checked 2026-09-29):
- One-time US$5 developer registration; the publishing Google account needs 2-Step Verification
  (https://developer.chrome.com/docs/webstore/register and third-party guides, see `store/listing.md`).
- Required for submission: description, category, language, 128×128 store icon, at least one 1280×800
  (or 640×400) screenshot, a 440×280 small promo tile, the Privacy practices tab, and a privacy policy
  URL, since Duel Lens handles user data (https://developer.chrome.com/docs/webstore/cws-dashboard-listing,
  https://developer.chrome.com/docs/webstore/program-policies/user-data-faq).
- Review usually takes a few days and can take weeks. New developers, new items and more code get closer
  review. In April 2026 Google warned of a backlog; resubmitting while pending resets your place in the
  queue (https://developer.chrome.com/docs/webstore/review-process,
  https://groups.google.com/a/chromium.org/g/chromium-extensions/c/VJ6DcpEn51Y/m/yuxvHWdwCAAJ).
- The store build asks for the host permission `https://images.ygoprodeck.com/*` (official card images,
  decision D2) plus the optional `api.anthropic.com`. Neither is broad host access, so it shouldn't
  trigger the "in-depth review" warning that `<all_urls>`-style permissions get. The zip is about 39.6 MB
  (with the card detector) against a 2 GB limit.
- Since 2026-08-01: "all data collection" must be prominently disclosed in the product, and data must be
  "strictly necessary" to the single purpose (https://developer.chrome.com/blog/cws-policy-updates-2026).

---

## Verification snapshot (2026-09-29, updated after fix wave F2 and the Genesys-points addition, ~10:30)

What shipped, checked against the code and against fresh builds (`fix-f2-report.md`, `genesys-report.md`):

- **D2 decided: official card images by default.** `build.mjs`'s default (so `npm run release`'s, too)
  now shows YGOPRODeck's official card images and downloads new cards' artwork; the crop build
  (`--no-remote-images`) is the old behaviour, kept for a one-flag rollback. The manifest's
  `host_permissions` is `https://images.ygoprodeck.com/*` by default, and empty in the crop build
  (`fix-f2-report.md`, "D2 (lead)").
- **Genesys points.** A card-database refresh now also fetches
  `db.ygoprodeck.com/api/v7/cardinfo.php?format=genesys&misc=yes` (a third request, after
  `checkDBVer.php` and `cardinfo.php?misc=yes`) and merges each card's Genesys points; the popover shows
  a "Genesys N pts" chip. `extension/data/cards.json` was regenerated with the merge: 761 of 14,590
  cards got points, and the file is otherwise byte-identical (`genesys-report.md`).
- **Our own card detector ships:** `extension/models/detector/card-detector.onnx` (6,184,172 B), a
  MobileNetV3-Large backbone (Apache-2.0), trained only on synthetic frames. Click to scan is real:
  face-up cards are outlined on the frozen frame; click one to scan; drag still works.
- **OpenCV.js is removed and DRAW2 is deleted from the repository too:** unchanged from the previous
  sync (A4; A6 phases 1 and 2); see the Decisions and Code-and-build tables below.
- **Checks (`fix-f2-report.md`):** `npx tsc --noEmit` 0 errors; `npx vitest run` 70 files, 1004 passed, 8
  skipped, 0 failed; `npx tsx test/e2e/run.ts` 8/8 (run twice, before and after D2); `--click` 8/8;
  `--store-images` (the crop build) 8/8, 0 requests to `images.ygoprodeck.com`.
- **Checks after the Genesys addition (`genesys-report.md`, on top of F2):** `npx tsc --noEmit` 0 errors
  outside `tools/live-check/` and `tools/partial/` (other agents' in-progress folders, not this work);
  `npx vitest run` 70 files, 1022 passed, 8 skipped, 0 failed (F2's 1004 plus Genesys's 18 new
  tests); `npx tsx test/e2e/run.ts` 8/8, the popover showing the Genesys chip where a card has one
  (`pog-small.png`: "Genesys 30 pts"; `ash-upside.png`: "Genesys 20 pts"; `dm.png`: no chip, 0 points).
- **Checks on the reviewed tree (`final-review.md`, 2026-09-29 11:00–11:40, current):** `npx tsc --noEmit`
  0 errors; `npx vitest run` **71 files, 1126 passed**, 8 skipped, 0 failed; `npx tsx test/e2e/run.ts`
  (drag) 8/8, all confident; `--click` 8/8, 8 outlines on each shot.
- **Since then, two more rounds landed** (`final-fixes-x-report.md`, the post-click fixes M1–M12; and
  `partial-report.md`, the edge-cut rescue). **The lead's full run on the final tree** (2026-09-29, 12:35,
  the tree built into `dist/`): `npx vitest run` 73 files, **1167 passed**, 8 skipped, 0 failed; E2E drag
  **8/8** and `--click` **8/8** (outlines median 214 ms, popover 248 ms). Both E2E runs passed the hostile-page
  probe (0 of 9 shadow roots reached), the focus checks and the two-click check. `npm run release` with E2E
  still has to be re-run for the final zip (B2). **Engine:** the rescue path is in. When a card runs off the edge of
  the picture and the normal reading matches nothing, Duel Lens now reads it once more as a whole card;
  at best it answers "Not sure", never confident. A card that's merely covered (not at the picture's edge)
  isn't helped. `tools/eval-real.ts` (120 cards, 70 negatives) is unchanged: 116/120 right, 115 confident,
  0 confidently wrong, negatives 0/70 confident; 0 new answers turned up on the 1,545 non-card scans
  checked (cut, covered, real and the foil frames) (`partial-report.md`).
- **Release zip: not a reviewed build as of this pass — don't cite a SHA-256 here.** The zip on disk
  predates the Genesys-points merge, and a later rebuild mixed in another workstream's in-progress
  engine code (`final-review.md` I5). **Re-run `npm run release` before submitting**, once all in-flight
  work has landed and passed review, and record that run's own SHA-256 (from its printed summary) here.
- **Release command:** `npm run release` (add `-- --skip-e2e` to skip the E2E step; add `-- --sourcemap`
  for linked source maps). It now defaults to YGOPRODeck's official images (decision D2); add
  `-- --no-remote-images` for the crop build instead.

---

## 1. Decisions

| # | Decision | Owner | Status | Recommendation, inputs and evidence |
|---|---|---|---|---|
| D1 | The project's own licence | User | **DONE 2026-09-29: Apache-2.0** (LICENSE at the root; the release refuses a build without it) | **Apache-2.0** (`legal-audit.md` §3). Compatible with everything shipped: DINOv2-derived weights Apache-2.0, the card detector (MobileNetV3-Large backbone) Apache-2.0, ONNX Runtime MIT, Preact MIT, the Anthropic SDK MIT, fonts OFL. OpenCV is no longer shipped (A4). The release waits for it (L4). |
| D2 | Card images at public scale | User | **DONE.** Official images chosen 2026-09-29. | The store build ships YGOPRODeck's official card images by default, each downloaded once per user and cached (C16). YGOPRODeck's API guide: "Do not continually hotlink images directly from this site. Please download and re-host the images yourself", with IP blacklisting as the penalty (https://ygoprodeck.com/api-guide/). Mitigations: per-user caching (above), a courtesy email to YGOPRODeck before submission (`legal-audit.md` Appendix A, USER MUST DO), and a one-flag rollback (`--no-remote-images`) if they ever object. |
| D3 | Card data and index updates | User | TODO | Today every build checks `db.ygoprodeck.com` weekly: plain GETs whose URLs name no card, and the full card list and its Genesys points (two lists, `cardinfo.php?misc=yes` and `cardinfo.php?format=genesys&misc=yes`) only when the version changed. New cards' artwork reaches the index automatically in builds with remote images (decision D2), or only with extension updates in the crop build, which is the audit's "extension updates only" fallback. Your own feed (R1) would make YGOPRODeck see one client. |
| D4 | Publisher name and contact email | User | TODO | A dedicated address (USER MUST DO 3). |
| D5 | Where the privacy policy is hosted | User | TODO | GitHub Pages of the public repo (USER MUST DO 4). The extension needs no URL: it links to its bundled `privacy.html` (`src/welcome/links.tsx:24`). |
| D6 | Monetisation | User | TODO | **None at launch**: Konami's fan-use tolerance is for non-commercial use (`legal-audit.md` §7.3). |
| D7 | Publish the source (public GitHub repo) | User | TODO | **Yes, after a clean-up** (`legal-audit.md` §11). It gives a free home for the privacy policy (D5), the FAQ and a support URL (D17). Before: remove the DRAW2-derived tools (§4.4), keep `data/` out (already ignored), don't commit the DINOv3 and MobileCLIP benchmark indexes. |
| D8 | The debug "Save crops" option in the store build | Lead | DONE | Compiled only into `--dev` and `--e2e` builds (`src/options/app.tsx:408`; `build.mjs:55`). The store privacy texts have no "Saved crops" row. |
| D9 | Footage for the screenshots | User (optional) | Plan ready | Synthetic scenes now (the E2E board: `store/screenshots-plan.md` §3.2); your own footage of your own cards is better if you record some. Never Konami's broadcasts. |
| D10 | The model's licence and metadata | User | TODO | Apache-2.0, as the notices already state (§2.1). ONNX `metadata_props` at the next export (`tools/train/export.py`). |
| D11 | Contact YGOPRODeck | User | TODO | The same email as D2. |
| D12 | Trademark search for "Duel Lens" | User | Optional | Low priority (`legal-audit.md` §7.6). |
| D13 | Page addresses in the history | User | Default in place | Kept, and disclosed in the consent step ("with the address and title of each page"). The optional "Remember the page for each scan" switch isn't built. |
| D14 | Store title | User | **DONE 2026-09-29: "Duel Lens – Card Reader for Duel Videos"** (the manifest `name`; `short_name` "Duel Lens") | Keep the name **Duel Lens**. Recommended title: "Duel Lens – Card Reader for Duel Videos" (`store/listing.md` §2). Never "Yu-Gi-Oh!" in the title. It is the manifest `name`, so pick it before the first upload. |
| D15 | Summary (manifest `description`) | User | TODO | The manifest's 132-character text is fine (`disclaimers.md` §3.1); `store/listing.md` §3 has options. |
| D16 | Category | User | TODO | Entertainment (alternative: Games). |
| D17 | Support channel | User | **DONE 2026-09-29: GitHub Issues (https://github.com/mathulbrich/duel-lens/issues) and mathulbrich@gmail.com** | GitHub Issues (if D7), or the D4 address. Fills `{{SUPPORT_URL}}` in `store/faq.md`. |
| D18 | Visibility and timing | User | TODO | Public, with "publish automatically after review" unticked, then publish by hand within 30 days of approval. Unlisted is the quiet alternative. |
| D19 | Promo video | User | Optional | `store/screenshots-plan.md` §8; your own YouTube account; never Konami footage. |
| D20 | Trader or non-trader (EU Digital Services Act) | User | TODO | Declared in the developer account. A free hobby project with no monetisation is normally "non-trader"; a trader's contact details are shown publicly. |
| D21 | Ship the model trained on real card crops (`dinov2-small-duel-v3b`, the local default since 2026-09-30) | User | **DONE 2026-09-30: ship it** (the user released 0.9.1 with v3b) | Better on real footage, but its crops were read from YouTube videos by a headless browser, which YouTube's Terms don't allow (`legal-audit.md`, status update 2026-09-30). Ship it (the notices already state its training data), or keep shipping `dinov2-small-duel`: revert the 2026-09-30 switch (`src/shared/models.ts`, `tools/release.mjs` and its test, `.gitignore`, `THIRD_PARTY_NOTICES.md`, `docs/DEVELOPMENT.md`). |

---

## 2. Code and build (the lead)

Line numbers as of around 06:05, and may have moved since A6 finished moving code in `src/offscreen/`,
`src/content/popover.tsx`, `src/background/router.ts` and `build.mjs` (both phases now reported done; see
C1). The "05:30" and "06:00" builds are store builds the docs sync made with `node build.mjs --out` into a
scratch folder and checked with `verifyBuild` from `tools/release.mjs`.

| # | Item | Owner | Status | Evidence, or done when |
|---|---|---|---|---|
| C1 | Delete DRAW2 (AGPL-3.0): `src/offscreen/draw2/**`, everything that imports it, the art check's DRAW2 path, `--with-draw2`, the docs | Lead (A6) | **DONE (A6 phase 1 and phase 2).** Repository hygiene done. | `a6-phase1-report.md` (extension): no extension entry point imports `src/offscreen/draw2/`, directly or indirectly (proven per entry with esbuild metafiles), and the bundles carry none of DRAW2's modules or identifiers. `a6-phase2-report.md` (repository): `src/offscreen/draw2/` and its tests, the art check, and the DRAW2-only tools (`tools/train-detector/draw2-proposals.ts` etc.) are deleted; `extension/models/draw2/` (`detector.onnx`, `classifier.onnx`, `labels.json`, `LICENSE`, `README.md`) is moved, not deleted, into the gitignored `data/draw2-archive/models/`. `grep -rni draw2 src tools test build.mjs package.json README.md` gives 25 lines in 6 files, none in `src/`, `test/`, `build.mjs`, `package.json` or `README.md` — only data provenance and the release guard remain. `npm run release` still refuses any bundle with DRAW2 code or the `models/draw2` string. |
| C2 | Keep the E2E hook `duelLensDebug` out of the release bundle | Lead | DONE | `src/background/index.ts:141` installs it only `if (__DUEL_LENS_E2E__)`. The 05:30 and 06:00 store builds have 0 hits; see also `compliance-evidence/release-verify-manual.txt`. |
| C3 | Keep the `data-duel-lens-*` state mirror out of the release bundle | Lead | DONE | `src/content/index.ts:255`. 0 hits and 0 warnings in the 05:30 and 06:00 store builds. |
| C4 | Prominent disclosure for the AI check in Options, above the toggle | Lead | DONE | `src/options/app.tsx:48-51`, rendered at `:276`. `src/options/app.test.tsx:425-428` fails if it drifts from `store/privacy-practices.md` §7. |
| C5 | Enforce the optional `api.anthropic.com` permission | Lead | **DONE.** | Ask AI and Test refuse without it (`src/background/router.ts:318`, `:365`, cases `ask-ai` and `test-ai`). The popover now offers "Ask AI" only with the permission too: `aiEnabled` checks the setting, the key **and** the permission (`router.ts:223-225`). Turning the check off in Options removes the permission (`chrome.permissions.remove`, `src/options/app.tsx:154-173`); the key stays, since clearing its field is the key's own removal control, as `disclaimers.md` §5 already says — turning the check on again asks only for the permission. (`final-fixes-x-report.md`, M12.) |
| C6 | The Debug section (D8) | Lead | DONE | See D8. |
| C7 | OpenCV's WebAssembly is inlined in `offscreen.js` as one string, which looks like the "Red Titanium" (obfuscation) pattern | Lead | **DONE (A4).** | Resolved by removal, not by separating the file: OpenCV.js is gone entirely (our own card detector replaced it), and `@techstark/opencv-js` is gone from `package.json`. `offscreen.js` is now 188,327 B (longest line 1,063 characters), not one multi-MB string. `npm run release` refuses any bundle that contains OpenCV.js. Verified independently in this sync's own scratch build: 0 "opencv" hits in any bundle. |
| C8 | The welcome page says what the history holds | Lead | DONE | The consent step's History point (default build: "with the address and title of each page"; the crop build's variant adds "and a small picture of what you selected") and "Your history and settings…" (`src/welcome/copy.ts:66-99`, `:102-117`). Word for word from `disclaimers.md` §4a and §4 (`src/welcome/copy.test.ts`). |
| C9 | Privacy policy and licences links inside the extension | Lead | DONE | They point to the bundled `privacy.html` and `licenses.html` (`src/welcome/links.tsx:24-25`), from the welcome page, Options → About and the consent step. No hosted URL is needed in the code. The listing still needs one (D5). |
| C10 | Drop the `db.ygoprodeck.com` host permission | Lead | DONE | The store build needs no host permission for `db.ygoprodeck.com` (`extension/manifest.json`; `build.mjs`). The weekly refresh works without one (CORS `*`: curl, a real build with no host permissions in Chrome for Testing, and `src/background/card-store.test.ts:202-215`). It does ask for `https://images.ygoprodeck.com/*`, a separate host, for the official card images (decision D2; C16). Evidence: `compliance-report.md`, "Decisions I took", 1. |
| C11 | Third-party notices inside the package | Lead | DONE | `build.mjs:146-150` copies `THIRD_PARTY_NOTICES.md` without its maintainer comments, and `LICENSE` once it exists. `licenses.html` shows them. The notices were re-checked against the 05:30 and 06:00 store builds, and `legal.js` was added to Preact's files. `LICENSE`: L4. |
| C12 | Open the welcome page once on install | Lead | DONE | `src/background/index.ts:28-32` (reason `install` only). Every E2E run checks it ("install: opened welcome.html", `compliance-evidence/e2e-store-3.txt`). |
| C13 | Final-review minors (error-copy breadth, "AI check failed" for an unknown answer, the side panel's "This session" heading and unsure marking) | Lead | TODO | Triaged for "the post-click fix round" (ledger, final-review rulings); not verified in this sync. "This session" is still the side panel's heading (`src/sidepanel/app.tsx:178`). See the SDD folder's `final-review-2.md`. |
| C14 | Click to scan: ship in 0.9.0 or leave out | Lead | **DONE (A4).** Ships. | Our own card detector (`extension/models/detector/card-detector.onnx`, MobileNetV3-Large backbone, Apache-2.0, trained only on synthetic frames) is registered in every build but `--no-detector` (`src/offscreen/index.ts`), and `npm run release` refuses a build without it. Face-up cards are outlined on the frozen frame; click one to scan; drag still works too. Real-footage: click-to-scan E2E 115/120, 0 wrong (`a4-report.md` §2.3). Listing, FAQ and screenshot text now describe it (S1, S6, S3). |
| C15 | First-run consent before the first scan (legal audit B4) | Lead | DONE | No capture, message or script before consent (`src/background/scan.ts:131-134`). `src/background/consent.ts` stores the date. The consent step is `src/welcome/consent.tsx`, in `disclaimers.md` §4a words. Options → About shows the date. Every E2E run checks the gate (`compliance-evidence/e2e-board-2.txt`, `e2e-store-3.txt`). |
| C16 | Store mode: official card images by default (legal audit B2; decision D2, decided 2026-09-29) | Lead | **DONE.** | `build.mjs`'s header comment and `remoteImages = !cli.flags.has('--no-remote-images')`. The popover and side panel show the matched card's official picture, downloaded once per card and cached (`src/content/app.tsx:176-191`, `:315`; `src/sidepanel/app.tsx:164`); the self-updating artwork index runs too (`src/background/index.ts:47`, `:67`, `:85`). The manifest asks for host access to `https://images.ygoprodeck.com/*`. The crop build (`--no-remote-images`) is the old behaviour, kept for a one-flag rollback: the popover and side panel show the user's own crop, a 160 px picture per scan is kept (`src/background/thumbnail.ts:7-8`, `src/background/history.ts`), no artwork runs, and no host permission is asked. Evidence: `fix-f2-report.md` (`tools/release.mjs`'s host checks; a default real build with the images host and 0 `verifyBuild` errors, and a `--no-remote-images` real build with 0 hosts). |
| C17 | Bundled `privacy.html` and `licenses.html` | Lead | DONE | `src/legal/` and `extension/{privacy,licenses}.html`. `privacy.html` renders `src/legal/policy.ts`, whose text `src/legal/policy.test.ts` keeps in step with `docs/release/privacy-policy.md` (6/6 at 05:41). |
| C18 | Fill in the policy's placeholders (`[DEVELOPER NAME]`, `[CONTACT EMAIL]`, `[EFFECTIVE DATE]`) | Lead, after D4 | BLOCKED on D4 | In `src/legal/policy.ts` and `docs/release/privacy-policy.md` together (the drift test), then reprint Appendix D (its command). |
| C19 | Release checks that don't exist yet: fail when `THIRD_PARTY_NOTICES.md`, `privacy.html`, `licenses.html` or (after D1) `LICENSE` is missing, or when a store build names `images.ygoprodeck.com` or asks for host permissions | Lead | **DONE**, apart from the LICENSE warning, which becomes an error once D1 is chosen | `tools/release.mjs`'s `verifyBuild` now errors when `THIRD_PARTY_NOTICES.md`, `privacy.html` or `licenses.html` is missing, and warns (not yet an error, pending D1) when `LICENSE` is missing. The host-permission checks (the official-images build needs `images.ygoprodeck.com`; the crop build must ask for no host permission; no unexpected host) already existed before this item. (`final-fixes-x-report.md`, M10.) |
| C20 | Sender checks in the router and the offscreen handler (final review, item 10) | Lead | TODO | Defence in depth, not a disclosure issue (`legal-audit.md` §10). |
| C21 | Legal review of the store-mode wording | User or legal owner | TODO | The compliance round's open point 2: `src/welcome/copy.ts` and `src/legal/policy.ts`. One nit is listed in `legal-audit.md`'s Status update ("the artwork index on your computer" in the store policy's permission row). |

---

## 3. Store texts and images

| # | Item | Owner | Status | Where, and evidence |
|---|---|---|---|---|
| S1 | Listing texts: title, summary, description, category, language, Test instructions | Lead | DONE (draft) | `store/listing.md`, updated 2026-09-29 for the store build: official card images (decision D2) in PRIVACY, PERMISSIONS and the Test instructions, the host permission for `images.ygoprodeck.com`, Genesys points in FEATURES, the consent step in HOW IT WORKS, no DRAW2-only message. Final after D14 to D16, D4 and D5. |
| S2 | Privacy practices answers | Lead | DONE (draft) | `store/privacy-practices.md`, updated for the store build: the host permission for `images.ygoprodeck.com` (decision D2) with a truthful purpose; the official card image and the artwork index as website content and local storage; YGOPRODeck's metadata (the IP address, which of three card-data files, and which card pictures, no card names sent). Re-check on the final zip (B6). |
| S3 | Five screenshots, 1280×800, with the E2E harness, **not from Konami's broadcast frames** | Lead | TODO | `store/screenshots-plan.md`, rewritten for the store UI (the crop, not an official image) and synthetic scenes (the E2E board) or the user's own footage (D9) → `store/screenshots/`. |
| S4 | Small promo tile, 440×280 | Lead | TODO | `store/screenshots-plan.md` §5 → `store/promo/` |
| S5 | Store icon, 128×128 with 16 px transparent padding | Lead | DONE | `store/assets/icon-128-store.png`, 128×128, byte for byte the manifest's `extension/icons/icon-128.png`. Full-bleed original: `store/assets/icon-128-fullbleed.png`. |
| S6 | FAQ and troubleshooting | Lead writes, User hosts | DONE (draft) | `store/faq.md`, updated for the store build: consent, the crop, no image downloads, no DRAW2-only message, the current Options labels. `{{SUPPORT_URL}}` and `{{PRIVACY_POLICY_URL}}` after D17 and D5. |
| S7 | One disclaimer wording everywhere | Lead | **DONE 2026-09-29, README included** (the short disclaimer and the full legal notice are word for word from `disclaimers.md` §1–2, checked) | The extension's pages use `src/welcome/copy.ts`, word for word from `disclaimers.md` (tested). The listing's last paragraph is `disclaimers.md` §3.2, and the FAQ's Konami answer is §2, both in their text-only form. The README belongs to another agent; not checked here. |
| S8 | A checked test video link for the Test instructions | Lead | TODO | `store/listing.md` §7 (`{{TEST_VIDEO_URL}}`) |
| S9 | The listing's claims re-checked on the final build | Lead | DOING | The checkboxes under the description in `store/listing.md` §4: 4 ticked, 6 open. |

---

## 4. Legal

| # | Item | Owner | Status | Where, and evidence |
|---|---|---|---|---|
| L1 | Licence audit of every shipped file | Lead (legal workstream) | DONE, with a status update | `docs/release/legal-audit.md`: the original analysis, plus "Status update, 2026-09-29 around 06:00" (B1 in progress, B2 addressed by store mode pending D2, B3 notices bundled with `LICENSE` pending D1, B4 done). |
| L2 | Privacy policy text, matching `store/privacy-practices.md`, with the Limited Use statement | Lead | DOING | `docs/release/privacy-policy.md`. It is in step with the bundled `privacy.html` (`src/legal/policy.test.ts`, 6/6), and **Appendix D is the text to host**. It waits for D4 (C18) and D5 (hosting). |
| L3 | Disclaimers | Lead (legal workstream) | DONE | `docs/release/disclaimers.md`; in the product word for word (`src/welcome/copy.test.ts`). |
| L4 | `LICENSE` file for the project | Lead writes after D1 | **DONE 2026-09-29** (the official Apache-2.0 text from apache.org; "Copyright 2026 the Duel Lens authors" in README) | The repo root. `build.mjs:150` copies it into the build, and `licenses.html` shows it first. |
| L5 | Konami trademark hygiene in all store images: no logos, no event branding, no player names or faces, no broadcast frames | Lead | TODO (with S3) | `store/screenshots-plan.md` §2 |

---

## 5. Accounts, money and hosting

| # | Item | Owner | Status | Notes |
|---|---|---|---|---|
| A1 | Pick the Google account that will own the item; turn on 2-Step Verification | User | TODO | The account's email can't be changed later |
| A2 | Register as a Chrome Web Store developer and pay the one-time US$5 fee | User | TODO | https://chrome.google.com/webstore/devconsole |
| A3 | Verify the contact email; set the publisher display name (D4) | User | TODO | |
| A4 | Trader or non-trader declaration (D20) | User | TODO | |
| A5 | Optional: verified publisher ("Official URL") via Google Search Console | User | N/A for v1 | Needs a domain |
| H1 | Host the privacy policy (D5): `docs/release/privacy-policy.md` Appendix D, after D4. Give the lead the URL. | User | TODO | Then the lead fills `{{PRIVACY_POLICY_URL}}` in `store/`. No code change: the extension carries its own copy. |
| H2 | Host the FAQ or support page (D17) and give the lead the URL | User | TODO | Then the lead fills `{{SUPPORT_URL}}` |

---

## 6. Repository

| # | Item | Owner | Status | Notes |
|---|---|---|---|---|
| G1 | Commit plan: file groups, messages, `.gitignore` additions | Lead prepares | TODO | Already ignored: `release/`, `dist/`, `dist-e2e/`, `/data/`, `.superpowers/`, `extension/models/**/*.onnx`. At commit time (ledger, final-review rulings): `__pycache__/`, `*.part`, the four benchmark indexes (`extension/data/index-dinov2-small*`, `index-dinov3-*`, `index-mobileclip-s0*`), and re-including the default model `dinov2-small-duel.q8.onnx` (final review I3; the user decides). |
| G2 | Make the commits | User (or the lead, once the user says so) | TODO | The repository has no commits yet, only a staged baseline (`git status`). |
| G3 | Create the public repo and push (if D7) | User | TODO | Check first that no private data is tracked: `data/` (real frames, test sets) stays ignored |

---

## 7. Build and verify (the lead, on the exact zip)

| # | Item | Owner | Status | Done when, and evidence |
|---|---|---|---|---|
| B1 | `version` 0.9.0 in `extension/manifest.json` | Lead | DONE | |
| B2 | `npm run release`: tsc, vitest, the E2E fixture test, build, verification, zip and SHA-256 | Lead | **DONE (2026-09-29, afternoon, final tree)** | `npm run release` (with E2E) exit 0, **no warnings**: tsc ok; vitest 74 files, **1209 passed**, 8 skipped; E2E **8/8**; 33 files (LICENSE included); manifest name "Duel Lens – Card Reader for Duel Videos" (D14), publisher details filled in (D4), and the "Low match" label for weak box-only guesses; hosts `https://images.ygoprodeck.com/*` (D2), optional `https://api.anthropic.com/*`. **Zip:** `release/duel-lens-0.9.0.zip`, 39.6 MB, passes `unzip -t`, SHA-256 `1e8b95e33ebd8e347ed230431cdaef9fc3be49cd2efd794eeeb9db0e6570eea2`. Engine at this point: eval-real 117/120, 115 confident, 0 wrong, 0/70; `--real --click` 117/120, 112 confident, 0 wrong (click-regression-report.md). This build also has the YGOPRODeck link and the highlighted banlist and Genesys chips. Re-run it after any change (e.g. the D4 publisher details), and take the SHA from that run. |
| B3 | Real-footage E2E on the same sources: `npx tsx test/e2e/run.ts --real` | Lead | **DONE (A4), on the full 120 + 70 real set** | `a4-report.md` §2.2–2.3, `tools/eval-real.ts` on `data/realset` (120 cards, 70 non-card boxes, 9 productions): **eval-real 116/120 right, 115 confident, 0 confident wrong; negatives 0/70 confident.** `--real` (drag) E2E: same 116/120, 115 confident, 0 wrong, 70/70 negatives, 0/190 answers differ from eval-real. `--real --click` (click-to-scan) E2E: **115/120, 0 wrong**, 1 outline miss, 70/70 negatives. Median timings: shortcut → outlines ≈230 ms, click → popover ≈0.5 s (524 ms). This supersedes the pre-A4/pre-detector numbers (94/94 and 111/108 top-1/confident) quoted here before. These numbers are for the development docs only: the store copy stays modest. |
| B4 | Load `release/build/` unpacked in a fresh profile, and walk through `packaging.md` step 5: the welcome page and consent; a scan on a real YouTube stream with the crop in the popover; the side panel's picture; Options → About | Lead (and the User, if they want a hands-on check) | TODO | Notes in the ledger |
| B5 | The zip's manifest has no `<all_urls>`, no "E2E", no `key`, and no `update_url` | Lead | DONE on the F2 build; re-check the zip | The F2 store build's permissions are activeTab, scripting, offscreen, storage, unlimitedStorage, sidePanel and alarms; `host_permissions` is `https://images.ygoprodeck.com/*` (decision D2); optional `https://api.anthropic.com/*` (`fix-f2-report.md`). |
| B6 | Every privacy answer still true for this zip (`store/privacy-practices.md` §0 to §5) | Lead | TODO (after C1) | Signed off in the ledger |
| B7 | Crop-build E2E: `npx tsx test/e2e/run.ts --store-images` (the flag name predates D2; it now builds the crop build, `--no-remote-images`) | Lead | **DONE.** | 8/8, 0 requests to `images.ygoprodeck.com`, all 8 history entries keep a picture, and the side panel shows it (`fix-f2-report.md`). The store build's own default-mode E2E (official images) is the plain `npx tsx test/e2e/run.ts`, also 8/8, run again after the Genesys addition (`fix-f2-report.md`; `genesys-report.md`). |

---

## 8. Submission (user, in the Developer Dashboard)

| # | Step | Owner | Status | Source file |
|---|---|---|---|---|
| U1 | Add new item → upload `release/duel-lens-0.9.0.zip` (check its SHA-256 first) | User | TODO | `docs/release/packaging.md` |
| U2 | Store listing tab: description, category, language, store icon, screenshots, small promo tile, homepage and support URLs, mature content "No" | User | TODO | `store/listing.md`, `store/` images |
| U3 | Privacy practices tab: single purpose, one justification per permission, host permissions (`images.ygoprodeck.com` in the store build, decision D2; the optional api.anthropic.com if asked), remote code "No", data usage (three boxes ticked), the three certifications, privacy policy URL | User | TODO | `store/privacy-practices.md` |
| U4 | Distribution: free, all regions, visibility (D18) | User | TODO | `store/listing.md` §8 |
| U5 | Test instructions (optional; they mention the consent step) | User | TODO | `store/listing.md` §7 |
| U6 | Untick automatic publishing, if chosen (D18) | User | TODO | |
| U7 | Submit for review | User | TODO | |

---

## 9. After submission

| # | Item | Owner | Status |
|---|---|---|---|
| P1 | Don't resubmit or edit while the review is pending (it restarts the queue); contact developer support after 3 weeks | User | TODO |
| P2 | On a rejection: forward the email; the lead maps the violation ID to a fix (section 10) and prepares a new zip | User → Lead | TODO |
| P3 | On approval with deferred publishing: last check of the approved version, then Publish within 30 days | User | TODO |
| P4 | After publishing: install from the store in a clean profile and run the smoke test; add the store link to README and the welcome page | Lead (the User installs) | TODO |
| P5 | Any later change in data handling (for example D2's images): update the policy, this tab and the in-product notice, and ask again in the extension, before that version ships | Lead | Ongoing |

---

## 10. Rejection playbook

| Violation ID | What it means | Where Duel Lens could trip it | Fix |
|---|---|---|---|
| Purple Nickel | Data use not prominently disclosed, or no consent | Covered: the consent step before the first scan (C15) and the AI disclosure (C4). Keep the in-product texts, the policy and the privacy answers saying the same thing. | Disclose in the UI before the action |
| Purple Lithium | Missing, broken or incomplete privacy policy | The policy URL (D5, H1); the hosted text must match `privacy.html` (Appendix D) and the privacy answers | Fix the URL; align the text |
| Purple Potassium | Unused or overly broad permissions | Unlikely: the one host permission (`images.ygoprodeck.com`) has a truthful, specific justification (decision D2), and `unlimitedStorage` has its own. | Justify them (`store/privacy-practices.md` §2) |
| Purple Copper | Data sent insecurely | None known (all HTTPS). The Anthropic key travels in the API's auth header, as Anthropic requires | Explain in an appeal if raised |
| Red Titanium | Obfuscated code | **Resolved (C7):** OpenCV's inlined WebAssembly string is gone with OpenCV itself (A4) | N/A; if raised anyway, appeal noting `offscreen.js` is 188 KB with no multi-MB string literals |
| Blue Argon | Remotely hosted code | None known: everything is packaged; ORT loads from `ort/` | Point to `src/offscreen/web-runtime.ts:37` |
| Yellow Zinc | Missing or misleading metadata | A screenshot or text showing a feature not in the zip: click to scan (C14), or official card images (decision D2) when the uploaded build is actually the crop build, or vice versa | Match the listing to the zip |
| Yellow Magnesium | Doesn't work as described | The reviewer scans before agreeing (the welcome page opens instead; the Test instructions explain it), or scans a DRM page or a chrome:// page, or the engine fails on their machine | Test instructions with a working video (S8); graceful messages already exist |
| Red Nickel / Red Potassium | Deceptive behaviour, undisclosed actions | The debug hooks are out of store builds (C2, C3) | Keep them out |
| Impersonation / IP | Implied endorsement, trademark or copyright misuse | Title (D14), logos or broadcast frames in images (L5) | Rename, recrop, disclaimer |

---

## 11. Risk register (updated 2026-09-29 around 09:00, final sync)

Most likely to block or reject first:

1. ~~**DRAW2 (C1).**~~ **Resolved (A6 phase 1 and phase 2).** No longer a bundling risk: the extension
   hasn't imported it since A6 phase 1, and independent checks (this sync's build, `npm run release`)
   find 0 DRAW2 code or strings in any bundle. Repository hygiene is also done: `a6-phase2-report.md`
   confirms `src/offscreen/draw2/` and the DRAW2-only tools are deleted, and `extension/models/draw2/` is
   moved into the gitignored `data/draw2-archive/models/`. This clears the way for D7 (publishing the
   source).
2. ~~OpenCV's inlined WebAssembly string in `offscreen.js` (C7).~~ **Resolved (A4):** OpenCV.js is removed
   from the product entirely, not just repackaged.
3. **The privacy policy URL and its placeholders** (D4, D5, C18). The hosted text must match `privacy.html`.
4. ~~**"Ask AI" offered without the permission, and the key and permission kept when the check is turned
   off (C5).**~~ **Resolved:** the popover now offers "Ask AI" only with the permission, and turning the
   check off in Options removes the permission (`final-fixes-x-report.md`, M12).

Lower: `fonts/*` web-accessible to `<all_urls>` (justified: the in-page popover loads them, with
`use_dynamic_url`; `extension/manifest.json:43-45`); the store-mode wording review (C21); the final-review
minors (C13); submitting before the courtesy email to YGOPRODeck goes out (D2: send it first, USER MUST
DO).
