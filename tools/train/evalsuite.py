"""Per-epoch evaluation, all against the full index (every artwork, held-out ones included) with the
engine's per-card max and rotation merge:
  synth-video / synth-hard  fixed renderings of held-out artworks (this generator, other seeds)
  real / human / lowres     real crops (labelled quad inset 0 and 5%, plain box), see prepare.py real
  web                       YGOPRODeck card images cut at ART_BOX, 0 and 180 degrees
  synth-foil                fixed full-card foil renderings (synth.py _fullfoil, 'video' level), when
                            val/foil.npz exists (python tools/train/evalsuite.py build-foil)
  synth-overframe / -occl / -badge   the combined retrain's effects, fixed renderings ('video'), when
                            val/combined.npz exists (evalsuite.py build-combined)
  guard-pend / -link / -fixtures     CLEAN card images (YGOPRODeck cards_small: every pendulum card, the link
                            cards cached, and the E2E board's 8 cards) cut at ART_BOX upright as the engine cuts a
                            straightened card: top-1, the right card's score, and how many r2's thresholds would
                            call sure, when val/guard.npz exists (evalsuite.py build-guard)
Everything is reported for seen cards, unseen-random (5% of older cards) and unseen-new (released
>= 2026) separately; see prepare.py split.
Build the fixed query sets once: python tools/train/evalsuite.py build (and build-foil for the foil set)
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict

import numpy as np
import torch
from PIL import Image

from common import (ART_BOX, BENCH_REPORT, CARD_BACK_ID, CARDS_SMALL, REAL_DIR, VAL_DIR, art_box_px, index_entries,
                    load_art_cache, load_split, pil_resize_224)


GROUPS = ("seen", "unseen-random", "unseen-new")
WEB_DIR = VAL_DIR.parent / "web-small"


def _fetch_small(image_id: int):
    """YGOPRODeck's cards_small image (the benchmark's 'web' source), cached."""
    import time
    import urllib.request

    for p in (CARDS_SMALL / f"{image_id}.jpg", WEB_DIR / f"{image_id}.jpg"):
        if p.exists():
            return p
    req = urllib.request.Request(f"https://images.ygoprodeck.com/images/cards_small/{image_id}.jpg",
                                 headers={"User-Agent": "duel-lens-train/1.0"})
    try:
        data = urllib.request.urlopen(req, timeout=20).read()
    except Exception as err:
        print("skip", image_id, err)
        return None
    WEB_DIR.mkdir(parents=True, exist_ok=True)
    out = WEB_DIR / f"{image_id}.jpg"
    out.write_bytes(data)
    time.sleep(0.12)
    return out


def build(n: int = 400):
    """Per group (seen, unseen-random = the random 5% of older cards, unseen-new = released >= 2026):
    n artworks rendered once at 'video' and once at 'hard' (fixed seeds), and n web images (the card's
    cards_small image cut at ART_BOX, 0 and 180 degrees)."""
    from synth import Library, render

    VAL_DIR.mkdir(parents=True, exist_ok=True)
    entries = index_entries()
    art = load_art_cache()
    split = load_split()
    grp = {int(k): v for k, v in split["group"].items()}
    r = np.random.default_rng(12345)
    lib = Library(entries)
    out = {}
    for g in GROUPS:
        pool = [i for i, e in enumerate(entries) if e["cardId"] != CARD_BACK_ID and grp.get(e["cardId"]) == g]
        pick = np.sort(r.choice(pool, min(n, len(pool)), replace=False))
        out[f"{g}/idx"] = pick
        for lvl, seed in (("video", 1000), ("hard", 2000)):
            views = np.empty((len(pick), 224, 224, 3), np.uint8)
            for j, i in enumerate(pick):
                views[j] = render(np.asarray(art[i]), lib.kinds[i], lib, np.random.default_rng(seed + j + 7919 * GROUPS.index(g)), lvl)
            out[f"{g}/{lvl}"] = views
        crops, cards = [], []
        for i in r.permutation(pool)[: n]:
            p = _fetch_small(entries[i]["imageId"])
            if p is None:
                continue
            a = np.asarray(Image.open(p).convert("RGB"))
            for rot in (0, 180):
                c = a if rot == 0 else a[::-1, ::-1]
                x0, y0, x1, y1 = art_box_px(c.shape[1], c.shape[0], ART_BOX)
                crops.append(pil_resize_224(np.ascontiguousarray(c[y0:y1, x0:x1])))
            cards.append(entries[i]["cardId"])
        out[f"{g}/web"] = np.stack(crops)
        out[f"{g}/webCards"] = np.array(cards)
        print(f"{g}: synth {len(pick)} x (video, hard), web {len(cards)}", flush=True)
    np.savez(VAL_DIR / "groups.npz", **out)



FOIL_VAL = VAL_DIR / "foil.npz"


def build_foil(n: int = 200):
    """Per group, n artworks (other than build()'s picks where possible) rendered once at 'video' as full-card
    foil prints (synth.py _fullfoil, fixed seeds): the foil check of every epoch (val/foil.npz)."""
    from synth import Library, render

    entries = index_entries()
    art = load_art_cache()
    grp = {int(k): v for k, v in load_split()["group"].items()}
    taken = set()
    if (VAL_DIR / "groups.npz").exists():
        d = np.load(VAL_DIR / "groups.npz")
        taken = {int(i) for g in GROUPS for i in d[f"{g}/idx"]}
    r = np.random.default_rng(31337)
    lib = Library(entries)
    out = {}
    for g in GROUPS:
        pool = [i for i, e in enumerate(entries) if e["cardId"] != CARD_BACK_ID and grp.get(e["cardId"]) == g and i not in taken]
        pick = np.sort(r.choice(pool, min(n, len(pool)), replace=False))
        views = np.empty((len(pick), 224, 224, 3), np.uint8)
        for j, i in enumerate(pick):
            views[j] = render(np.asarray(art[i]), lib.kinds[i], lib, np.random.default_rng(3000 + j + 7919 * GROUPS.index(g)), "video", fullfoil=1.0)
        out[f"{g}/idx"] = pick
        out[f"{g}/foil"] = views
        print(f"{g}: foil {len(pick)}", flush=True)
    np.savez(FOIL_VAL, **out)

COMBINED_VAL = VAL_DIR / "combined.npz"
GUARD_VAL = VAL_DIR / "guard.npz"
EFFECTS = ("overframe", "occl", "badge")


def build_combined(n: int = 150):
    """Per group and effect (overframe, occluder, badge), n artworks rendered once at 'video' with that effect forced
    (synth.py render(mix=...), fixed seeds): val/combined.npz. The unseen pools are small, so effects may share
    artworks; the TEST sets' cards are left out (foil_set.py's synthetic foils, the overframe diagnosis's synthetic
    scenes), so checkpoint selection never sees them."""
    import json as _json

    from common import ROOT
    from synth import Library, render

    entries = index_entries()
    art = load_art_cache()
    grp = {int(k): v for k, v in load_split()["group"].items()}
    test_cards = set()
    for f in (ROOT / "data/train/foil/synth/manifest.json", ROOT / "data/debug/overframe/synth/truth.json"):
        if f.exists():
            test_cards |= {int(x["cardId"]) for x in _json.load(open(f))}
    print(f"test-set cards left out: {len(test_cards)}", flush=True)
    lib = Library(entries)
    train = [i for i, e in enumerate(entries) if grp.get(e["cardId"]) == "seen"]
    out = {}
    for ei, eff in enumerate(EFFECTS):
        r = np.random.default_rng(4242 + ei)
        for g in GROUPS:
            pool = [i for i, e in enumerate(entries) if e["cardId"] != CARD_BACK_ID and grp.get(e["cardId"]) == g
                    and e["cardId"] not in test_cards and (eff != "overframe" or lib.kinds[i][0] == "normal")]
            pick = np.sort(r.choice(pool, min(n, len(pool)), replace=False))
            views = np.empty((len(pick), 224, 224, 3), np.uint8)
            for j, i in enumerate(pick):
                rr = np.random.default_rng(5000 + 1000 * ei + j + 7919 * GROUPS.index(g))
                other = np.asarray(art[train[int(rr.integers(len(train)))]])
                views[j] = render(np.asarray(art[i]), lib.kinds[i], lib, rr, "video", mix={eff: 1.0}, other=other)
            out[f"{eff}/{g}/idx"] = pick
            out[f"{eff}/{g}/views"] = views
            print(f"{eff} {g}: {len(pick)}", flush=True)
    np.savez(COMBINED_VAL, **out)


def build_guard():
    """Clean card images cut at ART_BOX upright (the engine's cut of a straightened card): every pendulum card and
    every cached link card (YGOPRODeck cards_small, fetched and cached like build()'s web set), and the E2E board's 8
    cards (test/fixtures/cards): val/guard.npz. The foil run lost pendulum cards (foil-report.md); this is its guard."""
    from common import ROOT, load_cards

    entries = index_entries()
    cards = load_cards()
    out = {}
    sets = {
        "pend": [i for i, e in enumerate(entries) if cards.get(e["cardId"], {}).get("frameType", "").endswith("_pendulum")],
        "link": [i for i, e in enumerate(entries) if cards.get(e["cardId"], {}).get("frameType", "") == "link"],
    }
    by_image = {e["imageId"]: i for i, e in enumerate(entries)}
    for name, idx in sets.items():
        crops, cids = [], []
        for i in idx:
            p = _fetch_small(entries[i]["imageId"]) if name == "pend" else next((q for q in (CARDS_SMALL / f"{entries[i]['imageId']}.jpg", WEB_DIR / f"{entries[i]['imageId']}.jpg") if q.exists()), None)
            if p is None:
                continue
            a = np.asarray(Image.open(p).convert("RGB"))
            x0, y0, x1, y1 = art_box_px(a.shape[1], a.shape[0], ART_BOX)
            crops.append(pil_resize_224(np.ascontiguousarray(a[y0:y1, x0:x1])))
            cids.append(entries[i]["cardId"])
        out[f"{name}/views"] = np.stack(crops)
        out[f"{name}/cards"] = np.array(cids)
        print(f"{name}: {len(cids)}", flush=True)
    crops, cids = [], []
    for f in sorted((ROOT / "test/fixtures/cards").glob("*.jpg")):
        i = by_image.get(int(f.stem))
        if i is None:
            continue
        a = np.asarray(Image.open(f).convert("RGB"))
        x0, y0, x1, y1 = art_box_px(a.shape[1], a.shape[0], ART_BOX)
        crops.append(pil_resize_224(np.ascontiguousarray(a[y0:y1, x0:x1])))
        cids.append(entries[i]["cardId"])
    out["fixtures/views"] = np.stack(crops)
    out["fixtures/cards"] = np.array(cids)
    print(f"fixtures: {len(cids)}", flush=True)
    np.savez(GUARD_VAL, **out)


# r2's thresholds (src/shared/models.ts): a guard reading is "sure" when these would call it so.
SURE = lambda s, m: (s >= 0.80 and m >= 0.02) or (s >= 0.73 and m >= 0.10)


class Suite:
    def __init__(self):
        self.entries = index_entries()
        self.art = load_art_cache()
        cids = [e["cardId"] for e in self.entries]
        self.card_list = sorted(set(cids))
        pos = {c: k for k, c in enumerate(self.card_list)}
        self.card_idx = torch.tensor([pos[c] for c in cids])
        self.pos = pos
        d = np.load(VAL_DIR / "groups.npz")
        self.groups = {g: {k: d[f"{g}/{k}"] for k in ("idx", "video", "hard", "web", "webCards")} for g in GROUPS}
        self.foil = None
        if FOIL_VAL.exists():
            f = np.load(FOIL_VAL)
            self.foil = {g: {k: f[f"{g}/{k}"] for k in ("idx", "foil")} for g in GROUPS}
        self.combined = None
        if COMBINED_VAL.exists():
            f = np.load(COMBINED_VAL)
            self.combined = {eff: {g: {k: f[f"{eff}/{g}/{k}"] for k in ("idx", "views")} for g in GROUPS} for eff in EFFECTS}
        self.guard = None
        if GUARD_VAL.exists():
            f = np.load(GUARD_VAL)
            self.guard = {k: {"views": f[f"{k}/views"], "cards": f[f"{k}/cards"]} for k in ("pend", "link", "fixtures")}
        man = json.load(open(REAL_DIR / "manifest.json"))
        self.real_man = man
        self.real = np.stack([pil_resize_224(np.asarray(Image.open(REAL_DIR / m["file"]).convert("RGB"))) for m in man])
        grp = {int(k): v for k, v in load_split()["group"].items()}
        self.real_seen = {m["id"]: grp.get(m["cardId"], "seen") == "seen" for m in man}

    def card_scores(self, q: torch.Tensor, bank: torch.Tensor) -> torch.Tensor:
        sims = q @ bank.T
        out = torch.full((q.shape[0], len(self.card_list)), -2.0)
        return out.scatter_reduce(1, self.card_idx.expand(q.shape[0], -1), sims, reduce="amax")

    def ranks(self, scores: torch.Tensor, true_cards) -> np.ndarray:
        t = torch.tensor([self.pos[c] for c in true_cards])
        s_true = scores.gather(1, t[:, None])
        return ((scores > s_true).sum(1) + 1).numpy()

    def run(self, embed, bank: torch.Tensor | None = None) -> dict:
        """embed(uint8 array) -> L2-normalised CPU tensor. Returns metrics and per-sighting ranks."""
        if bank is None:
            bank = embed(self.art)
        res = {}
        acc = lambda rk: {"n": len(rk), "top1": float((rk == 1).mean()), "top5": float((rk <= 5).mean()), "medRank": float(np.median(rk))}
        for g, d in self.groups.items():
            true_cards = [self.entries[i]["cardId"] for i in d["idx"]]
            for lvl in ("video", "hard"):
                res[f"synth-{lvl}/{g}"] = acc(self.ranks(self.card_scores(embed(d[lvl]), bank), true_cards))
            sc = self.card_scores(embed(d["web"]), bank)
            res[f"web/{g}"] = acc(self.ranks(torch.maximum(sc[0::2], sc[1::2]), list(d["webCards"])))
        keys = ["synth-video", "synth-hard", "web"]
        if self.foil is not None:
            for g, d in self.foil.items():
                true_cards = [self.entries[i]["cardId"] for i in d["idx"]]
                res[f"synth-foil/{g}"] = acc(self.ranks(self.card_scores(embed(d["foil"]), bank), true_cards))
            keys.append("synth-foil")
        if self.combined is not None:
            for eff, per in self.combined.items():
                for g, d in per.items():
                    true_cards = [self.entries[i]["cardId"] for i in d["idx"]]
                    res[f"synth-{eff}/{g}"] = acc(self.ranks(self.card_scores(embed(d["views"]), bank), true_cards))
                keys.append(f"synth-{eff}")
        if self.guard is not None:
            for name, d in self.guard.items():
                sc = self.card_scores(embed(d["views"]), bank)
                t = torch.tensor([self.pos[int(c)] for c in d["cards"]])
                s_true = sc.gather(1, t[:, None])[:, 0]
                other = sc.scatter(1, t[:, None], -2.0)
                back = self.pos.get(CARD_BACK_ID)
                if back is not None:
                    other[:, back] = -2.0
                s_other = other.max(1).values
                top1 = (s_true > s_other)
                sure = [bool(tp) and SURE(float(a), float(a - b)) for tp, a, b in zip(top1, s_true, s_other)]
                res[f"guard-{name}"] = {"n": len(t), "top1": int(top1.sum()), "sure": int(sum(sure)),
                                        "meanScore": float(s_true.mean()), "medScore": float(s_true.median()),
                                        "minScore": float(s_true.min()), "meanLead": float((s_true - s_other).mean())}
        for k in keys:  # unseen = both unseen groups
            a, b = res[f"{k}/unseen-random"], res[f"{k}/unseen-new"]
            n = a["n"] + b["n"]
            res[f"{k}/unseen"] = {"n": n, "top1": (a["top1"] * a["n"] + b["top1"] * b["n"]) / n, "top5": (a["top5"] * a["n"] + b["top5"] * b["n"]) / n}
        sc = self.card_scores(embed(self.real), bank)
        groups = defaultdict(list)
        for k, m in enumerate(self.real_man):
            groups[(m["id"], m["variant"])].append(k)
            groups[(m["id"], "all")].append(k)
            if m["variant"].startswith("quad"):
                groups[(m["id"], "quad")].append(k)
        meta = {m["id"]: m for m in self.real_man}
        per = defaultdict(dict)
        for (sid, var), ks in groups.items():
            s = sc[ks].max(0).values[None]
            per[sid][var] = int(self.ranks(s, [meta[sid]["cardId"]])[0])
        sets = {"human": lambda m: m["set"] == "realset" and m["source"] == "human",
                "real": lambda m: m["set"] == "realset",
                "real-seen": lambda m: m["set"] == "realset" and self.real_seen[m["id"]],
                "real-unseen": lambda m: m["set"] == "realset" and not self.real_seen[m["id"]],
                "lowres": lambda m: m["set"] == "lowres",
                "lowres-seen": lambda m: m["set"] == "lowres" and self.real_seen[m["id"]],
                "lowres-unseen": lambda m: m["set"] == "lowres" and not self.real_seen[m["id"]]}
        for name, f in sets.items():
            ids = [sid for sid in per if f(meta[sid])]
            for var in ("quad0", "quad5", "box", "quad", "all"):
                rk = np.array([per[sid][var] for sid in ids])
                res[f"{name}-{var}"] = {"n": len(rk), "top1": int((rk == 1).sum()), "top5": int((rk <= 5).sum()), "medRank": float(np.median(rk)) if len(rk) else None}
        res["perSighting"] = {sid: dict(v) for sid, v in per.items()}
        return res


def summary(res: dict) -> str:
    f = lambda k: f"{100 * res[k]['top1']:.1f}"
    g = lambda k: f"{res[k]['top1']}/{res[k]['top5']}/{res[k]['n']}"
    foil = f"foil {f('synth-foil/seen')}/{f('synth-foil/unseen')} " if "synth-foil/seen" in res else ""
    for eff in EFFECTS:
        if f"synth-{eff}/seen" in res:
            foil += f"{eff} {f(f'synth-{eff}/seen')}/{f(f'synth-{eff}/unseen')} "
    for name in ("pend", "link", "fixtures"):
        if f"guard-{name}" in res:
            gd = res[f"guard-{name}"]
            foil += f"| {name} {gd['top1']}/{gd['sure']}/{gd['n']} s{gd['meanScore']:.3f} min{gd['minScore']:.3f} "
    return (f"video seen/unseen {f('synth-video/seen')}/{f('synth-video/unseen')} hard {f('synth-hard/seen')}/{f('synth-hard/unseen')} {foil}"
            f"web {f('web/seen')}/{f('web/unseen')} (new {f('web/unseen-new')}) | real q0 seen {g('real-seen-quad0')} unseen {g('real-unseen-quad0')} "
            f"human q0 {g('human-quad0')} q5 {g('human-quad5')} box {g('human-box')} | real29 q0 {g('real-quad0')} all {g('real-all')} | "
            f"lowres q0 {g('lowres-quad0')}")


if __name__ == "__main__":
    if sys.argv[1] == "build":
        build()
    elif sys.argv[1] == "build-foil":
        build_foil()
    elif sys.argv[1] == "build-combined":
        build_combined()
    elif sys.argv[1] == "build-guard":
        build_guard()
