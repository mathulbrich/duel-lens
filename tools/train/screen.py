"""Screens PyTorch checkpoints on real footage before export (combined-retrain-report.md): the images the CURRENT engine
embeds for each scan (tools/train/dump-scans.ts), scored against every artwork's clean embedding by the same checkpoint,
as evalsuite.py does. Per scan: every card's best score over the scan's readings (the engine's merged list, both
rotation stages), the right card's rank and score, the top five, the card back's score.

  python tools/train/screen.py --out OUT.json --hyps DIR[,DIR...] CKPT [CKPT...]   # appends each checkpoint to OUT.json
  python tools/train/screen.py --report OUT.json [CKPT-substring ...] [--floor 0.74]

The report, per set, group and mode: the right card first, first and over a floor (0.74, 0.70, 0.68: the model floor,
and the suggestions' 0.68), how many dinov2-small-duel's thresholds would call sure ("sure*": one stage, no rotation
logic, so a proxy), median scores; for non-card rows (cardId null), how high they reach. The engine's own decisions
come from tools/train/eval-gate.ts on the exported model.
"""
from __future__ import annotations

import json
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

SURE = lambda s, m: s >= 0.74 and ((s >= 0.80 and m >= 0.02) or (s >= 0.73 and m >= 0.10))  # the 0.74 floor applies to both gates


def screen(out_path: str, hyp_dirs: list[str], cks: list[str]):
    import torch
    from PIL import Image

    from common import CARD_BACK_ID, index_entries, load_art_cache, pil_resize_224
    from model import Embedder, embed_u8

    dev = torch.device("mps")
    entries = index_entries()
    cards = np.array([e["cardId"] for e in entries])
    card_list = sorted(set(cards.tolist()))
    pos = {c: k for k, c in enumerate(card_list)}
    card_idx = torch.tensor([pos[c] for c in cards])
    back = pos.get(CARD_BACK_ID)
    sets = []
    for d in map(Path, hyp_dirs):
        man = json.load(open(d / "manifest.json"))
        imgs, owner = [], []
        for k, m in enumerate(man):
            for f in m["files"]:
                imgs.append(pil_resize_224(np.asarray(Image.open(d / f).convert("RGB"))))
                owner.append(k)
        sets.append((d.name, man, np.stack(imgs) if imgs else np.zeros((0, 224, 224, 3), np.uint8), np.array(owner)))
        print(f"{d.name}: {len(man)} scans, {len(imgs)} images", flush=True)
    art = load_art_cache()
    results = json.load(open(out_path)) if Path(out_path).exists() else {}
    for ck in cks:
        t0 = time.time()
        model = Embedder(standardize=True)
        model.load_state_dict(torch.load(ck, map_location="cpu"))
        model = model.to(dev)
        bank = embed_u8(model, art, dev, amp=torch.bfloat16)
        res = {}
        for name, man, imgs, owner in sets:
            if len(imgs) == 0:
                continue
            q = embed_u8(model, imgs, dev, amp=torch.bfloat16)
            pc = torch.cat([torch.full((len(s), len(card_list)), -2.0).scatter_reduce(1, card_idx.expand(len(s), -1), s, reduce="amax")
                            for s in (q[i:i + 512] @ bank.T for i in range(0, len(q), 512))])
            for k, m in enumerate(man):
                sel = torch.tensor(owner == k)
                rec = {"id": m["id"], "group": m["group"], "mode": m.get("mode", "drag"), "cardId": m["cardId"]}
                if not sel.any():
                    res.setdefault(name, []).append({**rec, "noOutline": True})
                    continue
                s = pc[sel].max(0).values
                rec["back"] = round(float(s[back]), 4) if back is not None else -2.0
                if back is not None:
                    s[back] = -2.0
                top = torch.topk(s, 5)
                rec["top"] = [[card_list[int(i)], round(float(v), 4)] for v, i in zip(top.values, top.indices)]
                if m["cardId"] is not None:
                    t = float(s[pos[m["cardId"]]])
                    rec["truth"], rec["rank"] = round(t, 4), int((s > t).sum()) + 1
                res.setdefault(name, []).append(rec)
        results[ck] = res
        print(f"== {ck} ({time.time() - t0:.0f} s)", flush=True)
        json.dump(results, open(out_path, "w"))


def report(path: str, pick: list[str], floor: float):
    res = json.load(open(path))
    lead = lambda r: r["truth"] - (r["top"][1][1] if r["top"][0][0] == r["cardId"] else r["top"][0][1])
    for ck in [c for c in res if not pick or any(p in c for p in pick)]:
        print(f"=================== {ck}")
        for name, rows in res[ck].items():
            groups = defaultdict(list)
            for r in rows:
                groups[(r["group"], r["mode"])].append(r)
            for (g, mode), rs in sorted(groups.items()):
                ok = [r for r in rs if not r.get("noOutline")]
                if not ok:
                    print(f"  {name:14s} {g:24s} {mode:5s} n {len(rs):3d} | no outline")
                    continue
                if rs[0]["cardId"] is None:
                    tops = [r["top"][0][1] for r in ok]
                    print(f"  {name:14s} {g:24s} {mode:5s} n {len(rs):3d} | max {max(tops):.3f}" +
                          "".join(f" | >={f:.2f} {sum(t >= f for t in tops):3d}" for f in (0.80, floor, 0.70, 0.68)))
                    continue
                first = [r for r in ok if r["rank"] == 1]
                s = f"  {name:14s} {g:24s} {mode:5s} n {len(rs):3d} first {len(first):3d}"
                s += "".join(f" | first>={f:.2f} {sum(r['truth'] >= f for r in first):3d}" for f in (floor, 0.70, 0.68))
                s += f" | sure* {sum(SURE(r['truth'], lead(r)) for r in first):3d}"
                s += f" | med truth {np.median([r['truth'] for r in ok]):.3f} rank {np.median([r['rank'] for r in ok]):.0f}"
                print(s + (f" | no outline {len(rs) - len(ok)}" if len(ok) < len(rs) else ""))


if __name__ == "__main__":
    a = sys.argv[1:]
    if "--report" in a:
        floor = float(a[a.index("--floor") + 1]) if "--floor" in a else 0.74
        rest = [x for i, x in enumerate(a) if x not in ("--report", "--floor") and a[i - 1] != "--floor"]
        report(rest[0], rest[1:], floor)
    else:
        out = a[a.index("--out") + 1]
        dirs = a[a.index("--hyps") + 1].split(",")
        screen(out, dirs, [x for i, x in enumerate(a) if not x.startswith("--") and a[i - 1] not in ("--out", "--hyps")])
