import type { FastifyInstance } from "fastify";
import { UnrecoverableError, type Job, type JobsOptions, type Queue } from "bullmq";
import { ENRICH_JOB, RECIPE_ENRICHMENT_QUEUE, type EnrichPayload } from "@buttery/pipeline-contract";
import { acquireLock, releaseLock } from "#/lib/lock.ts";
import { emptySummary, foldRepos } from "#/queues/atproto-sync/plan.ts";
import { loadSyncConfig, RECIPE_COLLECTION } from "#/queues/atproto-sync/lib/config.ts";
import { HttpError } from "#/queues/atproto-sync/lib/http.ts";
import { enumerateDids, enumerateDidsFromPds } from "#/queues/atproto-sync/lib/relay.ts";
import { closeSyncRun, markMissingRepos, markRepoError, openSyncRun, registerRepos, sweepDid } from "#/queues/atproto-sync/lib/sweep.ts";
import type { FinalizePayload, RepoOutcome, SweepScope, SyncRepoPayload } from "#/queues/atproto-sync/types.ts";

/**
 * The sweep, as three jobs and the flow between them:
 *
 *     enumerate ──fans out──▶ sync-repo × N ──▶ finalize
 *
 * `enumerate` finds the work and submits the rest as one `FlowProducer.add`
 * call. Each repo is its own job, so a slow PDS costs that repo its retries and
 * nothing else, and the fleet shares them. `finalize` sits in
 * `waiting-children` — occupying no worker — until every repo job has settled,
 * then folds what they returned into the `atproto_sync_run` row.
 *
 * The algorithm did not change when it became a flow. This is the same
 * enumerate → index → reconcile it always was, cut where it was already cut,
 * and the per-repo work in `lib/sweep.ts` is untouched.
 *
 * Every handler below takes `fastify` as its first argument instead of closing
 * over a module-scope pool: `fastify.db` replaces the old `getPool` (there is
 * one pool for the whole service now, see `plugins/db.ts`), and `fastify.log` /
 * `fastify.redis` replace the old bespoke logger import and the step context's
 * `redis` field the previous registration path did not carry. There is no
 * factory to call anymore (`createSteps(fastify)` is gone) — `index.ts` passes
 * `fastify` straight through to whichever handler `job.name` selects, the same
 * way BullMQ's own examples do.
 */

// --- job names ---------------------------------------------------------------

/** Passed to `queue.add`/`flow.add` and matched on `job.name` in `index.ts`'s processor. Shared so the two files can't drift. */
export const ENUMERATE_JOB = "enumerate";
export const SYNC_REPO_JOB = "sync-repo";
export const FINALIZE_JOB = "finalize";

// --- job options ---------------------------------------------------------------

/**
 * The old kernel let each step declare its own `jobOptions`, applied wherever
 * that step got added. BullMQ's `Queue`/`FlowProducer` have no such per-name
 * concept — options are an argument to `.add()`, not a property of a job name —
 * so each set below is passed explicitly at the call site instead: `enumerate`'s
 * doubles as `index.ts`'s `defaultJobOptions` (it is the only job ever added
 * through the scheduler or `POST /jobs/atproto-sync`, both of which have no way
 * to name per-job options), and `sync-repo`'s / `finalize`'s are passed at
 * `flow.add` time below, since those two are only ever created as flow children.
 */

/**
 * Paging a relay is the one part of a sweep worth retrying wholesale; past two
 * tries it is an outage, and the next scheduled sweep is a better answer.
 */
export const ENUMERATE_JOB_OPTIONS: JobsOptions = {
  attempts: 2,
  backoff: { type: "exponential", delay: 60_000 },
  removeOnComplete: { count: 50 },
  removeOnFail: { count: 50 },
};

