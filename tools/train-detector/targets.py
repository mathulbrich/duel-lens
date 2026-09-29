"""CenterNet targets for oriented card boxes, and the matching decoder (Python side; the extension's
decoder is src/offscreen/detector/decode.ts and must agree with decode() here).

Grid: output cell (i, j) covers input pixels [4j, 4j+4) x [4i, 4i+4); its centre is at ((j+.5)*4, (i+.5)*4).
Per object (cls, cx, cy, w, h, a): an oriented Gaussian peak (exactly 1 at the centre's cell) in its
class's heatmap, sigma = SIGMA * side (cells, at least MIN_SIGMA); every cell where that Gaussian is
above REG_MIN (and highest among objects) regresses the object: dx, dy = centre - cell centre (cells),
log w, log h (cells), sin 2a, cos 2a, weighted by the Gaussian. Ignored objects (-1) mask the
heatmap's negative loss inside their outline.
"""
from __future__ import annotations

import math

import cv2
import numpy as np

STRIDE = 4
NREG = 14  # dx, dy, log w, log h, sin 2t, cos 2t, then 8 corner residuals (4 corners x (u, v))
RECT = np.float32([[-1, -1], [1, -1], [1, 1], [-1, 1]])  # a rectangle's corners in its box frame, (w/2, h/2) units
SIGMA = 0.08
MIN_SIGMA = 0.7
REG_MIN = 0.5  # regression cells: the object's Gaussian above this (about +-1.2 sigma)
K = 2


def frame_angle(a: float) -> tuple[float, int]:
    """The box frame's angle for a card whose own "down" axis is at `a`: a modulo 180 degrees, in
    (-45, 135] degrees (the wrap falls on 45-degree tilts, rare on a mat; 0 and 90 are far from it), and
    how many half turns were removed (odd: the frame is the card turned 180 degrees)."""
    n = math.ceil((a - 3 * math.pi / 4) / math.pi - 1e-12)
    return a - n * math.pi, n


def corner_targets(cx, cy, w, h, a, quad: np.ndarray) -> np.ndarray:
    """The 8 corner residuals of a card: each of the box frame's corners (TL, TR, BR, BL of the frame
    at frame_angle(a)) in frame coordinates, in (w/2, h/2) units, minus the rectangle's. quad is in the
    card texture's corner order."""
    af, n = frame_angle(a)
    q = np.roll(quad.reshape(4, 2), -2 * (n % 2), 0)  # frame slot k = texture corner k (+2 if turned)
    c, s = math.cos(af), math.sin(af)
    d = q - np.float32([cx, cy])
    local = np.stack([d[:, 0] * c + d[:, 1] * s, -d[:, 0] * s + d[:, 1] * c], 1) / np.float32([max(1e-3, w / 2), max(1e-3, h / 2)])
    return (local - RECT).ravel().astype(np.float32)


