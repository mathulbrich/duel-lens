// Registry of image-embedding models. The same spec drives the Node index build
// (tools/build-index.ts) and the in-browser engine (src/offscreen), so both
// produce vectors in the same space. Owner: data & index stream (tools/).

export interface EmbeddingModelSpec {
  id: string;
  label: string;
  /** File under extension/models/ (bundled; never loaded from a CDN at runtime). */
  file: string;
  /** Where the ONNX file comes from (download URL), for tools/fetch-models.ts. */
  sourceUrl: string;
  license: string;
  /** Square input size in pixels. */
  inputSize: number;
  /** Per-channel RGB mean/std applied after scaling pixels to [0, 1]. */
  mean: [number, number, number];
  std: [number, number, number];
  inputName: string;
  outputName: string;
  /**
   * How to reduce the output tensor to one vector:
   * 'none' = output is already [batch, dim]; 'cls' = take token 0 of [batch, tokens, dim];
   * 'mean' = average over tokens of [batch, tokens, dim].
   */
  pooling: 'none' | 'cls' | 'mean';
  dim: number;
  /**
   * Largest batch to run at once. Default 16. Use 1 if the batch axis is fixed, or if batching
   * changes the vectors (dynamically quantised int8 graphs), so index and queries match.
   */
  maxBatch?: number;
  /**
   * Decision thresholds on cosine scores, calibrated by tools/benchmark.ts.
   * score: minimum top score for a confident match; margin: minimum gap to the next card;
   * floor: below this the result is "no card found".
   * second (optional): another way to be confident, a lower score with a large lead over the
   * next card (a clear lead is strong evidence on footage). cardBackMargin (optional): the lead the
   * card back needs to be a confident "face-down card".
   */
  thresholds: {
    score: number;
    margin: number;
    floor: number;
    second?: { score: number; margin: number };
    cardBackMargin?: number;
  };
  /**
   * The suggestions' floor for this model (src/offscreen/engine.ts SUGGEST.floor, which was calibrated on
   * dinov2-small-duel), when its scores sit elsewhere: calibrated like `thresholds`, through the engine on real
   * footage (tools/eval-real.ts --suggest-floor). Optional: SUGGEST.floor otherwise.
   */
  suggestFloor?: number;
}

