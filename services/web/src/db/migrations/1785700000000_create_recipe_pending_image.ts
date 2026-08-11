import { type Kysely, sql } from "kysely";

/**
 * Local recipe authoring support (docs/plans/2026-08-02-create-recipes.md,
 * Phase A). Two additions, both serving the create/import flow:
 *
 *   1. `recipe_pending_image` — a pointer to a draft's not-yet-published image.
 *      Buttery holds one image per draft in Railway object storage (S3-compatible;
 *      see src/lib/blob-storage.ts), NOT in Postgres and NOT yet as an atproto
 *      blob. The bytes live in the bucket under `object_key`; this row is just the
 *      pointer + metadata. On publish the object is read back, uploaded to the
 *      user's PDS as a blob, then the object + this row are cleared. For an
 *      imported hero that hasn't been fetched yet, `source_url` holds the origin
 *      URL and `object_key` is null (fetched lazily — Phase B/C).
 *      One image per recipe in v1 → PK on `recipe_id`.
 *
 *   2. A dedupe index on `recipe_attribution.url` for website attributions, so
 *      "does a public record already cite this source URL?" is a cheap lookup
 *      (import dedupe, plan §dedupe). The public-only filter is applied in the
 *      query (a single-table partial index can't join `recipe.visibility`); this
 *      index just makes the URL probe itself cheap.
 *
 * `Kysely<any>` is intentional: migrations are frozen in time and must not track
 * the evolving `DB` interface (matches the existing migrations).
 */

const now = sql`now()`;

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // --- recipe_pending_image (draft image pointer) -----------------------
  await db.schema
    .createTable("recipe_pending_image")
    // One pending image per draft recipe; cascades away with the recipe row.
    .addColumn("recipe_id", "text", (col) => col.primaryKey().references("recipe.id").onDelete("cascade"))
    // Bucket object key holding the bytes. Null when the image is a not-yet-
    // fetched imported hero (then `source_url` is set instead).
    .addColumn("object_key", "text")
    .addColumn("mime", "text")
    .addColumn("alt", "text")
    // For imported heroes we may only know the source URL until fetch time.
    .addColumn("source_url", "text")
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .execute();

  // --- import-dedupe index on website attribution URLs ------------------
  // Case-insensitive URL probe, scoped to website attributions. The publish-time
  // dedupe query additionally joins `recipe` on `visibility = 'public'`.
  await sql`
    create index recipe_attribution_website_url_idx
      on recipe_attribution (lower(url))
      where kind = 'website' and url is not null
  `.execute(db);
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop index if exists recipe_attribution_website_url_idx`.execute(db);
  await db.schema.dropTable("recipe_pending_image").ifExists().execute();
}
