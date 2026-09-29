# tools/realset: the real-footage test set

Real duel frames, captured at native resolution from nine productions, with the boxes a user would draw
on them. Every recogniser is judged on this set (spec addendum §4): `tools/eval-real.ts` runs it.

Everything lives in `data/realset/` and `data/debug/frames/`. Like the rest of `data/`, the frames are
gitignored (back them up privately); `set.json`, `excluded.json` and `negatives.json` are kept with the
source (`.gitignore` re-includes them). Back them up before you experiment.

## Productions

The frame name's prefix gives the production (`productionOf` in `lib/constants.ts`):

| Prefix | Production | Look |
|---|---|---|
| `native-wc-` | Yu-Gi-Oh! World Championship 2026, Day 2 (official stream) | vertical mat, players left and right, cards about 70×95 px |
| `native-wcq-` | WCQ Stuttgart 2026, feature-match recap by UnitedGosus | dark gold Exodia mat, warm light, cards about 150×100 px |
| any other `native-` | YCS Paris 2026 (the user's video and later matches of the same stream) | cards about 110×150 px |

Capture-C's five productions (merged 2026-09-29) have their own prefixes: `native-tsc-` (Team Solemn
Circus locals), `native-hgg-` and `native-hgg720-` (the Houston regional, and its 720p rendition),
`native-ycsc-` (YCS Columbus), `native-dp-` (a hand-held deck-profile close-up) and `native-dlaw-`
(DarkLaw locals, an oblique camera). Their frames carry an ICC colour profile (an `iCCP` chunk), which
Chrome applies and `sharp` doesn't: the E2E's crops of them differ from `eval-real.ts`'s by at most one
level per channel on some pixels (the answers are the same).

Frames are `data/debug/frames/<frame>.png`. All box coordinates are in the frame's own pixels.

## Files

### `set.json`: the labelled cards (120)

An array of `RealsetEntry` (`lib/types.ts`), one per face-up card:

| Field | Meaning |
|---|---|
| `id` | `<frame>-<key>`, unique |
| `frame` | the frame name, without `.png` |
| `userBox` | `{x, y, w, h}`: the axis-aligned box a user would draw (what `eval-real.ts` crops by default) |
| `rotatedBox` | the card's oriented box on record (provenance): `{cx, cy, w, h, angleDeg, conf, pts}`, `pts` = the four corners; `null` on capture-C's rows |
| `cardId`, `name` | the label (`cards.json` id and name) |
| `source` | provenance: `'human'`: identified by a person; `'draw2-teacher'`: the teacher classifier's own top-1, kept after the lead compared it with the artwork |
| `verified` | a person checked the label: every `human` row, and the 15 teacher rows accepted at the first spot check (teacher rows added later keep `false`, although they were compared with the artwork too) |
| `teacherProb`, `teacherRatio`, `teacherTop5` | optional provenance: the teacher's top-1 probability, its top-1/top-2 ratio (`RATIO_GATE` = 5 was its accept gate) and its top 5, recorded even where a person overrode it; absent or `null` on capture-C's rows |
| `occluded` | optional: a hand covers part of the card |

**Provenance fields.** `source`, `rotatedBox` and the `teacher*` fields record how the first rows were
labelled: by the detector and classifier of an earlier third-party prototype (the "teacher"), which was
removed from the repository on 2026-09-29 with the tool that ran it. They are kept as factual history
(the `'draw2-teacher'` value keeps its original name); `lib/types.ts` keeps the teacher fields optional,
and nothing writes teacher rows any more. The teacher rows may lean towards what the teacher got right;
the `human` rows are the stricter bar. `eval-real.ts` reports both, and each production.

On 2026-09-28 the set held 57 cards: 17 human, 40 teacher (39 with ratio ≥ 5). On 2026-09-29 capture-C's
63 human-labelled cards were merged in (from `staging-C.json`): 120 cards, 80 human and 40 teacher. By
production: YCS Paris 50, WC 2, WCQ Stuttgart 5, TSC 22, Houston 15, YCS Columbus 7, deck-profile
close-up 5, DarkLaw 14.

### `excluded.json`: detections left out (32)

