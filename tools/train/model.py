"""The embedder: DINOv2 ViT-S/14 (facebook/dinov2-small, Apache-2.0; 384 dims) or ViT-B/14 (facebook/dinov2-base,
Apache-2.0; 768 dims, `arch="base"`), CLS token after the final layer norm (= HF pooler_output), with the position
embeddings baked at 224 px so the exported graph needs no interpolation. Optional in-graph per-image, per-channel input standardisation
(invariance to global per-channel affine colour changes: washout, lifted blacks, white balance).

A student (`depth`, `size`; Live check's Light speed): fewer transformer blocks and a smaller input, resized inside the
graph from the usual 224 px (so the engine feeds it as any other model), its position embeddings baked at `size`.
`shrink_state` makes one from a full checkpoint: every `keep_layers` block, the position grid resized."""
from __future__ import annotations

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

import common  # noqa: F401  (sets HF_HOME)
from common import MEAN, S, STD

ARCHS = {"small": "facebook/dinov2-small", "base": "facebook/dinov2-base"}
BASE = ARCHS["small"]


def keep_layers(n: int, depth: int) -> list[int]:
    """`depth` of `n` blocks, evenly spaced from the first to the last."""
    return sorted({int(round(i * (n - 1) / (depth - 1))) for i in range(depth)}) if depth > 1 else [n - 1]


def resize_pos(pos: torch.Tensor, size: int) -> torch.Tensor:
    """Baked position embeddings [1, 1+g*g, d] (CLS first) resized (bicubic) to a `size` px input's grid."""
    cls, grid = pos[:, :1], pos[:, 1:]
    g, n = int(round(grid.shape[1] ** 0.5)), size // 14
    if g == n:
        return pos
    grid = grid.reshape(1, g, g, -1).permute(0, 3, 1, 2)
    grid = F.interpolate(grid.float(), size=(n, n), mode="bicubic", align_corners=False).to(pos.dtype)
    return torch.cat([cls, grid.permute(0, 2, 3, 1).reshape(1, n * n, -1)], dim=1)


