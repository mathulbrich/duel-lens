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
| `low` | 2 | 0.5 CPU between them | 4 GB | an old dual-core laptop |
| `potato` | 2 | 0.25 CPU | 3 GB | a Celeron-class netbook |

- **Chrome, Opera:** the real-footage E2E, click to scan (`test/e2e/run.ts --real --click`) on the first `ROWS` cards of `data/realset` (40 by default). Opera's build is loaded in Chromium, as `run.ts` does. Every 10th row first closes the offscreen document, so the engine loads again, as after 5 idle minutes (`DUEL_LENS_E2E_COLD_EVERY`, `test/e2e/low-end.ts`).
- **Firefox:** `test/e2e/firefox.ts`, the board by drag and click, then a scan after the idle reload.
- **Output:** each run writes to `test/e2e/out/low-end/<profile>/`:
  - `<browser>.log`;
  - its JSON report (per-stage engine timings in `rows[].raw.timings`; engine loads in `lowEnd.engineLoads`);
  - `<browser>.memory`: the browser's peak memory (PSS, MB).
- **One model at a time:** `embed-bench.ts` times a single model run (embedder crop, detector screenshot) by thread count, with and without ORT's spinning, under the same limits:
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

**Still slow:**
- **Cold start.** After 5 idle minutes the engine loads again. Outlines then take about 3.1 s (Chrome) or 6.0 s (Opera, whose files are base64 text). The first scan after install takes about 8 s.
- **Detector.** The screenshot detector at 1,280 px takes about 1.0–1.4 s.
- **The slow 10%.** When the first reading isn't sure, the 180° readings add about 2.5 s (p90 about 4.4 s).
- **Memory.** Peak about 1.1 GB for Chromium and 1.5 GB for Firefox, with nothing else open.
