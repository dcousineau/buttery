import { useEffect, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";
import { requireActiveHousehold } from "#/lib/api";
import { submitImport } from "#/lib/api";
import { Spinner } from "#/components/ui/spinner";
import { Button } from "#/components/ui/button";
import { seo } from "#/lib/seo";

/**
 * The bookmarklet's landing tab (plan §C3). The bookmarklet opens this
 * authenticated, same-origin route as a popup and hands it the page's JSON-LD or
 * raw HTML via postMessage; we call `submitImport` (which runs the shared
 * extractor server-side and caches the parse) and land on the create form at
 * `?import=<id>` — the exact prefill-by-id mechanism Phase B already ships.
 *
 * `recipes_` (trailing underscore) keeps the `/household/recipes/import-bridge`
 * path but breaks out of the recipes master–detail layout: this is a throwaway
 * popup, not a ledger view, so it must not load or render the whole box.
 */
export const Route = createFileRoute("/household/recipes_/import-bridge")({
  // Auth gate only (redirects to /login if signed out); no data needed.
  loader: async () => requireActiveHousehold(),
  head: () => ({ meta: seo({ title: "Importing… · Buttery", description: "Bringing a recipe into Buttery." }) }),
  component: ImportBridge,
});

const READY = "buttery-import-ready";
const PAYLOAD = "buttery-import-payload";

type Payload = { url: string; jsonld?: string; html?: string };

function ImportBridge() {
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  // A payload arrives exactly once; guard against a re-post double-submitting.
  const handled = useRef(false);

  useEffect(() => {
    const opener = window.opener as Window | null;
    if (!opener) {
      // oxlint-disable-next-line react/set-state-in-effect -- terminal one-shot state (no opener == dead popup), not a render loop.
      setFailed(true);
      return;
    }

    let poll = 0;

    async function ingest(payload: Payload) {
      if (handled.current) return;
      handled.current = true;
      window.clearInterval(poll);
      try {
        const res = await submitImport(payload);
        if (res.status === "ok" || res.status === "partial") {
          void navigate({ to: "/household/recipes/new", search: { import: res.importId } });
          return;
        }
        setFailed(true);
      } catch {
        setFailed(true);
      }
    }

    function onMessage(e: MessageEvent<unknown>) {
      // Trust only the tab that opened us. Its origin is the (arbitrary) recipe
      // page, so we can't pin an origin — the opener identity is the guarantee.
      if (e.source !== opener) return;
      // Shape is asserted, never assumed: the sender is an arbitrary web page.
      const data = e.data as { type?: unknown; payload?: unknown } | null;
      if (!data || data.type !== PAYLOAD) return;
      const p = data.payload as Payload | undefined;
      if (!p || typeof p.url !== "string") return;
      void ingest(p);
    }

    window.addEventListener("message", onMessage);
    // Poll the opener with READY until it replies — the bookmarklet may still be
    // attaching its listener when we mount, so a single post can be missed.
    poll = window.setInterval(() => opener.postMessage({ type: READY }, "*"), 250);
    opener.postMessage({ type: READY }, "*");
    // Give up if nothing arrives (opener closed, bookmarklet stale, etc.).
    const giveUp = window.setTimeout(() => {
      if (!handled.current) {
        window.clearInterval(poll);
        setFailed(true);
      }
    }, 15_000);

    return () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(poll);
      window.clearTimeout(giveUp);
    };
  }, [navigate]);

  return (
    <div className="grid min-h-svh place-content-center bg-background px-6 text-center">
      {failed ? (
        <div className="flex max-w-sm flex-col items-center gap-3">
          <span className="grid size-10 place-content-center rounded-md border-2 border-border bg-background text-destructive">
            <CircleAlert className="size-5" aria-hidden="true" />
          </span>
          <h1 className="m-0 text-lg font-bold text-foreground">That import didn't come through</h1>
          <p className="m-0 text-sm text-muted-foreground">
            Close this tab and click Save to Buttery again on the recipe page. If it keeps failing, the page may not have a recipe Buttery can read.
          </p>
          <Button onClick={() => window.close()}>Close this tab</Button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <Spinner className="size-7" />
          <h1 className="m-0 text-lg font-bold text-foreground">Bringing your recipe into Buttery…</h1>
          <p className="m-0 text-sm text-muted-foreground">Keep this tab open for a moment.</p>
        </div>
      )}
    </div>
  );
}
