import { useState } from "react";
import { Loader2, Play } from "lucide-react";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { triggerEnrich, triggerLlmEnrich } from "#/lib/api";
import type { EnrichTriggerResult, LlmEnrichmentSummary } from "./types";

/**
 * The devtools panel's pair of "run it now" buttons for the recipe currently
 * being inspected (`RecipeDebugSections.tsx`'s `LlmEnrichmentSection`), plus
 * the indicator that says which of them is the one to press.
 *
 * See `server/enrichment-queue.ts`'s `enqueueLlmEnrich` / `enqueueEnrichNow`
 * for the full reasoning; summarized here for whoever is reading this
 * component instead of that module:
 *
 * ── WHY TWO BUTTONS AND NOT ONE ─────────────────────────────────────────
 * They are two different jobs on the same queue, and the second one refuses
 * to run without the first. `llm-enrich` calls a model only when the RULES
 * pass is `status='ok'` on the same content AND at the deployed
 * `CLASSIFIER_VERSION`; bump that version and every already-classified recipe
 * fails the check at once, so the LLM button can only queue a job that logs
 * "rules pass … is missing or stale — skipped" and stops. Nothing in the app
 * re-runs the rules pass on its own — it fires on a content change or not at
 * all — so until the rules button existed, the panel could diagnose that
 * state but not leave it, and the fix was to go run the pipeline's backfill
 * CLI across the whole corpus to unstick one recipe.
 *
 * The rules button is therefore the "and everything after it" button:
 * `runEnrich` forwards its own `force` into the `llm-enrich` it hands off to
 * on success, so one click runs the rules pass and then the model. The LLM
 * button stays for the narrower, and much more common, case of iterating on
 * the model's answer against a rules pass that is already current — no reason
 * to re-run the lexicon to ask the model again.
 *
 * ── WHY BOTH ALWAYS FORCE A RE-RUN ──────────────────────────────────────
 * The automatic `enrich → llm-enrich` handoff enqueues WITHOUT `force`, so it
 * short-circuits to `{status:"unchanged"}` when the stored labels already
 * cover this content — right for a job that fires on every save, wrong for a
 * button captioned "run it now". Both triggers send `force: true`, so a click
 * always produces a real run rather than a job that immediately no-ops.
 *
 * ── WHY A REPEAT CLICK DOESN'T SILENTLY DO NOTHING ──────────────────────
 * Both jobs' BullMQ ids are deterministic per recipe, which is what makes
 * automatic triggers collapse into one job instead of racing — the right
 * behaviour for a write path, wrong for a button whose entire point is "run
 * it AGAIN". `enqueueManualRun` resolves that server-side (joins a job still
 * running, removes a finished one before re-adding); these components just
 * render whichever outcome came back, honestly, rather than always claiming
 * "queued".
 *
 * ── ACCESSIBILITY ────────────────────────────────────────────────────────
 * Real `<button>`s (the design system's `Button`) whose accessible name IS
 * their visible text — no `aria-label` override to keep in sync as the label
 * changes between idle/pending, and "label in name" (WCAG 2.5.3) is satisfied
 * for free. What clicking one does lives in the static caption beside it, not
 * stuffed into the name. Each button's result copy lives in its OWN
 * `role="status"`/`aria-live="polite"` region — one per button rather than a
 * shared region, so a screen reader hears the outcome of the run that was
 * actually clicked instead of the two overwriting each other — updated
 * whether the outcome is a success, a no-op, or an error, and never left
 * unspoken (repo a11y rule: AGENTS.md → `accessibility-compliance`).
 */
export function EnrichRunButtons({ recipeId, summary }: { recipeId: string; summary: LlmEnrichmentSummary | null }) {
  return (
    <div className="flex flex-col gap-2 border-t-2 border-border/60 pt-2">
      <RulesPassIndicator summary={summary} />
      <RunButton
        label="Run rules + LLM enrichment"
        pendingLabel="Queuing…"
        caption="Forces a fresh rules classification, which on success hands off to a forced llm-enrich. The one to use when the rules pass below is stale or missing."
        run={() => triggerEnrich(recipeId)}
      />
      <RunButton
        label="Run LLM enrichment only"
        pendingLabel="Queuing…"
        caption="Forces a fresh llm-enrich run for this recipe, even if the last one is already current. Needs a current rules pass — it comes back skipped without one."
        run={() => triggerLlmEnrich(recipeId)}
      />
    </div>
  );
}

