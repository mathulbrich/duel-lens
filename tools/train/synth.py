"""Realistic synthetic renderings of an artwork as the engine sees it on a streamed duel mat.

One call renders a whole chain, seeded:
  card     the artwork pasted into a real full-card template of its frame type (name bar, stars,
           text box; pendulum illustrations under the pendulum box), optional holo/foil rainbow
  sleeve   coloured sleeve margins, plastic haze, glare bands, specular highlights, sheen
  scene    the card at 32-115 px of artwork width on a mat (zone outlines), 0/90/180/270 deg +-10 deg,
           camera perspective, optional hand occlusion; rendered 2x supersampled, then downscaled
  camera   uneven light, defocus and motion blur, white-balance cast (pink/magenta, yellow, blue,
           green), washout (low contrast, lifted blacks), gamma, desaturation, sharpening halos,
           noise, resolution loss, 4:2:0 chroma + JPEG blocking, chroma smear, deblocking
  detector a detector-like quad (sleeve or card, scale/shift/rotation/corner errors, or the plain
           axis-aligned box) straightened, ART_BOX cut at 448 px and resized to 224 like the engine
Levels: 'mild' (website/screenshot quality), 'video', 'hard'. Output: 224x224x3 uint8 RGB.

The combined retrain (run r4, combined-retrain-report.md) adds, through render(..., mix=MIX), four print and
scene effects the video chain never had, each with its own chance per view (the default mix=None draws no
extra random numbers, so r1/r2/r3 renderings and evalsuite's fixed sets are exactly as before):
  overframe  the illustration zoomed 1.05-1.95x over the WHOLE card (no frame; the rest continued from its
             reflected, blurred edges), the template's text box see-through over it, the name's strokes in
             gold, sometimes its stars and attribute icon; then a full-card foil on 60% (_overframe)
  occluder   fingers or a hand (shaded skin, nails), another card or sleeve, or dice and counters over
             15-50% of the card, in the scene (_occlude)
  badge      a simulator's pile count: a white bold 1-2 digit number with a dark outline at the card's
             centre (DuelingBook, _badge)
  fullfoil   the r3-foil full-card foil (_fullfoil), at mix['fullfoil']
render(..., info=dict) reports which of them a view got (info['new']: any), for the distillation loss.
mix['v2'] (MIX_V2, the continuation runs r5-v2a/b): the foil's metal often vivid and darker than the white ink, with
contrast kept (_fullfoil v2), overframes read mostly from the user's loose box, mix['pendfoil'] scaling the foil's
chance on pendulum cards; without it every v1 rendering is unchanged.
"""
from __future__ import annotations

import json
import math

import cv2
import numpy as np

from common import ART_BOX, ART_BOX_PENDULUM, CARD_BACK_FULL, TEMPLATES, load_cards

cv2.setNumThreads(1)

WC = 280
HC = round(WC * 86 / 59)  # 408
OUT = 224
CROP = 448  # the engine cuts ART_BOX at ~451 px from its 590x860 straightened card
PENDULUM_BOX_TOP = 0.635  # card-height fraction where the pendulum effect box covers the illustration


def _box(b, w=WC, h=HC):
    return (int(round(b["x"] * w)), int(round(b["y"] * h)), int(round((b["x"] + b["w"]) * w)), int(round((b["y"] + b["h"]) * h)))


AX0, AY0, AX1, AY1 = _box(ART_BOX)
PX0, PY0, PX1, PY1 = _box(ART_BOX_PENDULUM)

FRAME_GROUP = {"effect": "effect", "normal": "normal", "spell": "spell", "trap": "trap", "xyz": "xyz", "fusion": "fusion",
               "synchro": "synchro", "link": "link", "ritual": "ritual", "token": "normal"}
SLEEVE_DARK = [(15, 15, 18), (25, 22, 60), (55, 20, 70), (70, 15, 20), (15, 45, 25), (40, 40, 45), (10, 30, 70), (60, 35, 90)]
SLEEVE_LIGHT = [(235, 235, 235), (240, 170, 200), (170, 200, 240), (200, 180, 230), (240, 220, 160)]
SKIN = [(224, 172, 140), (198, 134, 106), (141, 85, 54), (250, 205, 175), (180, 120, 90)]
ZONE = [(120, 170, 255), (255, 90, 170), (230, 230, 240), (100, 220, 255)]


class Library:
    """Frame templates (per worker). kind(entry) says how an index entry is rendered."""

    def __init__(self, entries: list[dict]):
        cards = load_cards()
        man = json.load(open(TEMPLATES / "manifest.json"))
        self.tpl: dict[str, list[np.ndarray]] = {}
        for m in man:
            p = TEMPLATES / f"{m['imageId']}.jpg"
            im = cv2.imread(str(p), cv2.IMREAD_COLOR)
            if im is None:
                continue
            im = cv2.resize(cv2.cvtColor(im, cv2.COLOR_BGR2RGB), (WC, HC), interpolation=cv2.INTER_CUBIC)
            key = "pendulum" if m["frameType"].endswith("_pendulum") else FRAME_GROUP.get(m["frameType"], "effect")
            self.tpl.setdefault(key, []).append(im)
        self.any = [t for k, v in self.tpl.items() if k != "pendulum" for t in v]
        back = cv2.imread(str(CARD_BACK_FULL), cv2.IMREAD_COLOR)
        self.back = cv2.resize(cv2.cvtColor(back, cv2.COLOR_BGR2RGB), (WC, HC), interpolation=cv2.INTER_AREA)
        self.kinds = []
        for e in entries:
            ft = cards.get(e["cardId"], {}).get("frameType", "effect")
            size = e.get("size", [624, 624])
            if e["cardId"] == -1:
                self.kinds.append(("back", None))
            elif ft.endswith("_pendulum") and size[1] > size[0] * 1.1:
                self.kinds.append(("pendulum", "pendulum"))
            else:
                self.kinds.append(("normal", FRAME_GROUP.get(ft, "effect")))


# ---------------------------------------------------------------- helpers

def U(r, a, b):
    return float(r.uniform(a, b))


def _grid(h, w):
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    return xx / max(h, w), yy / max(h, w)


def _hue_shift(img: np.ndarray, deg: float) -> np.ndarray:
    hsv = cv2.cvtColor(img, cv2.COLOR_RGB2HSV)
    hsv[..., 0] = ((hsv[..., 0].astype(np.int32) + int(deg / 2)) % 180).astype(np.uint8)
    return cv2.cvtColor(hsv, cv2.COLOR_HSV2RGB)


def _foil(canvas: np.ndarray, r, region):
    """Holo/foil: a rainbow sweep (screen blend), sometimes fine prismatic lines and sparkles."""
    x0, y0, x1, y1 = region
    sub = canvas[y0:y1, x0:x1]
    h, w = sub.shape[:2]
    xx, yy = _grid(h, w)
    a = U(r, 0, math.pi)
    t = xx * math.cos(a) + yy * math.sin(a)
    phase = t * U(r, 0.6, 3.0) + U(r, 0, 1)
    rgb = 0.5 + 0.5 * np.cos(2 * math.pi * (phase[..., None] + np.float32([0, 1 / 3, 2 / 3])))
    alpha = U(r, 0.06, 0.25)
    if r.random() < 0.35:  # prismatic / secret-rare fine lines
        b = U(r, 0, math.pi)
        lines = 0.5 + 0.5 * np.sin((xx * math.cos(b) + yy * math.sin(b)) * U(r, 60, 140))
        alpha = alpha * (0.5 + lines[..., None])
    sub[:] = 255 - (255 - sub) * (1 - alpha * rgb)
    if r.random() < 0.3:  # sparkles
        n = int(h * w * U(r, 0.002, 0.01))
        ys, xs = r.integers(0, h, n), r.integers(0, w, n)
        sub[ys, xs] = np.minimum(255, sub[ys, xs] + U(r, 60, 160))


