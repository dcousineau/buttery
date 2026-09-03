import { createServerFn } from "@tanstack/react-start";
import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { DB } from "#/db/types";

/**
 * Autoimport lifecycle: when a member joins (or turns the setting back on),
 * every public recipe published by their DID is added to the household box.
 * The cron path is inline in `services/pipeline/src/queues/atproto-sync/jobs.ts`,
 * which calls `autoimportRecipeForMemberHouseholds` per advanced recipe; this
 * web-side helper handles the bulk backfill/member addition case. Both run the
 * same INSERT ... SELECT shape.
 *
 * Server-only: every consumer reaches this module from a `createServerFn`
 * handler and dynamically imports it so `getDb` stays out of the client bundle.
 */

/**
 * Import all public recipes published by `did` into `householdId`, but only if
 * that member has `autoimport_my_recipes = true`. Idempotent via
 * `ON CONFLICT ... DO NOTHING`.
 */
export async function importMemberRecipes(db: Kysely<DB>, householdId: string, did: string): Promise<{ added: number }> {
  const result = await db
    .insertInto("household_recipe")
    .columns(["household_id", "recipe_id", "added_by_did"])
    .expression((eb) =>
      eb
        .selectFrom("household_member as hm")
        .innerJoin("recipe as r", "r.did", "hm.did")
        .where("hm.household_id", "=", householdId)
        .where("hm.did", "=", did)
        .where("hm.deleted_at", "is", null)
        .where("hm.tombstoned", "=", false)
        .where("hm.autoimport_my_recipes", "=", true)
        .where("r.visibility", "=", "public")
        .select(["hm.household_id", sql<string>`r.id`.as("recipe_id"), sql<string>`hm.did`.as("added_by_did")]),
    )
    .onConflict((oc) => oc.columns(["household_id", "recipe_id"]).doNothing())
    .executeTakeFirst();

  return { added: Number(result?.numInsertedOrUpdatedRows ?? 0) };
}

/**
 * The DID of the household member whose autoimport setting PINS `recipeId` in
 * the box — i.e. the recipe's publisher is a live member of this household with
 * `autoimport_my_recipes = true`, so unboxing it would only last until the next
 * sweep re-imported it. `null` when nothing pins it.
 *
 * One query, two callers: `unboxRecipe` refuses the removal with it, and the
 * detail payload (`getHouseholdRecipe`) reports it so the pane can disable the
 * button instead of letting the user discover the refusal by pressing it.
 */
export async function autoimportPinnedBy(db: Kysely<DB>, householdId: string, recipeId: string): Promise<string | null> {
  const row = await db
    .selectFrom("recipe as r")
    .innerJoin("household_member as hm", (join) => join.onRef("hm.did", "=", "r.did").on("hm.household_id", "=", householdId))
    .where("r.id", "=", recipeId)
    .where("hm.deleted_at", "is", null)
    .where("hm.tombstoned", "=", false)
    .where("hm.autoimport_my_recipes", "=", true)
    .select("hm.did")
    .executeTakeFirst();
  return row?.did ?? null;
}

function validateHouseholdId(id: unknown): string {
  if (typeof id !== "string" || id.length === 0) throw new Error("householdId is required.");
  return id;
}

function validateDid(did: unknown): string {
  if (typeof did !== "string" || !did.startsWith("did:")) throw new Error("A valid DID is required.");
  return did;
}

/**
 * Turn a member's Autoimport My Recipes preference on or off.
 *
 * Authorization: a member may change their own setting; an owner may change any
 * member's setting. The setting is per-household-per-member.
 * → `{ householdId, did, enabled }`
 */
export const setHouseholdMemberAutoimport = createServerFn({ method: "POST" })
  .validator((data: { householdId: string; did: string; enabled: boolean }) => {
    if (typeof data?.enabled !== "boolean") throw new Error("enabled must be a boolean.");
    return { householdId: validateHouseholdId(data?.householdId), did: validateDid(data?.did), enabled: data.enabled };
  })
  .handler(async ({ data }): Promise<{ householdId: string; did: string; enabled: boolean }> => {
    const { requireSessionDid } = await import("./session");
    const { assertMember, loadLiveMembership } = await import("../authz");
    const { getDb } = await import("#/lib/db");
    const { InsufficientRoleError } = await import("./errors");

    const callerDid = await requireSessionDid();

    await getDb()
      .transaction()
      .execute(async (trx) => {
        const caller = await assertMember(callerDid, data.householdId, "member", (d, h) => loadLiveMembership(d, h, trx));
        // Self-service, or owners acting on anyone in the household.
        if (caller.did !== data.did && caller.role !== "owner") {
          throw new InsufficientRoleError("Only the member themself or an owner can change this setting.");
        }

        // Ensure the target is a live member before mutating their row.
        const target = await loadLiveMembership(data.did, data.householdId, trx);
        if (!target) throw new Error("That person is not a member of this household.");

        await trx
          .updateTable("household_member")
          .set({ autoimport_my_recipes: data.enabled })
          .where("household_id", "=", data.householdId)
          .where("did", "=", data.did)
          .where("deleted_at", "is", null)
          .where("tombstoned", "=", false)
          .execute();
      });

    return { householdId: data.householdId, did: data.did, enabled: data.enabled };
  });

/**
 * Manually backfill all public recipes published by `did` into the household.
 * Useful when autoimport was off and is turned back on, or when recipes existed
 * before the member joined. Idempotent.
 * → `{ householdId, did, added }`
 */
export const backfillAutoimportRecipes = createServerFn({ method: "POST" })
  .validator((data: { householdId: string; did: string }) => ({
    householdId: validateHouseholdId(data?.householdId),
    did: validateDid(data?.did),
  }))
  .handler(async ({ data }): Promise<{ householdId: string; did: string; added: number }> => {
    const { requireSessionDid } = await import("./session");
    const { assertMember, loadLiveMembership } = await import("../authz");
    const { getDb } = await import("#/lib/db");
    const { InsufficientRoleError } = await import("./errors");

    const callerDid = await requireSessionDid();

    const { added } = await getDb()
      .transaction()
      .execute(async (trx) => {
        const caller = await assertMember(callerDid, data.householdId, "member", (d, h) => loadLiveMembership(d, h, trx));
        if (caller.did !== data.did && caller.role !== "owner") {
          throw new InsufficientRoleError("Only the member themself or an owner can backfill their recipes.");
        }

        const target = await loadLiveMembership(data.did, data.householdId, trx);
        if (!target) throw new Error("That person is not a member of this household.");

        return importMemberRecipes(trx, data.householdId, data.did);
      });

    return { householdId: data.householdId, did: data.did, added };
  });
