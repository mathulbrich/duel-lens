"""The overnight harvest's real card crops as a training list for run r6-real (dinov2-small-duel-v3).

  python tools/train/real_data.py build [--out data/train/real-v3/list.json] [--no-embed]

Inputs (local, TRAIN videos only, overnight-p5-brief.md): data/overnight/labels/<video>.jsonl (auto labels per crop),
data/overnight/verified/{labeller-a,labeller-b,qc}.jsonl (the checkers). Never data/overnight/excluded, data/realset or
data/realset2, and nothing from a video whose split in data/overnight/videos.json isn't 'train'.

The binding filters (overnight-p5-brief.md, "QC results"):
  - every crop must exist (the lead deletes crops), and its short side px[0] must be in [45, 110) px (the faces guard:
    display walls and close-up zooms are >= 110 px; unverifiable washed-out crops < 45 px);
  - confident labels (QC final: 99.8%) are used, except (overnight-p3-qc.md, FINAL): Rite of Aramesir (Adventurer
    Tokens reuse its art), Dark Contract with the Different Dimension (a YCS-logo card), face-up tracks labelled -1,
    Blue-Eyes White Dragon under 0.85 (a playmat's Field Center card), tracks whose crop QC found upside down, and
    confident tracks whose best score is under 0.81 unless QC marked them correct;
  - propagated frames (QC final: 95.1%): QC's verdicts where it judged the frame (the most conservative line wins),
    otherwise only frames whose own top-1 is the label;
  - qc.jsonl: a source's crops are dropped when its verdict is wrong or unsure (per frame when a track is split into good
    and bad lines), the listed frames when usable is false; 'rule' lines apply to every matching track, and the same
    three rules (Aramesir, card back, the face wall) are applied here to material harvested after them;
  - labellers: 'labeled' tracks with a real card are the hard positives (weight --lab-w); 'not-a-card' and 'unknown'
    tracks are NEVER used (the lead, 02:42: cards only; not-a-card crops may show people), and neither is any 'none'
    crop no labeller identified as a card; a later line for a track supersedes an earlier one.
One entry per TRACK (its frames are one example, sampled with augmentation), with the card's artwork the anchor: the
index artwork of that card nearest r2's embedding of the crop (alternate artworks), and for the labellers' tracks the
crop's way up checked with r2 (0 or 180 degrees, whichever matches the card's artwork better).
Unseen-split cards (prepare.py split): the random 5% of older cards ('unseen-random') are left out entirely, so that
group's per-epoch numbers stay open-set; cards released in 2026 ('unseen-new') ARE used (they are what the 2026
events play), so the per-epoch 'unseen-new' numbers are no longer open-set for the cards with real crops.
"""
from __future__ import annotations

import argparse
import json
import os
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

from common import CARD_BACK_ID, DATA, ROOT, VAL_DIR, index_entries, load_cards, load_split

OVN = ROOT / "data" / "overnight"
OUT = DATA / "real-v3"
ARAMESIR = 3285551
DARK_CONTRACT_DD = 54936778  # QC final: every one was a purple card printed with the YCS logo
BLUE_EYES = 89631139
PX_MIN, PX_MAX = 45, 110
M_CROP = (1 - 1 / 1.08) / 2  # the harvest's crop = the card's quad grown 1.08x around its centre (4% per side)


def read_jsonl(p: Path) -> list[dict]:
    out = []
    if not p.exists():
        return out
    for line in open(p):
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass  # a line being written
    return out


