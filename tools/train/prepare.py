"""Data preparation for the embedder fine-tuning. Run each step once (they are idempotent).

  python tools/train/prepare.py cache       224x224 uint8 cache of every index artwork (data/train/cache)
  python tools/train/prepare.py split       unseen cards (released >= 2026 + a random 5% of older cards)
  python tools/train/prepare.py templates   full-card frame templates from YGOPRODeck (cards_small)
  python tools/train/prepare.py real        real ground-truth art crops from the real set's labelled quads (data/train/real)
  python tools/train/prepare.py all
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from multiprocessing import Pool

import cv2
import numpy as np
from PIL import Image

from common import (ART_BOX, ART_CACHE, ARTWORKS, BENCH_REPORT, CARD_BACK, CARD_BACK_ID, CARD_H, CARD_W,
                    CACHE_DIR, ENTRIES, FRAMES_DIR, GT_CARDS, REAL_DIR, ROOT, S, SPLIT, TEACHER_OUT, TEMPLATES,
                    art_box_px, load_cards)


# ---------------------------------------------------------------- cache

def _load_one(image_id: int) -> np.ndarray:
    p = CARD_BACK if image_id == CARD_BACK_ID else ARTWORKS / f"{image_id}.jpg"
    # Pillow BILINEAR is the antialiased triangle filter of src/shared/preprocess.ts.
    return np.asarray(Image.open(p).convert("RGB").resize((S, S), Image.BILINEAR), dtype=np.uint8)


def build_cache():
    if ART_CACHE.exists() and ENTRIES.exists():
        print("cache exists:", ART_CACHE)
        return
    meta = json.load(open(ROOT / "extension/data/index-dinov2-small.meta.json"))
    entries = meta["entries"]
    ids = [e["imageId"] for e in entries]
    tmp = CACHE_DIR / "art224.tmp.npy"
    out = np.lib.format.open_memmap(tmp, mode="w+", dtype=np.uint8, shape=(len(ids), S, S, 3))
    t0 = time.time()
    with Pool(6) as pool:
        for i, a in enumerate(pool.imap(_load_one, ids, chunksize=64)):
            out[i] = a
            if (i + 1) % 2000 == 0:
                print(f"  {i + 1}/{len(ids)} {time.time() - t0:.0f}s", flush=True)
    out.flush()
    del out
    tmp.rename(ART_CACHE)
    # Original sizes tell pendulum illustrations (712x908) apart from square artworks.
    for e in entries:
        p = CARD_BACK if e["imageId"] == CARD_BACK_ID else ARTWORKS / f"{e['imageId']}.jpg"
        e["size"] = list(Image.open(p).size)
    json.dump(entries, open(ENTRIES, "w"))
    print(f"cache {len(ids)} x {S}x{S}x3 in {time.time() - t0:.0f}s")


# ---------------------------------------------------------------- split

def first_release() -> dict[int, str]:
    """Earliest TCG/OCG release date per card id (YGOPRODeck misc_info), '' when unknown."""
    raw = json.load(open(ROOT / "data" / "raw" / "cardinfo.json"))["data"]
    out = {}
    for c in raw:
        ds = [m.get(k) for m in c.get("misc_info") or [] for k in ("tcg_date", "ocg_date") if m.get(k)]
        out[c["id"]] = min(ds) if ds else ""
    return out


def build_split():
    """Unseen cards (never trained on, not even as negatives; still in the index):
      - new: every card first released on or after 2026-01-01 (tcg_date/ocg_date), which covers the
        2026 cards of the real set (the Sacred Beasts, Hyperinvoked Aeon, Aiwass, ...);
      - random: a seeded random 5% of the older cards, a clean unseen split beyond 2026.
    Everything else (and the card back) is seen."""
    entries = json.load(open(ENTRIES))
    dates = first_release()
    cards = sorted({e["cardId"] for e in entries if e["cardId"] != CARD_BACK_ID})
    new = {c for c in cards if dates.get(c, "") >= "2026-01-01"}
    older = [c for c in cards if c not in new]
    rng = np.random.default_rng(2026)
    rand = set(rng.choice(older, int(round(0.05 * len(older))), replace=False).tolist())
    held = new | rand
    realset = ROOT / "data" / "realset" / "set.json"
    rs = json.load(open(realset)) if realset.exists() else []
    train = [i for i, e in enumerate(entries) if e["cardId"] not in held]
    val = [i for i, e in enumerate(entries) if e["cardId"] in held]
    group = {c: ("unseen-new" if c in new else "unseen-random" if c in rand else "seen") for c in cards}
    json.dump({"heldOutCards": sorted(held), "newCards": sorted(new), "randomCards": sorted(rand), "group": group,
               "trainIdx": train, "valIdx": val}, open(SPLIT, "w"))
    rs_groups = {}
    for e in rs:
        rs_groups.setdefault(group.get(int(e["cardId"]), "seen"), set()).add(e["name"])
    print(f"unseen cards {len(held)}: {len(new)} released >= 2026, {len(rand)} random older (5%); "
          f"train artworks {len(train)}, unseen artworks {len(val)}")
    for g, names in sorted(rs_groups.items()):
        print(f"  real set, {g}: {sorted(names)}")


# ---------------------------------------------------------------- templates

TEMPLATE_QUOTA = {"effect": 40, "spell": 30, "trap": 30, "normal": 20, "xyz": 20, "fusion": 20, "synchro": 20,
                  "link": 20, "ritual": 12, "effect_pendulum": 16, "normal_pendulum": 4, "fusion_pendulum": 3,
                  "xyz_pendulum": 3, "synchro_pendulum": 3, "token": 4}


def build_templates():
    """Full-card images (YGOPRODeck cards_small, 168x246) of training cards: their frame, name bar,
    stars and text box surround the pasted artwork, so misframed crops bleed in real frame detail."""
    cards = load_cards()
    held = set(json.load(open(SPLIT))["heldOutCards"])
    rng = np.random.default_rng(7)
    ids = list(cards)
    rng.shuffle(ids)
    got = {k: 0 for k in TEMPLATE_QUOTA}
    manifest = []
    have = {p.stem for p in TEMPLATES.glob("*.jpg")}
    for cid in ids:
        c = cards[cid]
        ft = c.get("frameType")
        if ft not in TEMPLATE_QUOTA or got[ft] >= TEMPLATE_QUOTA[ft] or cid in held:
            continue
        img_id = c["imageIds"][0]
        out = TEMPLATES / f"{img_id}.jpg"
        if str(img_id) not in have:
            try:
                req = urllib.request.Request(f"https://images.ygoprodeck.com/images/cards_small/{img_id}.jpg",
                                             headers={"User-Agent": "duel-lens-train/1.0"})
                out.write_bytes(urllib.request.urlopen(req, timeout=20).read())
                time.sleep(0.15)
            except Exception as err:
                print("skip", img_id, err)
                continue
        got[ft] += 1
        manifest.append({"imageId": img_id, "cardId": cid, "frameType": ft})
        if all(got[k] >= v for k, v in TEMPLATE_QUOTA.items()):
            break
    json.dump(manifest, open(TEMPLATES / "manifest.json", "w"), indent=1)
    print("templates", got)


# ---------------------------------------------------------------- real crops

def warp_quad(img: np.ndarray, pts, out_w: int, out_h: int) -> np.ndarray:
    """The card straightened from its 4 corners (pts: TL, TR, BR, BL, frame pixels) to out_w x out_h, as
    src/offscreen/geometry.ts's warpQuad does: pixel centres at half-integers, bilinear, black outside the
    frame. OpenCV puts pixel centres at integers, so both quads move by half a pixel; the map goes from
    output pixels to frame pixels (WARP_INVERSE_MAP)."""
    out_corners = np.float32([[0, 0], [out_w, 0], [out_w, out_h], [0, out_h]]) - 0.5
    m = cv2.getPerspectiveTransform(out_corners, np.float32(pts) - 0.5)
    return cv2.warpPerspective(img, m, (out_w, out_h), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                               borderMode=cv2.BORDER_CONSTANT, borderValue=0)


def art_of_card(card: np.ndarray, rotation: int) -> np.ndarray:
    """ART_BOX of a straightened card turned `rotation` (0/180) degrees, like hypotheses.ts cutBox."""
    c = card if rotation == 0 else card[::-1, ::-1]
    x0, y0, x1, y1 = art_box_px(c.shape[1], c.shape[0], ART_BOX)
    return np.ascontiguousarray(c[y0:y1, x0:x1])


def whole_box_arts(frame: np.ndarray, box) -> list[tuple[int, np.ndarray]]:
    """The engine's 'whole' hypothesis on a plain box: the box as a card, ART_BOX cut after turning
    (0/180 for portrait boxes, 90/270 for sideways ones)."""
    x, y, w, h = box
    H, W = frame.shape[:2]
    x0, y0 = max(0, int(round(x))), max(0, int(round(y)))
    x1, y1 = min(W, int(round(x + w))), min(H, int(round(y + h)))
    crop = frame[y0:y1, x0:x1]
    out = []
    rots = (0, 180) if (x1 - x0) <= (y1 - y0) else (90, 270)
    for r in rots:
        c = np.rot90(crop, k={0: 0, 90: -1, 180: 2, 270: 1}[r])  # clockwise turns
        bx0, by0, bx1, by1 = art_box_px(c.shape[1], c.shape[0], ART_BOX)
        out.append((r, np.ascontiguousarray(c[by0:by1, bx0:bx1])))
    return out


# Ground truth per frame, in the order of its boxes in TEACHER_OUT/detections.json (sorted by x).
G = dict(P=81196066, E=14152693, K=35618217, H=58570206, R=96345184, A=33166263, U=23856331, F=65861210,
         S=63926180, I=74063034, D=13935001)
FRAMES = [
    ("native-bottom-row", "native", ["b1", "b2", "b3", "b6"], "PEKH"),
    ("native-top-row", "native", ["t1", "t2", "t3", "t4", "t5"], "RAURF"),
    ("native-left-col", "native", ["L-sideways", "L-field"], "SI"),
    ("native-right-sideways", "native", ["R-trap"], "D"),
    ("bottom-row", "screenshot", ["b1", "b2", "b3", "b6"], "PEKH"),
    ("top-row", "screenshot", ["t1", "t2", "t3", "t4", "t5"], "RAURF"),
    ("left-col", "screenshot", ["L-sideways", "L-field"], "SI"),
    ("right-sideways", "screenshot", ["R-trap"], "D"),
    ("mat-zoom", "mat", ["L-sideways", "L-field", "b1", "b2", "t1", "b3", "t2", "t3", "t4", "R-trap", "b6", "t5"],
     "SIPERKAURDHF"),
]
INSETS = (0.0, 0.05)


def _emit(manifest, img, pts, box, tags):
    """quad0/quad5 (the labelled quad, optionally inset 5% per side for the sleeve) and box ('whole') crops."""
    pts = np.float64(pts)
    base = tags["id"]
    for inset in INSETS:
        c = pts.mean(0)
        q = c + (pts - c) * (1 - 2 * inset)
        card = warp_quad(img, q, CARD_W, CARD_H)
        for rot in (0, 180):
            name = f"{base}__quad{int(inset * 100)}__r{rot}.png"
            Image.fromarray(art_of_card(card, rot)).save(REAL_DIR / name)
            manifest.append(dict(file=name, variant=f"quad{int(inset * 100)}", rotation=rot, **tags))
    if box is None:
        xs, ys = pts[:, 0], pts[:, 1]
        box = [float(xs.min()), float(ys.min()), float(xs.max() - xs.min()), float(ys.max() - ys.min())]
    for rot, art in whole_box_arts(img, box):
        name = f"{base}__box__r{rot}.png"
        Image.fromarray(art).save(REAL_DIR / name)
        manifest.append(dict(file=name, variant="box", rotation=rot, **tags))


def build_real():
    """Real test crops. Set 'realset': the rows of data/realset/set.json (the shared real test set) that have
    a labelled rotated box, each with that box and the user box (provenance: tools/realset/README.md). Set
    'lowres': the same 12 verified cards in the screenshot-size and mat-zoom captures (the teacher's boxes,
    TEACHER_OUT/detections.json)."""
    REAL_DIR.mkdir(parents=True, exist_ok=True)
    for f in REAL_DIR.glob("*.png"):
        f.unlink()
    manifest = []
    frames = {}

    def frame(name):
        if name not in frames:
            frames[name] = np.asarray(Image.open(FRAMES_DIR / f"{name}.png").convert("RGB"))
        return frames[name]

    realset = ROOT / "data" / "realset" / "set.json"
    for e in json.load(open(realset)) if realset.exists() else []:
        if not e.get("rotatedBox"):
            continue  # capture-C's rows (merged 2026-09-29) have no labelled quad
        ub = e.get("userBox")
        box = [ub["x"], ub["y"], ub["w"], ub["h"]] if ub else None
        tags = dict(id=e["id"], set="realset", frame=e["frame"], res="native", cardId=int(e["cardId"]),
                    verified=bool(e.get("verified")), source=e.get("source"), teacherRatio=e.get("teacherRatio"))
        _emit(manifest, frame(e["frame"]), e["rotatedBox"]["pts"], box, tags)
    dets = json.load(open(TEACHER_OUT / "detections.json"))
    for name, res, keys, gts in FRAMES:
        if res == "native":
            continue
        d = dets[name]
        assert len(d) == len(keys), (name, len(d), len(keys))
        for det, key, g in zip(d, keys, gts):
            tags = dict(id=f"{name}-{key}", set="lowres", frame=name, res=res, cardId=G[g], verified=True,
                        source="human", teacherRatio=None)
            _emit(manifest, frame(name), det["pts"], None, tags)
    json.dump(manifest, open(REAL_DIR / "manifest.json", "w"), indent=1)
    n = len({m["id"] for m in manifest})
    print(f"real: {len(manifest)} crops of {n} card sightings -> {REAL_DIR}")


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "all"
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    TEMPLATES.mkdir(parents=True, exist_ok=True)
    if step in ("cache", "all"):
        build_cache()
    if step in ("split", "all"):
        build_split()
    if step in ("templates", "all"):
        build_templates()
    if step in ("real", "all"):
        build_real()
