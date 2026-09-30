"""Averages the weights of several checkpoints (a 'soup': the epoch-to-epoch swings of the real-footage screen average
out), optionally weighted (CKPT:W; a fine-tune interpolated back toward its start, WiSE-FT style):
  python tools/train/avg_ckpt.py OUT.pt CKPT CKPT [CKPT ...]
  python tools/train/avg_ckpt.py OUT.pt ../../data/train/ckpt/r6-real/epoch08.pt:0.7 ../../data/train/ckpt/r2/best.pt:0.3"""
import sys

import torch

out, args = sys.argv[1], sys.argv[2:]
cks = [(a.rsplit(":", 1)[0], float(a.rsplit(":", 1)[1])) if ":" in a.rsplit("/", 1)[-1] else (a, 1.0) for a in args]
total = sum(w for _, w in cks)
sds = [(torch.load(c, map_location="cpu"), w / total) for c, w in cks]
avg = {}
for k, v in sds[0][0].items():
    if v.is_floating_point():
        avg[k] = sum(sd[k].float() * w for sd, w in sds).to(v.dtype)
    else:
        avg[k] = v
torch.save(avg, out)
names = ", ".join(f"{c.split('ckpt/')[-1]} x{w / total:.2f}" for c, w in cks)
print(f"averaged {len(cks)} checkpoints ({names}) -> {out}")