# The metal a full-card foil reflects under stream lighting, as a tint (normalised to mean 1 where used):
# grey, olive, steel blue, lavender, warm grey, neutral, green-grey.
FOIL_METAL = [(0.60, 0.60, 0.52), (0.57, 0.55, 0.42), (0.50, 0.56, 0.64), (0.58, 0.53, 0.63), (0.63, 0.57, 0.49),
              (0.58, 0.58, 0.58), (0.50, 0.58, 0.52)]
_GREY_AXIS = np.float32([1, 1, 1]) / math.sqrt(3)
_CROSS = np.float32([[0, -_GREY_AXIS[2], _GREY_AXIS[1]], [_GREY_AXIS[2], 0, -_GREY_AXIS[0]], [-_GREY_AXIS[1], _GREY_AXIS[0], 0]])


def _vivid_tint(r) -> np.ndarray:
    """A saturated foil reflection (v2): one hue at 25-70% saturation, mean 1 (the grating at one angle: the real
    overframe's blue-violet, Kuriboh - Multiply!'s pink-violet and mint green)."""
    hsv = np.uint8([[[int(r.integers(0, 180)), int(U(r, 0.25, 0.7) * 255), 255]]])
    rgb = cv2.cvtColor(hsv, cv2.COLOR_HSV2RGB)[0, 0].astype(np.float32) / 255
    return rgb / rgb.mean()


def _fullfoil(canvas: np.ndarray, r, region, art=None, v2: bool = False):
    """A full-card foil print (Starlight, Collector's, Quarter Century Secret Rare) under stream lighting.
    The inks sit thin over a mirror, so the camera sees the ink's transmittance, largely desaturated (and
    sometimes hue-shifted by the grating: a yellow artwork reads pink), times the metal's reflection: a
    grey, olive, steel or lavender tint, brighter or darker than the print, uneven across the card (it
    depends on the view), with a faint rainbow and a fine prismatic texture. Opaque white ink (a
    character's highlights) keeps its colour; the heavier frame ink keeps more of its hue than the art;
    contrast usually drops; sparkles; often a broad sheen where the foil catches the light. So a pastel
    artwork turns grey-olive (foil-report.md). `art`: the illustration's box inside `region`, when
    `region` is the whole card.
    v2 (the combined retrain's continuation, combined-retrain-report.md), after the real crops of the user's cards:
    the metal is often a VIVID hue (45%: the overframe Magician reads saturated blue-violet, Kuriboh's burst
    pink-violet or mint), more often darker than the white ink (a pastel ground reads dark slate or olive, as on
    Yummy★Snatchy and Marshmao☆Yummy, while the white-inked character stays white), the inks keep a little more
    colour, and contrast holds or rises (dark outlines stay dark) instead of dropping."""
    x0, y0, x1, y1 = region
    sub = canvas[y0:y1, x0:x1] / 255.0
    h, w = sub.shape[:2]
    xx, yy = _grid(h, w)
    luma = sub @ np.float32([0.299, 0.587, 0.114])
    sat = (sub.max(2) - sub.min(2)) / (sub.max(2) + 1e-3)
    chroma = sub - luma[..., None]
    if r.random() < 0.35:  # the grating turns the hues around the grey axis
        th = math.radians(U(r, 30, 150)) * (1 if r.random() < 0.5 else -1)
        rot = np.eye(3, dtype=np.float32) + math.sin(th) * _CROSS + (1 - math.cos(th)) * (_CROSS @ _CROSS)
        chroma = chroma @ rot.T
    ink = np.power(np.clip(luma[..., None] + U(r, 0.1, 0.8 if v2 else 0.7) * chroma, 0, 1), U(r, 0.7, 1.1))
    if v2 and r.random() < 0.45:
        tint = _vivid_tint(r)
    else:
        tint = np.float32(FOIL_METAL[r.integers(len(FOIL_METAL))])
        tint = tint / tint.mean() + r.uniform(-0.03, 0.03, 3).astype(np.float32)
    a = U(r, 0, 2 * math.pi)
    t = xx * math.cos(a) + yy * math.sin(a)
    bright = (U(r, 0.3, 0.7) if r.random() < 0.55 else U(r, 0.7, 1.15)) if v2 else U(r, 0.35, 1.15)
    metal = tint * bright * (1 + U(r, 0.05, 0.4) * np.cos(2 * math.pi * (t * U(r, 0.3, 1.2) + U(r, 0, 1))))[..., None]
    if r.random() < 0.6:  # the grating's rainbow, faint and broad
        b = U(r, 0, 2 * math.pi)
        hue = (xx * math.cos(b) + yy * math.sin(b)) * U(r, 0.3, 1.5) + U(r, 0, 1)
        rainbow = 0.5 + 0.5 * np.cos(2 * math.pi * (hue[..., None] + np.float32([0, 1 / 3, 2 / 3])))
        metal = metal * (1 + U(r, 0.03, 0.25) * (2 * rainbow - 1))
    if r.random() < 0.7:  # prismatic lines or grain
        if r.random() < 0.5:
            c = U(r, 0, math.pi)
            tex = np.sin((xx * math.cos(c) + yy * math.sin(c)) * U(r, 80, 220))
        else:
            tex = cv2.GaussianBlur(r.standard_normal((h, w)).astype(np.float32), (0, 0), U(r, 0.5, 1.5))
            tex /= tex.std() + 1e-6
        metal = metal * (1 + U(r, 0.03, 0.12) * tex[..., None])
    out = ink * metal
    white = np.clip((luma - 0.78) / 0.12, 0, 1) * np.clip((0.2 - sat) / 0.08, 0, 1) * U(r, 0.3, 1.0)
    out = white[..., None] * sub + (1 - white[..., None]) * out
    if art is not None:  # the frame keeps more of its colour than the illustration
        mask = np.full((h, w), U(r, 0.35, 1.0), np.float32)
        ax0, ay0, ax1, ay1 = art
        mask[ay0:ay1, ax0:ax1] = 1.0
        mask = cv2.GaussianBlur(mask, (0, 0), 2.0)[..., None]
        out = mask * out + (1 - mask) * sub
    m = out.mean((0, 1), keepdims=True)
    out = m + (U(r, 0.95, 1.3) if v2 else U(r, 0.85, 1.1)) * (out - m)
    if r.random() < 0.4:  # sparkles
        n = int(h * w * U(r, 0.002, 0.01))
        ys, xs = r.integers(0, h, n), r.integers(0, w, n)
        out[ys, xs] = np.minimum(1.0, out[ys, xs] + U(r, 0.2, 0.5))
    if r.random() < 0.35:  # a broad sheen where the foil catches the light
        s = U(r, 0, math.pi)
        d = (xx - xx.mean()) * math.cos(s) + (yy - yy.mean()) * math.sin(s) - U(r, -0.4, 0.4)
        al = (U(r, 0.08, 0.35) * np.exp(-0.5 * (d / U(r, 0.08, 0.4)) ** 2))[..., None]
        out = out * (1 - al) + al * np.float32([0.92, 0.92, 0.9]) * U(r, 0.8, 1.1)
    canvas[y0:y1, x0:x1] = np.clip(out, 0, 1) * 255


