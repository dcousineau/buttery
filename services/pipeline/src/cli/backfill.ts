import type { Pool } from "pg";
import type { Queue } from "bullmq";
import { buildApp } from "#/app.ts";
import { CLASSIFIER_VERSION } from "@buttery/food/classify";
import { LLM_ENRICHMENT_VERSION } from "@buttery/food/llm";
import { ENRICH_JOB, enrichJobId, LLM_ENRICH_JOB, llmEnrichJobId, RECIPE_ENRICHMENT_QUEUE } from "@buttery/pipeline-contract";
import { claimBatch, claimLlmBatch, DEFAULT_BACKFILL_LIMIT, MAX_BACKFILL_LIMIT } from "#/queues/recipe-enrichment/lib/load.ts";
import { ENRICH_JOB_OPTIONS, LLM_ENRICH_JOB_OPTIONS } from "#/queues/recipe-enrichment/index.ts";

/**
 * Enqueue enrichment for the whole corpus, a bounded wave at a time.
 *
 *   pnpm --filter @buttery/pipeline backfill [flags]        # the rules pass
 *   pnpm --filter @buttery/pipeline backfill --llm [flags]  # the LLM second opinion
 *
 * This is the production caller `claimBatch`/`claimLlmBatch` were written for
 * and never got. Like `trigger.ts` it only ENQUEUES — `buildApp("cli")` builds
 * no `Worker`s, so nothing here classifies anything. The work happens on the
 * worker fleet, under its own concurrency cap and retries, and you watch it in
 * Bull Board.
 *
 * ── WHY WAVES, AND NOT ONE PASS ────────────────────────────────────────────
 *
 * The claim queries are pure SELECTs: they mark nothing, so re-running one
 * before the fleet has drained returns the same ids again. There is also no
 * cursor to page with — the claim is a staleness predicate, not an offset —
 * and the only thing that removes a recipe from it is that recipe actually
 * being enriched. So the loop is: claim a batch, enqueue it, wait for the
 * backlog to fall to `--drain-to`, claim again. Convergence comes from the
 * work completing, not from bookkeeping this process holds.
 *
 * Re-claiming is cheap rather than merely tolerable, which is what makes that
 * shape affordable: `enrichJobId`/`llmEnrichJobId` are deterministic, so a
 * duplicate `queue.add` for a recipe already in flight returns the existing
 * job instead of running it twice.
 *
 * The same property is why `--force` removes the id first. BullMQ's dedupe is
 * not scoped to waiting jobs — a completed job still occupying that id
 * silently swallows the add — so a forced re-run without the `remove` would
 * enqueue nothing at all. `remove` no-ops on a missing id and refuses to touch
 * an active job, both of which are what we want.
 *
 * ── STALLING ───────────────────────────────────────────────────────────────
 *
 * A recipe that fails permanently (a bad ingredient row, an unseeded vocab
 * slug) stays a candidate forever, so "claim until empty" alone would spin.
 * When a wave claims nothing this process has not already enqueued AND the
 * backlog is drained, the remainder is stuck rather than pending: the run
 * stops and prints the ids so `recipe_enrichment.error` can be read for them.
 *
 * ── RUNNING IT WITH THE LLM FLAG OFF ───────────────────────────────────────
 *
 * That is the intended order, not a limitation. Every `enrich` hands off to
 * `llm-enrich` unconditionally; with `LLM_ENRICHMENT_ENABLED` off, the gate
 * fails closed and each of those marks the recipe `llm_status = 'skipped'`
 * without calling a model — one env read and one upsert per recipe, no
 * tokens. Crucially `markLlmSkipped` leaves `llm_version` alone, so it stays
 * below `LLM_ENRICHMENT_VERSION`, and the FIRST non-force `--llm` run after
 * you flip the flag on reclaims every one of them. Backfill rules now, flip
 * the flag when you are ready, then run `--llm` — no `--force` needed to undo
 * the skips.
 */

interface Options {
  llm: boolean;
  limit: number;
  max: number;
  force: boolean;
  localOnly: boolean;
  dryRun: boolean;
  drainTo: number;
  pollMs: number;
}

const DEFAULT_DRAIN_TO = 50;
const DEFAULT_POLL_SECONDS = 5;

function parseArgv(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) flags.set(arg.slice(2), "true");
    else flags.set(arg.slice(2, eq), arg.slice(eq + 1));
  }
  const num = (name: string, fallback: number): number => {
    const raw = flags.get(name);
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    llm: flags.has("llm"),
    // Clamped the same way `claimBatch` clamps it, so the number this prints
    // is the number the query will use rather than the one you asked for.
    limit: Math.min(Math.max(1, Math.floor(num("limit", DEFAULT_BACKFILL_LIMIT))), MAX_BACKFILL_LIMIT),
    max: Math.max(0, Math.floor(num("max", Number.POSITIVE_INFINITY))) || Number.POSITIVE_INFINITY,
    force: flags.has("force"),
    localOnly: flags.has("local-only"),
    dryRun: flags.has("dry-run"),
    drainTo: Math.max(0, Math.floor(num("drain-to", DEFAULT_DRAIN_TO))),
    pollMs: Math.max(1, num("poll-seconds", DEFAULT_POLL_SECONDS)) * 1000,
  };
}

