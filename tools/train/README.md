# tools/train: fine-tuning Duel Lens's artwork embedder for real duel video

Fine-tunes `facebook/dinov2-small` (Apache-2.0) into `dinov2-small-duel`, an open-set embedder:
a degraded, misframed, colour-cast rendering of an artwork must land next to that artwork's
clean embedding, computed by the same network. The index design is unchanged (one int8 vector
per artwork, built by `tools/build-index.ts`), so a new card only needs its vector.

Report: `.superpowers/sdd/2026-09-28-duel-lens-v1/phase2-finetune-report.md`.

## Setup (once)

```sh
python3.13 -m venv data/venv-train
data/venv-train/bin/pip install torch transformers safetensors huggingface_hub onnx onnxruntime \
    onnxscript pillow numpy opencv-python-headless
cd tools/train
../../data/venv-train/bin/python prepare.py all     # art cache (2.2 GB), held-out split, frame templates, real crops
../../data/venv-train/bin/python evalsuite.py build  # fixed synthetic + web query sets, per seen/unseen group
```

- `prepare.py cache`: every index artwork resized to 224 px (Pillow bilinear = the extension's
  resize), in `tools/build-index.ts` order, as `data/train/cache/art224.npy`.
- `prepare.py split`: unseen cards = every card first released on or after 2026-01-01
  (`misc_info` tcg/ocg dates in `data/raw/cardinfo.json`: 538 cards, including the real set's
  Sacred Beasts, Hyperinvoked Aeon, Aiwass, Sorath and Fairy Tail Ball) plus a seeded random 5%
  of older cards (696). They are never trained on, not even as negatives, but they are in the
  index, as the product's will be. `data/train/split.json` has the group of every card.
- `prepare.py templates`: full-card images (YGOPRODeck `cards_small`) of seen cards by frame type
  (227 after the split), whose frames surround the pasted artwork.
- `prepare.py real`: real test crops from the labelled rotated boxes (`data/realset/set.json`'s, whose
  provenance `tools/realset/README.md` records, plus the teacher's boxes on the screenshot and mat-zoom
  captures, `common.py`'s `TEACHER_OUT`): the card straightened like the engine's `warpQuad`, its
  ART_BOX (inset 0 and 5%) at 0/180 degrees, and the plain box's `whole` hypothesis.

HF weights are cached in `data/train/hf/`.

## Generator (`synth.py`)

Seeded, on the fly, numpy + OpenCV (about 10 ms per view). See the module docstring for the whole
chain (card template, foil, sleeve, glare, mat scene 2x supersampled, camera/ISP/codec, detector-like
quad errors, the engine's 448 px ART_BOX cut). Levels `mild`/`video`/`hard`, mixed 18/57/25% in
training (r1 used 12/63/25%). `negative_canvas()` renders sleeve backs, deck piles and empty mat
zones.

```sh
../../data/venv-train/bin/python sheet.py calib    # real crops next to renderings of the same artworks
../../data/venv-train/bin/python sheet.py levels   # random artworks at each level
```

## Train

```sh
../../data/venv-train/bin/python train.py --bench              # throughput and memory
../../data/venv-train/bin/python train.py --run r2 --minutes 100   # the shipped model (epoch 14)
```

Loss: InfoNCE of each degraded view against its artwork's clean embedding (in-batch, with
gradient) plus a memory bank of every other training artwork's clean embedding (tau 0.05;
same-card and near-duplicate artworks masked), and a squared hinge keeping negatives' top-5
similarity under 0.3. Blocks 4-11 and the final norm train (layer-wise LR decay 0.85, top LR
3e-5, AdamW, warmup then cosine over the time budget), bf16 autocast on MPS, batch 64 anchors x
(1 clean + 2 degraded) + 4x2 negatives. Every epoch: full bank refresh, evaluation
(`evalsuite.py`), checkpoint `data/train/ckpt/<run>/epochNN.pt` and `best.pt`: early stopping on
the UNSEEN split (synthetic video + hard top-1 of unseen cards, with web top-1 >= 99% on seen and
unseen). Log: `data/train/logs/<run>.jsonl` and `<run>.log`; `curve.py <run>` prints the curve.
Only `r2/best.pt`, `r2/epoch16.pt` and `r1/best.pt` were kept.

