import { ENRICH_JOB, LLM_ENRICH_JOB, RECIPE_ENRICHMENT_QUEUE, enrichJobId, llmEnrichJobId, type EnrichPayload, type LlmEnrichPayload } from "@buttery/pipeline-contract";
import type { Queue } from "bullmq";

/**
 * Producer-only handoff into the `recipe-enrichment` BullMQ queue that
 * `services/pipeline` drains — the app never runs a `Worker`, it only ever
 * calls `queue.add`. See `docs/plans/2026-08-20-recipe-enrichment.md` §9 and
 * `@buttery/pipeline-contract` for the queue/step names and the job id.
 * `ENRICH_JOB` and `LLM_ENRICH_JOB` are two job NAMES on the same queue
 * (`RECIPE_ENRICHMENT_QUEUE`) — `services/pipeline/…/queues/recipe-enrichment/
 * index.ts` runs one `Queue`/`Worker` pair, switched on `job.name` — so this
 * module keeps one lazily-built `Queue` singleton and both `enqueueEnrich`
 * and `enqueueLlmEnrich` below share it, rather than each opening its own.
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
 * best-effort write it refuses to let fail the caller. `enqueueLlmEnrich`
 * below keeps the same never-throws rule even though it is not a write-path
 * call at all (see its own doc for why it still can't throw).
 *
 * No-ops (no Redis connection is ever attempted) when `REDIS_URL` is unset —
 * a laptop with no Redis running must still be able to save a recipe. Checked
 * directly against `process.env.REDIS_URL` up front rather than calling
 * `getRedis()` and catching its throw: both find the same fact, but a reader
 * of this file shouldn't have to open `#/lib/redis.ts` to learn that an unset
 * var is the intended "queueing is off" case rather than a surprise.
 *
 * `bullmq` is imported with a dynamic `import()` inside `getQueue`, never at
 * module scope — the repo's standing rule for `pg` (AGENTS.md), restated for
 * this module by name in §9 — so it never reaches the client bundle. The
 * `Queue` singleton has to be built lazily for the same reason: it cannot be
 * a module-level `new Queue(...)`, which would need a static import to
 * construct.
 *
 * Built on the shared `getRedis()` client rather than a connection of its
 * own — one Redis socket for the whole app, not a second one just for this
 * queue.
 */

let queue: Queue<EnrichPayload | LlmEnrichPayload> | undefined;

async function getQueue(): Promise<Queue<EnrichPayload | LlmEnrichPayload>> {
  if (!queue) {
    const { Queue: QueueCtor } = await import("bullmq");
    const { getRedis } = await import("#/lib/redis");
    queue = new QueueCtor<EnrichPayload | LlmEnrichPayload>(RECIPE_ENRICHMENT_QUEUE, { connection: getRedis() });
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
    const q = await getQueue();
    await q.add(ENRICH_JOB, { recipeId }, { jobId: enrichJobId(recipeId) });
  } catch (err) {
    console.warn(`[enrichment-queue] could not enqueue enrich for recipe ${recipeId}`, err);
  }
}

// --- the devtools "run it now" trigger --------------------------------------

/**
 * What `enqueueLlmEnrich` handed back, so its one caller (the devtools
 * panel's "run LLM enrichment now" button, via `server/recipe-debug.ts`'s
 * `triggerLlmEnrichPayload`) can show the developer a REAL outcome instead of
 * a bare "done": `enqueueEnrich` above can afford to return `void` because no
 * write-path caller ever looks at the result, but a button whose entire job
 * is to report what happened has nothing to report without this.
 */
export type LlmEnrichEnqueueOutcome =
  | { status: "disabled" }
  | { status: "already-running"; jobId: string; state: string }
  | { status: "enqueued"; jobId: string }
  | { status: "error"; message: string };

