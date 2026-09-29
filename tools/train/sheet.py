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
    {"calib": calib, "levels": levels, "foil": foil, "time": timing}[sys.argv[1]]()
