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
  python tools/train/train.py --run r4-combined --init data/train/ckpt/r2/best.pt --mix combined --kd-view 8 \
      --kd-clean 8 --pend-x 2 --select combined ...
      (the combined retrain: full-card foils, overframes, occluders and count badges in the mix (synth.MIX), with
      r2 as a frozen teacher: views without those effects, and every anchor's clean artwork, are held to r2's
      embeddings (1 - cosine), pendulum artworks twice per epoch, and the best checkpoint must keep the clean
      guard sets (evalsuite build-guard) at r2's level; combined-retrain-report.md)
  python tools/train/train.py --run r6-real --init data/train/ckpt/r2/best.pt --real data/train/real-v3/list.json ...
      (dinov2-small-duel-v3, overnight-p5-brief.md: REAL card crops of the overnight harvest (real_data.py) join each
      batch as anchors of their own (the card's clean artwork, K views cut from its track's crops as the engine cuts
      a straightened card, never distilled), with not-a-card crops (sleeves, zones) as negatives; the synthetic chain,
      the combined effects and the anchoring to r2 as before)
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
REAL = -3  # a real track (key: REAL, salt, anchor, files, flip)
REALNEG = -4  # a real not-a-card track (key: REALNEG, salt, files)


def real_view(img: np.ndarray, r: np.random.Generator, m_crop: float) -> np.ndarray:
    """One engine-like reading of a harvest crop (176x256, the card's quad grown 1.08x): the card's quad with a
    detector-like error (the engine reads the fitted corners, the box and the 1.08-grown quad), its ART_BOX cut at
    448 px and resized to 224, then a mild photometric and codec jitter (the crop is real footage already)."""
    import cv2

    from common import ART_BOX
    from synth import CROP, OUT, U

    h, w = img.shape[:2]
    cw, ch = w * (1 - 2 * m_crop), h * (1 - 2 * m_crop)
    u = r.random()
    grow = 1.0 if u < 0.5 else 1.08 if u < 0.7 else U(r, 0.97, 1.08)
    sc = grow * U(r, 0.97, 1.03)
    ex, ey = cw * sc * U(r, 0.98, 1.02), ch * sc * U(r, 0.98, 1.02)
    cx = w / 2 + U(r, -0.025, 0.025) * cw
    cy = h / 2 + U(r, -0.035, 0.02) * ch
    t = math.radians(U(r, -2.0, 2.0))
    loc = np.float32([[-ex / 2, -ey / 2], [ex / 2, -ey / 2], [ex / 2, ey / 2], [-ex / 2, ey / 2]])
    loc = loc @ np.float32([[math.cos(t), -math.sin(t)], [math.sin(t), math.cos(t)]]).T
    loc += r.uniform(-0.01, 0.01, (4, 2)).astype(np.float32) * cw
    q = (loc + np.float32([cx, cy])).astype(np.float32)
    unit = np.float32([[0, 0], [1, 0], [1, 1], [0, 1]])
    Hq = cv2.getPerspectiveTransform(unit, q)
    A_out = np.float64([[ART_BOX["w"] / CROP, 0, ART_BOX["x"]], [0, ART_BOX["h"] / CROP, ART_BOX["y"]], [0, 0, 1]])
    crop = cv2.warpPerspective(img, Hq @ A_out, (CROP, CROP), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                               borderMode=cv2.BORDER_REPLICATE)
    x = cv2.resize(crop, (OUT, OUT), interpolation=cv2.INTER_AREA).astype(np.float32)
    if r.random() < 0.5:  # exposure, contrast, white balance, saturation, gamma
        x = x * U(r, 0.85, 1.15) + U(r, -12, 12)
        x = (x - x.mean()) * U(r, 0.85, 1.15) + x.mean()
        x *= np.float32([U(r, 0.95, 1.05), U(r, 0.95, 1.05), U(r, 0.95, 1.05)])
        luma = x @ np.float32([0.299, 0.587, 0.114])
        x = luma[..., None] + U(r, 0.8, 1.2) * (x - luma[..., None])
        x = 255 * np.power(np.clip(x, 0, 255) / 255, U(r, 0.85, 1.2))
    if r.random() < 0.2:
        x = cv2.GaussianBlur(x, (0, 0), U(r, 0.3, 0.9))
    if r.random() < 0.2:  # resolution loss
        f = U(r, 0.55, 0.9)
        x = cv2.resize(cv2.resize(x, (int(OUT * f), int(OUT * f)), interpolation=cv2.INTER_AREA), (OUT, OUT), interpolation=cv2.INTER_LINEAR)
    x8 = np.clip(x, 0, 255).astype(np.uint8)
    if r.random() < 0.35:
        ok, buf = cv2.imencode(".jpg", cv2.cvtColor(x8, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, int(U(r, 40, 90))])
        x8 = cv2.cvtColor(cv2.imdecode(buf, cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)
    return x8


def load_crop(path: str, flip: bool = False) -> np.ndarray:
    import cv2

    from common import ROOT

    im = cv2.imread(str(ROOT / path), cv2.IMREAD_COLOR)
    if im is None:  # deleted since the list was built
        return None
    im = cv2.cvtColor(im, cv2.COLOR_BGR2RGB)
    return np.ascontiguousarray(im[::-1, ::-1]) if flip else im


class Views(torch.utils.data.Dataset):
    """Item = (K degraded views, clean view, index); index NEG renders K negative views."""

    def __init__(self, k: int, seed: int, fullfoil: float = 0.0, mix: dict | None = None, m_crop: float = (1 - 1 / 1.08) / 2):
        self.k, self.seed, self.fullfoil, self.mix, self.m_crop = k, seed, fullfoil, mix, m_crop
        self.lib = None
        self.epoch = 0

    def __len__(self):
        return 1 << 30

    def __getitem__(self, key):
        i, salt = key[0], key[1]
        if self.lib is None:
            from synth import Library

            self.entries = index_entries()
            self.lib = Library(self.entries)
            self.art = load_art_cache()
            self.train_idx = np.array(load_split()["trainIdx"])
        from synth import mixed_level, render

        if i in (REAL, REALNEG):  # a real track: K engine-like readings of its crops (never distilled)
            r = np.random.default_rng([self.seed, salt, 7])
            files, flip = (key[3], key[4]) if i == REAL else (key[2], False)
            views = []
            for _ in range(self.k * 3):
                im = load_crop(files[int(r.integers(len(files)))], flip)
                if im is not None:
                    views.append(real_view(im, r, self.m_crop))
                if len(views) == self.k:
                    break
            while len(views) < self.k:  # every crop gone: the clean artwork, lightly jittered (keeps the batch whole)
                views.append(np.asarray(self.art[key[2]]) if i == REAL else np.zeros((224, 224, 3), np.uint8))
            clean = np.asarray(self.art[key[2]]) if i == REAL else np.zeros((224, 224, 3), np.uint8)
            return (torch.from_numpy(np.stack(views)), torch.from_numpy(np.ascontiguousarray(clean)),
                    key[2] if i == REAL else NEG, torch.ones(self.k, dtype=torch.bool))
        r = np.random.default_rng([self.seed, salt, i + 3])
        new = np.zeros(self.k, np.bool_)  # which views got a combined-retrain effect (no distillation on those)
        if i == NEG:
            views = [render(None, ("neg", None), self.lib, r, mixed_level(r), mix=self.mix) for _ in range(self.k)]
            clean = np.zeros((224, 224, 3), np.uint8)
        else:
            a = np.asarray(self.art[i])
            views = []
            for v in range(self.k):
                info = {}
                other = np.asarray(self.art[self.train_idx[int(r.integers(len(self.train_idx)))]]) if self.mix else None
                views.append(render(a, self.lib.kinds[i], self.lib, r, mixed_level(r), fullfoil=self.fullfoil, mix=self.mix,
                                    info=info, other=other))
                new[v] = bool(info.get("new"))
            clean = a
        return torch.from_numpy(np.stack(views)), torch.from_numpy(np.ascontiguousarray(clean)), i, torch.from_numpy(new)


class Batches(torch.utils.data.Sampler):
    """Each epoch: every training artwork once as an anchor (the card back a few extra times), in
    batches of B, plus n_neg negative items per batch."""

    def __init__(self, train_idx, back_idx, b, n_neg, seed, extra=(), real=None, n_real=0, n_real_neg=0, frac=1.0):
        self.train_idx, self.back_idx, self.b, self.n_neg, self.seed = list(train_idx), back_idx, b, n_neg, seed
        self.extra = list(extra)  # anchors seen once more per epoch (--pend-x: pendulum artworks)
        self.epoch = 0
        self.frac = frac  # the share of the synthetic anchors per epoch (shorter epochs: more checkpoints)
        self.n_real, self.n_real_neg = n_real, n_real_neg
        self.set_real(real)

    def set_real(self, real):
        """The real list (real_data.py): positives drawn with probability by weight, negatives uniformly."""
        self.real = real
        if real:
            w = np.array([p["w"] for p in real["pos"]], np.float64)
            self.real_p = w / w.sum()

    def epoch_batches(self, epoch):
        r = np.random.default_rng([self.seed, epoch])
        idx = self.train_idx + self.extra + ([self.back_idx] * 30 if self.back_idx is not None else [])
        idx = list(r.permutation(idx))
        if self.frac < 1:
            idx = idx[:int(len(idx) * self.frac)]
        out = []
        for s in range(0, len(idx) - self.b + 1, self.b):
            chunk = idx[s:s + self.b]
            if len(set(chunk)) < len(chunk):  # the card back twice in one batch
                continue
            salt = epoch * 1_000_003 + s
            batch = [(int(i), salt) for i in chunk] + [(NEG, salt + j) for j in range(self.n_neg)]
            if self.real and self.n_real:
                pos, neg = self.real["pos"], self.real["neg"]
                for j, t in enumerate(r.choice(len(pos), self.n_real, p=self.real_p)):
                    p = pos[int(t)]
                    batch.append((REAL, salt + 101 + j, int(p["anchor"]), tuple(p["files"]), bool(p.get("flip"))))
                if neg and self.n_real_neg:
                    for j, t in enumerate(r.choice(len(neg), self.n_real_neg)):
                        batch.append((REALNEG, salt + 201 + j, tuple(neg[int(t)]["files"])))
            out.append(batch)
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
    new = torch.stack([x[3] for x in items])  # [n, K]
    return v, c, i, new


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
    ap.add_argument("--select", default="default", choices=["default", "foil", "combined"],
                    help="best checkpoint: unseen video+hard top-1 (default), plus unseen foil top-1 (foil), plus unseen "
                         "overframe, occluder and badge top-1 with the clean guards held (combined)")
    ap.add_argument("--mix", default="", help="'combined' (synth.MIX), 'combined-v2' (synth.MIX_V2) or a JSON dict of per-view effect chances")
    ap.add_argument("--guard-ref", default="", help="a run's log (.jsonl) whose epoch-0 record the clean guards are held to "
                                                     "(default: this run's epoch 0); for a continuation, the teacher's (r2's) own record")
    ap.add_argument("--kd-view", type=float, default=0.0, help="weight of 1-cos(student, teacher) on views without a new effect")
    ap.add_argument("--kd-clean", type=float, default=0.0, help="weight of 1-cos(student, teacher) on the anchors' clean artworks")
    ap.add_argument("--teacher", default="", help="the frozen teacher's checkpoint (default: --init)")
    ap.add_argument("--pend-x", type=int, default=1, help="pendulum artworks per epoch (2: twice)")
    ap.add_argument("--kd-pend-x", type=float, default=1.0, help="the distillation terms' weight on pendulum anchors "
                                                                  "(their views and clean artwork), relative to the others")
    ap.add_argument("--real", default="", help="real_data.py's list (real card crops of the overnight harvest)")
    ap.add_argument("--real-bs", type=int, default=24, help="real tracks per batch (anchors of their own)")
    ap.add_argument("--real-neg", type=int, default=2, help="real not-a-card tracks per batch (negatives)")
    ap.add_argument("--epoch-frac", type=float, default=1.0, help="share of the synthetic anchors per epoch")
    ap.add_argument("--real-reload", action="store_true", help="re-read --real at each epoch's end when the file changed "
                                                                 "(the harvest and the checkers keep adding material)")
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

    mix = None
    if args.mix:
        from synth import MIX, MIX_V2

        mix = dict(MIX) if args.mix == "combined" else dict(MIX_V2) if args.mix == "combined-v2" else json.loads(args.mix)
        print(f"mix {mix}", flush=True)
    extra = []
    from common import load_cards

    cmap = load_cards()
    is_pend = torch.tensor([cmap.get(int(c), {}).get("frameType", "").endswith("_pendulum") for c in cards])
    if args.pend_x > 1:
        pend = [int(i) for i in train_idx if cmap.get(int(cards[i]), {}).get("frameType", "").endswith("_pendulum")]
        extra = pend * (args.pend_x - 1)
        print(f"pendulum anchors x{args.pend_x}: {len(pend)}", flush=True)
    teacher = None
    if args.kd_view > 0 or args.kd_clean > 0:
        teacher = Embedder(standardize=bool(args.std)).to(dev)
        teacher.load_state_dict(torch.load(args.teacher or args.init, map_location="cpu"))
        teacher.eval()
        for p_ in teacher.parameters():
            p_.requires_grad_(False)
        print(f"teacher {args.teacher or args.init}: kd-view {args.kd_view} kd-clean {args.kd_clean}", flush=True)
    real = None
    real_mtime = None
    if args.real:
        real_mtime = os.path.getmtime(args.real)
        real = json.load(open(args.real))
        print(f"real list {args.real} (built {real['built']}): {len(real['pos'])} tracks "
              f"({sum(p['kind'] == 'labeled' for p in real['pos'])} labeled), {len(real['neg'])} negative tracks; "
              f"{args.real_bs} + {args.real_neg} per batch", flush=True)
    ds = Views(args.k, args.seed, args.fullfoil, mix, real["mCrop"] if real else (1 - 1 / 1.08) / 2)
    sampler = Batches(train_idx, back_idx, args.bs, args.neg, args.seed, extra, real, args.real_bs, args.real_neg, args.epoch_frac)
    dl = torch.utils.data.DataLoader(ds, batch_sampler=sampler, num_workers=args.workers, collate_fn=collate,
                                     prefetch_factor=3, persistent_workers=True)
    it = iter(dl)
    steps_per_epoch = len(sampler.epoch_batches(0))

    teacher_bank = None
    res0 = None
    if args.bench:
        bank = F.normalize(torch.randn(len(train_idx), 384, device=dev), dim=1)
        teacher_bank = F.normalize(torch.randn(N, 384, device=dev), dim=1)
        dups = {}
    else:
        from evalsuite import Suite, summary

        suite = Suite()
        t0 = time.time()
        bank_all = embed(art)
        dups = near_duplicates(bank_all, cards, train_idx, 0.95)
        print(f"initial bank {time.time() - t0:.0f}s; near-duplicate pairs {sum(map(len, dups.values()))}", flush=True)
        bank = bank_all[train_idx].to(dev)
        # the teacher's clean embeddings (= the start's, when the teacher is --init): the anchors' clean targets
        teacher_bank = (bank_all if not args.teacher else embed_u8(teacher, art, dev, amp=amp)).to(dev) if teacher is not None else None
        res0 = None
        if not args.resume:
            res = suite.run(embed, bank_all)
            res0 = res
            print("epoch 0 |", summary(res), flush=True)
            with open(log_path, "a") as f:
                f.write(json.dumps({"epoch": 0, "step": 0, "trainMin": 0, **res}) + "\n")
        if args.guard_ref:  # the guards' reference: another run's epoch 0 (r2's own numbers for a continuation)
            res0 = next(r for r in map(json.loads, open(args.guard_ref)) if r["epoch"] == 0)
            print(f"guards held to epoch 0 of {args.guard_ref}", flush=True)

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
            views, clean, idx, vnew = next(it)
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
            loss_kd = torch.zeros((), device=dev)
            if teacher is not None:
                std_rows = torch.nonzero(~vnew[~is_neg].reshape(-1)).flatten()
                # pendulum anchors' terms weigh kd-pend-x times as much (their top-60% cut leans on colour)
                w_anchor = torch.where(is_pend[a_idx], args.kd_pend_x, 1.0).float().to(dev)
                if args.kd_view > 0 and len(std_rows):
                    with torch.no_grad(), torch.autocast("mps", dtype=amp, enabled=amp is not None):
                        zt = teacher(x[Bn + std_rows.to(dev)])
                    zt = F.normalize(zt.float(), dim=1)
                    w = w_anchor[std_rows.to(dev) // K]
                    loss_kd = loss_kd + args.kd_view * (w * (1 - (zd[std_rows.to(dev)] * zt).sum(1))).mean()
                if args.kd_clean > 0:
                    tc = teacher_bank[a_idx.to(dev)]
                    loss_kd = loss_kd + args.kd_clean * (w_anchor * (1 - (zc * tc).sum(1))).mean()
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
                for c in (dups.get(int(col_of[e]), ()) if col_of[e] >= 0 else ()):
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
            loss = loss + loss_kd
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_([p for g in groups for p in g["params"]], 1.0)
            f = lr_factor(step, train_time / budget)
            for g in opt.param_groups:
                g["lr"] = g["base_lr"] * f
            opt.step()
            with torch.no_grad():  # rolling bank refresh with the anchors' fresh clean embeddings
                cols = col_of[a_idx.numpy()]
                ok = cols >= 0  # a real track of a 2026 card: its artwork has no bank column
                if ok.all():
                    bank[torch.tensor(cols, device=dev)] = zc.detach()
                elif ok.any():
                    bank[torch.tensor(cols[ok], device=dev)] = zc.detach()[torch.tensor(np.nonzero(ok)[0], device=dev)]
            step += 1
            losses.append((loss_pos.item(), loss_neg.item(), loss_kd.item()))
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
                lk = np.mean([l[2] for l in losses[-50:]])
                print(f"ep {epoch} step {step} loss {lp:.3f} neg {ln:.4f} kd {lk:.4f} lr {groups[-1]['lr']:.2e} "
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
        if args.select in ("foil", "combined"):
            score += res["synth-foil/unseen"]["top1"]
        ok_web = min(res["web/seen"]["top1"], res["web/unseen"]["top1"]) >= 0.99
        guards = {}
        if args.select == "combined":
            for eff in ("overframe", "occl", "badge"):
                score += res[f"synth-{eff}/unseen"]["top1"]
            # the clean guards, against the start (epoch 0 = the teacher, r2): pendulum and link cards and the E2E
            # board's cards read as surely (at most 1% fewer sure) and as high (mean right-card score at most 0.01
            # lower; the board's lowest at most 0.015 lower); the real crops' top-1 kept
            if res0 is not None:
                for name in ("pend", "link", "fixtures"):
                    a, b = res[f"guard-{name}"], res0[f"guard-{name}"]
                    guards[name] = (a["top1"] >= b["top1"] - max(1, int(0.01 * b["n"])) and a["sure"] >= b["sure"] - max(1, int(0.01 * b["n"]))
                                    and a["meanScore"] >= b["meanScore"] - 0.01 and a["minScore"] >= b["minScore"] - (0.015 if name == "fixtures" else 1))
                guards["real"] = res["real-quad0"]["top1"] >= res0["real-quad0"]["top1"] and res["lowres-quad0"]["top1"] >= res0["lowres-quad0"]["top1"] - 1
            ok_web = ok_web and all(guards.values())
        if real is not None and args.real_reload and os.path.getmtime(args.real) != real_mtime:
            real_mtime = os.path.getmtime(args.real)
            real = json.load(open(args.real))
            sampler.set_real(real)
            print(f"real list reloaded (built {real['built']}): {len(real['pos'])} tracks "
                  f"({sum(p['kind'] == 'labeled' for p in real['pos'])} labeled), {len(real['neg'])} negative tracks", flush=True)
        ck = out_dir / f"epoch{epoch:02d}.pt"
        torch.save(model.state_dict(), ck)
        is_best = ok_web and score > best
        if is_best:
            best = score
            torch.save(model.state_dict(), out_dir / "best.pt")
        rec = {"epoch": epoch, "step": step, "trainMin": train_time / 60, "epochMin": (t_eval - t_epoch) / 60,
               "evalMin": (time.time() - t_eval) / 60, "loss": float(np.mean([l[0] for l in losses[-steps_per_epoch:]])),
               "lossNeg": float(np.mean([l[1] for l in losses[-steps_per_epoch:]])),
               "lossKd": float(np.mean([l[2] for l in losses[-steps_per_epoch:]])), "guards": guards, "selScore": score,
               "best": is_best, "realBuilt": real["built"] if real is not None else None, **res}
        with open(log_path, "a") as f:
            f.write(json.dumps(rec) + "\n")
        print(f"epoch {epoch} | {summary(res)} | loss {rec['loss']:.3f} kd {rec['lossKd']:.4f} | sel {score:.3f} guards {guards} | "
              f"eval {rec['evalMin']:.1f} min{' | BEST' if is_best else ''}", flush=True)
    print("done", flush=True)
    os._exit(0)


if __name__ == "__main__":
    main()
