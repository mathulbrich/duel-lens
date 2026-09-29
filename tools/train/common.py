"""Shared paths, constants and data loading for the Duel Lens embedder fine-tuning (tools/train/).

Everything here mirrors the TypeScript side so that training, evaluation and the shipped index
agree: ART_BOX from src/shared/card-layout.ts, the engine's 590x860 straightened card
(src/offscreen/detect.ts) and the index entry order of tools/build-index.ts.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "train"
CACHE_DIR = DATA / "cache"
ART_CACHE = CACHE_DIR / "art224.npy"
ENTRIES = CACHE_DIR / "entries.json"
TEMPLATES = DATA / "templates"
REAL_DIR = DATA / "real"
VAL_DIR = DATA / "val"
CKPT_DIR = DATA / "ckpt"
SHEETS = DATA / "sheets"
LOGS = DATA / "logs"
ONNX_DIR = DATA / "onnx"
SPLIT = DATA / "split.json"
os.environ.setdefault("HF_HOME", str(DATA / "hf"))

ARTWORKS = ROOT / "data" / "artworks"
CARD_BACK = ROOT / "data" / "card-back.jpg"
CARD_BACK_FULL = ROOT / "data" / "raw" / "card-back-full.png"
CARDS_JSON = ROOT / "extension" / "data" / "cards.json"
BENCH_REPORT = ROOT / "data" / "bench" / "report-2026-09-28.json"
CARDS_SMALL = ROOT / "data" / "bench" / "cards-small"
FRAMES_DIR = ROOT / "data" / "debug" / "frames"
# Local data (gitignored) from the real set's teacher labeller, an earlier prototype since removed
# (tools/realset/README.md): its detections.json holds the boxes of prepare.py real's 'lowres' set.
TEACHER_OUT = ROOT / "data" / "debug" / "exp-draw2" / "out"

CARD_BACK_ID = -1
S = 224  # model input size
MEAN = (0.485, 0.456, 0.406)
STD = (0.229, 0.224, 0.225)

# src/shared/card-layout.ts
ART_BOX = dict(x=0.118, y=0.181, w=0.765, h=0.525)
ART_BOX_PENDULUM = dict(x=0.062, y=0.179, w=0.876, h=0.766)
CARD_ASPECT = 59 / 86
# src/shared/card-layout.ts: the straightened card
CARD_W, CARD_H = 590, 860

# The 12 real cards of the YCS Paris 2026 frames, identified by a person, by passcode.
GT_CARDS = {
    81196066: "Lunalight Perfume Dancer",
    14152693: "Lunalight Emerald Bird",
    35618217: "Lunalight Kaleido Chick",
    58570206: "Heavy Polymerization",
    96345184: "Infinity of the Sacred Beasts - Raviel, Lord of Phantasms",
    33166263: "Hyperinvoked Aeon",
    23856331: "Inferno of the Sacred Beasts - Uria, Lord of Searing Flames",
    65861210: "Fallen Paradise of the Sacred Beasts",
    63926180: "Sacred Spirit Sword Aiwass",
    74063034: "Invocation",
    13935001: "Lunalight Serenade Dance",
}


def load_cards() -> dict[int, dict]:
    return {c["id"]: c for c in json.load(open(CARDS_JSON))["cards"]}


def index_entries() -> list[dict]:
    """Index entries (imageId, cardId) in tools/build-index.ts order, card back last."""
    if ENTRIES.exists():
        return json.load(open(ENTRIES))
    meta = json.load(open(ROOT / "extension" / "data" / "index-dinov2-small.meta.json"))
    return meta["entries"]


def load_art_cache(mmap: bool = True) -> np.ndarray:
    return np.load(ART_CACHE, mmap_mode="r" if mmap else None)


def load_split() -> dict:
    return json.load(open(SPLIT))


def art_box_px(width: int, height: int, box=ART_BOX):
    """The engine's toPixels(): whole pixels of a card-relative box in a width x height card."""
    x, y, w, h = box["x"] * width, box["y"] * height, box["w"] * width, box["h"] * height
    x0 = min(width - 1, max(0, round(x)))
    x1 = min(width, max(x0 + 1, round(x + w)))
    y0 = min(height - 1, max(0, round(y)))
    y1 = min(height, max(y0 + 1, round(y + h)))
    return x0, y0, x1, y1


def pil_resize_224(img: np.ndarray) -> np.ndarray:
    """The extension's preprocess resize (antialiased bilinear = Pillow BILINEAR) to 224x224."""
    from PIL import Image

    return np.asarray(Image.fromarray(img).resize((S, S), Image.BILINEAR), dtype=np.uint8)
