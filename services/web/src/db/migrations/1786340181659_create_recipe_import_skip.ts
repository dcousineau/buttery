import { type Kysely, sql } from "kysely";

/**
 * One row per import item that produced no recipe. See
 * `docs/plans/2026-08-09-paprika-import.md` §7.2 and §7.7.
 *
 * ── WHY A TABLE AND NOT A CLIENT-REPORTED NUMBER (§7.7) ───────────────────
 * §7.7 says session counters are DERIVED, never incremented, and finalize
 * honours that for `imported` and `linked` by counting the sidecar rows the
 * commit path wrote. Skips had no rows, so `skipped_count` had to come from the
 * client — which a replayed chunk can inflate, and which let the done screen and
 * the persisted row disagree in shape (the screen split the two skip reasons,
 * the stored counter collapsed them).
 *
 * `action: "skip"` is the mechanism §7.2 describes ("it exists so the client can
 * report a complete accounting of the session without the server having to infer
 * absence"), so the client now sends every excluded entry and the server records
 * it here. Both skip counters are then a `group by reason` over rows this
 * pipeline wrote, exactly like the other two.
 *
 * ── WHY NOT `household_recipe_meta` (the shape this replaces) ─────────────
 * A commit-time duplicate skip used to be recorded as a `ns='import.skip'` row
 * on the recipe it duplicated. That only ever worked for the half of the skips
 * the SERVER detects: a user skip has no recipe to hang a marker on and
 * `household_recipe_meta.recipe_id` is a NOT NULL FK. A skip is a fact about an
 * ITEM in a SESSION, not about a recipe — so it is keyed that way, and the two
 * reasons live in one place instead of two.
 *
 * ── IDEMPOTENT BY KEY ─────────────────────────────────────────────────────
 * The primary key is `(session_id, client_id)` — the same `(session, item)`
 * identity as §7.5's ledger. A replayed chunk upserts the rows it already wrote,
 * so re-sending 25 skips moves no count. There is deliberately no `count`,
 * `attempt`, or timestamp-per-attempt column: nothing here may be incremented.
 *
 * `household_id` is redundant with the session's own household and is kept
 * anyway, because every read and write in `server/recipe-import.ts` re-asserts
 * `household_id` and a derive query that had to join to `recipe_import_session`
 * to do so would be the one place that does not.
 *
 * `Kysely<any>` is intentional: migrations are frozen in time and must not track
 * the evolving `DB` interface (matches the existing migrations).
 */

const now = sql`now()`;

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("recipe_import_skip")
    .addColumn("session_id", "text", (col) => col.notNull().references("recipe_import_session.id").onDelete("cascade"))
    .addColumn("client_id", "text", (col) => col.notNull())
    .addColumn("household_id", "text", (col) => col.notNull().references("household.id").onDelete("cascade"))
    // 'duplicate' — Buttery declined to write a second copy; 'user' — the user
    // took it off the list. D24 keeps them apart all the way to the summary, so
    // the row that answers the counter has to keep them apart too. Free text
    // with a check constraint rather than an enum type, following the sibling
    // tables' precedent (`recipe_import_session.status` and `.importer`).
    .addColumn("reason", "text", (col) => col.notNull())
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addPrimaryKeyConstraint("recipe_import_skip_pkey", ["session_id", "client_id"])
    .addCheckConstraint("recipe_import_skip_reason", sql`reason in ('duplicate', 'user')`)
    .execute();

  // The only read: "how did this session's skips split", at finalize. The
  // primary key already serves `session_id` as its leading column, so the extra
  // index only exists to carry `household_id` into the same scan.
  await db.schema.createIndex("recipe_import_skip_session").on("recipe_import_skip").columns(["household_id", "session_id"]).execute();
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("recipe_import_skip").ifExists().execute();
}
