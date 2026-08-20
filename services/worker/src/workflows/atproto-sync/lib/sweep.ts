import type { Pool } from "pg";
import type { SyncConfig } from "#/workflows/atproto-sync/lib/config.ts";
import { RECIPE_COLLECTION } from "#/workflows/atproto-sync/lib/config.ts";
import type { BatchOutcome, SweepSummary } from "#/workflows/atproto-sync/types.ts";
import { log } from "#/log.ts";
import { resolveIdentity } from "#/workflows/atproto-sync/lib/identity.ts";
import { getRepoRev, listRecords } from "#/workflows/atproto-sync/lib/pds.ts";
import { reconcileDeletes, toRecipeRow, upsertRecipe } from "#/workflows/atproto-sync/lib/recipe.ts";
import { deleteRenderedForDid, renderRecipe } from "#/workflows/atproto-sync/lib/render.ts";

/**
 * The mechanics of a sweep: what happens to one repo, and the bookkeeping rows
 * that record that a sweep happened. The *order* these run in is `workflow.ts`;
 * which of them an activity calls is `activities.ts`. Nothing in this file knows
 * that Temporal exists, and every function takes the pool it should use rather
 * than reaching for one.
 */

// --- atproto_repo bookkeeping SQL ---------------------------------------

// Discovery upsert: insert the DID (first_seen_at defaults to now); on a repeat
// sighting just clear missing_since (it's back / still present).
const UPSERT_REPO_SQL = `
insert into atproto_repo (did) values ($1)
on conflict (did) do update set missing_since = null
`;

// Cache the resolved PDS + handle. `handle` is a cache-only claim from the DID
// doc's alsoKnownAs (plan §2) — kept for display, re-resolved, never truth.
const CACHE_IDENTITY_SQL = `update atproto_repo set pds = $2, handle = $3 where did = $1`;

const MARK_SYNCED_SQL = `update atproto_repo set last_synced_at = now(), last_error = null where did = $1`;

const MARK_REPO_ERROR_SQL = `update atproto_repo set last_error = $2 where did = $1`;

const GET_CACHED_IDENTITY_SQL = `select pds, handle from atproto_repo where did = $1`;

// Mark DIDs that were NOT seen this (full) sweep as missing, first time only.
const MARK_MISSING_SQL = `
update atproto_repo
   set missing_since = now()
 where missing_since is null
   and did <> all($1::text[])
`;

// --- atproto_sync_run bookkeeping SQL -----------------------------------

const START_RUN_SQL = `insert into atproto_sync_run (status) values ('running') returning id`;

const FINISH_RUN_SQL = `
update atproto_sync_run set
  finished_at      = now(),
  status           = $2,
  repos_seen       = $3,
  records_upserted = $4,
  records_deleted  = $5,
  repos_failed     = $6,
  error            = $7
where id = $1
`;

// --- bookkeeping ---------------------------------------------------------

/** Open the run row. Returns its id, or null on a dry run (which writes nothing). */
export async function openSyncRun(pool: Pool, config: SyncConfig): Promise<string | null> {
  if (config.dryRun) return null;
  const started = await pool.query<{ id: string }>(START_RUN_SQL);
  return started.rows[0].id;
}

/**
 * Close the run row. Safe to call with a null id (a dry run, or a failure before
 * the row was opened) and never throws — bookkeeping must not be the thing that
 * turns a finished sweep into a failed run, nor mask the error that got here.
 */
export async function closeSyncRun(pool: Pool, syncRunId: string | null, summary: SweepSummary, error: string | null): Promise<void> {
  if (!syncRunId) return;
  await pool
    .query(FINISH_RUN_SQL, [syncRunId, error ? "error" : "ok", summary.reposSeen, summary.recordsUpserted, summary.recordsDeleted, summary.reposFailed, error])
    .catch((err: unknown) => {
      log.error("failed to close sync run row", { syncRunId, err: String(err) });
    });
}

/** Record every discovered DID, which also clears any `missing_since` on it. */
export async function registerRepos(pool: Pool, dids: string[]): Promise<void> {
  for (const did of dids) await pool.query(UPSERT_REPO_SQL, [did]);
}

/**
 * Flag DIDs that dropped out of enumeration. Candidates for later cleanup —
 * enumeration is best-available, not provably complete, so this is a flag and
 * not a purge (plan §2 atproto_repo notes). Full sweeps only; the caller decides.
 */
