#!/usr/bin/env bash
# The whole evaluation of a trained checkpoint, as reported in detector-report.md:
#   tools/train-detector/final-eval.sh data/train-detector/ckpt/d5/last.pt
# Exports and installs the model, then runs (in parallel batches) the real-frame evaluation (whole frame,
# refined outlines, tiles, fp32 vs fp16 weights), the straightening evaluation, WASM
# parity, and the unit + data-gated tests; logs in data/train-detector/eval/final-*.txt. Speed is
# measured separately (bench-speed.ts), when the machine is quiet.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CKPT="${1:?checkpoint}"
E="$ROOT/data/train-detector/eval"
cd "$ROOT/tools/train-detector"
../../data/venv-train/bin/python export.py --ckpt "$ROOT/$CKPT" --name card-detector > "$E/final-export.txt" 2>&1
cp "$ROOT/data/train-detector/onnx/card-detector.fp16w.onnx" "$ROOT/extension/models/detector/card-detector.onnx"
cd "$ROOT"
run() { nice -n 5 npx tsx "$@"; }
run tools/train-detector/evaluate.ts --threads 3 --out "$E/results.json" --png-dir "$E/out" > "$E/final-results.txt" 2>&1 &
run tools/train-detector/evaluate.ts --threads 3 --refine --out "$E/results-refined.json" --png-dir "$E/out-refined" > "$E/final-results-refined.txt" 2>&1 &
run tools/train-detector/eval-straighten.ts --threads 3 --out "$E/straighten.json" > "$E/final-straighten.txt" 2>&1 &
wait
run tools/train-detector/evaluate.ts --threads 3 --path tiles --no-png --out "$E/results-tiles.json" > "$E/final-results-tiles.txt" 2>&1 &
run tools/train-detector/evaluate.ts --threads 3 --model data/train-detector/onnx/card-detector.fp32.onnx --no-png --out "$E/results-fp32.json" > "$E/final-results-fp32.txt" 2>&1 &
run tools/train-detector/parity-wasm.ts --threads 4 > "$E/final-parity-wasm.txt" 2>&1 &
wait
nice -n 5 npx vitest run src/offscreen/detector/ > "$E/final-vitest.txt" 2>&1 || true
echo "final evaluation done: $E/final-*.txt"