class Embedder(nn.Module):
    def __init__(self, standardize: bool = False, arch: str = "small", depth: int | None = None, size: int = S):
        super().__init__()
        from transformers import Dinov2Model

        m = Dinov2Model.from_pretrained(ARCHS[arch])
        self.arch = arch
        if depth and depth < len(m.encoder.layer):  # a student: the blocks it keeps (weights from shrink_state)
            m.encoder.layer = nn.ModuleList([m.encoder.layer[i] for i in keep_layers(len(m.encoder.layer), depth)])
            m.config.num_hidden_layers = depth
        with torch.no_grad():  # bake `size` px position embeddings (224 px: 16x16 patches + CLS)
            emb = m.embeddings
            dummy = torch.zeros(1, 1 + (size // 14) ** 2, emb.position_embeddings.shape[-1])
            pos = emb.interpolate_pos_encoding(dummy, size, size)
            emb.position_embeddings = nn.Parameter(pos.clone())
            m.config.image_size = size
        self.vit = m
        self.size = size
        self.standardize = standardize

    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
        x = pixel_values
        if x.shape[-1] != self.size:  # a student's smaller input, from the usual 224 px
            x = F.interpolate(x, size=(self.size, self.size), mode="bilinear", align_corners=False)
        if self.standardize:
            mu = x.mean(dim=(2, 3), keepdim=True)
            sd = x.std(dim=(2, 3), keepdim=True)
            x = (x - mu) / (sd + 1e-3)
        return self.vit(pixel_values=x).pooler_output

    @property
    def dim(self) -> int:
        return self.vit.config.hidden_size


def arch_of(state_dict: dict) -> str:
    """'small' (384-dim) or 'base' (768-dim), from a checkpoint's CLS token."""
    return "base" if state_dict["vit.embeddings.cls_token"].shape[-1] == 768 else "small"


def shape_of(state_dict: dict) -> tuple[int, int]:
    """A checkpoint's (depth, input size): its blocks, and its position grid's side in px."""
    depth = len({k.split(".")[3] for k in state_dict if k.startswith("vit.encoder.layer.")})
    tokens = state_dict["vit.embeddings.position_embeddings"].shape[1] - 1
    return depth, int(round(tokens ** 0.5)) * 14


def shrink_state(state_dict: dict, depth: int, size: int) -> dict:
    """A student's start from a full checkpoint: its keep_layers blocks renumbered, its position grid resized."""
    n, _ = shape_of(state_dict)
    keep = keep_layers(n, depth)
    out = {}
    for k, v in state_dict.items():
        if k.startswith("vit.encoder.layer."):
            parts = k.split(".")
            i = int(parts[3])
            if i not in keep:
                continue
            parts[3] = str(keep.index(i))
            k = ".".join(parts)
        out[k] = v
    out["vit.embeddings.position_embeddings"] = resize_pos(state_dict["vit.embeddings.position_embeddings"], size)
    return out


def load_embedder(ckpt: str, standardize: bool = True) -> Embedder:
    """An Embedder of the checkpoint's own architecture and shape (a student's depth and size), with its weights (CPU)."""
    sd = torch.load(ckpt, map_location="cpu")
    depth, size = shape_of(sd)
    m = Embedder(standardize=standardize, arch=arch_of(sd), depth=depth, size=size)
    m.load_state_dict(sd)
    return m


def freeze_until(model: Embedder, first_trainable_block: int):
    """Freeze the patch/position embeddings and blocks [0, first_trainable_block)."""
    for p in model.vit.embeddings.parameters():
        p.requires_grad_(False)
    for i, blk in enumerate(model.vit.encoder.layer):
        for p in blk.parameters():
            p.requires_grad_(i >= first_trainable_block)


def param_groups(model: Embedder, lr: float, decay: float, wd: float):
    """Layer-wise learning-rate decay: the last block gets lr, each earlier block decay x less."""
    n = len(model.vit.encoder.layer)
    groups = []
    for i, blk in enumerate(model.vit.encoder.layer):
        ps = [p for p in blk.parameters() if p.requires_grad]
        if ps:
            scale = decay ** (n - 1 - i)
            groups.append({"params": [p for p in ps if p.ndim > 1], "lr": lr * scale, "weight_decay": wd, "base_lr": lr * scale})
            groups.append({"params": [p for p in ps if p.ndim <= 1], "lr": lr * scale, "weight_decay": 0.0, "base_lr": lr * scale})
    ln = [p for p in model.vit.layernorm.parameters() if p.requires_grad]
    groups.append({"params": ln, "lr": lr, "weight_decay": 0.0, "base_lr": lr})
    return [g for g in groups if g["params"]]


_MEAN = torch.tensor(MEAN).view(1, 3, 1, 1)
_STD = torch.tensor(STD).view(1, 3, 1, 1)


def to_input(u8: torch.Tensor | np.ndarray, device) -> torch.Tensor:
    """uint8 [n,224,224,3] -> normalised float [n,3,224,224] on device (the extension's toTensorCHW)."""
    if isinstance(u8, np.ndarray):
        u8 = torch.from_numpy(np.ascontiguousarray(u8))
    x = u8.to(device, non_blocking=True).permute(0, 3, 1, 2).float() / 255
    return (x - _MEAN.to(device)) / _STD.to(device)


@torch.no_grad()
def embed_u8(model: nn.Module, imgs, device, bs: int = 256, amp: torch.dtype | None = None) -> torch.Tensor:
    """L2-normalised embeddings (CPU float32) of uint8 images [n,224,224,3] (array or memmap)."""
    was = model.training
    model.eval()
    out = []
    for s in range(0, len(imgs), bs):
        x = to_input(np.asarray(imgs[s:s + bs]), device)
        with torch.autocast("mps", dtype=amp, enabled=amp is not None):
            z = model(x)
        out.append(F.normalize(z.float(), dim=1).cpu())
    model.train(was)
    return torch.cat(out)
