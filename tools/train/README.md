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

## The combined retrain (runs r4-combined and r5-v2a/b, `dinov2-small-duel-v2`, not adopted)

Fine-tunes of r2 for four print and scene effects at once, with r2 kept as the anchor. Report (the gate, the user's
cards frame by frame, what the next attempt should change): `.superpowers/sdd/2026-09-28-duel-lens-v1/combined-retrain-report.md`.

- **Effects** (`synth.py`, `render(..., mix=MIX)`; each with its own chance per view, the rest of the chain unchanged):
  full-card foils (`_fullfoil`, 10%), **overframe** prints (`_overframe`, 10%: the artwork zoomed 1.05-1.95x over the
  whole card, the see-through text box, a gold name, sometimes stars and the icon; foiled on 60%), **occluders**
  (`_occlude`, 15%: shaded fingers or a hand, another card or sleeve, dice and counters over 15-50% of the card) and
  simulator **count badges** (`_badge`, 8%: a white bold 1-2 digit number with a dark outline at the card's centre).
  `mix=None` (the default) draws nothing, so r1/r2/r3 renderings and every fixed set are unchanged. The negatives gain
  ring, ringed-emblem, starburst and logo-band sleeve designs (`_sleeve_design`, a third of the sleeves).
- **v2** (`MIX_V2`, `--mix combined-v2`, or a JSON mix with `"v2": 1`), after the real crops of the user's cards: the
  foil's metal is often a vivid hue and more often darker than the white ink, with contrast kept (`_fullfoil(v2=True)`);
  overframes are read from the user's box, as the engine reads them (the detector takes them for face-down cards),
  60% of the time and 1.0-1.45x loose; `pendfoil` scales the foil's chance on pendulum cards. v1 renderings are unchanged.
- **Anti-regression:** r2 is a frozen teacher. Views that got none of the four effects are held to r2's embedding of the
  same view (`--kd-view`, 1 - cosine), and every anchor's clean artwork to r2's clean embedding (`--kd-clean`), so the
  index geometry stays r2's (foil-report.md). Pendulum artworks are anchors twice per epoch (`--pend-x 2`), and
  `--kd-pend-x` weighs their distillation terms more. A continuation (`--init` another run's checkpoint) names the
  teacher (`--teacher r2/best.pt`) and holds the guards to r2's own numbers (`--guard-ref r4-combined.jsonl`: its epoch 0).
- **Selection** (`--select combined`): unseen video + hard + foil + overframe + occluder + badge top-1, only among
  epochs whose clean guards hold against epoch 0 (or `--guard-ref`): pendulum, link and E2E-board card images cut as the
  engine cuts them (`val/guard.npz`: top-1, r2-threshold "sure" count and mean score), web top-1 >= 99%, the real crops'
  top-1. The checkpoint was then chosen by screening every epoch on real footage (`screen.py`, below).

```sh
../../data/venv-train/bin/python sheet.py combined               # real overframe, badge and covered crops vs the effects (tune by eye)
../../data/venv-train/bin/python evalsuite.py build-combined     # val/combined.npz: fixed overframe/occluder/badge renderings
../../data/venv-train/bin/python evalsuite.py build-guard        # val/guard.npz: clean pendulum, link and E2E-board cards
../../data/venv-train/bin/python train.py --run r4-combined --init ../../data/train/ckpt/r2/best.pt --mix combined \
    --kd-view 8 --kd-clean 8 --pend-x 2 --select combined --minutes 90 --lr 2e-5 --warmup 100 --seed 4
../../data/venv-train/bin/python train.py --run r5-v2a --init ../../data/train/ckpt/r4-combined/epoch05.pt \
    --teacher ../../data/train/ckpt/r2/best.pt --guard-ref ../../data/train/logs/r4-combined.jsonl --mix combined-v2 \
    --kd-view 8 --kd-clean 8 --pend-x 2 --select combined --minutes 40 --lr 1.5e-5 --warmup 60 --seed 5
../../data/venv-train/bin/python train.py --run r5-v2b --init ../../data/train/ckpt/r5-v2a/epoch05.pt \
    --teacher ../../data/train/ckpt/r2/best.pt --guard-ref ../../data/train/logs/r4-combined.jsonl \
    --mix '{"fullfoil": 0.3, "overframe": 0.15, "occl": 0.08, "badge": 0.05, "v2": 1, "pendfoil": 0.0}' \
    --kd-view 8 --kd-clean 8 --kd-pend-x 3 --pend-x 2 --select combined --minutes 42 --lr 1.2e-5 --warmup 40 --seed 6
# screen every checkpoint on real footage through the current engine's own readings, before exporting
# (dump each row set once, about 3 minutes in all: targets, realset, foil-others, webcards, guard)
cd ../.. && npx tsx tools/train/dump-scans.ts --set data/train/combined/targets.json --modes drag,click --out /tmp/scans-targets
cd tools/train && ../../data/venv-train/bin/python screen.py --out screen.json --hyps /tmp/scans-targets,... ../../data/train/ckpt/r5-v2b/epoch*.pt
../../data/venv-train/bin/python screen.py --report screen.json
cd ../..
# export, index, gate
cd tools/train && ../../data/venv-train/bin/python export.py export --ckpt <ckpt> --name dinov2-small-duel-v2 && cd ../..
npx tsx tools/build-index.ts --model dinov2-small-duel-v2
npx tsx tools/train/eval-gate.ts --models dinov2-small-duel,dinov2-small-duel-v2 --set <rows.json> --modes drag,click
```

`eval-gate.ts` runs any set of rows (a frame, a box, the card or `null`) through the engine by drag and by click (the
whole-frame detector's outline under the box's centre, handed to the engine as a click does), for several models. The
row sets are in `data/train/combined/` (local): the user's cards (`targets.json`), the real set with its negatives
(`realset.json`), the other real foils, 661 clean board-size cards (`guard.json`, pendulum, link, other, the E2E
board's) and the foil report's 60 + 60 (`webcards.json`).