/**
 * A PDS being briefly unreachable is the common case and is worth three tries.
 * Past that it is an outage on their side, and the next scheduled sweep is a
 * better answer than a fourth attempt inside this one. Retention is tighter
 * than `enumerate`'s: a sweep of the whole network is thousands of these, and
 * keeping every one would make the queue the largest thing in Redis within a
 * day.
 */
export const SYNC_REPO_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
};

export const FINALIZE_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 10_000 },
  removeOnComplete: { count: 50 },
  removeOnFail: { count: 50 },
};

// --- overlap ---------------------------------------------------------------

/**
 * One sweep at a time across the fleet, taken by `enumerate` and released by
 * `finalize` — so it spans the whole flow, not one job.
 *
 * BullMQ stops the same job running twice; it does not stop two different jobs
 * on a queue, which is what an hourly schedule plus a sweep that runs long
 * produces. The Railway cron this replaces got that from the platform, so
 * losing it would be a regression.
 *
 * The TTL is the schedule's own period, deliberately. Nothing heartbeats it —
 * the holder is a flow, not a process — so it is a plain deadline, and what it
 * says is "a sweep may not start while the last one is still going, up to one
 * period". A sweep that outlasts its own interval is already the pathological
 * case, and freeing the lock then is better than wedging the schedule forever
 * if `finalize` never runs.
 */
const LOCK_KEY = "pipeline:lock:atproto-sync";
const LOCK_TTL_MS = 60 * 60_000;

function scopeOf(data: unknown): SweepScope {
  const raw = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  return {
    dryRun: raw.dryRun === true,
    maxRepos: typeof raw.maxRepos === "number" || typeof raw.maxRepos === "string" ? Number(raw.maxRepos) : undefined,
    onlyDid: typeof raw.onlyDid === "string" ? raw.onlyDid : undefined,
  };
}

// --- enumerate ---------------------------------------------------------------

/**
 * Find the DIDs to sweep, open the run row, and submit the rest of the flow.
 * Three enumeration sources, in precedence order — one DID by name, one PDS's
 * repo list (local dev; the atproto dev-env ships no relay), or the relay's
 * collection index, which is the production path.
 */
export async function enumerate(fastify: FastifyInstance, queue: Queue, job: Job): Promise<unknown> {
  const scope = scopeOf(job.data);
  const config = loadSyncConfig(scope);

  const lock = await acquireLock(fastify.redis, LOCK_KEY, LOCK_TTL_MS);
  if (!lock) {
    // Not a failure: the work is already being done, and failing would only
    // buy a retry that hits the same lock. Skipping one hourly sweep costs
    // nothing — the next reconciles everything this one would have.
    fastify.log.warn("sweep skipped — another sweep holds the lock");
    await job.log("skipped: another sweep is already in flight");
    return { status: "skipped" };
  }

  try {
    const dids: string[] = [];
    if (config.onlyDid) {
      dids.push(config.onlyDid);
      fastify.log.info({ did: config.onlyDid }, "single-did sweep");
    } else if (config.pdsListUrl) {
      for await (const did of enumerateDidsFromPds(config.pdsListUrl, config.maxRepos)) dids.push(did);
      fastify.log.info({ pds: config.pdsListUrl, count: dids.length }, "enumerated repos from pds");
    } else {
      for await (const did of enumerateDids(config.relayUrl, RECIPE_COLLECTION, config.maxRepos)) dids.push(did);
      fastify.log.info({ count: dids.length }, "enumerated repos");
    }

    const syncRunId = await openSyncRun(fastify.db, config);
    if (!config.dryRun) await registerRepos(fastify.db, dids);

    await job.log(`${dids.length} repos to sweep${config.fullSweep ? "" : " (partial sweep)"}, run ${syncRunId ?? "(dry)"}`);

    // One flow: N repo jobs, and the finalize job that waits on all of them.
    // `finalize` carries the DID list because reconciliation needs every repo
    // that was *enumerated*, not just the ones that succeeded — a repo whose
    // PDS was down has not gone missing from the network.
    //
    // Every child gets `ignoreDependencyOnFailure: true` explicitly. The old
    // kernel gave every child that for free; BullMQ's `FlowProducer` does not
    // default it, and without it one dead repo would fail `finalize` itself
    // instead of just being counted by it — which is the whole reason a sweep
    // survives a handful of unreachable PDSes.
    const finalizeData: FinalizePayload = { ...scope, dids, fullSweep: config.fullSweep, syncRunId, lock };
    await fastify.bullmq.flow.add({
      name: FINALIZE_JOB,
      queueName: queue.name,
      data: finalizeData,
      opts: FINALIZE_JOB_OPTIONS,
      children: dids.map((did) => ({
        name: SYNC_REPO_JOB,
        queueName: queue.name,
        data: { ...scope, did, syncRunId } satisfies SyncRepoPayload,
        opts: { ...SYNC_REPO_JOB_OPTIONS, ignoreDependencyOnFailure: true },
      })),
    });

    return { syncRunId, reposSeen: dids.length, fullSweep: config.fullSweep, dryRun: config.dryRun };
  } catch (err) {
    // Nothing downstream exists yet, so this job owns the cleanup: close the
    // row it opened and free the lock, or the schedule wedges for an hour.
    await closeSyncRun(fastify.db, null, emptySummary(config.dryRun), String(err), fastify.log);
    await releaseLock(fastify.redis, LOCK_KEY, lock, fastify.log);
    throw err;
  }
}

