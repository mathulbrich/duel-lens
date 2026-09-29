"""Fine-tune DINOv2-small into Duel Lens's open-set artwork embedder (MPS).

Objective (open-set metric learning, index design kept): every degraded rendering of an artwork must
retrieve that artwork's CLEAN embedding - computed by the same network, exactly as the index is
built - among all training artworks' clean embeddings:
  - per step: B anchors, each with its clean view (with gradient) and K degraded views
  - logits of a degraded view: in-batch clean embeddings (gradient flows to both sides) and a memory
    bank of every other training artwork's clean embedding (no gradient; rows refreshed whenever an
    anchor passes, fully refreshed every epoch), temperature tau; same-card entries (alternate
    artworks) and near-duplicate artworks of other cards are masked out
  - negatives (sleeve backs, deck piles, empty mat zones) are pushed below a similarity margin
Unseen cards (released >= 2026 + a random 5% of older cards, prepare.py split) are never positives
nor negatives; the best checkpoint is chosen on them (early stopping on the unseen split).

  python tools/train/train.py --bench              throughput/memory of a few steps
  python tools/train/train.py --minutes 100 --run r2
  python tools/train/train.py --run r3-foil --init data/train/ckpt/r2/best.pt --fullfoil 0.2 --select foil ...
      (a fine-tune of r2 with full-card foil prints in the mix; foil-report.md)
"""
from __future__ import annotations

import argparse
import json
import math
import os
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

from common import CARD_BACK_ID, CKPT_DIR, LOGS, index_entries, load_art_cache, load_split
from model import Embedder, embed_u8, freeze_until, param_groups, to_input

NEG = -2


class Views(torch.utils.data.Dataset):
    """Item = (K degraded views, clean view, index); index NEG renders K negative views."""

    def __init__(self, k: int, seed: int, fullfoil: float = 0.0):
        self.k, self.seed, self.fullfoil = k, seed, fullfoil
        self.lib = None
        self.epoch = 0

    def __len__(self):
        return 1 << 30

    def __getitem__(self, key):
        i, salt = key
        if self.lib is None:
            from synth import Library

            self.entries = index_entries()
            self.lib = Library(self.entries)
            self.art = load_art_cache()
        from synth import mixed_level, render

        r = np.random.default_rng([self.seed, salt, i + 3])
        if i == NEG:
            views = [render(None, ("neg", None), self.lib, r, mixed_level(r)) for _ in range(self.k)]
            clean = np.zeros((224, 224, 3), np.uint8)
        else:
            a = np.asarray(self.art[i])
            views = [render(a, self.lib.kinds[i], self.lib, r, mixed_level(r), fullfoil=self.fullfoil) for _ in range(self.k)]
            clean = a
        return torch.from_numpy(np.stack(views)), torch.from_numpy(np.ascontiguousarray(clean)), i


class Batches(torch.utils.data.Sampler):
    """Each epoch: every training artwork once as an anchor (the card back a few extra times), in
    batches of B, plus n_neg negative items per batch."""

    def __init__(self, train_idx, back_idx, b, n_neg, seed):
        self.train_idx, self.back_idx, self.b, self.n_neg, self.seed = list(train_idx), back_idx, b, n_neg, seed
        self.epoch = 0

    def epoch_batches(self, epoch):
        r = np.random.default_rng([self.seed, epoch])
        idx = self.train_idx + ([self.back_idx] * 30 if self.back_idx is not None else [])
        idx = list(r.permutation(idx))
        out = []
        for s in range(0, len(idx) - self.b + 1, self.b):
            chunk = idx[s:s + self.b]
            if len(set(chunk)) < len(chunk):  # the card back twice in one batch
                continue
            salt = epoch * 1_000_003 + s
            out.append([(int(i), salt) for i in chunk] + [(NEG, salt + j) for j in range(self.n_neg)])
        return out

    def __iter__(self):
        e = 0
        while True:
            for b in self.epoch_batches(e):
                yield b
            e += 1

    def __len__(self):
        return 1 << 30


def collate(items):
    v = torch.stack([x[0] for x in items])  # [n, K, 224, 224, 3]
    c = torch.stack([x[1] for x in items])
    i = torch.tensor([x[2] for x in items])
    return v, c, i


