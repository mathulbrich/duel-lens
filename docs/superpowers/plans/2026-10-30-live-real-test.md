# Live on real footage: test plan

Status: draft, 2026-10-30. Branch `live-log`. Asked by the user after a hand test showed a stale name (Centur-Ion
Trudea kept on a spot after it went to the GY and another card took its place).

## Footage

| Id | Video | Start | What it shows |
|---|---|---|---|
| V1 | `https://www.youtube.com/watch?v=gYmgyzpjitM&t=4748` | 1:19:08 | YCS Bologna 2024, R11: Fiendsmith Kashtira vs Bystial Centur-Ion, top-down mat, "Card highlight" panel, player cams |
| V2 | `https://www.youtube.com/watch?v=gYmgyzpjitM&t=20788` | 5:46:28 | Same stream, a later feature match |

Automation loads these two pages only, at the user's request. A bot check or sign-in wall stops the run: report it,
never work around it. A consent page gets its most private choice ("Reject all"). Ads play out (they are a test:
`currentSrc` changes must cut).

## Matrix

| Run | Browser | Machine | Effort | Footage |
|---|---|---|---|---|
| R1 | Chrome | this Mac | balanced | V1, 6 min |
| R2 | Chrome | this Mac | balanced | V2, 6 min |
| R3 | Chrome | this Mac | light | V1, 6 min |
| R4 | Opera build in Chromium | this Mac | balanced | V1, 6 min |
| R5 | Firefox | this Mac | balanced | V1, 6 min |
| R6 | Firefox | this Mac | light | V2, 6 min |
| R7 | Chromium | Docker `low` | balanced | V1, 6 min |
| R8 | Chromium | Docker `low` | light | V1, 6 min |

## Each run records

- The Live log over time: names, first video time, appearances, status, interval.
- At each new listing: a page screenshot cropped to the card's outline (what Live saw) beside the listed card's
  official picture, on one contact sheet per run.
- Outlines every 2 s (state, rect) and a screenshot every 30 s, to check for stale gold outlines.
- Step costs (thumb, encode, crop: p50/p95), long tasks, peak interval, status changes.
- Scripted events in the run: pause 10 s at 2:00, seek back 30 s at 3:00, effort switch at 4:00 (balanced runs).

## Checks

1. **Wrong names (hard fail):** every listed name matches its crop on the contact sheet. One wrong name fails the run.
2. **Stale outlines (hard fail):** a gold outline's name must match the card under it on the 30 s screenshots; a
   card that left must lose its outline within one detection.
3. **Coverage (report):** distinct face-up cards that lay still ≥ 5 s on the mat (counted from the 30 s
   screenshots) vs listed; Chrome balanced is expected to list most of them.
4. **Pace (report):** median interval and step p95; long tasks over 50 ms on this Mac are a finding.
5. **Lifecycle (hard fail):** pause → 'paused' and no frames; resume; seek back → cut and no duplicate entries; ads
   don't list cards; the effort switch reaches the loop.
6. **Low-end (report):** interval, coverage, long tasks; compare balanced vs light.

## Fix first

The stale-name bug: a promoted (or rejected) track keeps matching by IoU when another card takes its place, so the new
card is never read and the old name stays on the outline and the card box. Fix: a track whose zones moved after its
last read is read again once they are quiet (state back to voting, outline dashed, no name until it is confirmed
again). A hand passing over a card costs a re-read.

## Tooling

`test/e2e/live-real.ts`: `--browser chrome|opera|firefox`, `--url`, `--minutes`, `--effort`, `--script` (the events
above), writes `test/e2e/out/live-real/<run>/report.json`, `sheet.png` (contact sheet), `shots/`. Docker runs reuse
`test/e2e/low-end/run.sh` with a `live-real` mode.
