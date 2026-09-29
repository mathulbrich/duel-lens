"""Export a checkpoint to ONNX with the model-spec interface (pixel_values [n,3,224,224] ImageNet-
normalised -> embedding [n,384], pooling 'none'), quantise it and check it.

  python tools/train/export.py export --ckpt data/train/ckpt/r1/best.pt --name dinov2-small-duel
      -> data/train/onnx/<name>.fp32.onnx; weight-only MatMulNBits <name>.q4.onnx (4-bit, block 32),
         .q4b16.onnx (4-bit, block 16), .q8.onnx (8-bit, block 32); dynamic int8 <name>.int8.onnx
         (per tensor) and .int8pc.onnx (per channel)
  python tools/train/export.py check --ckpt ... --name ...
      -> parity with PyTorch (cosine per image) and batch dependence of every file, plus the full
         evaluation suite through onnxruntime; data/train/logs/export-<name>.json
"""
from __future__ import annotations

import argparse
import json
import os
import time

import numpy as np
import torch
import torch.nn as nn

from common import LOGS, ONNX_DIR, load_art_cache
from model import Embedder, to_input


def load(ckpt: str, std: bool = True) -> Embedder:
    m = Embedder(standardize=std)
    m.load_state_dict(torch.load(ckpt, map_location="cpu"))
    m.vit.config._attn_implementation = "eager"  # plain MatMul/Softmax attention in the graph
    return m.eval()


class Wrap(nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, pixel_values):
        return self.m(pixel_values)


def export(ckpt: str, name: str, std: bool):
    import onnx
    from onnxruntime.quantization import QuantType, quantize_dynamic
    from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer

    ONNX_DIR.mkdir(parents=True, exist_ok=True)
    m = load(ckpt, std)
    fp32 = ONNX_DIR / f"{name}.fp32.onnx"
    x = torch.randn(2, 3, 224, 224)
    with torch.no_grad():
        torch.onnx.export(Wrap(m), (x,), str(fp32), input_names=["pixel_values"], output_names=["embedding"],
                          dynamic_axes={"pixel_values": {0: "batch"}, "embedding": {0: "batch"}}, opset_version=17,
                          do_constant_folding=True, dynamo=False)
    onnx.checker.check_model(str(fp32))
    # weight-only MatMulNBits (float activations, so a batch never changes a vector): 4 and 8 bits
    for bits, block, suffix in ((4, 32, "q4"), (4, 16, "q4b16"), (8, 32, "q8")):
        q = MatMulNBitsQuantizer(onnx.load(str(fp32)), bits=bits, block_size=block, is_symmetric=True)
        q.process()
        q.model.save_model_to_file(str(ONNX_DIR / f"{name}.{suffix}.onnx"), use_external_data_format=False)
    # dynamic int8 (activation scales per batch: needs maxBatch 1)
    quantize_dynamic(str(fp32), str(ONNX_DIR / f"{name}.int8.onnx"), weight_type=QuantType.QInt8, per_channel=False,
                     op_types_to_quantize=["MatMul"])
    quantize_dynamic(str(fp32), str(ONNX_DIR / f"{name}.int8pc.onnx"), weight_type=QuantType.QInt8, per_channel=True,
                     op_types_to_quantize=["MatMul"])
    for f in sorted(ONNX_DIR.glob(f"{name}.*.onnx")):
        print(f"{f.name}: {f.stat().st_size / 1e6:.1f} MB")


def ort_embedder(path, threads=8, batch=16):
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.intra_op_num_threads = threads
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    sess = ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])

    def embed(u8):
        out = []
        for s in range(0, len(u8), batch):
            x = to_input(np.asarray(u8[s:s + batch]), "cpu").numpy()
            out.append(sess.run(["embedding"], {"pixel_values": x})[0])
        z = torch.from_numpy(np.concatenate(out)).float()
        return torch.nn.functional.normalize(z, dim=1)

    return embed


def check(ckpt: str, name: str, std: bool, full: bool, threads: int, only: set[str] | None = None):
    from evalsuite import Suite, summary

    suite = Suite()
    r = np.random.default_rng(0)
    art_probe = np.asarray(load_art_cache()[np.sort(r.choice(14000, 64, replace=False))])
    probe = np.concatenate([suite.real[:64], suite.groups["unseen-new"]["video"][:64], art_probe])
    m = load(ckpt, std)
    with torch.no_grad():
        ref = torch.nn.functional.normalize(m(to_input(probe, "cpu")), dim=1)
    report = {}
    for f in sorted(ONNX_DIR.glob(f"{name}.*.onnx")):
        kind = f.name[len(name) + 1:-5]
        if only and kind not in only:
            continue
        e1 = ort_embedder(f, threads, batch=1)
        e16 = ort_embedder(f, threads, batch=16)
        z1, z16 = e1(probe), e16(probe)
        cos = (z1 * ref).sum(1)
        cos_b = (z1 * z16).sum(1)
        t0 = time.time()
        e1(probe[:32])
        ms = (time.time() - t0) / 32 * 1000
        rec = {"file": f.name, "MB": round(f.stat().st_size / 1e6, 2), "cosVsTorchMin": float(cos.min()), "cosVsTorchMean": float(cos.mean()),
               "batch16VsBatch1Min": float(cos_b.min()), "msPerImage": round(ms, 1)}
        print(json.dumps(rec), flush=True)
        if full and kind != "fp32":
            t0 = time.time()
            res = suite.run(e1 if kind.startswith("int8") else e16)
            rec["suite"] = {k: v for k, v in res.items() if k != "perSighting"}
            rec["perSighting"] = res["perSighting"]
            print(f"  {kind}: {summary(res)} ({(time.time() - t0) / 60:.1f} min)", flush=True)
        report[kind] = rec
    json.dump(report, open(LOGS / f"export-{name}.json", "w"), indent=1)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["export", "check"])
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--name", default="dinov2-small-duel")
    ap.add_argument("--std", type=int, default=1)
    ap.add_argument("--full", type=int, default=1)
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--only", default="", help="comma-separated variants to check (default: all)")
    a = ap.parse_args()
    os.nice(5)
    if a.cmd == "export":
        export(a.ckpt, a.name, bool(a.std))
    else:
        check(a.ckpt, a.name, bool(a.std), bool(a.full), a.threads, set(a.only.split(",")) - {""} or None)
