import type { Pool } from "pg";
import type { Config } from "#/config.ts";
import { RECIPE_COLLECTION } from "#/config.ts";
import { getPool } from "#/db.ts";
import { log } from "#/log.ts";
import { enumerateDids, enumerateDidsFromPds } from "#/relay.ts";
import { resolveIdentity } from "#/identity.ts";
import { getRepoRev, listRecords } from "#/pds.ts";
import { reconcileDeletes, toRecipeRow, upsertRecipe } from "#/recipe.ts";
import { deleteRenderedForDid, renderRecipe } from "#/render.ts";

export interface SweepSummary {
  syncRunId: string | null;
  status: "ok" | "error";
  reposSeen: number;
  recordsUpserted: number;
  recordsDeleted: number;
  reposFailed: number;
  dryRun: boolean;
}

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

// --- concurrency pool ----------------------------------------------------

/** Run `worker` over `items` with at most `concurrency` in flight. */
async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
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

interface RepoOutcome {
  upserted: number;
  deleted: number;
  failed: boolean;
}

async function sweepDid(pool: Pool, config: Config, did: string): Promise<RepoOutcome> {
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

// --- orchestration -------------------------------------------------------

export async function runSweep(config: Config): Promise<SweepSummary> {
  const pool = getPool(config.databaseUrl);

  // Enumerate the DIDs to sweep.
  const dids: string[] = [];
  if (config.onlyDid) {
    dids.push(config.onlyDid);
    log.info("single-did sweep", { did: config.onlyDid });
  } else if (config.pdsListUrl) {
    // Local dev: one PDS's repo list stands in for the relay (see relay.ts).
    for await (const did of enumerateDidsFromPds(config.pdsListUrl, config.maxRepos)) {
      dids.push(did);
    }
    log.info("enumerated repos from pds", { pds: config.pdsListUrl, count: dids.length });
  } else {
    for await (const did of enumerateDids(config.relayUrl, RECIPE_COLLECTION, config.maxRepos)) {
      dids.push(did);
    }
    log.info("enumerated repos", { count: dids.length });
  }

  // A partial sweep (onlyDid / maxRepos / a single PDS) must NOT drive
  // missing/delete-wide reconciliation — it hasn't observed the whole network.
  const fullSweep = !config.onlyDid && !config.maxRepos && !config.pdsListUrl;

  let syncRunId: string | null = null;
  if (!config.dryRun) {
    const started = await pool.query<{ id: string }>(START_RUN_SQL);
    syncRunId = started.rows[0].id;
  }

  const summary: SweepSummary = {
    syncRunId,
    status: "ok",
    reposSeen: dids.length,
    recordsUpserted: 0,
    recordsDeleted: 0,
    reposFailed: 0,
    dryRun: config.dryRun,
  };

  try {
    // Upsert every discovered DID before sweeping (clears missing_since).
    if (!config.dryRun) {
      for (const did of dids) await pool.query(UPSERT_REPO_SQL, [did]);
    }

    await runPool(dids, config.concurrency, async (did) => {
      const outcome = await sweepDid(pool, config, did);
      summary.recordsUpserted += outcome.upserted;
      summary.recordsDeleted += outcome.deleted;
      if (outcome.failed) summary.reposFailed++;
    });

    // Mark DIDs that dropped out of enumeration this full sweep (candidates
    // for later cleanup — enumeration is best-available, not provably complete,
    // so this is a flag, not a purge; plan §2 atproto_repo notes).
    if (fullSweep && !config.dryRun) {
      const missing = await pool.query(MARK_MISSING_SQL, [dids]);
      log.info("marked missing repos", { count: missing.rowCount ?? 0 });
    }

    if (!config.dryRun && syncRunId) {
      await pool.query(FINISH_RUN_SQL, [syncRunId, "ok", summary.reposSeen, summary.recordsUpserted, summary.recordsDeleted, summary.reposFailed, null]);
    }
  } catch (err) {
    summary.status = "error";
    const message = String(err);
    if (!config.dryRun && syncRunId) {
      await pool.query(FINISH_RUN_SQL, [syncRunId, "error", summary.reposSeen, summary.recordsUpserted, summary.recordsDeleted, summary.reposFailed, message]).catch(() => {});
    }
    throw err;
  }

  return summary;
}
