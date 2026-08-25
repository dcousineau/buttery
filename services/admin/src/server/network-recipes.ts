import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "./session";
import { loadAnnotations, type AnnotationSet } from "./annotations";
import { loadLocalRecipeByRecord, type LocalRecipeDetail } from "./local-recipes";
import { toJsonRow, toJsonValue, type JsonValue } from "./json";

/**
 * The NETWORK side: `public.atproto_collection_recipe`, the cron sweep's index
 * of `exchange.recipe.recipe` records seen on atproto, read raw.
 *
 * Everything here is a *pass-through*. No field is normalised, renamed or
 * merged with the local copy — `validation_status` comes back as the sweep
 * wrote it, `record` comes back byte-for-byte as the PDS served it. The app's
 * read path already does the resolving; this view exists because that resolving
 * is exactly what hides the problems an operator is looking for.
 *
 * Pagination, sorting and filtering are all server-side. The index is unbounded
 * — it grows with the network, not with our users — so a client-side table over
 * "all rows" is a page that gets slower every week. The sortable columns are a
 * closed enum for the same reason every raw-SQL order-by is: an unvalidated
 * sort key is an injection.
 */

const did = z.string().min(1).max(2048);
const rkey = z.string().min(1).max(512);

/** Columns the list view can sort on, mapped to their qualified SQL name. */
const SORT_COLUMNS = {
  indexed_at: "acr.indexed_at",
  record_updated_at: "acr.record_updated_at",
  record_created_at: "acr.record_created_at",
  name: "acr.name",
  did: "acr.did",
} as const;

export type NetworkSortColumn = keyof typeof SORT_COLUMNS;

/** One row of the raw network browser. */
export interface NetworkRecipeRow {
  did: string;
  rkey: string;
  collection: string;
  uri: string;
  cid: string;
  rev: string;
  name: string | null;
  validation_status: string;
  record_created_at: string | null;
  record_updated_at: string | null;
  indexed_at: string;
  deleted_at: string | null;
  /** From `atproto_repo` — the repo this record lives in. */
  handle: string | null;
  pds: string | null;
  repo_status: string | null;
  /** Non-null when a `public.recipe` row is published as this exact record. */
  local_recipe_id: string | null;
  local_origin: string | null;
  /** How many observed revisions we hold (see the admin revision trigger). */
  revision_count: number;
  /** When the record last actually changed, as opposed to when we last swept. */
  last_change_at: string | null;
}

