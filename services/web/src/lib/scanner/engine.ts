import type { Corners } from "./types.ts";

/**
 * The scanner engine: scanic's edge detector (Rust compiled to wasm, inlined
 * in the package) plus its perspective warp.
 *
 * Nothing heavy is imported at module scope. `loadScannerEngine()` pulls scanic
 * in with a dynamic `import()` the first time it is called, so this file is
 * cheap to include anywhere and the engine never lands in the main bundle.
 */

export interface ScannerEngine {
  /** Find the page in `source`, or null when nothing page-shaped is there. */
  detect(source: HTMLCanvasElement): Promise<Corners | null>;
  /** Flatten the page quadrilateral into an upright rectangle, or null if the warp failed. */
  extract(source: HTMLCanvasElement, corners: Corners): Promise<HTMLCanvasElement | null>;
}

/** A detected quad smaller than this share of the frame is noise, not a page. */
const MIN_PAGE_AREA_RATIO = 0.15;

/**
 * The neural corner detector: more robust than scanic's edge-based default on
 * cluttered tables, low contrast and steep angles. Its ~2MB model and runtime
 * wasm come from scanic's CDN (jsDelivr) on first use; set `ml.assetBaseUrl` to
 * serve the `scanic-ml` package from our own origin instead.
 */
const DETECTOR_OPTIONS = { detector: "ml" } as const;

/** Long enough for ~2MB of model and wasm on a slow phone connection, short enough that a stall surfaces as an error. */
const LOAD_TIMEOUT_MS = 45_000;

let enginePromise: Promise<ScannerEngine> | null = null;

export function loadScannerEngine(): Promise<ScannerEngine> {
  // A failed load must be retryable, so only a successful promise is kept.
  enginePromise ??= createEngine().catch((error: unknown) => {
    enginePromise = null;
    throw error;
  });
  return enginePromise;
}

async function createEngine(): Promise<ScannerEngine> {
  const { Scanner, extractDocument } = await withTimeout(import("scanic"));
  const scanner = new Scanner(DETECTOR_OPTIONS);
  // Fetches and compiles the model and wasm now, so the first live frame is not the one that pays for it.
  await withTimeout(scanner.initialize());

  return {
    async detect(source) {
      const result = await scanner.scan(source, { ...DETECTOR_OPTIONS, mode: "detect" });
      if (!result.success || !result.corners) return null;
      return quadArea(result.corners) / (source.width * source.height) >= MIN_PAGE_AREA_RATIO ? result.corners : null;
    },

    async extract(source, corners) {
      const result = await extractDocument(source, corners, { output: "canvas" });
      return result.success && result.output instanceof HTMLCanvasElement ? result.output : null;
    },
  };
}

/** A stalled download or wasm start must fail visibly, not spin forever. */
function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("The page detector took too long to load.")), LOAD_TIMEOUT_MS);
    work.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("The page detector failed to load."));
      },
    );
  });
}

/** Shoelace formula over the quad in TL → TR → BR → BL order. */
function quadArea({ topLeft, topRight, bottomRight, bottomLeft }: Corners): number {
  const ring = [topLeft, topRight, bottomRight, bottomLeft];
  let twice = 0;
  for (const [i, p] of ring.entries()) {
    const next = ring[(i + 1) % ring.length];
    twice += p.x * next.y - next.x * p.y;
  }
  return Math.abs(twice) / 2;
}
