import { type Kysely, sql } from "kysely";

/**
 * Per-member autoimport preference: when enabled, every public recipe published
 * by this DID is automatically added to the household recipe box. Defaulted to
 * true so existing members opt in; members can turn it off from household
 * settings.
 *
 * The default alone only decides what happens to recipes published FROM NOW ON
 * — the cron path (`services/pipeline/.../atproto-sync/jobs.ts`) imports a
 * recipe as it advances, and `importMemberRecipes` runs when someone joins or
 * flips the setting back on. Neither fires for a member who is already in a
 * household today, so this migration also does the one-time backfill: every
 * live member's already-published public recipes land in their box the moment
 * it runs. Without it, "on by default" would silently mean "on, but empty until
 * you publish your next recipe".
 *
 * `down` drops the column and the index but deliberately leaves the boxed rows
 * alone: once imported, a `household_recipe` row is indistinguishable from one
 * a person added by hand, and un-boxing on a rollback would delete recipes the
 * household believes it owns.
 */

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("household_member")
    .addColumn("autoimport_my_recipes", "boolean", (col) => col.notNull().defaultTo(true))
    .execute();

  // Live members with autoimport on — the cron import path filters here.
  await sql`
    create index household_member_autoimport_idx
      on household_member (did, household_id)
      where deleted_at is null and tombstoned = false and autoimport_my_recipes = true
  `.execute(db);

  // One-time backfill, the same INSERT ... SELECT shape as
  // `importMemberRecipes` (server/household/autoimport.ts) — live membership,
  // autoimport on, publisher = member, public recipes only, idempotent on the
  // box's (household_id, recipe_id) key so re-running adds nothing.
  await sql`
    insert into household_recipe (household_id, recipe_id, added_by_did)
    select hm.household_id, r.id, hm.did
      from household_member hm
      join recipe r on r.did = hm.did
     where hm.deleted_at is null
       and hm.tombstoned = false
       and hm.autoimport_my_recipes = true
       and r.visibility = 'public'
    on conflict (household_id, recipe_id) do nothing
  `.execute(db);
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await sql`drop index if exists household_member_autoimport_idx`.execute(db);
  await db.schema.alterTable("household_member").dropColumn("autoimport_my_recipes").execute();
}
