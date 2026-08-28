import type { FastifyInstance } from "fastify";
import { UnrecoverableError } from "bullmq";
import { ENRICH_STEP, RECIPE_ENRICHMENT_QUEUE, type EnrichPayload } from "@buttery/pipeline-contract";
import type { StepSpec } from "#/plugins/workflow.ts";
import { acquireLock, releaseLock } from "#/lib/lock.ts";
import { emptySummary, foldRepos } from "#/workflows/atproto-sync/plan.ts";
import { loadSyncConfig, RECIPE_COLLECTION } from "#/workflows/atproto-sync/lib/config.ts";
import { HttpError } from "#/workflows/atproto-sync/lib/http.ts";
import { enumerateDids, enumerateDidsFromPds } from "#/workflows/atproto-sync/lib/relay.ts";
import { closeSyncRun, markMissingRepos, markRepoError, openSyncRun, registerRepos, sweepDid } from "#/workflows/atproto-sync/lib/sweep.ts";
import type { FinalizePayload, RepoOutcome, SweepScope, SyncRepoPayload } from "#/workflows/atproto-sync/types.ts";

/**
 * The sweep, as three steps and the graph between them:
 *
 *     enumerate ──fans out──▶ sync-repo × N ──▶ finalize
 *
 * `enumerate` finds the work and submits the rest as one flow. Each repo is its
 * own job, so a slow PDS costs that repo its retries and nothing else, and the
 * fleet shares them. `finalize` sits in `waiting-children` — occupying no worker
 * — until every repo job has settled, then folds what they returned into the
 * `atproto_sync_run` row.
 *
 * The algorithm did not change when it became a graph. This is the same
 * enumerate → index → reconcile it always was, cut where it was already cut, and
 * the per-repo work in `lib/sweep.ts` is untouched.
 *
 * `createSteps(fastify)` closes the three steps over the Fastify instance
 * instead of a module-scope pool: `fastify.db` replaces the old `getPool`
 * (there is one pool for the whole service now, see `plugins/db.ts`), and
 * `fastify.log` / `fastify.redis` replace the old bespoke logger import and the
 * step context's `redis` field, which this registration path does not carry
 * (see `plugins/workflow.ts`'s D5).
 */

// --- overlap ---------------------------------------------------------------

