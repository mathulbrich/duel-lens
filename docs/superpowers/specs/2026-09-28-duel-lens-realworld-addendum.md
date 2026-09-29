# Duel Lens: real-world recognition addendum

> **Historical record (2026-09-28).** This is the design as it was planned that day. Parts are superseded: the
> third-party DRAW2 detector it mentions was replaced by Duel Lens's own card detector and removed from the
> repository, and click to scan, official card images and Genesys points came later. For how Duel Lens works now,
> see [README.md](../../../README.md) and [docs/DEVELOPMENT.md](../../DEVELOPMENT.md).

Date: 2026-09-28 · Status: approved by the user ("yes, do both in parallel with agents")
Base spec: `2026-09-28-duel-lens-design.md`. Evidence: `.superpowers/sdd/2026-09-28-duel-lens-v1/research-{apis,draw2,domain-gap}.md`.

## Why
The v1 matcher fails on real YouTube duel footage (YCS Paris 2026, t=7826 s). The test was 12 cards at native 1080p on an overhead camera: sleeved cards, glare, washed-out colour, artwork about 50–75 px wide, many in defense position.

| | Our v1 | DRAW2 (open source, AGPL-3.0) |
|---|---|---|
| Cards detected | 2/12 (OpenCV) | 12/12 (detector) |
| Right card first | 0/12; true card ranks 120–225+ even with DRAW2's boxes | 9/12 (fp32 classifier); 10/12 in the top 5 |

The root cause is the domain gap. The embedder only saw clean digital art. Downscaling and blur are fine, but washout, colour cast and glare break it.

## Decisions
1. **Phase 1, now (personal use):** DRAW2's detector and classifier become the primary recogniser in the offscreen engine. The embedding matcher stays as the fallback, and the AI check stays as it is. AGPL is acceptable while the extension is personal. The README must say so.
2. **Phase 2, in parallel:** fine-tune our own open-set embedder "like DRAW2/Neuron", on realistic synthetic renderings of every artwork plus real crops later. Keep the index design, so new cards only need new vectors. It replaces DRAW2's classifier as primary once it beats DRAW2 on the real test set.
3. **Phase 3, before publishing:** replace the AGPL detector with our own, trained on synthetic composites.
4. **One real test set judges everything:** `data/realset/`, built from real frames and labelled by DRAW2 (confident answers only) plus human spot checks. It's grown from the user's video and more frames the lead captures.

## Contracts (lead, done)
- `RecognitionResult.recognizer?: 'draw2' | 'embedding' | 'combined'`
- `best.hypothesis` may be `'draw2'`
- `Candidate.score`: DRAW2 candidates use the class probability renormalised over their top 5, in [0, 1]
- `build.mjs` ships `extension/models/draw2/**` when present. The engine must still work without it, by falling back to embedding only.
- `.gitignore` ignores `extension/models/**/*.onnx` and `data/venv*/`.

## Acceptance
- **Phase 1:** on the real set, at least DRAW2's standalone accuracy (9/12 on the first 12). E2E still 8/8. First scan ≤ 1.5 s and warm ≤ 0.8 s in headless Chrome. When the top-1/top-2 probability ratio is below 5, say "Not sure" and lead with the alternatives.
- **Phase 2:** the fine-tuned model beats DRAW2's top-1 on the real set, at a model size ≤ 30 MB, and keeps top-1 ≥ 99% on clean web images.