export const MODELS: Record<string, EmbeddingModelSpec> = {
  'dinov2-small': {
    id: 'dinov2-small',
    label: 'DINOv2 small (int8)',
    file: 'dinov2-small.int8.onnx',
    sourceUrl: 'https://huggingface.co/Xenova/dinov2-small/resolve/main/onnx/model_quantized.onnx',
    license: 'Apache-2.0',
    inputSize: 224,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    inputName: 'pixel_values',
    outputName: 'last_hidden_state',
    pooling: 'cls',
    dim: 384,
    // int8 with dynamic activation quantisation: scales are computed per batch, so a batch
    // changes every vector (cosine to the lone vector down to 0.989 in a batch of 8).
    maxBatch: 1,
    // Calibrated by tools/benchmark.ts (2026-09-28, n=1000, seed 1): 97.0% precise, 77.8% confident on 'video'.
    thresholds: { score: 0.6343, margin: 0.0175, floor: 0.617 },
  },
  'dinov2-small-q4': {
    id: 'dinov2-small-q4',
    label: 'DINOv2 small (4-bit weights)',
    // MatMulNBits: 4-bit block-quantised weights with float32 activations, so unlike the int8
    // file a batch does not change the vectors.
    file: 'dinov2-small.q4.onnx',
    sourceUrl: 'https://huggingface.co/Xenova/dinov2-small/resolve/main/onnx/model_q4.onnx',
    license: 'Apache-2.0',
    inputSize: 224,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    inputName: 'pixel_values',
    outputName: 'last_hidden_state',
    pooling: 'cls',
    dim: 384,
    // Calibrated by tools/benchmark.ts (2026-09-28, n=1000, seed 1): 97.2% precise, 71.4% confident on 'video'.
    thresholds: { score: 0.6514, margin: 0.0225, floor: 0.651 },
  },
  'dinov3-small': {
    id: 'dinov3-small',
    label: 'DINOv3 ViT-S/16 (int8)',
    // model_quantized.onnx with its .onnx_data weights inlined by tools/prepare-model.py.
    file: 'dinov3-small.int8.onnx',
    sourceUrl:
      'https://huggingface.co/onnx-community/dinov3-vits16-pretrain-lvd1689m-ONNX/resolve/main/onnx/model_quantized.onnx',
    license: 'DINOv3 License (Meta, custom): https://ai.meta.com/resources/models-and-libraries/dinov3-license',
    inputSize: 224,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    inputName: 'pixel_values',
    // pooler_output is the final-layer-norm CLS token, [batch, 384].
    outputName: 'pooler_output',
    pooling: 'none',
    dim: 384,
    // int8 with dynamic activation quantisation: scales are computed per batch, so a batch
    // changes every vector (cosine to the lone vector down to 0.970 in a batch of 8).
    maxBatch: 1,
    // Calibrated by tools/benchmark.ts (2026-09-28, n=1000, seed 1): 97.1% precise, 78.0% confident on 'video'.
    thresholds: { score: 0.6354, margin: 0.0175, floor: 0.611 },
  },
  'dinov3-small-q4': {
    id: 'dinov3-small-q4',
    label: 'DINOv3 ViT-S/16 (4-bit weights)',
    // model_q4.onnx (MatMulNBits: 4-bit weights, float32 activations, so batching is safe) with
    // its .onnx_data weights inlined by tools/prepare-model.py.
    file: 'dinov3-small.q4.onnx',
    sourceUrl:
      'https://huggingface.co/onnx-community/dinov3-vits16-pretrain-lvd1689m-ONNX/resolve/main/onnx/model_q4.onnx',
    license: 'DINOv3 License (Meta, custom): https://ai.meta.com/resources/models-and-libraries/dinov3-license',
    inputSize: 224,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    inputName: 'pixel_values',
    outputName: 'pooler_output',
    pooling: 'none',
    dim: 384,
    // Calibrated by tools/benchmark.ts (2026-09-28, n=1000, seed 1): 97.1% precise, 93.6% confident on 'video'.
    // Floor lowered from the calibrated 0.599 to 0.50 (lead ruling): blank crops top out at 0.444
    // (noise), and 0.50–0.5997 becomes a "Not sure" band that shows alternatives instead of
    // "nothing found", which matters most on low-bitrate video.
    thresholds: { score: 0.5997, margin: 0.0075, floor: 0.5 },
  },
  'dinov2-small-duel': {
    id: 'dinov2-small-duel',
    label: 'Duel Lens DINOv2 small, fine-tuned for duel video (8-bit weights)',
    // facebook/dinov2-small fine-tuned by tools/train (open-set metric learning: synthetic duel-video
    // renderings of each artwork are pulled onto its clean embedding; cards released in 2026 and a
    // random 5% of older ones never seen). The graph standardises each input channel per image
    // (invariance to washout and colour casts) and outputs the final-norm CLS token. MatMulNBits
    // 8-bit weights with float32 activations, so batching is safe. Built locally, not downloaded:
    // see tools/train/README.md.
    file: 'dinov2-small-duel.q8.onnx',
    sourceUrl: 'local: built by tools/train (see tools/train/README.md), no download',
    license: 'Apache-2.0 (fine-tuned from facebook/dinov2-small)',
    inputSize: 224,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    inputName: 'pixel_values',
    outputName: 'embedding',
    pooling: 'none',
    dim: 384,
    // Calibrated on real footage (2026-09-28). tools/eval-real.ts --raw recorded the embedding
    // matcher's candidates before any threshold, through the engine on both of its paths at the time
    // (a detector's box, and the user's box alone), for the 57 cards of data/realset/set.json (3 productions) and the 37 non-card
    // boxes of negatives.json (piles, sleeves, mat art). decide() and the two-stage rotation were
    // replayed at each threshold, also on tools/train/eval-synth.ts's sample (900 per level, seed 1).
    // The model's top-1 is right on all 57 cards (0.745-0.972, median 0.89). Non-cards reach 0.736
    // (a WCS logo sleeve; mean 0.666, sd 0.057). Upside-down cards read at most 0.698 on stage 1.
    // Rule: no real confident-wrong on either path, synthetic video-lowres >= 97% precise, then:
    //   score 0.80: 0.064 (2.3 sd) above the highest non-card. The rule alone allows 0.74, only
    //     0.004 above it, and a confident wrong answer is the worst outcome.
    //   margin 0.02: artwork shared by two cards (gap <= 0.008) is "not sure", not a coin toss.
    //     Right real answers lead by >= 0.052; half the non-cards by < 0.022.
    //   floor 0.74: every non-card below it (by 0.0035), every right real answer above it (lowest
    //     0.7446). The gap is 0.008 wide: nothing clears both by more; score guards the non-cards.
    // Real: alone 54 sure, 3 not sure (0.745-0.774, right), 0 wrong, 0 nothing; through the engine
    // (with the former third-party classifier and its art check) 57/57, 54 confident, 0 confident wrong; negatives.json 0/37
    // confident. Synthetic video-lowres 100% precise, 99.1% confident; web 99.9%, 98.9%.
    // Was { 0.8273, 0, 0.77 } (first 29 cards). tools/benchmark.ts --apply/--write must not
    // overwrite these: its 'video' calibration is saturated (0.8716 / 0 / 0.871).
    // second / cardBackMargin (lead ruling, 2026-09-29): tuned on real footage from 9 productions
    // (data/realset, 57 cards + 37 non-card boxes; data/realset/staging-C, 63 cards incl. 28 tilted,
    // 19 oblique, 15 foil + 33 non-card boxes), replaying the engine's decisions on eval-real --raw.
    // Against score/margin alone: +9 confident answers, all right; 0 confident wrong on 120 cards;
    // confident non-card boxes 1 → 0 (an empty mat zone that read as the card back, lead 0.056).
    thresholds: { score: 0.8, margin: 0.02, floor: 0.74, second: { score: 0.73, margin: 0.1 }, cardBackMargin: 0.1 },
  },
  'dinov2-small-duel-foil': {
    id: 'dinov2-small-duel-foil',
    label: 'Duel Lens DINOv2 small, fine-tuned for duel video and full-card foils (8-bit weights)',
    // dinov2-small-duel fine-tuned further by tools/train (run r3-foil: train.py --init r2/best.pt --fullfoil 0.2
    // --select foil) with full-card foil prints in the mix (Starlight, Collector's, Quarter Century Secret Rare:
    // synth.py _fullfoil), so a foil whose artwork reads grey-olive or rainbow-shifted still lands on its clean
    // embedding (.superpowers/sdd/2026-09-28-duel-lens-v1/foil-report.md). Same graph, interface and size as
    // dinov2-small-duel; its own index. Built locally, not downloaded: see tools/train/README.md.
    file: 'dinov2-small-duel-foil.q8.onnx',
    sourceUrl: 'local: built by tools/train (see tools/train/README.md), no download',
    license: 'Apache-2.0 (fine-tuned from facebook/dinov2-small)',
    inputSize: 224,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    inputName: 'pixel_values',
    outputName: 'embedding',
    pooling: 'none',
    dim: 384,
    // Calibrated on real footage (2026-09-29) the way dinov2-small-duel's were: tools/eval-real.ts --raw through the
    // engine (our card detector) on data/realset (120 cards, 9 productions) and negatives.json (70 non-card boxes),
    // decide() and the two-stage rotation replayed at each threshold (foil-report.md, section 5).
    // Right real answers read 0.754-0.966 (median 0.914) and all lead the next card by >= 0.139; non-card boxes reach
    // 0.795 (a white-ring sleeve, lead 0.013) and 0.780 (a purple emblem sleeve, lead 0.078), the rest <= 0.731.
    // No floor separates them (the old rule), so:
    //   floor 0.74: every right real answer above it (lowest 0.754); the two sleeves above it are "not sure".
    //   score 0.85: 0.055 above the highest non-card (0.80 would leave 0.005).
    //   margin 0.02: artwork shared by two cards stays "not sure".
    //   second { 0.74, 0.12 }: confident on a clear lead; right answers lead by >= 0.139, non-cards by <= 0.078.
    // Real: 116/120 right, 116 confident, 0 confident wrong; negatives 0 confident, 2 not sure, 68 nothing.
    // NOT the default: it failed the adoption gate (2026-09-29). Pendulum cards regressed: the E2E board's
    // Odd-Eyes Pendulum Dragon reads 0.734 (dinov2-small-duel 0.779), "Couldn't match this" (E2E 7/8), and 60
    // clean pendulum card images give 50 confident answers against 58. Kept for the foil experiment's record.
    thresholds: { score: 0.85, margin: 0.02, floor: 0.74, second: { score: 0.74, margin: 0.12 }, cardBackMargin: 0.1 },
  },
  'dinov2-small-duel-v3b': {
    id: 'dinov2-small-duel-v3b',
    label: 'Duel Lens DINOv2 small, fine-tuned on real card crops from duel videos, pendulum-anchored (8-bit weights)',
    // dinov2-small-duel-v3's run continued (tools/train: run r6-real-b epoch 1, from the average of r6-real epochs 8-11,
    // on the overnight real card crops rebuilt at 04:42 with the QC's final rules: 14,319 tracks of 1,585 cards), r2 a
    // frozen teacher with the pendulum anchors' distillation x6 and pendulum artworks 3x an epoch
    // (.superpowers/sdd/2026-09-28-duel-lens-v1/overnight-p5-report.md). Same graph, interface and size as
    // dinov2-small-duel; its own index. Built locally, not downloaded: see tools/train/README.md.
    // The default since 2026-09-30: it passed the adoption gate (overnight-plan.md; DEFAULT_MODEL_ID below).
    // Calibrated as dinov2-small-duel-v3 was (eval-real --raw on data/realset and data/realset2, decide() and the two
    // stages replayed): at floor 0.74 no gate adds a confident card on both sets; a lower floor adds realset2 non-cards
    // (0.735: +1, 0.72: +5). So today's gate: realset 116 confident, 0 wrong, 0/70; realset2 364 confident, 0 wrong,
    // 9/127 non-cards confident (today's model: 346, 0, 16). The suggestions' 0.68 floor (SUGGEST) holds for it too:
    // Dominus Impulse reads 0.701, every lower floor adds a wrong list on realset2, and no non-card box gets a list.
    file: 'dinov2-small-duel-v3b.q8.onnx',
    sourceUrl: 'local: built by tools/train (see tools/train/README.md), no download',
    license: 'Apache-2.0 (fine-tuned from facebook/dinov2-small)',
    inputSize: 224,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    inputName: 'pixel_values',
    outputName: 'embedding',
    pooling: 'none',
    dim: 384,
    thresholds: { score: 0.8, margin: 0.02, floor: 0.74, second: { score: 0.73, margin: 0.1 }, cardBackMargin: 0.1 },
  },
  'mobileclip-s0': {
    id: 'mobileclip-s0',
    label: 'MobileCLIP-S0 image encoder (fp16 weights)',
    // vision_model.onnx with its weights stored as float16 by tools/prepare-model.py; it computes
    // in float32. Not Xenova's int8 file: its dynamic quantisation breaks retrieval (13 of 40
    // mildly degraded artworks found among 2,000, against 40 of 40 with float weights).
    file: 'mobileclip-s0-vision.f16w.onnx',
    sourceUrl: 'https://huggingface.co/Xenova/mobileclip_s0/resolve/main/onnx/vision_model.onnx',
    license: 'apple-amlr (Apple ML Research Model license, research use; weights from apple/MobileCLIP-S0)',
    inputSize: 256,
    // preprocessor_config.json: rescale to [0, 1], no mean/std normalisation.
    mean: [0, 0, 0],
    std: [1, 1, 1],
    inputName: 'pixel_values',
    outputName: 'image_embeds',
    pooling: 'none',
    dim: 512,
    // Calibrated by tools/benchmark.ts (2026-09-28, n=1000, seed 1): 97.1% precise, 76.0% confident on 'video'.
    thresholds: { score: 0.7132, margin: 0.015, floor: 0.698 },
  },
  'mobilenetv3-large': {
    id: 'mobilenetv3-large',
    label: 'MobileNetV3-Large 1.0 (ImageNet-21k MIIL, fp32)',
    // timm classifier with the final Gemm removed by tools/prepare-model.py (pre-logits features).
    file: 'mobilenetv3-large-100-miil.onnx',
    sourceUrl:
      'https://huggingface.co/onnx-community/mobilenetv3_large_100.miil_in21k_ft_in1k/resolve/main/onnx/model.onnx',
    license: 'Apache-2.0',
    inputSize: 224,
    // MIIL weights: rescale to [0, 1], no mean/std normalisation.
    mean: [0, 0, 0],
    std: [1, 1, 1],
    inputName: 'pixel_values',
    outputName: 'features',
    pooling: 'none',
    dim: 1280,
    // Calibrated by tools/benchmark.ts (2026-09-28, n=1000, seed 1): 97.1% precise, 49.0% confident on 'video'.
    thresholds: { score: 0.5369, margin: 0.04, floor: 0.536 },
  },
};

