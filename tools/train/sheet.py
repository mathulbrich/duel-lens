"""Contact sheets to calibrate the generator by eye.

  python tools/train/sheet.py calib   real ART_BOX crops (labelled quads) next to synthetic renderings of the
                                      same artworks -> data/train/sheets/calibration.png
  python tools/train/sheet.py levels  random artworks at each level -> data/train/sheets/levels.png
  python tools/train/sheet.py time    generator throughput (one process)
"""
from __future__ import annotations

import json
import sys
import time

import numpy as np
from PIL import Image, ImageDraw

from common import REAL_DIR, SHEETS, index_entries, load_art_cache, pil_resize_224
from synth import Library, render

T = 112  # thumbnail size


def thumb(a: np.ndarray) -> Image.Image:
    return Image.fromarray(a).resize((T, T), Image.BILINEAR)


def calib():
    entries = index_entries()
    art = load_art_cache()
    lib = Library(entries)
    by_card = {}
    for i, e in enumerate(entries):
        by_card.setdefault(e["cardId"], i)
    man = json.load(open(REAL_DIR / "manifest.json"))
    reals = [m for m in man if m["variant"] == "quad0" and m["set"] == "realset" and m.get("verified")]
    # the upright hypothesis is the one whose rotation matches the card: show both, then synth
    rows = []
    seen = set()
    for m in reals:
        if m["id"] in seen:
            continue
        seen.add(m["id"])
        pair = [x for x in reals if x["id"] == m["id"]]
        rows.append((m, pair))
    r = np.random.default_rng(3)
    ncol = 2 + 1 + 7
    sheet = Image.new("RGB", (ncol * T, len(rows) * T), (255, 255, 255))
    for y, (m, pair) in enumerate(rows):
        for x, p in enumerate(pair[:2]):
            sheet.paste(thumb(pil_resize_224(np.asarray(Image.open(REAL_DIR / p["file"]).convert("RGB")))), (x * T, y * T))
        i = by_card[m["cardId"]]
        sheet.paste(thumb(np.asarray(art[i])), (2 * T, y * T))
        for x in range(7):
            lvl = "video" if x < 4 else "hard"
            sheet.paste(thumb(render(np.asarray(art[i]), lib.kinds[i], lib, r, lvl)), ((3 + x) * T, y * T))
    d = ImageDraw.Draw(sheet)
    d.text((4, 4), "real 0/180", fill=(255, 255, 0))
    d.text((2 * T + 4, 4), "clean", fill=(255, 255, 0))
    d.text((3 * T + 4, 4), "synthetic video x4, hard x3", fill=(255, 255, 0))
    SHEETS.mkdir(parents=True, exist_ok=True)
    sheet.save(SHEETS / "calibration.png")
    print("wrote", SHEETS / "calibration.png")


def levels():
    entries = index_entries()
    art = load_art_cache()
    lib = Library(entries)
    r = np.random.default_rng(5)
    idx = r.choice(len(entries), 8, replace=False)
    cols = ["clean", "mild", "mild", "video", "video", "video", "hard", "hard", "hard"]
    sheet = Image.new("RGB", (len(cols) * T, len(idx) * T))
    for y, i in enumerate(idx):
        for x, lvl in enumerate(cols):
            a = np.asarray(art[i]) if lvl == "clean" else render(np.asarray(art[i]), lib.kinds[i], lib, r, lvl)
            sheet.paste(thumb(a), (x * T, y * T))
    sheet.save(SHEETS / "levels.png")
    print("wrote", SHEETS / "levels.png")


# Real full-card foils (frame, box x,y,w,h, turns to upright, card id): the foil test set's sightings
FOIL_REAL = [
    ("data/debug/t21820/yt-bBbjafm1u2Q-t21820.png", (760, 234, 100, 138), 2, 30581601),  # Yummy★Snatchy
    ("data/debug/t21820/yt-bBbjafm1u2Q-t21820.png", (1228, 616, 136, 98), 1, 14965712),  # Kuriboh - Multiply! (grey)
    ("data/debug/t21820/yt-bBbjafm1u2Q-t21820.png", (566, 628, 136, 98), 1, 14965712),  # Kuriboh - Multiply! (pink)
    ("data/debug/t21820/yt-bBbjafm1u2Q-t21820.png", (1432, 597, 96, 138), 0, 14558127),  # Ash Blossom
    ("data/debug/frames/native-hgg-t2951-mid.png", (385, 403, 167, 112), 1, 33854624),  # Bystial Magnamhut
    ("data/debug/frames/native-tsc-t1201-mid.png", (38, 403, 152, 102), 1, 55393975),  # Angelechy Destrier
]


