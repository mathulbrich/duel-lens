# tools/overnight: the overnight harvest (card crops only)

`harvest.ts` collects **training material from TRAIN videos only**: straightened crops of the cards in duel
videos and pseudo-labels from the extension's own engine. It is step P2 of
`.superpowers/sdd/2026-09-28-duel-lens-v1/overnight-plan.md`. It needs the network (YouTube), runs one
headless Chrome per process, and is not part of CI.

## The rules it enforces (the user's)

- **CARDS ONLY.** A crop is the card alone: its 4 corners from the card detector, grown by at most 4% per side,
  straightened with the engine's `warpQuad`, upright, 176×256 px (portrait, the card's aspect), JPEG q90.
- **No frame is ever written.** Frames are grabbed from the `<video>` into memory, the crops are cut, and the
  frames are dropped. No faces, table, overlays or logos are saved.
- **Train videos only.** The tool refuses any video whose `split` in `data/overnight/videos.json` isn't
  `train`: `--video` with a held-out id exits with `REFUSED`, and so does a group listing one.
- **Face-down boxes** are kept only as possible **overframe fronts** (the detector calls an overframe print
  face-down): the engine reads the track with its thresholds off (raw scores, as `eval-real --raw`) and keeps
  it only when the detector is unsure it is face-down (median confidence in [0.5, 0.72): the user's overframe
  Magician came at 0.63–0.68, sleeves and backs mostly at 0.75–0.96, the mat's art near the 0.4 floor), the
  first candidate is a real card, not the card back, scoring ≥ `--facedown-keep` (0.55), and its
  top 3 shares no card with another face-down track's, in the same moment or in the video's other moments (a
  sleeve design repeats; an overframe front is one of a kind). Card backs, sleeves and the playmat's printed
  zones (which the detector also calls face-down) are dropped. Kept face-down tracks are **never labelled**
  (source `none`, raw top 5 per frame): they are candidates for the checkers (P3), not training labels.

## Runner commands

One runner per group, from the repository root:

```bash
nohup npx tsx tools/overnight/harvest.ts --group 1 --until 05:00 --moments-per-video 80 > /dev/null 2>&1 &
nohup npx tsx tools/overnight/harvest.ts --group 2 --until 05:00 --moments-per-video 80 > /dev/null 2>&1 &
nohup npx tsx tools/overnight/harvest.ts --group 3 --until 05:00 --moments-per-video 80 > /dev/null 2>&1 &
nohup npx tsx tools/overnight/harvest.ts --group 4 --until 05:00 --moments-per-video 80 > /dev/null 2>&1 &
```

The tool writes its own log (`data/overnight/harvest-<group>.log`); follow it with `tail -f`. Set `--until` to
when the harvest must stop (local time, HH:MM, the next time the clock reads it).

**Why K = 80:** measured on 2026-09-30 with 4 runners at once (and other agents busy: load average about 35),
each runner did **230–264 moments an hour** (13.6–15.7 s a moment; analysis is the bottleneck, about 380 ms
per engine reading). A group has 13 videos, so 80 moments each (1,040) outlasts 01:00–05:00 even at full speed;
the interleaved order keeps every video evenly covered whenever the run stops. Alone, one runner does about
400–600 moments an hour.

- **Stopping:** the tool stops by itself at `--until`, when free disk falls under 20 GB, or when the group is
  done. To stop it earlier, signal the node process once: `kill -INT $(cat data/overnight/harvest-1.pid)`
  (the group's pid file). It stops after the moment in hand and closes its browser; a second signal stops it at
  once. Signal the pid in the file, not `npx`: a signal relayed through npx and tsx can arrive twice.
- **One runner per group:** a second run with the same group (tag) refuses to start while the first is alive.
- **Resuming:** run the same command again. The moments are the same list on every run (seeded by the video
  and K), and every moment already in `labels/<video>.jsonl` or `labels/<video>.moments.jsonl` is skipped. A
  moment that failed is retried once on a later run. Keep K the same for a group, or the new list is mostly
  new moments, which is fine but unplanned.

### Options

| Option | Default | What it does |
|---|---|---|
| `--group N` | required | The `harvestGroup` in `videos.json`. |
| `--until HH:MM` | none | Stop at this local time. |
| `--moments-per-video K` | 60 | Moments per video, spread from 5% to 95% of it, jittered. |
| `--video ID` | all the group's | One video of the group (must be train). |
| `--max-moments N` | none | Stop after N moments (tests). |
| `--engine-frames N` | 5 | Engine readings per face-up track (spread over its frames; the rest are read only when needed to label it). |
| `--facedown-keep S` | 0.55 | A face-down track is kept when its raw first candidate is a real card scoring ≥ S. |
| `--threads T` | 3 | onnxruntime threads for the embedder and the detector (4 runners × 3 on 14 cores). |
| `--order interleave\|sequential` | interleave | Interleave: round-robin over the group's videos, each one's moments in a spread order, so a run stopped early still covers every video. Sequential: video by video. |
| `--no-pipeline` | pipelined | By default the next moment loads while this one is analysed. |
| `--min-free-gb G` | 20 | The disk hard stop (never lower than 20). |
| `--margin M` | 0.04 | Crop margin per side (at most 0.04). |
| `--tag NAME` | the group | Names the log and summary files. |
| `--out DIR` | `data/overnight` | Where crops, labels, the log and the summary go (tests). |
| `--headful` | headless | Show the browser (debugging). |

## What each moment does

1. Loads the watch page at t (one page load per moment: an automated browser gets only about 20 s of YouTube
   per load), answers the consent dialog with "Reject all", waits out ads (skipping when offered), forces
   `hd1080` when offered (else the best under it), and records what was served.
2. Grabs 5 native frames at t, t+1 … t+4 s through a canvas, and runs the card detector on each (the
   extension's model and its 0.4 confidence floor). A moment whose first frame has fewer than 2 face-up cards
   (the desk, talking heads, break screens) is **skipped** there.
3. Builds tracks: the same card on several frames when its outlines overlap with polygon IoU ≥ 0.5. Face-up and
   face-down never mix (a set card flipped in place is two tracks).
4. Reads each face-up track's frames with the extension's engine exactly as a **click** does: the crop the
   content script cuts around a clicked card (its bounds plus 4%), with the detector's corners as the
   outline; the default model `dinov2-small-duel`, its thresholds and `decide()`.
5. Labels a track when **at least 2 frames read confidently as the same card and no frame confidently reads
   another**. Frames confident on it are `confident`; its other frames are `propagated` (the hard cases: glare,
   a hand, motion, tilt). Otherwise the track is `none`, with each frame's top 5 kept for checking (and one
   raw reading, `rawTop5`, when the engine found nothing at all).
6. Cuts every kept detection. The way up comes from the track's readings (the engine's winning hypothesis
   says whether the card was read upright or turned 180°); `orientation: "unknown"` when nothing was read.

## Output (all under `data/overnight/`, local only, never committed)

- `crops/<video>/m<t>-t<track>-f<frame>.jpg`: `t` is the moment's start in whole seconds (6 digits), `track` the
  track in that moment, `frame` 0–4.
- `labels/<video>.jsonl`, one line per crop:

  ```json
  {"video":"SdcCScBEvQE","moment":2219,"t":2219.02,"frame":0,"track":0,"kind":"face-up","conf":0.968,
   "corners":[[x,y],[x,y],[x,y],[x,y]],"px":[291,417],"file":"data/overnight/crops/SdcCScBEvQE/m002219-t00-f0.jpg",
   "cardId":16922142,"name":"Radiant Typhoon Krosea","source":"confident","decision":"confident",
   "top5":[{"cardId":16922142,"score":0.9716}],"quality":{"served":"hd1080","w":1920,"h":1080},"orientation":"engine"}
  ```

  - `corners`: the card's top-left, top-right, bottom-right and bottom-left in the frame, as cut (before the
    margin); `px`: its short and long side in frame pixels.
  - `cardId`: the track's label (`-1` is the card back), or null. `source`: `confident`, `propagated` or `none`.
  - `decision`: this frame's own reading. From the engine: `confident`, `unsure`, `suggested` (a low match or
    suggestions), `badge`, `nothing`, `confident-back`, `unsure-back`, `error`, or `not-run` (the frame wasn't
    read). Lines with `"raw": true` were read with the thresholds off; their decision is `decide()` on the
    raw list, so it can also be `below-floor` or `below-floor-back`.
  - `top5`: this frame's candidates (empty when not read or nothing matched); `rawTop5`: the raw candidates of
    an unlabelled face-up track the engine matched to nothing.