def build(no_embed: bool, lab_w: float) -> dict:
    videos = json.load(open(OVN / "videos.json"))["videos"]
    train = {v["id"] for v in videos if v.get("split") == "train"}
    held = {v["id"] for v in videos if v.get("split") != "train"}
    entries = index_entries()
    by_card = defaultdict(list)
    for i, e in enumerate(entries):
        by_card[e["cardId"]].append(i)
    cards = load_cards()
    grp = {int(k): v for k, v in load_split()["group"].items()}
    # the random 5% of older cards stay unseen (open-set check); 2026 releases are used (the events play them)
    val_unseen = {c for c, g in grp.items() if g == "unseen-random"}
    stats = Counter()
    # ---- crops, by track
    tracks: dict[tuple, list[dict]] = defaultdict(list)
    for p in sorted((OVN / "labels").glob("*.jsonl")):
        if p.name.endswith(".moments.jsonl"):
            continue
        vid = p.name[:-len(".jsonl")]
        if vid not in train:
            stats["label files not train (skipped)"] += 1
            continue
        for d in read_jsonl(p):
            stats["crops"] += 1
            if not (ROOT / d["file"]).exists():
                stats["crops: file gone"] += 1
                continue
            px0 = d["px"][0]
            if px0 >= PX_MAX:
                stats["crops: px >= 110 (faces guard)"] += 1
                continue
            if px0 < PX_MIN:
                stats["crops: px < 45"] += 1
                continue
            tracks[(vid, d["moment"], d["track"])].append(d)
    # ---- checkers
    lab: dict[tuple, dict] = {}
    for f in ("labeller-a.jsonl", "labeller-b.jsonl"):
        for d in read_jsonl(OVN / "verified" / f):
            k = (d["video"], d["moment"], d["track"])
            if d["video"] in train:
                lab[k] = d  # a later line supersedes
    qc: dict[tuple, list[dict]] = defaultdict(list)
    for d in read_jsonl(OVN / "verified" / "qc.jsonl"):
        qc[(d["video"], d["moment"], d["track"], d.get("source"))].append(d)
    pos, neg = [], []
    for k, fr in tracks.items():
        vid, moment, tr = k
        fr.sort(key=lambda d: d["frame"])
        auto = fr[0]["cardId"]
        L = lab.get(k)
        if L is not None and L["status"] == "not-a-card":
            if auto is not None:
                stats["tracks: labeller not-a-card on an auto label (dropped)"] += 1
                continue
            stats["tracks: not-a-card (never used)"] += 1
            continue
        if L is not None and L["status"] == "labeled":
            cid = L["cardId"]
            if auto is not None and auto != cid:
                stats["tracks: labeller vs auto label disagree (dropped)"] += 1
                continue
            if cid is None or cid == CARD_BACK_ID or cid not in by_card or cid == ARAMESIR:
                stats["tracks: labeled, card not usable"] += 1
                continue
            keep = [d for d in fr if not (d.get("decision") == "confident" and d["top5"] and d["top5"][0]["cardId"] != cid)]
            if keep:
                pos.append({"key": list(k), "cardId": cid, "kind": "labeled", "category": L.get("category"), "files": [d["file"] for d in keep],
                            "orientation": [d.get("orientation") for d in keep], "px": [d["px"][0] for d in keep]})
                stats["tracks: labeled (hard positives)"] += 1
            continue
        if auto is None:
            continue
        # ---- an auto label
        if auto == CARD_BACK_ID:
            stats["tracks: label -1 (dropped)"] += 1
            continue
        if auto == ARAMESIR:
            stats["tracks: Rite of Aramesir (dropped)"] += 1
            continue
        if auto == DARK_CONTRACT_DD:
            stats["tracks: Dark Contract with the Different Dimension (dropped)"] += 1
            continue
        if fr[0]["kind"] != "face-up":
            stats["tracks: auto label on face-down (dropped)"] += 1
            continue
        if vid == "JggQN6Qm4uk":
            continue  # the face wall (excluded video; never here, but the rule stands)
        qconf, qprop = qc.get((vid, moment, tr, "confident"), []), qc.get((vid, moment, tr, "propagated"), [])
        if any("upside down" in (q.get("note") or "").lower() for q in qconf + qprop):
            stats["tracks: crop upside down per QC (dropped)"] += 1
            continue
        best = max((d["top5"][0]["score"] for d in fr if d["source"] == "confident" and d["top5"] and d["top5"][0]["cardId"] == auto), default=0.0)
        if auto == BLUE_EYES and best < 0.85:
            stats["tracks: Blue-Eyes under 0.85 (dropped)"] += 1
            continue
        if 0 < best < 0.81 and not any(q["verdict"] == "correct" for q in qconf):
            stats["tracks: confident under 0.81 not marked correct (dropped)"] += 1
            continue
        if auto not in by_card:
            stats["tracks: card not in the index"] += 1
            continue

        def verdict(lines, source_frames, split_ok):
            """Frames of one source to keep under the QC lines (None: no line). The most conservative verdict wins; a
            propagated track may be split into good and bad frames (split_ok)."""
            if not lines:
                return None
            bad = {f for q in lines if q["verdict"] in ("wrong", "unsure") or q.get("usable") is False for f in q.get("frames", [])}
            good = {f for q in lines if q["verdict"] == "correct" and q.get("usable") is not False for f in q.get("frames", [])}
            any_bad = any(q["verdict"] in ("wrong", "unsure") for q in lines)
            any_good = any(q["verdict"] == "correct" for q in lines)
            if any_bad and (not any_good or not split_ok):
                return set()
            if any_bad:  # a split propagated track: only the frames judged good
                return good - bad
            return set(source_frames) - bad

        conf_fr = [d for d in fr if d["source"] == "confident"]
        prop_fr = [d for d in fr if d["source"] == "propagated"]
        keep = []
        v = verdict(qconf, [d["frame"] for d in conf_fr], split_ok=False)
        if v is None:
            keep += conf_fr
        else:
            keep += [d for d in conf_fr if d["frame"] in v]
            stats["tracks: confident QC-judged"] += 1
            if len(v) < len(conf_fr):
                stats["crops: confident dropped by QC"] += len(conf_fr) - len(v)
        own = lambda d: bool(d["top5"]) and d["top5"][0]["cardId"] == auto
        v = verdict(qprop, [d["frame"] for d in prop_fr], split_ok=True)
        # QC's verdict where it judged the frame; an unjudged frame only when its own reading's top-1 is the label
        judged_good = {f for q in qprop if q["verdict"] == "correct" and q.get("usable") is not False for f in q.get("frames", [])}
        kp = [d for d in prop_fr if (v is None or d["frame"] in v) and (d["frame"] in judged_good or own(d))]
        stats["crops: propagated kept"] += len(kp)
        stats["crops: propagated dropped"] += len(prop_fr) - len(kp)
        keep += kp
        if not keep:
            stats["tracks: nothing left after QC"] += 1
            continue
        if auto in val_unseen:
            stats["tracks: unseen-random card (left out)"] += 1
            continue
        keep.sort(key=lambda d: d["frame"])
        pos.append({"key": list(k), "cardId": auto, "kind": "auto", "category": None, "files": [d["file"] for d in keep],
                    "orientation": [d.get("orientation") for d in keep], "px": [d["px"][0] for d in keep],
                    "prop": sum(d["source"] == "propagated" for d in keep)})
    # labeled tracks of cards in the unseen evaluation sets: left out too
    n0 = len(pos)
    pos = [p for p in pos if p["cardId"] not in val_unseen]
    stats["tracks: labeled unseen-random card (left out)"] += n0 - len(pos) - 0
    assert not any(k[0] in held for k in (tuple(p["key"]) for p in pos + neg))
    stats["positives"] = len(pos)
    stats["positives: auto"] = sum(p["kind"] == "auto" for p in pos)
    stats["positives: labeled"] = sum(p["kind"] == "labeled" for p in pos)
    stats["positive crops"] = sum(len(p["files"]) for p in pos)
    stats["distinct cards"] = len({p["cardId"] for p in pos})
    stats["distinct cards: unseen-new (2026)"] = len({p["cardId"] for p in pos if grp.get(p["cardId"], "seen") == "unseen-new"})
    stats["distinct cards: pendulum"] = len({p["cardId"] for p in pos if cards.get(p["cardId"], {}).get("frameType", "").endswith("_pendulum")})
    per_card = Counter(p["cardId"] for p in pos)
    stats["tracks per card: max"] = max(per_card.values()) if per_card else 0
    stats["tracks per card: median"] = float(np.median(list(per_card.values()))) if per_card else 0
    for p in pos:
        p["anchor"] = by_card[p["cardId"]][0]
        p["flip"] = False
        p["seen"] = grp.get(p["cardId"], "seen") == "seen"
    if not no_embed:
        choose_anchor_and_way_up(pos, by_card, stats)
        pos = [p for p in pos if not p.get("drop")]
        stats["positives after the way-up check"] = len(pos)
        stats["positives after the way-up check: labeled"] = sum(p["kind"] == "labeled" for p in pos)
    # weights: a card's auto tracks share at most `cap` units, labeled tracks lab_w each
    cap = 3.0
    for p in pos:
        p["w"] = lab_w if p["kind"] == "labeled" else min(1.0, cap / per_card[p["cardId"]])
    return {"built": time.strftime("%Y-%m-%d %H:%M:%S"), "stats": dict(stats), "pos": pos, "neg": neg, "mCrop": M_CROP}


