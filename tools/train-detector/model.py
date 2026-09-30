"""The card detector: a CenterNet-style oriented-box detector on a light timm backbone.

    image [1, 3, H, W] RGB in [0, 1] (H, W multiples of 32)
      -> backbone features at strides 4, 8, 16, 32 (timm features_only, ImageNet weights)
      -> FPN-lite top-down neck (1x1 laterals, nearest 2x upsampling, depthwise-separable convs)
      -> heads at stride 4:
           heat   [1, K, H/4, W/4]  centre heatmap per class (sigmoid inside the graph), K = 2:
                                    0 face-up card, 1 face-down (sleeve back, deck pile, card back)
           box    [1, 14, H/4, W/4] dx, dy (sub-cell centre offset, cells), log(w/4), log(h/4)
                                    (w, h = the card's own width and height edges, in cells), sin 2t,
                                    cos 2t (t = the card's own vertical axis from vertical, clockwise;
                                    a card's outline is the same turned 180 degrees, so only 2t is
                                    defined), then 8 corner residuals: the 4 corners (keystone) in the
                                    box frame at t in (-45, 135] degrees, (w/2, h/2) units, minus the
                                    rectangle's corners (targets.corner_targets)
           peak   [1, K, H/4, W/4]  3x3 max-pool of heat (the decoder keeps cells where heat == peak)

The normalisation (ImageNet mean/std) is inside the graph so the caller only feeds RGB / 255.
"""
from __future__ import annotations

import math

import torch
import torch.nn as nn
import torch.nn.functional as F

CLASSES = ("face-up", "face-down")
STRIDE = 4
MEAN = (0.485, 0.456, 0.406)
STD = (0.229, 0.224, 0.225)

BACKBONES = {
    # name: timm id with Apache-2.0 ImageNet weights (license checked on the Hugging Face hub)
    "mnv3l": "mobilenetv3_large_100.ra_in1k",
    "mnv3s": "mobilenetv3_small_100.lamb_in1k",
    "mnv4s": "mobilenetv4_conv_small.e2400_r224_in1k",
    "lcnet": "lcnet_100.ra2_in1k",
    "effl0": "efficientnet_lite0.ra_in1k",
}


