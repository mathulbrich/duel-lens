"""Train the card detector on synthetic frames (MPS).

  python train.py --bench                          throughput of a few steps
  python train.py --run d1 --minutes 90            train; checkpoints every --ckpt-min minutes and at the end
  python train.py --run d2 --init ../../data/train-detector/ckpt/d1/last.pt --minutes 120

Each step: B frames rendered by scene.render_frame() in worker processes, two 640x640 windows each
(a random window, a window around a card, or 25% of the time the drag case: a loose box around one
card, resized); CenterNet focal loss on the heatmaps (ignored objects masked), Gaussian-weighted L1
on offsets, log sizes and (sin 2a, cos 2a). AdamW, warmup then cosine over the time budget.
Every --eval-min minutes: the real full-view frames (click-D's truth.json, a quick proxy for
evaluate.ts) and a fixed synthetic validation set; logs in data/train-detector/logs/<run>.jsonl.
"""
from __future__ import annotations

import argparse
import json
import math
import time

import numpy as np
import torch
import torch.nn.functional as F

from common import CKPT_DIR, LOGS
from model import Detector
from targets import build

WIN = 640


class Windows(torch.utils.data.Dataset):
    def __init__(self, seed: int, split: str = "train", per_frame: int = 4):
        self.seed, self.split, self.per_frame = seed, split, per_frame
        self.A = None

    def __len__(self):
        return 1 << 30

    def __getitem__(self, i):
        from scene import IGNORE, Assets, drag_crop, render_frame, window

        if self.A is None:
            self.A = Assets(self.split)
        r = np.random.default_rng([self.seed, i])
        img, objs, kind = render_frame(self.A, r)
        cards = [o for o in objs if o.cls != IGNORE and o.visible > 0.6]
        xs, ts = [], []
        for _ in range(self.per_frame):
            u = r.random()
            if cards and u < 0.25:
                win, rows = drag_crop(img, objs, r, cards[int(r.integers(len(cards)))], WIN)
            else:
                win, rows = window(img, objs, r, WIN, cards[int(r.integers(len(cards)))] if cards and u < 0.75 else None)
            heat, reg, regw, ign = build(rows, (WIN, WIN))
            xs.append(win)
            ts.append(np.concatenate([heat, reg, regw[None], ign[None]], 0))
        return torch.from_numpy(np.stack(xs)), torch.from_numpy(np.stack(ts).astype(np.float16))


def collate(items):
    return torch.cat([x for x, _ in items]), torch.cat([t for _, t in items])


def to_input(x_u8: torch.Tensor, device) -> torch.Tensor:
    # contiguous NCHW: a permuted (channels-last) input makes MPS's conv backward ~4x slower
    return x_u8.to(device, non_blocking=True).permute(0, 3, 1, 2).contiguous().float().div_(255.0)


def losses(logits, box, t):
    K = logits.shape[1]
    R = box.shape[1]  # 14: 6 box channels + 8 corner residuals
    heat = t[:, :K]
    reg = t[:, K:K + R]
    regw = t[:, K + R]
    ign = t[:, K + R + 1]
    pred = torch.sigmoid(logits.float()).clamp(1e-4, 1 - 1e-4)
    pos = (heat >= 0.999).float()
    npos = pos.sum().clamp(min=1.0)
    pos_loss = (torch.log(pred) * (1 - pred) ** 2 * pos).sum()
    negw = (1 - heat) ** 4 * (1 - pos) * (1 - ign[:, None])
    neg_loss = (torch.log(1 - pred) * pred ** 2 * negw).sum()
    focal = -(pos_loss + neg_loss) / npos
    w = regw[:, None]
    wsum = regw.sum().clamp(min=1.0)  # = number of objects (each object's weights sum to 1)
    b = box.float()
    off = (torch.abs(b[:, 0:2] - reg[:, 0:2]) * w).sum() / wsum
    size = (torch.abs(b[:, 2:4] - reg[:, 2:4]) * w).sum() / wsum
    # squared error for the angle and the corners: with L1, the ~90% of cards within a few degrees of an
    # axis (small targets of random sign) pull as hard as a card tilted 30 degrees, and the fit collapses
    # onto the axes (runs d1-d4 predicted 0 or 90 degrees for every tilt); a squared error weighs large
    # misses more
    ang = 2.0 * (((b[:, 4:6] - reg[:, 4:6]) ** 2) * w).sum() / wsum
    corner = 4.0 * (((b[:, 6:14] - reg[:, 6:14]) ** 2) * w).sum() / wsum
    return focal, off, size, ang, corner


