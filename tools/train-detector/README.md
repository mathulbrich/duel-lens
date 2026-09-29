# tools/train-detector: Duel Lens's own card detector

Finds every card on a duel-stream screenshot, and the card inside a user's rough box, as an **oriented
box plus the card's 4 corners** (a keystone quad when the camera isn't overhead: hand-held close-ups,
oblique table cams), with a **face-up / face-down** class (face-down = sleeve backs, deck piles, the
official card back). It replaced an earlier prototype's third-party (AGPL) detector, using none of its
code or weights and never training on its detections: it is trained only on synthetic frames.

Report: `.superpowers/sdd/2026-09-28-duel-lens-v1/detector-report.md`.
Extension module: `src/offscreen/detector/` (`createCardDetector`, `createWebCardDetector`,
`createNodeCardDetector`). Model: `extension/models/detector/card-detector.onnx` (kept with the source:
`.gitignore` re-includes it). The extension registers it in `src/offscreen/index.ts` (A4, report
`a4-report.md`): click to scan outlines its face-up cards, one run per screenshot, and every scan
straightens the card it finds in the crop. `build.mjs` ships it in every build and stops when it is
missing (`--no-detector` builds without it); `npm run release` refuses a build without it.

## Licences

| Part | Licence |
|---|---|
| Backbone weights: timm `mobilenetv3_large_100.ra_in1k` (Hugging Face `timm/…`, ImageNet-1k) | Apache-2.0 |
| timm 1.0.30, PyTorch 2.14, torchvision 0.29 (installed, not used by the model) | Apache-2.0, BSD-3, BSD-3 |
| OpenCV (opencv-python-headless), NumPy, onnx, onnxruntime | Apache-2.0, BSD-3, Apache-2.0, MIT |
| Neck, heads, generator, training, export, decoder: this folder and `src/offscreen/detector/` | the project's own code |
| Training images: YGOPRODeck card images and artworks already in `data/` (the index's own sources), the official card back | used as before by the embedder's training (Phase 2) |

That earlier detector was run offline only to **propose** quads for some evaluation labels (the tool
that ran it has been removed); every label was checked by eye and each records its source.

## Setup (once)

```sh
data/venv-train/bin/pip install torchvision timm "torch==2.14.0"   # into the Phase 2 venv
```

## Pipeline

```sh
cd tools/train-detector
../../data/venv-train/bin/python sheet.py frames --n 6 --seed 7     # sample frames with labels drawn
../../data/venv-train/bin/python sheet.py windows --n 16 --seed 2   # training windows (incl. the drag case)
# the shipped model's chain (MPS; 16 windows of 640 px per step; see the report's §3):
../../data/venv-train/bin/python train.py --run d2 --minutes 45                                             # from ImageNet
../../data/venv-train/bin/python train.py --run d3 --init ../../data/train-detector/ckpt/d2/step001319.pt --minutes 39 --lr 8e-4 --warmup 100 --seed 3
../../data/venv-train/bin/python train.py --run d4 --init ../../data/train-detector/ckpt/d3/last.pt --minutes 66 --lr 6e-4 --warmup 50 --seed 4
../../data/venv-train/bin/python train.py --run d5 --init ../../data/train-detector/ckpt/d4/last.pt --minutes 70 --lr 6e-4 --warmup 50 --seed 5 --eval-min 10
# (the generator changed between runs: d3 added the corner head and keystone, d4 foreshortening, d5 the
#  squared-error angle/corner loss and more tilted cards; a single run on the final code should do as well)
cd ../..
tools/train-detector/final-eval.sh data/train-detector/ckpt/d5/last.pt  # export + install the fp16w model + every evaluation below
(cd tools/train-detector && ../../data/venv-train/bin/python tables.py)  # the report's tables from the JSON outputs
npx tsx tools/train-detector/evaluate.ts                            # real frames, real set, negatives; outlined PNGs
npx tsx tools/train-detector/evaluate.ts --path tiles --no-png      # the same through tools/lib/tiled-detector.ts's tiled search
npx tsx tools/train-detector/eval-straighten.ts                     # recogniser after straightening from the 4 corners
npx tsx tools/train-detector/parity-wasm.ts                         # onnxruntime-web WASM vs node
npx tsx tools/train-detector/bench-speed.ts --runtime wasm --threads 4
npx vitest run src/offscreen/detector/                              # unit tests + the data-gated integration test
```

- `scene.py`: the generator. One broadcast frame per call at the working scale (1280 px wide): a mat
  in one of five looks (YCS-like glowing zones, WC-like printed grid on blue/red halves, WCQ-like gold
  mat with printed artwork in ornate zones, random/art/patterned playmats, zoomed-in close-ups); cards
  in zones and loose (face-up: YGOPRODeck card images or frame templates with any artwork, holo,
  sleeves; face-down: plain/emblem/pattern/holo/tournament-logo sleeves, full-bleed art sleeves, the
  card back); piles, XYZ stacks, cards on piles, fanned hands (ignored); arms and hands; the broadcast
  (cams, bars, logos, art-only panels, the featured-card panel: a card, the card back, or empty);
  hard negatives (empty zones with labels and tints, mat art, mat logos, empty card-shaped panels);
  then a tilted camera for 30% of frames (75% of close-ups): a random homography (keystone up to a far
  edge ~2x narrower, yaw, roll) maps the overhead scene and every label quad; then the camera/codec
  chain (blur, colour casts, washout, gamma, sharpening, noise, resolution loss, 4:2:0 JPEG blocking at
  the source scale). Labels: amodal quads (4 corners in the card's own order) plus the fitted oriented
  box; less than half visible = ignore. Training windows: 640 px crops, or the drag case (a loose box
  around one card, resized).
- `targets.py`: CenterNet targets (oriented Gaussian peaks per class, per-object normalised regression
  of offset, log size, sin/cos 2θ, and the 4 corners as residuals from the box's corners in the box
  frame, θ taken in (−45°, 135°] so the corner order never flips at 0° or 90°) and the Python decoder
  (the TS decoder, `src/offscreen/detector/decode.ts`, mirrors it).
- `model.py`: MobileNetV3-Large features at strides 4–32, an FPN-lite neck, stride-4 heads (heat;
  offset; size and angle; corners).
- `train.py` / `quick_eval.py`: training with a periodic check on the 7 labelled real frames (click-D's
  axis-aligned truth, a proxy) and held-out synthetic frames.
- `export.py`: ONNX (opset 17, dynamic H/W); `fp16w` stores weights as float16 and casts them back
  (onnxruntime folds the casts at load: fp32 compute); parity against PyTorch on the real frames.
- Evaluation labels: `label_fullview.py propose|build` (GrabCut proposals; the labels on record also
  hold some the earlier detector proposed, see its docstring), `zoom.py` (read corners off a gridded
  zoom), `fullview-fixes.json` (typed-in corrections) → `data/train-detector/eval/fullview-quads.json`.
- `arch_bench.py`, `bench-wasm.mjs`: the backbone speed comparison in onnxruntime-web.
- `draw-picks.ts`: the detector's outlines on one frame or one user-box crop (debugging).
- `src/offscreen/detector/refine.ts` (used by the extension module): the classical outline fit (tilt from the
  gradient orientations, then each side), which the drag path applies by default; the network's own angle
  is coarse on real cards.

Outputs live in `data/train-detector/` (gitignored): `ckpt/`, `logs/`, `sheets/`, `onnx/`, `eval/`.

## Rebuilding the model

The `.onnx` (6.2 MB) is kept with the source, unlike the other models. To rebuild: run the pipeline
above (about 2.5 h of MPS training), or re-export a kept checkpoint with `export.py`, then copy the
`fp16w` file to `extension/models/detector/card-detector.onnx`. The shipped file's SHA-256 is in
[`docs/DEVELOPMENT.md`](../../docs/DEVELOPMENT.md) ("Models"). A new model means new numbers: re-run `tools/eval-real.ts` (the engine,
120 cards and 70 negatives), `tools/train-detector/evaluate.ts` and the end-to-end tests.
