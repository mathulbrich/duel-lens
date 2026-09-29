"""Sample sheets of the synthetic generator, with the labels drawn on (green face-up, orange
face-down, grey ignore; a tick marks each box's "up" side).

  python sheet.py frames [--n 6] [--seed 1] [--kind ycs]   -> data/train-detector/sheets/frames-<kind|mixed>-<seed>.jpg
  python sheet.py windows [--n 16] [--seed 1]               -> data/train-detector/sheets/windows-<seed>.jpg (training inputs)
"""
from __future__ import annotations

import argparse
import math

import cv2
import numpy as np

from common import SHEETS
from scene import FACE_DOWN, FACE_UP, IGNORE, Assets, corners, drag_crop, render_frame, window

COL = {FACE_UP: (60, 220, 80), FACE_DOWN: (255, 150, 30), IGNORE: (150, 150, 150)}


def draw(img: np.ndarray, rows, thick=2):
    """Label rows (scene.row_of): the quad, and a tick from the centre to its first edge's middle (the card's top)."""
    out = img.copy()
    for row in rows:
        cls, cx, cy = row[0], row[1], row[2]
        q = np.float32(row[6:14]).reshape(4, 2) if len(row) >= 14 else corners(*row[1:6])
        cv2.polylines(out, [np.round(q).astype(np.int32)], True, COL[int(cls)], thick, cv2.LINE_AA)
        top = (q[0] + q[1]) / 2
        cv2.line(out, (int(top[0]), int(top[1])), (int(cx), int(cy)), COL[int(cls)], 1, cv2.LINE_AA)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["frames", "windows"])
    ap.add_argument("--n", type=int, default=6)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--kind", default=None)
    args = ap.parse_args()
    SHEETS.mkdir(parents=True, exist_ok=True)
    A = Assets()
    r = np.random.default_rng(args.seed)
    tiles = []
    if args.what == "frames":
        for i in range(args.n):
            img, objs, kind = render_frame(A, r, kind=args.kind)
            from scene import label_of, row_of
            rows = [row_of(label_of(o, o.visible), o, 0, 0) for o in objs]
            rows = [x for x in rows if x[0] != -2]
            t = draw(img, rows)
            cv2.putText(t, kind, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 0), 2)
            tiles.append(t)
        cols = 2
        name = f"frames-{args.kind or 'mixed'}-{args.seed}.jpg"
    else:
        for i in range(args.n):
            img, objs, kind = render_frame(A, r)
            cards = [o for o in objs if o.cls != IGNORE and o.visible > 0.6]
            if cards and r.random() < 0.25:
                win, rows = drag_crop(img, objs, r, cards[int(r.integers(len(cards)))])
            else:
                win, rows = window(img, objs, r, 640, cards[int(r.integers(len(cards)))] if cards and r.random() < 0.7 else None)
            tiles.append(cv2.resize(draw(win, rows), (480, 480), interpolation=cv2.INTER_AREA))
        cols = 4
        name = f"windows-{args.seed}.jpg"
    rows_ = [np.hstack(tiles[i:i + cols] + [np.zeros_like(tiles[0])] * (cols - len(tiles[i:i + cols]))) for i in range(0, len(tiles), cols)]
    sheet = np.vstack(rows_)
    path = SHEETS / name
    cv2.imwrite(str(path), cv2.cvtColor(sheet, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 88])
    print(path)


if __name__ == "__main__":
    main()
