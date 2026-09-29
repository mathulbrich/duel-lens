"""Markdown tables from the evaluation outputs (data/train-detector/eval/*.json), for the report.

  python tables.py [--results results.json] [--tiles results-tiles.json] [--straighten straighten.json]
                   [--thr 0.4]
"""
from __future__ import annotations

import argparse
import json
from statistics import mean

from common import EVAL_DIR

ORDER = ["all", "set A: 7 frames, 4 productions", "YCS Paris 2026 (main)", "YCS Paris 2026 (Genesys)", "WC 2026", "WCQ Stuttgart 2026",
         "set B: 10 frames, 5 new productions", "YCS Columbus 2026", "Houston Game Guys (locals)", "tsc (table-cam stream)",
         "dlaw (casual table stream)", "dp (oblique close-up)"]


def frac(a, b):
    return f"{a}/{b}" if b else "–"


def fullview_table(res, thr):
    t = res["fullview"]["table"][str(thr)]
    out = ["| Frames | Face-up (IoU ≥ 0.5) | Face-down (IoU ≥ 0.5) | Up→down | Down→up | False outlines (per frame) | Corner error, px (% of width) |",
           "|---|---|---|---|---|---|---|"]
    for k in ORDER:
        if k not in t:
            continue
        r = t[k]
        cp = mean(r["cornerPx"]) if r["cornerPx"] else float("nan")
        cr = mean(r["cornerRel"]) if r["cornerRel"] else float("nan")
        out.append(f"| {k} | {frac(*r['up'])} | {frac(*r['down'])} | {r['upAsDown']} | {r['downAsUp']} | {r['fp']} ({r['fp'] / r['frames']:.2f}) | {cp:.1f} ({100 * cr:.1f}%) |")
    return "\n".join(out)


def threshold_table(res, label):
    t = res["fullview"]["table"]
    out = [f"| Threshold ({label}) | Face-up | Face-down | Down→up | Up→down | False outlines |", "|---|---|---|---|---|---|"]
    for thr in sorted(t, key=float):
        r = t[thr]["all"]
        out.append(f"| {thr} | {frac(*r['up'])} | {frac(*r['down'])} | {r['downAsUp']} | {r['upAsDown']} | {r['fp']} |")
    return "\n".join(out)


def realset_table(res):
    rows = res["realset"]["rows"]
    out = ["| Production | n | On the frame, IoU ≥ 0.3 / ≥ 0.5 | …as face-up | In the user box's crop, IoU ≥ 0.3 / ≥ 0.5 | …as face-up |", "|---|---|---|---|---|---|"]
    for k in ["all", "YCS Paris 2026", "WC 2026", "WCQ Stuttgart 2026"]:
        rs = [r for r in rows if k == "all" or r["production"] == k]
        n = len(rs)
        f3 = sum(r["frameIoU"] >= 0.3 for r in rs)
        f5 = sum(r["frameIoU"] >= 0.5 for r in rs)
        fu = sum(r["frameIoU"] >= 0.3 and r["frameKind"] == "face-up" for r in rs)
        c3 = sum(r["cropIoU"] >= 0.3 for r in rs)
        c5 = sum(r["cropIoU"] >= 0.5 for r in rs)
        cu = sum(r["cropIoU"] >= 0.3 and r["cropKind"] == "face-up" for r in rs)
        out.append(f"| {k} | {n} | {f3} / {f5} | {fu} | {c3} / {c5} | {cu} |")
    return "\n".join(out)


def negatives_table(res):
    neg = res["realset"]["negatives"]
    out = ["| Set | Boxes | Piles/sleeves: face-down outline / face-up / none (frame) | Nothing there: outlined (frame) | Nothing there: top pick in the box's crop (up / down / none) | Mat art as face-up (frame / crop) |",
           "|---|---|---|---|---|---|"]
    for s in ["negatives.json", "staging-C-negatives.json"]:
        rs = [r for r in neg if r["set"] == s]
        objs = [r for r in rs if r["object"] == "face-down"]
        none = [r for r in rs if r["object"] == "nothing"]
        art = [r for r in rs if r["matArt"]]
        out.append(
            f"| {s} | {len(rs)} | {sum(bool(r['frameDown']) and not r['frameUp'] for r in objs)} / {sum(bool(r['frameUp']) for r in objs)} / {sum(not r['frameUp'] and not r['frameDown'] for r in objs)} of {len(objs)} "
            f"| {sum(bool(r['frameUp'] or r['frameDown']) for r in none)} of {len(none)} (face-up {sum(bool(r['frameUp']) for r in none)}) "
            f"| {sum((r['cropTop'] or {}).get('kind') == 'face-up' for r in none)} / {sum((r['cropTop'] or {}).get('kind') == 'face-down' for r in none)} / {sum(r['cropTop'] is None for r in none)} "
            f"| {sum(bool(r['frameUp']) for r in art)} / {sum((r['cropTop'] or {}).get('kind') == 'face-up' for r in art)} of {len(art)} |")
    return "\n".join(out)