// --- sync-repo -----------------------------------------------------------------

/**
 * Sweep one repo. See `lib/sweep.ts`, which throws when the repo cannot be
 * swept — which is how a job asks for the retry it deserves.
 *
 * The one judgement call is which failures deserve a retry at all. A PDS that
 * times out or 500s will probably answer next time. A PDS that answers `400`
 * for a DID — a deactivated or migrated repo, which the live network has a few
 * of — will answer 400 forever, and retrying it three times with backoff
 * spends a minute to learn nothing. `UnrecoverableError` is BullMQ's way of
 * saying so: fail now, skip the remaining attempts.
 *
 * Also where recipe-enrichment gets triggered for whatever this repo advanced
 * (recipe-enrichment plan §9) — enqueued here, per repo, rather than batched up
 * in `finalize`: `finalize` would have to carry every advanced id from every
 * repo in the sweep through its own Redis job payload (thousands, on a full
 * sweep), and doing it all at once there would spike load at the tail of the
 * sweep instead of spreading it across the whole run the way per-repo enqueue
 * does.
 */
export async function syncRepo(fastify: FastifyInstance, job: Job): Promise<unknown> {
  const raw = (typeof job.data === "object" && job.data !== null ? job.data : {}) as Record<string, unknown>;
  const did = typeof raw.did === "string" ? raw.did : "";
  if (!did) throw new UnrecoverableError("sync-repo job has no did");

  const config = loadSyncConfig(scopeOf(job.data));

  try {
    const { outcome, advancedRecipeIds } = await sweepDid(fastify.db, config, did, fastify.log);
    await job.log(`${outcome.upserted} upserted, ${outcome.deleted} deleted`);

    // Best-effort enqueue (D3): `renderRecipe` already wrote `status='stale'`
    // in the same transaction as the content that advanced, so that row is
    // the durable signal and §7.2's backfill will find anything this misses —
    // a failed enqueue must cost this repo nothing: not its retries, not the
    // rest of its own ids. `advancedRecipeIds` is already empty on a dry run
    // (`sweepDid` never calls `renderRecipe` on that path), so this guard is
    // belt-and-suspenders — kept explicit so the loop stays inert even if a
    // future change to `sweepDid` ever stopped guaranteeing that.
    //
    // Judgement call: the generic cross-queue handoff this repo migrated to
    // (`fastify.bullmq.get(name)?.queue.add(...)`) resolves a bad queue name to
    // `undefined` and silently does nothing — no throw. The old `ctx.enqueue`
    // deliberately threw on an unregistered workflow/step so a typo would fail
    // loudly rather than vanish (see the old `define.ts`). Losing that would
    // mean a typo'd `RECIPE_ENRICHMENT_QUEUE` stops enrichment for the life of
    // the bug with nothing in the logs to find it by, which is exactly what the
    // old design set out to avoid. So this looks the registration up itself and
    // throws when it is missing, rather than using the bare `?.` — the catch
    // below still turns that throw into a per-id `error` log instead of failing
    // the repo, same as before.
    if (!config.dryRun) {
      for (const recipeId of advancedRecipeIds) {
        try {
          const enrichment = fastify.bullmq.get(RECIPE_ENRICHMENT_QUEUE);
          if (!enrichment) throw new Error(`no queue registered named "${RECIPE_ENRICHMENT_QUEUE}"`);
          await enrichment.queue.add(ENRICH_JOB, { recipeId } satisfies EnrichPayload);
        } catch (err) {
          fastify.log.error({ did, recipeId, err: String(err) }, "failed to enqueue recipe enrichment");
        }
      }
    }

    return outcome;
  } catch (err) {
    const permanent = err instanceof HttpError && err.status !== undefined && err.status !== 429 && err.status >= 400 && err.status < 500;
    fastify.log.error({ did, permanent, err: String(err) }, "repo sweep failed");
    if (!config.dryRun) await markRepoError(fastify.db, did, String(err), fastify.log);
    if (permanent) throw new UnrecoverableError(`${did}: ${String(err)}`);
    throw err;
  }
}

