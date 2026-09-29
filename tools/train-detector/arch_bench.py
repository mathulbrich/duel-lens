"""Export candidate detector architectures (random neck/heads; the backbone's weights don't change the
speed) to ONNX with dynamic H, W, for timing in onnxruntime-web (tools/train-detector/bench-wasm.mjs).

  python arch_bench.py mnv3l mnv3s mnv4s lcnet   -> data/train-detector/bench/<name>.onnx
"""
from __future__ import annotations

import sys

import torch

from common import BENCH_DIR
from model import Detector, Exported, count_params


def export(name: str, neck: int, head: int, tag: str):
    det = Detector(name, pretrained=False, neck=neck, head=head).eval()
    x = torch.rand(1, 3, 736, 1280)
    out = BENCH_DIR / f"{tag}.onnx"
    with torch.no_grad():
        torch.onnx.export(Exported(det), (x,), str(out), input_names=["image"], output_names=["heat", "box", "peak"],
                          dynamic_axes={"image": {2: "h", 3: "w"}, "heat": {2: "gh", 3: "gw"}, "box": {2: "gh", 3: "gw"}, "peak": {2: "gh", 3: "gw"}},
                          opset_version=17, do_constant_folding=True, dynamo=False)
    print(f"{tag}: {count_params(det):.2f} M params, {out.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    BENCH_DIR.mkdir(parents=True, exist_ok=True)
    for name in sys.argv[1:]:
        export(name, 64, 48, name)
