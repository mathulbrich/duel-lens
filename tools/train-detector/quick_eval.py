"""Quick evaluation during training (Python): the 7 real full-view frames scored against click-D's
axis-aligned hand labels (data/debug/fullview/truth.json, its hit rule), and a fixed synthetic
validation set (held-out cards and artworks) at polygon IoU >= 0.5. The report's numbers come from
tools/train-detector/evaluate.ts (the TypeScript module, onnxruntime) on the quad labels.

  python quick_eval.py --ckpt ../../data/train-detector/ckpt/d1/last.pt [--out-dir <dir>]  (also draws outlines)
"""
from __future__ import annotations

import argparse
import json
import math

import cv2
import numpy as np
import torch

from common import FULLVIEW, WORK_LONG
from targets import decode, poly_iou

FACE_UP_KINDS = {"card", "featured"}
FACE_DOWN_KINDS = {"pile", "sleeve"}


def truth_class(t) -> int | None:
    k = t["kind"]
    if k == "featured" and "card back" in t.get("note", ""):
        return 1
    if k in FACE_UP_KINDS:
        return 0
    if k in FACE_DOWN_KINDS:
        return 1
    return None  # ignore


def prepare(img: np.ndarray, long_side: int = WORK_LONG):
    """RGB uint8 -> padded float tensor [1,3,H,W] at the working scale, and the scale factor."""
    h, w = img.shape[:2]
    s = min(1.0, long_side / max(h, w))
    nw, nh = int(round(w * s)), int(round(h * s))
    im = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA) if s < 1 else img
    ph, pw = int(math.ceil(nh / 32) * 32), int(math.ceil(nw / 32) * 32)
    pad = np.full((ph, pw, 3), 114, np.uint8)
    pad[:nh, :nw] = im
    return torch.from_numpy(np.ascontiguousarray(pad.transpose(2, 0, 1)))[None].float() / 255.0, s


@torch.no_grad()
def detect(model, dev, img: np.ndarray, thr=0.2, long_side: int = WORK_LONG):
    x, s = prepare(img, long_side)
    logits, box = model(x.to(dev))
    heat = torch.sigmoid(logits.float())[0].cpu().numpy()
    dets = decode(heat, box.float()[0].cpu().numpy(), thr=thr)
    for d in dets:
        for k in ("cx", "cy", "w", "h"):
            d[k] /= s
        d["quad"] = d["quad"] / s
    return dets


def score_frame(dets, truth, thr):
    hit = {}
    fps = []
    conf = np.zeros((2, 3), int)  # truth class x predicted class (2 = missed)
    for d in dets:
        if d["score"] < thr:
            continue
        x0, y0 = d["quad"].min(0)
        x1, y1 = d["quad"].max(0)
        best, best_iou = -1, 0.0
        for i, t in enumerate(truth):
            bx, by, bw, bh = t["box"]
            inside = bx - 0.1 * bw <= d["cx"] <= bx + 1.1 * bw and by - 0.1 * bh <= d["cy"] <= by + 1.1 * bh
            ratio = (x1 - x0) * (y1 - y0) / max(1.0, bw * bh)
            if not inside or ratio < 0.3 or ratio > 3:
                continue
            ix = max(0.0, min(x1, bx + bw) - max(x0, bx))
            iy = max(0.0, min(y1, by + bh) - max(y0, by))
            u = ix * iy / ((x1 - x0) * (y1 - y0) + bw * bh - ix * iy + 1e-6)
            if u > best_iou:
                best, best_iou = i, u
        if best < 0:
            fps.append(d)
        elif truth_class(truth[best]) is None:
            continue
        elif best not in hit:
            hit[best] = d
    for i, t in enumerate(truth):
        c = truth_class(t)
        if c is None:
            continue
        conf[c, hit[i]["cls"] if i in hit else 2] += 1
    return conf, fps


def fullview(model, dev, thrs=(0.3, 0.5), out_dir=None):
    truth = json.load(open(FULLVIEW / "truth.json"))
    res = {}
    allconf = {t: np.zeros((2, 3), int) for t in thrs}
    allfp = {t: 0 for t in thrs}
    for name, labels in truth.items():
        if name.startswith("_"):
            continue
        img = cv2.cvtColor(cv2.imread(str(FULLVIEW / name)), cv2.COLOR_BGR2RGB)
        dets = detect(model, dev, img, thr=min(thrs))
        for t in thrs:
            conf, fps = score_frame(dets, labels, t)
            allconf[t] += conf
            allfp[t] += len(fps)
        if out_dir is not None:
            draw_dets(img, dets, labels, out_dir / name, min(thrs))
    for t in thrs:
        c = allconf[t]
        res[f"t{t}"] = dict(faceup=f"{c[0, 0] + c[0, 1]}/{c[0].sum()}", facedown=f"{c[1, 0] + c[1, 1]}/{c[1].sum()}",
                            up_as_down=int(c[0, 1]), down_as_up=int(c[1, 0]), fp=allfp[t])
    return res


