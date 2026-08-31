import { type Kysely, sql } from "kysely";

/**
 * `recipe_pending_image` holds bytes we own, or it holds nothing.
 *
 * The table shipped with a `source_url` column and a nullable `object_key`, so
 * "we could not fetch this hero, keep the third-party URL instead" was a
 * representable state — and it was reached constantly, because hotlink
 * protection refuses a datacenter IP far more often than it refuses a browser.
 * Worse, the read path had started *rendering* that column: a draft's hero on
 * `/household/recipes/$id` was an `<img src>` pointing at someone else's CDN,
 * and the publish path re-fetched from it rather than from our copy.
 *
 * Buttery serves images from exactly two places: an atproto CDN (blobs on the
 * author's own PDS) and its own bucket. Dropping the column and tightening
 * `object_key` to `not null` makes the third case unrepresentable instead of
 * merely forbidden. Where the image came from is not lost — the *page*'s URL is
 * still `recipe_attribution.url`, which is the provenance anyone actually
 * wanted; the CDN path the photo happened to sit behind was never that.
 *
 * Existing rows with no `object_key` held only a URL and no bytes, so there is
 * nothing to migrate: they are deleted, and those drafts show no hero until
 * they are re-imported. `mime` becomes `not null` for the same reason — it is
 * the encoding the PDS blob is uploaded with, so a row without one is a publish
 * that cannot happen.
 *
 * `Kysely<any>` is intentional: migrations are frozen in time and must not
 * track the evolving `DB` interface (matches the existing migrations).
 */

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // URL-only rows carry no bytes; there is nothing they could be backfilled
  // from that would not mean re-fetching from the very host that refused us.
  await sql`delete from recipe_pending_image where object_key is null or mime is null`.execute(db);

  await db.schema.alterTable("recipe_pending_image").dropColumn("source_url").execute();
  await db.schema
    .alterTable("recipe_pending_image")
    .alterColumn("object_key", (col) => col.setNotNull())
    .execute();
  await db.schema
    .alterTable("recipe_pending_image")
    .alterColumn("mime", (col) => col.setNotNull())
    .execute();
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("recipe_pending_image")
    .alterColumn("mime", (col) => col.dropNotNull())
    .execute();
  await db.schema
    .alterTable("recipe_pending_image")
    .alterColumn("object_key", (col) => col.dropNotNull())
    .execute();
  await db.schema.alterTable("recipe_pending_image").addColumn("source_url", "text").execute();
}