def lr_at(step, progress, warm, peak):
    """Linear warmup over `warm` steps, then cosine to 2% over the TIME budget (progress 0..1), so a
    stall (another job hogging the CPU) doesn't leave the run ending at a high learning rate."""
    if step < warm:
        return peak * (step + 1) / warm
    p = min(1.0, max(0.0, progress))
    return peak * (0.02 + 0.98 * 0.5 * (1 + math.cos(math.pi * p)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="d1")
    ap.add_argument("--backbone", default="mnv3l")
    ap.add_argument("--minutes", type=float, default=90)
    ap.add_argument("--frames", type=int, default=4, help="frames per step (x4 windows each; 16 windows of 640px take ~11.6 GB on MPS)")
    ap.add_argument("--workers", type=int, default=5)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--wd", type=float, default=1e-4)
    ap.add_argument("--warmup", type=int, default=300)
    ap.add_argument("--init", default=None)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--ckpt-min", type=float, default=10)
    ap.add_argument("--eval-min", type=float, default=15)
    ap.add_argument("--bench", action="store_true")
    ap.add_argument("--amp", action="store_true", help="bf16 autocast")
    args = ap.parse_args()

    dev = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    model = Detector(args.backbone, pretrained=args.init is None).to(dev)
    if args.init:
        sd = torch.load(args.init, map_location="cpu")
        missing, unexpected = model.load_state_dict(sd["model"] if "model" in sd else sd, strict=False)
        print(f"init from {args.init}: new (untrained) {sorted({k.split('.')[0] for k in missing})}, unused {unexpected}", flush=True)
    decay, no_decay = [], []
    for n, p in model.named_parameters():
        (no_decay if p.ndim <= 1 else decay).append(p)
    opt = torch.optim.AdamW([{"params": decay, "weight_decay": args.wd}, {"params": no_decay, "weight_decay": 0.0}], lr=args.lr)

    ds = Windows(args.seed)
    sampler = torch.utils.data.BatchSampler(range(1 << 30), args.frames, drop_last=True)
    dl = torch.utils.data.DataLoader(ds, batch_sampler=sampler, num_workers=args.workers, collate_fn=collate,
                                     persistent_workers=True, prefetch_factor=2)
    it = iter(dl)
    (CKPT_DIR / args.run).mkdir(parents=True, exist_ok=True)
    LOGS.mkdir(parents=True, exist_ok=True)
    log = open(LOGS / f"{args.run}.jsonl", "a")

    def save(name, step, extra=None):
        torch.save({"model": model.state_dict(), "step": step, "args": vars(args), **(extra or {})}, CKPT_DIR / args.run / name)

    t0 = time.time()
    budget = args.minutes * 60
    step = 0
    warm_end = None
    last_ckpt = last_eval = time.time()
    agg_t = None
    nagg = 0
    wait = 0.0
    model.train()
    while True:
        tw = time.time()
        x, t = next(it)
        wait += time.time() - tw
        x = to_input(x, dev)
        t = t.to(dev, non_blocking=True).float()
        elapsed = time.time() - t0
        if warm_end is None and step >= args.warmup:
            warm_end = elapsed
        total = int(budget / max(1e-6, elapsed / max(1, step)))  # (for the log: steps at the current pace)
        lr = lr_at(step, 0.0 if warm_end is None else (elapsed - warm_end) / max(1.0, budget - warm_end), args.warmup, args.lr)
        for g in opt.param_groups:
            g["lr"] = lr
        if args.amp:
            with torch.autocast("mps", dtype=torch.bfloat16):
                logits, box = model(x)
        else:
            logits, box = model(x)
        focal, off, size, ang, corner = losses(logits, box, t)
        loss = focal + off + size + ang + corner
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 10.0)
        opt.step()
        step += 1
        # no per-step .item(): each is a GPU sync, and with the CPU contended the kernel dispatch must run ahead of the GPU
        parts = torch.stack([loss.detach(), focal.detach(), off.detach(), size.detach(), ang.detach(), corner.detach()])
        agg_t = parts if agg_t is None else agg_t + parts
        nagg += 1
        if args.bench and step == 30:
            dt = time.time() - t0
            print(f"bench: {step} steps in {dt:.1f}s = {dt / step:.2f} s/step, {step * x.shape[0] / dt:.1f} windows/s, data wait {wait:.1f}s")
            return
        if step % 50 == 0:
            m = [float(v) for v in (agg_t / max(1, nagg)).cpu().tolist()]
            agg_t = None
            msg = dict(run=args.run, step=step, min=round((time.time() - t0) / 60, 2), lr=round(lr, 6), loss=round(m[0], 4), focal=round(m[1], 4),
                       off=round(m[2], 4), size=round(m[3], 4), ang=round(m[4], 4), corner=round(m[5], 4), wait=round(wait, 1), total=total)
            print(json.dumps(msg), flush=True)
            log.write(json.dumps(msg) + "\n")
            log.flush()
            nagg = 0
        now = time.time()
        done = now - t0 >= budget
        if now - last_ckpt >= args.ckpt_min * 60 or done:
            save("last.pt", step)
            last_ckpt = now
        if now - last_eval >= args.eval_min * 60 or done:
            from quick_eval import quick_eval

            model.eval()
            res = quick_eval(model, dev)
            model.train()
            if dev.type == "mps":
                torch.mps.empty_cache()
            res.update(run=args.run, step=step, min=round((now - t0) / 60, 2), kind="eval")
            print(json.dumps(res), flush=True)
            log.write(json.dumps(res) + "\n")
            log.flush()
            save(f"step{step:06d}.pt", step, {"eval": res})
            last_eval = time.time()
        if done:
            break
    print("done", step)


if __name__ == "__main__":
    main()