def _glare(obj: np.ndarray, r, strength: float):
    h, w = obj.shape[:2]
    xx, yy = _grid(h, w)
    cx, cy = w / max(h, w) / 2, h / max(h, w) / 2
    alpha = np.zeros((h, w), np.float32)
    if r.random() < 0.4 * strength:  # sleeve glare band
        t = U(r, 0, math.pi)
        d = (xx - cx) * math.cos(t) + (yy - cy) * math.sin(t) - U(r, -0.45, 0.45)
        alpha = np.maximum(alpha, U(r, 0.1, 0.7) * np.exp(-0.5 * (d / U(r, 0.02, 0.22)) ** 2))
    if r.random() < 0.25 * strength:  # specular highlight
        ex, ey = U(r, 0.1, 0.9) * w / max(h, w), U(r, 0.1, 0.9) * h / max(h, w)
        rx, ry = U(r, 0.03, 0.2), U(r, 0.03, 0.2)
        alpha = np.maximum(alpha, U(r, 0.4, 1.0) * np.exp(-0.5 * (((xx - ex) / rx) ** 2 + ((yy - ey) / ry) ** 2)))
    if r.random() < 0.45 * strength:  # sheen across the sleeve
        t = U(r, 0, 2 * math.pi)
        g = ((xx - cx) * math.cos(t) + (yy - cy) * math.sin(t)) / 0.7 + 0.5
        alpha = np.maximum(alpha, U(r, 0.05, 0.3) * np.clip(g, 0, 1))
    if alpha.any():
        tint = np.float32([255, U(r, 240, 255), U(r, 225, 255)])
        a = alpha[..., None]
        obj[:] = obj * (1 - a) + tint * a


def _hand(img: np.ndarray, r, quad: np.ndarray):
    """A hand reaching over part of the card from outside: palm ellipse and 2-4 fingers."""
    c = quad.mean(0)
    cw = np.linalg.norm(quad[1] - quad[0])
    k = r.integers(4)
    a, b = quad[k], quad[(k + 1) % 4]
    p = a + (b - a) * U(r, 0.2, 0.8)
    out = (p - c) / (np.linalg.norm(p - c) + 1e-6)
    R = cw * U(r, 0.3, 0.55)
    palm = p + out * R * U(r, 0.7, 1.1)
    col = np.float32(SKIN[r.integers(len(SKIN))]) * U(r, 0.8, 1.1)
    layer = np.zeros(img.shape[:2], np.uint8)
    ang = math.degrees(math.atan2(out[1], out[0]))
    cv2.ellipse(layer, (int(palm[0]), int(palm[1])), (int(R), int(R * 0.8)), ang, 0, 360, 255, -1, cv2.LINE_AA)
    for _ in range(r.integers(2, 5)):
        tip = p - out * cw * U(r, 0.0, 0.3) + np.array([-out[1], out[0]]) * cw * U(r, -0.3, 0.3)
        cv2.line(layer, (int(palm[0]), int(palm[1])), (int(tip[0]), int(tip[1])), 255, max(2, int(R * 0.35)), cv2.LINE_AA)
    m = cv2.GaussianBlur(layer, (0, 0), 1.0).astype(np.float32)[..., None] / 255
    shade = np.float32(U(r, 0.75, 1.0))
    img[:] = img * (1 - m) + col * shade * m