def near_duplicates(bank: torch.Tensor, cards: np.ndarray, rows: np.ndarray, thr: float) -> dict[int, list[int]]:
    """Training-bank columns whose artwork is almost identical (cos > thr) to another card's artwork."""
    out: dict[int, list[int]] = {}
    B = bank[rows]
    for s in range(0, len(rows), 2048):
        sims = B[s:s + 2048] @ B.T
        ii, jj = torch.nonzero(sims > thr, as_tuple=True)
        for a, b in zip((ii + s).tolist(), jj.tolist()):
            if cards[rows[a]] != cards[rows[b]]:
                out.setdefault(a, []).append(b)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="r1")
    ap.add_argument("--minutes", type=float, default=140, help="training wall-clock budget (evaluation excluded)")
    ap.add_argument("--max-epochs", type=int, default=100)
    ap.add_argument("--bs", type=int, default=64)
    ap.add_argument("--k", type=int, default=2)
    ap.add_argument("--neg", type=int, default=4)
    ap.add_argument("--neg-w", type=float, default=0.3)
    ap.add_argument("--neg-margin", type=float, default=0.3)
    ap.add_argument("--lr", type=float, default=3e-5)
    ap.add_argument("--decay", type=float, default=0.85)
    ap.add_argument("--wd", type=float, default=0.05)
    ap.add_argument("--first", type=int, default=4, help="first trainable transformer block")
    ap.add_argument("--tau", type=float, default=0.05)
    ap.add_argument("--std", type=int, default=1, help="in-graph per-channel input standardisation")
    ap.add_argument("--amp", default="bf16", choices=["none", "bf16", "fp16"])
    ap.add_argument("--workers", type=int, default=7)
    ap.add_argument("--warmup", type=int, default=150)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--bench", action="store_true")
    ap.add_argument("--resume", default="")
    ap.add_argument("--init", default="", help="start from this checkpoint's weights (a fine-tune; epoch 0 is still evaluated)")
    ap.add_argument("--fullfoil", type=float, default=0.0, help="chance of a full-card foil print per view (synth.py _fullfoil)")
    ap.add_argument("--select", default="default", choices=["default", "foil"],
                    help="best checkpoint: unseen video+hard top-1 (default), plus unseen foil top-1 (foil)")
    args = ap.parse_args()
    os.nice(10)
    torch.manual_seed(args.seed)
    dev = torch.device("mps")
    amp = {"none": None, "bf16": torch.bfloat16, "fp16": torch.float16}[args.amp]

    entries = index_entries()
    split = load_split()
    art = load_art_cache()
    N = len(entries)
    cards = np.array([e["cardId"] for e in entries])
    train_idx = np.array(split["trainIdx"])
    back_idx = next((i for i in train_idx if cards[i] == CARD_BACK_ID), None)
    col_of = np.full(N, -1)
    col_of[train_idx] = np.arange(len(train_idx))  # entry -> training-bank column
    bank_card = torch.tensor(cards[train_idx], device=dev)

    model = Embedder(standardize=bool(args.std)).to(dev)
    if args.resume or args.init:
        model.load_state_dict(torch.load(args.resume or args.init, map_location="cpu"))
    freeze_until(model, args.first)
    groups = param_groups(model, args.lr, args.decay, args.wd)
    opt = torch.optim.AdamW(groups, betas=(0.9, 0.98))
    n_train = sum(p.numel() for g in groups for p in g["params"])
    print(f"trainable params {n_train / 1e6:.1f}M (blocks {args.first}..11 + final norm), train artworks {len(train_idx)}, "
          f"held-out artworks {len(split['valIdx'])}", flush=True)

    out_dir = CKPT_DIR / args.run
    out_dir.mkdir(parents=True, exist_ok=True)
    log_path = LOGS / f"{args.run}.jsonl"
    embed = lambda x: embed_u8(model, x, dev, amp=amp)

    ds = Views(args.k, args.seed, args.fullfoil)
    sampler = Batches(train_idx, back_idx, args.bs, args.neg, args.seed)
    dl = torch.utils.data.DataLoader(ds, batch_sampler=sampler, num_workers=args.workers, collate_fn=collate,
                                     prefetch_factor=3, persistent_workers=True)
    it = iter(dl)
    steps_per_epoch = len(sampler.epoch_batches(0))

    if args.bench:
        bank = F.normalize(torch.randn(len(train_idx), 384, device=dev), dim=1)
        dups = {}
    else:
        from evalsuite import Suite, summary

        suite = Suite()
        t0 = time.time()
        bank_all = embed(art)
        dups = near_duplicates(bank_all, cards, train_idx, 0.95)
        print(f"initial bank {time.time() - t0:.0f}s; near-duplicate pairs {sum(map(len, dups.values()))}", flush=True)
        bank = bank_all[train_idx].to(dev)
        if not args.resume:
            res = suite.run(embed, bank_all)
            print("epoch 0 |", summary(res), flush=True)
            with open(log_path, "a") as f:
                f.write(json.dumps({"epoch": 0, "step": 0, "trainMin": 0, **res}) + "\n")

    def lr_factor(step, frac):
        return min(1.0, (step + 1) / args.warmup) * (0.05 + 0.95 * 0.5 * (1 + math.cos(math.pi * min(1.0, frac))))

    budget = args.minutes * 60
    train_time = 0.0
    step = 0
    best = -1.0
    epoch = 0
    stop = False
    losses = []
    step_times = []
    while not stop and epoch < args.max_epochs:
        epoch += 1
        t_epoch = time.time()
        for _ in range(steps_per_epoch):
            ts = time.time()
            views, clean, idx = next(it)
            is_neg = idx == NEG
            a_idx = idx[~is_neg]
            Bn = len(a_idx)
            K = views.shape[1]
            xd = views[~is_neg].reshape(-1, 224, 224, 3)
            xn = views[is_neg].reshape(-1, 224, 224, 3)
            xc = clean[~is_neg]
            x = to_input(torch.cat([xc, xd, xn]), dev)
            with torch.autocast("mps", dtype=amp, enabled=amp is not None):
                z = model(x)
            z = F.normalize(z.float(), dim=1)
            zc, zd, zn = z[:Bn], z[Bn:Bn + Bn * K], z[Bn + Bn * K:]
            a_cards = torch.tensor(cards[a_idx.numpy()], device=dev)
            v_cards = a_cards.repeat_interleave(K)
            v_anchor = torch.arange(Bn, device=dev).repeat_interleave(K)
            li = zd @ zc.T / args.tau
            same_in = v_cards[:, None] == a_cards[None, :]
            same_in[torch.arange(len(v_anchor), device=dev), v_anchor] = False
            li = li.masked_fill(same_in, float("-inf"))
            lb = zd @ bank.T / args.tau
            mask_b = v_cards[:, None] == bank_card[None, :]
            rows, cols = [], []
            for vi, e in enumerate(np.repeat(a_idx.numpy(), K)):
                for c in dups.get(int(col_of[e]), ()):
                    rows.append(vi)
                    cols.append(c)
            if rows:
                mask_b[torch.tensor(rows, device=dev), torch.tensor(cols, device=dev)] = True
            lb = lb.masked_fill(mask_b, float("-inf"))
            loss_pos = F.cross_entropy(torch.cat([li, lb], 1), v_anchor)
            loss = loss_pos
            loss_neg = torch.zeros((), device=dev)
            if len(zn):
                sn = torch.cat([zn @ zc.T, zn @ bank.T], 1)
                top = sn.topk(5, dim=1).values
                loss_neg = F.relu(top - args.neg_margin).pow(2).mean() * 10
                loss = loss + args.neg_w * loss_neg
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_([p for g in groups for p in g["params"]], 1.0)
            f = lr_factor(step, train_time / budget)
            for g in opt.param_groups:
                g["lr"] = g["base_lr"] * f
            opt.step()
            with torch.no_grad():  # rolling bank refresh with the anchors' fresh clean embeddings
                bank[torch.tensor(col_of[a_idx.numpy()], device=dev)] = zc.detach()
            step += 1
            losses.append((loss_pos.item(), loss_neg.item()))
            if args.bench:
                torch.mps.synchronize()
            step_times.append(time.time() - ts)
            train_time += step_times[-1]
            if args.bench and step >= 25:
                mem = torch.mps.driver_allocated_memory() / 1e9
                st = np.mean(step_times[-15:])
                print(f"bench: {step} steps, last 15 {st:.2f}s/step, {(Bn * (K + 1) + len(zn)) / st:.0f} img/s, "
                      f"driver mem {mem:.1f} GB, loss {loss_pos.item():.3f}", flush=True)
                os._exit(0)
            if step % 50 == 0:
                lp = np.mean([l[0] for l in losses[-50:]])
                ln = np.mean([l[1] for l in losses[-50:]])
                print(f"ep {epoch} step {step} loss {lp:.3f} neg {ln:.4f} lr {groups[-1]['lr']:.2e} "
                      f"{train_time / 60:.1f}/{args.minutes:.0f} train-min", flush=True)
            if train_time >= budget:
                stop = True
                break
        # ---- end of epoch: full bank refresh, evaluation, checkpoint
        t_eval = time.time()
        bank_all = embed(art)
        bank = bank_all[train_idx].to(dev)
        res = suite.run(embed, bank_all)
        # early stopping on the UNSEEN split: synthetic video + hard top-1 of cards never trained on,
        # subject to clean web top-1 >= 99% on seen and unseen cards alike
        score = res["synth-video/unseen"]["top1"] + res["synth-hard/unseen"]["top1"]
        if args.select == "foil":
            score += res["synth-foil/unseen"]["top1"]
        ok_web = min(res["web/seen"]["top1"], res["web/unseen"]["top1"]) >= 0.99
        ck = out_dir / f"epoch{epoch:02d}.pt"
        torch.save(model.state_dict(), ck)
        is_best = ok_web and score > best
        if is_best:
            best = score
            torch.save(model.state_dict(), out_dir / "best.pt")
        rec = {"epoch": epoch, "step": step, "trainMin": train_time / 60, "epochMin": (t_eval - t_epoch) / 60,
               "evalMin": (time.time() - t_eval) / 60, "loss": float(np.mean([l[0] for l in losses[-steps_per_epoch:]])),
               "lossNeg": float(np.mean([l[1] for l in losses[-steps_per_epoch:]])), "best": is_best, **res}
        with open(log_path, "a") as f:
            f.write(json.dumps(rec) + "\n")
        print(f"epoch {epoch} | {summary(res)} | loss {rec['loss']:.3f} | eval {rec['evalMin']:.1f} min{' | BEST' if is_best else ''}", flush=True)
    print("done", flush=True)
    os._exit(0)


if __name__ == "__main__":
    main()
