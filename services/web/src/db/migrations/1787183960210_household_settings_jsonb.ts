import { type Kysely, sql } from "kysely";

/**
 * A generic settings bag on `household` (onboarding→pantry plan §6).
 *
 * The first key is `inviteNudgeDismissedAt` — the timestamp a member dismissed
 * the pantry's "invite the rest of the house" card. It lives here rather than in
 * `household_preference` because that table is the user-facing *preferences*
 * surface (week start, timezone), while this is incidental UI state nobody sets
 * on purpose; a jsonb bag also means the next such flag costs no migration.
 *
 * Dismissal is per-household, not per-member, by design: one member deciding the
 * house has been told is enough for the house (§3.5).
 *
 * `Kysely<any>` is intentional: migrations are frozen in time.
 */

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("household")
    .addColumn("settings", "jsonb", (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .execute();
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("household").dropColumn("settings").execute();
}
