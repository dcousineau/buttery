import { createServerFn } from "@tanstack/react-start";
import { redirect } from "@tanstack/react-router";
import type { Role } from "./errors";

/**
 * Household lifecycle server functions (§7, §9). Every function is server-only:
 * heavy server deps (`getDb`, kysely `sql`, the authz/session helpers) are
 * pulled in via dynamic `import()` inside each handler so this module stays safe
 * to reference from the client bundle — the same pattern `lib/recipes-browse.ts`
 * uses. The client-safe `Role` type and `createServerFn` stub are the only
 * static imports.
 *
 * FROZEN §9 contract — export names, input shapes, and RETURN shapes are what
 * Agent C wires the UI to. Do not change them.
 */

/** A caller's membership in one household, for list/summary UIs. */
export interface HouseholdSummary {
  id: string;
  name: string;
  role: Role;
  memberCount: number;
}

/** Coerce a free-text DB role to the ranked `Role` union (unknown → member). */
function asRole(role: string): Role {
  return role === "owner" ? "owner" : "member";
}

const NAME_MAX = 100;

/** Validate + normalize a household name (shared by create/rename). */
function validateName(name: unknown): string {
  if (typeof name !== "string") throw new Error("Household name is required.");
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("Household name is required.");
  if (trimmed.length > NAME_MAX) throw new Error(`Household name must be at most ${NAME_MAX} characters.`);
  return trimmed;
}

/**
 * Create a household and make the caller its first `owner`, atomically, then set
 * it as the caller's active household. Any authed user may call this; whether to
 * warn "you're already in a household" is a UI concern (Agent C's confirm
 * dialog) — the server just creates.
 *
 * → `{ id, name, role: "owner" }`
 */
export const createHousehold = createServerFn({ method: "POST" })
  .validator((data: { name: string }) => ({ name: validateName(data?.name) }))
  .handler(async ({ data }): Promise<{ id: string; name: string; role: "owner" }> => {
    const { getServerSession, setActiveHousehold } = await import("./session");
    const { getDb } = await import("#/lib/db");
    const { ulid } = await import("./ids");

    const session = await getServerSession();
    if (!session?.user.did) throw redirect({ to: "/login" });
    const did = session.user.did;
    const sessionId = session.session.id;

    const id = ulid();
    await getDb()
      .transaction()
      .execute(async (trx) => {
        await trx.insertInto("household").values({ id, name: data.name, created_by_did: did }).execute();
        await trx.insertInto("household_member").values({ household_id: id, did, role: "owner", invited_by_did: null }).execute();
        // Put the creator straight into their new household's context.
        await setActiveHousehold(sessionId, id, trx);
      });

    return { id, name: data.name, role: "owner" };
  });

/**
 * Rename a household (owners only), bumping `updated_at`.
 * → `{ id, name }`
 */
export const renameHousehold = createServerFn({ method: "POST" })
  .validator((data: { householdId: string; name: string }) => {
    if (typeof data?.householdId !== "string" || data.householdId.length === 0) throw new Error("householdId is required.");
    return { householdId: data.householdId, name: validateName(data.name) };
  })
  .handler(async ({ data }): Promise<{ id: string; name: string }> => {
    const { requireSessionDid } = await import("./session");
    const { assertMember } = await import("./authz");
    const { getDb } = await import("#/lib/db");
    const { sql } = await import("kysely");

    const did = await requireSessionDid();
    await assertMember(did, data.householdId, "owner");

    await getDb()
      .updateTable("household")
      .set({ name: data.name, updated_at: sql`now()` })
      .where("id", "=", data.householdId)
      .where("deleted_at", "is", null)
      .execute();

    return { id: data.householdId, name: data.name };
  });

/**
 * The caller's LIVE memberships with household summaries + live member counts.
 * → `Array<{ id, name, role, memberCount }>`
 */
export const listMyHouseholds = createServerFn({ method: "GET" }).handler(async (): Promise<HouseholdSummary[]> => {
  const { requireSessionDid } = await import("./session");
  const { getDb } = await import("#/lib/db");

  const did = await requireSessionDid();
  const db = getDb();

  const mine = await db
    .selectFrom("household_member as hm")
    .innerJoin("household as h", "h.id", "hm.household_id")
    .where("hm.did", "=", did)
    .where("hm.deleted_at", "is", null)
    .where("hm.tombstoned", "=", false)
    .where("h.deleted_at", "is", null)
    .select(["h.id as id", "h.name as name", "hm.role as role"])
    .execute();

  if (mine.length === 0) return [];

  const counts = await db
    .selectFrom("household_member")
    .where(
      "household_id",
      "in",
      mine.map((m) => m.id),
    )
    .where("deleted_at", "is", null)
    .where("tombstoned", "=", false)
    .groupBy("household_id")
    .select((eb) => ["household_id", eb.fn.countAll<string>().as("cnt")])
    .execute();

  const countByHousehold = new Map(counts.map((c) => [c.household_id, Number(c.cnt)]));

  return mine.map((m) => ({
    id: m.id,
    name: m.name,
    role: asRole(m.role),
    memberCount: countByHousehold.get(m.id) ?? 0,
  }));
});

/**
 * Soft-delete a household (owners only): mark the household deleted, soft-delete
 * every live membership, and revoke every pending invite — all in one tx.
 * Members with this household active get `active_household_id` cleared on their
 * next request by the §5 stale-active guard (Agent C).
 * → `{ id, deleted: true }`
 */
export const deleteHousehold = createServerFn({ method: "POST" })
  .validator((data: { householdId: string }) => {
    if (typeof data?.householdId !== "string" || data.householdId.length === 0) throw new Error("householdId is required.");
    return { householdId: data.householdId };
  })
  .handler(async ({ data }): Promise<{ id: string; deleted: true }> => {
    const { requireSessionDid } = await import("./session");
    const { assertMember } = await import("./authz");
    const { getDb } = await import("#/lib/db");
    const { sql } = await import("kysely");

    const did = await requireSessionDid();
    await assertMember(did, data.householdId, "owner");

    await getDb()
      .transaction()
      .execute(async (trx) => {
        await trx
          .updateTable("household")
          .set({ deleted_at: sql`now()` })
          .where("id", "=", data.householdId)
          .where("deleted_at", "is", null)
          .execute();

        await trx
          .updateTable("household_member")
          .set({ deleted_at: sql`now()` })
          .where("household_id", "=", data.householdId)
          .where("deleted_at", "is", null)
          .execute();

        await trx
          .updateTable("household_invite")
          .set({ status: "revoked", revoked_at: sql`now()` })
          .where("household_id", "=", data.householdId)
          .where("status", "=", "pending")
          .execute();
      });

    // TODO(email): notify remaining members that the household was deleted (§11).

    return { id: data.householdId, deleted: true };
  });
