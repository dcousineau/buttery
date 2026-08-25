import { useEffect, useState } from "react";
import { AlertTriangle, FlaskConical } from "lucide-react";
import { getRecipeEnrichmentDebug, type RecipeEnrichmentLabelView, type RecipeEnrichmentView } from "#/lib/api";
import { Badge } from "#/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Spinner } from "#/components/ui/spinner";
import { cn } from "#/lib/utils";

/**
 * Dev-only diagnostic panel for the recipe-enrichment pipeline
 * (recipe-enrichment plan §10). Shows the `recipe_enrichment` row and its
 * labels, grouped by dimension, with per-label confidence/method/evidence —
 * exactly what `getRecipeEnrichment` returns, undecorated.
 *
 * ── THE DEV GATE (D16) ──────────────────────────────────────────────────
 * This component assumes it is already behind `import.meta.env.DEV` at the
 * call site — it renders unconditionally once mounted. The gate that
 * actually matters is server-side: `getRecipeEnrichmentDebug`
 * (`#/server/recipe-enrichment.ts`) re-checks `NODE_ENV` on the server and
 * refuses in production no matter what reaches it, so mounting this
 * component without the client check would fail loud (an error state), not
 * leak data.
 *
 * ── `not_detected` IS NOT "FREE OF" (§3.2) ─────────────────────────────
 * An allergen label's `not_detected` verdict is called out with its own
 * caption below, every time it renders — it must never read as a safety
 * claim.
 *
 * ── EVIDENCE, GENERICALLY (§8.3) ────────────────────────────────────────
 * `evidence` is per-classifier JSON with no shape this module can assume
 * beyond "an array or an object of facts that fired". `evidenceLines` below
 * renders whatever is there as short readable lines instead of a raw
 * `JSON.stringify` blob — that is what makes a wrong verdict diagnosable
 * ("not vegetarian *because line 7 is fish sauce*") instead of mysterious.
 *
 * Looks like a diagnostic on purpose (dashed border, monospace-leaning
 * labels) — this is dev tooling, not a product surface.
 */
type FetchState = { recipeId: string; kind: "error"; message: string } | { recipeId: string; kind: "ready"; data: RecipeEnrichmentView | null };

export function EnrichmentDebugPanel({ recipeId }: { recipeId: string }) {
  // No synchronous `setState` inside the effect (react/set-state-in-effect):
  // "loading" is derived at render time by comparing `state.recipeId` to the
  // CURRENT `recipeId` prop, rather than reset imperatively when the effect
  // starts. `state` only ever holds the outcome of the most recently
  // COMPLETED fetch, so a still-loading recipe (first mount, or a recipeId
  // that just changed) simply has no matching state yet.
  const [state, setState] = useState<FetchState | null>(null);

  useEffect(() => {
    let cancelled = false;
    getRecipeEnrichmentDebug(recipeId)
      .then((data) => {
        if (!cancelled) setState({ recipeId, kind: "ready", data });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ recipeId, kind: "error", message: error instanceof Error ? error.message : "Failed to load enrichment." });
      });
    return () => {
      cancelled = true;
    };
  }, [recipeId]);

  const current = state?.recipeId === recipeId ? state : null;

  return (
    <Card size="sm" className="border-dashed border-muted-foreground/50 bg-muted/20 shadow-none" aria-label="Enrichment diagnostics (development only)">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-[0.6875rem] font-bold tracking-wide text-muted-foreground uppercase">
          <FlaskConical className="size-3.5" aria-hidden="true" />
          Enrichment · dev only
        </CardTitle>
        <CardDescription className="text-[0.6875rem]">Derived diet/allergen facts from the pipeline. Never shown to real users.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-xs">
        {current === null && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner />
            Loading enrichment…
          </div>
        )}

        {current?.kind === "error" && (
          <Alert variant="destructive">
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>Couldn't load enrichment</AlertTitle>
            <AlertDescription>{current.message}</AlertDescription>
          </Alert>
        )}

        {current?.kind === "ready" && current.data === null && <p className="m-0 text-muted-foreground">Nothing has run for this recipe yet — no enrichment row exists.</p>}

        {current?.kind === "ready" && current.data && <EnrichmentBody data={current.data} />}
      </CardContent>
    </Card>
  );
}

