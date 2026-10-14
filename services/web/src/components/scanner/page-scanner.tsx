import { lazy, Suspense } from "react";
import { ClientOnly } from "@tanstack/react-router";
import type { ScannedPage } from "#/lib/scanner/types.ts";
import { ScannerPlaceholder } from "./scanner-placeholder.tsx";

export type { ScannedPage } from "#/lib/scanner/types.ts";

export interface PageScannerProps {
  /** Called with each capture. The scan never leaves the browser on its own. */
  onCapture: (scan: ScannedPage) => void;
  className?: string;
}

/**
 * The implementation pulls in the camera code and, through it, scanic and its
 * wasm. `lazy()` keeps all of that out of whichever bundle imports this
 * wrapper — it becomes its own chunk, fetched only once the scanner is shown.
 */
const PageScannerImpl = lazy(() => import("./page-scanner-impl.tsx"));

/**
 * Camera page scanner. Safe to drop anywhere: this wrapper is all that ships
 * with the host page.
 *
 * - Never rendered on the server. `ClientOnly` renders `fallback` for SSR *and*
 *   the first client render, so the hydrated markup matches and there is no
 *   mismatch; the real scanner mounts right after.
 * - Its code downloads on demand, behind `Suspense`, with the same placeholder
 *   box so the layout holds still.
 */
export function PageScanner({ onCapture, className }: PageScannerProps) {
  return (
    <ClientOnly fallback={<ScannerPlaceholder label="Getting the scanner ready…" className={className} />}>
      <Suspense fallback={<ScannerPlaceholder label="Loading the scanner…" className={className} />}>
        <PageScannerImpl onCapture={onCapture} className={className} />
      </Suspense>
    </ClientOnly>
  );
}