/** Jobs this backfill still owes the fleet: everything not yet completed or failed. */
async function backlog(queue: Queue): Promise<number> {
  const counts = await queue.getJobCounts("waiting", "active", "delayed", "prioritized");
  return Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const opts = parseArgv(process.argv.slice(2));

  const app = await buildApp("cli");
  await app.ready();

  const registration = app.bullmq.get(RECIPE_ENRICHMENT_QUEUE);
  if (!registration) {
    app.log.error({ queue: RECIPE_ENRICHMENT_QUEUE }, "queue is not registered");
    process.exitCode = 2;
    await app.close();
    return;
  }
  const queue = registration.queue;
  const pool: Pool = app.db;

  const jobName = opts.llm ? LLM_ENRICH_JOB : ENRICH_JOB;
  const jobOptions = opts.llm ? LLM_ENRICH_JOB_OPTIONS : ENRICH_JOB_OPTIONS;
  const jobIdFor = opts.llm ? llmEnrichJobId : enrichJobId;
  const claim = (): Promise<{ ids: string[]; remaining: number }> =>
    opts.llm
      ? claimLlmBatch(pool, { llmVersion: LLM_ENRICHMENT_VERSION, limit: opts.limit, force: opts.force, localOnly: opts.localOnly })
      : claimBatch(pool, { classifierVersion: CLASSIFIER_VERSION, limit: opts.limit, force: opts.force, localOnly: opts.localOnly });

  app.log.info(
    {
      job: jobName,
      version: opts.llm ? LLM_ENRICHMENT_VERSION : CLASSIFIER_VERSION,
      limit: opts.limit,
      max: opts.max === Number.POSITIVE_INFINITY ? null : opts.max,
      force: opts.force,
      localOnly: opts.localOnly,
      dryRun: opts.dryRun,
      drainTo: opts.drainTo,
    },
    "backfill starting",
  );

  // Ctrl-C stops CLAIMING. Everything already enqueued keeps running on the
  // fleet — there is nothing to roll back, and killing in-flight jobs to
  // honour a Ctrl-C would be worse than letting them finish.
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      app.log.warn({ signal }, "stopping after this wave — jobs already enqueued will still run");
    });
  }

  const enqueued = new Set<string>();
  let waves = 0;
  let stalled: string[] = [];

  try {
    while (!stopping && enqueued.size < opts.max) {
      const { ids, remaining } = await claim();
      if (ids.length === 0) break;

      waves += 1;
      const fresh = ids.filter((id) => !enqueued.has(id));

      if (opts.dryRun) {
        app.log.info({ wave: waves, claimed: ids.length, remaining, sample: ids.slice(0, 5) }, "dry run — nothing enqueued");
        break;
      }

      // Re-enqueue the whole claim, not just `fresh`: an id we sent in an
      // earlier wave whose job has since completed and aged out of the
      // `removeOnComplete` window is a genuine retry, and one whose job is
      // still around is a free no-op. Only the `--max` budget counts `fresh`.
      const budget = opts.max - enqueued.size;
      const sending = Number.isFinite(opts.max) ? ids.slice(0, budget) : ids;
      for (const recipeId of sending) {
        const jobId = jobIdFor(recipeId);
        if (opts.force) await queue.remove(jobId);
        await queue.add(jobName, { recipeId, force: opts.force }, { ...jobOptions, jobId });
        enqueued.add(recipeId);
      }

      const pending = await backlog(queue);
      app.log.info({ wave: waves, claimed: ids.length, new: fresh.length, enqueued: enqueued.size, remaining, backlog: pending }, "wave enqueued");

      // Nothing new to give the fleet and nothing left for it to do: whatever
      // the claim still matches is failing rather than waiting.
      if (fresh.length === 0 && pending <= opts.drainTo) {
        stalled = ids;
        break;
      }

      while (!stopping && (await backlog(queue)) > opts.drainTo) {
        await sleep(opts.pollMs);
      }
    }

    if (stalled.length > 0) {
      app.log.warn(
        { stuck: stalled.length, sample: stalled.slice(0, 10) },
        "backfill stopped: these recipes stay claimable after being enqueued and drained — read recipe_enrichment.error for them",
      );
      process.exitCode = 1;
    } else {
      app.log.info({ waves, enqueued: enqueued.size, stopped: stopping }, "backfill done");
    }
  } catch (err) {
    app.log.error({ err: String(err) }, "backfill failed — is a pipeline server up and reachable?");
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

await main();