def draw_dets(img, dets, labels, path, thr):
    out = cv2.cvtColor(img, cv2.COLOR_RGB2BGR).copy()
    for t in labels:
        x, y, w, h = t["box"]
        c = truth_class(t)
        col = (160, 160, 160) if c is None else ((0, 0, 255) if c == 0 else (0, 128, 255))
        cv2.rectangle(out, (int(x), int(y)), (int(x + w), int(y + h)), col, 1)
    for d in dets:
        if d["score"] < thr:
            continue
        col = (80, 220, 60) if d["cls"] == 0 else (255, 160, 40)
        cv2.polylines(out, [np.round(d["quad"]).astype(np.int32)], True, col, 2, cv2.LINE_AA)
        cv2.putText(out, f"{d['score']:.2f}", (int(d["quad"][0][0]), int(d["quad"][0][1]) - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.45, col, 1, cv2.LINE_AA)
    cv2.imwrite(str(path), out)


_VAL = None


def synth_val(model, dev, n_frames=24, thr=0.3):
    """On fixed held-out synthetic frames (1280x720; held-out cards/artworks; about a third keystoned):
    recall / precision at quad IoU >= 0.5, class accuracy, the median predicted/true width, and the
    mean corner error (px, and in card widths) of matched cards, best of the 4 cyclic corner orders (and, as
    synth_corner_px_box, of their rotated boxes alone). Since DET-SPREADS the frames hold face-up spreads too
    (render_frame's default): d5 scores lower on this set than in its own log (see the report)."""
    global _VAL
    from scene import Assets, label_of, render_frame

    if _VAL is None:
        A = Assets("val")
        _VAL = []
        for i in range(n_frames):
            r = np.random.default_rng([999, i])
            img, objs, kind = render_frame(A, r)
            _VAL.append((img, [o for o in objs], kind))
    tp = fp = fn = 0
    cls_ok = cls_n = 0
    ratios, cerr, cerr_rel, angerr, cerr_box = [], [], [], [], []
    for img, objs, kind in _VAL:
        dets = [d for d in detect(model, dev, img, thr=thr, long_side=10_000) if d["score"] >= thr]
        gts = [(label_of(o, o.visible), np.float32(o.quad)) for o in objs]
        used = set()
        for d in dets:
            best, bi = 0.0, -1
            for i, (c, q) in enumerate(gts):
                if c == -2:
                    continue
                u = poly_iou(d["quad"], q)
                if u > best:
                    best, bi = u, i
            if best >= 0.3 and bi >= 0 and gts[bi][0] >= 0:
                o = objs[bi]
                ratios.append(d["w"] / max(1e-3, min(o.w, o.h)))
            if best >= 0.5 and bi not in used:
                if gts[bi][0] >= 0:
                    used.add(bi)
                    tp += 1
                    cls_n += 1
                    cls_ok += int(d["cls"] == gts[bi][0])
                    q = gts[bi][1]
                    ta = math.degrees(objs[bi].angle)
                    if abs(((ta + 45) % 90) - 45) > 8:  # tilted more than 8 degrees off an axis
                        da = (math.degrees(d["angle"]) - ta) % 90  # outline angles agree modulo 90 (portrait box vs card frame)
                        angerr.append(min(da, 90 - da))
                    e = min(float(np.linalg.norm(np.roll(d["quad"], -k, 0) - q, axis=1).mean()) for k in range(4))
                    cerr.append(e)
                    cerr_box.append(min(float(np.linalg.norm(np.roll(d["rbox"], -k, 0) - q, axis=1).mean()) for k in range(4)))
                    cerr_rel.append(e / max(1.0, min(objs[bi].w, objs[bi].h)))
            elif best < 0.3 or (bi >= 0 and gts[bi][0] >= 0 and bi in used):
                fp += 1
        fn += sum(1 for i, (c, q) in enumerate(gts) if c >= 0 and i not in used)
    return dict(synth_recall=round(tp / max(1, tp + fn), 4), synth_precision=round(tp / max(1, tp + fp), 4), synth_cls_acc=round(cls_ok / max(1, cls_n), 4),
                synth_size_ratio=round(float(np.median(ratios)) if ratios else 0.0, 4),
                synth_corner_px=round(float(np.mean(cerr)) if cerr else 0.0, 2), synth_corner_rel=round(float(np.mean(cerr_rel)) if cerr_rel else 0.0, 4),
                # the same with the rotated box's own corners: equal to synth_corner_px when the corner head is inert
                synth_corner_px_box=round(float(np.mean(cerr_box)) if cerr_box else 0.0, 2),
                synth_tilted_angle_err_deg=round(float(np.median(angerr)) if angerr else -1.0, 2), synth_tilted_n=len(angerr))


def quick_eval(model, dev):
    res = {"fullview": fullview(model, dev)}
    res.update(synth_val(model, dev))
    return res


if __name__ == "__main__":
    from pathlib import Path

    from model import Detector

    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--out-dir", default=None)
    ap.add_argument("--long", type=int, default=WORK_LONG)
    args = ap.parse_args()
    dev = torch.device("mps")
    sd = torch.load(args.ckpt, map_location="cpu")
    m = Detector(sd.get("args", {}).get("backbone", "mnv3l"), pretrained=False, corner_act=sd.get("args", {}).get("corner_act", "relu"))
    m.load_state_dict(sd["model"])
    m.to(dev).eval()
    out = Path(args.out_dir) if args.out_dir else None
    if out:
        out.mkdir(parents=True, exist_ok=True)
    print(json.dumps(fullview(m, dev, out_dir=out), indent=1))
    print(json.dumps(synth_val(m, dev)))
