"""Export a detector checkpoint to ONNX for the extension, and check it.

  python export.py --ckpt ../../data/train-detector/ckpt/d2/best.pt [--name card-detector] [--out-dir DIR]
      -> data/train-detector/onnx/ (or DIR) <name>.fp32.onnx and <name>.fp16w.onnx (fp16 weights, fp32 compute:
         every weight is stored as float16 and Cast back to float32; onnxruntime folds the casts at load)
         and a parity report (PyTorch vs onnxruntime on the real full-view frames: heatmap max |diff|,
         decoded boxes matched at polygon IoU)
  cp ../../data/train-detector/onnx/card-detector.fp16w.onnx ../../extension/models/detector/card-detector.onnx

Graph: image [1,3,H,W] RGB in [0,1] (H, W multiples of 32) -> heat [1,2,H/4,W/4] (sigmoid),
box [1,14,H/4,W/4], peak [1,2,H/4,W/4] (3x3 max-pool of heat). Opset 17, dynamic H and W. A checkpoint trained
with --corner-act leaky exports LeakyRelu nodes in the corner branch; the outputs don't change.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np
import onnx
import torch
from onnx import TensorProto, helper, numpy_helper

from common import FULLVIEW, LOGS, ONNX_DIR
from model import Detector, Exported
from quick_eval import prepare
from targets import decode, poly_iou


def load(ckpt: str) -> Detector:
    sd = torch.load(ckpt, map_location="cpu")
    a = sd.get("args", {})
    m = Detector(a.get("backbone", "mnv3l"), pretrained=False, corner_act=a.get("corner_act", "relu"))
    m.load_state_dict(sd["model"])
    return m.eval()


def export_fp32(m: Detector, path):
    x = torch.rand(1, 3, 736, 1280)
    with torch.no_grad():
        # an eval-mode wrapper: the exporter restores the wrapper's training flag on the whole model afterwards
        torch.onnx.export(Exported(m).eval(), (x,), str(path), input_names=["image"], output_names=["heat", "box", "peak"],
                          dynamic_axes={"image": {2: "h", 3: "w"}, "heat": {2: "gh", 3: "gw"}, "box": {2: "gh", 3: "gw"}, "peak": {2: "gh", 3: "gw"}},
                          opset_version=17, do_constant_folding=True, dynamo=False)
    model = onnx.load(str(path))
    model.doc_string = "Duel Lens card detector (tools/train-detector). Backbone: timm mobilenetv3_large_100.ra_in1k (Apache-2.0)."
    onnx.checker.check_model(model)
    onnx.save(model, str(path))


def to_fp16_weights(src, dst, min_size: int = 64):
    """Store float32 initializers with >= min_size elements as float16, each followed by a Cast to float32."""
    model = onnx.load(str(src))
    g = model.graph
    casts = []
    for init in g.initializer:
        if init.data_type != TensorProto.FLOAT:
            continue
        arr = numpy_helper.to_array(init)
        if arr.size < min_size:
            continue
        name = init.name
        half = numpy_helper.from_array(arr.astype(np.float16), name + "_fp16")
        init.CopyFrom(half)
        casts.append(helper.make_node("Cast", [name + "_fp16"], [name], to=TensorProto.FLOAT, name=name + "_cast"))
    # casts first so every consumer sees its float32 weight
    nodes = list(g.node)
    del g.node[:]
    g.node.extend(casts + nodes)
    onnx.checker.check_model(model)
    onnx.save(model, str(dst))


def ort_session(path, threads=8):
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.intra_op_num_threads = threads
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])


def parity(m: Detector, files: list, thr=0.3):
    frames = sorted(FULLVIEW.glob("fv-*.png"))
    sessions = {f.name: ort_session(f) for f in files}
    rep = {k: dict(max_heat_diff=0.0, max_box_diff_at_peaks=0.0, boxes_torch=0, boxes_matched=0, min_iou=1.0) for k in sessions}
    for fr in frames:
        img = cv2.cvtColor(cv2.imread(str(fr)), cv2.COLOR_BGR2RGB)
        x, s = prepare(img)
        with torch.no_grad():
            heat_t, box_t, peak_t = [t.numpy() for t in Exported(m).eval()(x)]
        dt = decode(heat_t[0], box_t[0], peak_t[0], thr=thr)
        for k, sess in sessions.items():
            heat_o, box_o, peak_o = sess.run(None, {"image": np.ascontiguousarray(x.numpy())})
            r = rep[k]
            r["max_heat_diff"] = max(r["max_heat_diff"], float(np.abs(heat_o - heat_t).max()))
            mask = (heat_t[0] > thr).any(0)
            if mask.any():
                r["max_box_diff_at_peaks"] = max(r["max_box_diff_at_peaks"], float(np.abs(box_o[0][:, mask] - box_t[0][:, mask]).max()))
            do = decode(heat_o[0], box_o[0], peak_o[0], thr=thr)
            r["boxes_torch"] += len(dt)
            for d in dt:
                best = max([poly_iou(d["quad"], e["quad"]) for e in do if e["cls"] == d["cls"]] + [0.0])
                r["boxes_matched"] += int(best >= 0.9)
                r["min_iou"] = min(r["min_iou"], best)
    return rep


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--name", default="card-detector")
    ap.add_argument("--no-parity", action="store_true", help="skip the PyTorch-vs-onnxruntime check (intermediate checkpoints)")
    ap.add_argument("--out-dir", default=str(ONNX_DIR), help="where the two .onnx files go (a candidate: data/train-detector/candidates)")
    args = ap.parse_args()
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    m = load(args.ckpt)
    fp32 = out / f"{args.name}.fp32.onnx"
    fp16w = out / f"{args.name}.fp16w.onnx"
    export_fp32(m, fp32)
    m.eval()
    to_fp16_weights(fp32, fp16w)
    for f in (fp32, fp16w):
        print(f"{f.name}: {f.stat().st_size / 1e6:.2f} MB")
    if args.no_parity:
        return
    rep = parity(m, [fp32, fp16w])
    print(json.dumps(rep, indent=1))
    LOGS.mkdir(parents=True, exist_ok=True)
    with open(LOGS / f"export-{args.name}.json", "w") as fh:
        json.dump({"ckpt": args.ckpt, "sizes_MB": {f.name: round(f.stat().st_size / 1e6, 2) for f in (fp32, fp16w)}, "parity": rep}, fh, indent=1)
    # With onnxruntime sessions and torch loaded, the interpreter's exit can abort in a static destructor on macOS
    # ("libc++abi: ... recursive_mutex lock failed"), after the work is done; the non-zero status then stops
    # final-eval.sh (set -e). Everything is written and closed: leave without the teardown.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
