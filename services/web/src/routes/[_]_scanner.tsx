import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageScanner, type ScannedPage } from "#/components/scanner/page-scanner.tsx";
import { ScanDebugPanel } from "#/components/scanner/scan-debug-panel.tsx";
import { Badge } from "#/components/ui/badge.tsx";
import { seo } from "#/lib/seo";

/**
 * Test bench for the cookbook page scanner. Nothing is uploaded — the debug
 * panel shows the image that would eventually go to the model. The scanner
 * moves into the add-recipe modal once it has been tried on real books.
 */
export const Route = createFileRoute("/__scanner")({
  head: () => ({
    meta: [...seo({ title: "Page scanner · Buttery", description: "Scanner test bench." }), { name: "robots", content: "noindex" }],
  }),
  component: ScannerTestPage,
});

function ScannerTestPage() {
  const [scan, setScan] = useState<ScannedPage | null>(null);

  return (
    <div className="page-wrap pt-10 pb-8 sm:pt-14">
      <Badge variant="secondary">Test bench</Badge>
      <h1 className="display-title mt-3 mb-2 text-3xl">Page scanner</h1>
      <p className="mt-0 mb-8 max-w-prose text-muted-foreground">
        Point the camera at a cookbook page and scan it. Nothing leaves your browser — the right-hand side shows what would be sent to the model.
      </p>

      <div className="grid gap-8 lg:grid-cols-2">
        <section aria-labelledby="scanner-heading" className="min-w-0">
          <h2 id="scanner-heading" className="mt-0 mb-3 text-lg font-semibold">
            Scanner
          </h2>
          <PageScanner onCapture={setScan} />
        </section>
        <section aria-labelledby="debug-heading" className="min-w-0">
          <h2 id="debug-heading" className="mt-0 mb-3 text-lg font-semibold">
            What the model would see
          </h2>
          <ScanDebugPanel scan={scan} />
        </section>
      </div>
    </div>
  );
}