function EnrichmentBody({ data }: { data: RecipeEnrichmentView }) {
  const dimensions = Object.keys(data.labels).sort();

  return (
    <div className="flex flex-col gap-3">
      <dl className="m-0 grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-1">
        <dt className="font-semibold text-muted-foreground">Status</dt>
        <dd className="m-0">
          <StatusBadge status={data.status} />
        </dd>
        <dt className="font-semibold text-muted-foreground">Classifier</dt>
        <dd className="m-0">v{data.classifierVersion}</dd>
        <dt className="font-semibold text-muted-foreground">Enriched at</dt>
        <dd className="m-0">{data.enrichedAt ? new Date(data.enrichedAt).toLocaleString() : "—"}</dd>
      </dl>

      {/* `error` is a message, not a stack (§3.1) — safe to render as-is. */}
      {data.status === "error" && data.error && (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>Last run failed</AlertTitle>
          <AlertDescription>{data.error}</AlertDescription>
        </Alert>
      )}

      {dimensions.length === 0 ? (
        <p className="m-0 text-muted-foreground">No labels recorded.</p>
      ) : (
        dimensions.map((dimension) => (
          <section key={dimension} aria-labelledby={`enrichment-dim-${dimension}`}>
            <h3 id={`enrichment-dim-${dimension}`} className="m-0 mb-1.5 text-[0.625rem] font-bold tracking-wide text-muted-foreground uppercase">
              {dimension}
            </h3>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {data.labels[dimension].map((label) => (
                <li key={label.slug}>
                  <LabelRow label={label} />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variant = status === "ok" ? "secondary" : status === "error" ? "destructive" : "outline";
  return (
    <Badge size="xs" variant={variant}>
      {status}
    </Badge>
  );
}

/** Verdict → styling. Covers both the allergen and the diet vocabularies (§3.2). */
const VERDICT_STYLE: Record<string, string> = {
  contains: "border-destructive text-destructive bg-destructive/10",
  excluded: "border-destructive text-destructive bg-destructive/10",
  may_contain: "border-warning text-warning bg-warning/15",
  likely: "border-border text-secondary-foreground bg-secondary",
  not_detected: "border-border text-muted-foreground bg-card",
  unknown: "border-border text-muted-foreground bg-muted",
};

function VerdictBadge({ verdict }: { verdict: string }) {
  return (
    <Badge size="xs" variant="outline" className={cn(VERDICT_STYLE[verdict])}>
      {verdict.replace(/_/g, " ")}
    </Badge>
  );
}

function LabelRow({ label }: { label: RecipeEnrichmentLabelView }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border-2 border-border bg-card px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span className="font-semibold text-foreground">{label.slug}</span>
        <VerdictBadge verdict={label.verdict} />
        <span className="text-muted-foreground">
          {Math.round(label.confidence * 100)}% · {label.method}
        </span>
      </div>

      {/* §3.2's single most important line, restated at the point of display:
        `not_detected` means the rules found nothing over text they may not
        have fully parsed — never "free of" or "safe". */}
      {label.verdict === "not_detected" && (
        <p className="m-0 text-[0.6875rem] text-muted-foreground italic">Not detected ≠ free of — rules found no match; the text may not have been fully parsed.</p>
      )}

      <EvidenceList evidence={label.evidence} />
    </div>
  );
}

function EvidenceList({ evidence }: { evidence: unknown }) {
  const lines = evidenceLines(evidence);
  if (!lines.length) return <p className="m-0 text-[0.6875rem] text-muted-foreground">No evidence recorded.</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 border-t border-border/50 p-0 pt-1 text-[0.6875rem] text-muted-foreground">
      {lines.map((line, i) => (
        <li key={i} className="flex gap-1">
          <span aria-hidden="true">·</span>
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Evidence is per-classifier JSON with no shape this module assumes beyond
 * "an array of facts, or one fact object" (§3.2, §8.3). Renders each array
 * entry, or each key of a bare object, as one short readable line — the point
 * is a wrong verdict stays diagnosable without reading a JSON blob.
 */
function evidenceLines(evidence: unknown): string[] {
  if (evidence == null) return [];
  if (Array.isArray(evidence)) return evidence.map(oneLine);
  return [oneLine(evidence)];
}

function oneLine(value: unknown): string {
  if (typeof value === "object" && value !== null) return objectLine(value as Record<string, unknown>);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return JSON.stringify(value) ?? "";
}

function objectLine(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .map(([key, value]) => `${key}: ${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}`)
    .join(" · ");
}
