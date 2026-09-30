"""Synthetic duel-stream frames with oriented card labels, for training the card detector.

One call to `render_frame()` builds a whole broadcast frame at the detector's working scale (the
screenshot resized so its long side is 1280 px), seeded:

  mat        one of five looks: 'ycs' (dark mat, glowing zone outlines, blue/red halves), 'wc'
             (blue/red halves, thin printed zone grid, gold swirls), 'wcq' (dark gold mat with
             ornate zone frames holding printed artwork = MAT ART, a hard negative), 'random'
             (any colour/texture, art playmats, random zone styles), 'close' (zoomed in, no
             broadcast). Empty zones are card-shaped outlines and are never labelled.
  objects    face-up cards (YGOPRODeck card images, or Phase 2's frame templates with any artwork
             pasted in; holo), sleeved or not; face-down cards (sleeve backs: plain, emblem,
             pattern, official-style logo, holo/silver, full-bleed ART sleeves; the official card
             back); piles (stacked offsets, messy spreads; face-down or with a face-up top card);
             XYZ stacks and cards on piles; fanned hands (held: ignored); loose cards at any angle;
             SPREADS of face-up cards lying on the table (place_spread: a Graveyard or banished pile
             spread out, cards set down loosely, a hand laid out as a fan), in zones and loose, drawn
             from their own random stream (render_frame's `spreads`)
  broadcast  player-cam panels, name/LP/timer bars with text, logos, hexagon/stripe backdrops,
             art-only side panels (hard negatives), and the big FEATURED CARD panel (a face-up
             card, the card back, or an empty black panel = hard negative)
  occluders  arms and hands reaching over the mat, dice, deck boxes
  camera     uneven light, blur, colour casts, washout, gamma, sharpening, noise, resolution loss,
             JPEG/H.264-like blocking at the source scale (4:2:0), chroma smear

Labels: oriented boxes (cx, cy, w, h, angle) in frame pixels, w = short side, h = long side, angle =
clockwise angle of the long axis from vertical (src/offscreen/geometry.ts's convention; only defined modulo 180 deg), and
a class: 0 face-up, 1 face-down, -1 ignore (a card less than half visible: under a hand or another
card, a sliver of an XYZ material, a held fan). A covered card of a spread counts from 0.4 visible
(Obj.extra['pos_min'], label_of); a fan laid on the table is labelled like any other card. The box is
the object's outer outline (the sleeve's, when sleeved), whole even when partly hidden (amodal).
"""
from __future__ import annotations

import json
import math
import string
from dataclasses import dataclass, field

import cv2
import numpy as np

from common import ARTWORKS, CARD_ASPECT, CARD_BACK_FULL, CARDS_SMALL, TEMPLATES

cv2.setNumThreads(1)

FACE_UP, FACE_DOWN, IGNORE = 0, 1, -1
TW, TH = 268, 391  # card texture size (YGOPRODeck cards_small)
ART_BOX = dict(x=0.118, y=0.181, w=0.765, h=0.525)  # src/shared/card-layout.ts

SLEEVE_DARK = [(15, 15, 18), (25, 22, 60), (55, 20, 70), (70, 15, 20), (15, 45, 25), (40, 40, 45), (10, 30, 70), (60, 35, 90),
               (95, 40, 150), (120, 60, 170), (20, 20, 90)]
SLEEVE_LIGHT = [(235, 235, 235), (240, 170, 200), (170, 200, 240), (200, 180, 230), (240, 220, 160), (190, 190, 200), (120, 170, 230)]
SKIN = [(224, 172, 140), (198, 134, 106), (141, 85, 54), (250, 205, 175), (180, 120, 90), (230, 180, 160)]
FONTS = [cv2.FONT_HERSHEY_SIMPLEX, cv2.FONT_HERSHEY_DUPLEX, cv2.FONT_HERSHEY_TRIPLEX, cv2.FONT_HERSHEY_COMPLEX, cv2.FONT_HERSHEY_PLAIN]


def U(r, a, b):
    return float(r.uniform(a, b))


def C(r, seq):
    return seq[int(r.integers(len(seq)))]


# ---------------------------------------------------------------- assets

class Assets:
    """Card images, artworks and frame templates (loaded lazily, per worker)."""

    def __init__(self, split: str = "train"):
        small = sorted(CARDS_SMALL.glob("*.jpg"))
        arts = sorted(ARTWORKS.glob("*.jpg"))
        # 5% of each pool is held out for synthetic validation
        self.small = [p for i, p in enumerate(small) if (i % 20 == 7) == (split == "val")]
        self.arts = [p for i, p in enumerate(arts) if (i % 20 == 7) == (split == "val")]
        man = json.load(open(TEMPLATES / "manifest.json"))
        self.templates = [TEMPLATES / f"{m['imageId']}.jpg" for m in man if not m["frameType"].endswith("_pendulum")]
        back = cv2.imread(str(CARD_BACK_FULL), cv2.IMREAD_COLOR)
        self.back = cv2.resize(cv2.cvtColor(back, cv2.COLOR_BGR2RGB), (TW, TH), interpolation=cv2.INTER_AREA)
        self._tpl_cache: dict[int, np.ndarray] = {}

    @staticmethod
    def _read(p, flags=cv2.IMREAD_COLOR):
        im = cv2.imread(str(p), flags)
        if im is None:
            return None
        return cv2.cvtColor(im, cv2.COLOR_BGR2RGB)

    def card_image(self, r) -> np.ndarray:
        for _ in range(5):
            im = self._read(C(r, self.small))
            if im is not None:
                return cv2.resize(im, (TW, TH), interpolation=cv2.INTER_AREA) if im.shape[:2] != (TH, TW) else im
        return self.back.copy()

    def artwork(self, r, reduced: bool = True) -> np.ndarray:
        for _ in range(5):
            im = self._read(C(r, self.arts), cv2.IMREAD_REDUCED_COLOR_2 if reduced else cv2.IMREAD_COLOR)
            if im is not None:
                return im
        return (r.uniform(0, 255, (312, 312, 3))).astype(np.uint8)

    def template(self, r) -> np.ndarray:
        i = int(r.integers(len(self.templates)))
        t = self._tpl_cache.get(i)
        if t is None:
            t = self._read(self.templates[i])
            t = cv2.resize(t, (TW, TH), interpolation=cv2.INTER_AREA) if t.shape[:2] != (TH, TW) else t
            if len(self._tpl_cache) < 300:
                self._tpl_cache[i] = t
        return t.copy()


# ---------------------------------------------------------------- textures

def _grid(h, w):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    s = max(h, w)
    return xx / s, yy / s


def hue_shift(img: np.ndarray, deg: float) -> np.ndarray:
    hsv = cv2.cvtColor(img.astype(np.uint8), cv2.COLOR_RGB2HSV)
    hsv[..., 0] = ((hsv[..., 0].astype(np.int32) + int(deg / 2)) % 180).astype(np.uint8)
    return cv2.cvtColor(hsv, cv2.COLOR_HSV2RGB)


def foil(tex: np.ndarray, r, region=None):
    """Holo/foil rainbow (screen blend), sometimes fine prismatic lines (Phase 2's _foil)."""
    x0, y0, x1, y1 = region or (0, 0, tex.shape[1], tex.shape[0])
    sub = tex[y0:y1, x0:x1]
    h, w = sub.shape[:2]
    xx, yy = _grid(h, w)
    a = U(r, 0, math.pi)
    t = xx * math.cos(a) + yy * math.sin(a)
    phase = t * U(r, 0.6, 3.0) + U(r, 0, 1)
    rgb = 0.5 + 0.5 * np.cos(2 * math.pi * (phase[..., None] + np.float32([0, 1 / 3, 2 / 3])))
    alpha = U(r, 0.06, 0.3)
    if r.random() < 0.35:
        b = U(r, 0, math.pi)
        lines = 0.5 + 0.5 * np.sin((xx * math.cos(b) + yy * math.sin(b)) * U(r, 60, 140))
        alpha = alpha * (0.5 + lines[..., None])
    sub[:] = 255 - (255 - sub) * (1 - alpha * rgb)


def glare(obj: np.ndarray, r, strength: float = 1.0):
    """Sleeve glare band, specular blob or sheen (Phase 2's _glare)."""
    h, w = obj.shape[:2]
    xx, yy = _grid(h, w)
    cx, cy = w / max(h, w) / 2, h / max(h, w) / 2
    alpha = np.zeros((h, w), np.float32)
    if r.random() < 0.35 * strength:
        t = U(r, 0, math.pi)
        d = (xx - cx) * math.cos(t) + (yy - cy) * math.sin(t) - U(r, -0.45, 0.45)
        alpha = np.maximum(alpha, U(r, 0.1, 0.7) * np.exp(-0.5 * (d / U(r, 0.02, 0.22)) ** 2))
    if r.random() < 0.2 * strength:
        ex, ey = U(r, 0.1, 0.9) * w / max(h, w), U(r, 0.1, 0.9) * h / max(h, w)
        rx, ry = U(r, 0.03, 0.2), U(r, 0.03, 0.2)
        alpha = np.maximum(alpha, U(r, 0.4, 1.0) * np.exp(-0.5 * (((xx - ex) / rx) ** 2 + ((yy - ey) / ry) ** 2)))
    if r.random() < 0.4 * strength:
        t = U(r, 0, 2 * math.pi)
        g = ((xx - cx) * math.cos(t) + (yy - cy) * math.sin(t)) / 0.7 + 0.5
        alpha = np.maximum(alpha, U(r, 0.05, 0.3) * np.clip(g, 0, 1))
    if alpha.any():
        tint = np.float32([255, U(r, 240, 255), U(r, 225, 255)])
        a = alpha[..., None]
        obj[..., :3] = obj[..., :3] * (1 - a) + tint * a


def put_text(img, r, x, y, scale, colour, text=None, thick=None, font=None):
    text = (text or "".join(C(r, string.ascii_uppercase + "  0123456789") for _ in range(int(r.integers(3, 14))))).strip() or "YGO"
    font = FONTS[int(r.integers(len(FONTS)))] if font is None else font
    scale = max(0.2, float(scale))
    thick = thick or max(1, int(scale * U(r, 1.2, 2.6)))
    if img.dtype == np.uint8:
        cv2.putText(img, text, (int(x), int(y)), font, scale, colour, thick, cv2.LINE_AA)
        return
    # OpenCV 5 draws text on 8-bit images only: draw a mask, then blend it into the float image
    (tw, th), base = cv2.getTextSize(text, font, scale, thick)
    pw, ph = tw + 2 * thick + 2, th + base + 2 * thick + 2
    mask = np.zeros((ph, pw), np.uint8)
    cv2.putText(mask, text, (thick + 1, th + thick + 1), font, scale, 255, thick, cv2.LINE_AA)
    x0, y0 = int(x) - thick - 1, int(y) - th - thick - 1
    H, W = img.shape[:2]
    ax0, ay0, ax1, ay1 = max(0, x0), max(0, y0), min(W, x0 + pw), min(H, y0 + ph)
    if ax1 <= ax0 or ay1 <= ay0:
        return
    m = mask[ay0 - y0:ay1 - y0, ax0 - x0:ax1 - x0].astype(np.float32)[..., None] / 255
    sub = img[ay0:ay1, ax0:ax1]
    sub[:] = sub * (1 - m) + np.float32(colour) * m


def face_up_texture(A: Assets, r) -> np.ndarray:
    """A face-up card, TH x TW x 3 float32: a real card image or a frame template with another artwork."""
    if r.random() < 0.55:
        tex = A.card_image(r).astype(np.float32)
    else:
        tex = A.template(r)
        if r.random() < 0.15:
            tex = hue_shift(tex, U(r, -60, 60))
        tex = tex.astype(np.float32)
        x0, y0 = int(round(ART_BOX["x"] * TW)), int(round(ART_BOX["y"] * TH))
        x1, y1 = int(round((ART_BOX["x"] + ART_BOX["w"]) * TW)), int(round((ART_BOX["y"] + ART_BOX["h"]) * TH))
        tex[y0:y1, x0:x1] = cv2.resize(A.artwork(r), (x1 - x0, y1 - y0), interpolation=cv2.INTER_AREA)
    if r.random() < 0.2:
        region = (int(0.118 * TW), int(0.181 * TH), int(0.883 * TW), int(0.706 * TH)) if r.random() < 0.6 else None
        foil(tex, r, region)
    return tex


