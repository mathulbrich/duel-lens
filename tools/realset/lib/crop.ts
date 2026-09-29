// The content script's crop, reproduced exactly (see tools/debug-scan.ts, which does the same
// for the same reason): cropSelection's screenshot branch is CROP_MARGIN around the user's box,
// clipped to the frame, downscaled if huge, plus `inner` (the user's box in crop pixels). Two
// private helpers of src/content/capture.ts (toPixels, innerBox) are copied verbatim, cited
// below; everything else (expandRect, cropRGBA, resizeRGBA) is imported and run for real.
//
// Shared by tools/realset/verify.ts (the contact-sheet crop) and tools/eval-real.ts (the crop
// fed to a recogniser), so both see the same pixels the extension would send.
import { CROP_MARGIN, MAX_CROP_SIDE } from '../../../src/content/capture';
import { expandRect, type Rect } from '../../../src/content/geometry';
import type { UserBox } from '../../../src/offscreen/engine';
import { cropRGBA, resizeRGBA, type RGBAImage } from '../../../src/shared/preprocess';

/** src/content/capture.ts lines 168-173 (toPixels): whole source pixels covering `r`. */
function toCropPixels(r: Rect): Rect {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return { x, y, w: Math.max(1, Math.ceil(r.x + r.w) - x), h: Math.max(1, Math.ceil(r.y + r.h) - y) };
}

/** src/content/capture.ts lines 158-166 (innerBox): the user's box inside the crop, in crop pixels. */
function computeInnerBox(box: Rect, px: Rect, scale: number, outW: number, outH: number): UserBox {
  const clip = (v: number, hi: number) => Math.max(0, Math.min(v, hi));
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const x0 = clip((box.x - px.x) * scale, outW);
  const y0 = clip((box.y - px.y) * scale, outH);
  const x1 = clip((box.x + box.w - px.x) * scale, outW);
  const y1 = clip((box.y + box.h - px.y) * scale, outH);
  return { x: r3(x0), y: r3(y0), w: r3(x1 - x0), h: r3(y1 - y0) };
}

export interface CropBuild {
  cropImg: RGBAImage;
  box: Rect;
  region: Rect;
  px: Rect;
  outW: number;
  outH: number;
  /** The user's box inside cropImg, in cropImg pixels (CropPayload.inner). */
  inner: UserBox;
}

/** Same crop cropSelection's screenshot branch produces: 4% margin around `box`. */
export function buildCrop(image: RGBAImage, box: Rect): CropBuild {
  const region = expandRect(box, CROP_MARGIN, { x: 0, y: 0, w: image.width, h: image.height });
  const px = toCropPixels(region);
  const scale = Math.min(1, MAX_CROP_SIDE / Math.max(px.w, px.h));
  const outW = Math.max(1, Math.round(px.w * scale));
  const outH = Math.max(1, Math.round(px.h * scale));
  const cropped = cropRGBA(image, px.x, px.y, px.w, px.h);
  const cropImg = outW === cropped.width && outH === cropped.height ? cropped : resizeRGBA(cropped, outW, outH);
  const inner = computeInnerBox(box, px, scale, outW, outH);
  return { cropImg, box, region, px, outW, outH, inner };
}
