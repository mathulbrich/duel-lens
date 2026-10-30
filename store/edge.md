# Duel Lens: Microsoft Edge Add-ons submission guide (draft)

Status: draft, prepared 2026-10-16, for the same store build and texts the Chrome Web Store listing
uses (`store/listing.md`, `store/privacy-practices.md`, `store/privacy-tab-answers.txt`). Edge is a
Chromium browser (it tracks Chrome's engine and extensions platform closely), so **the same zip**
(`release/duel-lens-<version>.zip` from `npm run release`, per `docs/release/packaging.md` and
`docs/release/RELEASE-CHECKLIST.md` §7) is uploaded unmodified — no second build, no manifest change.
Compat check (`compat-chromium.md`, this ledger): `chrome.sidePanel`, `chrome.offscreen`,
`chrome.scripting`, `chrome.alarms`, `chrome.storage` (incl. `.session`), `cross_origin_embedder_policy`/
`cross_origin_opener_policy` and the `side_panel` manifest key are all native Chromium/Edge features; Edge
has never been the browser Duel Lens needed a fallback for (Opera was — `store/opera.md`).

Sources (checked 2026-10-16):
- Account/registration: https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/create-dev-account
- Submission walkthrough and Partner Center tabs (Package, Availability, Properties, Store listings): https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension
- Image specs (logo, screenshots, promo tiles): https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension (Store listings section); cross-checked against https://www.stefanvd.net/blog/2024/07/27/browser-extension-screenshots/
- Review process/automation and current turnaround: https://blogs.windows.com/msedgedev/2026/09/08/faster-reviews-and-quality-recognition-for-microsoft-edge-extensions/ and https://blogs.windows.com/msedgedev/2025/02/26/empowering-microsoft-edge-add-ons-developers-with-faster-reviews/
- Individual developer fee waived: https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/

---

## 1. Account creation

1. Sign in to [Partner Center](https://partner.microsoft.com/dashboard) with a Microsoft account (MSA).
   A plain personal Microsoft account works; you don't need an existing Partner Center account for
   anything else.
2. In Partner Center, go to **Account settings → Programs**, find the **Microsoft Edge** card, and
   click **Get started**.
3. Fill in the registration form (developer/publisher display name — reuse "Duel Lens" / the publisher
   name decided for the Chrome listing, D4 in `RELEASE-CHECKLIST.md`) and submit.
4. **No fee.** Individual developer registration for the Microsoft Store/Edge Add-ons program is free
   (it used to carry a small one-time charge; Microsoft waived it for individual developers in 2025).
   Wait for the verification email before submitting an extension.

This is a separate registration from the Chrome Web Store developer account (§A2/§5 in
`RELEASE-CHECKLIST.md`) and from Opera's (`store/opera.md`) — each store has its own account, even
though the publisher identity and contact email are the same everywhere.

---

## 2. Upload the same zip

1. Partner Center → your extension → **New extension** (first submission) or the existing listing.
2. **Package** tab: upload `release/duel-lens-<version>.zip` — the exact file built for the Chrome Web
   Store (check its SHA-256 against the lead's build log first, same as Chrome step U1). Partner Center
   validates the manifest on upload; resolve anything it flags before moving on.
   - No `--edge` build flag exists or is needed (`docs/release/packaging.md`'s flag table is unchanged):
     the store build's manifest (`extension/manifest.json`) — `activeTab`, `scripting`, `offscreen`,
     `storage`, `unlimitedStorage`, `sidePanel`, `alarms`, `contextMenus`, optional `https://api.anthropic.com/*`, host
     permission `https://images.ygoprodeck.com/*` — is valid Edge MV3 as written.
3. If Partner Center's validator reports an "unrecognized manifest key" warning for anything, it's a
   warning, not a rejection (Chromium's manifest parser — which Edge uses — logs unknown top-level keys
   without refusing to load the extension; see `compat-chromium.md` §3 for the chrome://extensions
   evidence). Nothing in Duel Lens's manifest is actually unrecognized by Edge, so this isn't expected
   to fire at all; it's listed here only so a stray warning on a future manifest change isn't mistaken
   for a blocker.

---

## 3. Listing fields — reuse from `store/`

Edge's **Properties** and **Store listings** tabs map onto the same fields Chrome's dashboard has, with
the same source texts:

| Partner Center field | Reuse | Note |
|---|---|---|
| Extension name | manifest `name` (already set for Chrome) | No separate field; Edge reads it from the package like Chrome does |
| Store listing description | `store/listing.md` §4 (the long description) | Same plain-text block, pasted as-is (it describes the 0.9.4 features: find a card by name with Alt+Shift+F and the toolbar icon's right-click menu, Report issue, the three "Show card details" choices) |
| Short description / summary | `store/listing.md` §3, option 1 | Edge doesn't enforce the 132-char manifest-description limit the same way, but the same short text reads fine |
| Category | `store/listing.md` §5 — **Entertainment** | Edge's category list differs slightly from Chrome's; pick the closest match (Entertainment exists in both) |
| Logo (one per supported language) | `store/assets/icon-128-store.png` | Edge recommends 300×300, minimum 128×128 (1:1); our 128×128 clears the minimum. A sharper 300×300 master can be produced later if Edge ever flags it — not a blocker for first submission |
| Screenshots (1–6) | `store/screenshots/01-hero.png` … `05-privacy.png` | Edge accepts 1280×800 or 640×480; ours are 1280×800 (`store/listing.md` §1) — use as-is, no resize |
| Small promo tile (440×280) | `store/promo/small-440x280.png` | Same file Chrome uses |
| Large/marquee promo tile (1400×560) | — | Chrome's listing skipped this too (`store/listing.md` §1); same call for Edge |
| Website / support URL | `store/listing.md` §1 (Homepage/Support URL row) | Same repo/issues link or support email |
| Privacy policy URL | the hosted gist (`docs/release/RELEASE-CHECKLIST.md` D5) | Same URL as Chrome's and Opera's |

Markets/Availability: all markets, Public visibility, free — same choices as Chrome's Distribution tab
(`store/listing.md` §8).

---

## 4. Privacy answers

Edge's **Privacy** page (under Properties, in current Partner Center) asks for the same five things
Chrome's Privacy practices tab does, and the *content* of every answer is identical because it describes
the same build and the same data handling — only the exact UI wording of the questions differs slightly.
Reuse directly from `store/privacy-tab-answers.txt` (source: `store/privacy-practices.md`):

1. **Single purpose / what the extension does** → §1 of `privacy-tab-answers.txt`, verbatim.
2. **Permission justifications** → §2, one box per permission; Edge asks for these per-permission too
   (activeTab, scripting, offscreen, storage, unlimitedStorage, sidePanel, alarms, contextMenus, plus the optional
   `api.anthropic.com` host permission and the required `images.ygoprodeck.com` one). `contextMenus` adds
   one item to the toolbar icon's right-click menu, "Find a card by name…", which opens the side panel's
   search box; the Alt+Shift+F command (`find-card`) does the same, so mention both when a box asks.
3. **Remote code** → §3: "No remote code" (everything ships in the package; only card data/images are
   fetched, never executed).
4. **Data usage** → §4's three ticked categories (authentication info for the user's own Anthropic key,
   web history for the scan history, website content for the screenshot/crop) map onto Edge's data-use
   certification the same way. Card reports are part of those answers: a report is sent only when the
   user presses **Send report** after **Report issue**, becomes a public issue on github.com/mathulbrich/duel-lens/issues
   through Duel Lens's report service (it keeps the image 90 days and no IP address), and holds the
   shrunk crop, the cards shown, the page link and an optional comment (`store/privacy-practices.md` §0 and §4).
5. **Certifications** → §5's three ticks (no selling/transferring data, no unrelated use, no
   creditworthiness use).
6. **Privacy policy URL** → the same hosted gist.

Edge's 2026 submission flow treats this page as a first-class step (not a quick afterthought): expect it
to ask for the single-purpose statement and permission justifications before it lets the package move
to review, and to warn that an incomplete or inaccurate answer here causes extra review rounds or
rejection — so paste the full text, don't summarize it.

---

**What's new (0.9.4), if a box asks:** Find a card by name (Alt+Shift+F, the toolbar icon's right-click
menu, the side panel's search box). Report issue on a wrong, unsure or unmatched card (nothing is sent until
Send report). Three "Show card details" choices. More "Not sure" answers and faster scans on slower computers.

---

## 5. Review time

Microsoft's stated target is **up to 7 business days**. In practice, Microsoft's own 2026 posts say
submission volume (including a wave of AI-assisted/low-quality submissions) has strained the review
pipeline and lengthened turnaround beyond that in some periods; Microsoft responded by automating the
repeatable policy/security checks so human reviewers focus on judgment calls, and by adding a faster
refresh cycle for "Featured" recognition. There's no published worst-case number the way Chrome's
"contact support after 3 weeks" is — if a submission sits well past 7 business days, Partner Center's
support channel is the next step (mirrors Chrome's P1 in `RELEASE-CHECKLIST.md` §9).

---

## 6. Policy differences from the Chrome Web Store worth knowing

- **No developer fee.** Chrome charges a one-time US$5 registration fee (`RELEASE-CHECKLIST.md` A2);
  Edge/Microsoft Store individual developer registration is free.
- **Privacy is a dedicated, more structured step in 2026.** Microsoft's own guidance (cited above) now
  treats the single-purpose statement, permission justifications, remote-code disclosure and data-use
  certification as a distinct gate before review, more explicitly than Chrome's single "Privacy
  practices" tab — same answers, just don't skip or shorten them.
- **Screenshots: up to 6**, vs. Chrome's 1–5; Duel Lens only has 5 (`store/screenshots/`), which is
  fine for both.
- **No separate "trader/non-trader" declaration** the way Chrome's EU-driven dashboard asks for one
  (`RELEASE-CHECKLIST.md` §5, D20) — not found in Edge's Partner Center flow; if Partner Center does
  surface an equivalent during submission, answer it the same way the Chrome declaration was answered.
- **Same manifest, no `--edge`-specific build.** Unlike Opera (which, as of writing, may still lack
  `chrome.sidePanel` on some installs — `store/opera.md`), nothing here required a code or manifest
  change; this guide's only "build" step is re-checking the zip's SHA-256 before upload.

---

## 7. What the user should check by hand (Edge isn't installed on this machine)

1. Install the uploaded `.zip` as an unpacked extension in Edge (`edge://extensions` → Developer mode →
   Load unpacked, pointed at `release/build/`, the same unpacked folder the zip is made from) and
   confirm no "unrecognized manifest key" or permission warning appears for `side_panel` or anything
   else in `extension/manifest.json`.
2. Press Alt+Shift+Y on a real duel video and confirm the welcome/consent flow, the frozen-frame outline,
   and the popover all work exactly as in Chrome.
3. Press Alt+Shift+U (or "Keep in side panel") and confirm Edge opens its native side panel (it should
   — Edge has shipped `chrome.sidePanel` since it tracked Chrome 114) rather than falling back to the
   popup window `src/background/panel.ts` would use if it didn't.
4. Confirm the offscreen document loads (the recognition engine) — check `edge://extensions` → the
   extension's "service worker"/"Inspect views" for console errors on first scan.
5. After publishing, install from the live Edge Add-ons listing in a clean profile and repeat a smoke
   test, same as Chrome's P4 (`RELEASE-CHECKLIST.md` §9).
