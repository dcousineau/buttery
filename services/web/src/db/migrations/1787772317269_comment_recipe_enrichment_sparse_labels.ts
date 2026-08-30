import type { Kysely } from "kysely";

/**
 * Tombstone. This migration originally attached `COMMENT ON` prose to
 * `recipe_enrichment_label` and two of its columns; the commit that banned
 * schema comments (see AGENTS.md) deleted the file outright.
 *
 * Deleting it was the mistake, not the ban. Kysely's ledger is append-only
 * history: `recipe_enrichment_label` had already run against production, so
 * removing the file left a `kysely_migration` row with nothing to match and
 * every subsequent deploy died in `preDeploy` with
 * `corrupted migrations: previously executed migration ... is missing`.
 * A migration that has run somewhere can be emptied; it cannot be unlinked.
 *
 * So the name stays and the body goes. The comments this used to set are
 * still on the production table — harmless prose that no longer has an owner
 * — and `down` is empty for the same reason `up` is: dropping them is a
 * separate decision, not this file's job.
 *
 * Nothing new belongs here. Write a new migration instead.
 */

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(_db: Kysely<any>): Promise<void> {}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(_db: Kysely<any>): Promise<void> {}
