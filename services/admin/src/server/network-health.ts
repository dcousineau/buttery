import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "./session";

/**
 * The sweep's own vital signs: which repos we track, and how the last sweeps
 * went. Both tables are written by `services/atproto-cron-sync`; the admin only
 * reads them.
 *
 * This is the page you open when the network browser looks wrong. A record that
 * is stale on every repo is a sweep problem; one stale repo with a `last_error`
 * is a PDS problem. Neither question can be answered from the record index
 * alone, which is why these live beside it rather than in it.
 */

/** One tracked atproto repo. */
export interface RepoRow {
  did: string;
  handle: string | null;
  pds: string | null;
  status: string;
  first_seen_at: string;
  last_synced_at: string | null;
  missing_since: string | null;
  last_error: string | null;
  record_count: number;
  live_record_count: number;
}

export const listRepos = createServerFn({ method: "GET" })
  .validator((data: unknown) =>
    z
      .object({
        search: z.string().max(200).optional(),
        status: z.string().max(50).optional(),
        /** Only repos whose last sweep failed — the triage view. */
        erroredOnly: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      })
      .parse(data ?? {}),
  )
  .handler(async ({ data }): Promise<{ rows: RepoRow[]; total: number }> => {
    await requireAdmin();
    const { getDb } = await import("#/lib/db");
    const db = getDb();

    // One filtered builder, two selects — the page and the count cannot drift.
    let filtered = db.selectFrom("atproto_repo as repo");

    // A repo is addressed by either name an operator might have to hand: the
    // handle they read in the app, or the DID they copied from a URI.
    if (data.search) {
      const like = `%${data.search}%`;
      filtered = filtered.where((eb) => eb.or([eb("repo.handle", "ilike", like), eb("repo.did", "ilike", like)]));
    }
    if (data.status) filtered = filtered.where("repo.status", "=", data.status);
    if (data.erroredOnly) filtered = filtered.where("repo.last_error", "is not", null);

    const rows = await filtered
      .select((eb) => [
        "repo.did",
        "repo.handle",
        "repo.pds",
        "repo.status",
        "repo.first_seen_at",
        "repo.last_synced_at",
        "repo.missing_since",
        "repo.last_error",
        eb
          .selectFrom("atproto_collection_recipe as acr")
          .whereRef("acr.did", "=", "repo.did")
          .select((inner) => inner.fn.countAll<string>().as("count"))
          .as("record_count"),
        eb
          .selectFrom("atproto_collection_recipe as acr")
          .whereRef("acr.did", "=", "repo.did")
          .where("acr.deleted_at", "is", null)
          .select((inner) => inner.fn.countAll<string>().as("count"))
          .as("live_record_count"),
      ])
      .orderBy("repo.last_synced_at", (ob) => ob.desc().nullsLast())
      .orderBy("repo.did", "asc")
      .limit(data.limit)
      .offset(data.offset)
      .execute();

    const counted = await filtered.select((eb) => eb.fn.countAll<string>().as("total")).executeTakeFirst();

    return {
      rows: rows.map((row) => ({
        did: row.did,
        handle: row.handle,
        pds: row.pds,
        status: row.status,
        first_seen_at: new Date(row.first_seen_at).toISOString(),
        last_synced_at: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
        missing_since: row.missing_since ? new Date(row.missing_since).toISOString() : null,
        last_error: row.last_error,
        record_count: Number(row.record_count ?? 0),
        live_record_count: Number(row.live_record_count ?? 0),
      })),
      total: Number(counted?.total ?? 0),
    };
  });

/** One sweep. */
export interface SyncRunRow {
  id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  repos_seen: number;
  records_upserted: number;
  records_deleted: number;
  repos_failed: number;
  error: string | null;
}

export const listSyncRuns = createServerFn({ method: "GET" })
  .validator((data: unknown) => z.object({ limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }).parse(data ?? {}))
  .handler(async ({ data }): Promise<{ rows: SyncRunRow[]; total: number }> => {
    await requireAdmin();
    const { getDb } = await import("#/lib/db");
    const db = getDb();

    const [rows, counted] = await Promise.all([
      db.selectFrom("atproto_sync_run").selectAll().orderBy("started_at", "desc").limit(data.limit).offset(data.offset).execute(),
      db
        .selectFrom("atproto_sync_run")
        .select((eb) => eb.fn.countAll<string>().as("total"))
        .executeTakeFirst(),
    ]);

    return {
      rows: rows.map((row) => {
        const started = new Date(row.started_at);
        const finished = row.finished_at ? new Date(row.finished_at) : null;
        return {
          id: String(row.id),
          status: row.status,
          started_at: started.toISOString(),
          finished_at: finished ? finished.toISOString() : null,
          duration_ms: finished ? finished.getTime() - started.getTime() : null,
          repos_seen: row.repos_seen,
          records_upserted: row.records_upserted,
          records_deleted: row.records_deleted,
          repos_failed: row.repos_failed,
          error: row.error,
        };
      }),
      total: Number(counted?.total ?? 0),
    };
  });
