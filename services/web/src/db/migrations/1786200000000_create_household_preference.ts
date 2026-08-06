import { type Kysely, sql } from "kysely";

/**
 * `household_preference` — typed, household-wide preferences. See
 * `docs/plans/2026-08-06-meal-planner.md` §3.1.
 *
 * A 1:1 side-table on `household`, NOT a key/value bag and NOT columns on
 * `household` itself: it keeps `household` lean, keeps every value typed
 * end-to-end through kysely-codegen, and grows only by migration (which is the
 * point — each new preference gets a review).
 *
 * Rows are created LAZILY. `getHouseholdPreferences()` returns hard-coded
 * defaults (`{ weekStartDay: 1, timezone: 'UTC' }`) when no row exists; the
 * first write upserts one. So there is no backfill here and no
 * row-per-household bookkeeping at household creation — the column defaults
 * below exist so an upsert that names only one column still lands a sane row.
 *
 * Buttery-PRIVATE: never written to a PDS, never leaves Postgres.
 *
 * `Kysely<any>` is intentional: migrations are frozen in time and must not
 * track the evolving `DB` interface (matches the existing migrations).
 */

const now = sql`now()`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("household_preference")
    // PK *and* FK: exactly one preference row per household, gone when the
    // household is hard-deleted.
    .addColumn("household_id", "text", (col) => col.primaryKey().references("household.id").onDelete("cascade"))
    // ISO-8601 weekday numbering: 1 = Monday … 7 = Sunday. Monday default (D11).
    .addColumn("week_start_day", "int2", (col) => col.notNull().defaultTo(1))
    // IANA zone name. Validated against `Intl.supportedValuesOf("timeZone")` on
    // write, so a bad value can never reach the date math (§6.11).
    .addColumn("timezone", "text", (col) => col.notNull().defaultTo("UTC"))
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("updated_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    // Cheap backstop for the app-level 1…7 validation.
    .addCheckConstraint("household_preference_week_start_day_check", sql`week_start_day between 1 and 7`)
    .execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("household_preference").ifExists().execute();
}
