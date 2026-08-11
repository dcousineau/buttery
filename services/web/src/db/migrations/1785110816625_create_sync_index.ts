import { type Kysely, sql } from "kysely";

/**
 * The atproto → Postgres sync index. Three tables owned here (web owns DDL;
 * the `atproto-cron-sync` service is a pure raw-`pg` writer). See
 * `docs/plans/01-atproto-cron-sync-service.md` §2.
 *
 *   - `atproto_repo`               — one row per tracked DID (discovery + PDS cache)
 *   - `atproto_collection_recipe`  — the record index the web app browses
 *   - `atproto_sync_run`           — per-sweep observability / drift alarm
 *
 * App-owned tables use snake_case and are prefixed `atproto_` — this is raw
 * storage of atproto records mirrored for sync (the camelCase better-auth
 * tables in the initial migration are forced by better-auth, not the
 * convention).
 *
 * `Kysely<any>` is intentional: migrations are frozen in time and must not
 * track the evolving `DB` interface.
 */

// Column default: `now()`.
const now = sql`now()`;

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // one row per tracked DID
  await db.schema
    .createTable("atproto_repo")
    .addColumn("did", "text", (col) => col.primaryKey())
    .addColumn("pds", "text")
    .addColumn("handle", "text")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("active"))
    .addColumn("first_seen_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("last_synced_at", "timestamptz")
    .addColumn("missing_since", "timestamptz")
    .addColumn("last_error", "text")
    .execute();

  await db.schema.createIndex("atproto_repo_status_idx").on("atproto_repo").column("status").execute();

  // the record index (the table web browses)
  await db.schema
    .createTable("atproto_collection_recipe")
    .addColumn("did", "text", (col) => col.notNull())
    .addColumn("rkey", "text", (col) => col.notNull())
    .addColumn("collection", "text", (col) => col.notNull().defaultTo("exchange.recipe.recipe"))
    .addColumn("uri", "text", (col) => col.notNull())
    .addColumn("cid", "text", (col) => col.notNull())
    .addColumn("rev", "text", (col) => col.notNull())
    .addColumn("record", "jsonb", (col) => col.notNull())
    .addColumn("name", "text")
    .addColumn("record_created_at", "timestamptz")
    .addColumn("record_updated_at", "timestamptz")
    .addColumn("validation_status", "text", (col) => col.notNull().defaultTo("unknown"))
    .addColumn("indexed_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("deleted_at", "timestamptz")
    // PK is (did, rkey); include `collection` only if a second collection ever
    // shares this table (see plan §7).
    .addPrimaryKeyConstraint("atproto_collection_recipe_pkey", ["did", "rkey"])
    .execute();

  await db.schema.createIndex("atproto_collection_recipe_name_idx").on("atproto_collection_recipe").column("name").execute();
  await db.schema.createIndex("atproto_collection_recipe_indexed_at_idx").on("atproto_collection_recipe").column("indexed_at").execute();
  // The live set — most browse queries filter to non-deleted rows.
  await db.schema.createIndex("atproto_collection_recipe_live_idx").on("atproto_collection_recipe").columns(["did", "rkey"]).where(sql.ref("deleted_at"), "is", null).execute();

  // per-sweep observability / drift alarm
  await db.schema
    .createTable("atproto_sync_run")
    .addColumn("id", "bigserial", (col) => col.primaryKey())
    .addColumn("started_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("finished_at", "timestamptz")
    .addColumn("status", "text", (col) => col.notNull().defaultTo("running"))
    .addColumn("repos_seen", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("records_upserted", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("records_deleted", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("repos_failed", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("error", "text")
    .execute();
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  // Indexes drop implicitly with their tables.
  await db.schema.dropTable("atproto_sync_run").ifExists().execute();
  await db.schema.dropTable("atproto_collection_recipe").ifExists().execute();
  await db.schema.dropTable("atproto_repo").ifExists().execute();
}