LOGO_WORDS = ["YU-GI-OH!", "WORLD", "CHAMPIONSHIP", "QUALIFIER", "SERIES", "YCS", "WCQ", "WCS", "2026", "2025", "KONAMI", "OTS",
              "REGIONAL", "NATIONALS", "DUELIST", "TCG", "OCG", "ULTRA PRO", "DRAGON", "CHAOS", "PREMIUM"]


def tournament_sleeve(A: Assets, r) -> np.ndarray:
    """An official/tournament-style sleeve back: saturated ground, ornate border(s), a central logo or
    emblem - card-like structure that is still NOT a face-up card (no name bar, art box, text box)."""
    base = np.float32(C(r, [(190, 30, 35), (30, 60, 170), (15, 15, 20), (90, 30, 140), (235, 235, 240), (200, 160, 60),
                            (20, 110, 60), (20, 130, 200), (150, 20, 60)])) * U(r, 0.7, 1.15)
    tex = np.empty((TH, TW, 3), np.float32)
    xx, yy = _grid(TH, TW)
    cx_, cy_ = TW / max(TH, TW) / 2, TH / max(TH, TW) / 2
    d = np.sqrt((xx - cx_) ** 2 + (yy - cy_) ** 2)
    if r.random() < 0.6:  # radial glow
        tex[:] = base * (1 + U(r, 0.2, 0.8) * np.exp(-(d / U(r, 0.15, 0.4)) ** 2))[..., None]
    else:  # sunburst rays
        ang = np.arctan2(yy - cy_, xx - cx_)
        rays = (np.sin(ang * int(r.integers(8, 30))) > 0).astype(np.float32)
        tex[:] = base * (1 + U(r, 0.1, 0.35) * rays)[..., None]
    ink = C(r, [(235, 200, 90), (245, 245, 245), (190, 190, 200), (20, 20, 20), (255, 215, 0)])
    for _ in range(int(r.integers(1, 4))):  # ornate borders
        m = int(TW * U(r, 0.02, 0.12))
        cv2.rectangle(tex, (m, m), (TW - 1 - m, TH - 1 - m), ink, int(r.integers(2, 9)), cv2.LINE_AA)
    if r.random() < 0.6:  # corner ornaments
        m = int(TW * U(r, 0.06, 0.14))
        for (px, py) in ((m, m), (TW - m, m), (TW - m, TH - m), (m, TH - m)):
            cv2.circle(tex, (px, py), int(TW * U(r, 0.03, 0.07)), ink, -1, cv2.LINE_AA)
    u = r.random()
    c = (int(TW * U(r, 0.4, 0.6)), int(TH * U(r, 0.4, 0.6)))
    if u < 0.4:  # a logo of words
        n = int(r.integers(1, 4))
        y = c[1] - n * 18
        for i in range(n):
            word = C(r, LOGO_WORDS)
            sc = U(r, 0.8, 1.6)
            (tw, th), _ = cv2.getTextSize(word, cv2.FONT_HERSHEY_DUPLEX, sc, 3)
            x = max(2, (TW - tw) // 2)
            put_text(tex, r, x, y + i * (th + 12), sc, (20, 20, 20), text=word, thick=6, font=cv2.FONT_HERSHEY_DUPLEX)
            put_text(tex, r, x, y + i * (th + 12), sc, C(r, [(255, 60, 60), (255, 215, 0), (250, 250, 250), (60, 160, 255)]), text=word, thick=2,
                     font=cv2.FONT_HERSHEY_DUPLEX)
    elif u < 0.75:  # a round emblem, maybe with an artwork inside
        rad = int(TW * U(r, 0.2, 0.42))
        if r.random() < 0.5:
            art = cv2.resize(A.artwork(r), (2 * rad, 2 * rad), interpolation=cv2.INTER_AREA).astype(np.float32)
            mask = np.zeros((2 * rad, 2 * rad), np.uint8)
            cv2.circle(mask, (rad, rad), rad, 255, -1, cv2.LINE_AA)
            y0, x0 = c[1] - rad, c[0] - rad
            if 0 <= y0 and 0 <= x0 and y0 + 2 * rad <= TH and x0 + 2 * rad <= TW:
                m = mask.astype(np.float32)[..., None] / 255
                tex[y0:y0 + 2 * rad, x0:x0 + 2 * rad] = tex[y0:y0 + 2 * rad, x0:x0 + 2 * rad] * (1 - m) + art * m
        else:
            cv2.circle(tex, c, rad, tuple(float(v) for v in r.integers(0, 256, 3)), -1, cv2.LINE_AA)
            put_text(tex, r, c[0] - rad * 0.7, c[1] + 10, U(r, 0.7, 1.3), ink, text=C(r, LOGO_WORDS))
        cv2.circle(tex, c, rad, ink, int(r.integers(2, 7)), cv2.LINE_AA)
    else:  # a shield / diamond emblem
        w_, h_ = TW * U(r, 0.25, 0.45), TH * U(r, 0.2, 0.35)
        pts = np.float32([(c[0], c[1] - h_), (c[0] + w_, c[1] - h_ * 0.3), (c[0] + w_ * 0.6, c[1] + h_), (c[0] - w_ * 0.6, c[1] + h_),
                          (c[0] - w_, c[1] - h_ * 0.3)]).astype(np.int32)
        cv2.fillPoly(tex, [pts], tuple(float(v) for v in r.integers(0, 256, 3)), cv2.LINE_AA)
        cv2.polylines(tex, [pts], True, ink, int(r.integers(2, 6)), cv2.LINE_AA)
    tex += r.normal(0, U(r, 0, 4), tex.shape).astype(np.float32)
    return np.clip(tex, 0, 255)


def sleeve_back_texture(A: Assets, r) -> np.ndarray:
    """What a face-down card shows: a sleeve's back (many designs) or the bare official card back."""
    k = r.random()
    if k < 0.28:
        tex = tournament_sleeve(A, r)
        if r.random() < 0.25:
            foil(tex, r)
        return tex
    k = (k - 0.28) / 0.72
    if k < 0.2:  # the official card back (bare, or behind a clear-backed sleeve)
        tex = A.back.astype(np.float32)
        if r.random() < 0.3:
            tex = tex * U(r, 0.7, 1.2)
        return tex
    if k < 0.45:  # full-bleed ART sleeve: an artwork cut to the card's shape, sometimes a logo band
        art = A.artwork(r, reduced=False)
        s = art.shape[0]
        cw = int(s * CARD_ASPECT)
        x0 = int(r.integers(0, s - cw + 1))
        tex = cv2.resize(art[:, x0:x0 + cw], (TW, TH), interpolation=cv2.INTER_AREA).astype(np.float32)
        if r.random() < 0.4:  # a printed logo/text band (e.g. "NEURON")
            y = int(TH * U(r, 0.6, 0.9))
            band = int(TH * U(r, 0.05, 0.12))
            if r.random() < 0.5:
                tex[y:y + band] = tex[y:y + band] * 0.3 + np.float32(C(r, SLEEVE_DARK + SLEEVE_LIGHT)) * 0.7
            put_text(tex, r, TW * U(r, 0.05, 0.3), y + band * 0.8, U(r, 0.6, 1.4), tuple(float(v) for v in r.integers(0, 256, 3)))
        if r.random() < 0.3:
            foil(tex, r)
        return tex
    base = np.float32(r.integers(0, 256, 3)) if r.random() < 0.4 else np.float32(C(r, SLEEVE_DARK + SLEEVE_LIGHT))
    tex = np.empty((TH, TW, 3), np.float32)
    xx, yy = _grid(TH, TW)
    t = U(r, 0, 2 * math.pi)
    tex[:] = base + (U(r, -45, 45) * ((xx - 0.3) * math.cos(t) + (yy - 0.5) * math.sin(t)))[..., None]
    if k < 0.6:  # official-style: a big emblem + a logo text
        col = tuple(float(v) for v in r.integers(0, 256, 3))
        c = (int(TW * U(r, 0.35, 0.65)), int(TH * U(r, 0.35, 0.65)))
        if r.random() < 0.5:
            rad = int(TW * U(r, 0.15, 0.4))
            cv2.circle(tex, c, rad, col, int(r.integers(-1, 12)) or -1, cv2.LINE_AA)
            if r.random() < 0.5:
                cv2.circle(tex, c, int(rad * U(r, 0.4, 0.8)), tuple(float(v) for v in r.integers(0, 256, 3)), -1, cv2.LINE_AA)
        else:
            pts = (np.float32(c) + r.uniform(-0.35, 0.35, (int(r.integers(3, 8)), 2)) * TW).astype(np.int32)
            cv2.fillPoly(tex, [pts], col, cv2.LINE_AA)
        if r.random() < 0.7:
            put_text(tex, r, TW * U(r, 0.05, 0.3), TH * U(r, 0.2, 0.95), U(r, 0.7, 1.6), tuple(float(v) for v in r.integers(0, 256, 3)))
    elif k < 0.75:  # stripes / checks / soft texture
        if r.random() < 0.6:
            f = U(r, 6, 40)
            a = U(r, 0, math.pi)
            pat = np.sin((xx * math.cos(a) + yy * math.sin(a)) * f) > 0
            if r.random() < 0.4:
                pat ^= np.sin((xx * math.sin(a) - yy * math.cos(a)) * f) > 0
            tex[pat] = tex[pat] * U(r, 0.5, 0.9)
        else:
            tex += cv2.resize(r.uniform(-1, 1, (int(r.integers(3, 12)), int(r.integers(3, 12)), 3)).astype(np.float32), (TW, TH),
                              interpolation=cv2.INTER_CUBIC) * U(r, 10, 60)
    elif k < 0.88:  # holo / silver / metallic sleeves
        lum = U(r, 120, 230)
        tex[:] = lum + (U(r, -50, 50) * ((xx - 0.5) * math.cos(t) + (yy - 0.5) * math.sin(t)))[..., None]
        tex += cv2.resize(r.uniform(-1, 1, (int(r.integers(4, 30)), int(r.integers(4, 30)), 1)).astype(np.float32), (TW, TH),
                          interpolation=cv2.INTER_LINEAR)[..., None] * U(r, 5, 35)
        if r.random() < 0.6:
            foil(tex, r)
        if r.random() < 0.4:  # prismatic starburst lines
            for _ in range(int(r.integers(5, 25))):
                a = U(r, 0, math.pi)
                cx, cy = TW * U(r, 0, 1), TH * U(r, 0, 1)
                d = np.array([math.cos(a), math.sin(a)]) * TH
                cv2.line(tex, (int(cx - d[0]), int(cy - d[1])), (int(cx + d[0]), int(cy + d[1])),
                         tuple(float(v) for v in r.integers(100, 256, 3)), int(r.integers(1, 3)), cv2.LINE_AA)
    # else: plain colour with a gradient
    tex += r.normal(0, U(r, 0, 5), tex.shape).astype(np.float32)
    return np.clip(tex, 0, 255)


def add_sleeve(tex: np.ndarray, r, colour=None) -> np.ndarray:
    """A face-up card in a sleeve: coloured margins (the card sits low: bigger top margin), haze."""
    ml, mr = int(U(r, 0.015, 0.05) * TW), int(U(r, 0.015, 0.05) * TW)
    mt, mb = int(U(r, 0.03, 0.08) * TW), int(U(r, 0.01, 0.04) * TW)
    col = np.float32(colour if colour is not None else C(r, SLEEVE_DARK if r.random() < 0.7 else SLEEVE_LIGHT)) * U(r, 0.8, 1.15)
    obj = np.empty((TH + mt + mb, TW + ml + mr, 3), np.float32)
    obj[:] = col
    obj[mt - 1:mt + TH + 1, ml - 1:ml + TW + 1] *= 0.6
    obj[mt:mt + TH, ml:ml + TW] = tex
    haze = U(r, 0.0, 0.12)
    obj[mt:mt + TH, ml:ml + TW] = obj[mt:mt + TH, ml:ml + TW] * (1 - haze) + 200 * haze
    return obj


# ---------------------------------------------------------------- geometry

def corners(cx, cy, w, h, a) -> np.ndarray:
    """As boxCorners in src/offscreen/geometry.ts: TL, TR, BR, BL of a w x h box turned a radians clockwise (y down)."""
    c, s = math.cos(a), math.sin(a)
    pts = [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]
    return np.float32([(cx + dx * c - dy * s, cy + dx * s + dy * c) for dx, dy in pts])


def wrap_angle(a: float) -> float:
    """An outline's angle modulo 180 degrees, in [-90, 90) degrees (radians)."""
    return (a + math.pi / 2) % math.pi - math.pi / 2


@dataclass
class Obj:
    cls: int  # FACE_UP, FACE_DOWN or IGNORE (a fanned hand etc.)
    cx: float
    cy: float
    w: float
    h: float
    angle: float  # visual rotation (radians, clockwise); the label is wrap_angle(angle)
    quad: np.ndarray  # drawn outline (4x2), may include perspective
    area: float = 0.0
    visible: float = 1.0
    note: str = ""
    extra: dict = field(default_factory=dict)


class Canvas:
    """The frame being drawn, with an owner map (which object each pixel shows) for visibility."""

    def __init__(self, h: int, w: int):
        self.h, self.w = h, w
        self.img = np.zeros((h, w, 3), np.float32)
        self.owner = np.full((h, w), -1, np.int16)
        self.objs: list[Obj] = []

    def blit(self, tex: np.ndarray, quad: np.ndarray, obj: Obj | None, r, shadow: float = 0.0, alpha: float = 1.0):
        """Warp a texture (h x w x 3 float32) onto quad (TL, TR, BR, BL) with anti-aliased edges."""
        x0 = max(0, int(math.floor(quad[:, 0].min())) - 3)
        y0 = max(0, int(math.floor(quad[:, 1].min())) - 3)
        x1 = min(self.w, int(math.ceil(quad[:, 0].max())) + 4)
        y1 = min(self.h, int(math.ceil(quad[:, 1].max())) + 4)
        if x1 - x0 < 2 or y1 - y0 < 2:
            if obj is not None:
                self._own(obj, quad)
            return
        th, tw = tex.shape[:2]
        side = max(np.linalg.norm(quad[1] - quad[0]), np.linalg.norm(quad[3] - quad[0]), 2.0)
        f = min(1.0, 2.0 * side / max(th, tw))  # pre-shrink so the warp doesn't alias
        if f < 1.0:
            tex = cv2.resize(tex, (max(4, int(tw * f)), max(4, int(th * f))), interpolation=cv2.INTER_AREA)
            th, tw = tex.shape[:2]
        rgba = np.zeros((th + 2, tw + 2, 4), np.float32)
        rgba[1:-1, 1:-1, :3] = tex
        rgba[1:-1, 1:-1, 3] = alpha
        src = np.float32([[1, 1], [tw + 1, 1], [tw + 1, th + 1], [1, th + 1]])
        M = cv2.getPerspectiveTransform(src, (quad - np.float32([x0, y0])).astype(np.float32))
        patch = cv2.warpPerspective(rgba, M, (x1 - x0, y1 - y0), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        region = self.img[y0:y1, x0:x1]
        if shadow > 0:
            m = cv2.GaussianBlur(patch[..., 3], (0, 0), max(0.8, side * 0.03))
            dx, dy = int(round(side * U(r, 0.0, 0.04))), int(round(side * U(r, 0.0, 0.05)))
            m = np.roll(np.roll(m, dy, 0), dx, 1)
            region *= (1 - shadow * m)[..., None]
        a = patch[..., 3:4]
        region[:] = region * (1 - a) + patch[..., :3] * a
        if obj is not None:
            self._own(obj, quad)

    def _own(self, obj: Obj, quad: np.ndarray):
        idx = self.objs.index(obj) if obj in self.objs else None
        if idx is None:
            self.objs.append(obj)
            idx = len(self.objs) - 1
        cv2.fillConvexPoly(self.owner, np.round(quad).astype(np.int32), int(idx), cv2.LINE_8)

    def occlude(self, mask: np.ndarray):
        """Pixels (bool mask) covered by something that is not a card (a hand, an overlay)."""
        self.owner[mask] = -1

    def add(self, obj: Obj):
        self.objs.append(obj)
        return obj


def quad_of(cx, cy, w, h, a, persp=0.0, r=None) -> np.ndarray:
    q = corners(cx, cy, w, h, a)
    if persp > 0 and r is not None:
        q = q + r.uniform(-persp, persp, (4, 2)).astype(np.float32) * w
    return q


def fit_box(q: np.ndarray):
    """(cx, cy, w, h, angle) of a near-rectangular quad TL, TR, BR, BL (w along TL->TR)."""
    c = q.mean(0)
    w = (np.linalg.norm(q[1] - q[0]) + np.linalg.norm(q[2] - q[3])) / 2
    h = (np.linalg.norm(q[3] - q[0]) + np.linalg.norm(q[2] - q[1])) / 2
    v = (q[3] - q[0] + q[2] - q[1]) / 2  # the box's "down" axis
    a = math.atan2(-v[0], v[1])  # angle of the down axis from +y, clockwise
    return float(c[0]), float(c[1]), float(w), float(h), a


# ---------------------------------------------------------------- objects on the mat

def rotation(r, base_choices=(0.0, 90.0, 180.0, 270.0), p=(0.42, 0.25, 0.13, 0.2), jitter=None) -> float:
    """Degrees -> radians: mostly 0/90/180/270 +- a few degrees, sometimes up to 15, rarely any angle."""
    u = r.random()
    if u < 0.1:
        return math.radians(U(r, 0, 360))
    base = base_choices[int(r.choice(len(base_choices), p=p))]
    j = jitter if jitter is not None else (U(r, -20, 20) if u < 0.4 else U(r, -4, 4))
    return math.radians(base + j)


def place_card(cv: Canvas, A: Assets, r, cx, cy, cw, ang, face_up=True, sleeved=None, persp=0.012, shadow=None, cls=None, tex=None,
               label=True, note="") -> Obj | None:
    """One card (sleeved or not). cw = the object's short side in frame pixels."""
    if tex is None:
        if face_up:
            tex = face_up_texture(A, r)
            sleeved = r.random() < 0.8 if sleeved is None else sleeved
            if sleeved:
                tex = add_sleeve(tex, r)
        else:
            tex = sleeve_back_texture(A, r)
    else:
        tex = tex.copy()
    if r.random() < 0.5:
        glare(tex, r, U(r, 0.3, 1.2))
    h = cw * tex.shape[0] / tex.shape[1]
    q = quad_of(cx, cy, cw, h, ang, persp * r.random(), r)
    cx2, cy2, w2, h2, a2 = fit_box(q)
    obj = Obj(cls if cls is not None else (FACE_UP if face_up else FACE_DOWN), cx2, cy2, w2, h2, a2, q, note=note)
    cv.blit(tex, q, obj if label else None, r, shadow=U(r, 0.2, 0.55) if (shadow if shadow is not None else r.random() < 0.5) else 0.0)
    return obj


def place_pile(cv: Canvas, A: Assets, r, cx, cy, cw, ang, top_face_up=False, n=None, messy=False):
    """A deck / extra deck / graveyard pile: stacked cards whose edges show on one or two sides."""
    n = n or int(r.integers(3, 12))
    back = sleeve_back_texture(A, r)
    edge = np.clip(back.mean((0, 1)) * U(r, 0.5, 1.2) + U(r, -20, 40), 0, 255)
    d = np.float32([math.cos(U(r, 0, 2 * math.pi)), math.sin(U(r, 0, 2 * math.pi))])
    d /= max(1e-3, np.linalg.norm(d))
    step = cw * U(r, 0.006, 0.03)
    h = cw / CARD_ASPECT
    for i in range(n, 0, -1):
        a = ang + (math.radians(U(r, -9, 9)) if messy else math.radians(U(r, -1.2, 1.2)))
        off = d * step * i + (r.uniform(-1, 1, 2) * cw * (0.08 if messy else 0.01))
        if messy and r.random() < 0.5:
            place_card(cv, A, r, cx + off[0], cy + off[1], cw, a, tex=back, label=False, shadow=(i == n))
        else:  # a card under the top one shows only its edge: a flat polygon with a darker rim
            q = corners(cx + off[0], cy + off[1], cw, h, a)
            col = tuple(float(v) for v in np.clip(edge * U(r, 0.8, 1.1), 0, 255))
            cv2.fillConvexPoly(cv.img, np.round(q * 4).astype(np.int32), col, cv2.LINE_AA, 2)
            cv2.polylines(cv.img, [np.round(q * 4).astype(np.int32)], True, tuple(c * 0.6 for c in col), 1, cv2.LINE_AA, 2)
    if top_face_up:
        return place_card(cv, A, r, cx, cy, cw, ang, face_up=True, note="pile-top")
    return place_card(cv, A, r, cx, cy, cw, ang, face_up=False, tex=back, note="pile")


def place_xyz(cv: Canvas, A: Assets, r, cx, cy, cw, ang):
    """An XYZ monster on its materials: 1-3 cards peeking out by a few percent."""
    objs = []
    for _ in range(int(r.integers(1, 4))):
        dx, dy = r.uniform(-0.12, 0.12, 2) * cw
        o = place_card(cv, A, r, cx + dx, cy + dy, cw, ang + math.radians(U(r, -6, 6)), face_up=r.random() < 0.8, note="material")
        objs.append(o)
    objs.append(place_card(cv, A, r, cx, cy, cw, ang, face_up=True, note="xyz"))
    return objs


def place_fan(cv: Canvas, A: Assets, r, cx, cy, cw, ang):
    """A fanned hand of cards HELD at the table's edge (face-up or face-down): ignored in training and evaluation.
    (A hand laid out on the table is place_spread(layout="fan"), labelled like other cards.)"""
    k = int(r.integers(3, 8))
    face_up = r.random() < 0.4
    spread = math.radians(U(r, 4, 14))
    piv = np.float32([cx, cy]) + np.float32([-math.sin(ang), math.cos(ang)]) * cw * 1.2
    objs = []
    for i in range(k):
        a = ang + (i - (k - 1) / 2) * spread
        c = piv + np.float32([math.sin(a), -math.cos(a)]) * cw * 1.2
        o = place_card(cv, A, r, float(c[0]), float(c[1]), cw, a, face_up=face_up, cls=IGNORE, note="fan")
        objs.append(o)
    return objs


# spreads (DET-SPREADS, stack-outline-report.md option 6): face-up cards lying on the table, overlapping
SPREAD_POS_MIN = 0.4  # a covered card of a trail/scatter spread is a positive from this visible share (others: 0.5)
SPREAD_ZONE_SHARE = 0.08  # zone spreads: about this share of the zones that hold something
SPREAD_LOOSE_P = 0.25  # a frame's chance of one loose spread
TABLE_FAN_P = 0.1  # a frame's chance of a hand laid out as a fan on the table


def place_spread(cv: Canvas, A: Assets, r, cx, cy, cw, ang, layout: str = "trail", where: str = "loose") -> list[Obj]:
    """Face-up cards spread on the table and overlapping (a Graveyard or banished pile spread out, cards set down
    loosely, a hand laid out): 2-5 face-up cards, and a quarter of the time one face-down card among them.
      trail    each card 15-60% of a card's width from the one before, heading one way (+-20 degrees per step), like
               the Graveyard of bBbjafm1u2Q t=7770 (stack-outline-report.md)
      scatter  the same steps, each in any direction
      fan      turned about a pivot below them, 4-14 degrees and 35-85% of a card's width apart: a hand laid out on the
               table (not held)
    Trail and scatter: each card turned 0-15 degrees from the one before, all one way or mixed (at most 35 degrees from
    the first). Drawn in lay order (each on top of the one before) or, 30% of the time, in a random order; one
    player's sleeves or random ones. Labels: a trail/scatter card is a positive from 0.4 visible (extra['pos_min'];
    the top card lies whole), a fan's cards like any other card's (0.5); label_of. Every card is an Obj with
    extra['spread'] = layout, extra['where'] ('zone' | 'loose'), extra['z'] (0 = drawn first) and extra['sid'] (the
    spread's id within the frame)."""
    sid = len(cv.objs)
    n_up = int(r.choice([2, 3, 4, 5], p=[0.3, 0.3, 0.22, 0.18]))
    n = n_up + int(r.random() < 0.25)
    down_at = int(r.integers(n)) if n > n_up else -1
    sgn = 1.0 if r.random() < 0.5 else -1.0
    if layout == "fan":
        step = math.radians(U(r, 4, 14)) * sgn
        rad = cw * U(r, 0.35, 0.85) / abs(step)  # neighbours 35-85% of a card's width apart (t=7770's laid-out fan: 65-80%)
        piv = np.float32([cx, cy]) + np.float32([-math.sin(ang), math.cos(ang)]) * rad
        angs = [ang + (k - (n - 1) / 2) * step + math.radians(U(r, -2, 2)) for k in range(n)]
        pos = [piv + np.float32([math.sin(a), -math.cos(a)]) * rad * U(r, 0.96, 1.04) for a in angs]
    else:
        one_way = r.random() < 0.5
        phi = U(r, 0, 2 * math.pi)
        steps, turns = [np.float32([0, 0])], [0.0]
        for _ in range(1, n):
            t = phi + math.radians(r.normal(0, 20)) if layout == "trail" else U(r, 0, 2 * math.pi)
            steps.append(steps[-1] + np.float32([math.cos(t), math.sin(t)]) * U(r, 0.15, 0.6) * cw)
            d = math.radians(U(r, 0, 15)) * (sgn if one_way else (1.0 if r.random() < 0.5 else -1.0))
            if abs(turns[-1] + d) > math.radians(35):
                d = -d
            turns.append(turns[-1] + d)
        P = np.stack(steps)
        pos = list(np.float32([cx, cy]) + (P - P.mean(0)))  # centred on (cx, cy)
        angs = [ang + t for t in turns]
    order = list(range(n)) if r.random() < 0.7 else [int(v) for v in r.permutation(n)]
    same = r.random() < 0.5
    col = C(r, SLEEVE_DARK if r.random() < 0.7 else SLEEVE_LIGHT)
    objs = []
    for z, k in enumerate(order):
        if k == down_at:
            tex, face_up = sleeve_back_texture(A, r), False
        else:
            tex, face_up = face_up_texture(A, r), True
            if r.random() < (0.85 if same else 0.8):
                tex = add_sleeve(tex, r, colour=col if same else None)
        o = place_card(cv, A, r, float(pos[k][0]), float(pos[k][1]), cw * U(r, 0.97, 1.03), angs[k], face_up=face_up, tex=tex,
                       note=f"spread-{layout}")
        o.extra.update(spread=layout, where=where, z=z, sid=sid)
        if layout != "fan":
            o.extra["pos_min"] = SPREAD_POS_MIN
        objs.append(o)
    return objs


def zone_spreads(cv: Canvas, A: Assets, r, zones, filled, cw):
    """Spreads in the outer zone columns (the Graveyard / banished side; the outer rows on a mat turned 90 degrees),
    in zones left empty, about SPREAD_ZONE_SHARE of the zones that hold something. r: the spreads' own stream."""
    if not zones or not any(filled):
        return
    at = (lambda z: z[1]) if zones[0][5] else (lambda z: z[0])
    lo, hi = min(at(z) for z in zones), max(at(z) for z in zones)
    outer = [i for i, z in enumerate(zones) if not filled[i] and at(z) in (lo, hi)]
    if not outer:
        return
    p = min(1.0, SPREAD_ZONE_SHARE / (1 - SPREAD_ZONE_SHARE) * sum(filled) / len(outer))
    for i in outer:
        if r.random() >= p:
            continue
        zx, zy, zw, zh, owner, vert = zones[i]
        base = (90.0 if vert else 0.0) + (90.0 if r.random() < 0.15 else 0.0) + (180.0 if owner == 0 and r.random() < 0.6 else 0.0)
        ang = math.radians(base + (U(r, -20, 20) if r.random() < 0.3 else U(r, -4, 4)))
        place_spread(cv, A, r, zx + zw / 2 + U(r, -0.1, 0.1) * zw, zy + zh / 2 + U(r, -0.1, 0.1) * zh, cw * U(r, 0.94, 1.06), ang,
                     layout="trail" if r.random() < 0.7 else "scatter", where="zone")


def loose_spreads(cv: Canvas, A: Assets, r, mrect, cw):
    """A loose spread (SPREAD_LOOSE_P of frames) and a hand laid out as a fan (TABLE_FAN_P), anywhere on the mat."""
    x0, y0, x1, y1 = mrect
    for layout, p in (("trail" if r.random() < 0.6 else "scatter", SPREAD_LOOSE_P), ("fan", TABLE_FAN_P)):
        if r.random() >= p:
            continue
        m = min(cw, (x1 - x0) / 4, (y1 - y0) / 4)
        place_spread(cv, A, r, U(r, x0 + m, x1 - m), U(r, y0 + m, y1 - m), cw * U(r, 0.94, 1.06), rotation(r), layout=layout, where="loose")


# ---------------------------------------------------------------- mats and zones

def zone_style(r, kind):
    if kind == "ycs":
        return dict(glow=True, thick=U(r, 1.5, 3.0), colours=[(C(r, [(90, 140, 255), (120, 170, 255), (80, 200, 255)])),
                                                             (C(r, [(255, 80, 120), (255, 110, 150), (240, 90, 90)]))])
    if kind == "wc":
        return dict(glow=False, thick=U(r, 0.8, 1.8), colours=[(235, 235, 240), (240, 225, 200)])
    if kind == "wcq":
        return dict(glow=False, thick=U(r, 0.8, 1.6), colours=[(70, 60, 45), (80, 70, 50)])
    c1 = tuple(float(v) for v in r.integers(0, 256, 3))
    c2 = tuple(float(v) for v in r.integers(0, 256, 3)) if r.random() < 0.5 else c1
    return dict(glow=r.random() < 0.3, thick=U(r, 0.8, 3.5), colours=[c1, c2], dashed=r.random() < 0.15)


ZONE_WORDS = ["MAIN MONSTER ZONE", "SPELL & TRAP ZONE", "FIELD ZONE", "GRAVEYARD", "DECK", "EXTRA DECK", "PENDULUM ZONE",
              "EXTRA MONSTER ZONE", "BANISHED"]


def zone_extras(img, r, zones, style):
    """Printed zone furniture: tinted interiors and small labels along an edge (never a card)."""
    tint = r.random() < 0.35
    label = r.random() < 0.35
    tint_col = np.float32(r.integers(0, 256, 3))
    a = U(r, 0.06, 0.3)
    for (zx, zy, zw, zh, owner, vert) in zones:
        x0, y0, x1, y1 = int(zx), int(zy), int(zx + zw), int(zy + zh)
        if tint:
            sub = img[max(0, y0):max(0, y1), max(0, x0):max(0, x1)]
            sub[:] = sub * (1 - a) + tint_col * a
        if label and zw > 20:
            word = C(r, ZONE_WORDS)
            sc = max(0.22, min(zw, zh) / 260)
            (tw, th), _ = cv2.getTextSize(word, cv2.FONT_HERSHEY_SIMPLEX, sc, 1)
            mask = np.zeros((th + 6, tw + 4), np.uint8)
            cv2.putText(mask, word, (2, th + 2), cv2.FONT_HERSHEY_SIMPLEX, sc, 255, 1, cv2.LINE_AA)
            if zh > zw:
                mask = np.rot90(mask, 1 if r.random() < 0.5 else 3)
            mh, mw = mask.shape
            px = x0 + 3 if r.random() < 0.5 else x1 - mw - 3
            py = y0 + (zh - mh) / 2 if zh > zw else (y1 - mh - 3)
            px, py = int(px), int(py)
            if px >= 0 and py >= 0 and py + mh <= img.shape[0] and px + mw <= img.shape[1]:
                m = mask.astype(np.float32)[..., None] / 255 * U(r, 0.5, 1.0)
                col = np.float32(style["colours"][owner % len(style["colours"])])
                img[py:py + mh, px:px + mw] = img[py:py + mh, px:px + mw] * (1 - m) + col * m


def mat_logo(cv: "Canvas", A: Assets, r, cx, cy, size):
    """A printed logo/emblem on the mat about a card in size (e.g. YCS's centre logo): not a card."""
    s_ = int(size)
    if s_ < 12:
        return
    u = r.random()
    col = tuple(float(v) for v in r.integers(0, 256, 3))
    ink = tuple(float(v) for v in r.integers(150, 256, 3))
    if u < 0.4:
        cv2.circle(cv.img, (int(cx), int(cy)), s_ // 2, col, -1, cv2.LINE_AA)
        cv2.circle(cv.img, (int(cx), int(cy)), s_ // 2, ink, max(1, s_ // 20), cv2.LINE_AA)
    elif u < 0.75:
        w_, h_ = s_ * U(r, 0.6, 1.0), s_ * U(r, 0.5, 0.9)
        pts = np.float32([(cx, cy - h_ / 2), (cx + w_ / 2, cy - h_ / 5), (cx + w_ / 3, cy + h_ / 2), (cx - w_ / 3, cy + h_ / 2), (cx - w_ / 2, cy - h_ / 5)])
        cv2.fillPoly(cv.img, [pts.astype(np.int32)], col, cv2.LINE_AA)
        cv2.polylines(cv.img, [pts.astype(np.int32)], True, ink, max(1, s_ // 25), cv2.LINE_AA)
    else:  # a rectangular badge with an artwork (card-sized, but framed like a logo)
        w_, h_ = int(s_ * U(r, 0.7, 1.2)), int(s_ * U(r, 0.5, 0.9))
        art = cv2.resize(A.artwork(r), (max(4, w_), max(4, h_)), interpolation=cv2.INTER_AREA).astype(np.float32)
        x0, y0 = int(cx - w_ / 2), int(cy - h_ / 2)
        if x0 >= 0 and y0 >= 0 and x0 + w_ <= cv.w and y0 + h_ <= cv.h:
            cv.img[y0:y0 + h_, x0:x0 + w_] = cv.img[y0:y0 + h_, x0:x0 + w_] * 0.3 + art * 0.7
    put_text(cv.img, r, cx - s_ * 0.4, cy + s_ * 0.1, s_ / 60, ink, text=C(r, LOGO_WORDS))


def pattern_mat(sub, r):
    """Camo blotches, a starfield/splatter or marble veins over a mat."""
    h, w = sub.shape[:2]
    u = r.random()
    if u < 0.4:  # camo: thresholded low-frequency noise in 2-4 colours
        n = cv2.resize(r.uniform(0, 1, (max(2, h // int(r.integers(12, 40))), max(2, w // int(r.integers(12, 40))))).astype(np.float32), (w, h),
                       interpolation=cv2.INTER_CUBIC)
        levels = np.sort(r.uniform(0.3, 0.7, int(r.integers(1, 3))))
        base = sub.mean((0, 1))
        for lv in levels:
            m = n > lv
            sub[m] = sub[m] * U(r, 0.55, 0.9) + np.float32(base) * 0.0 + U(r, -10, 25)
    elif u < 0.75:  # stars / splatter
        for _ in range(int(r.integers(80, 600))):
            x, y = int(r.integers(0, w)), int(r.integers(0, h))
            rad = int(max(1, r.exponential(1.2)))
            v = U(r, 120, 255)
            cv2.circle(sub, (x, y), rad, (v, v, v), -1, cv2.LINE_AA)
    else:  # marble veins
        xx, yy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
        nz = cv2.resize(r.uniform(-1, 1, (max(2, h // 30), max(2, w // 30))).astype(np.float32), (w, h), interpolation=cv2.INTER_CUBIC)
        v = np.abs(np.sin((xx * U(r, 0.01, 0.04) + yy * U(r, 0.01, 0.04) + nz * U(r, 3, 8))))
        sub += ((v < 0.08).astype(np.float32) * U(r, 30, 90))[..., None]


def draw_zones(img, r, zones, style):
    """Every zone outline; a glowing style's glow is one blurred layer for all of them."""
    if style.get("glow"):
        t = max(1, int(round(style["thick"])))
        layer = np.zeros_like(img)
        for (zx, zy, zw, zh, owner, vert) in zones:
            colour = style["colours"][owner % len(style["colours"])]
            cv2.rectangle(layer, (int(zx), int(zy)), (int(zx + zw), int(zy + zh)), colour, t + 3, cv2.LINE_AA)
        img += cv2.GaussianBlur(layer, (0, 0), U(r, 2, 5)) * U(r, 0.5, 1.0)
    for (zx, zy, zw, zh, owner, vert) in zones:
        draw_zone(img, r, zx, zy, zw, zh, style["colours"][owner % len(style["colours"])], style)


def draw_zone(img, r, x, y, w, h, colour, style):
    x, y, w, h = int(round(x)), int(round(y)), int(round(w)), int(round(h))
    t = max(1, int(round(style["thick"])))
    if style.get("glow"):  # (the glow itself is drawn by draw_zones)
        cv2.rectangle(img, (x, y), (x + w, y + h), tuple(min(255.0, c * 1.1 + 30) for c in colour), t, cv2.LINE_AA)
    elif style.get("dashed"):
        n = max(4, (w + h) // 8)
        pts = [(x + w * i / n, y) for i in range(n)] + [(x + w, y + h * i / n) for i in range(n)] + \
              [(x + w - w * i / n, y + h) for i in range(n)] + [(x, y + h - h * i / n) for i in range(n)]
        for i in range(0, len(pts) - 1, 2):
            cv2.line(img, (int(pts[i][0]), int(pts[i][1])), (int(pts[i + 1][0]), int(pts[i + 1][1])), colour, t, cv2.LINE_AA)
    else:
        cv2.rectangle(img, (x, y), (x + w, y + h), colour, t, cv2.LINE_AA)
        if r.random() < 0.15:  # double outline / corner marks
            m = max(2, int(w * 0.06))
            cv2.rectangle(img, (x + m, y + m), (x + w - m, y + h - m), colour, max(1, t - 1), cv2.LINE_AA)


def texture_noise(h, w, r, scale_lo=4, scale_hi=40, amp=12):
    k = int(r.integers(scale_lo, scale_hi))
    low = cv2.resize(r.uniform(-1, 1, (max(2, h // k), max(2, w // k), 1)).astype(np.float32), (w, h), interpolation=cv2.INTER_CUBIC)
    return low[..., None] * amp if low.ndim == 2 else low * amp


def mat_background(cv: Canvas, A: Assets, r, rect, kind):
    """Fill the mat rectangle; returns the mat's base colour."""
    x0, y0, x1, y1 = rect
    h, w = y1 - y0, x1 - x0
    sub = cv.img[y0:y1, x0:x1]
    if kind == "ycs":
        base = np.float32([U(r, 18, 45)] * 3) + np.float32([0, U(r, 0, 5), U(r, 2, 12)])
        sub[:] = base
        xx, yy = _grid(h, w)
        sub += (texture_noise(h, w, r, 20, 80, 6)).reshape(h, w, -1)
        # coloured light from the mat's edges
        glowc = np.float32([U(r, 60, 120), U(r, 60, 120), U(r, 150, 255)])
        sub += glowc * (np.exp(-xx * w / max(h, w) * U(r, 3, 8)) * U(r, 0.0, 0.35))[..., None]
    elif kind == "wc":
        split = U(r, 0.47, 0.53)
        horiz = w > h * 0.9
        c1 = np.float32([U(r, 20, 60), U(r, 80, 140), U(r, 190, 250)])
        c2 = np.float32([U(r, 200, 250), U(r, 60, 100), U(r, 40, 80)])
        if r.random() < 0.3:
            c1, c2 = np.float32(r.integers(0, 256, 3)), np.float32(r.integers(0, 256, 3))
        if horiz:
            s = int(w * split)
            sub[:, :s] = c1
            sub[:, s:] = c2
        else:
            s = int(h * split)
            sub[:s] = c1
            sub[s:] = c2
        sub += texture_noise(h, w, r, 10, 60, 10).reshape(h, w, -1)
        for _ in range(int(r.integers(2, 9))):  # gold swirls / flowers
            col = C(r, [(230, 190, 90), (250, 230, 180), (255, 255, 255), (240, 200, 210)])
            pts = np.cumsum(r.normal(0, min(h, w) * 0.05, (int(r.integers(4, 12)), 2)), 0) + np.float32([U(r, 0, w), U(r, 0, h)])
            cv2.polylines(sub, [pts.astype(np.int32)], False, col, int(r.integers(1, 4)), cv2.LINE_AA)
            for _ in range(int(r.integers(0, 6))):
                cv2.circle(sub, (int(U(r, 0, w)), int(U(r, 0, h))), int(r.integers(2, 9)), col, -1, cv2.LINE_AA)
    elif kind == "wcq":
        base = np.float32([U(r, 40, 75), U(r, 35, 60), U(r, 20, 40)])
        sub[:] = base
        sub += texture_noise(h, w, r, 10, 60, 8).reshape(h, w, -1)
        xx, yy = _grid(h, w)
        sub *= (1 + U(r, 0.1, 0.5) * np.exp(-((xx - U(r, 0.2, 0.8)) ** 2 + (yy - U(r, 0.2, 0.8)) ** 2) / U(r, 0.02, 0.2)))[..., None]
    else:  # random: flat, gradient, cloth noise, or a full-art playmat
        u = r.random()
        if u < 0.3:
            art = A.artwork(r)
            if r.random() < 0.5:
                art = cv2.cvtColor(cv2.cvtColor(art, cv2.COLOR_RGB2GRAY), cv2.COLOR_GRAY2RGB) if r.random() < 0.3 else art
            sub[:] = cv2.resize(art, (w, h), interpolation=cv2.INTER_LINEAR).astype(np.float32) * U(r, 0.35, 0.9)
        else:
            base = np.float32(r.integers(0, 256, 3)) * U(r, 0.2, 1.0)
            sub[:] = base
            xx, yy = _grid(h, w)
            t = U(r, 0, 2 * math.pi)
            sub += (U(r, -40, 40) * ((xx - 0.5) * math.cos(t) + (yy - 0.5) * math.sin(t)))[..., None]
            sub += texture_noise(h, w, r, 3, 50, U(r, 3, 25)).reshape(h, w, -1)
            if u > 0.8:  # woven cloth
                sub += (np.sin(np.arange(w, dtype=np.float32) * U(r, 1.5, 3.0))[None, :, None] * U(r, 2, 8))
    np.clip(sub, 0, 255, out=sub)


def mat_art(cv: Canvas, A: Assets, r, x, y, w, h, kind):
    """Artwork printed on the mat inside an ornate zone frame (WCQ's Exodia): NOT a card."""
    art = A.artwork(r)
    ah, aw = int(h), int(w)
    if ah < 4 or aw < 4:
        return
    a = cv2.resize(art, (aw, ah), interpolation=cv2.INTER_AREA).astype(np.float32)
    g = a.mean(2, keepdims=True)
    tint = np.float32([U(r, 0.9, 1.3), U(r, 0.75, 1.05), U(r, 0.4, 0.8)]) if kind == "wcq" else np.float32([1, 1, 1])
    sat = U(r, 0.0, 0.7)
    a = (g + sat * (a - g)) * tint * U(r, 0.45, 0.9)
    x, y = int(x), int(y)
    y1, x1 = min(cv.h, y + ah), min(cv.w, x + aw)
    if y1 <= max(0, y) or x1 <= max(0, x):
        return
    sub = cv.img[max(0, y):y1, max(0, x):x1]
    part = a[max(0, y) - y:y1 - y, max(0, x) - x:x1 - x]
    k = U(r, 0.6, 1.0)
    sub[:] = sub * (1 - k) + part * k
    col = C(r, [(200, 160, 70), (170, 140, 80), (230, 200, 120)])
    t = int(r.integers(1, 4))
    cv2.rectangle(cv.img, (x, y), (x + aw, y + ah), col, t, cv2.LINE_AA)
    if r.random() < 0.7:
        m = max(2, int(aw * U(r, 0.03, 0.08)))
        cv2.rectangle(cv.img, (x - m, y - m), (x + aw + m, y + ah + m), tuple(c * 0.8 for c in col), max(1, t - 1), cv2.LINE_AA)


def layout_zones(r, rect, cw, kind):
    """Zones (x, y, w, h) on the mat for cards of short side cw, and their owners (0 top/left player, 1 other)."""
    x0, y0, x1, y1 = rect
    W, H = x1 - x0, y1 - y0
    zw = cw * U(r, 1.04, 1.2)
    zh = zw / CARD_ASPECT * U(r, 0.97, 1.03)
    vertical_mat = kind == "wc" or (kind in ("random", "close") and r.random() < 0.2)
    if vertical_mat:  # players left and right: landscape zones
        zw, zh = zh, zw
    gx = zw * U(r, 1.08, 1.6)
    gy = zh * U(r, 1.08, 1.5)
    ncol = max(1, int((W - zw * 0.3) // gx))
    nrow = max(1, int((H - zh * 0.3) // gy))
    ox = x0 + (W - (ncol - 1) * gx - zw) / 2 + U(r, -0.2, 0.2) * gx
    oy = y0 + (H - (nrow - 1) * gy - zh) / 2 + U(r, -0.2, 0.2) * gy
    zones = []
    for i in range(nrow):
        if r.random() < 0.12 and not vertical_mat:  # an empty middle row (the gap between players)
            continue
        for j in range(ncol):
            if r.random() < 0.06:
                continue
            owner = (i >= nrow / 2) if not vertical_mat else (j >= ncol / 2)
            zones.append((ox + j * gx, oy + i * gy, zw, zh, int(owner), vertical_mat))
    return zones


# ---------------------------------------------------------------- broadcast overlay

def hexagons(img, r, colour, size):
    h, w = img.shape[:2]
    s = size
    for yi, y in enumerate(np.arange(-s, h + s, s * 1.5)):
        for x in np.arange(-s + (yi % 2) * s * 0.866, w + s, s * 1.732):
            pts = np.float32([(x + s * math.cos(math.radians(60 * k + 30)), y + s * math.sin(math.radians(60 * k + 30))) for k in range(6)])
            cv2.polylines(img, [pts.astype(np.int32)], True, colour, 1, cv2.LINE_AA)


def panel(cv: Canvas, r, x, y, w, h, border, fill=None, radius=0):
    x, y, w, h = int(x), int(y), int(w), int(h)
    if fill is not None:
        cv2.rectangle(cv.img, (x, y), (x + w, y + h), fill, -1)
    t = int(r.integers(1, 5))
    if r.random() < 0.5:  # glowing border
        layer = np.zeros_like(cv.img)
        cv2.rectangle(layer, (x, y), (x + w, y + h), border, t + 3)
        cv.img += cv2.GaussianBlur(layer, (0, 0), U(r, 2, 6)) * U(r, 0.4, 0.9)
    cv2.rectangle(cv.img, (x, y), (x + w, y + h), border, t, cv2.LINE_AA)
    m = np.zeros((cv.h, cv.w), bool)
    m[max(0, y):max(0, y + h + 1), max(0, x):max(0, x + w + 1)] = True
    cv.occlude(m)


def camera_view(cv: Canvas, A: Assets, r, x, y, w, h):
    """A player-cam: blurry colourful content (a stand-in), sometimes a person-ish silhouette."""
    x, y, w, h = int(x), int(y), int(w), int(h)
    if w < 8 or h < 8:
        return
    art = A.artwork(r)
    v = cv2.resize(art, (w, h), interpolation=cv2.INTER_LINEAR).astype(np.float32)
    v = cv2.GaussianBlur(v, (0, 0), U(r, 1, 6)) * U(r, 0.4, 0.9)
    if r.random() < 0.7:  # head and shoulders
        c = (int(w * U(r, 0.3, 0.7)), int(h * U(r, 0.3, 0.55)))
        skin = C(r, SKIN)
        cv2.ellipse(v, (c[0], c[1] + int(h * 0.55)), (int(w * 0.35), int(h * 0.3)), 0, 0, 360, tuple(float(q) for q in r.integers(0, 256, 3)), -1, cv2.LINE_AA)
        cv2.ellipse(v, c, (int(w * 0.11), int(h * 0.17)), 0, 0, 360, skin, -1, cv2.LINE_AA)
    y1, x1 = min(cv.h, y + h), min(cv.w, x + w)
    if y1 > max(0, y) and x1 > max(0, x):
        cv.img[max(0, y):y1, max(0, x):x1] = v[max(0, y) - y:y1 - y, max(0, x) - x:x1 - x]


def broadcast(cv: Canvas, A: Assets, r, mat_rect, kind, featured_w):
    """Everything outside the mat: backdrop, cams, bars, logos, featured-card panel(s)."""
    H, W = cv.h, cv.w
    x0, y0, x1, y1 = mat_rect
    back = np.zeros((H, W), bool)
    back[:, :x0] = True
    back[:, x1:] = True
    back[:y0] = True
    back[y1:] = True
    base = np.float32(C(r, [(15, 20, 45), (20, 15, 25), (60, 15, 20), (10, 10, 15), (35, 35, 60)])) * U(r, 0.6, 1.5)
    if kind == "wcq":
        base = np.float32([U(r, 60, 110), U(r, 10, 30), U(r, 10, 30)])
    bg = np.empty_like(cv.img)
    bg[:] = base
    if r.random() < 0.6:
        hexagons(bg, r, tuple(float(v) for v in np.clip(base * U(r, 1.3, 2.5) + 10, 0, 255)), int(r.integers(14, 40)))
    if r.random() < 0.4:  # diagonal stripes
        for _ in range(int(r.integers(2, 8))):
            p = int(U(r, -W, W))
            cv2.line(bg, (p, 0), (p + H, H), tuple(float(v) for v in np.clip(base * U(r, 1.2, 3), 0, 255)), int(r.integers(3, 30)))
    bg += texture_noise(H, W, r, 20, 90, 6).reshape(H, W, -1)
    for (a0, a1, b0, b1) in ((0, H, 0, x0), (0, H, x1, W), (0, y0, x0, x1), (y1, H, x0, x1)):
        if a1 > a0 and b1 > b0:
            cv.img[a0:a1, b0:b1] = bg[a0:a1, b0:b1]
    cv.occlude(back)
    side_l, side_r = x0, W - x1
    # player cams
    for side, sw in (("l", side_l), ("r", side_r)):
        if sw < 60 or r.random() < 0.15:
            continue
        cw_ = sw * U(r, 0.7, 0.92)
        ch_ = cw_ * U(r, 0.55, 1.05)
        cx_ = (sw - cw_) / 2 if side == "l" else x1 + (sw - cw_) / 2
        cy_ = H * U(r, 0.05, 0.3)
        border = C(r, [(80, 160, 255), (255, 80, 110), (230, 230, 230), (255, 200, 60)])
        camera_view(cv, A, r, cx_, cy_, cw_, ch_)
        panel(cv, r, cx_, cy_, cw_, ch_, border)
        # name bar and LP box under it
        by = cy_ + ch_ + U(r, 2, 20)
        bh = H * U(r, 0.035, 0.06)
        cv2.rectangle(cv.img, (int(cx_), int(by)), (int(cx_ + cw_), int(by + bh)), tuple(float(v) for v in np.float32(border) * U(r, 0.3, 0.8)), -1)
        put_text(cv.img, r, cx_ + 6, by + bh * 0.75, bh / 40, (250, 250, 250))
        ly = by + bh + U(r, 10, 60)
        cv2.rectangle(cv.img, (int(cx_), int(ly)), (int(cx_ + cw_), int(ly + bh * 1.4)), tuple(float(v) for v in np.float32(border) * 0.4), -1)
        put_text(cv.img, r, cx_ + cw_ * 0.3, ly + bh * 1.2, bh / 28, (255, 255, 255), text=str(int(r.integers(0, 9)) * 1000 + int(r.integers(0, 2)) * 500))
        if r.random() < 0.6:  # a round logo / timer box
            ly2 = ly + bh * 2 + U(r, 10, 50)
            if r.random() < 0.5:
                cv2.circle(cv.img, (int(cx_ + cw_ / 2), int(ly2 + cw_ * 0.3)), int(cw_ * U(r, 0.2, 0.4)),
                           tuple(float(v) for v in r.integers(0, 256, 3)), -1, cv2.LINE_AA)
                put_text(cv.img, r, cx_ + cw_ * 0.15, ly2 + cw_ * 0.35, cw_ / 180, tuple(float(v) for v in r.integers(0, 256, 3)))
            else:
                cv2.rectangle(cv.img, (int(cx_), int(ly2)), (int(cx_ + cw_), int(ly2 + bh * 2)), (15, 15, 15), -1)
                put_text(cv.img, r, cx_ + cw_ * 0.2, ly2 + bh * 1.5, bh / 25, (255, 255, 255), text=f"{int(r.integers(0, 60)):02d}:{int(r.integers(0, 60)):02d}")
    # top/bottom bars with text
    if y0 > 12:
        put_text(cv.img, r, U(r, 0, W * 0.3), y0 * U(r, 0.5, 0.85), y0 / 45, tuple(float(v) for v in r.integers(150, 256, 3)))
    if H - y1 > 12:
        for _ in range(int(r.integers(1, 5))):
            put_text(cv.img, r, U(r, 0, W * 0.8), y1 + (H - y1) * U(r, 0.5, 0.9), (H - y1) / 40, (235, 235, 235))
    # art-only side panels (not a card: an artwork in a near-square panel)
    objs = []
    if r.random() < (0.5 if kind == "wcq" else 0.12):
        for side, sw in (("l", side_l), ("r", side_r)):
            if sw < 80:
                continue
            aw = sw * U(r, 0.9, 1.0)
            ah = aw * U(r, 0.8, 1.15)
            ax = 0 if side == "l" else x1
            ay = H * U(r, 0.3, 0.45)
            art = cv2.resize(A.artwork(r), (int(aw), int(ah)), interpolation=cv2.INTER_LINEAR).astype(np.float32)
            yy1, xx1 = min(H, int(ay) + art.shape[0]), min(W, int(ax) + art.shape[1])
            cv.img[int(ay):yy1, int(ax):xx1] = art[:yy1 - int(ay), :xx1 - int(ax)]
    # the featured-card panel(s)
    if featured_w > 0:
        sides = [s for s, sw in (("l", side_l), ("r", side_r)) if sw > featured_w * 1.05]
        if sides:
            both = kind == "wc" and len(sides) == 2 and r.random() < 0.7
            for side in (sides if both else [C(r, sides)]):
                fw = featured_w * U(r, 0.95, 1.05)
                fh = fw / CARD_ASPECT
                sw = side_l if side == "l" else side_r
                fx = (sw - fw) / 2 if side == "l" else x1 + (sw - fw) / 2
                fy = min(H - fh - 4, H * U(r, 0.5, 0.65))
                if fy < 0:
                    continue
                m = U(r, 2, 10)
                border = C(r, [(80, 160, 255), (255, 80, 110), (230, 230, 230), (40, 40, 40)])
                panel(cv, r, fx - m, fy - m, fw + 2 * m, fh + 2 * m, border, fill=(8, 8, 10))
                u = r.random()
                q = corners(fx + fw / 2, fy + fh / 2, fw, fh, 0.0)
                if u < 0.72:
                    tex = face_up_texture(A, r)
                    o = Obj(FACE_UP, *fit_box(q), quad=q, note="featured")
                    cv.blit(tex, q, o, r)
                    objs.append(o)
                elif u < 0.85:
                    o = Obj(FACE_DOWN, *fit_box(q), quad=q, note="featured-back")
                    cv.blit(A.back.astype(np.float32), q, o, r)
                    objs.append(o)
                elif r.random() < 0.6:  # an empty card-shaped panel with a placeholder (an oval, a logo): NOT a card
                    col = tuple(float(v) for v in np.float32(border) * U(r, 0.5, 1.0))
                    if r.random() < 0.6:
                        cv2.ellipse(cv.img, (int(fx + fw / 2), int(fy + fh / 2)), (int(fw * U(r, 0.15, 0.35)), int(fh * U(r, 0.15, 0.3))), 0, 0, 360, col,
                                    int(r.integers(1, 4)), cv2.LINE_AA)
                    else:
                        put_text(cv.img, r, fx + fw * 0.1, fy + fh * 0.5, fw / 150, col, text=C(r, LOGO_WORDS))
                # else: an empty (black) featured panel: card-shaped, NOT a card
    return objs


# ---------------------------------------------------------------- occluders

def arm(cv: Canvas, r, start, end, width):
    """An arm from outside the frame to `end`, ending in a hand (palm + fingers), drawn in its own box."""
    d = np.float32(end) - np.float32(start)
    d /= max(1e-3, np.linalg.norm(d))
    palm = np.float32(end) + d * width * 0.5
    pad = width * 3.2
    xs = [start[0], end[0], palm[0]]
    ys = [start[1], end[1], palm[1]]
    bx0, by0 = int(max(0, min(xs) - pad)), int(max(0, min(ys) - pad))
    bx1, by1 = int(min(cv.w, max(xs) + pad)), int(min(cv.h, max(ys) + pad))
    if bx1 - bx0 < 4 or by1 - by0 < 4:
        return
    o = np.float32([bx0, by0])
    P = lambda p: (int(p[0] - o[0]), int(p[1] - o[1]))  # noqa: E731
    layer = np.zeros((by1 - by0, bx1 - bx0), np.uint8)
    # a forearm that narrows towards the wrist
    w0, w1 = width * U(r, 1.1, 1.5), width
    n = np.float32([-d[1], d[0]])
    poly = np.float32([np.float32(start) + n * w0 / 2, np.float32(end) + n * w1 / 2, np.float32(end) - n * w1 / 2, np.float32(start) - n * w0 / 2]) - o
    cv2.fillConvexPoly(layer, np.round(poly * 4).astype(np.int32), 255, cv2.LINE_AA, 2)
    cv2.ellipse(layer, P(palm), (int(width * 0.75), int(width * 0.6)), math.degrees(math.atan2(d[1], d[0])), 0, 360, 255, -1, cv2.LINE_AA)
    for i in range(int(r.integers(1, 5))):
        a = math.atan2(d[1], d[0]) + U(r, -0.7, 0.7)
        tip = palm + np.float32([math.cos(a), math.sin(a)]) * width * U(r, 0.8, 1.6)
        cv2.line(layer, P(palm), P(tip), 255, max(2, int(width * U(r, 0.18, 0.28))), cv2.LINE_AA)
    m = cv2.GaussianBlur(layer, (0, 0), 1.0).astype(np.float32) / 255
    sub = cv.img[by0:by1, bx0:bx1]
    col = np.empty_like(sub)
    col[:] = np.float32(C(r, SKIN)) * U(r, 0.75, 1.1)
    if r.random() < 0.4:  # a shirt sleeve on the forearm
        sl = np.zeros(layer.shape, np.uint8)
        mid = np.float32(start) + (np.float32(end) - np.float32(start)) * U(r, 0.3, 0.7)
        cv2.line(sl, P(start), P(mid), 255, int(width * 1.6), cv2.LINE_AA)
        col[sl > 0] = np.float32(r.integers(0, 256, 3))
    # shading across the arm (rounder look) and a little texture
    yy, xx = np.mgrid[0:layer.shape[0], 0:layer.shape[1]].astype(np.float32)
    across = ((xx + o[0] - start[0]) * n[0] + (yy + o[1] - start[1]) * n[1]) / max(1.0, width)
    shade = (1 - U(r, 0.1, 0.35) * np.clip(np.abs(across), 0, 1.5) ** 2)[..., None]
    sub[:] = sub * (1 - m[..., None]) + col * shade * m[..., None]
    full = np.zeros((cv.h, cv.w), bool)
    full[by0:by1, bx0:bx1] = m > 0.5
    cv.occlude(full)


def dice(cv: Canvas, r, cw):
    s = cw * U(r, 0.12, 0.25)
    x, y = U(r, 0, cv.w), U(r, 0, cv.h)
    q = corners(x, y, s, s, U(r, 0, math.pi))
    cv2.fillConvexPoly(cv.img, q.astype(np.int32), tuple(float(v) for v in r.integers(0, 256, 3)), cv2.LINE_AA)
    for _ in range(int(r.integers(1, 6))):
        cv2.circle(cv.img, (int(x + U(r, -s / 3, s / 3)), int(y + U(r, -s / 3, s / 3))), max(1, int(s * 0.1)), (240, 240, 240), -1, cv2.LINE_AA)


# ---------------------------------------------------------------- camera / codec

_NOISE = None


def _noise_bank():
    global _NOISE
    if _NOISE is None:
        _NOISE = np.random.default_rng(1234).standard_normal((1024, 1536, 3)).astype(np.float32)
    return _NOISE


def _smooth_field(h, w, r, cells=6):
    """A smooth random field in [-1, 1] (low resolution, resized): lighting and vignettes."""
    return cv2.resize(r.uniform(-1, 1, (cells, cells)).astype(np.float32), (w, h), interpolation=cv2.INTER_CUBIC)


def degrade(img: np.ndarray, r, level: float = 1.0) -> np.ndarray:
    """Phase 2's camera/ISP/codec chain on a whole frame (float32 in, uint8 out); written to keep memory
    traffic low (the trainer's GPU work shares the memory bus): low-res lighting fields, a cached noise
    bank, gamma through a lookup table."""
    h, w = img.shape[:2]
    cap = img
    if r.random() < 0.5 * level:  # uneven light / vignette
        cap = cap * (1 + U(r, 0.1, 0.4) * _smooth_field(h, w, r, int(r.integers(2, 5))))[..., None]
    sig = U(r, 0.0, 1.3 * level)
    if sig > 0.25:
        cap = cv2.GaussianBlur(cap, (0, 0), sig)
    if r.random() < 0.1 * level:  # motion blur
        L = int(r.integers(2, 5))
        k = np.zeros((L * 2 + 1, L * 2 + 1), np.float32)
        t = U(r, 0, math.pi)
        cv2.line(k, (int(L - L * math.cos(t)), int(L - L * math.sin(t))), (int(L + L * math.cos(t)), int(L + L * math.sin(t))), 1.0, 1)
        cap = cv2.filter2D(cap, -1, k / k.sum())
    ct = r.choice(5, p=[0.3, 0.2, 0.2, 0.2, 0.1])
    s_ = U(r, 0.02, 0.22 * level)
    gains = [np.float32([1, 1, 1]), np.float32([1 + s_, 1 - 0.8 * s_, 1 + 0.4 * s_]), np.float32([1 + s_, 1 + 0.5 * s_, 1 - s_]),
             np.float32([1 - 0.6 * s_, 1, 1 + s_]), np.float32([1 - 0.5 * s_, 1 + s_, 1 - 0.5 * s_])][ct]
    sat = U(r, 0.55, 1.2)
    wa = U(r, max(0.45, 1 - 0.55 * level), 1.05)
    lift = (1 - wa) * 255 * U(r, 0.2, 0.9)
    # colour cast, saturation and washout as one 3x3 colour matrix + offset (a single pass)
    lum = np.float32([0.299, 0.587, 0.114])
    Msat = sat * np.eye(3, dtype=np.float32) + (1 - sat) * np.tile(lum, (3, 1))
    M = wa * (Msat @ np.diag(gains)).astype(np.float32)
    cap = cv2.transform(cap, M) + np.float32(lift)
    if r.random() < 0.4 * level:  # sharpening halos
        cap = cv2.addWeighted(cap, 1 + U(r, 0.3, 1.0), cv2.GaussianBlur(cap, (0, 0), U(r, 0.8, 1.6)), -U(r, 0.3, 1.0), 0)
    if r.random() < 0.5:
        bank = _noise_bank()
        y0, x0 = int(r.integers(0, bank.shape[0] - h + 1)) if h <= bank.shape[0] else 0, int(r.integers(0, bank.shape[1] - w + 1)) if w <= bank.shape[1] else 0
        if h <= bank.shape[0] and w <= bank.shape[1]:
            cap = cv2.scaleAdd(bank[y0:y0 + h, x0:x0 + w], U(r, 0.5, 4), cap)
    cap8 = np.clip(cap, 0, 255).astype(np.uint8)
    gamma = U(r, 0.8, 1.25)
    cap8 = cv2.LUT(cap8, np.clip(255 * (np.arange(256) / 255) ** gamma, 0, 255).astype(np.uint8))
    # the stream: resolution loss + codec blocking at the source scale, then back up to the screen
    f = 1.0 if r.random() < 0.2 else U(r, 0.45, 1.0)
    small = cv2.resize(cap8, (max(8, int(w * f)), max(8, int(h * f))), interpolation=cv2.INTER_AREA) if f < 1 else cap8
    for _ in range(2 if r.random() < 0.25 else 1):
        q = int(U(r, 22, 92))
        ok, buf = cv2.imencode(".jpg", cv2.cvtColor(small, cv2.COLOR_RGB2BGR),
                               [cv2.IMWRITE_JPEG_QUALITY, q, cv2.IMWRITE_JPEG_SAMPLING_FACTOR, cv2.IMWRITE_JPEG_SAMPLING_FACTOR_420])
        small = cv2.cvtColor(cv2.imdecode(buf, cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)
    if r.random() < 0.3:  # chroma smear
        ycc = cv2.cvtColor(small, cv2.COLOR_RGB2YCrCb)
        ycc[..., 1:] = cv2.GaussianBlur(ycc[..., 1:], (0, 0), U(r, 0.6, 1.5))
        small = cv2.cvtColor(ycc, cv2.COLOR_YCrCb2RGB)
    if f < 1:
        small = cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR if r.random() < 0.7 else cv2.INTER_CUBIC)
    if r.random() < 0.15:  # the screenshot's own light compression
        ok, buf = cv2.imencode(".jpg", cv2.cvtColor(small, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, int(U(r, 70, 95))])
        small = cv2.cvtColor(cv2.imdecode(buf, cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)
    return small


# ---------------------------------------------------------------- the frame

KINDS = ("ycs", "wc", "wcq", "random", "close")
KIND_P = (0.24, 0.2, 0.16, 0.25, 0.15)


def card_width(r, kind) -> float:
    """The frame's card size (short side, working-scale px): 28-290, most at 45-110."""
    if kind == "close":
        return math.exp(U(r, math.log(110), math.log(290)))
    u = r.random()
    if u < 0.12:
        return U(r, 26, 42)
    if u < 0.85:
        return math.exp(U(r, math.log(42), math.log(115)))
    return math.exp(U(r, math.log(115), math.log(180)))


def render_frame(A: Assets, r, W: int = 1280, H: int = 720, kind: str | None = None, spreads: bool = True):
    """A synthetic broadcast frame (uint8 RGB H x W) and its objects (Obj, frame pixels).

    spreads: add face-up spreads (zone_spreads, loose_spreads). They draw from their own random stream (spawned from
    r, which spawning doesn't advance), so every other object of the frame is the same as with spreads=False, which
    renders exactly the generator as it was before DET-SPREADS."""
    rs = r.spawn(1)[0] if spreads else None
    kind = kind or KINDS[int(r.choice(len(KINDS), p=KIND_P))]
    cv = Canvas(H, W)
    cw = card_width(r, kind)
    # mat rectangle: the broadcast frames the mat in the middle; 'close' fills the frame
    if kind == "close" or r.random() < 0.12:
        mat = (0, 0, W, H)
        bc = False
    else:
        mw = W * (U(r, 0.55, 0.68) if kind != "random" else U(r, 0.45, 0.85))
        mx = (W - mw) / 2 + U(r, -0.04, 0.04) * W
        my0 = 0 if r.random() < 0.5 else int(U(r, 0.0, 0.1) * H)
        my1 = H if r.random() < 0.4 else int(H * U(r, 0.88, 1.0))
        mat = (int(max(0, mx)), my0, int(min(W, mx + mw)), my1)
        bc = True
    table = np.float32(C(r, [(12, 12, 14), (30, 30, 34), (50, 40, 35), (20, 22, 30)]))
    cv.img[:] = table + texture_noise(H, W, r, 30, 90, 4).reshape(H, W, -1)
    # the physical mat inside the view (a little inset, sometimes rotated a few degrees - skipped: zones stay axis-aligned)
    inset = int(U(r, 0, 0.05) * min(mat[2] - mat[0], mat[3] - mat[1]))
    mrect = (mat[0] + inset, mat[1] + inset, mat[2] - inset, mat[3] - inset)
    if mrect[2] - mrect[0] > 40 and mrect[3] - mrect[1] > 40:
        mat_background(cv, A, r, mrect, kind)
        if kind in ("random", "close", "ycs") and r.random() < 0.3:
            pattern_mat(cv.img[mrect[1]:mrect[3], mrect[0]:mrect[2]], r)
    zkind = kind if kind in ("ycs", "wc", "wcq") else ("random" if kind == "random" else C(r, ["ycs", "wc", "wcq", "random"]))
    style = zone_style(r, zkind)
    zones = layout_zones(r, mrect, cw, zkind)
    # mat art inside some zones (WCQ-style ornate frames), and printed logos on the mat
    art_p = {"wcq": 0.45, "random": 0.06, "close": 0.1}.get(kind, 0.0)
    for (zx, zy, zw, zh, owner, vert) in zones:
        if r.random() < art_p:
            m = U(r, 0.04, 0.12)
            mat_art(cv, A, r, zx - zw * m, zy - zh * m, zw * (1 + 2 * m), zh * (1 + 2 * m), zkind)
    if r.random() < 0.5:
        for _ in range(int(r.integers(1, 4))):
            put_text(cv.img, r, U(r, mrect[0], mrect[2]), U(r, mrect[1], mrect[3]), cw / U(r, 30, 70),
                     tuple(float(v) for v in r.integers(0, 256, 3)))
    if r.random() > 0.08:
        zone_extras(cv.img, r, zones, style)
        draw_zones(cv.img, r, zones, style)
    for _ in range(int(r.choice(3, p=[0.55, 0.35, 0.1]))):  # printed logos on the mat
        mat_logo(cv, A, r, U(r, mrect[0], mrect[2]), U(r, mrect[1], mrect[3]), cw * U(r, 0.8, 2.0))
    # cards in zones
    occ = U(r, 0.15, 0.75)
    filled = []
    for (zx, zy, zw, zh, owner, vert) in zones:
        filled.append(r.random() <= occ)
        if not filled[-1]:
            continue
        cx = zx + zw / 2 + U(r, -0.08, 0.08) * zw
        cy = zy + zh / 2 + U(r, -0.08, 0.08) * zh
        base = (90.0 if vert else 0.0)
        if r.random() < 0.3:  # defence position / set cards: turned 90 degrees in the zone
            base += 90.0
        up = owner == 0 and r.random() < 0.6  # the far player's cards often face them (180)
        ang = math.radians(base + (180.0 if up else 0.0) + (U(r, -20, 20) if r.random() < 0.3 else U(r, -4, 4)))
        if r.random() < 0.06:
            ang = math.radians(U(r, 0, 360))
        size = cw * U(r, 0.94, 1.06)
        u = r.random()
        if u < 0.5:
            place_card(cv, A, r, cx, cy, size, ang, face_up=True)
        elif u < 0.66:
            place_card(cv, A, r, cx, cy, size, ang, face_up=False)
        elif u < 0.82:
            place_pile(cv, A, r, cx, cy, size, ang, top_face_up=r.random() < 0.35, messy=r.random() < 0.2)
        elif u < 0.9:
            place_xyz(cv, A, r, cx, cy, size, ang)
        else:  # a face-up card lying across a pile / another card
            place_pile(cv, A, r, cx, cy, size, ang, top_face_up=False, n=int(r.integers(2, 6)))
            place_card(cv, A, r, cx + U(r, -0.3, 0.3) * size, cy + U(r, -0.3, 0.3) * size, size, ang + math.radians(C(r, [0, 90]) + U(r, -20, 20)), face_up=True)
    if spreads:  # Graveyard / banished spreads in empty outer zones (their own stream: nothing above or below changes)
        zone_spreads(cv, A, rs, zones, filled, cw)
    # loose cards anywhere on the mat (off-zone, any angle), fanned hands near the edges
    for _ in range(int(r.integers(0, 4))):
        cx, cy = U(r, mrect[0], mrect[2]), U(r, mrect[1], mrect[3])
        u = r.random()
        if u < 0.55:
            place_card(cv, A, r, cx, cy, cw * U(r, 0.94, 1.06), rotation(r), face_up=r.random() < 0.65)
        elif u < 0.8:
            place_pile(cv, A, r, cx, cy, cw, rotation(r), top_face_up=r.random() < 0.4, messy=r.random() < 0.4)
        else:
            edge = C(r, ["t", "b", "l", "r"])
            ex = {"l": mrect[0] + U(r, -0.5, 0.5) * cw, "r": mrect[2] + U(r, -0.5, 0.5) * cw}.get(edge, cx)
            ey = {"t": mrect[1] + U(r, -0.5, 0.5) * cw, "b": mrect[3] + U(r, -0.5, 0.5) * cw}.get(edge, cy)
            ang = {"t": math.pi, "b": 0.0, "l": math.pi / 2, "r": -math.pi / 2}[edge] + U(r, -0.4, 0.4)
            place_fan(cv, A, r, ex, ey, cw, ang)
    if spreads:  # a loose spread, a hand laid out on the table
        loose_spreads(cv, A, rs, mrect, cw)
    for _ in range(int(r.integers(0, 3))):
        dice(cv, r, cw)
    # arms and hands over the mat (reaching for the objects above; not the spreads, so the main stream stays as it was)
    n_arms = int(r.choice(4, p=[0.45, 0.3, 0.17, 0.08]))
    reach = [o for o in cv.objs if "spread" not in o.extra]
    for _ in range(n_arms):
        edge = C(r, ["t", "b", "l", "r"])
        sx = {"l": mrect[0] - cw, "r": mrect[2] + cw}.get(edge, U(r, mrect[0], mrect[2]))
        sy = {"t": mrect[1] - cw, "b": mrect[3] + cw}.get(edge, U(r, mrect[1], mrect[3]))
        if reach and r.random() < 0.6:
            o = C(r, reach)
            ex, ey = o.cx + U(r, -0.6, 0.6) * o.w, o.cy + U(r, -0.6, 0.6) * o.h
        else:
            ex, ey = U(r, mrect[0], mrect[2]), U(r, mrect[1], mrect[3])
        arm(cv, r, (sx, sy), (ex, ey), cw * U(r, 0.45, 0.9))
    # broadcast overlay on top (cams, bars, featured card panels)
    if bc:
        featured = 0.0 if r.random() < 0.2 else math.exp(U(r, math.log(150), math.log(260)))
        for o in broadcast(cv, A, r, mat, kind, featured):
            if o not in cv.objs:
                cv.objs.append(o)
    # visibility from the owner map
    counts = np.bincount(cv.owner[cv.owner >= 0].ravel(), minlength=len(cv.objs)) if len(cv.objs) else np.zeros(0)
    for i, o in enumerate(cv.objs):
        o.area = float(cv2.contourArea(o.quad.astype(np.float32)))
        o.visible = float(counts[i]) / max(1.0, o.area) if i < len(counts) else 0.0
    frame = cv.img
    if r.random() < (0.85 if kind == "close" else 0.3):  # a camera that isn't overhead: keystone every card
        frame = camera_tilt(cv, r, strength=U(r, 0.4, 1.0) if kind == "close" else U(r, 0.1, 0.45))
    img = degrade(frame, r, U(r, 0.4, 1.0))
    return img, [o for o in cv.objs], kind


def camera_tilt(cv: Canvas, r, strength: float) -> np.ndarray:
    """View the rendered (overhead) frame through a tilted camera: a random homography maps a
    trapezoid of the table (wider on the far side, the top, as a camera looking forward sees it;
    optionally wider on one side: yaw; turned: roll) onto the whole output frame. Every object's quad
    is mapped too (the labels become keystone quads). Returns the warped image."""
    H_, W_ = cv.h, cv.w
    k = U(r, 0.05, 0.5) * strength  # keystone: the far edge of the source is (1 + 2k) times the near one
    yaw = U(r, -0.25, 0.25) * strength
    roll = math.radians(U(r, -12, 12) * strength)
    # a steep camera also foreshortens the table's depth: the output sees a stretch of table taller than
    # it is wide (cards look squashed, a portrait card's image can be wider than tall)
    squash = U(r, 0.45, 1.0) if strength > 0.5 else U(r, 0.8, 1.0)
    zoom = U(r, 0.7, 1.0)
    w_, h_ = W_ * zoom, H_ * zoom / squash
    lo, hi = min(h_ / 2, H_ - h_ / 2), max(h_ / 2, H_ - h_ / 2)
    cx, cy = U(r, w_ / 2, W_ - w_ / 2), U(r, lo, hi)
    # the source trapezoid, centred: TL, TR, BR, BL (the order of dst)
    src = np.float32([[-w_ / 2 - k * w_, -h_ / 2], [w_ / 2 + k * w_, -h_ / 2], [w_ / 2, h_ / 2], [-w_ / 2, h_ / 2]])
    if yaw > 0:  # the left side is farther: its edge is longer in the source
        src[0, 1] -= yaw * h_
        src[3, 1] += yaw * h_
    else:
        src[1, 1] += yaw * h_
        src[2, 1] -= yaw * h_
    if r.random() < 0.35:  # seen from the other side: the far edge is the bottom (mirror, keep the corner order)
        src = src[[3, 2, 1, 0]] * np.float32([1, -1])
    c_, s_ = math.cos(roll), math.sin(roll)
    src = src @ np.float32([[c_, s_], [-s_, c_]]) + np.float32([cx, cy])
    src += r.uniform(-0.02, 0.02, (4, 2)).astype(np.float32) * np.float32([w_, h_])
    dst = np.float32([[0, 0], [W_, 0], [W_, H_], [0, H_]])
    Hm = cv2.getPerspectiveTransform(src.astype(np.float32), dst)
    border = tuple(float(v) for v in np.float32(C(r, [(12, 12, 14), (30, 30, 34), (50, 40, 35), (20, 22, 30), (70, 60, 50)])) * U(r, 0.7, 1.3))
    out = cv2.warpPerspective(cv.img, Hm, (W_, H_), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=border)
    for o in cv.objs:
        q = cv2.perspectiveTransform(o.quad.reshape(1, 4, 2).astype(np.float32), Hm)[0]
        o.quad = q
        o.cx, o.cy, o.w, o.h, o.angle = fit_box(q)
        o.area = float(abs(cv2.contourArea(q)))
    return out


# ---------------------------------------------------------------- training windows

def label_of(o: Obj, visible: float) -> int:
    """Training class of an object seen `visible` (share of its area): its class from half visible (a covered card
    of a trail/scatter spread from SPREAD_POS_MIN: extra['pos_min']), ignore down to 12%, then absent."""
    if o.cls == IGNORE:
        return IGNORE if visible > 0.1 else -2
    if visible >= o.extra.get("pos_min", 0.5):
        return o.cls
    return IGNORE if visible > 0.12 else -2  # -2: not there at all


ROW = 14  # cls, cx, cy, w, h, angle, then the 4 corners x0, y0 .. x3, y3


def row_of(cls, o: Obj, dx: float, dy: float, s: float = 1.0):
    """A label row: class, the fitted box (w, h along the card's own width and height edges, angle =
    the card's own "down" axis from +y, clockwise, NOT wrapped) and the quad's 4 corners in the card
    texture's order (its top-left, top-right, bottom-right, bottom-left), shifted by (dx, dy), scaled by s."""
    q = (o.quad.astype(np.float64) - np.float64([dx, dy])) * s
    return (cls, (o.cx - dx) * s, (o.cy - dy) * s, o.w * s, o.h * s, o.angle, *q.ravel().tolist())


def window(img: np.ndarray, objs: list[Obj], r, size: int = 640, focus: Obj | None = None):
    """A size x size training window (padded with grey where the frame is smaller) and its labels:
    rows (row_of) in window pixels, cls = 0/1 or -1 (ignore)."""
    H, W = img.shape[:2]
    if focus is not None:
        x0 = int(np.clip(focus.cx - U(r, 0.2, 0.8) * size, -size * 0.1, max(0, W - size * 0.9)))
        y0 = int(np.clip(focus.cy - U(r, 0.2, 0.8) * size, -size * 0.1, max(0, H - size * 0.9)))
    else:
        x0 = int(U(r, min(0, W - size), max(0, W - size)))
        y0 = int(U(r, min(0, H - size), max(0, H - size)))
    out = np.full((size, size, 3), 114, np.uint8)
    sx0, sy0 = max(0, x0), max(0, y0)
    sx1, sy1 = min(W, x0 + size), min(H, y0 + size)
    out[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = img[sy0:sy1, sx0:sx1]
    rows = []
    frame_win = np.float32([[sx0 - x0, sy0 - y0], [sx1 - x0, sy0 - y0], [sx1 - x0, sy1 - y0], [sx0 - x0, sy1 - y0]])
    for o in objs:
        q = (o.quad - np.float32([x0, y0])).astype(np.float32)
        vis = o.visible * inside_share(q, frame_win, o.area)
        cls = label_of(o, vis)
        if cls == -2:
            continue
        rows.append(row_of(cls, o, x0, y0))
    return out, np.float32(rows).reshape(-1, ROW)


def inside_share(q: np.ndarray, rect: np.ndarray, area: float) -> float:
    """Share of quad q's area (given) inside the convex polygon rect."""
    from targets import _area, clip_convex

    return _area(clip_convex(q, rect)) / max(1.0, area)


def drag_crop(img: np.ndarray, objs: list[Obj], r, focus: Obj, size: int = 640):
    """The drag case: a user's rough box around one card (5-60% margin, off-centre), resized so its
    long side is 256-576 px, in the top-left of a grey size x size canvas. Labels as in window()."""
    H, W = img.shape[:2]
    bw = (abs(math.sin(focus.angle)) * focus.h + abs(math.cos(focus.angle)) * focus.w)
    bh = (abs(math.cos(focus.angle)) * focus.h + abs(math.sin(focus.angle)) * focus.w)
    mx, my = U(r, 1.05, 1.6), U(r, 1.05, 1.6)
    cx, cy = focus.cx + U(r, -0.12, 0.12) * bw, focus.cy + U(r, -0.12, 0.12) * bh
    x0, x1 = int(max(0, cx - bw * mx / 2)), int(min(W, cx + bw * mx / 2))
    y0, y1 = int(max(0, cy - bh * my / 2)), int(min(H, cy + bh * my / 2))
    if x1 - x0 < 8 or y1 - y0 < 8:
        return window(img, objs, r, size, focus)
    crop = img[y0:y1, x0:x1]
    L = U(r, 256, 576)
    s = L / max(crop.shape[:2])
    nw, nh = max(8, int(round(crop.shape[1] * s))), max(8, int(round(crop.shape[0] * s)))
    crop = cv2.resize(crop, (nw, nh), interpolation=cv2.INTER_LINEAR if s > 1 else cv2.INTER_AREA)
    out = np.full((size, size, 3), 114, np.uint8)
    out[:nh, :nw] = crop
    rect = np.float32([[0, 0], [nw, 0], [nw, nh], [0, nh]])
    rows = []
    for o in objs:
        q = ((o.quad - np.float32([x0, y0])) * s).astype(np.float32)
        vis = o.visible * inside_share(q, rect, o.area * s * s)
        cls = label_of(o, vis)
        if cls == -2:
            continue
        rows.append(row_of(cls, o, x0, y0, s))
    return out, np.float32(rows).reshape(-1, ROW)
