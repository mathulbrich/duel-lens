"""Epoch-0 numbers of the base model on the evaluation suite, with and without the in-graph
per-channel input standardisation, plus MPS throughput. python tools/train/baseline.py"""
from __future__ import annotations

import json
import time

import torch

from common import LOGS
from evalsuite import Suite, summary
from model import Embedder, embed_u8

dev = torch.device("mps")
suite = Suite()
out = {}
for std in (False, True):
    m = Embedder(standardize=std).to(dev).eval()
    for amp in (None, torch.float16):
        t0 = time.time()
        bank = embed_u8(m, suite.art, dev, amp=amp)
        dt = time.time() - t0
        print(f"standardize={std} amp={amp}: bank {len(bank)} in {dt:.1f}s ({len(bank) / dt:.0f} img/s)", flush=True)
        res = suite.run(lambda x: embed_u8(m, x, dev, amp=amp), bank)
        print("  ", summary(res), flush=True)
        out[f"std={std},amp={amp}"] = {k: v for k, v in res.items() if k != "perSighting"}
        out[f"std={std},amp={amp}"]["perSighting"] = res["perSighting"]
json.dump(out, open(LOGS / "baseline.json", "w"), indent=1)
