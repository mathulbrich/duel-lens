# Duel Lens on a slow computer

`run.sh` runs the extension in a Linux container (`Dockerfile`: Debian's Chromium and Firefox ESR) with fewer cores, a CPU quota, less memory and no GPU. Both models then run on ONNX Runtime's WASM backend, the worst case. Docker must be running.

```sh
test/e2e/low-end/run.sh low                    # Chrome, Opera and Firefox (about 20 minutes)
test/e2e/low-end/run.sh fast chrome            # the same container unthrottled, to compare with
ROWS=20 test/e2e/low-end/run.sh potato opera   # fewer cards
```

| Profile | Cores | CPU quota | Memory | Like |
|---|---|---|---|---|
| `fast` | 6 | none | 6 GB | this Mac in a container |
| `mid` | 2 | 1 CPU between them | 4 GB | a weak laptop without a usable graphics card |
| `low` | 2 | 0.5 CPU between them | 4 GB | an old dual-core laptop |
| `potato` | 2 | 0.25 CPU | 3 GB | a Celeron-class netbook |

- **Chrome, Opera:** the real-footage E2E, click to scan (`test/e2e/run.ts --real --click`) on the first `ROWS` cards of `data/realset` (40 by default). Opera's build is loaded in Chromium, as `run.ts` does. Every 10th row first closes the offscreen document, so the engine loads again, as after 15 idle minutes (`DUEL_LENS_E2E_COLD_EVERY`, `test/e2e/low-end.ts`).
- **Live:** `run.sh low live` plays Live's synthetic clip (`test/e2e/live.ts`, 30 s) in Chromium and writes `live-report.json`. No pass mark here: read the pace (median `intervalMs`), each step's median and 95th percentile (`thumbMs`, `encodeMs`, `cropMs`) and the long tasks. Measured, `low` profile (2 cores, 0.5 CPU, no GPU): median interval 8000 ms (the cap; status `slow`), `thumbMs` p50 2.8 / p95 98.5 ms, `encodeMs` p50 5.2 / p95 108.9 ms (4 samples), `cropMs` p50 1.7 / p95 77.3 ms (3 samples), 98 long tasks (longest 189 ms); only Dark Magician was listed, 19.2 s after its placement. For comparison this Mac: median 500 ms, p95 3.3 / 6.3 / 2.7 ms, no long tasks, all three cards listed in 1.9 to 3.6 s.
- **Firefox:** `test/e2e/firefox.ts`, the board by drag and click, then a scan after the idle reload.
- **Live on a hand:** `COMPARE_EFFORT=light run.sh mid hand` runs `test/e2e/hand-timing.ts` on YouTube (the 5 hand cards, 6 s each) and writes `hand.json` with Live's trail. With YouTube playing, `low` is not a fair weak PC: software video decoding takes most of its half CPU (the same detection took 1.1 to 6.3 s), where a real laptop decodes video in hardware. Read `mid` for weak computers (2026-11-07: Light shows the first hand card in about 0.5 s, Balanced and Best in about 1.3 s).
- **Output:** each run writes to `test/e2e/out/low-end/<profile>/`:
  - `<browser>.log`;
  - its JSON report (per-stage engine timings in `rows[].raw.timings`; engine loads in `lowEnd.engineLoads`);
  - `<browser>.memory`: the browser's peak memory (PSS, MB).
- **One model at a time:** `load-bench.ts` times loading the engine (ORT start, each session), and `embed-bench.ts` times a single model run (embedder crop, detector screenshot) by thread count, with and without ORT's spinning, under the same limits:
  ```sh
  docker run --rm --cpuset-cpus=0,1 --memory=4g -v "$PWD:/repo" -v duel-lens-low-end-nm:/repo/node_modules \
    duel-lens-low-end npx tsx test/e2e/low-end/embed-bench.ts --threads 2
  ```

The container runs the same Chromium code paths, without the GPU and with less CPU. It is not a real slow PC: its cores are this Mac's, cut by a quota. Read its numbers as relative, and expect ±20% between runs.

## Findings (2026-10-29, `low`)

**Threads.** ORT's WASM threads wait for each other at every layer. A thread that loses its core holds up the rest. One embedder crop on 2 cores, no quota:

| Threads | Crop |
|---|---|
| 1 | 273 ms |
| 2 | 149 ms |
| 4 | 540 ms |

The engine used `min(4, cores)`, which is 4 threads on a 2-core, 4-thread laptop. It now uses half the cores, 1 to 4 (`web-runtime.ts` `wasmThreads`). Computers with 8 or more cores are unchanged.

**Views in turn.** A click embedded the straightened card's 3 views (corners, box, grown box) at once, 77% of a scan. The engine now reads the first view alone, and the other two only when it isn't sure (`engine.ts` `viewsInTurn`). Every answer is the same on realset (120 cards, 70 negatives) and realset2 (399 cards, 127 negatives).

Before and after, warm medians (p90). Chrome and Opera: 40 cards. Firefox: the board.

| | Before | After |
|---|---|---|
| Chrome: click → answer | 3,217 ms (5,603) | 1,593 ms (4,363) |
| Chrome: shortcut → outlines | 1,525 ms | 1,213 ms |
| Chrome: scan after the engine reloads | 4,611 ms | 2,598 ms |
| Opera: click → answer | 3,198 ms | 1,594 ms |
| Firefox: click → answer | 2,905 ms | 1,912 ms |
| Accuracy (Chrome, Opera) | 40/40 | 40/40 |

Firefox's outlines didn't change: its event page isn't cross-origin isolated, so it has always run one thread.

**The shortcut's warm-up.** It loaded the card detector and the whole engine at once, so the first screenshot's detection could wait behind the embedder's session. That session holds the offscreen document's thread for about a second. The warm-up now loads the engine only after that first detection, or after 3 s (`handler.ts` `WARMUP_DETECTION_WAIT_MS`), while the user picks a card. A scan that comes first still loads it at once.
- The first outlines after install: 8.1 s → 4.8 s (the detector's own time 4.5 s → 2.1 s).
- After an idle reload, the outlines stay at about 3.1 s: the detector's first run costs 2.6 s, against 1.0 s warm. That is ONNX Runtime's WASM start plus the detector's session, and nothing waited ahead of them.
- The harness clicks the moment the outlines show, so its cold scans now wait about 0.5 s for the embedder. A person takes longer than that to pick a card.

**Graph optimization is not the cost.** `load-bench.ts` creates the sessions as the extension does: the detector first, at `all`. The embedder's session then takes 0.8–1.0 s whatever its level (`all` to `disabled`), with the same vectors. Its inference is the same speed at every level. The detector's is 13% slower below `all`.

**Still slow:**
- **Cold start.** When the offscreen document closes, the next outlines take about 3.1 s (Chrome) or 6.0 s (Opera, whose files are base64 text). It now closes after 15 idle minutes instead of 5 (`offscreen-client.ts` `OFFSCREEN_IDLE_MINUTES`), so a viewer who scans now and then meets it less. The cost is holding its memory 10 minutes longer.
- **Detector.** The screenshot detector at 1,280 px takes about 1.0–1.4 s.
- **The slow 10%.** When the first reading isn't sure, the 180° readings add about 2.5 s (p90 about 4.4 s).
- **Memory.** Peak about 1.1 GB for Chromium and 1.5 GB for Firefox, with nothing else open.