/**
 * The model the extension uses (build.mjs ships only this model and its index): dinov2-small-duel-v3b,
 * our own fine-tune (tools/train), since 2026-09-30. It is dinov2-small-duel (the default before it) further
 * fine-tuned on real card crops from public tournament videos, and it passed the adoption gate
 * (.superpowers/sdd/2026-09-28-duel-lens-v1/overnight-plan.md, overnight-p6-T1/T2/T3.md) against that model on the same engine:
 * - the real test set (120 cards, 70 non-card boxes; tools/eval-real.ts): 117 right, 116 confident, 0 confident wrong,
 *   0/70 confident, against 117/115/0 and 0/70; by click 117/115/0 against 117/112/0;
 * - realset2 (399 cards and 127 non-card boxes from held-out videos): 377 right, 364 confident, 0 confident wrong,
 *   9/127 non-cards confident, against 373/346/0 and 16/127;
 * - the E2E board 8/8 by drag and click; 59/60 clean pendulum cards confident (58 before).
 * dinov2-small-duel stays registered (the previous default). Both are 25.7 MB, built locally, not downloaded: see
 * docs/DEVELOPMENT.md, "Models".
 */
export const DEFAULT_MODEL_ID = 'dinov2-small-duel-v3b';

export function getModel(id: string = DEFAULT_MODEL_ID): EmbeddingModelSpec {
  const m = MODELS[id];
  if (!m) throw new Error(`Unknown embedding model "${id}"`);
  return m;
}
