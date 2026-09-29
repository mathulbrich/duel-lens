"""Shared paths and constants for the card detector (tools/train-detector/)."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "train-detector"
HF_DIR = DATA / "hf"
CKPT_DIR = DATA / "ckpt"
LOGS = DATA / "logs"
SHEETS = DATA / "sheets"
ONNX_DIR = DATA / "onnx"
EVAL_DIR = DATA / "eval"
BENCH_DIR = DATA / "bench"
os.environ.setdefault("HF_HOME", str(HF_DIR))

# card sources
CARDS_SMALL = ROOT / "data" / "bench" / "cards-small"  # 1,905 full-card images (YGOPRODeck cards_small, 268x391)
ARTWORKS = ROOT / "data" / "artworks"  # 14,643 artworks (624x624)
TEMPLATES = ROOT / "data" / "train" / "templates"  # Phase 2's frame templates (+ manifest.json)
CARD_BACK_FULL = ROOT / "data" / "raw" / "card-back-full.png"  # the official card back, 927x1353
CARDS_JSON = ROOT / "extension" / "data" / "cards.json"

# real evaluation data (never trained on)
FULLVIEW = ROOT / "data" / "debug" / "fullview"
FRAMES = ROOT / "data" / "debug" / "frames"
REALSET = ROOT / "data" / "realset"

CARD_ASPECT = 59 / 86  # width / height
# The extension's working size: a screenshot is resized so its long side is at most this (then padded to /32).
WORK_LONG = 1280