/**
 * Best-effort: enqueue `recipeId` for the LLM second opinion, on demand,
 * from the devtools panel. This is the manual analogue of the
 * `enrich → llm-enrich` handoff `services/pipeline`'s own `runEnrich` does
 * automatically (`queues/recipe-enrichment/index.ts`) — same queue, same job
 * name, same deterministic id — but a person clicking a button captioned
 * "run it now" has different expectations than an automatic retry does, and
 * this function exists to reconcile the two.
 *
 * ── WHY THIS ALWAYS SENDS `force: true` ─────────────────────────────────
 * The automatic handoff enqueues WITHOUT `force` — `isLlmFresh`
 * (`services/pipeline/…/lib/load.ts`) short-circuits a `llm-enrich` job to
 * `{status:"unchanged"}` when the stored `llm_version`/`llm_input_hash`
 * already cover this content, which is exactly right for a job that fires on
 * every save. It is exactly wrong for THIS button: a developer clicking "run
 * it now" wants a fresh model call, full stop, not a job that immediately
 * no-ops because the last run happens to already be current. `force: true`
 * in the payload is what `isLlmFresh` checks first (`!force && …`), so it
 * always loses the short-circuit and the model actually runs — still subject
 * to `llm-enrich`'s real precondition (the rules pass must be `status='ok'`
 * on the same content), which no client-side flag can or should bypass.
 *
 * ── THE DETERMINISTIC jobId PROBLEM, AND HOW THIS RESOLVES IT ───────────
 * `llmEnrichJobId(recipeId)` is deterministic ON PURPOSE elsewhere: it is
 * what makes two automatic triggers for the same recipe collapse into one
 * job instead of racing (D14, mirrored from `enrichJobId`). For a manual
 * "run it again" button that same determinism is a trap — BullMQ refuses to
 * create a second job under an id already occupied, and `removeOnComplete`
 * keeps a finished job's key around for a while rather than freeing it
 * immediately, so a plain `q.add` with this job id would, for a recipe whose
 * last run already finished, silently hand back that SAME finished job
 * without running anything new. A button that then said "queued!" would be
 * lying — the developer would sit at Bull Board watching nothing happen.
 *
 * Two real states have to be told apart before deciding what to do:
 *
 *   - A job under this id is still active/waiting/delayed (genuinely in
 *     flight): join it, don't duplicate it. This is the one case where the
 *     manual button's behaviour matches an automatic trigger's, and it is
 *     reported as `"already-running"` rather than silently pretended away.
 *   - A job under this id already reached a terminal state (completed or
 *     failed): its Redis key is still occupying the id, so it is removed
 *     first — `Job.remove()` — and THEN the fresh job is added under the
 *     same id. This is safe specifically because the old job is no longer
 *     running (removing an active job would throw); it is what makes "run it
 *     again" actually mean again.
 *
 * Never throws — same rule the rest of this module follows (module doc), even
 * though this call sits behind a button rather than a write path: a
 * dev-panel action failing loudly enough to blow up the whole panel over a
 * BullMQ hiccup would be a worse debugging experience than the button simply
 * reporting `{status:"error"}` and letting the developer try again.
 */
export async function enqueueLlmEnrich(recipeId: string): Promise<LlmEnrichEnqueueOutcome> {
  if (!process.env.REDIS_URL) return { status: "disabled" };

  const jobId = llmEnrichJobId(recipeId);
  try {
    const q = await getQueue();
    const existing = await q.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state !== "completed" && state !== "failed") {
        // Still in flight under the id an automatic trigger would also use —
        // see the doc comment above. Reported honestly rather than silently
        // dropped, so the developer knows to go watch the run already
        // underway instead of wondering why nothing new showed up.
        return { status: "already-running", jobId, state };
      }
      // Terminal state: see the doc comment above for why a plain `q.add`
      // here would otherwise silently hand back this same finished job.
      await existing.remove();
    }
    await q.add(LLM_ENRICH_JOB, { recipeId, force: true } satisfies LlmEnrichPayload, { jobId });
    return { status: "enqueued", jobId };
  } catch (err) {
    console.warn(`[enrichment-queue] could not enqueue llm-enrich for recipe ${recipeId}`, err);
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
