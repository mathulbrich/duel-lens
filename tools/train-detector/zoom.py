"""Zoomed view of a frame region with a labelled pixel grid, for reading label corners by eye.

  python zoom.py <image> x y w h [--zoom 4] [--quads '[[[x,y],...]]'] [--out file.png]
"""
from __future__ import annotations

import argparse
import json

import cv2
import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("x", type=int)
    ap.add_argument("y", type=int)
    ap.add_argument("w", type=int)
    ap.add_argument("h", type=int)
    ap.add_argument("--zoom", type=int, default=4)
    ap.add_argument("--quads", default="[]")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    img = cv2.imread(a.image)
    z = a.zoom
    x0, y0 = max(0, a.x), max(0, a.y)
    x1, y1 = min(img.shape[1], a.x + a.w), min(img.shape[0], a.y + a.h)
    crop = cv2.resize(img[y0:y1, x0:x1], ((x1 - x0) * z, (y1 - y0) * z), interpolation=cv2.INTER_CUBIC)
    for gx in range((x0 // 10 + 1) * 10, x1, 10):
        X = (gx - x0) * z
        major = gx % 50 == 0
        cv2.line(crop, (X, 0), (X, crop.shape[0]), (255, 255, 255) if major else (150, 150, 150), 1)
        if major:
            cv2.putText(crop, str(gx), (X + 2, 12), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 255), 1, cv2.LINE_AA)
    for gy in range((y0 // 10 + 1) * 10, y1, 10):
        Y = (gy - y0) * z
        major = gy % 50 == 0
        cv2.line(crop, (0, Y), (crop.shape[1], Y), (255, 255, 255) if major else (150, 150, 150), 1)
        if major:
            cv2.putText(crop, str(gy), (2, Y - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 255), 1, cv2.LINE_AA)
    for q in json.loads(a.quads):
        qq = (np.float32(q) - np.float32([x0, y0])) * z
        cv2.polylines(crop, [np.round(qq).astype(np.int32)], True, (255, 0, 255), 2, cv2.LINE_AA)
    cv2.imwrite(a.out, crop)


if __name__ == "__main__":
    main()
