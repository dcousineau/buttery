import { UnrecoverableError } from "bullmq";
import { contentFingerprint } from "@buttery/recipe-schemas/normalize";
import { BACKFILL_REPORT_STEP, BACKFILL_STEP, ENRICH_STEP, type EnrichPayload } from "@buttery/pipeline-contract";
import type { StepSpec } from "#/workflows/define.ts";
import { log } from "#/log.ts";
import { getPool } from "#/workflows/recipe-enrichment/lib/db.ts";
import {
  buildClassifierLines,
  claimBatch,
  DEFAULT_BACKFILL_LIMIT,
  describeWriteError,
  getEnrichmentState,
  loadRecipe,
  markError,
  writeEnrichment,
} from "#/workflows/recipe-enrichment/lib/load.ts";
// `classify.ts` is the classifier agent's module, built in parallel against
// `types.ts`'s `ClassifierInput` / `Label` contract — see the plan §8 and this
// folder's module doc. `lib/load.ts` deliberately does not depend on it (see
// that file's doc); this is the one place in the workflow that does, because
// `enrich` is the one step that actually has to run a classifier.
import { CLASSIFIER_VERSION, classify } from "#/workflows/recipe-enrichment/classify.ts";
import type { BackfillPayload, BackfillReportPayload } from "#/workflows/recipe-enrichment/types.ts";

/**
 * The three steps and the graph between them (plan §7):
 *
 *     enrich                                        one recipe — the entry step
 *     backfill ──fans out──▶ enrich × N ──▶ backfill-report
 *
 * `enrich` is reachable two ways: directly, from a trigger (`ctx.enqueue` from
 * `atproto-sync`'s `sync-repo`, or the web app's write path — plan §9), and as
 * a `backfill` child. `backfill` claims a bounded batch of recipes whose
 * `recipe_enrichment` row is missing, stale, or behind the current
 * `CLASSIFIER_VERSION`, and fans them out as `enrich` children under a
 * `backfill-report` parent — one atomic `flow()` call, so there is no window
 * where half the batch is submitted.
 *
 * No overlap lock (D14): unlike `atproto-sync`, this workflow has no schedule
 * to guard the next firing of, and BullMQ already refuses to run the same job
 * twice — `enrichJobId` (`@buttery/pipeline-contract`) makes two triggers for
 * one recipe collapse into one job instead of racing.
 */

// --- enrich (entry) --------------------------------------------------------

function parseEnrichPayload(payload: unknown): EnrichPayload {
  const raw = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  const recipeId = typeof raw.recipeId === "string" ? raw.recipeId : "";
  if (!recipeId) {
    // Retrying a malformed payload three times is three wasted slots — fail
    // now, the same idiom `sync-repo` uses for a job with no `did`.
    throw new UnrecoverableError("enrich job has no recipeId");
  }
  return { recipeId, force: raw.force === true };
}

/**
 * Classify one recipe. See `lib/load.ts` for steps 1-2 (load + fingerprint
 * short-circuit) and 5 (the write transaction) — this function is the
 * orchestration plan §7.1 describes, not where the SQL lives.
 */
const enrich: StepSpec = {
  name: ENRICH_STEP,
  description: "Classify one recipe's ingredients into allergen and diet labels",
  jobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  },
  run: async ({ payload, log: line }) => {
    const { recipeId, force } = parseEnrichPayload(payload);
    const pool = getPool();

    // Step 1: load. A missing recipe completes as "gone" — a deleted recipe
    // is not a failure, and jobs outlive rows.
    const recipe = await loadRecipe(pool, recipeId);
    if (!recipe) {
      await line(`recipe ${recipeId} no longer exists`);
      return { status: "gone" };
    }

    // Step 2: the fingerprint short-circuit (D10). Order-independent by
    // construction — `contentFingerprint` sorts the ingredient lines itself —
    // so re-ordering a recipe's ingredients never trips a reclassify on its own.
    const inputHash = await contentFingerprint(
      recipe.name,
      recipe.lines.map((line) => line.text),
    );
    if (!force) {
      const state = await getEnrichmentState(pool, recipeId);
      if (state && state.status === "ok" && state.classifierVersion === CLASSIFIER_VERSION && state.inputHash === inputHash) {
        return { status: "unchanged" };
      }
    }

    try {
      // Steps 3-4: parse, match against the food lexicon, classify.
      const lines = await buildClassifierLines(recipe.lines);
      const labels = classify({ recipeName: recipe.name, lines });

      // Step 5: one transaction — replace the labels, upsert the row to `ok`.
      await writeEnrichment(pool, recipeId, inputHash, CLASSIFIER_VERSION, labels);
      await line(`classified ${lines.length} lines into ${labels.length} labels`);
      return { status: "ok", labels: labels.length };
    } catch (err) {
      // Caught OUTSIDE writeEnrichment's transaction, on purpose (plan §7.1
      // step 5): a failure that writes nothing is a failure nobody can see.
      // Re-thrown after recording it, so this step still gets the retry its
      // own `attempts`/`backoff` promise — this is a checkpoint, not a catch
      // that swallows the failure the way `sync-repo`'s does for its own reasons.
      const message = describeWriteError(err);
      log.error("enrich failed", { recipeId, err: message });
      await markError(pool, recipeId, message);
      throw err;
    }
  },
};