def build(rows: np.ndarray, size_hw: tuple[int, int]):
    """rows: [n, 14] (cls, cx, cy, w, h, angle, quad x0,y0..x3,y3; scene.row_of) in input pixels. Returns heat [K,gh,gw], reg [14,gh,gw],
    regw [gh,gw], ignore [gh,gw] (float32). regw sums to 1 over each object's cells (every object counts
    the same in the regression loss, whatever its size), with the object's Gaussian as the shape."""
    gh, gw = size_hw[0] // STRIDE, size_hw[1] // STRIDE
    heat = np.zeros((K, gh, gw), np.float32)
    reg = np.zeros((NREG, gh, gw), np.float32)
    regw = np.zeros((gh, gw), np.float32)
    owner = np.full((gh, gw), -1, np.int32)
    n_obj = 0
    ignore = np.zeros((gh, gw), np.uint8)
    for row in rows:
        cls, cx, cy, w, h, a = (float(v) for v in row[:6])
        if cls < 0:
            q = corner_pts(cx / STRIDE, cy / STRIDE, w / STRIDE, h / STRIDE, a)
            cv2.fillConvexPoly(ignore, np.round(q * 16).astype(np.int32), 1, cv2.LINE_8, 4)
            continue
        u, v = cx / STRIDE, cy / STRIDE
        pj, pi = int(math.floor(u)), int(math.floor(v))
        if not (0 <= pj < gw and 0 <= pi < gh):
            continue
        sw = max(MIN_SIGMA, SIGMA * w / STRIDE)
        sh = max(MIN_SIGMA, SIGMA * h / STRIDE)
        R = int(math.ceil(3 * max(sw, sh)))
        i0, i1 = max(0, pi - R), min(gh, pi + R + 1)
        j0, j1 = max(0, pj - R), min(gw, pj + R + 1)
        ii, jj = np.mgrid[i0:i1, j0:j1].astype(np.float32)
        ddx, ddy = jj - pj, ii - pi
        c, s = math.cos(a), math.sin(a)
        along_w = ddx * c + ddy * s
        along_h = -ddx * s + ddy * c
        g = np.exp(-(along_w ** 2 / (2 * sw * sw) + along_h ** 2 / (2 * sh * sh))).astype(np.float32)
        k = int(cls)
        np.maximum(heat[k, i0:i1, j0:j1], g, out=heat[k, i0:i1, j0:j1])
        take = (g > REG_MIN) & (g > regw[i0:i1, j0:j1])
        if not take.any():
            continue
        sub = reg[:, i0:i1, j0:j1]
        sub[0][take] = (u - (jj + 0.5))[take]
        sub[1][take] = (v - (ii + 0.5))[take]
        sub[2][take] = math.log(max(1e-3, w / STRIDE))
        sub[3][take] = math.log(max(1e-3, h / STRIDE))
        sub[4][take] = math.sin(2 * a)
        sub[5][take] = math.cos(2 * a)
        ct = corner_targets(cx, cy, w, h, a, np.asarray(row[6:14], np.float32))
        for ch in range(8):
            sub[6 + ch][take] = ct[ch]
        regw[i0:i1, j0:j1][take] = g[take]
        owner[i0:i1, j0:j1][take] = n_obj
        n_obj += 1
    # normalise each object's weights to sum 1 (cells it still owns after later objects took some)
    if n_obj:
        sums = np.bincount(owner[owner >= 0].ravel(), weights=regw[owner >= 0].ravel(), minlength=n_obj)
        m = owner >= 0
        regw[m] = regw[m] / np.maximum(sums[owner[m]], 1e-6)
    return heat, reg, regw, ignore.astype(np.float32)


def corner_pts(cx, cy, w, h, a) -> np.ndarray:
    c, s = math.cos(a), math.sin(a)
    pts = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]
    return np.float32([(cx + dx * c - dy * s, cy + dx * s + dy * c) for dx, dy in pts])


def _area(p) -> float:
    if len(p) < 3:
        return 0.0
    x, y = np.asarray(p, np.float64).T
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def _ccw(p: np.ndarray) -> np.ndarray:
    x, y = p[:, 0], p[:, 1]
    s = float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))
    return p if s > 0 else p[::-1]


def clip_convex(subject, clip) -> list:
    """Sutherland-Hodgman: the part of convex polygon `subject` inside convex polygon `clip`.
    (cv2.intersectConvexConvex misreports polygons with coincident edges.)"""
    out = [tuple(map(float, p)) for p in _ccw(np.asarray(subject, np.float64))]
    c = _ccw(np.asarray(clip, np.float64))
    for i in range(len(c)):
        ax, ay = c[i]
        bx, by = c[(i + 1) % len(c)]
        inp, out = out, []
        if not inp:
            break
        side = lambda p: (bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax)  # noqa: E731  >= 0: inside (left of a->b)
        for j in range(len(inp)):
            p, q = inp[j], inp[(j + 1) % len(inp)]
            sp, sq = side(p), side(q)
            if sp >= 0:
                out.append(p)
            if (sp >= 0) != (sq >= 0):
                t = sp / (sp - sq)
                out.append((p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])))
    return out