class ConvBNAct(nn.Sequential):
    """Conv + BN + activation: act True or "relu" (ReLU), "leaky" (LeakyReLU 0.1), False (none)."""

    def __init__(self, cin, cout, k=1, groups=1, act=True):
        super().__init__(nn.Conv2d(cin, cout, k, padding=k // 2, groups=groups, bias=False), nn.BatchNorm2d(cout))
        if act == "leaky":
            self.append(nn.LeakyReLU(0.1, inplace=True))
        elif act:
            self.append(nn.ReLU(inplace=True))


class DWSep(nn.Sequential):
    """Depthwise 3x3 + pointwise 1x1, each with BN + an activation (ReLU; see ConvBNAct)."""

    def __init__(self, cin, cout, k=3, act=True):
        super().__init__(ConvBNAct(cin, cin, k, groups=cin, act=act), ConvBNAct(cin, cout, 1, act=act))


class Detector(nn.Module):
    def __init__(self, backbone: str = "mnv3l", pretrained: bool = True, neck: int = 64, head: int = 48, classes: int = len(CLASSES),
                 corner_act: str = "relu"):
        """corner_act: the corner branch's hidden activations, "relu" (d1-d5) or "leaky" (LeakyReLU 0.1). With ReLU the
        branch went inert at card centres in d3-d5: every hidden unit off there, so its output was its final conv's bias
        and no gradient could reach it again (detector-spreads-report.md, Part 1). LeakyReLU can't switch off."""
        super().__init__()
        import timm

        self.backbone_name = backbone
        self.corner_act = corner_act
        self.body = timm.create_model(BACKBONES[backbone], pretrained=pretrained, features_only=True, out_indices=(1, 2, 3, 4))
        c4, c8, c16, c32 = self.body.feature_info.channels()
        self.l32 = ConvBNAct(c32, neck)
        self.l16 = ConvBNAct(c16, neck)
        self.l8 = ConvBNAct(c8, neck)
        self.p16 = DWSep(neck, neck)
        self.p8 = DWSep(neck, neck)
        self.to4 = ConvBNAct(neck, head)
        self.l4 = ConvBNAct(c4, head)
        self.p4 = DWSep(head, head)
        self.heat = nn.Sequential(DWSep(head, head), nn.Conv2d(head, classes, 1))
        # separate branches: the offset (large |dx| away from the centre) must not drive the size's features
        self.offset = nn.Sequential(DWSep(head, head), nn.Conv2d(head, 2, 1))
        self.shape = nn.Sequential(DWSep(head, head), nn.Conv2d(head, 4, 1))  # log w, log h, sin 2t, cos 2t
        # the 4 corners (keystone): residuals from the rectangle's corners in the box frame (targets.corner_targets)
        self.corners = nn.Sequential(DWSep(head, head, act=corner_act), nn.Conv2d(head, 8, 1))
        self.register_buffer("mean", torch.tensor(MEAN).view(1, 3, 1, 1), persistent=False)
        self.register_buffer("std", torch.tensor(STD).view(1, 3, 1, 1), persistent=False)
        # CenterNet's prior: heatmap logits start at p = 0.01
        nn.init.constant_(self.heat[-1].bias, -math.log((1 - 0.01) / 0.01))
        for head_ in (self.offset, self.shape, self.corners):
            nn.init.zeros_(head_[-1].bias)
            nn.init.normal_(head_[-1].weight, std=0.01)
        # sizes start at a typical card (70 x 102 px), so the weights only model the deviation from it
        with torch.no_grad():
            self.shape[-1].bias[0] = math.log(70 / 4)
            self.shape[-1].bias[1] = math.log(102 / 4)
            self.shape[-1].bias[3] = 1.0  # cos 2t: upright

    def reinit_branch(self, name: str):
        """Re-initialise one output branch ("heat", "offset", "shape" or "corners") as a new model's: its hidden layers
        (and BN statistics) PyTorch's defaults, its final conv as in __init__. For a fine-tune whose checkpoint has a
        dead branch (d5's corners)."""
        branch = getattr(self, name)
        for m in branch.modules():
            if isinstance(m, (nn.Conv2d, nn.BatchNorm2d)):
                m.reset_parameters()
        last = branch[-1]
        if name == "heat":  # default weights, CenterNet's prior p = 0.01
            nn.init.constant_(last.bias, -math.log((1 - 0.01) / 0.01))
            return
        nn.init.zeros_(last.bias)
        nn.init.normal_(last.weight, std=0.01)
        if name == "shape":
            with torch.no_grad():
                last.bias[0] = math.log(70 / 4)
                last.bias[1] = math.log(102 / 4)
                last.bias[3] = 1.0

    def features(self, x):
        f4, f8, f16, f32 = self.body((x - self.mean) / self.std)
        up = lambda t: F.interpolate(t, scale_factor=2.0, mode="nearest")  # noqa: E731
        p16 = self.p16(up(self.l32(f32)) + self.l16(f16))
        p8 = self.p8(up(p16) + self.l8(f8))
        return self.p4(up(self.to4(p8)) + self.l4(f4))

    def forward(self, x):
        """Training output: heatmap logits [N, K, h, w] and box regressions [N, 14, h, w]
        (dx, dy, log w, log h, sin 2t, cos 2t, 8 corner residuals)."""
        p4 = self.features(x)
        return self.heat(p4), torch.cat([self.offset(p4), self.shape(p4), self.corners(p4)], 1)


class Exported(nn.Module):
    """The graph shipped to the extension: sigmoid heatmap, its 3x3 max-pool, raw box channels."""

    def __init__(self, det: Detector):
        super().__init__()
        self.det = det

    def forward(self, image):
        logits, box = self.det(image)
        heat = torch.sigmoid(logits)
        peak = F.max_pool2d(heat, 3, stride=1, padding=1)
        return heat, box, peak


def count_params(m: nn.Module) -> float:
    return sum(p.numel() for p in m.parameters()) / 1e6
