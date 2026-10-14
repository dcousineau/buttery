import { useEffect, useRef, useState } from "react";
import { Camera, CameraOff, ImageUp, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { loadScannerEngine, type ScannerEngine } from "#/lib/scanner/engine.ts";
import { createCanvas, DETECT_MAX_DIM, scaleCorners, scanFrame } from "#/lib/scanner/scan.ts";
import type { Corners, ScannedPage } from "#/lib/scanner/types.ts";
import { cn } from "#/lib/utils.ts";

/** Live detection cadence. Detection is the expensive part; 5-6 fps tracks a hand-held page fine. */
const DETECT_INTERVAL_MS = 180;

type EngineState = { status: "loading" } | { status: "ready"; engine: ScannerEngine } | { status: "error"; message: string };
type CameraState = "starting" | "live" | "denied" | "unavailable";

interface Props {
  onCapture: (scan: ScannedPage) => void;
  className?: string;
}

/** Default export so `lazy()` can load it. See `page-scanner.tsx`. */
export default function PageScannerImpl({ onCapture, className }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [engineState, setEngineState] = useState<EngineState>({ status: "loading" });
  const [camera, setCamera] = useState<CameraState>("starting");
  const [corners, setCorners] = useState<Corners | null>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);

  const engine = engineState.status === "ready" ? engineState.engine : null;

  useEffect(() => {
    let cancelled = false;
    loadScannerEngine().then(
      (loaded) => {
        if (!cancelled) setEngineState({ status: "ready", engine: loaded });
      },
      (error: unknown) => {
        if (!cancelled) setEngineState({ status: "error", message: error instanceof Error ? error.message : "The page detector failed to load." });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const [cameraAttempt, setCameraAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    void openCamera().then(async (result) => {
      if (typeof result === "string") {
        if (!cancelled) setCamera(result);
        return;
      }
      const opened = result;
      const video = videoRef.current;
      if (!video) return;
      if (cancelled) {
        for (const track of opened.getTracks()) track.stop();
        return;
      }
      stream = opened;
      video.srcObject = opened;
      try {
        await video.play();
      } catch {
        // Autoplay can be interrupted by a quick unmount; nothing to recover.
      }
      if (!cancelled) setCamera("live");
    });
    return () => {
      cancelled = true;
      if (stream) for (const track of stream.getTracks()) track.stop();
    };
    // `cameraAttempt` is a retry trigger, not a value the effect reads.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [cameraAttempt]);

  // Live outline: detect on a small copy of the current frame, a few times a second.
  useEffect(() => {
    if (!engine || camera !== "live") return;
    const video = videoRef.current;
    if (!video) return;
    const scratch = createCanvas(1, 1);
    let cancelled = false;
    // Detection is async now; skip a tick rather than queue frames behind a slow one.
    let busy = false;
    const tick = async () => {
      if (busy || video.readyState < 2 || !video.videoWidth) return;
      setFrameSize((prev) => (prev?.width === video.videoWidth && prev.height === video.videoHeight ? prev : { width: video.videoWidth, height: video.videoHeight }));
      const ratio = Math.min(1, DETECT_MAX_DIM / Math.max(video.videoWidth, video.videoHeight));
      scratch.width = Math.round(video.videoWidth * ratio);
      scratch.height = Math.round(video.videoHeight * ratio);
      scratch.getContext("2d")?.drawImage(video, 0, 0, scratch.width, scratch.height);
      busy = true;
      try {
        const found = await engine.detect(scratch);
        if (!cancelled) setCorners(found ? scaleCorners(found, 1 / ratio) : null);
      } catch {
        if (!cancelled) setCorners(null);
      } finally {
        busy = false;
      }
    };
    const id = window.setInterval(() => void tick(), DETECT_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [engine, camera]);

  async function runScan(frame: HTMLCanvasElement) {
    if (!engine) return;
    setCapturing(true);
    setCaptureError(null);
    try {
      onCapture(await scanFrame(engine, frame));
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : "That scan didn't work. Try again.");
    } finally {
      setCapturing(false);
    }
  }

  async function captureFromCamera() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const frame = createCanvas(video.videoWidth, video.videoHeight);
    frame.getContext("2d")?.drawImage(video, 0, 0);
    await runScan(frame);
  }

  async function captureFromFile(file: File) {
    try {
      const bitmap = await createImageBitmap(file);
      // Phone photos are huge; the output is capped at OUTPUT_MAX_EDGE anyway.
      const frame = createCanvas(bitmap.width, bitmap.height);
      frame.getContext("2d")?.drawImage(bitmap, 0, 0);
      bitmap.close();
      await runScan(frame);
    } catch {
      setCaptureError("That file couldn't be read as an image.");
    }
  }

  const ready = engine !== null && camera === "live";
  const status = engineState.status === "loading" ? "Warming up the page detector…" : camera !== "live" ? "" : corners ? "Page found" : "Looking for a page…";

  return (
    <div data-slot="page-scanner" className={cn("flex w-full flex-col gap-3", className)}>
      <div className="relative aspect-3/4 w-full overflow-hidden rounded-xl border-2 border-border bg-foreground shadow-pop-md">
        <video ref={videoRef} playsInline muted aria-label="Camera preview" className="size-full object-contain" />

        {frameSize &&
          corners && (
            // Same viewBox and fit as the video, so the outline lands on the page.
            <svg viewBox={`0 0 ${frameSize.width} ${frameSize.height}`} className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
              <polygon
                points={[corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft].map((p) => `${p.x},${p.y}`).join(" ")}
                className="fill-primary/25 stroke-primary"
                strokeWidth={Math.max(frameSize.width, frameSize.height) / 160}
                strokeLinejoin="round"
              />
            </svg>
          )}

        {camera === "starting" && <Overlay>Starting the camera…</Overlay>}
        {camera === "live" && engineState.status === "loading" && <Overlay>Warming up the page detector…</Overlay>}
        {(camera === "denied" || camera === "unavailable") && (
          <Overlay icon={<CameraOff className="size-10" aria-hidden="true" />} spinner={false}>
            {camera === "denied"
              ? "Camera access is blocked. Allow it in your browser's site settings, or upload a photo instead."
              : "No camera available here. Upload a photo instead."}
          </Overlay>
        )}
      </div>

      <p className="m-0 min-h-5 text-sm text-muted-foreground" role="status" aria-live="polite">
        {status}
      </p>

      {engineState.status === "error" && (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>The page detector didn't load</AlertTitle>
          <AlertDescription>{engineState.message}</AlertDescription>
        </Alert>
      )}
      {captureError && (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Scan failed</AlertTitle>
          <AlertDescription>{captureError}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-3">
        <Button size="lg" onClick={() => void captureFromCamera()} disabled={!ready || capturing}>
          {capturing ? <Spinner aria-hidden="true" role="presentation" /> : <Camera aria-hidden="true" data-icon="inline-start" />}
          {capturing ? "Scanning…" : "Scan page"}
        </Button>
        <Button size="lg" variant="outline" onClick={() => fileRef.current?.click()} disabled={!engine || capturing}>
          <ImageUp aria-hidden="true" data-icon="inline-start" />
          Upload a photo
        </Button>
        {(camera === "denied" || camera === "unavailable") && (
          <Button
            size="lg"
            variant="ghost"
            onClick={() => {
              setCamera("starting");
              setCameraAttempt((n) => n + 1);
            }}
          >
            Try the camera again
          </Button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="sr-only"
          tabIndex={-1}
          aria-label="Upload a photo of a page"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void captureFromFile(file);
          }}
        />
      </div>
    </div>
  );
}

/** The camera stream, or why there isn't one. */
async function openCamera(): Promise<MediaStream | "denied" | "unavailable"> {
  if (!navigator.mediaDevices?.getUserMedia) return "unavailable";
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      audio: false,
    });
  } catch (error) {
    return error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError") ? "denied" : "unavailable";
  }
}

function Overlay({ children, icon, spinner = true }: { children: React.ReactNode; icon?: React.ReactNode; spinner?: boolean }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-muted/90 p-6 text-center text-sm text-muted-foreground">
      {icon}
      <p className="m-0 flex items-center gap-2" role="status">
        {spinner && <Spinner aria-hidden="true" role="presentation" />}
        {children}
      </p>
    </div>
  );
}