def poly_iou(a: np.ndarray, b: np.ndarray) -> float:
    """IoU of two convex quads (4x2)."""
    inter = _area(clip_convex(a, b))
    if inter <= 0:
        return 0.0
    return float(inter / max(1e-9, _area(a) + _area(b) - inter))


def poly_inside(a: np.ndarray, b: np.ndarray) -> float:
    """Share of convex polygon a's area inside convex polygon b."""
    return float(_area(clip_convex(a, b)) / max(1e-9, _area(a)))


def portrait(cx, cy, w, h, a, quad: np.ndarray):
    """The reported box: portrait (w <= h), angle in (-90, 90] degrees, and the quad's corners cycled
    so the first is the one nearest the reported box's own top-left (clockwise order kept)."""
    if w > h:
        w, h, a = h, w, a + math.pi / 2
    a = (a + math.pi / 2) % math.pi - math.pi / 2
    box = corner_pts(cx, cy, w, h, a)
    shift = min(range(4), key=lambda k: float(np.linalg.norm(np.roll(quad, -k, 0) - box, axis=1).sum()))
    return w, h, a, np.roll(quad, -shift, 0), box


def decode(heat: np.ndarray, box: np.ndarray, peak: np.ndarray | None = None, thr: float = 0.25, nms_iou: float = 0.5, max_det: int = 200):
    """heat/peak [K,gh,gw] (probabilities), box [6 or 14,gh,gw] -> list of dicts (cls, score, cx, cy, w, h,
    angle, scores, quad = the 4 predicted corners, rbox = the rotated box's corners), input pixels,
    strongest first. Peaks are cells equal to their 3x3 max; one rotated-box NMS over both classes."""
    if peak is None:
        import torch
        import torch.nn.functional as F

        peak = F.max_pool2d(torch.from_numpy(heat)[None], 3, 1, 1)[0].numpy()
    K_, gh, gw = heat.shape
    ks, iis, jjs = np.nonzero((heat >= peak) & (heat > thr))
    order = np.argsort(-heat[ks, iis, jjs])[:max_det * 3]
    dets = []
    for o in order:
        k, i, j = int(ks[o]), int(iis[o]), int(jjs[o])
        dx, dy, lw, lh, s2, c2 = box[:6, i, j]
        cx, cy = (j + 0.5 + dx) * STRIDE, (i + 0.5 + dy) * STRIDE
        w, h = math.exp(min(8.0, lw)) * STRIDE, math.exp(min(8.0, lh)) * STRIDE
        a = 0.5 * math.atan2(s2, c2)
        if a <= -math.pi / 4:
            a += math.pi  # the box frame's range, (-45, 135] degrees (frame_angle)
        if box.shape[0] >= NREG:
            res = box[6:14, i, j].reshape(4, 2)
            local = (RECT + res) * np.float32([w / 2, h / 2])
            c, s = math.cos(a), math.sin(a)
            quad = np.stack([cx + local[:, 0] * c - local[:, 1] * s, cy + local[:, 0] * s + local[:, 1] * c], 1).astype(np.float32)
        else:
            quad = corner_pts(cx, cy, w, h, a)
        w, h, a, quad, rbox = portrait(cx, cy, w, h, a, quad)
        dets.append(dict(cls=k, score=float(heat[k, i, j]), cx=float(cx), cy=float(cy), w=float(w), h=float(h), angle=float(a),
                         scores=[float(heat[q, i, j]) for q in range(K_)], quad=quad, rbox=rbox))
    kept = []
    for d in dets:
        if all(poly_iou(d["rbox"], k["rbox"]) <= nms_iou for k in kept):
            kept.append(d)
        if len(kept) >= max_det:
            break
    return kept