const listInput = z.object({
  search: z.string().max(200).optional(),
  did: did.optional(),
  validation: z.enum(["all", "valid", "invalid", "unknown"]).default("all"),
  presence: z.enum(["live", "deleted", "all"]).default("live"),
  /** `both` = also has a local row; `network-only` = the sweep found an orphan. */
  pairing: z.enum(["all", "both", "network-only"]).default("all"),
  sort: z.enum(["indexed_at", "record_updated_at", "record_created_at", "name", "did"]).default("indexed_at"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

export const listNetworkRecipes = createServerFn({ method: "GET" })
  .validator((data: unknown) => listInput.parse(data ?? {}))
  .handler(async ({ data }): Promise<{ rows: NetworkRecipeRow[]; total: number }> => {
    await requireAdmin();
    const { getDb } = await import("#/lib/db");
    const db = getDb();

    // ONE filtered query, two different `select`s off it. Building the page and
    // the count from the same `filtered` builder is what makes the footer's
    // "N of M" structurally unable to disagree with the rows above it — a second
    // hand-maintained predicate is where that drifts.
    //
    // Both joins are on the base rather than only on the page query, so the
    // count sees the same rows. Neither can multiply them: `atproto_repo.did` is
    // the primary key, and `recipe (did, rkey)` is unique (`recipe_did_rkey_key`).
    let filtered = db
      .selectFrom("atproto_collection_recipe as acr")
      .leftJoin("atproto_repo as repo", "repo.did", "acr.did")
      .leftJoin("recipe as r", (join) => join.onRef("r.did", "=", "acr.did").onRef("r.rkey", "=", "acr.rkey"));

    if (data.search) filtered = filtered.where("acr.name", "ilike", `%${data.search}%`);
    if (data.did) filtered = filtered.where("acr.did", "=", data.did);
    if (data.validation !== "all") filtered = filtered.where("acr.validation_status", "=", data.validation);
    if (data.presence === "live") filtered = filtered.where("acr.deleted_at", "is", null);
    if (data.presence === "deleted") filtered = filtered.where("acr.deleted_at", "is not", null);
    if (data.pairing === "both") filtered = filtered.where("r.id", "is not", null);
    if (data.pairing === "network-only") filtered = filtered.where("r.id", "is", null);

    const rows = await filtered
      .select((eb) => [
        "acr.did",
        "acr.rkey",
        "acr.collection",
        "acr.uri",
        "acr.cid",
        "acr.rev",
        "acr.name",
        "acr.validation_status",
        "acr.record_created_at",
        "acr.record_updated_at",
        "acr.indexed_at",
        "acr.deleted_at",
        "repo.handle",
        "repo.pds",
        "repo.status as repo_status",
        "r.id as local_recipe_id",
        "r.origin as local_origin",
        eb
          .selectFrom("admin.atproto_record_revision as rev")
          .whereRef("rev.did", "=", "acr.did")
          .whereRef("rev.rkey", "=", "acr.rkey")
          .select((inner) => inner.fn.countAll<string>().as("count"))
          .as("revision_count"),
        eb
          .selectFrom("admin.atproto_record_revision as rev")
          .whereRef("rev.did", "=", "acr.did")
          .whereRef("rev.rkey", "=", "acr.rkey")
          .where("rev.action", "!=", "backfill")
          .select((inner) => inner.fn.max("rev.observed_at").as("at"))
          .as("last_change_at"),
      ])
      // `nulls last` matters here: an unvalidated or never-published record has
      // a null `record_updated_at`, and Postgres sorts nulls FIRST on `desc` —
      // so "most recently updated" would open on a page of records that have no
      // update time at all.
      .orderBy(SORT_COLUMNS[data.sort], (ob) => (data.dir === "asc" ? ob.asc().nullsLast() : ob.desc().nullsLast()))
      .orderBy("acr.did", "asc")
      .orderBy("acr.rkey", "asc")
      .limit(data.limit)
      .offset(data.offset)
      .execute();

    const counted = await filtered.select((eb) => eb.fn.countAll<string>().as("total")).executeTakeFirst();

    return {
      rows: rows.map((row) => ({
        did: row.did,
        rkey: row.rkey,
        collection: row.collection,
        uri: row.uri,
        cid: row.cid,
        rev: row.rev,
        name: row.name,
        validation_status: row.validation_status,
        record_created_at: row.record_created_at ? new Date(row.record_created_at).toISOString() : null,
        record_updated_at: row.record_updated_at ? new Date(row.record_updated_at).toISOString() : null,
        indexed_at: new Date(row.indexed_at).toISOString(),
        deleted_at: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
        handle: row.handle,
        pds: row.pds,
        repo_status: row.repo_status,
        local_recipe_id: row.local_recipe_id,
        local_origin: row.local_origin,
        revision_count: Number(row.revision_count ?? 0),
        last_change_at: row.last_change_at ? new Date(row.last_change_at).toISOString() : null,
      })),
      total: Number(counted?.total ?? 0),
    };
  });

/** One observed revision of a record. See the admin revision-history migration. */
export interface RecordRevision {
  id: string;
  action: string;
  cid: string;
  rev: string;
  name: string | null;
  record: JsonValue;
  record_created_at: string | null;
  record_updated_at: string | null;
  validation_status: string | null;
  observed_at: string;
}

export interface NetworkRecipeDetail {
  /** The current index row, every column of it. */
  record: Record<string, JsonValue> | null;
  /** The `atproto_repo` row the record belongs to. */
  repo: Record<string, JsonValue> | null;
  /** Observed revisions, newest first. */
  revisions: RecordRevision[];
  /** The local copy of the same recipe, if there is one. Null is a real answer. */
  local: LocalRecipeDetail | null;
  annotations: AnnotationSet;
}

/**
 * Everything about one record, from every angle we have.
 *
 * `record` and `local` are BOTH returned and neither is preferred — a null
 * `local` means "the network has a record nothing here mirrors", a null
 * `record` means "we hold a local recipe claiming a `(did, rkey)` the sweep has
 * never seen", and both of those are findings rather than errors.
 */
export const getNetworkRecipe = createServerFn({ method: "GET" })
  .validator((data: unknown) => z.object({ did, rkey }).parse(data))
  .handler(async ({ data }): Promise<NetworkRecipeDetail> => {
    await requireAdmin();
    const { getDb } = await import("#/lib/db");
    const db = getDb();

    const [record, repo, revisions, local] = await Promise.all([
      db.selectFrom("atproto_collection_recipe").selectAll().where("did", "=", data.did).where("rkey", "=", data.rkey).executeTakeFirst(),
      db.selectFrom("atproto_repo").selectAll().where("did", "=", data.did).executeTakeFirst(),
      db
        .selectFrom("admin.atproto_record_revision")
        .select(["id", "action", "cid", "rev", "name", "record", "record_created_at", "record_updated_at", "validation_status", "observed_at"])
        .where("did", "=", data.did)
        .where("rkey", "=", data.rkey)
        .orderBy("observed_at", "desc")
        .orderBy("id", "desc")
        // A record that flaps would otherwise render an unbounded table. 200 is
        // far past the point where a human reads rows one by one, and the count
        // in the list view still reports the true total.
        .limit(200)
        .execute(),
      loadLocalRecipeByRecord(data.did, data.rkey),
    ]);

    const annotations = await loadAnnotations({ recipeId: (local?.tables.recipe.id as string | undefined) ?? null, did: data.did, rkey: data.rkey });

    return {
      record: record ? toJsonRow(record) : null,
      repo: repo ? toJsonRow(repo) : null,
      revisions: revisions.map((row) => ({
        id: String(row.id),
        action: row.action,
        cid: row.cid,
        rev: row.rev,
        name: row.name,
        record: toJsonValue(row.record),
        record_created_at: row.record_created_at ? new Date(row.record_created_at).toISOString() : null,
        record_updated_at: row.record_updated_at ? new Date(row.record_updated_at).toISOString() : null,
        validation_status: row.validation_status,
        observed_at: new Date(row.observed_at).toISOString(),
      })),
      local,
      annotations,
    };
  });

/** A cross-network feed of what the sweep has seen change lately. */
export interface NetworkChangeRow {
  id: string;
  did: string;
  rkey: string;
  action: string;
  name: string | null;
  cid: string;
  rev: string;
  observed_at: string;
  handle: string | null;
}

export const listNetworkChanges = createServerFn({ method: "GET" })
  .validator((data: unknown) =>
    z
      .object({
        // `backfill` rows all share one timestamp and would drown a feed whose
        // whole purpose is "what changed"; they are excluded unless asked for.
        includeBackfill: z.boolean().default(false),
        action: z.enum(["all", "created", "updated", "deleted", "restored"]).default("all"),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      })
      .parse(data ?? {}),
  )
  .handler(async ({ data }): Promise<{ rows: NetworkChangeRow[]; total: number }> => {
    await requireAdmin();
    const { getDb } = await import("#/lib/db");
    const db = getDb();

    // Same shape as `listNetworkRecipes`: one filtered builder, two selects.
    // `atproto_repo.did` is a primary key, so the join cannot multiply rows and
    // the count query can share it.
    let filtered = db.selectFrom("admin.atproto_record_revision as rev").leftJoin("atproto_repo as repo", "repo.did", "rev.did");

    if (!data.includeBackfill) filtered = filtered.where("rev.action", "!=", "backfill");
    if (data.action !== "all") filtered = filtered.where("rev.action", "=", data.action);

    const rows = await filtered
      .select(["rev.id", "rev.did", "rev.rkey", "rev.action", "rev.name", "rev.cid", "rev.rev", "rev.observed_at", "repo.handle"])
      .orderBy("rev.observed_at", "desc")
      .orderBy("rev.id", "desc")
      .limit(data.limit)
      .offset(data.offset)
      .execute();

    const counted = await filtered.select((eb) => eb.fn.countAll<string>().as("total")).executeTakeFirst();

    return {
      rows: rows.map((row) => ({
        id: String(row.id),
        did: row.did,
        rkey: row.rkey,
        action: row.action,
        name: row.name,
        cid: row.cid,
        rev: row.rev,
        observed_at: new Date(row.observed_at).toISOString(),
        handle: row.handle,
      })),
      total: Number(counted?.total ?? 0),
    };
  });