def foil():
    """Real full-card foils (left, x3) next to _fullfoil renderings of the same artwork in its own frame
    type, brought to the real card's size with a little blur and JPEG (x3), to tune the foil by eye."""
    import cv2

    from common import ROOT
    from synth import AX0, AX1, AY0, AY1, HC, PX0, PX1, PY0, PY1, PENDULUM_BOX_TOP, WC, _fullfoil

    entries = index_entries()
    art = load_art_cache()
    lib = Library(entries)
    by_image = {e["imageId"]: i for i, e in enumerate(entries)}
    r = np.random.default_rng(11)
    Z, ncol = 2, 8
    rows = []
    for frame, (x, y, w, h), turns, cid in FOIL_REAL:
        im = np.asarray(Image.open(ROOT / frame).convert("RGB"))
        real = np.rot90(im[y:y + h, x:x + w], k=-turns)  # clockwise turns to upright
        rh, rw = real.shape[:2]
        tiles = [Image.fromarray(np.ascontiguousarray(real)).resize((rw * Z, rh * Z), Image.LANCZOS)]
        i = by_image[cid]
        what, group = lib.kinds[i]
        for _ in range(ncol):
            pool = lib.tpl.get("pendulum" if what == "pendulum" else group) or lib.any
            canvas = pool[r.integers(len(pool))].astype(np.float32)
            a = np.asarray(art[i])
            if what == "pendulum":
                ill = cv2.resize(a, (PX1 - PX0, PY1 - PY0), interpolation=cv2.INTER_LINEAR).astype(np.float32)
                cut = int(PENDULUM_BOX_TOP * HC) - PY0
                canvas[PY0:PY0 + cut, PX0:PX1] = ill[:cut]
            else:
                canvas[AY0:AY1, AX0:AX1] = cv2.resize(a, (AX1 - AX0, AY1 - AY0), interpolation=cv2.INTER_AREA)
            _fullfoil(canvas, r, (0, 0, WC, HC), art=(PX0, PY0, PX1, PY1) if what == "pendulum" else (AX0, AY0, AX1, AY1))
            cw = int(round(min(rw, rh) * 0.86))  # the card inside the real crop's margin
            ch = int(round(cw * 86 / 59))
            small = cv2.resize(canvas, (cw, ch), interpolation=cv2.INTER_AREA)
            small = cv2.GaussianBlur(small, (0, 0), 0.6)
            ok, buf = cv2.imencode(".jpg", cv2.cvtColor(np.clip(small, 0, 255).astype(np.uint8), cv2.COLOR_RGB2BGR),
                                   [cv2.IMWRITE_JPEG_QUALITY, 60])
            small = cv2.cvtColor(cv2.imdecode(buf, cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)
            tiles.append(Image.fromarray(small).resize((cw * Z, ch * Z), Image.LANCZOS))
        tiles.append(Image.fromarray(np.asarray(art[i])).resize((min(rw, rh) * Z, min(rw, rh) * Z)))
        rows.append(tiles)
    W = max(sum(t.width + 4 for t in row) for row in rows)
    H = sum(max(t.height for t in row) + 4 for row in rows)
    sheet = Image.new("RGB", (W, H), (255, 255, 255))
    yy = 0
    for row in rows:
        xx = 0
        for t in row:
            sheet.paste(t, (xx, yy))
            xx += t.width + 4
        yy += max(t.height for t in row) + 4
    SHEETS.mkdir(parents=True, exist_ok=True)
    sheet.save(SHEETS / "foil-calib.png")
    print("wrote", SHEETS / "foil-calib.png", sheet.size)


def _warp_card(im: np.ndarray, corners, w=280, h=408) -> np.ndarray:
    """A card straightened from its corners (the upright card's TL, TR, BR, BL)."""
    import cv2

    M = cv2.getPerspectiveTransform(np.float32(corners), np.float32([[0, 0], [w, 0], [w, h], [0, h]]))
    return cv2.warpPerspective(im, M, (w, h), flags=cv2.INTER_LINEAR)


def _small(card: np.ndarray, cw: int, r, blur=(0.4, 0.9), q=(55, 80)) -> np.ndarray:
    """A 280x408 card canvas brought to cw px wide with a little blur and JPEG, as on a stream."""
    import cv2

    ch = int(round(cw * 86 / 59))
    small = cv2.resize(np.clip(card, 0, 255).astype(np.float32), (cw, ch), interpolation=cv2.INTER_AREA)
    small = cv2.GaussianBlur(small, (0, 0), float(r.uniform(*blur)))
    ok, buf = cv2.imencode(".jpg", cv2.cvtColor(np.clip(small, 0, 255).astype(np.uint8), cv2.COLOR_RGB2BGR),
                           [cv2.IMWRITE_JPEG_QUALITY, int(r.uniform(*q))])
    return cv2.cvtColor(cv2.imdecode(buf, cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)


def _row_sheet(rows, path, Z=2):
    W = max(sum(t.width + 4 for t in row) for row in rows)
    H = sum(max(t.height for t in row) + 4 for row in rows)
    sheet = Image.new("RGB", (W, H), (255, 255, 255))
    yy = 0
    for row in rows:
        xx = 0
        for t in row:
            sheet.paste(t, (xx, yy))
            xx += t.width + 4
        yy += max(t.height for t in row) + 4
    SHEETS.mkdir(parents=True, exist_ok=True)
    sheet.save(path)
    print("wrote", path, sheet.size)


def combined():
    """The combined retrain's effects, by eye (combined-retrain-report.md): each row starts with REAL footage, then
    renderings of the same artwork (or random ones for occluders) with the effect:
      overframe  the real overframe (t6186, t6450; straightened) | _overframe cards brought to its size (x6)
      badge      DuelingBook's "1" and "10" pile tops (t950) | _badge cards at their size (x6)
      occluder   the real covered cards (partial study) | captured scenes with _occlude (x6)
      training   the 224 px training views the model sees: overframe / badge / occluder / all (x8 each)."""
    import cv2

    from common import ROOT
    from synth import AX0, AX1, AY0, AY1, MIX, _badge, _overframe

    entries = index_entries()
    art = load_art_cache()
    lib = Library(entries)
    by_image = {e["imageId"]: i for i, e in enumerate(entries)}
    r = np.random.default_rng(int(sys.argv[2]) if len(sys.argv) > 2 else 7)
    Z = 2
    rows = []
    # ---- overframe
    ov = Image.open(ROOT / "data/debug/overframe/yt-WFORv4AsNoM-t6186.png").convert("RGB")
    ov2 = Image.open(ROOT / "data/debug/overframe/yt-WFORv4AsNoM-t6450.png").convert("RGB")
    realA = _warp_card(np.asarray(ov), [(538.3, 468.3), (531.7, 563.7), (395.3, 550.8), (401.7, 455.8)], 96, 138)
    realB = _warp_card(np.asarray(ov2), [(619.4, 453.4), (598, 546.4), (465.6, 514.6), (486, 423)], 96, 138)
    i = by_image[44001993]
    row = [Image.fromarray(realA).resize((96 * Z, 138 * Z), Image.LANCZOS), Image.fromarray(realB).resize((96 * Z, 138 * Z), Image.LANCZOS)]
    for _ in range(6):
        tpl = lib.tpl["ritual"][r.integers(len(lib.tpl["ritual"]))].astype(np.float32)
        canvas = tpl.copy()
        canvas[AY0:AY1, AX0:AX1] = cv2.resize(np.asarray(art[i]), (AX1 - AX0, AY1 - AY0), interpolation=cv2.INTER_AREA)
        _overframe(canvas, tpl, np.asarray(art[i]), r)
        row.append(Image.fromarray(_small(canvas, 92, r)).resize((92 * Z, 134 * Z), Image.LANCZOS))
    rows.append(row)
    # a second overframe row on other artworks, with their card-level rendering at full size
    row = []
    for _ in range(8):
        j = int(r.integers(len(entries)))
        if lib.kinds[j][0] != "normal":
            continue
        tpl = (lib.tpl.get(lib.kinds[j][1]) or lib.any)
        tpl = tpl[r.integers(len(tpl))].astype(np.float32)
        canvas = tpl.copy()
        _overframe(canvas, tpl, np.asarray(art[j]), r)
        row.append(Image.fromarray(np.clip(canvas, 0, 255).astype(np.uint8)).resize((140, 204), Image.LANCZOS))
    rows.append(row)
    # ---- badge
    fr = Image.open(ROOT / "data/debug/t950-recco/yt-1NkgdX2T1g0-t950.png").convert("RGB")
    real_reco = fr.crop((1455, 418, 1573, 574))
    row = [real_reco.resize((real_reco.width * Z, real_reco.height * Z), Image.LANCZOS)]
    for img_id in (89392810, 89392810, 89392810):
        i = by_image[img_id]
        for _ in range(2):
            tpl = lib.tpl["effect"][r.integers(len(lib.tpl["effect"]))].astype(np.float32)
            canvas = tpl.copy()
            canvas[AY0:AY1, AX0:AX1] = cv2.resize(np.asarray(art[i]), (AX1 - AX0, AY1 - AY0), interpolation=cv2.INTER_AREA)
            _badge(canvas, r)
            row.append(Image.fromarray(_small(canvas, 107, r, blur=(0.6, 1.1), q=(60, 85))).resize((107 * Z, 156 * Z), Image.LANCZOS))
    rows.append(row)
    # ---- occluders: real covered cards, then captured scenes
    import json as _json

    real = [x for x in _json.load(open(ROOT / "data/debug/partial/real.json")) if "covered" in x.get("cut", "")]
    row = []
    for x in real:
        im = Image.open(ROOT / x["image"]).convert("RGB")
        bx, by, bw, bh = x["box"]
        m = int(0.1 * max(bw, bh))
        c = im.crop((bx - m, by - m, bx + bw + m, by + bh + m))
        s = 230 / max(c.size)
        row.append(c.resize((int(c.width * s), int(c.height * s)), Image.LANCZOS))
    rows.append(row)
    for lvl in ("video", "hard"):
        row = []
        for _ in range(7):
            j = int(r.integers(len(entries)))
            o = int(r.integers(len(entries)))
            info = {"debug": True}
            render(np.asarray(art[j]), lib.kinds[j], lib, r, lvl, mix={"occl": 1.0}, info=info, other=np.asarray(art[o]))
            cap, q = info["cap"], info["card_q"]
            x0, y0 = np.floor(q.min(0)).astype(int) - 6
            x1, y1 = np.ceil(q.max(0)).astype(int) + 6
            c = cap[max(0, y0):y1, max(0, x0):x1]
            s = 230 / max(c.shape[:2])
            row.append(Image.fromarray(c).resize((max(1, int(c.shape[1] * s)), max(1, int(c.shape[0] * s))), Image.LANCZOS))
        rows.append(row)
    # ---- the 224 px training views
    for name, mix in (("overframe", {"overframe": 1.0}), ("badge", {"badge": 1.0}), ("occl", {"occl": 1.0}), ("all", MIX)):
        row = []
        for _ in range(8):
            j = int(r.integers(len(entries)))
            if name == "overframe" and lib.kinds[j][0] != "normal":
                continue
            o = int(r.integers(len(entries)))
            row.append(thumb(render(np.asarray(art[j]), lib.kinds[j], lib, r, "video" if r.random() < 0.7 else "hard", mix=mix, other=np.asarray(art[o]))))
        rows.append(row)
    _row_sheet(rows, SHEETS / "combined.png")


def timing():
    entries = index_entries()
    art = load_art_cache()
    lib = Library(entries)
    r = np.random.default_rng(1)
    for lvl in ("mild", "video", "hard"):
        t0 = time.time()
        n = 200
        for _ in range(n):
            i = int(r.integers(len(entries)))
            render(np.asarray(art[i]), lib.kinds[i], lib, r, lvl)
        print(f"{lvl}: {(time.time() - t0) / n * 1000:.1f} ms/view")


if __name__ == "__main__":
    {"calib": calib, "levels": levels, "foil": foil, "combined": combined, "time": timing}[sys.argv[1]]()