/**
 * Has the rules pass actually been done for this recipe, and does it still
 * count?
 *
 * Three states worth telling apart, and the reason this is not just a boolean:
 * "never ran" and "ran, at a classifier version that is no longer deployed"
 * both leave `llm-enrich` refusing to call a model, but only the second one
 * means there are existing rules labels on screen above that a reader might
 * otherwise trust as current. `rulesEnrichedAt` is what separates them (see
 * its doc in `types.ts`).
 *
 * The section header already carries a warning badge for the stale case,
 * phrased as its CONSEQUENCE ("a run will likely come back skipped") for
 * someone scanning status. This one is phrased as the FACT, next to the
 * button that changes it, for someone who has stopped scanning and is
 * deciding what to press.
 */
function RulesPassIndicator({ summary }: { summary: LlmEnrichmentSummary | null }) {
  if (summary === null) {
    return (
      <Badge size="xs" variant="outline" className="self-start border-warning bg-warning/15 text-warning">
        rules pass: never run — no recipe_enrichment row exists
      </Badge>
    );
  }

  const doneAt = summary.rulesStatus === "ok" ? summary.rulesEnrichedAt : null;
  if (doneAt !== null && summary.rulesVersionCurrent) {
    return (
      <Badge size="xs" variant="secondary" className="self-start">
        rules pass: done at v{summary.classifierVersion} (current), {new Date(doneAt).toLocaleString()}
      </Badge>
    );
  }

  return (
    <Badge size="xs" variant="outline" className="self-start border-warning bg-warning/15 text-warning">
      {doneAt !== null
        ? `rules pass: done at v${summary.classifierVersion}, which is no longer the deployed classifier — re-run it`
        : `rules pass: not done — status is "${summary.rulesStatus}"`}
    </Badge>
  );
}

/**
 * One button and the `role="status"` region that reports what it did. Both
 * triggers behave identically once clicked — same outcome type, same
 * never-throws server contract, same three visual states — so they differ
 * only in their copy and which transport call they make.
 */
function RunButton({ label, pendingLabel, caption, run }: { label: string; pendingLabel: string; caption: string; run: () => Promise<EnrichTriggerResult> }) {
  const [state, setState] = useState<{ kind: "idle" } | { kind: "pending" } | { kind: "done"; result: EnrichTriggerResult }>({ kind: "idle" });

  async function onClick() {
    setState({ kind: "pending" });
    try {
      setState({ kind: "done", result: await run() });
    } catch (error: unknown) {
      // The server fn itself never throws for a queueing failure — see
      // enqueueManualRun's doc — but the RPC call to it can still reject
      // (network drop, the double dev-gate refusing outright in a
      // misconfigured environment). Reported the same honest way either way.
      setState({ kind: "done", result: { status: "error", message: error instanceof Error ? error.message : "The request itself failed." } });
    }
  }

  const pending = state.kind === "pending";

  return (
    <div className="flex flex-col gap-1.5">
      <p className="m-0 text-[0.6875rem] text-muted-foreground">{caption}</p>
      <Button type="button" size="sm" variant="outline" onClick={onClick} disabled={pending} className="self-start">
        {pending ? <Loader2 data-icon="inline-start" aria-hidden="true" className="animate-spin" /> : <Play data-icon="inline-start" aria-hidden="true" />}
        {pending ? pendingLabel : label}
      </Button>
      <p role="status" aria-live="polite" className="m-0 min-h-4 text-[0.6875rem] text-muted-foreground">
        {pending ? pendingLabel : state.kind === "done" ? describeResult(state.result) : null}
      </p>
    </div>
  );
}

function describeResult(result: EnrichTriggerResult): React.ReactNode {
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