The same `RealsetEntry` shape plus `excludedReason` (free text): cards in hand, deck sleeves, a foil,
overlapping or covered cards, a turn marker, and cards too small or washed out to identify by eye (most
of the WC production). They are kept so that nobody labels them again by accident, and they are never
scored.

### `negatives.json`: boxes around things that are not a face-up card (70)

An array of `NegativeBox` (`lib/types.ts`), hand-drawn like a user's box:

| Field | Meaning |
|---|---|
| `id` | unique, e.g. `t10400-bottom-rose` |
| `frame` | the frame name, without `.png` |
| `box` | `[x, y, w, h]` in frame pixels (an array, unlike `userBox`) |
| `design` | what the box holds, e.g. `"WCQ blue (official)"`, `"Black Rose Dragon art sleeve"`, `"MAT ART: printed Exodia artwork in a zone (not a card)"` |
| `source` | the stream, e.g. `"YCS Paris 2026 (Genesys) Day 1"` |

They are deck piles and single face-down cards in about 20 sleeve designs (plain, logo, holo and art
sleeves), a fan of face-down cards, and two boxes of artwork printed on the mat; capture-C added 33
(piles, sleeves, empty zones, mat art, a phone, a deck box, hands holding a deck). By production: YCS
Paris 15, WC 11, WCQ Stuttgart 11, TSC 9, Houston 8, YCS Columbus 9, deck-profile close-up 2, DarkLaw 5.
No recogniser should be sure of any card in them. `eval-real.ts
--negatives` reports how many come back confident, not sure or nothing found. (This file was
`piles-staging.json` until 2026-09-28.)

### Other files

- `set-additions.json` (28), `excluded-additions.json` (24): the staged rows merged into `set.json` and
  `excluded.json` on 2026-09-28 (`.superpowers/sdd/2026-09-28-duel-lens-v1/merge-realset.cjs`). They
  are kept as a record only: their rows are now in `set.json`, so passing both files to a tool counts
  them twice.
- `staging.json`, `staging-wc.json`, `staging-wcq.json`: the teacher labeller's raw output for the frames
  of the later captures, before the spot check (the labeller has since been removed).
- `results-engine-<model>.json`: `eval-real.ts` output (other `results-*` files come from earlier
  recognisers). `art-check-<model>.json`: output of an art-check calibration tool, since removed.
  `verify.png` / `verify.md`: `verify.ts` output.

## Tools

```bash
npx tsx tools/eval-real.ts --recognizer engine --model dinov2-small-duel --negatives data/realset/negatives.json
npx tsx tools/eval-real.ts --recognizer engine --no-detector --negatives data/realset/negatives.json   # as a --no-detector build
npx tsx tools/realset/verify.ts                                                        # contact sheet of set.json
```

- `../eval-real.ts`: the extension's engine. Top-1/top-5, confident and confident-wrong answers and
  latency, overall, by label source and by production. `--negatives <file>` adds the non-card boxes.
  `--raw` also records each row's candidates before any threshold (the embedding matcher's stage-1
  and all-stage lists, and the card back's score), which is what `src/shared/models.ts`'s thresholds
  are calibrated on. See the file's header.
- `verify.ts`: each entry's crop next to its label's clean artwork, for spot checks.
- `lib/`: `crop.ts` rebuilds the content script's crop exactly (4% margin, downscaling, `inner`);
  `cards.ts` loads `cards.json`; `types.ts` and `constants.ts` hold the shapes above, `RATIO_GATE`
  and `productionOf`.

## Adding frames

1. Capture frames at native resolution into `data/debug/frames/native-<prefix>...png` (the prefix gives
   the production; add one to `productionOf` for a new production).
2. Label them by hand into a staging file, `data/realset/staging-<name>.json`, as capture-C did
   (`staging-C.json`): one `RealsetEntry` per face-up card, with the `userBox` a user would draw,
   `rotatedBox: null`, `source: 'human'` and `verified: true`, and no teacher fields.
3. Check each row by eye against the artwork (`verify.ts` builds such a sheet, for `set.json`). Move the
   accepted rows into `set.json`, and the rest into `excluded.json` with an `excludedReason`. Draw boxes
   around sleeves, piles and other non-cards into `negatives.json`.
