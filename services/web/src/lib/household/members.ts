import { createServerFn } from "@tanstack/react-start";
import { redirect } from "@tanstack/react-router";
import type { Kysely } from "kysely";
import type { DB } from "#/db/types";
import type { Role } from "./errors";

/**
 * Membership-management server functions (§7, §9): remove / setRole / leave, plus
 * the tombstone path (§7.2). Server-only — heavy deps are dynamically imported
 * per handler (see `households.ts`). The owner invariant (§7.1) is enforced
 * INSIDE each mutating transaction via the pure `wouldDropLastOwner`, so a
 * concurrent demotion can't race two "last owners" out.
 *
 * FROZEN §9 contract — names, inputs, RETURN shapes are Agent C's UI surface.
 */

/** Live-owner DIDs for a household, read inside a transaction for the invariant. */
async function liveOwnerDids(trx: Kysely<DB>, householdId: string): Promise<string[]> {
  const rows = await trx
    .selectFrom("household_member")
    .select(["did"])
    .where("household_id", "=", householdId)
    .where("role", "=", "owner")
    .where("deleted_at", "is", null)
    .where("tombstoned", "=", false)
    .execute();
  return rows.map((r) => r.did);
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
 * Remove a member (owners only). Soft-deletes the target's membership. Blocked by
 * the owner invariant if the target is the last live owner. Removing yourself is
 * "leave" — prefer `leaveHousehold`, but this handles it too.
 * → `{ householdId, did, removed: true }`
 */
export const removeMember = createServerFn({ method: "POST" })
  .validator((data: { householdId: string; did: string }) => ({ householdId: validateHouseholdId(data?.householdId), did: validateDid(data?.did) }))
  .handler(async ({ data }): Promise<{ householdId: string; did: string; removed: true }> => {
    const { requireSessionDid } = await import("./session");
    const { assertMember, loadLiveMembership } = await import("./authz");
    const { getDb } = await import("#/lib/db");
    const { sql } = await import("kysely");
    const { wouldDropLastOwner } = await import("./owner-invariant");
    const { LastOwnerError, NotAMemberError } = await import("./errors");

    const callerDid = await requireSessionDid();

    await getDb()
      .transaction()
      .execute(async (trx) => {
        await assertMember(callerDid, data.householdId, "owner", (d, h) => loadLiveMembership(d, h, trx));

        const target = await loadLiveMembership(data.did, data.householdId, trx);
        if (!target) throw new NotAMemberError("That person is not a member of this household.");

        // Owner invariant: only matters when the target is an owner.
        if (target.role === "owner") {
          const owners = await liveOwnerDids(trx, data.householdId);
          if (wouldDropLastOwner(owners, data.did)) throw new LastOwnerError("Cannot remove the last owner. Promote another owner or delete the household first.");
        }

        await trx
          .updateTable("household_member")
          .set({ deleted_at: sql`now()` })
          .where("household_id", "=", data.householdId)
          .where("did", "=", data.did)
          .where("deleted_at", "is", null)
          .where("tombstoned", "=", false)
          .execute();
      });

    // TODO(email): notify the removed member (§11).

    return { householdId: data.householdId, did: data.did, removed: true };
  });

/**
 * Promote/demote a member (owners only). Promotion to `owner` is always allowed;
 * demotion of an `owner` to `member` is blocked by the owner invariant unless
 * another live owner remains.
 * → `{ householdId, did, role }`
 */
export const setMemberRole = createServerFn({ method: "POST" })
  .validator((data: { householdId: string; did: string; role: Role }) => {
    if (data?.role !== "owner" && data?.role !== "member") throw new Error("role must be 'owner' or 'member'.");
    return { householdId: validateHouseholdId(data?.householdId), did: validateDid(data?.did), role: data.role };
  })
  .handler(async ({ data }): Promise<{ householdId: string; did: string; role: Role }> => {
    const { requireSessionDid } = await import("./session");
    const { assertMember, loadLiveMembership } = await import("./authz");
    const { getDb } = await import("#/lib/db");
    const { wouldDropLastOwner } = await import("./owner-invariant");
    const { LastOwnerError, NotAMemberError } = await import("./errors");

    const callerDid = await requireSessionDid();

    await getDb()
      .transaction()
      .execute(async (trx) => {
        await assertMember(callerDid, data.householdId, "owner", (d, h) => loadLiveMembership(d, h, trx));

        const target = await loadLiveMembership(data.did, data.householdId, trx);
        if (!target) throw new NotAMemberError("That person is not a member of this household.");

        // Demotion of an owner is the only role transition the invariant guards.
        if (target.role === "owner" && data.role === "member") {
          const owners = await liveOwnerDids(trx, data.householdId);
          if (wouldDropLastOwner(owners, data.did)) throw new LastOwnerError("Cannot demote the last owner. Promote another owner first.");
        }

        await trx
          .updateTable("household_member")
          .set({ role: data.role })
          .where("household_id", "=", data.householdId)
          .where("did", "=", data.did)
          .where("deleted_at", "is", null)
          .where("tombstoned", "=", false)
          .execute();
      });

    // TODO(email): notify the member when promoted to owner (§11).

    return { householdId: data.householdId, did: data.did, role: data.role };
  });

/**
 * Leave a household (self). Soft-deletes the caller's own membership and, if this
 * was their active household, clears `active_household_id`. Blocked if the caller
 * is the last live owner (`LastOwnerError`).
 * → `{ householdId, left: true }`
 */
export const leaveHousehold = createServerFn({ method: "POST" })
  .validator((data: { householdId: string }) => ({ householdId: validateHouseholdId(data?.householdId) }))
  .handler(async ({ data }): Promise<{ householdId: string; left: true }> => {
    const { getServerSession, setActiveHousehold } = await import("./session");
    const { loadLiveMembership } = await import("./authz");
    const { getDb } = await import("#/lib/db");
    const { sql } = await import("kysely");
    const { wouldDropLastOwner } = await import("./owner-invariant");
    const { LastOwnerError, NotAMemberError } = await import("./errors");

    const session = await getServerSession();
    if (!session?.user.did) throw redirect({ to: "/login" });
    const did = session.user.did;
    const sessionId = session.session.id;
    const activeHouseholdId = session.session.active_household_id;

    await getDb()
      .transaction()
      .execute(async (trx) => {
        const membership = await loadLiveMembership(did, data.householdId, trx);
        if (!membership) throw new NotAMemberError();

        if (membership.role === "owner") {
          const owners = await liveOwnerDids(trx, data.householdId);
          if (wouldDropLastOwner(owners, did)) throw new LastOwnerError();
        }

        await trx
          .updateTable("household_member")
          .set({ deleted_at: sql`now()` })
          .where("household_id", "=", data.householdId)
          .where("did", "=", did)
          .where("deleted_at", "is", null)
          .where("tombstoned", "=", false)
          .execute();

        // If they just left their active household, drop the stale context now.
        if (activeHouseholdId === data.householdId) {
          await setActiveHousehold(sessionId, null, trx);
        }
      });

    return { householdId: data.householdId, left: true };
  });

/**
 * Account-deletion tombstone path (§7.2). NOT a server function — a plain helper
 * meant to be invoked by an account-lifecycle event handler. Soft-deletes +
 * tombstones the membership (retaining the row, attributed to the dead DID, for
 * audit). If the dead account was the SOLE live owner of a live household, the
 * household is soft-deleted (its chosen resolution: no live owner can exist, so
 * it can no longer be administered).
 *
 * TODO(lifecycle): DETECTION IS A DOCUMENTED HOLE — no account-deletion event
 * feed calls this yet (§12). Wire an atproto account-deletion / tombstone signal
 * to this function when that feed exists.
 */
export async function tombstoneMemberForDeletedAccount(householdId: string, did: string): Promise<void> {
  const { getDb } = await import("#/lib/db");
  const { sql } = await import("kysely");

  await getDb()
    .transaction()
    .execute(async (trx) => {
      await trx
        .updateTable("household_member")
        .set({ deleted_at: sql`now()`, tombstoned: true })
        .where("household_id", "=", householdId)
        .where("did", "=", did)
        .execute();

      // Sole-owner death → the household is left with no live owner; soft-delete
      // it (mirror `deleteHousehold`'s cascade) so nothing renders against a
      // household that can never be administered again.
      const owners = await liveOwnerDids(trx, householdId);
      if (owners.length === 0) {
        const household = await trx.selectFrom("household").select(["deleted_at"]).where("id", "=", householdId).executeTakeFirst();
        if (household && household.deleted_at === null) {
          await trx
            .updateTable("household")
            .set({ deleted_at: sql`now()` })
            .where("id", "=", householdId)
            .execute();
          await trx
            .updateTable("household_member")
            .set({ deleted_at: sql`now()` })
            .where("household_id", "=", householdId)
            .where("deleted_at", "is", null)
            .execute();
          await trx
            .updateTable("household_invite")
            .set({ status: "revoked", revoked_at: sql`now()` })
            .where("household_id", "=", householdId)
            .where("status", "=", "pending")
            .execute();
        }
      }
    });
}
