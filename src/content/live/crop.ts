// Live: boxes and crops in the video's native pixels, so tracking, zones and crops don't move when the page scrolls.
import type { GrabFrameReply, DetectedCardBox } from '../../shared/messages';
import type { CropPayload } from '../../shared/types';
import { CROP_MARGIN, MAX_CROP_SIDE, cropFrame, cutCrop, defaultCanvas, toPixels, type CanvasFactory, type VideoFrameGrab } from '../capture';
import { expandRect } from '../geometry';

/**
 * The detector's boxes (pixels of the encoded `frame`) in the video's native pixels: the inverse of encodeFrame,
 * frame px -> viewport CSS px through `frame.box`, then viewport -> native through the picture's box. Sizes scale
 * as the picture does (uniformly: the frame keeps the picture's aspect).
 */
export function toNativeBoxes(grab: VideoFrameGrab, frame: NonNullable<GrabFrameReply['frame']>, boxes: DetectedCardBox[]): DetectedCardBox[] {
  const fx = frame.box.w / frame.width;
  const fy = frame.box.h / frame.height;
  const b = grab.contentBox;
  const kx = grab.videoWidth / b.w;
  const ky = grab.videoHeight / b.h;
  const pt = ([x, y]: [number, number]): [number, number] => [(frame.box.x + x * fx - b.x) * kx, (frame.box.y + y * fy - b.y) * ky];
  const size = fx * kx;
  return boxes.map((box) => {
    const [cx, cy] = pt([box.cx, box.cy]);
    return { ...box, cx, cy, w: box.w * size, h: box.h * size, pts: box.pts.map(pt) };
  });
}

/**
 * A rect in fractions of the whole picture (a track's box, the pointer) in fractions of the encoded `frame`, which
 * holds only the picture's visible part: toNativeBoxes the other way round. A point is a rect of no size.
 */
export function toFrameNorm<R extends { x: number; y: number; w?: number; h?: number }>(grab: VideoFrameGrab, frame: NonNullable<GrabFrameReply['frame']>, r: R): R {
  const b = grab.contentBox;
  const f = frame.box;
  const out = { ...r, x: (b.x + r.x * b.w - f.x) / f.w, y: (b.y + r.y * b.h - f.y) / f.h };
  if (r.w !== undefined) out.w = (r.w * b.w) / f.w;
  if (r.h !== undefined) out.h = (r.h * b.h) / f.h;
  return out;
}

/**
 * Cut a card (`box`, native video px) out of the grabbed native frame for `recognize`: its bounds plus CROP_MARGIN,
 * clamped to the frame, shrunk to MAX_CROP_SIDE, as a PNG. `outline` is its 4 corners in the crop's pixels.
 */
export function liveCrop(grab: VideoFrameGrab, box: DetectedCardBox, createCanvas: CanvasFactory = defaultCanvas): CropPayload {
  if (!grab.canvas) throw new Error('The video frame could not be read');
  const xs = box.pts.map((p) => p[0]);
  const ys = box.pts.map((p) => p[1]);
  const bounds = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  const px = toPixels(expandRect(bounds, CROP_MARGIN, { x: 0, y: 0, w: grab.videoWidth, h: grab.videoHeight }));
  const { canvas, scale, outW, outH } = cutCrop(grab.canvas, px, createCanvas, MAX_CROP_SIDE);
  const { inner, inCrop } = cropFrame(px, scale, outW, outH);
  try {
    return {
      dataUrl: canvas.toDataURL('image/png'),
      width: outW,
      height: outH,
      source: 'video',
      videoHeight: grab.videoHeight,
      inner: inner(bounds),
      outline: box.pts.map((p) => inCrop(p)),
      detected: true,
    };
  } finally {
    canvas.width = canvas.height = 0; // Live crops every frame: free the pixels now, not at GC
  }
}
