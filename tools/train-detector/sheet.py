"""Sample sheets of the synthetic generator, with the labels drawn on (green face-up, orange
face-down, grey ignore; a tick marks each box's "up" side).

  python sheet.py frames [--n 6] [--seed 1] [--kind ycs]   -> data/train-detector/sheets/frames-<kind|mixed>-<seed>.jpg
  python sheet.py windows [--n 16] [--seed 1]               -> data/train-detector/sheets/windows-<seed>.jpg (training inputs)
  python sheet.py spreads [--n 24] [--seed 1] [--kind ycs] [--layout trail|scatter|fan]
                                                            -> data/train-detector/sheets/spreads-<kind|mixed>-<layout|all>-<seed>.jpg:
     each spread (scene.place_spread) cropped and zoomed, labels drawn, each spread card's visible share printed at
     its centre (* = the spread's top card), header: layout, zone/loose, frame kind
"""
from __future__ import annotations

import argparse
import math

import cv2
import numpy as np

from common import SHEETS
from scene import FACE_DOWN, FACE_UP, IGNORE, Assets, corners, drag_crop, label_of, render_frame, row_of, window

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


def spread_tiles(A, r, n: int, kind=None, layout=None, size: int = 320):
    """Zoomed crops of the spreads in freshly rendered frames: every label drawn (draw()), each spread card's visible
    share at its centre (* = the top card: drawn last), header: layout, zone/loose, frame kind."""
    tiles = []
    while len(tiles) < n:
        img, objs, k = render_frame(A, r, kind=kind)
        rows = [row_of(label_of(o, o.visible), o, 0, 0) for o in objs]
        drawn = draw(img, [x for x in rows if x[0] != -2], thick=1)
        groups = {}
        for o in objs:
            if "spread" in o.extra and (layout is None or o.extra["spread"] == layout):
                groups.setdefault(o.extra["sid"], []).append(o)
        H, W = img.shape[:2]
        for g in groups.values():
            q = np.concatenate([o.quad for o in g])
            if not (0 <= q[:, 0].mean() < W and 0 <= q[:, 1].mean() < H):
                continue  # the tilted camera left this spread out of the frame
            cw = min(min(o.w, o.h) for o in g)
            x0, y0 = q.min(0) - 0.6 * cw
            x1, y1 = q.max(0) + 0.6 * cw
            side = max(x1 - x0, y1 - y0)
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            s_ = size / side
            M = np.float32([[s_, 0, size / 2 - cx * s_], [0, s_, size / 2 - cy * s_]])
            t = cv2.warpAffine(drawn, M, (size, size), flags=cv2.INTER_AREA if s_ < 1 else cv2.INTER_LINEAR, borderValue=(40, 40, 40))
            top = max(o.extra["z"] for o in g)
            for o in g:
                p = M @ np.float32([o.cx, o.cy, 1])
                lab = label_of(o, o.visible)
                txt = f"{min(99, int(round(100 * o.visible)))}{'*' if o.extra['z'] == top else ''}"
                col = COL[lab] if lab != -2 else (255, 60, 60)
                cv2.putText(t, txt, (int(p[0]) - 12, int(p[1]) + 5), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 3, cv2.LINE_AA)
                cv2.putText(t, txt, (int(p[0]) - 12, int(p[1]) + 5), cv2.FONT_HERSHEY_SIMPLEX, 0.45, col, 1, cv2.LINE_AA)
            head = f"{g[0].extra['spread']} {g[0].extra['where']} {k} {int(round(cw))}px"
            cv2.putText(t, head, (6, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 3, cv2.LINE_AA)
            cv2.putText(t, head, (6, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 0), 1, cv2.LINE_AA)
            tiles.append(t)
            if len(tiles) >= n:
                break
    return tiles


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["frames", "windows", "spreads"])
    ap.add_argument("--n", type=int, default=6)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--kind", default=None)
    ap.add_argument("--layout", default=None, help="spreads: only this layout (trail, scatter, fan)")
    args = ap.parse_args()
    SHEETS.mkdir(parents=True, exist_ok=True)
    A = Assets()
    r = np.random.default_rng(args.seed)
    tiles = []
    if args.what == "spreads":
        tiles = spread_tiles(A, r, args.n, args.kind, args.layout)
        cols = 6
        name = f"spreads-{args.kind or 'mixed'}-{args.layout or 'all'}-{args.seed}.jpg"
    elif args.what == "frames":
        for i in range(args.n):
            img, objs, kind = render_frame(A, r, kind=args.kind)
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