/**
 * One sweep at a time across the fleet, taken by `enumerate` and released by
 * `finalize` — so it spans the whole graph, not one job.
 *
 * BullMQ stops the same job running twice; it does not stop two different jobs
 * on a queue, which is what an hourly schedule plus a sweep that runs long
 * produces. The Railway cron this replaces got that from the platform, so losing
 * it would be a regression.
 *
 * The TTL is the schedule's own period, deliberately. Nothing heartbeats it —
 * the holder is a graph, not a process — so it is a plain deadline, and what it
 * says is "a sweep may not start while the last one is still going, up to one
 * period". A sweep that outlasts its own interval is already the pathological
 * case, and freeing the lock then is better than wedging the schedule forever if
 * `finalize` never runs.
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

export function createSteps(fastify: FastifyInstance): readonly StepSpec[] {
  // --- enumerate -------------------------------------------------------------

  /**
   * Find the DIDs to sweep, open the run row, and submit the rest of the graph.
   * Three enumeration sources, in precedence order — one DID by name, one PDS's
   * repo list (local dev; the atproto dev-env ships no relay), or the relay's
   * collection index, which is the production path.
   */
  const enumerate: StepSpec = {
    name: "enumerate",
    description: "Discover the repos to sweep, then fan them out",
    jobOptions: {
      // Paging a relay is the one part of a sweep worth retrying wholesale; past
      // two tries it is an outage, and the next scheduled sweep is a better answer.
      attempts: 2,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 50 },
    },
    run: async ({ payload, log: line, flow }) => {
      const scope = scopeOf(payload);
      const config = loadSyncConfig(scope);

      const lock = await acquireLock(fastify.redis, LOCK_KEY, LOCK_TTL_MS);
      if (!lock) {
        // Not a failure: the work is already being done, and failing would only
        // buy a retry that hits the same lock. Skipping one hourly sweep costs
        // nothing — the next reconciles everything this one would have.
        fastify.log.warn("sweep skipped — another sweep holds the lock");
        await line("skipped: another sweep is already in flight");
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

        await line(`${dids.length} repos to sweep${config.fullSweep ? "" : " (partial sweep)"}, run ${syncRunId ?? "(dry)"}`);

        // One flow: N repo jobs, and the finalize job that waits on all of them.
        // `finalize` carries the DID list because reconciliation needs every repo
        // that was *enumerated*, not just the ones that succeeded — a repo whose
        // PDS was down has not gone missing from the network.
        const finalize: FinalizePayload = { ...scope, dids, fullSweep: config.fullSweep, syncRunId, lock };
        await flow({
          step: "finalize",
          data: finalize,
          children: dids.map((did) => ({ step: "sync-repo", data: { ...scope, did, syncRunId } satisfies SyncRepoPayload })),
        });

        return { syncRunId, reposSeen: dids.length, fullSweep: config.fullSweep, dryRun: config.dryRun };
      } catch (err) {
        // Nothing downstream exists yet, so this job owns the cleanup: close the
        // row it opened and free the lock, or the schedule wedges for an hour.
        await closeSyncRun(fastify.db, null, emptySummary(config.dryRun), String(err), fastify.log);
        await releaseLock(fastify.redis, LOCK_KEY, lock, fastify.log);
        throw err;
      }
    },
  };

  // --- sync-repo -------------------------------------------------------------

  /**
   * Sweep one repo. See `lib/sweep.ts`, which throws when the repo cannot be
   * swept — which is how a job asks for the retry it deserves.
   *
   * The one judgement call is which failures deserve a retry at all. A PDS that
   * times out or 500s will probably answer next time. A PDS that answers `400` for
   * a DID — a deactivated or migrated repo, which the live network has a few of —
   * will answer 400 forever, and retrying it three times with backoff spends a
   * minute to learn nothing. `UnrecoverableError` is BullMQ's way of saying so:
   * fail now, skip the remaining attempts.
   *
   * Also where recipe-enrichment gets triggered for whatever this repo advanced
   * (recipe-enrichment plan §9) — enqueued here, per repo, rather than batched up
   * in `finalize`: `finalize` would have to carry every advanced id from every
   * repo in the sweep through its own Redis job payload (thousands, on a full
   * sweep), and doing it all at once there would spike load at the tail of the
   * sweep instead of spreading it across the whole run the way per-repo enqueue
   * does.
   */
  const syncRepo: StepSpec = {
    name: "sync-repo",
    description: "Sweep one repo: page its records, upsert them, reconcile its deletes",
    jobOptions: {
      // A PDS being briefly unreachable is the common case and is worth three
      // tries. Past that it is an outage on their side, and the next scheduled
      // sweep is a better answer than a fourth attempt inside this one.
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      // A sweep of the whole network is thousands of these. Keeping every one
      // would make the queue the largest thing in Redis within a day.
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
    },
    run: async ({ payload, log: line, enqueue }) => {
      const raw = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
      const did = typeof raw.did === "string" ? raw.did : "";
      if (!did) throw new UnrecoverableError("sync-repo job has no did");

      const config = loadSyncConfig(scopeOf(payload));

      try {
        const { outcome, advancedRecipeIds } = await sweepDid(fastify.db, config, did, fastify.log);
        await line(`${outcome.upserted} upserted, ${outcome.deleted} deleted`);

        // Best-effort enqueue (D3): `renderRecipe` already wrote `status='stale'`
        // in the same transaction as the content that advanced, so that row is
        // the durable signal and §7.2's backfill will find anything this misses —
        // a failed enqueue must cost this repo nothing: not its retries, not the
        // rest of its own ids. `advancedRecipeIds` is already empty on a dry run
        // (`sweepDid` never calls `renderRecipe` on that path), so this guard is
        // belt-and-suspenders — kept explicit so the loop stays inert even if a
        // future change to `sweepDid` ever stopped guaranteeing that.
        //
        // `ctx.enqueue` deliberately throws on an unregistered workflow or step —
        // a typo should fail loudly, not vanish (see `define.ts`). Catching it
        // here does not undo that: a bad workflow/step name throws on *every*
        // advanced recipe, on *every* repo, for the life of the bug, and each one
        // is logged at `error` — which is far louder in practice than the single
        // throw a caller who doesn't catch would get once. What this catch buys
        // is narrower: it stops that bug (or a transient Redis blip) from costing
        // an otherwise-successful repo its sweep and its retries, which D3 says
        // it must never do.
        if (!config.dryRun) {
          for (const recipeId of advancedRecipeIds) {
            try {
              await enqueue(RECIPE_ENRICHMENT_QUEUE, { step: ENRICH_STEP, data: { recipeId } satisfies EnrichPayload });
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
    },
  };

  // --- finalize --------------------------------------------------------------

  /**
   * Fold what the repo jobs returned, reconcile, and close the run row.
   *
   * It runs once every child has settled — completed, or failed after its last
   * attempt — because they were created with `ignoreDependencyOnFailure`. That is
   * the whole reason a sweep survives a handful of unreachable PDSes: their jobs
   * fail, this one counts them, and the sweep is still a success.
   */
  const finalize: StepSpec = {
    name: "finalize",
    description: "Fold the repo results, reconcile missing repos, close the run row",
    jobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 50 },
    },
    run: async ({ payload, children, log: line }) => {
      const input = payload as FinalizePayload;
      const config = loadSyncConfig(input);

      const results = await children();
      let summary = foldRepos(
        { ...emptySummary(config.dryRun), syncRunId: input.syncRunId, reposSeen: input.dids.length },
        results.values as RepoOutcome[],
        results.failures.length,
      );

      try {
        if (input.fullSweep && !config.dryRun) {
          summary = { ...summary, reposMarkedMissing: await markMissingRepos(fastify.db, input.dids) };
          fastify.log.info({ count: summary.reposMarkedMissing }, "marked missing repos");
        }
        await closeSyncRun(fastify.db, input.syncRunId, summary, null, fastify.log);
        await line(`sweep complete: ${JSON.stringify(summary)}`);
        fastify.log.info({ ...summary }, "sweep complete");
        return summary;
      } catch (err) {
        // Without this the row says `running` forever and the table stops being a
        // usable record of what happened.
        await closeSyncRun(fastify.db, input.syncRunId, { ...summary, status: "error" }, String(err), fastify.log);
        throw err;
      } finally {
        // Whatever happened, the next sweep gets to start. This job is the last
        // one in the graph, so there is nowhere else the lock could be freed.
        await releaseLock(fastify.redis, LOCK_KEY, input.lock, fastify.log);
      }
    },
  };

  return [enumerate, syncRepo, finalize];
}
