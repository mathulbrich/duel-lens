"""Quad labels for the full-view evaluation frames (data/debug/fullview), built from click-D's
axis-aligned hand labels (truth.json) and checked by eye.

  python label_fullview.py propose   -> data/train-detector/eval/fullview-candidates.json + check sheets
  python label_fullview.py build     -> data/train-detector/eval/fullview-quads.json (candidates + manual
                                        fixes from tools/train-detector/fullview-fixes.json) + sheets

Proposals, per labelled object (never used for training):
  grabcut  OpenCV GrabCut seeded with the label's box, the largest segment's minAreaRect
  box      otherwise the label's box itself
  manual   corners typed in after looking at the check sheet (fullview-fixes.json), which overrides the above
The labels on record also carry a fourth source, "draw2" (provenance): a box an earlier prototype's
third-party detector proposed offline, checked by eye like every proposal. That proposer has been
removed; build() still reads such rows.
Classes: face-up (card, featured showing a card), face-down (pile, sleeve, featured showing the card
back), ignore (click-D's ignore kind; kept as axis-aligned regions).
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np

from common import EVAL_DIR, FULLVIEW

HERE = Path(__file__).resolve().parent
TAG = ""  # "" = click-D's 7 frames; "new" = the frames added on 2026-09-29 (fullview-new-truth.json)


def _truth_file():
    return FULLVIEW / "truth.json" if not TAG else HERE / f"fullview-{TAG}-truth.json"


def _fixes_file():
    return HERE / ("fullview-fixes.json" if not TAG else f"fullview-{TAG}-fixes.json")


def _suffix():
    return "" if not TAG else f"-{TAG}"


def cls_of(t) -> str:
    k = t["kind"]
    if k == "ignore":
        return "ignore"
    if k == "featured" and "card back" in t.get("note", ""):
        return "face-down"
    return "face-up" if k in ("card", "featured") else "face-down"


def box_quad(b):
    x, y, w, h = b
    return np.float32([[x, y], [x + w, y], [x + w, y + h], [x, y + h]])


def order_quad(pts: np.ndarray) -> np.ndarray:
    """Corners clockwise starting from the one nearest the top-left of the portrait box."""
    c = pts.mean(0)
    ang = np.arctan2(pts[:, 1] - c[1], pts[:, 0] - c[0])
    p = pts[np.argsort(ang)]  # clockwise on screen (y down)
    start = int(np.argmin(p[:, 0] + p[:, 1]))
    return np.roll(p, -start, 0)


def grabcut_quad(img_bgr, b):
    x, y, w, h = [int(round(v)) for v in b]
    m = int(max(w, h) * 0.25)
    X0, Y0 = max(0, x - m), max(0, y - m)
    X1, Y1 = min(img_bgr.shape[1], x + w + m), min(img_bgr.shape[0], y + h + m)
    crop = img_bgr[Y0:Y1, X0:X1]
    mask = np.zeros(crop.shape[:2], np.uint8)
    rect = (x - X0, y - Y0, w, h)
    bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
    try:
        cv2.grabCut(crop, mask, rect, bgd, fgd, 6, cv2.GC_INIT_WITH_RECT)
    except cv2.error:
        return None
    fg = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(fg)
    if n <= 1:
        return None
    k = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    pts = np.column_stack(np.nonzero(lab == k)[::-1]).astype(np.float32)
    (cx, cy), (rw, rh), a = cv2.minAreaRect(pts)
    q = cv2.boxPoints(((cx + X0, cy + Y0), (rw, rh), a))
    return order_quad(np.float32(q))


def propose():
    truth = json.load(open(_truth_file()))
    out = {}
    for name, labels in truth.items():
        if name.startswith("_"):
            continue
        img = cv2.imread(str(FULLVIEW / name))
        rows = []
        for i, t in enumerate(labels):
            c = cls_of(t)
            row = dict(i=i, kind=t["kind"], note=t.get("note", ""), cls=c, box=t["box"])
            if c == "ignore":
                row.update(pts=box_quad(t["box"]).tolist(), source="box")
                rows.append(row)
                continue
            q = grabcut_quad(img, t["box"])
            row.update(pts=(q if q is not None else box_quad(t["box"])).tolist(), source="grabcut" if q is not None else "box")
            rows.append(row)
        out[name] = rows
    EVAL_DIR.mkdir(parents=True, exist_ok=True)
    json.dump(out, open(EVAL_DIR / f"fullview-candidates{_suffix()}.json", "w"), indent=1)
    sheets(out, "cand")


# Sheet colours per label source; "draw2" is the provenance value of the removed proposer's rows (see above).
COLS = {"draw2": (60, 220, 60), "grabcut": (255, 60, 255), "box": (0, 200, 255), "manual": (255, 200, 0)}


def sheets(labels, tag, zoom=3):
    """Per frame: every labelled object's crop at `zoom` x, its quad and index."""
    for name, rows in labels.items():
        img = cv2.imread(str(FULLVIEW / name))
        tiles = []
        for row in rows:
            if row["cls"] == "ignore":
                continue
            q = np.float32(row["pts"])
            x0, y0 = q.min(0) - 14
            x1, y1 = q.max(0) + 14
            x0, y0 = int(max(0, x0)), int(max(0, y0))
            x1, y1 = int(min(img.shape[1], x1)), int(min(img.shape[0], y1))
            crop = cv2.resize(img[y0:y1, x0:x1], ((x1 - x0) * zoom, (y1 - y0) * zoom), interpolation=cv2.INTER_CUBIC)
            qq = (q - np.float32([x0, y0])) * zoom
            cv2.polylines(crop, [np.round(qq).astype(np.int32)], True, COLS[row["source"]], 1, cv2.LINE_AA)
            # grid ticks every 10 source px for reading coordinates
            for gx in range((x0 // 10 + 1) * 10, x1, 10):
                cv2.line(crop, ((gx - x0) * zoom, 0), ((gx - x0) * zoom, 6 if gx % 50 else 14), (255, 255, 255), 1)
            for gy in range((y0 // 10 + 1) * 10, y1, 10):
                cv2.line(crop, (0, (gy - y0) * zoom), (6 if gy % 50 else 14, (gy - y0) * zoom), (255, 255, 255), 1)
            label = f"{row['i']} {row['cls'][5:]} {row['source']} ({x0},{y0})"
            cv2.putText(crop, label, (4, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 3, cv2.LINE_AA)
            cv2.putText(crop, label, (4, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
            tiles.append(crop)
        if not tiles:
            continue
        # pack tiles into rows of <= 1800 px
        rows_img, cur, cw_ = [], [], 0
        for t in tiles:
            if cw_ + t.shape[1] > 1800 and cur:
                rows_img.append(cur)
                cur, cw_ = [], 0
            cur.append(t)
            cw_ += t.shape[1]
        rows_img.append(cur)
        H = [max(t.shape[0] for t in r) for r in rows_img]
        W = max(sum(t.shape[1] for t in r) for r in rows_img)
        sheet = np.zeros((sum(H), W, 3), np.uint8)
        y = 0
        for r, h in zip(rows_img, H):
            x = 0
            for t in r:
                sheet[y:y + t.shape[0], x:x + t.shape[1]] = t
                x += t.shape[1]
            y += h
        cv2.imwrite(str(EVAL_DIR / f"{tag}-{name.replace('.png', '.jpg')}"), sheet, [cv2.IMWRITE_JPEG_QUALITY, 92])


def build():
    cand = json.load(open(EVAL_DIR / f"fullview-candidates{_suffix()}.json"))
    fixes = json.load(open(_fixes_file())) if _fixes_file().exists() else {}
    out = {"_format": ("Quad labels for the full-view frames: per frame a list of {cls: face-up|face-down|ignore, pts: 4 corners "
                       "[x, y] (frame px, clockwise), kind/note: click-D's truth.json label, source: draw2 (a box an earlier "
                       "prototype's third-party detector proposed offline, checked by eye) | grabcut (OpenCV GrabCut minAreaRect, checked by eye) | manual (typed in after "
                       "checking) | box (click-D's axis-aligned box; ignore regions), i: index in truth.json (-1: added)}. "
                       "Built by tools/train-detector/label_fullview.py.")}
    for name, rows in cand.items():
        fx = fixes.get(name, {})
        res = []
        for row in rows:
            f = fx.get(str(row["i"]))
            if f is not None:
                row = dict(row)
                if "pts" in f:
                    row["pts"] = order_quad(np.float32(f["pts"])).tolist()
                    row["source"] = "manual"
                if "rect" in f:  # cx, cy, w, h, angle (deg)
                    cx, cy, w, h, a = f["rect"]
                    q = cv2.boxPoints(((cx, cy), (w, h), a))
                    row["pts"] = order_quad(np.float32(q)).tolist()
                    row["source"] = "manual"
                for k in ("cls", "note"):
                    if k in f:
                        row[k] = f[k]
                if f.get("drop"):
                    continue
            row["pts"] = [[round(float(a), 1), round(float(b), 1)] for a, b in row["pts"]]
            res.append(row)
        for j, f in enumerate(fx.get("add", [])):
            q = order_quad(np.float32(f["pts"]) if "pts" in f else np.float32(cv2.boxPoints(((f["rect"][0], f["rect"][1]), (f["rect"][2], f["rect"][3]), f["rect"][4]))))
            res.append(dict(i=-1 - j, kind=f.get("kind", "card"), note=f.get("note", "added"), cls=f["cls"], box=None,
                            pts=[[round(float(a), 1), round(float(b), 1)] for a, b in q], source="manual"))
        out[name] = res
    json.dump(out, open(EVAL_DIR / f"fullview-quads{_suffix()}.json", "w"), indent=1)
    sheets({k: v for k, v in out.items() if not k.startswith("_")}, "final")
    n = {c: sum(1 for k, v in out.items() if not k.startswith("_") for r in v if r["cls"] == c) for c in ("face-up", "face-down", "ignore")}
    src = {}
    for k, v in out.items():
        if k.startswith("_"):
            continue
        for r in v:
            if r["cls"] != "ignore":
                src[r["source"]] = src.get(r["source"], 0) + 1
    print("labels", n, "sources", src)


if __name__ == "__main__":
    if "--tag" in sys.argv:
        TAG = sys.argv[sys.argv.index("--tag") + 1]
    {"propose": propose, "build": build}[sys.argv[1]]()
