import type { ScannerEngine } from "./engine.ts";
import type { Corners, ScannedPage } from "./types.ts";

/** Detection runs on a downscaled copy; it is edge-based and loses nothing at this size. */
export const DETECT_MAX_DIM = 640;
/** Longest edge of the flattened page. Plenty for a vision model to read cookbook print. */
export const OUTPUT_MAX_EDGE = 2000;
const JPEG_QUALITY = 0.85;

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** A copy of `source` no larger than `maxDim` on its longest side, plus the factor it was shrunk by. */
export function downscale(source: HTMLCanvasElement, maxDim: number): { canvas: HTMLCanvasElement; ratio: number } {
  const ratio = Math.min(1, maxDim / Math.max(source.width, source.height));
  const canvas = createCanvas(Math.round(source.width * ratio), Math.round(source.height * ratio));
  canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height);
  return { canvas, ratio };
}

export function scaleCorners(corners: Corners, factor: number): Corners {
  const scale = (p: { x: number; y: number }) => ({ x: p.x * factor, y: p.y * factor });
  return { topLeft: scale(corners.topLeft), topRight: scale(corners.topRight), bottomRight: scale(corners.bottomRight), bottomLeft: scale(corners.bottomLeft) };
}

export function toJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the scan."))), "image/jpeg", JPEG_QUALITY);
  });
}

/**
 * Turn one full-resolution frame into the image that would be uploaded:
 * detect the page, flatten it, encode it. With no page found, the whole frame
 * is the result — a bad crop is worse than none.
 */
export async function scanFrame(engine: ScannerEngine, frame: HTMLCanvasElement): Promise<ScannedPage> {
  const t0 = performance.now();
  const { canvas: small, ratio } = downscale(frame, DETECT_MAX_DIM);
  const detected = await engine.detect(small);
  const corners = detected ? scaleCorners(detected, 1 / ratio) : null;
  const t1 = performance.now();

  const flattened = corners ? await engine.extract(frame, corners) : null;
  const t2 = performance.now();

  // The warp's output size follows the page's size in the frame, so cap it here.
  const result = downscale(flattened ?? frame, OUTPUT_MAX_EDGE).canvas;
  const [blob, original] = await Promise.all([toJpeg(result), toJpeg(frame)]);
  const t3 = performance.now();

  return {
    blob,
    width: result.width,
    height: result.height,
    original,
    originalWidth: frame.width,
    originalHeight: frame.height,
    corners: flattened ? corners : null,
    timings: { detectMs: t1 - t0, extractMs: t2 - t1, encodeMs: t3 - t2 },
  };
}
