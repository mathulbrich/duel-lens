"""The synthetic half of the foil test set (foil-report.md): full-card foil renderings (synth.py _fullfoil)
of UNSEEN cards (never trained on, prepare.py split), other than the ones evalsuite.py build-foil checks
every epoch, so neither training nor checkpoint selection saw them. 'video' (2 in 3) and 'hard' levels,
fixed seeds, 224 px art cuts as the engine embeds them -> data/train/foil/synth/*.png + manifest.json,
for tools/train/eval-foil.ts (the shipped ONNX models and their indexes).

  python tools/train/foil_set.py [--n 150]     per unseen group (random 5% / released 2026)
"""
from __future__ import annotations

import argparse
import json

import numpy as np
from PIL import Image

from common import CARD_BACK_ID, DATA, index_entries, load_art_cache, load_split
from evalsuite import FOIL_VAL, GROUPS
from synth import Library, render

OUT = DATA / "foil" / "synth"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=150)
    a = ap.parse_args()
    entries = index_entries()
    art = load_art_cache()
    grp = {int(k): v for k, v in load_split()["group"].items()}
    f = np.load(FOIL_VAL)
    taken = {int(i) for g in GROUPS for i in f[f"{g}/idx"]}
    lib = Library(entries)
    r = np.random.default_rng(4242)
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = []
    for gi, g in enumerate(("unseen-random", "unseen-new")):
        # one artwork per card, not in the per-epoch foil check
        seen_cards = set()
        pool = []
        for i in r.permutation(len(entries)):
            e = entries[i]
            if e["cardId"] == CARD_BACK_ID or grp.get(e["cardId"]) != g or int(i) in taken or e["cardId"] in seen_cards:
                continue
            seen_cards.add(e["cardId"])
            pool.append(int(i))
        for j, i in enumerate(pool[: a.n]):
            level = "hard" if j % 3 == 2 else "video"
            img = render(np.asarray(art[i]), lib.kinds[i], lib, np.random.default_rng(5000 + j + 7919 * gi), level, fullfoil=1.0)
            name = f"{g}-{j:03d}-{entries[i]['imageId']}.png"
            Image.fromarray(img).save(OUT / name)
            manifest.append({"file": name, "cardId": entries[i]["cardId"], "imageId": entries[i]["imageId"], "group": g, "level": level})
    json.dump(manifest, open(OUT / "manifest.json", "w"), indent=1)
    print(f"wrote {len(manifest)} foil renderings of unseen cards to {OUT}")


if __name__ == "__main__":
    main()