def _sleeve_design(canvas: np.ndarray, r, base: np.ndarray):
    """More sleeve designs (combined retrain; foil-report.md: a white-ring sleeve and a purple emblem sleeve read as
    artworks): rings, a ringed emblem, a starburst, or a logo band with glyph-like strokes."""
    u = r.random()
    col = lambda: np.float32(r.integers(0, 256, 3)).tolist()
    c = (int(WC * U(r, 0.35, 0.65)), int(HC * U(r, 0.35, 0.65)))
    if u < 0.35:  # rings (one bright ring, or concentric)
        n = 1 if r.random() < 0.5 else int(r.integers(2, 5))
        R0 = WC * U(r, 0.15, 0.42)
        cc = col() if r.random() < 0.6 else [U(r, 200, 255)] * 3
        for j in range(n):
            cv2.circle(canvas, c, max(3, int(R0 * (1 - 0.22 * j))), cc, max(2, int(WC * U(r, 0.015, 0.06))), cv2.LINE_AA)
        if r.random() < 0.5:
            cv2.circle(canvas, c, max(2, int(R0 * U(r, 0.2, 0.5))), col(), -1, cv2.LINE_AA)
    elif u < 0.6:  # a ringed emblem: disc, ring and a polygon inside
        R0 = WC * U(r, 0.2, 0.4)
        cv2.circle(canvas, c, int(R0), col(), -1, cv2.LINE_AA)
        cv2.circle(canvas, c, int(R0), col(), max(2, int(WC * 0.02)), cv2.LINE_AA)
        k = int(r.integers(3, 9))
        ang = U(r, 0, 2 * math.pi)
        pts = np.int32([[c[0] + R0 * 0.75 * math.cos(ang + 2 * math.pi * i / k) * (1 if i % 2 == 0 or r.random() < 0.5 else 0.45),
                         c[1] + R0 * 0.75 * math.sin(ang + 2 * math.pi * i / k) * (1 if i % 2 == 0 or r.random() < 0.5 else 0.45)] for i in range(k)])
        cv2.fillPoly(canvas, [pts], col(), cv2.LINE_AA)
    elif u < 0.8:  # a starburst
        cc = col()
        for i in range(int(r.integers(8, 24))):
            a = U(r, 0, 2 * math.pi)
            L = WC * U(r, 0.2, 0.6)
            cv2.line(canvas, c, (int(c[0] + L * math.cos(a)), int(c[1] + L * math.sin(a))), cc, max(1, int(WC * U(r, 0.005, 0.03))), cv2.LINE_AA)
    else:  # a logo band with glyph-like strokes
        y0 = int(HC * U(r, 0.1, 0.8))
        bh = int(HC * U(r, 0.06, 0.16))
        canvas[y0:y0 + bh] = np.float32(col())
        tc = col()
        x = int(WC * U(r, 0.05, 0.2))
        while x < WC * 0.9:
            w = int(WC * U(r, 0.02, 0.07))
            if r.random() < 0.5:
                cv2.rectangle(canvas, (x, y0 + bh // 5), (x + w, y0 + bh - bh // 5), tc, max(1, bh // 8))
            else:
                cv2.ellipse(canvas, (x + w // 2, y0 + bh // 2), (max(1, w // 2), max(1, bh // 3)), 0, 0, 360, tc, max(1, bh // 8), cv2.LINE_AA)
            x += w + int(WC * U(r, 0.01, 0.03))


def negative_canvas(r, extra: bool = False) -> np.ndarray:
    """Things that are not a face-up card: a sleeve back (plain, gradient, emblem, pattern), the edge
    of a deck pile, or an empty mat zone. Trained to stay far from every indexed artwork.
    extra (the combined retrain): a third of the sleeves get one of _sleeve_design's designs as well."""
    canvas = np.empty((HC, WC, 3), np.float32)
    kind = r.random()
    if kind < 0.75:  # sleeve back / deck pile
        base = np.float32(r.integers(0, 256, 3)) if r.random() < 0.5 else np.float32((SLEEVE_DARK + SLEEVE_LIGHT)[r.integers(13)])
        xx, yy = _grid(HC, WC)
        t = U(r, 0, 2 * math.pi)
        canvas[:] = base + (U(r, -40, 40) * ((xx - 0.3) * math.cos(t) + (yy - 0.5) * math.sin(t)))[..., None]
        if extra and r.random() < 0.35:
            _sleeve_design(canvas, r, base)
        u = r.random()
        if u < 0.3:  # emblem
            col = np.float32(r.integers(0, 256, 3)).tolist()
            c = (int(WC * U(r, 0.3, 0.7)), int(HC * U(r, 0.3, 0.7)))
            if r.random() < 0.5:
                cv2.ellipse(canvas, c, (int(WC * U(r, 0.1, 0.35)), int(WC * U(r, 0.1, 0.35))), U(r, 0, 180), 0, 360, col, -1, cv2.LINE_AA)
            else:
                pts = (np.float32(c) + r.uniform(-0.35, 0.35, (int(r.integers(3, 7)), 2)) * WC).astype(np.int32)
                cv2.fillPoly(canvas, [pts], col, cv2.LINE_AA)
        elif u < 0.5:  # stripes / checks
            f = U(r, 6, 30)
            a = U(r, 0, math.pi)
            pat = np.sin((xx * math.cos(a) + yy * math.sin(a)) * f) > 0
            if r.random() < 0.4:
                pat ^= np.sin((xx * math.sin(a) - yy * math.cos(a)) * f) > 0
            canvas[pat] = canvas[pat] * U(r, 0.5, 0.9)
        elif u < 0.65:  # soft texture
            tex = cv2.resize(r.uniform(-1, 1, (int(r.integers(3, 12)), int(r.integers(3, 12)), 3)).astype(np.float32), (WC, HC), interpolation=cv2.INTER_CUBIC)
            canvas += tex * U(r, 10, 60)
        if r.random() < 0.35:  # deck pile: stacked sleeve edges along one side
            side = int(r.integers(4))
            for j in range(int(r.integers(2, 6))):
                off = int((j + 1) * U(r, 2, 5))
                col = (base * U(r, 0.6, 1.1)).tolist()
                if side == 0:
                    cv2.line(canvas, (0, HC - 1 - off), (WC - 1, HC - 1 - off), col, 2)
                elif side == 1:
                    cv2.line(canvas, (WC - 1 - off, 0), (WC - 1 - off, HC - 1), col, 2)
                elif side == 2:
                    cv2.line(canvas, (0, off), (WC - 1, off), col, 2)
                else:
                    cv2.line(canvas, (off, 0), (off, HC - 1), col, 2)
    else:  # empty mat zone with its outline
        canvas[:] = np.float32([U(r, 15, 70)] * 3) + r.uniform(-12, 12, 3).astype(np.float32)
        zc = ZONE[r.integers(len(ZONE))]
        m = int(U(r, 0.0, 0.12) * WC)
        cv2.rectangle(canvas, (m, m), (WC - 1 - m, HC - 1 - m), zc, int(r.integers(2, 6)), cv2.LINE_AA)
    canvas += r.normal(0, U(r, 0, 6), canvas.shape).astype(np.float32)
    return np.clip(canvas, 0, 255)


# ---------------------------------------------------------------- the combined retrain's effects

# Frame regions of a standard (non-pendulum) template, as card fractions (x0, y0, x1, y1).
NAME_BAR = (0.06, 0.035, 0.83, 0.105)
STARS = (0.07, 0.108, 0.93, 0.172)
ICON = (0.83, 0.03, 0.95, 0.112)
TEXT_BOX = (0.055, 0.712, 0.945, 0.948)
# The per-view chances of the combined retrain's mix (train.py --mix): full-card foil, overframe, occluder, badge.
MIX = {"fullfoil": 0.10, "overframe": 0.10, "occl": 0.15, "badge": 0.08}
# v2 (the continuation from r4-combined, combined-retrain-report.md): foils and overframes more often, with the v2
# foil (_fullfoil v2: vivid and darker metal, contrast kept) and overframes read from the user's LOOSE box (the
# detector takes an overframe for a face-down card, so the engine reads the box as drawn).
MIX_V2 = {"fullfoil": 0.2, "overframe": 0.15, "occl": 0.08, "badge": 0.05, "v2": 1, "pendfoil": 0.5}


def _fb(b, w=WC, h=HC):
    return int(round(b[0] * w)), int(round(b[1] * h)), int(round(b[2] * w)), int(round(b[3] * h))


def _overframe(canvas: np.ndarray, tpl: np.ndarray, art: np.ndarray, r, v2: bool = False):
    """An overframe print (CORI-era Secret/Starlight overframes, diag-overframe-report.md): the illustration covers
    the whole card with no frame. The real print shows a larger, re-framed illustration; from the index artwork alone
    it is approximated by zooming it 1.05-1.95x (the real card: about 1.18x; 'cover', art to the card's height, 1.9x)
    about a point near the standard art box's centre, the card beyond the artwork continued from its reflected,
    blurred edges. Over it: the template's text box, see-through (35-75%); the name's strokes recoloured gold (or
    silver); sometimes the stars, the attribute icon, a thin edge and the hologram."""
    s = U(r, 1.05, 1.45) if r.random() < 0.6 else U(r, 1.45, 1.95)
    side = int(round((AX1 - AX0) * s))
    cx = WC * (0.5 + U(r, -0.06, 0.06))
    cy = HC * (0.4435 + U(r, -0.06, 0.06))
    ox, oy = int(round(cx - side / 2)), int(round(cy - side / 2))
    big = cv2.resize(art, (side, side), interpolation=cv2.INTER_CUBIC if side > art.shape[0] else cv2.INTER_AREA).astype(np.float32)
    pl, pt = max(0, ox), max(0, oy)
    pr, pb = max(0, WC - (ox + side)), max(0, HC - (oy + side))
    lim = side - 1
    padded = cv2.copyMakeBorder(big, min(pt, lim), min(pb, lim), min(pl, lim), min(pr, lim), cv2.BORDER_REFLECT_101)
    padded = cv2.copyMakeBorder(padded, pt - min(pt, lim), pb - min(pb, lim), pl - min(pl, lim), pr - min(pr, lim), cv2.BORDER_REPLICATE)
    # the card's window in the padded image (the artwork's top-left sits at (ox, oy) on the card)
    x0 = max(0, -ox)
    y0 = max(0, -oy)
    full = padded[y0:y0 + HC, x0:x0 + WC]
    if full.shape[:2] != (HC, WC):
        full = cv2.resize(full, (WC, HC), interpolation=cv2.INTER_LINEAR)
    inside = np.zeros((HC, WC), np.float32)
    cv2.rectangle(inside, (ox, oy), (ox + side - 1, oy + side - 1), 1.0, -1)
    if inside.min() < 1:  # the continued part: blurred, a little darker or duller
        soft = cv2.GaussianBlur(full, (0, 0), U(r, 2.0, 7.0)) * U(r, 0.75, 1.0)
        m = cv2.GaussianBlur(inside, (0, 0), 3.0)[..., None]
        full = m * full + (1 - m) * soft
    out = full
    tb = _fb(TEXT_BOX)
    a = U(r, 0.35, 0.75)
    out[tb[1]:tb[3], tb[0]:tb[2]] = (1 - a) * out[tb[1]:tb[3], tb[0]:tb[2]] + a * tpl[tb[1]:tb[3], tb[0]:tb[2]]
    nb = _fb(NAME_BAR)
    bar = tpl[nb[1]:nb[3], nb[0]:nb[2]].astype(np.float32)
    lum = bar @ np.float32([0.299, 0.587, 0.114])
    ink = np.abs(lum - np.median(lum)) > 55  # the name's strokes: far from the bar's own colour
    ink = cv2.GaussianBlur(ink.astype(np.float32), (0, 0), 0.6)[..., None]
    gold = np.float32([U(r, 200, 245), U(r, 160, 200), U(r, 60, 120)]) if r.random() < 0.8 else np.float32([U(r, 200, 240)] * 3)
    sub = out[nb[1]:nb[3], nb[0]:nb[2]]
    out[nb[1]:nb[3], nb[0]:nb[2]] = sub * (1 - 0.9 * ink) + gold * 0.9 * ink
    if r.random() < 0.5:  # the level stars (red-orange discs)
        sb = _fb(STARS)
        st = tpl[sb[1]:sb[3], sb[0]:sb[2]].astype(np.float32)
        star = ((st[..., 0] > 150) & (st[..., 1] < 150) & (st[..., 2] < 110)).astype(np.float32)
        star = cv2.GaussianBlur(star, (0, 0), 0.6)[..., None]
        out[sb[1]:sb[3], sb[0]:sb[2]] = out[sb[1]:sb[3], sb[0]:sb[2]] * (1 - star) + st * star
    if r.random() < 0.5:  # the attribute icon
        ib = _fb(ICON)
        disc = np.zeros((ib[3] - ib[1], ib[2] - ib[0]), np.float32)
        cv2.ellipse(disc, (disc.shape[1] // 2, disc.shape[0] // 2), (disc.shape[1] // 2 - 1, disc.shape[0] // 2 - 1), 0, 0, 360, 1.0, -1, cv2.LINE_AA)
        disc = disc[..., None]
        out[ib[1]:ib[3], ib[0]:ib[2]] = out[ib[1]:ib[3], ib[0]:ib[2]] * (1 - disc) + tpl[ib[1]:ib[3], ib[0]:ib[2]] * disc
    if r.random() < 0.4:  # a thin edge
        cv2.rectangle(out, (0, 0), (WC - 1, HC - 1), [U(r, 20, 230)] * 3, int(r.integers(1, 4)))
    if r.random() < 0.3:  # the hologram
        hx, hy = int(WC * 0.9), int(HC * 0.955)
        cv2.rectangle(out, (hx - 6, hy - 5), (hx + 6, hy + 5), [U(r, 170, 240)] * 3, -1)
    canvas[:] = np.clip(out, 0, 255)
    if r.random() < (0.7 if v2 else 0.6):
        _fullfoil(canvas, r, (0, 0, WC, HC), v2=v2)


_FONT_FILES = ["Arial Bold.ttf", "Arial Black.ttf", "Arial Rounded Bold.ttf", "Verdana Bold.ttf", "Tahoma Bold.ttf",
               "Trebuchet MS Bold.ttf", "Arial Narrow Bold.ttf"]
_FONTS: dict = {}


def _font(name: str, px: int):
    """A bold sans font at px, from the system's fonts (macOS); None when it isn't there (Hershey is used then)."""
    key = (name, px)
    if key not in _FONTS:
        from PIL import ImageFont

        f = None
        for d in ("/System/Library/Fonts/Supplemental/", "/Library/Fonts/"):
            try:
                f = ImageFont.truetype(d + name, px)
                break
            except OSError:
                continue
        _FONTS[key] = f
    return _FONTS[key]


def _badge(canvas: np.ndarray, r):
    """A simulator's pile count over the card (diag-t950-report.md, DuelingBook): a white bold number of 1-2 digits,
    13-26% of the card's height, centred on the card, usually with a thin dark outline or shadow; sometimes on a dark
    translucent disc."""
    from PIL import Image, ImageDraw

    text = str(int(r.integers(1, 10))) if r.random() < 0.6 else str(int(r.integers(10, 60)))
    hpx = U(r, 0.13, 0.26) * HC
    cx, cy = WC * (0.5 + U(r, -0.05, 0.05)), HC * (0.5 + U(r, -0.06, 0.06))
    fill = int(U(r, 225, 255))
    dark = int(U(r, 0, 70))
    layer = Image.new("LA", (WC, HC), (0, 0))
    d = ImageDraw.Draw(layer)
    font = _font(_FONT_FILES[r.integers(len(_FONT_FILES))], max(8, int(hpx / 0.72)))
    stroke = int(round(U(r, 0, 0.012) * HC)) if r.random() < 0.8 else 0
    if r.random() < 0.1:  # a dark disc behind it
        rad = int(hpx * U(r, 0.65, 0.95))
        cv2.circle(canvas, (int(cx), int(cy)), rad, [U(r, 0, 60)] * 3, -1, cv2.LINE_AA)
    if font is not None:
        bb = d.textbbox((0, 0), text, font=font, stroke_width=stroke)
        tx, ty = cx - (bb[0] + bb[2]) / 2, cy - (bb[1] + bb[3]) / 2
        if r.random() < 0.3:  # a drop shadow
            d.text((tx + hpx * 0.04, ty + hpx * 0.04), text, font=font, fill=(dark, 150))
        d.text((tx, ty), text, font=font, fill=(fill, 255), stroke_width=stroke, stroke_fill=(dark, 255))
        la = np.asarray(layer, np.float32)
        lum, alpha = la[..., 0:1], la[..., 1:2] / 255
    else:
        m = np.zeros((HC, WC), np.float32)
        l = np.zeros((HC, WC), np.float32)
        sc = hpx / 22
        (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_DUPLEX, sc, max(1, int(sc * 3)))
        org = (int(cx - tw / 2), int(cy + th / 2))
        cv2.putText(m, text, org, cv2.FONT_HERSHEY_DUPLEX, sc, 1.0, max(1, int(sc * 3)) + 2 * stroke, cv2.LINE_AA)
        cv2.putText(l, text, org, cv2.FONT_HERSHEY_DUPLEX, sc, 1.0, max(1, int(sc * 3)), cv2.LINE_AA)
        lum = (dark + (fill - dark) * l)[..., None]
        alpha = m[..., None]
    canvas[:] = canvas * (1 - alpha) + lum * alpha


def _card_like(r, other: np.ndarray | None, lib) -> np.ndarray:
    """Another card, a card back or a sleeve (an occluder), WC x HC float32."""
    u = r.random()
    if u < 0.55 and other is not None and lib is not None:
        pool = lib.any
        c = pool[r.integers(len(pool))].astype(np.float32).copy()
        c[AY0:AY1, AX0:AX1] = cv2.resize(other, (AX1 - AX0, AY1 - AY0), interpolation=cv2.INTER_AREA)
        return c
    if u < 0.7 and lib is not None:
        return lib.back.astype(np.float32).copy()
    c = np.empty((HC, WC, 3), np.float32)
    c[:] = np.float32((SLEEVE_DARK + SLEEVE_LIGHT)[r.integers(13)]) * U(r, 0.7, 1.15)
    return c


def _poly_cover(mask: np.ndarray, card: np.ndarray) -> float:
    cm = np.zeros(mask.shape, np.uint8)
    cv2.fillPoly(cm, [np.round(card).astype(np.int32)], 1)
    n = cm.sum()
    return float((mask[cm > 0] > 0.5).sum() / max(1, n))


def _occlude(scene: np.ndarray, r, card_q: np.ndarray, other: np.ndarray | None = None, lib=None):
    """Something over 15-50% of the card, in the (supersampled) scene: fingers or a hand reaching in from one side
    (shaded skin, sometimes nails, sometimes motion blur), another card, a card back or a sleeve lying over it, or
    dice and counters. The size is searched until the occluder covers the coverage drawn (on the card's outline)."""
    cover = U(r, 0.15, 0.5)
    c = card_q.mean(0)
    cw = float(np.linalg.norm(card_q[1] - card_q[0]))
    chh = float(np.linalg.norm(card_q[3] - card_q[0]))
    size = max(cw, chh)
    H, W = scene.shape[:2]
    kind = r.random()
    # a low-resolution grid for the coverage search
    f = min(1.0, 96 / size)
    small = (max(8, int(W * f)), max(8, int(H * f)))
    if kind < 0.5:  # fingers / a hand
        k = int(r.integers(4))
        a, b = card_q[k], card_q[(k + 1) % 4]
        p = a + (b - a) * U(r, 0.15, 0.85)
        out = (p - c) / (np.linalg.norm(p - c) + 1e-6)
        tilt = U(r, -0.6, 0.6)
        d = -np.array([out[0] * math.cos(tilt) - out[1] * math.sin(tilt), out[0] * math.sin(tilt) + out[1] * math.cos(tilt)])
        n = np.array([-d[1], d[0]])
        nf = int(r.choice([1, 2, 3, 4], p=[0.1, 0.3, 0.3, 0.3]))
        fw = cw * U(r, 0.2, 0.34)  # real fingers over a card on camera: a quarter to a third of its width
        palm = r.random() < 0.6
        offs = [(j - (nf - 1) / 2) * fw * U(r, 0.9, 1.05) for j in range(nf)]
        lens = [U(r, 0.7, 1.0) for _ in range(nf)]
        base = p - d * size * 0.6

        def draw(img, scale, reach):
            for o, L in zip(offs, lens):
                a0 = (base + n * o) * scale
                a1 = (p + n * o + d * reach * L) * scale
                cv2.line(img, (int(a0[0]), int(a0[1])), (int(a1[0]), int(a1[1])), 1.0, max(1, int(fw * scale)), cv2.LINE_AA)
            if palm:
                pc = (base - d * size * 0.1) * scale
                cv2.ellipse(img, (int(pc[0]), int(pc[1])), (max(1, int(size * 0.45 * scale)), max(1, int(fw * nf * 0.7 * scale))),
                            math.degrees(math.atan2(d[1], d[0])), 0, 360, 1.0, -1, cv2.LINE_AA)
    elif kind < 0.8:  # another card / card back / sleeve over it
        occ = _card_like(r, other, lib)
        k = U(r, 0.8, 1.2)
        ang = math.atan2(card_q[1][1] - card_q[0][1], card_q[1][0] - card_q[0][0]) + U(r, -0.8, 0.8)
        direction = U(r, 0, 2 * math.pi)
        dv = np.array([math.cos(direction), math.sin(direction)])
        ow, oh = cw * k, chh * k
        R = np.array([[math.cos(ang), -math.sin(ang)], [math.sin(ang), math.cos(ang)]])
        corners = np.array([[-ow / 2, -oh / 2], [ow / 2, -oh / 2], [ow / 2, oh / 2], [-ow / 2, oh / 2]]) @ R.T

        def draw(img, scale, reach):  # reach: 0 = on the centre, larger = pushed out
            q = (c + dv * size * (1.2 - reach) + corners) * scale
            cv2.fillPoly(img, [np.round(q).astype(np.int32)], 1.0, cv2.LINE_AA)
    else:  # dice / counters
        m = int(r.integers(1, 4))
        pos = [c + np.array([U(r, -0.5, 0.5) * cw, U(r, -0.5, 0.5) * chh]) for _ in range(m)]
        shapes = [r.random() < 0.5 for _ in range(m)]
        angs = [U(r, 0, 90) for _ in range(m)]

        def draw(img, scale, reach):
            for q, sq, an in zip(pos, shapes, angs):
                rad = max(1, size * reach * 0.35 * scale)
                if sq:
                    box = cv2.boxPoints(((float(q[0] * scale), float(q[1] * scale)), (rad * 2, rad * 2), an))
                    cv2.fillPoly(img, [np.round(box).astype(np.int32)], 1.0, cv2.LINE_AA)
                else:
                    cv2.circle(img, (int(q[0] * scale), int(q[1] * scale)), int(rad), 1.0, -1, cv2.LINE_AA)
    # coverage search on the small grid (fingertips reach at most 0.85 of the card's long side past its edge)
    lo, hi = 0.02, (0.85 if kind < 0.5 else 1.2)
    for _ in range(7):
        mid = (lo + hi) / 2
        m = np.zeros((small[1], small[0]), np.float32)
        draw(m, f, mid * size if kind < 0.5 else mid)
        if _poly_cover(m, card_q * f) < cover:
            lo = mid
        else:
            hi = mid
    reach = hi * size if kind < 0.5 else hi
    mask = np.zeros((H, W), np.float32)
    draw(mask, 1.0, reach)
    # appearance
    if kind < 0.5:
        tone = np.float32(SKIN[r.integers(len(SKIN))]) * U(r, 0.75, 1.12) + r.uniform(-12, 12, 3).astype(np.float32)
        inner = cv2.distanceTransform((mask > 0.5).astype(np.uint8), cv2.DIST_L2, 3)
        hgt = np.clip(inner / max(1.0, fw * 0.5), 0, 1)
        shade = (U(r, 0.55, 0.75) + U(r, 0.25, 0.45) * np.sqrt(hgt))[..., None]
        layer = tone * shade + U(r, -10, 10)
        if r.random() < 0.5:  # nails: lighter, pinker ellipses near the fingertips
            for o, L in zip(offs, lens):
                tip = p + n * o + d * reach * L
                nc = tip - d * fw * 0.35
                cv2.ellipse(layer, (int(nc[0]), int(nc[1])), (max(1, int(fw * 0.28)), max(1, int(fw * 0.22))),
                            math.degrees(math.atan2(d[1], d[0])), 0, 360, (tone * np.float32([1.12, 1.05, 1.05]) + 18).tolist(), -1, cv2.LINE_AA)
    elif kind < 0.8:
        oh_, ow_ = occ.shape[:2]
        q = (c + dv * size * (1.2 - reach) + corners).astype(np.float32)
        M = cv2.getPerspectiveTransform(np.float32([[0, 0], [ow_, 0], [ow_, oh_], [0, oh_]]), q)
        layer = cv2.warpPerspective(occ, M, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT)
    else:
        col = np.float32([[245, 245, 240], [200, 30, 40], [25, 25, 30], [40, 90, 200], [230, 200, 40], [30, 150, 70]][r.integers(6)])
        layer = np.empty((H, W, 3), np.float32)
        layer[:] = col * U(r, 0.8, 1.1)
    if r.random() < 0.3:  # motion blur on the occluder only
        L = int(r.integers(3, 10))
        kern = np.zeros((L * 2 + 1, L * 2 + 1), np.float32)
        t = U(r, 0, math.pi)
        cv2.line(kern, (int(L - L * math.cos(t)), int(L - L * math.sin(t))), (int(L + L * math.cos(t)), int(L + L * math.sin(t))), 1.0, 1)
        kern /= kern.sum()
        mask = cv2.filter2D(mask, -1, kern)
        layer = cv2.filter2D(layer, -1, kern)
    else:
        mask = cv2.GaussianBlur(mask, (0, 0), U(r, 0.6, 1.8))
    if kind >= 0.5 and r.random() < 0.5:  # a soft shadow beside a lying object
        sh = cv2.GaussianBlur(np.roll(mask, (int(size * 0.03), int(size * 0.03)), (0, 1)), (0, 0), size * 0.03)[..., None]
        scene[:] = scene * (1 - 0.35 * sh)
    a = np.clip(mask, 0, 1)[..., None]
    scene[:] = scene * (1 - a) + layer * a


# ---------------------------------------------------------------- level parameters

LEVELS = {
    #          art px      blur sigma   washout a     jpeg q     glare  hand   foil  misframe
    "mild": dict(art=(100, 230), blur=(0.0, 0.6), wash=(0.85, 1.0), jpeg=(60, 95), glare=0.25, hand=0.0, foil=0.1, mis=0.5, cast=0.06, cam=0.3),
    "video": dict(art=(40, 110), blur=(0.15, 1.0), wash=(0.4, 1.0), jpeg=(35, 85), glare=1.0, hand=0.1, foil=0.25, mis=1.0, cast=0.2, cam=1.0),
    "hard": dict(art=(30, 72), blur=(0.35, 1.4), wash=(0.3, 0.75), jpeg=(22, 60), glare=1.3, hand=0.15, foil=0.3, mis=1.3, cast=0.26, cam=1.0),
}


def _art_px(r, lo, hi):
    # log-uniform: small artworks are over-represented, as on stream overlays and mat zooms
    return math.exp(U(r, math.log(lo), math.log(hi)))


# ---------------------------------------------------------------- the chain

def render(art: np.ndarray, kind: tuple, lib: Library, r: np.random.Generator, level: str = "video",
           fullfoil: float = 0.0, mix: dict | None = None, info: dict | None = None,
           other: np.ndarray | None = None) -> np.ndarray:
    """fullfoil: the chance of a full-card foil print (_fullfoil) instead of the level's light foil. At 0
    (the default, r1 and r2) the random stream, and so every rendering, is exactly what it was.
    mix (the combined retrain, MIX): per-view chances of 'fullfoil' (replaces `fullfoil`), 'overframe', 'occl' and
    'badge', drawn first; None (the default) draws nothing, so the stream is unchanged. Forcing one: a chance of 1.
    info: filled with the effects this view got ({'new': any of them, 'fullfoil', 'overframe', 'occl', 'badge'}).
    other: another artwork, for an occluder that is another card."""
    P = LEVELS[level]
    what, group = kind
    v2 = bool(mix is not None and mix.get("v2"))
    eff = {"fullfoil": False, "overframe": False, "occl": False, "badge": False}
    if mix is not None and what not in ("neg", "back"):
        eff["overframe"] = what == "normal" and r.random() < mix.get("overframe", 0)
        # (pendfoil: the full-card foil's chance on pendulum cards, relative; their top-60% cut carries much of its
        # evidence in colour, and the foil run lost them: foil-report.md)
        eff["fullfoil"] = r.random() < mix.get("fullfoil", 0) * (mix.get("pendfoil", 1.0) if what == "pendulum" else 1.0)
        eff["occl"] = r.random() < mix.get("occl", 0)
        eff["badge"] = r.random() < mix.get("badge", 0)
        if eff["overframe"]:
            eff["fullfoil"] = False  # an overframe has its own foil (60%)
    if info is not None:
        info.update(eff)
        info["new"] = any(eff.values())
    # ---- card canvas
    if what == "back":
        canvas = lib.back.astype(np.float32)
    elif what == "neg":
        canvas = negative_canvas(r, extra=mix is not None)
    else:
        pool = lib.tpl.get(group) if group and r.random() < 0.8 else None
        if what == "pendulum":
            pool = lib.tpl.get("pendulum")
        pool = pool or lib.any
        tpl = pool[r.integers(len(pool))]
        if what != "pendulum" and r.random() < 0.15:
            tpl = _hue_shift(tpl, U(r, -60, 60))
        canvas = tpl.astype(np.float32)
        if what == "pendulum":
            ill = cv2.resize(art, (PX1 - PX0, PY1 - PY0), interpolation=cv2.INTER_LINEAR).astype(np.float32)
            cut = int(PENDULUM_BOX_TOP * HC) - PY0
            canvas[PY0:PY0 + cut, PX0:PX1] = ill[:cut]
        else:
            canvas[AY0:AY1, AX0:AX1] = cv2.resize(art, (AX1 - AX0, AY1 - AY0), interpolation=cv2.INTER_AREA)
        if eff["overframe"]:
            _overframe(canvas, tpl.astype(np.float32), art, r, v2=v2)
        elif eff["fullfoil"] if mix is not None else (fullfoil > 0 and r.random() < fullfoil):
            # Starlight / Quarter Century: the whole card; Collector's-like: the illustration only
            ill = (PX0, PY0, PX1, PY1) if what == "pendulum" else (AX0, AY0, AX1, AY1)
            if r.random() < 0.7:
                _fullfoil(canvas, r, (0, 0, WC, HC), art=ill, v2=v2)
            else:
                _fullfoil(canvas, r, ill, v2=v2)
        elif r.random() < P["foil"]:
            region = (AX0, AY0, AX1, AY1) if r.random() < 0.6 else (0, 0, WC, HC)
            _foil(canvas, r, region)
        if eff["badge"]:
            _badge(canvas, r)
    # ---- sleeve (website images rarely show one)
    sleeved = r.random() < (0.2 if level == "mild" else 0.85) and what != "neg"
    if sleeved:
        ml, mr = int(U(r, 0.015, 0.05) * WC), int(U(r, 0.015, 0.05) * WC)
        mt, mb = int(U(r, 0.03, 0.09) * WC), int(U(r, 0.01, 0.04) * WC)
        col = np.float32((SLEEVE_DARK if r.random() < 0.75 else SLEEVE_LIGHT)[r.integers(5)]) * U(r, 0.8, 1.15)
        obj = np.empty((HC + mt + mb, WC + ml + mr, 3), np.float32)
        obj[:] = col
        # thin shadow where the card edge meets the sleeve
        obj[mt - 1:mt + HC + 1, ml - 1:ml + WC + 1] *= 0.6
        obj[mt:mt + HC, ml:ml + WC] = canvas
        haze = U(r, 0.0, 0.12)
        obj[mt:mt + HC, ml:ml + WC] = obj[mt:mt + HC, ml:ml + WC] * (1 - haze) + 200 * haze
        card_rect = (ml, mt, ml + WC, mt + HC)
    else:
        obj = canvas
        cv2.rectangle(obj, (0, 0), (WC - 1, HC - 1), (30, 30, 30), 1)
        card_rect = (0, 0, WC, HC)
    _glare(obj, r, P["glare"])
    Ho, Wo = obj.shape[:2]

    # ---- scene geometry (capture pixels)
    A = _art_px(r, *P["art"])
    k = A / (AX1 - AX0)  # capture px per canvas px
    base = [0, 90, 180, 270][r.choice(4, p=[0.5, 0.2, 0.15, 0.15])]
    theta = math.radians(base + U(r, -10, 10))
    cwid = k * WC
    Pc = int(math.ceil(k * math.hypot(Wo, Ho) * 1.25)) + 8  # capture patch size
    SS = 2
    Ps = Pc * SS
    cs, sn = math.cos(theta), math.sin(theta)
    obj_c = np.float32([[0, 0], [Wo, 0], [Wo, Ho], [0, Ho]])
    rel = (obj_c - np.float32([Wo / 2, Ho / 2])) * np.float32(k * SS)
    rot = np.float32([[cs, -sn], [sn, cs]])
    dst = (rel @ rot.T + np.float32(Ps / 2)).astype(np.float32)
    if r.random() < 0.7 * P["cam"]:
        dst += r.uniform(-0.05, 0.05, (4, 2)).astype(np.float32) * cwid * SS
    # pre-shrink the canvas so the warp does not alias
    f = min(1.0, k * SS * 1.3)
    src_obj = cv2.resize(obj, (max(8, int(Wo * f)), max(8, int(Ho * f))), interpolation=cv2.INTER_AREA) if f < 1 else obj
    fx, fy = src_obj.shape[1] / Wo, src_obj.shape[0] / Ho
    M = cv2.getPerspectiveTransform((obj_c * np.float32([fx, fy])).astype(np.float32), dst)
    rgba = np.dstack([src_obj, np.full(src_obj.shape[:2], 255, np.float32)])
    warped = cv2.warpPerspective(rgba, M, (Ps, Ps), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    # background mat
    mat = np.float32([U(r, 15, 70)] * 3) + r.uniform(-12, 12, 3).astype(np.float32)
    low = cv2.resize(r.uniform(-1, 1, (6, 6, 3)).astype(np.float32), (Ps, Ps), interpolation=cv2.INTER_CUBIC)
    bg = np.clip(mat + low * U(r, 0, 12), 0, 255)
    if r.random() < 0.5:  # zone outline around the card
        zc = np.float32(ZONE[r.integers(len(ZONE))])
        zw, zh = cwid * SS * U(r, 1.05, 1.3), cwid * SS / (59 / 86) * U(r, 1.05, 1.3)
        if base in (90, 270):
            zw, zh = zh, zw
        o = r.uniform(-0.1, 0.1, 2) * cwid * SS
        cv2.rectangle(bg, (int(Ps / 2 - zw / 2 + o[0]), int(Ps / 2 - zh / 2 + o[1])),
                      (int(Ps / 2 + zw / 2 + o[0]), int(Ps / 2 + zh / 2 + o[1])), zc.tolist(), max(1, int(SS * U(r, 1, 2.5))), cv2.LINE_AA)
    a = warped[..., 3:4] / 255
    scene = warped[..., :3] * a + bg * (1 - a)
    card_c = np.float32([[card_rect[0], card_rect[1]], [card_rect[2], card_rect[1]], [card_rect[2], card_rect[3]], [card_rect[0], card_rect[3]]])
    card_q = cv2.perspectiveTransform((card_c * np.float32([fx, fy]))[None].astype(np.float32), M)[0]
    sleeve_q = dst.copy()
    if r.random() < P["hand"]:
        _hand(scene, r, card_q)
    if eff["occl"]:
        _occlude(scene, r, card_q, other, lib)
    cap = cv2.resize(scene, (Pc, Pc), interpolation=cv2.INTER_AREA)
    card_q /= SS
    sleeve_q /= SS

    # ---- camera, ISP, codec
    cam = P["cam"]
    h, w = cap.shape[:2]
    if r.random() < 0.5 * cam:  # uneven light
        xx, yy = _grid(h, w)
        t = U(r, 0, 2 * math.pi)
        cap *= (1 + U(r, -0.25, 0.25) * ((xx - 0.5) * math.cos(t) + (yy - 0.5) * math.sin(t)) * 2)[..., None]
    sig = U(r, *P["blur"])
    if sig > 0.15:
        cap = cv2.GaussianBlur(cap, (0, 0), sig)
    if r.random() < 0.15 * cam:  # motion blur
        L = int(r.integers(2, 5))
        kern = np.zeros((L * 2 + 1, L * 2 + 1), np.float32)
        t = U(r, 0, math.pi)
        cv2.line(kern, (int(L - L * math.cos(t)), int(L - L * math.sin(t))), (int(L + L * math.cos(t)), int(L + L * math.sin(t))), 1.0, 1)
        cap = cv2.filter2D(cap, -1, kern / kern.sum())
    # white balance cast
    ct = r.choice(5, p=[0.15, 0.3, 0.15, 0.3, 0.1])
    s = U(r, 0.02, P["cast"])
    gains = [np.float32([1, 1, 1]), np.float32([1 + s, 1 - 0.8 * s, 1 + 0.4 * s]), np.float32([1 + s, 1 + 0.5 * s, 1 - s]),
             np.float32([1 - 0.6 * s, 1, 1 + s]), np.float32([1 - 0.5 * s, 1 + s, 1 - 0.5 * s])][ct]
    cap *= gains
    luma = cap @ np.float32([0.299, 0.587, 0.114])
    sat = U(r, 0.45, 1.15) if level != "mild" else U(r, 0.85, 1.1)
    cap = luma[..., None] + sat * (cap - luma[..., None])
    wa = U(r, *P["wash"])
    lift = (1 - wa) * 255 * U(r, 0.3, 1.0)
    cap = cap * wa + lift
    gamma = U(r, 0.75, 1.35) if level != "mild" else U(r, 0.9, 1.1)
    cap = 255 * np.power(np.clip(cap, 0, 255) / 255, gamma)
    if r.random() < 0.5 * cam:  # sharpening halos
        cap = cap + U(r, 0.3, 1.2) * (cap - cv2.GaussianBlur(cap, (0, 0), U(r, 0.8, 1.6)))
    if r.random() < 0.5 * cam:
        cap = cap + r.normal(0, U(r, 1, 5), cap.shape).astype(np.float32)
    if r.random() < 0.25 * cam:  # resolution loss (720p stream upscaled)
        f2 = U(r, 0.65, 0.92)
        cap = cv2.resize(cv2.resize(cap, (max(4, int(w * f2)), max(4, int(h * f2))), interpolation=cv2.INTER_AREA), (w, h), interpolation=cv2.INTER_LINEAR)
    cap8 = np.clip(cap, 0, 255).astype(np.uint8)
    for _ in range(2 if r.random() < 0.3 else 1):
        q = int(U(r, *P["jpeg"]))
        ok, buf = cv2.imencode(".jpg", cv2.cvtColor(cap8, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, q,
                               cv2.IMWRITE_JPEG_SAMPLING_FACTOR, cv2.IMWRITE_JPEG_SAMPLING_FACTOR_420])
        cap8 = cv2.cvtColor(cv2.imdecode(buf, cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)
    if r.random() < 0.35 * cam:  # video codec chroma smear
        ycc = cv2.cvtColor(cap8, cv2.COLOR_RGB2YCrCb)
        ycc[..., 1:] = cv2.GaussianBlur(ycc[..., 1:], (0, 0), U(r, 0.6, 1.5))
        cap8 = cv2.cvtColor(ycc, cv2.COLOR_YCrCb2RGB)
    if r.random() < 0.2 * cam:  # deblocking
        cap8 = cv2.GaussianBlur(cap8, (0, 0), 0.5)

    if info is not None and info.get("debug"):  # sheet.py: the captured scene and the card's corners in it
        info["cap"] = cap8.copy()
        info["card_q"] = card_q.copy()
    # ---- detector quad and the engine's crop
    mis = P["mis"]
    # v2 overframes: the detector takes them for face-down cards, so the engine reads the user's box as drawn, and
    # users draw it loosely (the real user's box was 1.38x the card): mostly the box, 1.0-1.45x the sleeve's bounds
    loose = U(r, 1.0, 1.45) if v2 and eff["overframe"] else 1.0
    if r.random() < (0.6 if v2 and eff["overframe"] else 0.15 * mis):  # plain axis-aligned box (the 'whole' hypothesis)
        x0, y0 = sleeve_q.min(0)
        x1, y1 = sleeve_q.max(0)
        if loose != 1.0:
            cx, cy = (x0 + x1) / 2 + U(r, -0.04, 0.04) * (x1 - x0), (y0 + y1) / 2 + U(r, -0.04, 0.04) * (y1 - y0)
            hw, hh = (x1 - x0) / 2 * loose * U(r, 0.97, 1.03), (y1 - y0) / 2 * loose * U(r, 0.97, 1.03)
            x0, x1 = max(0.0, cx - hw), min(float(Pc - 1), cx + hw)
            y0, y1 = max(0.0, cy - hh), min(float(Pc - 1), cy + hh)
        box = np.float32([[x0, y0], [x1, y0], [x1, y1], [x0, y1]])
        best = min(range(4), key=lambda s: np.abs(np.roll(box, -s, 0) - card_q).sum())
        q = np.roll(box, -best, 0)
    else:
        q = (sleeve_q if (sleeved and r.random() < 0.75) else card_q).astype(np.float64)
        c = q.mean(0)
        eu = (q[1] - q[0] + q[2] - q[3]) / 2
        ev = (q[3] - q[0] + q[2] - q[1]) / 2
        B = np.stack([eu / np.linalg.norm(eu), ev / np.linalg.norm(ev)])  # rows: card axes
        loc = (q - c) @ B.T
        sc = U(r, 1 - 0.07 * mis, 1 + 0.07 * mis)
        loc *= [sc * U(r, 0.97, 1.03), sc * U(r, 0.97, 1.03)]
        e = math.radians(U(r, -3, 3) * mis)
        loc = loc @ np.array([[math.cos(e), -math.sin(e)], [math.sin(e), math.cos(e)]]).T
        # the real set's detector quads sit high on the card (sleeve opening, shadow): bias the shift upwards
        loc += np.array([U(r, -0.05, 0.05) * np.linalg.norm(eu), U(r, -0.08, 0.04) * np.linalg.norm(ev)]) * mis
        loc += r.uniform(-0.015, 0.015, (4, 2)) * np.linalg.norm(eu) * mis
        q = (c + loc @ B).astype(np.float32)
    unit = np.float32([[0, 0], [1, 0], [1, 1], [0, 1]])
    Hq = cv2.getPerspectiveTransform(unit, np.float32(q))
    A_out = np.float64([[ART_BOX["w"] / CROP, 0, ART_BOX["x"]], [0, ART_BOX["h"] / CROP, ART_BOX["y"]], [0, 0, 1]])
    Mc = Hq @ A_out
    crop = cv2.warpPerspective(cap8, Mc, (CROP, CROP), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                               borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    return cv2.resize(crop, (OUT, OUT), interpolation=cv2.INTER_AREA)


def mixed_level(r) -> str:
    u = r.random()
    return "mild" if u < 0.18 else "video" if u < 0.75 else "hard"