def art_box_view(img: np.ndarray, flip: bool = False) -> np.ndarray:
    """The engine's quad reading of a harvest crop: the card (the crop without its 1.08 margin), ART_BOX, 224 px."""
    import cv2

    from synth import CROP, OUT
    from common import ART_BOX

    h, w = img.shape[:2]
    if flip:
        img = img[::-1, ::-1]
    x0, y0 = M_CROP * w, M_CROP * h
    cw, ch = w * (1 - 2 * M_CROP), h * (1 - 2 * M_CROP)
    q = np.float32([[x0, y0], [x0 + cw, y0], [x0 + cw, y0 + ch], [x0, y0 + ch]])
    unit = np.float32([[0, 0], [1, 0], [1, 1], [0, 1]])
    Hq = cv2.getPerspectiveTransform(unit, q)
    A_out = np.float64([[ART_BOX["w"] / CROP, 0, ART_BOX["x"]], [0, ART_BOX["h"] / CROP, ART_BOX["y"]], [0, 0, 1]])
    crop = cv2.warpPerspective(np.ascontiguousarray(img), Hq @ A_out, (CROP, CROP), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                               borderMode=cv2.BORDER_REPLICATE)
    return cv2.resize(crop, (OUT, OUT), interpolation=cv2.INTER_AREA)


