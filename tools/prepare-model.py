"""Prepares a downloaded ONNX model so the extension can load it as one file.

Called by tools/fetch-models.ts; needs the `onnx` package (a throwaway venv is enough:
python3 -m venv data/venv && data/venv/bin/pip install onnx).

  cut-classifier IN OUT  Drop the final classifier (Gemm/MatMul) of an image classifier and
                         expose its input, the pooled pre-logits features, as output "features".
  merge-external IN OUT  Inline weights stored in an external .onnx_data file (< 2 GB).
  fp16-weights IN OUT    Store float32 weights as float16, each followed by a Cast back to
                         float32: half the file size, float32 compute (ONNX Runtime folds the
                         casts when the session loads), so it runs on WASM and WebGPU alike.
"""
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


def cut_classifier(src: str, dst: str) -> None:
    model = onnx.load(src)
    graph = model.graph
    if len(graph.output) != 1:
        raise SystemExit(f"expected one output, got {[o.name for o in graph.output]}")
    head = next(n for n in graph.node if graph.output[0].name in n.output)
    if head.op_type not in ("Gemm", "MatMul"):
        raise SystemExit(f"last node is {head.op_type}, not a classifier layer")
    features = head.input[0]
    producer = next(n for n in graph.node if features in n.output)
    dim = None
    for init in graph.initializer:
        if init.name == head.input[1]:
            trans_b = next((a.i for a in head.attribute if a.name == "transB"), 0)
            dim = init.dims[1] if trans_b else init.dims[0]
    graph.node.remove(head)
    dropped = set(head.input[1:])
    keep = [i for i in graph.initializer if i.name not in dropped]
    del graph.initializer[:]
    graph.initializer.extend(keep)
    producer.output[list(producer.output).index(features)] = "features"
    del graph.output[:]
    graph.output.append(helper.make_tensor_value_info("features", TensorProto.FLOAT, ["batch_size", dim]))
    onnx.checker.check_model(model)
    onnx.save(model, dst)
    print(f"{dst}: output 'features' [batch_size, {dim}] (was {head.op_type} -> {head.output[0]})")


def merge_external(src: str, dst: str) -> None:
    model = onnx.load(src, load_external_data=True)
    onnx.save_model(model, dst, save_as_external_data=False)
    onnx.checker.check_model(dst)
    print(f"{dst}: weights inlined")


def fp16_weights(src: str, dst: str) -> None:
    model = onnx.load(src)
    graph = model.graph
    graph_inputs = {i.name for i in graph.input}
    inits, casts, kept = [], [], 0
    for init in graph.initializer:
        arr = numpy_helper.to_array(init) if init.data_type == TensorProto.FLOAT else None
        if arr is None or init.name in graph_inputs or arr.size < 16 or np.abs(arr).max() > 65000:
            inits.append(init)
            kept += arr is not None
            continue
        half = init.name + "__fp16"
        inits.append(numpy_helper.from_array(arr.astype(np.float16), half))
        casts.append(helper.make_node("Cast", [half], [init.name], name=init.name + "__to_fp32", to=TensorProto.FLOAT))
    del graph.initializer[:]
    graph.initializer.extend(inits)
    nodes = list(graph.node)
    del graph.node[:]
    graph.node.extend(casts + nodes)
    onnx.checker.check_model(model)
    onnx.save(model, dst)
    print(f"{dst}: {len(casts)} weight tensors stored as float16 ({kept} small or out-of-range ones kept float32)")


STEPS = {"cut-classifier": cut_classifier, "merge-external": merge_external, "fp16-weights": fp16_weights}

if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] not in STEPS:
        raise SystemExit(__doc__)
    STEPS[sys.argv[1]](sys.argv[2], sys.argv[3])
