import fp from "fastify-plugin";
import { UnrecoverableError } from "bullmq";
import { ENUMERATE_JOB, ENUMERATE_JOB_OPTIONS, enumerate, FINALIZE_JOB, finalize, SYNC_REPO_JOB, syncRepo } from "#/queues/atproto-sync/jobs.ts";

/**
 * Sweep the atproto network and reconcile the Postgres recipe index.
 *
 * This was a Railway cron service. It is a scheduled BullMQ queue now, which
 * buys three things the cron did not have: the sweep is visible in the Bull
 * Board UI while it runs — as a job per repo, with its own payload, log,
 * retries and duration — rather than only in a log stream; a sweep can be
 * triggered on demand with `POST /jobs/atproto-sync` without touching the
 * dashboard; and it spreads over the same autoscaled fleet as every other
 * queue instead of looping alone in a container of its own.
 *
 * The flow is three jobs — see `jobs.ts`:
 *
 *     enumerate ──fans out──▶ sync-repo × N ──▶ finalize
 *
 * Everything it needs is in this folder:
 *
 *   jobs.ts      the three jobs and the flow between them
 *   plan.ts      folding repo results into a summary — pure, and tested
 *   types.ts     what the jobs hand each other, which is JSON in Redis
 *   lib/         the work itself, unchanged from when this was its own package:
 *                config.ts, relay.ts + pds.ts + identity.ts + http.ts (the
 *                network), recipe.ts + render.ts (the writes), sweep.ts (one
 *                repo, and the run bookkeeping) — the pool is `fastify.db` now,
 *                so there is no db.ts here anymore
 *
 * One processor, one `switch` on `job.name` — `plugins/bullmq.ts`'s idiom, not
 * a per-job-name lookup table. There is nothing left here to describe a flow
 * ahead of time (no more `entry`, no more `steps: [...]`): `enumerate` decides
 * what the rest of the flow looks like at runtime, by calling
 * `fastify.bullmq.flow.add(...)` itself (see `jobs.ts`).
 */
export default fp(
  (fastify) => {
    const queue = fastify.bullmq.queue({
      name: "atproto-sync",
      description: "Sweep the atproto network and reconcile the Postgres recipe index",
      jobs: [
        { name: ENUMERATE_JOB, description: "Discover the repos to sweep, then fan them out" },
        { name: SYNC_REPO_JOB, description: "Sweep one repo: page its records, upsert them, reconcile its deletes" },
        { name: FINALIZE_JOB, description: "Fold the repo results, reconcile missing repos, close the run row" },
      ],
      // What the scheduler below fires, and what `POST /jobs/atproto-sync`
      // adds when the body names no job — the only entry point a sweep has,
      // same as the old workflow's `entry: "enumerate"`.
      defaultJob: ENUMERATE_JOB,
      // `enumerate` is the only job ever added through the scheduler or the
      // generic `POST /jobs/:queue` route, and neither has a way to name
      // per-job options — so its options double as this queue's defaults.
      // `sync-repo` and `finalize` are only ever created as flow children
      // inside `enumerate` itself, where `jobs.ts` passes their own options
      // directly to `flow.add`.
      defaultJobOptions: ENUMERATE_JOB_OPTIONS,

      // Hourly on Railway (see .railway/railway.ts), unset locally — a dev
      // machine should not quietly sweep the live atmosphere in the
      // background. Set ATPROTO_SYNC_SCHEDULE in services/pipeline/.env to
      // turn it on.
      schedule: fastify.env.ATPROTO_SYNC_SCHEDULE || undefined,

      // How many repos this sweep may have in flight at once, across every
      // replica. The sweep fans out every repo it found in one call and lets
      // the queue hold them; this is what decides how many of them actually
      // run, and it is the only limit that survives the autoscaler changing
      // the replica count underneath it.
      //
      // Eight is a polite number of simultaneous requests to point at the
      // atmosphere from one sweep. Raise it in the environment when a sweep's
      // wall-clock starts to matter more than that politeness does.
      globalConcurrency: Number(fastify.env.ATPROTO_SYNC_MAX_IN_FLIGHT || 8) || undefined,
    });

    fastify.bullmq.worker("atproto-sync", async (job) => {
      switch (job.name) {
        case ENUMERATE_JOB:
          return enumerate(fastify, queue, job);
        case SYNC_REPO_JOB:
          return syncRepo(fastify, job);
        case FINALIZE_JOB:
          return finalize(fastify, job);
        default:
          throw new UnrecoverableError(`unknown job "${job.name}"`);
      }
    });
  },
  { name: "queue-atproto-sync", dependencies: ["bullmq", "db", "redis"] },
);
