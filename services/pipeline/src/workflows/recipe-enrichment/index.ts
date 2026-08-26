import { ENRICH_STEP, RECIPE_ENRICHMENT_QUEUE } from "@buttery/pipeline-contract";
import { defineWorkflow } from "#/workflows/define.ts";
import { closeDb } from "#/workflows/recipe-enrichment/lib/db.ts";
import { shutdown as shutdownPosthog } from "#/workflows/recipe-enrichment/llm/posthog.ts";
import { steps } from "#/workflows/recipe-enrichment/steps.ts";

/**
 * Derive per-recipe facts (allergens, diet compatibility, and a nutrition
 * seam) that neither the atproto network nor local authoring can be trusted
 * to supply — see `docs/plans/2026-08-20-recipe-enrichment.md` §1. Purely a
 * Buttery-internal enhancement: nothing this workflow computes is ever
 * written back into an `exchange.recipe.recipe` record or published to a PDS.
 *
 * The graph is six steps — see `steps.ts`. Two providers, one queue:
 *
 *     enrich ──enqueues──▶ llm-enrich            one recipe — the entry step
 *     backfill     ──fans out──▶ enrich × N     ──▶ backfill-report
 *     llm-backfill ──fans out──▶ llm-enrich × N ──▶ llm-backfill-report
 *
 * `llm-enrich` is the second label provider (`docs/plans/2026-08-26-llm-recipe-
 * enrichment.md`): after a successful rules write, it asks a model to read the
 * lines the lexicon missed and to judge the dimensions no rule covers. It is a
 * STEP rather than another entry in `classifiers/index.ts` because that array's
 * contract is pure and synchronous (L3), and a step is what gives the model call
 * its own retry boundary. It is flag-gated and FAIL-CLOSED: no PostHog, or the
 * flag not explicitly true, means the step marks the recipe `skipped` and calls
 * nothing (L4). The two providers own disjoint label rows in one table, split by
 * the `method` column's prefix (`rules@N` vs `llm:%`, L9).
 *
 * `enrich` is triggered from two places outside this workflow entirely: the
 * web app's write path, and `atproto-sync`'s `sync-repo` step (via
 * `ctx.enqueue`, D13 — a cross-workflow handoff that deliberately does not
 * become a flow child of the sweep, so a corpus-wide enrichment can never hold
 * the sweep's lock). `backfill` is how a stale or newly-classifier-version'd
 * corpus gets caught up — a deliberate, manually-triggered act (D15): there is
 * no `schedule` here and no boot-time re-enqueue. A `CLASSIFIER_VERSION` bump
 * rides a deploy; reprocessing the corpus is a decision someone makes with
 * `POST /jobs/recipe-enrichment {"name":"backfill"}` (plan §7.2), not
 * something that happens to every recipe the moment a deploy lands.
 *
 * Everything this workflow needs is in this folder:
 *
 *   steps.ts       the six steps and the graph between them
 *   types.ts       the job payloads and what a classifier reads/writes — the
 *                  contract `steps.ts` and `classify.ts` agree on without
 *                  importing each other to find out
 *   classify.ts    the classifier array — pure, tested (plan §8)
 *   classifiers/   `allergen.ts`, `diet.ts` and friends
 *   lib/db.ts      this workflow's own lazy pg pool + `closeDb`
 *   lib/load.ts    recipe loading, ingredient parse/match, the write
 *                  transactions (rules AND llm, method-scoped), and both
 *                  backfill claim queries — deliberately independent of
 *                  `classify.ts` (see that file's doc)
 *   llm/           the second provider. `prompt.ts` is THE PROMPT, `merge.ts`
 *                  is THE POLICY — a human changing either opens exactly one
 *                  obvious file, which is the whole point of the folder.
 */
export const recipeEnrichment = defineWorkflow({
  name: RECIPE_ENRICHMENT_QUEUE,
  description: "Derive allergen and diet labels for a recipe's ingredients",
  entry: ENRICH_STEP,
  steps,

  // Every job on this queue falls back to this when nothing more specific
  // applies. It is load-bearing in a way the plan does not spell out, so here
  // is why: `server.ts`'s `POST /jobs/:queue` calls `queue.add(body.name ??
  // workflow.entry, body.data ?? {})` with NO third argument — a job posted
  // by hand or from the Bull Board's "add job" panel gets none of its own
  // step's `jobOptions`, only whatever the QUEUE itself defaults to. Without
  // this, the `backfill` job plan §7.2 tells an operator to `POST` by hand
  // would be retained by BullMQ forever — every backfill run, every board
  // click, sitting in Redis indefinitely. This is that workflow's own
  // insurance against that gap; it is not a defect fixed here, `server.ts`'s
  // missing third argument is a separate, already-recorded issue for the
  // coordinator, not something this workflow's definition can or should paper
  // over by itself.
  defaultJobOptions: {
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 200 },
  },

  // How many recipes this workflow may have in flight at once, across every
  // replica. `backfill` fans an entire claimed batch out in one call and lets
  // the queue hold it; this is what decides how many of those actually run
  // concurrently, and it is the only limit that survives the autoscaler
  // changing the replica count underneath it (AGENTS.md: "no throttle
  // producer, fan out everything, queue is the buffer"). Sixteen concurrent
  // recipes is a polite number of lexicon lookups and one-row transactions to
  // run against the shared dev/prod database from one workflow; raise it in
  // the environment once a backfill's wall-clock starts to matter more than
  // that politeness does.
  globalConcurrency: () => Number(process.env.RECIPE_ENRICHMENT_MAX_IN_FLIGHT || 16) || undefined,

  // This workflow opens its own pg pool on first use and reuses it across
  // jobs. Ending it on drain is what lets a scaled-down replica's process
  // actually exit — an open pool keeps the event loop alive.
  //
  // The posthog-node client is the second thing that does, and it has a second
  // reason to be closed properly: `$ai_generation` capture is fire-and-forget,
  // so a replica that exits without flushing loses the observability for
  // whatever it was working on last. Both run, and a failure in either must not
  // stop the other — a draining replica has to exit either way.
  close: async () => {
    await Promise.allSettled([closeDb(), shutdownPosthog()]);
  },
});