// --- finalize --------------------------------------------------------------

/**
 * Fold what the repo jobs returned, reconcile, and close the run row.
 *
 * It runs once every child has settled — completed, or failed after its last
 * attempt — because they were created with `ignoreDependencyOnFailure`. That is
 * the whole reason a sweep survives a handful of unreachable PDSes: their jobs
 * fail, this one counts them, and the sweep is still a success.
 */
export async function finalize(fastify: FastifyInstance, job: Job): Promise<unknown> {
  const input = job.data as FinalizePayload;
  const config = loadSyncConfig(input);

  // `getChildrenValues` keys its object by child job key, not by DID — the
  // values are what `plan.ts` folds. `getIgnoredChildrenFailures` is BullMQ's
  // replacement for the old kernel's `children().failures` array: same
  // information (one entry per child that exhausted its attempts and was
  // ignored rather than failing this job), keyed the same way, so only its
  // count matters to `foldRepos`.
  const childValues = await job.getChildrenValues<RepoOutcome>();
  const ignoredFailures = await job.getIgnoredChildrenFailures();

  let summary = foldRepos(
    { ...emptySummary(config.dryRun), syncRunId: input.syncRunId, reposSeen: input.dids.length },
    Object.values(childValues),
    Object.keys(ignoredFailures).length,
  );

  try {
    if (input.fullSweep && !config.dryRun) {
      summary = { ...summary, reposMarkedMissing: await markMissingRepos(fastify.db, input.dids) };
      fastify.log.info({ count: summary.reposMarkedMissing }, "marked missing repos");
    }
    await closeSyncRun(fastify.db, input.syncRunId, summary, null, fastify.log);
    await job.log(`sweep complete: ${JSON.stringify(summary)}`);
    fastify.log.info({ ...summary }, "sweep complete");
    return summary;
  } catch (err) {
    // Without this the row says `running` forever and the table stops being a
    // usable record of what happened.
    await closeSyncRun(fastify.db, input.syncRunId, { ...summary, status: "error" }, String(err), fastify.log);
    throw err;
  } finally {
    // Whatever happened, the next sweep gets to start. This job is the last
    // one in the flow, so there is nowhere else the lock could be freed.
    await releaseLock(fastify.redis, LOCK_KEY, input.lock, fastify.log);
  }
}
