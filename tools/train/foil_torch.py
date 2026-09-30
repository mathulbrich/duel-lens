"""Scores PyTorch checkpoints on the real foil set's engine hypotheses (tools/train/dump-hyps.ts), against every
artwork's clean embedding by the same checkpoint (as evalsuite.py does): per row, the right card's rank and
score over all the engine's readings, and the top card. A check on real footage before export and indexing
(foil-report.md); the shipped verdicts come from tools/train/eval-foil.ts on the exported models.

  python tools/train/foil_torch.py data/train/ckpt/r2/best.pt data/train/ckpt/r3-foil/epoch02.pt [--hyps=DIR] [--rows=GROUP]
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict

import numpy as np
import torch
from PIL import Image

from common import CARD_BACK_ID, DATA, index_entries, load_art_cache, pil_resize_224
from model import Embedder, embed_u8

HYPS = DATA / "foil" / "hyps"


def main():
    global HYPS
    for a in sys.argv[1:]:
        if a.startswith("--hyps="):  # another dump-hyps.ts output (the combined retrain's real sets)
            from pathlib import Path

            HYPS = Path(a.split("=", 1)[1])
    dev = torch.device("mps")
    entries = index_entries()
    cards = np.array([e["cardId"] for e in entries])
    card_list = sorted(set(cards.tolist()))
    pos = {c: k for k, c in enumerate(card_list)}
    card_idx = torch.tensor([pos[c] for c in cards])
    man = json.load(open(HYPS / "manifest.json"))
    imgs, owner = [], []
    for k, m in enumerate(man):
        for f in m["files"]:
            imgs.append(pil_resize_224(np.asarray(Image.open(HYPS / f).convert("RGB"))))
            owner.append(k)
    imgs = np.stack(imgs)
    owner = np.array(owner)
    art = load_art_cache()
    for ck in [a for a in sys.argv[1:] if not a.startswith('--')]:
        model = Embedder(standardize=True)
        model.load_state_dict(torch.load(ck, map_location="cpu"))
        model = model.to(dev)
        bank = embed_u8(model, art, dev, amp=torch.bfloat16)
        q = embed_u8(model, imgs, dev, amp=torch.bfloat16)
        sims = q @ bank.T
        per_card = torch.full((len(q), len(card_list)), -2.0).scatter_reduce(1, card_idx.expand(len(q), -1), sims, reduce="amax")
        groups = defaultdict(list)
        for k, m in enumerate(man):
            s = per_card[torch.tensor(owner == k)].max(0).values
            s[pos[CARD_BACK_ID]] = -2.0 if CARD_BACK_ID in pos else s[pos[CARD_BACK_ID]]
            t = float(s[pos[m["cardId"]]])
            rank = int((s > t).sum()) + 1
            top = int(s.argmax())
            groups[m["group"]].append((rank, t, float(s[top]), card_list[top] == m["cardId"]))
        print(f"== {ck}")
        show = {a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--rows=")}
        for k, m in enumerate(man):
            if m["group"] in show:
                s = per_card[torch.tensor(owner == k)].max(0).values
                t = float(s[pos[m["cardId"]]])
                print(f"    {m['id']:28s} rank {int((s > t).sum()) + 1:5d} truth {t:.3f} top {float(s.max()):.3f}")
        for g, rs in groups.items():
            ranks = np.array([r[0] for r in rs])
            print(f"  {g:14s} n={len(rs):3d} top1 {int((ranks == 1).sum()):3d} top5 {int((ranks <= 5).sum()):3d} "
                  f"median rank {np.median(ranks):6.1f} median truth {np.median([r[1] for r in rs]):.3f} "
                  f"median top {np.median([r[2] for r in rs]):.3f}", flush=True)


if __name__ == "__main__":
    main()