## Export, index, evaluate

```sh
../../data/venv-train/bin/python export.py export --ckpt ../../data/train/ckpt/r2/best.pt
../../data/venv-train/bin/python export.py check --ckpt ../../data/train/ckpt/r2/best.pt --full 0  # parity, batch dependence
cp ../../data/train/onnx/dinov2-small-duel.q8.onnx ../../extension/models/   # 8-bit MatMulNBits, the file named in MODELS
cd ../.. && npx tsx tools/build-index.ts --model dinov2-small-duel
npx tsx tools/train/eval-gt.ts --models dinov2-small-duel,dinov3-small-q4,dinov2-small  # real set, labelled boxes, seen/unseen
npx tsx tools/eval-real.ts --recognizer engine --model dinov2-small-duel                 # real set, engine path
npx tsx tools/train/eval-synth.ts --models dinov2-small-duel,dinov3-small-q4 --n 300       # seen/unseen on degrade.ts levels
npx tsx tools/train/eval-neg.ts --models dinov2-small-duel,dinov3-small-q4                 # deck piles, sleeves, empty zones
npx tsx tools/train/check-web.ts extension/models/dinov2-small-duel.q8.onnx 4              # onnxruntime-web WASM parity/latency
npx tsx tools/benchmark.ts --models dinov2-small-duel,dinov3-small-q4 --web --out data/train/logs/bench-final.json
```

Do not pass `--write` to the benchmark: it would also rewrite `DEFAULT_MODEL_ID` and every other
model's thresholds. The benchmark's own calibration level (`video`) is saturated for this model, so
its thresholds come from `eval-synth.ts`'s `video-lowres` calibration with the floor checked
against real frames (`eval-neg.ts`); see the comment in `src/shared/models.ts`.

## Full-card foils (run r3-foil, `dinov2-small-duel-foil`)

Starlight, Collector's and Quarter Century Secret Rare prints turn an artwork's colours to reflective grey,
olive or rainbow metal (a pastel background reads grey-olive, a yellow one pink). `synth.py _fullfoil` renders
that: the ink's transmittance (mostly desaturated, sometimes hue-turned) times a metal tint that varies across
the card, a faint rainbow, prismatic lines or grain, sparkles, a sheen; near-white opaque ink and part of the
frame's colour survive. `render(..., fullfoil=p)` uses it instead of the light foil with chance `p` (0 by
default, so r1/r2 renderings are unchanged). Report: `.superpowers/sdd/2026-09-28-duel-lens-v1/foil-report.md`.

```sh
../../data/venv-train/bin/python sheet.py foil              # real foil crops next to _fullfoil renderings (tune by eye)
../../data/venv-train/bin/python evalsuite.py build-foil    # val/foil.npz: the per-epoch foil check (fixed renderings)
../../data/venv-train/bin/python foil_set.py                # data/train/foil/synth: the synthetic foil TEST set (other unseen cards)
../../data/venv-train/bin/python train.py --run r3-foil --init ../../data/train/ckpt/r2/best.pt \
    --fullfoil 0.2 --select foil --minutes 65 --lr 2e-5 --warmup 100 --seed 3   # fine-tune of r2 (r2 untouched)
cd ../.. && npx tsx tools/train/foil-capture.ts --video <id> --groups "t0:t1,..."   # frames for the real foil set
npx tsx tools/train/eval-foil.ts --models dinov2-small-duel,dinov2-small-duel-foil  # real foil set (engine) + synthetic set
npx tsx tools/train/dump-hyps.ts && data/venv-train/bin/python tools/train/foil_torch.py <ckpt>...  # checkpoints on the real foil set, before export
```

`--select foil` adds the unseen foil top-1 to the early-stopping score. The real foil set's labels are in
`data/train/foil/real.json` (frames in `data/debug/t21820/` and `data/train/foil/frames/`).
