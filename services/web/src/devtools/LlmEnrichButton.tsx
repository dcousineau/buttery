import { useState } from "react";
import { Loader2, Play } from "lucide-react";
import { Button } from "#/components/ui/button";
import { triggerLlmEnrich } from "#/lib/api";
import type { LlmEnrichTriggerResult } from "./types";

/**
 * The devtools panel's "run it now" button for the LLM enrichment job on the
 * recipe currently being inspected (`RecipeDebugSections.tsx`'s
 * `LlmEnrichmentSection`). See `server/enrichment-queue.ts`'s
 * `enqueueLlmEnrich` doc for the full reasoning; summarized for whoever is
 * reading this component instead of that one:
 *
 * ── WHY THIS ALWAYS FORCES A RE-RUN ─────────────────────────────────────
 * The automatic `enrich → llm-enrich` handoff (`services/pipeline`) enqueues
 * WITHOUT `force`, so it short-circuits to `{status:"unchanged"}` when the
 * stored labels already cover this content — right for a job that fires on
 * every save, wrong for a button captioned "run it now". `enqueueLlmEnrich`
 * always sends `force: true`, so clicking this always produces a fresh model
 * call, not a job that immediately no-ops.
 *
 * ── WHY A REPEAT CLICK DOESN'T SILENTLY DO NOTHING ──────────────────────
 * `llm-enrich`'s BullMQ job id is deterministic per recipe, which is what
 * makes automatic triggers collapse into one job instead of racing — the
 * right behaviour for a write path, wrong for a button whose entire point is
 * "run it AGAIN". `enqueueLlmEnrich` resolves that server-side (joins a job
 * still running, removes a finished one before re-adding); this component
 * just renders whichever of the resulting outcomes came back, honestly,
 * rather than always claiming "queued".
 *
 * ── ACCESSIBILITY ────────────────────────────────────────────────────────
 * A real `<button>` (the design system's `Button`) whose accessible name IS
 * its visible text — no `aria-label` override to keep in sync as the label
 * changes between idle/pending, and it already satisfies "label in name"
 * (WCAG 2.5.3) for free. What clicking it does lives in the static caption
 * beside it, not stuffed into the name. The result copy lives in a
 * `role="status"`/`aria-live="polite"` region so a screen reader hears it
 * without focus having to move there, updated whether the outcome is a
 * success, a no-op, or an error — never left unspoken (repo a11y rule:
 * AGENTS.md → `accessibility-compliance`).
 */
export function LlmEnrichButton({ recipeId }: { recipeId: string }) {
  const [state, setState] = useState<{ kind: "idle" } | { kind: "pending" } | { kind: "done"; result: LlmEnrichTriggerResult }>({ kind: "idle" });

  async function onClick() {
    setState({ kind: "pending" });
    try {
      const result = await triggerLlmEnrich(recipeId);
      setState({ kind: "done", result });
    } catch (error: unknown) {
      // The server fn itself never throws for a queueing failure — see
      // enqueueLlmEnrich's doc — but the RPC call to it can still reject
      // (network drop, the double dev-gate refusing outright in a
      // misconfigured environment). Reported the same honest way either way.
      setState({ kind: "done", result: { status: "error", message: error instanceof Error ? error.message : "The request itself failed." } });
    }
  }

  const pending = state.kind === "pending";

  return (
    <div className="flex flex-col gap-1.5 border-t-2 border-border/60 pt-2">
      <p className="m-0 text-[0.6875rem] text-muted-foreground">Forces a fresh llm-enrich run for this recipe, even if the last one is already current.</p>
      <Button type="button" size="sm" variant="outline" onClick={onClick} disabled={pending} className="self-start">
        {pending ? <Loader2 data-icon="inline-start" aria-hidden="true" className="animate-spin" /> : <Play data-icon="inline-start" aria-hidden="true" />}
        {pending ? "Queuing…" : "Run LLM enrichment now"}
      </Button>
      <p role="status" aria-live="polite" className="m-0 min-h-4 text-[0.6875rem] text-muted-foreground">
        {pending ? "Queuing…" : state.kind === "done" ? describeResult(state.result) : null}
      </p>
    </div>
  );
}

function describeResult(result: LlmEnrichTriggerResult): React.ReactNode {
  switch (result.status) {
    case "disabled":
      return "Queueing is off in this environment — no REDIS_URL is set, so nothing was queued.";
    case "already-running":
      return `A run for this recipe is already "${result.state}" as job ${result.jobId} — joined it instead of starting a second one. Watch it in Bull Board.`;
    case "enqueued":
      return (
        <>
          Queued as job <code className="font-mono">{result.jobId}</code> — forces a fresh run. Watch it in the pipeline's{" "}
          {/* Hardcoded local dev address, deliberately: this whole panel is
              dev-only (double-gated — see recipe-debug.ts), and process-
              compose.yaml's own doc comment for the pipeline service names
              this exact address as where its Bull Board listens locally. */}
          <a href="http://127.0.0.1:3002/ui" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
            Bull Board
          </a>
          .
        </>
      );
    case "error":
      return `Could not queue it: ${result.message}`;
  }
}
