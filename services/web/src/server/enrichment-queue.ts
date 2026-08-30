import { ENRICH_STEP, RECIPE_ENRICHMENT_QUEUE, enrichJobId, type EnrichPayload } from "@buttery/pipeline-contract";
import type { Queue } from "bullmq";

/**
 * Producer-only handoff into the `recipe-enrichment` BullMQ queue that
 * `services/pipeline` drains — the app never runs a `Worker`, it only ever
 * calls `queue.add`. See `docs/plans/2026-08-20-recipe-enrichment.md` §9 and
 * `@buttery/pipeline-contract` for the queue/step names and the job id.
 *
 * ── THE ENQUEUE IS A LATENCY OPTIMISATION, NOT THE SIGNAL OF RECORD (D3) ──
 * The row a writer marks `status='stale'` inside its own transaction is what
 * makes a recipe's enrichment eventually correct; this queue only decides how
 * soon. That is why `enqueueEnrich` below **never throws** — an unreachable
 * Redis, a bad `REDIS_URL`, a BullMQ error, none of those may ever fail a
 * recipe save. §7.2's backfill sweep is what finds anything this queue drops,
 * so a failure here only ever costs freshness. It still has to be *visible*,
 * though — an error nobody sees is as bad as one that took the save down — so
 * it is swallowed with a `console.warn`, matching how `collections.ts` logs a
 * best-effort write it refuses to let fail the caller.
 *
 * No-ops (no Redis connection is ever attempted) when `REDIS_URL` is unset —
 * a laptop with no Redis running must still be able to save a recipe. Checked
 * directly against `process.env.REDIS_URL` up front rather than calling
 * `getRedis()` and catching its throw: both find the same fact, but a reader
 * of this file shouldn't have to open `#/lib/redis.ts` to learn that an unset
 * var is the intended "queueing is off" case rather than a surprise.
 *
 * `bullmq` is imported with a dynamic `import()` inside `getEnrichQueue`,
 * never at module scope — the repo's standing rule for `pg` (AGENTS.md),
 * restated for this module by name in §9 — so it never reaches the client
 * bundle. The `Queue` singleton has to be built lazily for the same reason:
 * it cannot be a module-level `new Queue(...)`, which would need a static
 * import to construct.
 *
 * Built on the shared `getRedis()` client rather than a connection of its
 * own — one Redis socket for the whole app, not a second one just for this
 * queue.
 */

let queue: Queue<EnrichPayload> | undefined;

async function getEnrichQueue(): Promise<Queue<EnrichPayload>> {
  if (!queue) {
    const { Queue: QueueCtor } = await import("bullmq");
    const { getRedis } = await import("#/lib/redis");
    queue = new QueueCtor<EnrichPayload>(RECIPE_ENRICHMENT_QUEUE, { connection: getRedis() });
  }
  return queue;
}

/**
 * Best-effort: enqueue `recipeId` for classification. Call this **after** the
 * transaction that marked it `stale` has committed — see the call sites in
 * `recipes-write.ts`. Deterministic `jobId` (`enrichJobId`) collapses a second
 * trigger for the same recipe (a re-save racing a sync sweep, say) into the
 * one already queued (D14) instead of running it twice.
 *
 * Never throws or rejects the caller's flow — see the module doc above.
 */
export async function enqueueEnrich(recipeId: string): Promise<void> {
  // Dev machine with no Redis: enrichment simply never gets a latency boost,
  // and the stale row waits for a manual backfill (D15). Still correct.
  if (!process.env.REDIS_URL) return;
  try {
    const q = await getEnrichQueue();
    await q.add(ENRICH_STEP, { recipeId }, { jobId: enrichJobId(recipeId) });
  } catch (err) {
    console.warn(`[enrichment-queue] could not enqueue enrich for recipe ${recipeId}`, err);
  }
}
