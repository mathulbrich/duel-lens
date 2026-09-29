"""Encodes one README GIF from a recording (render.ts writes the spec).

    python make_gif.py <spec.json>

The spec names the screencast frames of each layer (a page), where each layer's crop goes on the
canvas, and the timeline of what the "user" did. This script samples the frames at a steady rate, draws
the pointer, the click ripples and the key badges (the page never had them), and writes an optimised
GIF: one adaptive palette for the whole clip (so an unchanged pixel keeps its colour index and each
frame only stores what changed), no dithering, and identical frames merged into one longer frame.
Needs Pillow (data/venv-train has it).
"""

from __future__ import annotations

import bisect
import json
import math
import os
import sys

from PIL import Image, ImageChops, ImageDraw

GOLD = (231, 185, 85)


def load_sprite(entry):
    im = Image.open(entry["file"]).convert("RGBA")
    return im, tuple(entry.get("hot", (0, 0)))


def faded(sprite: Image.Image, alpha: float, cache: dict, key) -> Image.Image:
    level = max(0, min(10, round(alpha * 10)))
    k = (key, level)
    if k not in cache:
        if level >= 10:
            cache[k] = sprite
        else:
            s = sprite.copy()
            s.putalpha(sprite.getchannel("A").point(lambda v: v * level // 10))
            cache[k] = s
    return cache[k]


def ripple_sprites(steps: int = 14, radius: int = 34, scale: int = 4):
    """An expanding ring (a click), as `steps` RGBA images; drawn large and scaled down for smooth edges."""
    out = []
    size = (radius + 6) * 2
    for i in range(steps):
        p = i / (steps - 1)
        big = Image.new("RGBA", (size * scale, size * scale), (0, 0, 0, 0))
        d = ImageDraw.Draw(big)
        c = size * scale / 2
        r = (8 + (radius - 8) * (1 - (1 - p) ** 2)) * scale
        a = int(235 * (1 - p) ** 1.2)
        w = max(1, int(3.2 * scale * (1 - 0.4 * p)))
        d.ellipse((c - r, c - r, c + r, c + r), outline=GOLD + (a,), width=w)
        if p < 0.35:  # the press itself: a soft dot that fades quickly
            r2 = 10 * scale
            d.ellipse((c - r2, c - r2, c + r2, c + r2), fill=GOLD + (int(150 * (1 - p / 0.35)),))
        out.append(big.resize((size, size), Image.LANCZOS))
    return out, size // 2


def press_dot(scale: int = 4):
    """What shows under the pointer while the button is held (a drag)."""
    size = 26
    big = Image.new("RGBA", (size * scale, size * scale), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    c = size * scale / 2
    r = 11 * scale
    d.ellipse((c - r, c - r, c + r, c + r), fill=GOLD + (120,), outline=GOLD + (230,), width=2 * scale)
    return big.resize((size, size), Image.LANCZOS), size // 2


class Layer:
    """One page's frames, cropped and placed on the canvas.

    Shown only from `from` until `until` when given; `frames_from` and `frames_before` limit which of the
    page's frames it uses (a page that changed size, or a moment to hold)."""

    def __init__(self, spec):
        self.start = spec.get("from", float("-inf"))
        self.end = spec.get("until", float("inf"))
        lo = spec.get("frames_from", float("-inf"))
        hi = spec.get("frames_before", float("inf"))
        self.frames = [f for f in spec["frames"] if lo <= f["t"] < hi]
        if not self.frames:
            raise SystemExit(f"a layer has no frame between {lo} and {hi}")
        self.times = [f["t"] for f in self.frames]
        self.crop = spec["crop"]
        self.at = tuple(spec["at"])
        self.scale = spec.get("scale", 1)
        self._file = None
        self._im = None

    def shown(self, t):
        return self.start <= t < self.end

    def image(self, t):
        i = max(0, bisect.bisect_right(self.times, t) - 1)
        f = self.frames[i]["file"]
        if f != self._file:
            im = Image.open(f).convert("RGB")
            x, y, w, h = self.crop
            s = self.scale
            im = im.crop((round(x * s), round(y * s), round((x + w) * s), round((y + h) * s)))
            if s != 1:
                im = im.resize((w, h), Image.LANCZOS)
            self._file, self._im = f, im
        return self._im


class Pointer:
    """Where the pointer is at time t, what it looks like, and whether its button is down."""

    def __init__(self, events, layers):
        pts = [e for e in events if e["type"] in ("move", "down", "up")]
        pts.sort(key=lambda e: e["t"])
        self.pts = pts
        self.times = [e["t"] for e in pts]
        self.layers = layers

    def canvas_xy(self, e):
        layer = self.layers[e.get("layer", 0)]
        x, y = e["x"] - layer.crop[0], e["y"] - layer.crop[1]
        return layer.at[0] + x, layer.at[1] + y

    def at(self, t):
        if not self.pts:
            return None
        i = bisect.bisect_right(self.times, t) - 1
        if i < 0:
            i = 0
        e0 = self.pts[i]
        x, y = self.canvas_xy(e0)
        if i + 1 < len(self.pts):
            e1 = self.pts[i + 1]
            gap = e1["t"] - e0["t"]
            if 0 < gap < 0.12 and e0["t"] <= t:
                k = (t - e0["t"]) / gap
                x1, y1 = self.canvas_xy(e1)
                x, y = x + (x1 - x) * k, y + (y1 - y) * k
        cursor = "arrow"
        down = False
        for e in self.pts[: i + 1]:
            if e["type"] == "move":
                cursor = e.get("cursor", cursor)
            elif e["type"] == "down":
                down = True
            elif e["type"] == "up":
                down = False
        return x, y, cursor, down


def compose(spec):
    fps = spec.get("fps", 10)
    t0, t1 = spec["t0"], spec["t1"]
    W, H = spec["canvas"]
    bg = tuple(spec.get("background", (23, 21, 30)))
    layers = [Layer(l) for l in spec["layers"]]
    events = spec.get("events", [])
    pointer = Pointer(events, layers)
    sprites = {k: load_sprite(v) for k, v in spec["sprites"]["cursors"].items()}
    keys = {k: Image.open(v).convert("RGBA") for k, v in spec["sprites"]["keys"].items()}
    ripples, rip_c = ripple_sprites()
    dot, dot_c = press_dot()
    downs = [e for e in events if e["type"] == "down"]
    key_events = [e for e in events if e["type"] == "key"]
    key_at = tuple(spec.get("key_at", (16, 16)))
    fade_cache: dict = {}

    frames = []
    n = int(math.floor((t1 - t0) * fps)) + 1
    for k in range(n):
        t = t0 + k / fps
        canvas = Image.new("RGBA", (W, H), bg + (255,))
        for layer in layers:
            if layer.shown(t):
                canvas.paste(layer.image(t), layer.at)
        for d in spec.get("dividers", []):
            x, y, w, h, color = d[:5]
            since = d[5] if len(d) > 5 else float("-inf")
            if t >= since:
                canvas.paste(tuple(color) + (255,), (x, y, x + w, y + h))
        # Click ripples.
        for e in downs:
            p = (t - e["t"]) / 0.55
            if 0 <= p < 1:
                cx, cy = pointer.canvas_xy(e)
                sprite = ripples[min(len(ripples) - 1, int(p * len(ripples)))]
                canvas.alpha_composite(sprite, (int(round(cx - rip_c)), int(round(cy - rip_c))))
        # The pointer.
        state = pointer.at(t)
        if state:
            x, y, cursor, down = state
            if down:
                canvas.alpha_composite(dot, (int(round(x - dot_c)), int(round(y - dot_c))))
            if cursor != "none" and cursor in sprites:
                sprite, hot = sprites[cursor]
                canvas.alpha_composite(sprite, (int(round(x - hot[0])), int(round(y - hot[1]))))
        # Key badges: fade in and out. A negative position counts from the right or bottom edge.
        for e in key_events:
            if e["t"] <= t < e["until"]:
                a = min(1.0, (t - e["t"]) / 0.12, (e["until"] - t) / 0.18)
                badge = faded(keys[e["label"]], a, fade_cache, e["label"])
                bx = key_at[0] if key_at[0] >= 0 else W - badge.width + key_at[0]
                by = key_at[1] if key_at[1] >= 0 else H - badge.height + key_at[1]
                canvas.alpha_composite(badge, (bx, by))
        frames.append(canvas.convert("RGB"))
    return frames, 1000 / fps


def merge_identical(frames, durations):
    out, durs = [], []
    for f, d in zip(frames, durations):
        if out and ImageChops.difference(out[-1], f).getbbox() is None:
            durs[-1] += d
        else:
            out.append(f)
            durs.append(d)
    return out, durs


def global_palette(frames, colors):
    """One adaptive palette for the clip, from up to 12 frames spread over it."""
    pick = frames if len(frames) <= 12 else [frames[round(i * (len(frames) - 1) / 11)] for i in range(12)]
    w, h = pick[0].size
    mosaic = Image.new("RGB", (w, h * len(pick)))
    for i, f in enumerate(pick):
        mosaic.paste(f, (0, i * h))
    return mosaic.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)


def main():
    spec_path = sys.argv[1]
    with open(spec_path) as fh:
        spec = json.load(fh)
    frames, frame_ms = compose(spec)
    frames, durs = merge_identical(frames, [frame_ms] * len(frames))
    if spec.get("end_hold"):
        durs[-1] += spec["end_hold"] * 1000
    pal = global_palette(frames, spec.get("colors", 256))
    quantized = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in frames]
    # Frames that differ only below the palette's precision are one frame too.
    q, d = [], []
    for f, dur in zip(quantized, durs):
        if q and ImageChops.difference(q[-1].convert("RGB"), f.convert("RGB")).getbbox() is None:
            d[-1] += dur
        else:
            q.append(f)
            d.append(dur)
    out = spec["out"]
    os.makedirs(os.path.dirname(out), exist_ok=True)
    q[0].save(
        out,
        save_all=True,
        append_images=q[1:],
        duration=[int(round(x / 10) * 10) for x in d],
        loop=0,
        optimize=True,
        disposal=1,
    )
    size = os.path.getsize(out)
    total = sum(d) / 1000
    report = {"out": out, "bytes": size, "frames": len(q), "seconds": round(total, 2), "size": list(q[0].size)}
    # Review frames: the GIF itself, read back, at the given fractions of its length.
    review = spec.get("review")
    if review:
        os.makedirs(review["dir"], exist_ok=True)
        gif = Image.open(out)
        starts, t = [], 0.0
        for i in range(gif.n_frames):
            gif.seek(i)
            starts.append(t)
            t += gif.info.get("duration", 100) / 1000
        written = []
        for j, frac in enumerate(review["at"]):
            target = frac * t
            i = max(0, bisect.bisect_right(starts, target) - 1)
            gif.seek(i)
            path = os.path.join(review["dir"], f"{review['name']}-{j + 1}.png")
            gif.convert("RGB").save(path)
            written.append(path)
        report["review"] = written
    print(json.dumps(report))


if __name__ == "__main__":
    main()
