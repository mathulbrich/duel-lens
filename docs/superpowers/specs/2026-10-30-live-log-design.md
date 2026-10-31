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
that cycle's wall time.

| Effort | load | minIntervalMs | slow above |
|---|---|---|---|
| `balanced` (default) | 0.2 | 500 | 2000 ms |
| `light` | 0.1 | 2000 | 4000 ms |

"Slow" (panel notice) after 3 cycles in a row above the effort's "slow above".

**D-L4. Change gate: read a card once it has settled.** Research (live-mode study, 2026-10-30): on a real table the
players' hands move almost all the time, so a whole-frame gate rarely skips anything and reads land on blurred
frames; scanners wait for the picture to settle and read once.
- Every **200 ms** of playback, a 64×36 grey thumbnail of the whole video frame, split into **8×4** zones. Each zone's
  mean absolute difference (0–255) against the previous sample: **6** or more makes the zone *moving*, below **3**
  *quiet*, in between keeps its state. A zone *settles* when, after moving, it is quiet for **2** samples in a row.
- The detector runs (no sooner than the rate allows, D-L3) on the first frame, when a zone has settled since the last
  detection, and **10 s** after the last detection (refresh).
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
first, at **0.3** or more. A track missing from **3** detections in a row is dropped. At most **2** reads
(recognize calls) per cycle, of voting tracks that may be read (D-L4): fewest reads first, larger boxes first.

**D-L6. Vote.** A track is read on each cycle that may read it (D-L4) until it settles. It is **promoted** when **2** reads were
confident for the same card and no read was confident for another card. It is **rejected** after **4** reads without
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

**D-L9. UI.**
- On the video: the pill at the video's top left, 12 px in, in the overlay's tokens; red dot and "LIVE", the entry
  count, a ✕ that stops Live. Hidden when `live.showLabel` is off. Visible in fullscreen.
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

**D-L13. Outlines, hover and click on the playing video.** While Live runs, every card it has listed and still tracks (a
promoted track seen in the last detection) gets the scan's thin gold outline on the video, in the Live host. Outlines
move to each new detection's box (and on resize, scroll, fullscreen and video size changes); a scene cut, a dropped
track, a paused-for-scan session or `live.showLabel` off removes them. Cards still being checked and rejected tracks get
no outline: only cards Live is sure of. The video keeps playing.
- Hover follows Options → Show card details, as in scan mode: "Quick preview" shows today's quick preview beside the
  outline; "Full details" shows the card box (D-L9) passively; "Click" shows nothing on hover.
- A click opens the card box (D-L9) next to the outline; a click on another outline replaces it.
- Only the outlines take the pointer; the rest of the video stays the player's. Outlines are not in the Tab order (the
  side panel's Live list is the keyboard path), and keys still reach the player.
- Cards being read: a track still voting (seen in the last detection) gets a dashed outline in the overlay's grey, so
  the user sees where Live is looking right now. It shows no name and takes no pointer. When the track is promoted
  the outline turns solid gold with a short glow (none under reduced motion); when it is rejected the outline goes.
- No new copy: the outline's accessible name is the card's name, as in scan mode.

## Copy (English)

| Key | Text |
|---|---|
| `shared_command_live_toggle` | Start or stop Live on this tab |
| `menu_live_start` / `menu_live_stop` | Start Live on this tab / Stop Live |
| `bar_live_button` | Live |
| `live_label` | Live |
| `live_stop_label` | Stop Live |
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
