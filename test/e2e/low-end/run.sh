#!/usr/bin/env bash
# The extension's latency on a slow computer: a Linux container (Dockerfile) with fewer cores, a CPU quota,
# less memory and no GPU, so both models run on WASM.
# - chrome, opera: the real-footage E2E, click to scan (test/e2e/run.ts --real --click; Opera's build in
#   Chromium, as run.ts does), the first $ROWS cards, the engine loaded again every 10th row (low-end.ts);
# - firefox: test/e2e/firefox.ts in Firefox ESR (the board by drag and click, then a scan after the idle reload).
# Usage: test/e2e/low-end/run.sh [fast|low|potato] [chrome] [opera] [firefox]   (default: low, all three)
#   fast    6 cores, no quota, 6 GB: the same container unthrottled, to compare with
#   low     2 cores, 0.5 CPU between them, 4 GB: an old dual-core laptop
#   potato  2 cores, 0.25 CPU, 3 GB: a Celeron-class netbook
# A core of this Mac (Apple M4) runs about 3.5x an old laptop's (Geekbench single-core); the quota gives a
# lone thread half (low) or a quarter (potato) of one, both threads together a quarter or an eighth each.
# Writes test/e2e/out/low-end/<profile>/<browser>.log, the run's own JSON report next to it, and
# <browser>.memory: the peak of the browser's processes' memory (PSS, MB), sampled every second.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
profile=${1:-low}
shift || true
browsers=("${@:-chrome opera firefox}")
read -r -a browsers <<<"${browsers[*]}"
rows=${ROWS:-40}
case $profile in
  fast) limits=(--cpuset-cpus=0-5 --memory=6g) ;;
  low) limits=(--cpuset-cpus=0,1 --cpus=0.5 --memory=4g --memory-swap=4g) ;;
  potato) limits=(--cpuset-cpus=0,1 --cpus=0.25 --memory=3g --memory-swap=3g) ;;
  *) echo "profile: fast, low or potato, not $profile" >&2; exit 2 ;;
esac
image=duel-lens-low-end
out=test/e2e/out/low-end/$profile
mkdir -p "$root/$out"
docker build -q -t $image "$root/test/e2e/low-end" >/dev/null
volumes=(-v "$root:/repo" -v duel-lens-low-end-nm:/repo/node_modules -v duel-lens-low-end-e2e-nm:/repo/test/e2e/node_modules)
# Linux node_modules, once, unthrottled.
docker run --rm "${volumes[@]}" $image sh -c '[ -f node_modules/.package-lock.json ] || npm ci --no-audit --no-fund; [ -f test/e2e/node_modules/.package-lock.json ] || (cd test/e2e && npm ci --no-audit --no-fund)'

# The browser's memory: the sum of every process's PSS but the harness's own (node, the shell), each second.
sampler='peak=0; while sleep 1; do kb=$(for p in /proc/[0-9]*; do c=$(cat $p/comm 2>/dev/null) || continue; case $c in node|sh|bash|sleep|cat|awk|esbuild) continue;; esac; awk "/^Pss:/ {print \$2}" $p/smaps_rollup 2>/dev/null; done | awk "{s+=\$1} END {print s+0}"); [ "$kb" -gt "$peak" ] && peak=$kb && echo $((peak / 1024)) > "$MEMORY_FILE"; done'
for browser in "${browsers[@]}"; do
  case $browser in
    chrome) cmd="npx tsx test/e2e/run.ts --real --click --only cards --limit $rows --compare none"; env=(-e DUEL_LENS_E2E_DIST=$out/dist-chrome -e DUEL_LENS_E2E_COLD_EVERY=10); report=real-click-results.json ;;
    opera) cmd="npx tsx test/e2e/run.ts --real --click --only cards --limit $rows --compare none"; env=(-e DUEL_LENS_E2E_TARGET=opera -e DUEL_LENS_E2E_DIST=$out/dist-opera -e DUEL_LENS_E2E_COLD_EVERY=10); report=real-click-results.json ;;
    firefox) cmd="npx tsx test/e2e/firefox.ts"; env=(-e DUEL_LENS_E2E_DIST=$out/dist-firefox); report=firefox-report.json ;;
    *) echo "browser: chrome, opera or firefox, not $browser" >&2; exit 2 ;;
  esac
  echo "== $profile / $browser"
  docker run --rm --shm-size=1g "${limits[@]}" "${volumes[@]}" "${env[@]}" -e MEMORY_FILE=/repo/$out/$browser.memory $image \
    bash -c "($sampler) & $cmd; status=\$?; kill %1; exit \$status" 2>&1 | tee "$root/$out/$browser.log" || true
  cp "$root/test/e2e/out/$report" "$root/$out/$browser.json" 2>/dev/null || true
  echo "peak memory: $(cat "$root/$out/$browser.memory" 2>/dev/null || echo '?') MB"
done