def choose_anchor_and_way_up(pos: list[dict], by_card: dict, stats: Counter):
    """r2's embedding of each track's middle crop: the card's nearest artwork is the anchor (alternate artworks); the
    labellers' tracks are turned 180 degrees when that matches the card's artworks clearly better."""
    import cv2
    import torch

    from common import CKPT_DIR, load_art_cache
    from model import Embedder, embed_u8

    dev = torch.device("mps")
    model = Embedder(standardize=True)
    model.load_state_dict(torch.load(CKPT_DIR / "r2" / "best.pt", map_location="cpu"))
    model = model.to(dev).eval()
    art = load_art_cache()
    need = [p for p in pos if len(by_card[p["cardId"]]) > 1 or p["kind"] == "labeled"]
    imgs, own = [], []
    for j, p in enumerate(need):
        f = p["files"][len(p["files"]) // 2]
        im = cv2.cvtColor(cv2.imread(str(ROOT / f), cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)
        imgs.append(art_box_view(im))
        imgs.append(art_box_view(im, flip=True))
        own.append(j)
    if not imgs:
        return
    q = embed_u8(model, np.stack(imgs), dev, amp=torch.bfloat16)
    ids = sorted({i for p in need for i in by_card[p["cardId"]]})
    col = {i: c for c, i in enumerate(ids)}
    bank = embed_u8(model, np.stack([np.asarray(art[i]) for i in ids]), dev, amp=torch.bfloat16)
    s = q @ bank.T
    for j, p in enumerate(need):
        cols = [col[i] for i in by_card[p["cardId"]]]
        up, down = s[2 * j, cols], s[2 * j + 1, cols]
        u, dn = float(up.max()), float(down.max())
        flip = False
        if p["kind"] == "labeled":
            if all(o == "engine" for o in p["orientation"]):  # the engine's reading turned it: overrule only on clear evidence
                flip = dn > u + 0.05
            elif max(u, dn) >= 0.45 and abs(u - dn) > 0.02:  # no reading: r2 decides when it can tell
                flip = dn > u
            else:
                p["drop"] = True  # the way up can't be told
                stats["labeled tracks dropped: way up unknown"] += 1
        best = down if flip else up
        p["anchor"] = by_card[p["cardId"]][int(best.argmax())]
        p["flip"] = bool(flip)
        p["r2"] = round(float(best.max()), 4)
        if flip:
            stats["labeled tracks turned 180 by r2"] += 1
        if len(cols) > 1 and p["anchor"] != by_card[p["cardId"]][0]:
            stats["tracks anchored to an alternate artwork"] += 1


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["build"])
    ap.add_argument("--out", default=str(OUT / "list.json"))
    ap.add_argument("--no-embed", action="store_true")
    ap.add_argument("--lab-w", type=float, default=4.0, help="weight of a labeller's labeled track (hard positives)")
    a = ap.parse_args()
    t0 = time.time()
    res = build(a.no_embed, a.lab_w)
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    json.dump(res, open(tmp, "w"))
    os.replace(tmp, out)
    for k, v in res["stats"].items():
        print(f"{k}: {v}")
    print(f"-> {out} ({time.time() - t0:.0f} s)")