// --- backfill ----------------------------------------------------------

function parseBackfillPayload(payload: unknown): Required<BackfillPayload> {
  const raw = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
  return {
    // `number | string`, matching `atproto-sync`'s `scopeOf`: this payload
    // arrives as hand-written JSON from `POST /jobs/recipe-enrichment` or from
    // the board's add-job panel, and `{"limit":"50"}` is as likely to be typed
    // as `{"limit":50}`. `claimBatch` floors, clamps and caps whatever it gets.
    limit: typeof raw.limit === "number" || typeof raw.limit === "string" ? Number(raw.limit) || DEFAULT_BACKFILL_LIMIT : DEFAULT_BACKFILL_LIMIT,
    force: raw.force === true,
    localOnly: raw.localOnly === true,
  };
}

/**
 * Claim a batch (see `lib/load.ts`'s `claimBatch` for the SQL and the ordering
 * it enforces) and fan it out. Reached with `POST /jobs/recipe-enrichment` and
 * `{"name":"backfill"}` — no schedule, no boot-time re-enqueue (D15):
 * reprocessing the corpus is a decision someone makes, not something a deploy
 * triggers on its own.
 */
const backfill: StepSpec = {
  name: BACKFILL_STEP,
  description: "Claim a batch of stale/outdated recipes and fan them out as enrich children",
  jobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { count: 20 },
    removeOnFail: { count: 50 },
  },
  run: async ({ payload, log: line, flow }) => {
    const { limit, force, localOnly } = parseBackfillPayload(payload);
    const pool = getPool();

    const { ids, remaining } = await claimBatch(pool, { classifierVersion: CLASSIFIER_VERSION, limit, force, localOnly });
    await line(`claimed ${ids.length} recipes${force ? " (forced)" : ""}${localOnly ? " (local only)" : ""}, ${remaining} candidates remain`);
    log.info("backfill claimed", { claimed: ids.length, remaining, force, localOnly });

    const report: BackfillReportPayload = { claimed: ids.length, remaining, force, localOnly };
    // One atomic flow call: N `enrich` children, plus the report job that
    // waits on all of them. Works fine with zero children — an empty batch
    // still gets a report, so "nothing to do" is visible on the board too.
    await flow({
      step: BACKFILL_REPORT_STEP,
      data: report,
      children: ids.map((recipeId) => ({ step: ENRICH_STEP, data: { recipeId, force } satisfies EnrichPayload })),
    });

    return report;
  },
};

// --- backfill-report ---------------------------------------------------

/** Fold what the claimed batch's `enrich` children returned, and log it. */
const backfillReport: StepSpec = {
  name: BACKFILL_REPORT_STEP,
  description: "Fold a backfill run's children and log how many candidates remain",
  jobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  },
  run: async ({ payload, children, log: line }) => {
    const input = payload as BackfillReportPayload;
    const results = await children();

    const counts = { ok: 0, unchanged: 0, gone: 0, other: 0 };
    for (const value of results.values) {
      const status = value && typeof value === "object" && "status" in value ? String((value as { status?: unknown }).status) : "other";
      if (status === "ok" || status === "unchanged" || status === "gone") counts[status] += 1;
      else counts.other += 1;
    }

    const summary = {
      claimed: input.claimed,
      remaining: input.remaining,
      force: input.force,
      localOnly: input.localOnly,
      succeeded: results.values.length,
      failed: results.failures.length,
      ...counts,
    };
    await line(`backfill complete: ${JSON.stringify(summary)}`);
    log.info("backfill complete", summary);
    return summary;
  },
};

export const steps: readonly StepSpec[] = [enrich, backfill, backfillReport];
