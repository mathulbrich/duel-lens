"""The embedder: DINOv2 ViT-S/14 (facebook/dinov2-small, Apache-2.0), CLS token after the final layer
norm (= HF pooler_output), 384 dims, with the position embeddings baked at 224 px so the exported
graph needs no interpolation. Optional in-graph per-image, per-channel input standardisation
(invariance to global per-channel affine colour changes: washout, lifted blacks, white balance)."""
from __future__ import annotations

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

import common  # noqa: F401  (sets HF_HOME)
from common import MEAN, S, STD

BASE = "facebook/dinov2-small"


class Embedder(nn.Module):
    def __init__(self, standardize: bool = False):
        super().__init__()
        from transformers import Dinov2Model

        m = Dinov2Model.from_pretrained(BASE)
        with torch.no_grad():  # bake 224 px position embeddings (16x16 patches + CLS)
            emb = m.embeddings
            dummy = torch.zeros(1, 1 + (S // 14) ** 2, emb.position_embeddings.shape[-1])
            pos = emb.interpolate_pos_encoding(dummy, S, S)
            emb.position_embeddings = nn.Parameter(pos.clone())
            m.config.image_size = S
        self.vit = m
        self.standardize = standardize

    def forward(self, pixel_values: torch.Tensor) -> torch.Tensor:
        x = pixel_values
        if self.standardize:
            mu = x.mean(dim=(2, 3), keepdim=True)
            sd = x.std(dim=(2, 3), keepdim=True)
            x = (x - mu) / (sd + 1e-3)
        return self.vit(pixel_values=x).pooler_output


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
