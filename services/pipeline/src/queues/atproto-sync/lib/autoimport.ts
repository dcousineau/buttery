import type { Pool, PoolClient } from "pg";

const AUTOIMPORT_RECIPE_SQL = `
insert into household_recipe (household_id, recipe_id, added_by_did)
select hm.household_id, r.id, r.did
  from recipe r
  join household_member hm on hm.did = r.did and hm.autoimport_my_recipes = true
 where r.id = $1
   and r.visibility = 'public'
   and not exists (
     select 1 from household_recipe hr
     where hr.household_id = hm.household_id
       and hr.recipe_id = r.id
   )
on conflict do nothing
`;

/**
 * For a recipe that just advanced in the sync index, add it to every household
 * whose member published it and has autoimport enabled. This is intentionally a
 * single idempotent query rather than a queued job: the work is one insert with
 * a small join, and retrying the sync-repo job already covers failure cases.
 *
 * Runs best-effort inside the repo sweep: a failure here is logged but does not
 * fail the sync-repo job, because the recipe is already safely indexed and the
 * member-join backfill path will catch up later.
 */
export async function autoimportRecipeForMemberHouseholds(client: Pool | PoolClient, recipeId: string): Promise<number> {
  const res = await client.query(AUTOIMPORT_RECIPE_SQL, [recipeId]);
  return res.rowCount ?? 0;
}