def straighten_table(st):
    rs = st["results"]
    right = lambda v, r: bool(v) and v["top1"] == r["cardId"]  # noqa: E731
    sure = lambda v, r: right(v, r) and v["confident"]  # noqa: E731
    wrong_sure = lambda v, r: bool(v) and v["confident"] and v["top1"] != r["cardId"]  # noqa: E731
    out = ["| Rows | n | Model's 4 corners: top-1 / confident / confident wrong | Model's rotated box | Refined corners | Refined box | Refined merged (corners, box, box +8%) | Engine (eval-straighten.ts --engine-results): top-1 / confident | Engine or refined merged right |",
           "|---|---|---|---|---|---|---|---|---|"]
    groups = [("all", rs)] + [(p, [r for r in rs if r["production"] == p]) for p in dict.fromkeys(r["production"] for r in rs)] + \
             [(f"tag: {t}", [r for r in rs if t in r["tags"]]) for t in ["perspective", "tilted", "defense", "foil", "occluded"]]
    for name, g in groups:
        eng = [r for r in g if r["engine"]]
        cell = lambda key: f"{sum(right(r.get(key), r) for r in g)} / {sum(sure(r.get(key), r) for r in g)} / {sum(wrong_sure(r.get(key), r) for r in g)}"  # noqa: E731
        out.append(f"| {name} | {len(g)} | {cell('quad')} | {cell('rect')} | {cell('refined')} | {cell('refinedBox')} | {cell('merged')} "
                   f"| {sum(r['engine']['top1'] for r in eng)} / {sum(r['engine']['top1'] and r['engine']['confident'] for r in eng)} of {len(eng)} "
                   f"| {sum(right(r.get('merged'), r) or bool(r['engine'] and r['engine']['top1']) for r in g)} |")
    dp = [r for r in rs if r["production"] == "dp close-up"]
    out.append("")
    out.append("| dp close-up row | Model's corners | Refined merged | Engine | Corner error: model / refined, px (card width) |")
    out.append("|---|---|---|---|---|")
    for r in dp:
        q, m = r["quad"], r.get("merged")
        c = r.get("corner")
        corner = f"{c['quadPx']} / {c['refinedPx']} ({c['side']})" if c else "–"
        quad = f"{'right' if right(q, r) else 'wrong'} {q['score'] if q else '–'}{' confident' if q and q['confident'] else ''}"
        mer = f"{'right' if right(m, r) else 'wrong'} {m['score'] if m else '–'}{' confident' if m and m['confident'] else ''}"
        eng = "right" if r["engine"] and r["engine"]["top1"] else "wrong"
        out.append(f"| {r['id'].replace('native-', '')} | {quad} | {mer} | {eng} | {corner} |")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", default="results.json")
    ap.add_argument("--tiles", default="results-tiles.json")
    ap.add_argument("--straighten", default="straighten.json")
    ap.add_argument("--thr", default="0.4")
    a = ap.parse_args()
    res = json.load(open(EVAL_DIR / a.results))
    print(f"### Full-view frames, threshold {a.thr}\n")
    print(fullview_table(res, a.thr))
    print("\n### All 17 frames by threshold (whole-frame path)\n")
    print(threshold_table(res, "ours"))
    p = EVAL_DIR / a.tiles
    if p.exists():
        print("\n### tiles\n")
        print(threshold_table(json.load(open(p)), "tiles"))
    print("\n### Real set\n")
    print(realset_table(res))
    print("\n### Negatives\n")
    print(negatives_table(res))
    p = EVAL_DIR / a.straighten
    if p.exists():
        print("\n### Recogniser after straightening\n")
        print(straighten_table(json.load(open(p))))


if __name__ == "__main__":
    main()
