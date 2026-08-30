import { ENRICH_STEP, RECIPE_ENRICHMENT_QUEUE } from "@buttery/pipeline-contract";
import { defineWorkflow } from "#/workflows/define.ts";
import { closeDb } from "#/workflows/recipe-enrichment/lib/db.ts";
import { steps } from "#/workflows/recipe-enrichment/steps.ts";

/**
 * Derive per-recipe facts (allergens, diet compatibility, and a nutrition
 * seam) that neither the atproto network nor local authoring can be trusted
 * to supply — see `docs/plans/2026-08-20-recipe-enrichment.md` §1. Purely a
 * Buttery-internal enhancement: nothing this workflow computes is ever
 * written back into an `exchange.recipe.recipe` record or published to a PDS.
 *
 * The graph is three steps — see `steps.ts`:
 *
 *     enrich                                        one recipe — the entry step
 *     backfill ──fans out──▶ enrich × N ──▶ backfill-report
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
 *   steps.ts       the three steps and the graph between them
 *   types.ts       the job payloads and what a classifier reads/writes — the
 *                  contract `steps.ts` and `classify.ts` agree on without
 *                  importing each other to find out
 *   classify.ts    the classifier array — pure, tested (plan §8)
 *   classifiers/   `allergen.ts`, `diet.ts` and friends
 *   lib/db.ts      this workflow's own lazy pg pool + `closeDb`
 *   lib/load.ts    recipe loading, ingredient parse/match, the write
 *                  transaction, and the backfill claim query — deliberately
 *                  independent of `classify.ts` (see that file's doc)
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
  close: closeDb,
});
