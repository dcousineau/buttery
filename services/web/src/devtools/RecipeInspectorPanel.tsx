import { useEffect, useState } from "react";
import { useMatch } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { getRecipeDebug } from "#/lib/api";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Spinner } from "#/components/ui/spinner";
import { AtprotoRecordSection, CounterpartsSection, DebugSectionGroup, LlmEnrichmentSection, RecipeDebugHeader, WarningsSection } from "./RecipeDebugSections";
import { CopyButton } from "./CopyButton";
import type { RecipeDebugPayload } from "./types";

/**
 * The TanStack Devtools panel for the recipe currently being viewed
 * (see `types.ts` for the full design rationale).
 *
 * ── FINDING THE ACTIVE RECIPE ────────────────────────────────────────────
 * The devtools shell renders inside the router tree (`__root.tsx`), so router
 * hooks work here same as anywhere else. `useMatch({ from, shouldThrow:
 * false })` asks "is `/household/recipes/$id` active right now?" without
 * throwing when it isn't — no event bus needed (`@tanstack/devtools-event-
 * client` is for a *library* pushing state at the panel; here the router
 * already knows the answer, and it's one hook call away).
 *
 * ── DOUBLE GATE ───────────────────────────────────────────────────────────
 * `plugin.tsx` only ever mounts this component in dev (`import.meta.env.DEV`
 * picks the real plugin factory over the no-op one). The server fn re-checks
 * `NODE_ENV` on its own side regardless, so this component assumes nothing
 * about being safe to call in production — it just never gets the chance to.
 */
export function RecipeInspectorPanel({ theme }: { theme: "light" | "dark" }) {
  const recipeId = useMatch({
    from: "/household/recipes/$id",
    shouldThrow: false,
    select: (match) => match.params.id,
  });

  return (
    // The devtools portal target sits inside <html>, so the app's own light/
    // dark CSS variables (styles.css `:root` / `.dark`) already cascade in
    // regardless of this wrapper. Forcing `dark` here on top of that covers
    // the one case ambient inheritance can't: the devtools shell's own theme
    // setting (independent of the page's) reads dark while the page itself
    // is light. There's no matching `.light {}` override block to force the
    // opposite direction, so a dark page with the devtools shell set to
    // light stays dark here — a rarer combination, and not worth hand-
    // duplicating every token to cover.
    <div className={theme === "dark" ? "dark h-full overflow-auto bg-background p-3 text-foreground" : "h-full overflow-auto bg-background p-3 text-foreground"}>
      {recipeId ? (
        <RecipeDebugBody recipeId={recipeId} />
      ) : (
        <p className="m-0 text-sm text-muted-foreground">Open a recipe to inspect it — no `/household/recipes/$id` route is active.</p>
      )}
    </div>
  );
}

type FetchState = { recipeId: string; kind: "error"; message: string } | { recipeId: string; kind: "ready"; data: RecipeDebugPayload };

function RecipeDebugBody({ recipeId }: { recipeId: string }) {
  // Same pattern as the panel this supersedes (EnrichmentDebugPanel): no
  // synchronous setState inside the effect. `state` holds only the outcome
  // of the most recently COMPLETED fetch for the CURRENT recipeId; a recipe
  // that just changed simply has no matching state yet, so "loading" is
  // derived by comparison rather than reset imperatively.
  const [state, setState] = useState<FetchState | null>(null);

  useEffect(() => {
    let cancelled = false;
    getRecipeDebug(recipeId)
      .then((data) => {
        if (!cancelled) setState({ recipeId, kind: "ready", data });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ recipeId, kind: "error", message: error instanceof Error ? error.message : "Failed to load recipe debug data." });
      });
    return () => {
      cancelled = true;
    };
  }, [recipeId]);

  const current = state?.recipeId === recipeId ? state : null;

  if (current === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner />
        Loading…
      </div>
    );
  }

  if (current.kind === "error") {
    return (
      <Alert variant="destructive">
        <AlertTriangle aria-hidden="true" />
        <AlertTitle>Couldn't load recipe debug data</AlertTitle>
        <AlertDescription>{current.message}</AlertDescription>
      </Alert>
    );
  }

  const { data } = current;

  if (!data.found) {
    return (
      <p className="m-0 text-sm text-muted-foreground">
        No <code className="font-mono">recipe</code> row for id <code className="font-mono">{recipeId}</code> — deleted, or belongs to no household you're in.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-2">
        {data.summary && <RecipeDebugHeader summary={data.summary} action={<CopyButton value={data} label="full payload" />} />}
      </div>
      {/* The highlight: rendered first, right under the header, ahead of the
          raw atproto record — a developer reaching for this panel to check
          or trigger LLM enrichment shouldn't have to scroll past everything
          else to find it. */}
      <LlmEnrichmentSection recipeId={recipeId} summary={data.llmEnrichment} />
      <AtprotoRecordSection record={data.atprotoRecord} />
      <CounterpartsSection counterparts={data.counterparts} />
      <DebugSectionGroup title="Rendered layer" sections={data.rendered} />
      <DebugSectionGroup title="Private layers — never published" sections={data.privateLayers} />
      <WarningsSection warnings={data.warnings} />
    </div>
  );
}