- `labels/<video>.moments.jsonl`, one line per moment: `done`, `skipped` (with the reason) or `error`, the
  served quality, counts and timings. This is what resuming reads.
- `harvest-<group>.log`: one line per moment (`done`, `skip`, `ERROR`), plus browser restarts and the stop reason.
- `harvest-<group>-summary.json`: totals over every run of the group (videos, moments done, skipped, failed;
  tracks and labelled tracks by kind; crops by source and kind) and this run's speed (moments per hour,
  seconds per moment, capture and analysis medians, engine ms per reading, crops per moment).

## What to watch

- **The log's `done` lines**: a done moment is about 10–60 crops (28 on average); `hd1080 1920x1080` is
  normal (YouTube's own first pick, `auto 240p`, is forced up). About a third of the moments are skipped as
  desk or break (`skip … 0 face-up card(s)`).
- **`ERROR` lines**: one bad moment is logged and skipped. After 5 in a row the browser is restarted, and
  after 15 in a row the run stops (the network, most likely). A failed moment is retried on the next run. A
  video that fails 3 times with no moment captured (unavailable, private, age-gated) is set aside for the rest
  of the run (`set aside` in the log).
- **`bot check`**: YouTube asked to confirm this is not a bot. The runner waits (1, then 2 minutes) with a new
  browser; after 3 in a row it stops. If two runners stop this way, stop the others too and tell the lead:
  more page loads only make it worse.
- **`stopping:`** gives the reason: `--until`, `free disk … < 20 GB`, `the group is done`, a signal, or errors.
- **Disk:** crops are about 11 KB each. Check `df -h .` now and then; the runners stop by themselves under 20 GB.
- **Speed:** `thisRun.momentsPerHour` in the summary: 230–260 with 4 runners. Under 150 means the machine is
  overloaded (for example once the trainer starts): stop the runner and restart it with `--threads 2`; it
  resumes where it stopped.

## Checking labels by eye (P3)

```bash
npx tsx tools/overnight/sheet.ts --video <id> [--source confident|propagated|none|any] [--kind face-up|face-down|any] [--n 24] [--seed 1]
```

writes `data/overnight/sheets/<video>-<source>-<kind>.jpg`: each crop next to the YGOPRODeck artwork
(`data/artworks/<imageId>.jpg`) of its label, or of its first candidate when it has none, with the name, the
source, the decision and the score. It also prints one row per cell (file, label, top 3) for the verdicts.
Sheets hold card crops and reference art only.
