# Live log: design

Status: draft, 2026-10-30. Option B of the live-mode study (artifact "Duel Lens Live Mode"). UI preview: artifact
"Live Log Preview". Plan: `docs/superpowers/plans/2026-10-30-live-log.md`.

## What it is

The user turns on **Live** on a tab. While the video plays, Duel Lens reads a few frames a second, follows each card
from frame to frame, and lists every card it is sure of in the side panel's **Live** tab, with the video time it first
appeared. Nothing freezes or pauses. The video gets one small label ("● LIVE 6 ✕"); the toolbar button gets a LIVE
badge on that tab.

Not in this version: names drawn on the moving video (option C; D-L13 adds only outlines on listed cards, hover and
click), "Read without pausing" (option A), Wrong card? and Report issue from a Live row.

## Decisions

**D-L1. Starting and stopping.** Live starts only from a user action on the tab: the shortcut `live-toggle`
(Alt+Shift+L, Chrome's 4th and last suggested key), the toolbar button's right-click item ("Start Live on this tab" /
"Stop Live"), **L** or the bar's **Live** button in scan mode (closes scan mode first), or the panel's **Start Live**
button. The panel button works only when Duel Lens can still script the active tab (an `activeTab` grant from an
earlier action on this page); otherwise it answers "Press Alt+Shift+L on the video's tab to start Live." Consent is
required as for a scan (`hasConsent`, else the welcome page). One Live session at a time: starting on tab B stops tab A.

**D-L2. Where the work happens.** The loop runs in the content script, which has the video. The engine stays
stateless and is reached through two background messages: `live-detect` (new; runs today's `detectCards` on a frame,
screenshot path, long side 1280) and today's `recognize` with `record: false` (no history, no thumbnail, no AI). Tracking,
voting and the rate control are pure modules in `src/content/live/`. The background owns the log in
`chrome.storage.session`, key `live`; the panel reads it there, as it reads `board`.

**D-L3. Frames.** `requestVideoFrameCallback` on the chosen video (the largest visible one with its metadata loaded,
preferring a playing one; a video still buffering after a seek counts, and the loop waits for its frames). One request in flight at a time. A frame is JPEG, quality **0.85**, long side at most
**1280**, of the visible picture (today's `encodeFrame`, with options). After each cycle (a detection with its reads,
or reads alone, D-L4), the next one waits at least `clamp(costMs / load, minIntervalMs, 8000)`, where `costMs` is
that cycle's wall time; the first cycle after a start, which also waits for the card reader to load, waits
`minIntervalMs`.

| Effort | load | minIntervalMs | slow above |
|---|---|---|---|
| `balanced` (default) | 0.2 | 500 | 2000 ms |
| `light` | 0.1 | 2000 | 4000 ms |

"Slow" (panel notice) after 3 cycles in a row above the effort's "slow above".

**D-L4. Change gate: read a card once it has settled.** Research (live-mode study, 2026-10-30): on a real table the
players' hands move almost all the time, so a whole-frame gate rarely skips anything and reads land on blurred
frames; scanners wait for the picture to settle and read once.
- Every **200 ms** of playback (slower when a sample costs more than a tenth of that: every 10 × the mean of the last
  10 samples' cost, at most **1000 ms**), a 128×72 grey thumbnail of the whole video frame, split into **16×8** zones
  of 8×9 px (a zone is about 120×135 px of a 1080p video, one or two cards). Each zone's
  mean absolute difference (0–255) against the previous sample: **6** or more makes the zone *moving*, below **3**
  *quiet*, in between keeps its state. A zone *settles* when, after moving, it is quiet for **2** samples in a row.
- The detector runs (no sooner than the rate allows, D-L3) on the first frame, when a zone has settled since the last
  detection, and **10 s** after the last detection (refresh). While voting tracks wait to be read and no read track's
  zones moved and settled, a settle runs a read cycle instead and its detection comes **2 s** after the last one.
- A track still voting is read only while every zone under its box is quiet. Between detections such a track is read
  again from its last box, without the detector. On a refresh, voting tracks are read even if their zones move (a
  blurred read is simply not confident).
- A cut drops every track and makes every zone moving: the whole-frame mean difference at **40** or more; a `seeking`
  event; a new `currentSrc` (YouTube ads play in the same element); or, between two samples while playing,
  `|ΔmediaTime − Δwall × playbackRate|` above **2 s**. The first sample after a pause compares nothing.
- Boxes, zones and crops use the video's native pixels (normalised 0–1 for the tracker and zones), so scrolling the
  page does not move them.

**D-L5. Tracker.** Boxes normalised to the video (0–1), axis-aligned bounds of the detector's 4 corners.
Only `kind: 'face-up'` boxes whose long side is at least **0.045** of the video height. Greedy match by IoU, best
first, at **0.3** or more. A track missing from **3** detections in a row is dropped. At most **8** reads
(recognize calls) per cycle (2026-11-06: was 4, so one cycle reads every card of a usual field; LIVE.readBudgetMs, 600 ms,
still ends a slow computer's cycle after its first read), of voting tracks that may be read (D-L4): fewest reads first, larger boxes first.

**D-L6. Vote.** A track is read on each cycle that may read it (D-L4) until it settles. It is **promoted** when **2** reads were
confident for the same card, or one confident read scored **0.86** or more (VOTE.clear, calibrated on the
suggest-floor sets), and no read was confident for another card. It is **rejected** after **4** reads without
promotion, and is then not read again. Face-down results and errors count as reads that are not confident.

**D-L7. Log.** `LiveLog { tabId, pageUrl, pageTitle, startedAt, status, intervalMs?, entries }`, entries newest first,
one per card: `{ cardId, imageId, firstVideoTime, lastVideoTime, appearances }`. A promotion of a card already listed
adds an appearance when its video time is at least **20 s** after `lastVideoTime`. A video time is the `mediaTime`
that `requestVideoFrameCallback` reports for the frame that was read. At most **200** entries. Restarting
Live on the same tab and page keeps the entries; another page starts a new log. The log is not scan history: it is
never written to IndexedDB. It stays after Live stops, until the tab closes or Live starts on another page.

**D-L8. Status.** `'starting' | 'watching' | 'paused' | 'slow' | 'blocked' | 'stopped'`, with `stopReason?:
'user' | 'left' | 'blocked' | 'no-video' | 'other-tab'`. Paused: the video is paused, seeking or ended, or the page is
hidden. Blocked: the frame is unreadable (DRM). Left: the page's video changed (YouTube: the `v` parameter; elsewhere
the URL without its hash) or the tab navigated.
Paused also covers a video that can't show frames (a player error, an empty or stalled video); Live drops its outlines until frames come back.
A paused video (not seeking or ended, on a shown page) gives no frame callbacks, so Live reads its still frame on a timer:
one detection, then reads of every card on it at the rate's pace until none waits, then nothing until a seek or play.
The status says watching while it reads, then paused. A seek while paused reads the new frame from scratch.

**D-L9. UI.**
- On the video: the pill at the video's top left, 12 px in, in the overlay's tokens; red dot and "LIVE", the entry
  count, a ✕ that stops Live. The dot, "LIVE" and the count are one button ("Show the cards Live found") that opens
  the side panel, which shows its Live view; where the click's gesture does not reach the background, it shows the
  "Press Alt+Shift+U" hint instead. Hidden when `live.showLabel` is off. Visible in fullscreen.
- Toolbar: badge text `LIVE`, colour `#C8322B`, title "Duel Lens: Live is on", per tab; cleared on stop.
- Side panel: the view switcher always shows **Live** and **Scans** (and **Board** when a board exists). The Live view
  has the heading "Seen in this video", a Stop Live / Start again button, a status line, a "Checking N more card(s)…"
  line while tracks vote, the rows (34×50 picture, name, "seen N×" chip when N > 1, the time as a gold button), and the
  foot note. A row opens the card in the panel (as a Board pick does) and writes nothing. The time seeks the same video
  to 3 s before it, in the tab.
- Card box over the video: a row click also shows today's popover on the video, while Live runs on that tab. It is
  placed next to the card when a track still holds that card, otherwise at the video's top-right corner, 12 px in; it
  stays where it opened (it does not follow the card). The video keeps playing and Live keeps reading and listing: the
  box is page markup, and Live reads the video element's own pixels, so the box never hides a card from Live. It
  offers what needs no history entry (as a card found by name does: Copy, YGOPRODeck, Konami; no Keep, no other
  matches, no Ask AI, no Wrong card?, no Report issue). It does not take the focus, so Space and K still reach the
  player; Esc or its ✕ closes it; a second row click replaces it. Visible in fullscreen. When Live is not running on
  the tab (stopped, page left), the row opens the card in the panel only.
- Options → **Live**: effort (Balanced / Light) and "Show the LIVE label on the video". Changes reach a running Live
  session on its next frame.

**D-L10. Privacy.** Frames and crops stay in memory and are dropped after each frame. No network beyond what a scan
already uses (card images from YGOPRODeck in the remote-images build). No new permission. The privacy policy, the
consent text (point 1), `store/privacy-practices.md` and the listing say that while Live is on, Duel Lens reads the
playing video's frames continuously, on the computer.

**D-L11. Firefox.** Same loop. The detector runs on WASM there, so the interval is longer; no keep-alive while the
video is paused (the event page may unload; the next frame reloads the engine).

**D-L12. Gate.** After the loop works end to end (plan Task 7), the E2E clip must show, in Chrome on the development
Mac with `balanced`: a median interval of **800 ms or less**, every expected card listed within 15 s of its first
frame, and **0** wrong names. The low-end Docker profile reports its median interval (no pass mark; it decides the
"slow" wording). The clip has a hand moving over one part of the mat: a card lying still elsewhere must be listed
while the hand still moves. The report also gives Live's cost on the page per step (thumbnail, frame encode, crop
encode: median and 95th percentile, ms) and the long tasks (over 50 ms) while Live runs. A step whose 95th
percentile is over 50 ms on the development Mac moves to the asynchronous `canvas.toBlob` and is measured again;
still over, it counts as a gate failure. If the gate fails, stop and report before the UI, Options and docs tasks.

**D-L13. Hover first (2026-11-06, after DuelSight).** The pointer over the video steers Live. Only the card under the
pointer is outlined, in the Live host: the scan's thin gold outline once Live has listed it, a dashed grey one while it
is still being read; no other card on the video is outlined. The outline takes no pointer, so clicks, hovers and keys
stay the player's, and it moves with each detection (and on resize, scroll, fullscreen, video size changes).
- The pointer on a listed card shows it at once, with no rest (2026-11-06: was HOVER_MS; a sweep over the cards shows
  each in turn), as Options → Show card details says: "Full details", the card box (D-L9),
  passively; "Quick preview" and "Click", the quick preview (the outline takes no click, so the preview's own click opens
  the card box). It goes GRACE_MS after the pointer leaves the card, unless the pointer is on it. A card listed under the
  pointer shows at once.
- The loop follows the pointer (`HOVER`): while it moved over the picture in the last **10 s** and lies on a card still
  being read, or on a spot not searched in the last **500 ms**, a cycle comes sooner than the rate's wait: **250 ms**
  after the last cycle started at the soonest, and only once that cycle's cost and then the pull's own (the last pulled
  cycle's, else the last read's) have passed, so a slow computer's engine is busy half the time at most. A pulled cycle reads
  the card under the pointer alone, even while its zones move, or searches an unknown spot there (a detection, then
  that card alone); it never brings the rate's own cycle sooner. The rate's cycles read the pointed card first.
  (2026-11-06: was every 500 ms, with the other waiting cards read too, so a pulled cycle cost up to four reads.)
- No new copy: the outline's accessible name is the card's name, as in scan mode.

**D-L14. Live check: a popup toggle, on every site (2026-11-06, the user's call, after DuelSight's popup).** "Live" is
renamed **"Live check"** in every string a user sees (9 locales, Options, pill, panel, menus, docs). Code names stay.
- **Popup.** The toolbar icon opens a popup (`action.default_popup`, popup.html, Preact like Options) instead of
  scanning at once. It holds, top to bottom: a **"Scan this page"** button (today's scan of the active tab, then the
  popup closes); a **"Live check"** switch (on/off, global, with one line under it: "Point at a card in a video to see
  it."); a **"Cards found"** link that opens the side panel (Firefox: the sidebar); an **"Options"** link. The Alt+Shift+Y
  scan shortcut is unchanged (one step). The icon's right-click menu entry and the Alt+Shift+L shortcut toggle Live
  check too. The scan bar's Live button goes (the popup is the way in).
- **Global and persistent.** The switch is a setting, `live.check` (default off), kept across restarts. Turning it on:
  1. without the data consent (D-L1's), opens the consent page and stays off;
  2. asks Chrome for `<all_urls>` (`chrome.permissions.request`, from the popup's click: a gesture), added to
     `optional_host_permissions` (Firefox: its optional host permissions); refused, it stays off;
  3. registers `content.js` on every page (`chrome.scripting.registerContentScripts`, id `live-check`, `<all_urls>`,
     `document_idle`, top frame only, persisted) and injects it into the open tabs' top frames, so no reload is needed.
  Turning it off unregisters the script, stops any running loop and disarms every open tab. Permission removed in
  the browser's settings: the setting reads off.
- **Armed, not running.** On a page with Live check on, the content script only listens for the pointer: no frame is
  read and the engine is not loaded until the pointer has rested **0.6 s** on a playing, readable video of at least
  **400 x 225** CSS px (a feed's hover previews and most ads are smaller), and Live then reads that video
  (`ARM`, content/live/arm.ts). A video the loop finds unreadable (blocked) holds Live check off that page too.
  Then it asks the background to start Live there (the existing start: log, badge, pill, consent, another tab's run
  stopping as 'other-tab'), and the loop runs as D-L3..D-L13 say until the page changes or the pointer's tab is left.
  The pill's stop button stops the loop on that page only (no restart there until the page changes); the switch stays on.
- Pictures: D-L15. Frames other than the top one get no script.

**D-L15. Live check on pictures (2026-11-07).** With Live check on, the pointer resting **300 ms** on a picture of at
least 50 x 70 CSS px (an `<img>`, a canvas, an element's background image, a player inside an iframe; not a `<video>`,
which is D-L14's) shows the card under it, as a video's card shows (D-L13: the preview or the passive card box, per
Options). The picture's own pixels are read when the page allows it (same origin or served for any: the sharpest, at up
to 2048 px); otherwise a screenshot of the tab (`live-check-shot`, `captureVisibleTab`, allowed by Live check's
every-site permission, only for the active tab while the switch is on) is cut to the picture's visible part. The cards on
a picture are found once (live-detect) and kept per element until its source or size changes; only the card under the
pointer is read (recognize, not recorded), once, and shown only when the read is confident. Leaving the card's box lets
it go after GRACE_MS. Pictures' cards are not listed in the side panel. (`PICTURE`, content/live/pictures.ts.)

## Copy (English)

| Key | Text |
|---|---|
| `shared_command_live_toggle` | Start or stop Live on this tab |
| `menu_live_start` / `menu_live_stop` | Start Live on this tab / Stop Live |
| `bar_live_button` | Live |
| `live_label` | Live |
| `live_stop_label` | Stop Live |
| `live_open_panel_label` | Show the cards Live found |
| `sidepanel_live_tab` | Live |
| `sidepanel_live_heading` | Seen in this video |
| `sidepanel_live_stop_button` / `sidepanel_live_start_button` / `sidepanel_live_restart_button` | Stop Live / Start Live / Start again |
| `sidepanel_live_status_starting` | Starting · loading the card reader… |
| `sidepanel_live_status_watching` | Watching · about $rate$ frames a second |
| `sidepanel_live_status_paused` | Paused with the video. Play it to carry on. |
| `sidepanel_live_status_slow` | This computer is busy: Live reads one frame every $seconds$ s, so quick plays may be missed. |
| `sidepanel_live_status_blocked` | This video blocks screenshots, so Live can't read it. |
| `sidepanel_live_status_left` | Live stopped: you moved to another video. This list stays until you close the tab. |
| `sidepanel_live_status_stopped` | Live stopped. This list stays until you close the tab. |
| `sidepanel_live_checking_one` / `_other` | Checking 1 more card… / Checking $count$ more cards… |
| `sidepanel_live_seen_count` | seen $count$× |
| `sidepanel_live_jump_label` | Jump the video to $time$ |
| `sidepanel_live_empty_running` | Cards show up here once Duel Lens has seen them clearly for a moment. |
| `sidepanel_live_empty_idle` | Live lists every card a playing video shows clearly, without pausing it. |
| `sidepanel_live_needs_shortcut` | Press Alt+Shift+L on the video's tab to start Live. |
| `sidepanel_live_foot` | Only cards Duel Lens is sure of are listed. Click a name to see the card on the video, or a time to jump the video back there. |
| `content_live_no_video` | Live needs a playing video on this page. |
| `options_section_live` | Live |
| `options_live_hint` | Live reads the playing video a few times a second, on your computer. No frame is sent anywhere or saved. |
| `options_live_effort_balanced` / `_hint` | Balanced / Up to 2 frames a second. Best for fast plays. |
| `options_live_effort_light` / `_hint` | Light / About one frame every 2 seconds. Saves battery on a laptop. |
| `options_live_show_label_checkbox` | Show the LIVE label on the video |
| `bg_live_badge_title` | Duel Lens: Live is on |
