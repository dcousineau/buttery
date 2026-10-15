import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { Badge } from "#/components/ui/badge.tsx";
import { buttonVariants } from "#/components/ui/button.tsx";
import type { ScannedPage } from "#/lib/scanner/types.ts";

function useObjectUrl(blob: Blob | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return;
    const next = URL.createObjectURL(blob);
    // An object URL is a browser resource that must be revoked, so it is owned by this effect.
    // oxlint-disable-next-line react/set-state-in-effect
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return blob ? url : null;
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;
const ms = (n: number) => `${Math.round(n)} ms`;

/** What a capture would look like on the way to the LLM, plus the numbers behind it. */
export function ScanDebugPanel({ scan }: { scan: ScannedPage | null }) {
  const scanUrl = useObjectUrl(scan?.blob);
  const originalUrl = useObjectUrl(scan?.original);

  if (!scan) {
    return (
      <div className="flex aspect-3/4 w-full items-center justify-center rounded-xl border-2 border-dashed border-border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
        Scan a page and the image that would be sent to the model shows up here.
      </div>
    );
  }

  const rows: [string, string][] = [
    ["Upload image", `${scan.width} × ${scan.height} · ${scan.blob.type} · ${kb(scan.blob.size)}`],
    ["Camera frame", `${scan.originalWidth} × ${scan.originalHeight} · ${kb(scan.original.size)}`],
    ["Page detected", scan.corners ? "yes — cropped and flattened" : "no — whole frame used"],
    ["Detect", ms(scan.timings.detectMs)],
    ["Flatten", ms(scan.timings.extractMs)],
    ["Encode", ms(scan.timings.encodeMs)],
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Badge variant={scan.corners ? "default" : "outline"}>{scan.corners ? "Page found" : "No page found"}</Badge>
        {scanUrl && (
          <a href={scanUrl} download="scan.jpg" className={buttonVariants({ variant: "outline", size: "sm" })}>
            <Download aria-hidden="true" data-icon="inline-start" />
            Download
          </a>
        )}
      </div>

      {scanUrl && <img src={scanUrl} alt="The scanned page as it would be sent to the model" className="w-full rounded-xl border-2 border-border bg-muted shadow-pop-md" />}

      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="m-0 text-foreground">{value}</dd>
          </div>
        ))}
      </dl>

      {scan.corners && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Corner points</summary>
          <pre className="mt-2 overflow-x-auto rounded-lg border-2 border-border bg-muted p-3 text-xs">{JSON.stringify(scan.corners, null, 2)}</pre>
        </details>
      )}

      {originalUrl && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Original camera frame</summary>
          <img src={originalUrl} alt="The uncropped camera frame this scan came from" className="mt-2 w-full rounded-lg border-2 border-border" />
        </details>
      )}
    </div>
  );
}
