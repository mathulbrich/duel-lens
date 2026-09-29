"""Markdown training curve of a run: python tools/train/curve.py r2"""
import json
import sys

from common import LOGS

run = sys.argv[1] if len(sys.argv) > 1 else "r2"
rows = [json.loads(l) for l in open(LOGS / f"{run}.jsonl")]
p = lambda r, k: f"{100 * r[k]['top1']:.1f}"
c = lambda r, k: f"{r[k]['top1']}/{r[k]['n']}"
print("| epoch | train min | loss | video seen / unseen | hard seen / unseen | web seen / unseen | real seen (q0) | real unseen (q0) | human (q0) | real29 (all) | low-res (q0) |")
print("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
for r in rows:
    loss = f"{r['loss']:.3f}" if "loss" in r else "-"
    best = " *" if r.get("best") else ""
    print(f"| {r['epoch']}{best} | {r['trainMin']:.0f} | {loss} | {p(r, 'synth-video/seen')} / {p(r, 'synth-video/unseen')} | "
          f"{p(r, 'synth-hard/seen')} / {p(r, 'synth-hard/unseen')} | {p(r, 'web/seen')} / {p(r, 'web/unseen')} | "
          f"{c(r, 'real-seen-quad0')} | {c(r, 'real-unseen-quad0')} | {c(r, 'human-quad0')} | {c(r, 'real-all')} | {c(r, 'lowres-quad0')} |")
