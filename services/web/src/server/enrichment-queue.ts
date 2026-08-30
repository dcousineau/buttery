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
 * module keeps one lazily-built `Queue` singleton and every producer
 * below shares it, rather than each opening its own.
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
 * best-effort write it refuses to let fail the caller. The two manual
 * devtools triggers below keep the same never-throws rule even though neither
 * is a write-path call at all (see `enqueueManualRun` for why they still
 * can't throw).
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

// --- the devtools "run it now" triggers -------------------------------------

/**
 * What the two manual triggers below hand back, so their callers (the devtools
 * panel's pair of "run it now" buttons, via `server/recipe-debug.ts`'s
 * `triggerEnrichPayload` / `triggerLlmEnrichPayload`) can show the developer a
 * REAL outcome instead of a bare "done": `enqueueEnrich` above can afford to
 * return `void` because no write-path caller ever looks at the result, but a
 * button whose entire job is to report what happened has nothing to report
 * without this.
 *
 * One type for both triggers rather than one per job name: they differ in
 * which job they add, not in what can happen to it — the four outcomes below
 * are properties of adding a job under a deterministic id, which is the same
 * problem in both cases (see {@link enqueueManualRun}).
 */
export type EnrichEnqueueOutcome =
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
 * The deterministic-`jobId` problem this shares with its sibling, and how it
 * is resolved, is in {@link enqueueManualRun}. Never throws — same rule the
 * rest of this module follows (module doc).
 */
export async function enqueueLlmEnrich(recipeId: string): Promise<EnrichEnqueueOutcome> {
  return enqueueManualRun(LLM_ENRICH_JOB, llmEnrichJobId(recipeId), { recipeId, force: true } satisfies LlmEnrichPayload);
}

/**
 * Best-effort: enqueue `recipeId` for the RULES pass, on demand, from the
 * devtools panel — the sibling of {@link enqueueLlmEnrich}, and the thing that
 * unblocks it.
 *
 * ── WHY A SECOND BUTTON EXISTS AT ALL ───────────────────────────────────
 * `llm-enrich` refuses to call a model unless the rules pass is `status='ok'`
 * on the same content AND at the deployed `CLASSIFIER_VERSION`
 * (`rulesPassCurrent`, `services/pipeline/…/lib/load.ts`) — the panel surfaces
 * that precondition as `LlmEnrichmentSummary.rulesVersionCurrent`. Bump
 * `CLASSIFIER_VERSION` and every already-classified recipe fails it at once,
 * and the LLM button beside this one can then only queue a job that logs
 * "rules pass … is missing or stale — skipped" and stops. Nothing re-runs
 * `enrich` on its own to clear that: the rules pass fires on a content change
 * or not at all, so before this existed the panel could diagnose the state it
 * was stuck in but not leave it, and the developer had to go run the
 * pipeline's backfill CLI over the whole corpus to fix one recipe.
 *
 * ── ONE CLICK RUNS BOTH PASSES, IN ORDER ────────────────────────────────
 * `force: true` for the same reason its sibling sends it (a person clicking
 * "run it now" means now, not "unless a short-circuit decides otherwise"), and
 * here it carries further than this job alone: on success `runEnrich` hands off
 * to `llm-enrich` and forwards its OWN `force` into that payload. So this
 * single button re-runs the rules pass and then the model — exactly the
 * sequence a stale-classifier recipe needs — which leaves the LLM button for
 * the narrower case of re-running only the model against a rules pass that is
 * already current.
 *
 * Never throws — see {@link enqueueManualRun}.
 */
export async function enqueueEnrichNow(recipeId: string): Promise<EnrichEnqueueOutcome> {
  return enqueueManualRun(ENRICH_JOB, enrichJobId(recipeId), { recipeId, force: true } satisfies EnrichPayload);
}

/**
 * The shared body of both manual triggers above: add `payload` under a
 * DETERMINISTIC `jobId`, resolving the two states that determinism creates for
 * a button whose whole meaning is "run it again".
 *
 * ── THE DETERMINISTIC jobId PROBLEM, AND HOW THIS RESOLVES IT ───────────
 * `enrichJobId` / `llmEnrichJobId` are deterministic ON PURPOSE elsewhere:
 * that is what makes two automatic triggers for the same recipe collapse into
 * one job instead of racing (D14). For a manual button the same determinism is
 * a trap — BullMQ refuses to create a second job under an id already occupied,
 * and `removeOnComplete` keeps a finished job's key around for a while rather
 * than freeing it immediately, so a plain `q.add` would, for a recipe whose
 * last run already finished, silently hand back that SAME finished job without
 * running anything new. A button that then reported "queued!" would be lying —
 * the developer would sit at Bull Board watching nothing happen.
 *
 * Two real states have to be told apart before deciding what to do:
 *
 *   - A job under this id is still active/waiting/delayed (genuinely in
 *     flight): join it, don't duplicate it. This is the one case where the
 *     manual button's behaviour matches an automatic trigger's, and it is
 *     reported as `"already-running"` rather than silently pretended away.
 *   - A job under this id already reached a terminal state (completed or
 *     failed): its Redis key is still occupying the id, so it is removed
 *     first — `Job.remove()` — and THEN the fresh job is added under the same
 *     id. This is safe specifically because the old job is no longer running
 *     (removing an active job would throw); it is what makes "run it again"
 *     actually mean again.
 *
 * Never throws — same rule the rest of this module follows (module doc), even
 * though these calls sit behind a button rather than a write path: a dev-panel
 * action failing loudly enough to blow up the whole panel over a BullMQ hiccup
 * would be a worse debugging experience than the button simply reporting
 * `{status:"error"}` and letting the developer try again.
 */
async function enqueueManualRun(jobName: typeof ENRICH_JOB | typeof LLM_ENRICH_JOB, jobId: string, payload: EnrichPayload | LlmEnrichPayload): Promise<EnrichEnqueueOutcome> {
  if (!process.env.REDIS_URL) return { status: "disabled" };

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
    await q.add(jobName, payload, { jobId });
    return { status: "enqueued", jobId };
  } catch (err) {
    console.warn(`[enrichment-queue] could not enqueue ${jobName} for recipe ${payload.recipeId}`, err);
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