export async function markMissingRepos(pool: Pool, dids: string[]): Promise<number> {
  const missing = await pool.query(MARK_MISSING_SQL, [dids]);
  return missing.rowCount ?? 0;
}

// --- concurrency pool ----------------------------------------------------

/** Run `worker` over `items` with at most `concurrency` in flight. */
export async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
}

// --- per-DID sweep -------------------------------------------------------

export interface RepoOutcome {
  upserted: number;
  deleted: number;
  failed: boolean;
}

export async function sweepDid(pool: Pool, config: SyncConfig, did: string): Promise<RepoOutcome> {
  const outcome: RepoOutcome = { upserted: 0, deleted: 0, failed: false };
  try {
    // Resolve identity (PDS + handle), preferring the cached values. Re-resolve
    // when either is missing so a repo cached before handles were tracked
    // backfills its handle on the next sweep.
    const cached = await pool.query<{ pds: string | null; handle: string | null }>(GET_CACHED_IDENTITY_SQL, [did]);
    let pds = cached.rows[0]?.pds ?? null;
    let handle = cached.rows[0]?.handle ?? null;
    if (!pds || !handle) {
      const identity = await resolveIdentity(did);
      pds = identity.pds;
      handle = identity.handle ?? handle;
      if (!config.dryRun) await pool.query(CACHE_IDENTITY_SQL, [did, pds, handle]);
    }

    const rev = await getRepoRev(pds, did);
    const records = await listRecords(pds, did, RECIPE_COLLECTION);
    const seenRkeys: string[] = [];

    // One dedicated client per DID so this DID's writes never interleave with
    // another's (plan §1 "Never interleave writes for the same DID").
    const client = await pool.connect();
    try {
      for (const rec of records) {
        const row = toRecipeRow(did, RECIPE_COLLECTION, rev, rec);
        if (!row) continue;
        seenRkeys.push(row.rkey);
        if (config.dryRun) {
          outcome.upserted++; // would-upsert
          continue;
        }
        outcome.upserted += await upsertRecipe(client, row);
        // Render the normalized/search layer on the same client (never
        // interleave a DID's writes). Rev-guarded internally; local rows exempt.
        await renderRecipe(client, row);
      }
    } finally {
      client.release();
    }

    // Reconcile deletes only after a fully-successful enumeration for this DID:
    // soft-delete the raw rows, hard-delete the rendered rows (children cascade).
    if (!config.dryRun) {
      outcome.deleted = await reconcileDeletes(pool, did, seenRkeys);
      await deleteRenderedForDid(pool, did, seenRkeys);
      await pool.query(MARK_SYNCED_SQL, [did]);
    }

    log.info("repo synced", { did, records: records.length, upserted: outcome.upserted, deleted: outcome.deleted });
  } catch (err) {
    outcome.failed = true;
    const message = String(err);
    log.error("repo sweep failed", { did, err: message });
    if (!config.dryRun) {
      // Best-effort; don't let bookkeeping failure mask the real error.
      await pool.query(MARK_REPO_ERROR_SQL, [did, message]).catch(() => {});
    }
  }
  return outcome;
}

// --- one batch of repos --------------------------------------------------

/**
 * Sweep a slice of the network: register the DIDs, then page and upsert each
 * one, `SYNC_CONCURRENCY` at a time.
 *
 * A repo that fails does not fail the batch. Its error goes to
 * `atproto_repo.last_error` and its count to `reposFailed`, because one repo
 * whose PDS is down should not cost the reconciliation of every other repo — and
 * an hourly sweep that fails whenever any one of thousands of servers is
 * unreachable would simply always be failing. What *does* fail the batch is the
 * database going away underneath it, which is exactly the case worth retrying.
 *
 * `onRepo` is called after each DID. The activity uses it to heartbeat, which is
 * how Temporal tells "still working through 200 repos" from "the worker died
 * ten minutes ago".
 */
export async function sweepRepos(pool: Pool, config: SyncConfig, dids: string[], onRepo?: (done: number, total: number) => void): Promise<BatchOutcome> {
  const outcome: BatchOutcome = { recordsUpserted: 0, recordsDeleted: 0, reposFailed: 0 };
  if (!config.dryRun) await registerRepos(pool, dids);

  let done = 0;
  await runPool(dids, config.concurrency, async (did) => {
    const repo = await sweepDid(pool, config, did);
    outcome.recordsUpserted += repo.upserted;
    outcome.recordsDeleted += repo.deleted;
    if (repo.failed) outcome.reposFailed++;
    done++;
    onRepo?.(done, dids.length);
  });

  return outcome;
}
