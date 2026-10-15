export interface Point {
  x: number;
  y: number;
}

/** Page corners in pixel coordinates of the image they were detected on. */
export interface Corners {
  topLeft: Point;
  topRight: Point;
  bottomRight: Point;
  bottomLeft: Point;
}

/** What a capture hands to the caller — `blob` is what would be sent to the LLM. */
export interface ScannedPage {
  /** Perspective-corrected, cropped page (JPEG). Falls back to the full frame when no page was found. */
  blob: Blob;
  width: number;
  height: number;
  /** The uncropped camera frame, kept for debugging detection. */
  original: Blob;
  originalWidth: number;
  originalHeight: number;
  /** Corners in `original` pixel coordinates; null when no page was found. */
  corners: Corners | null;
  timings: { detectMs: number; extractMs: number; encodeMs: number };
}
