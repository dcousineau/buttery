import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";
import type { HouseholdNudges } from "#/lib/api/types";

/**
 * The `household.settings` jsonb bag and the one thing living in it so far: the
 * pantry's "invite the rest of the house" nudge (onboarding→pantry plan §6).
 *
 * Distinct from `./preferences` on purpose. That table is the user-facing
 * *preferences* surface — things somebody deliberately sets (week start,
 * timezone) — and every key in it is a product decision with a UI. This is
 * incidental UI state nobody chooses: a dismissal, remembered so the app stops
 * asking. A jsonb bag means the next such flag costs a key rather than a
 * migration.
 *
 * Dismissal is per-HOUSEHOLD, not per-member: one member deciding the house has
 * been told is enough for the house (§3.5). The nudge also auto-hides at two or
 * more live members, which is derived rather than stored — a household that
 * grows never needs its flag cleaned up.
 *
 * Server-only imports (`getDb`, authz) are pulled in with dynamic `import()`
 * inside each handler so this module stays safe to reference from the client
 * bundle — the pattern every other server module here uses.
 */

/**
 * The wire DTO is declared in the port's `types.ts` and imported from there
 * (offline plan §4.3 / §7): the client caches these shapes and must be able to
 * name them without importing a server module. Re-exported for server callers.
 */
export type { HouseholdNudges };

const householdIdInput = z.object({ householdId: z.string().min(1) });

/** The key `dismissInviteNudge` writes into `household.settings`. */
const INVITE_NUDGE_DISMISSED_AT = "inviteNudgeDismissedAt";

/**
 * Which first-run nudges the pantry should show for this household.
 *
 * One query, one boolean: `inviteNudge` is true exactly when the household has a
 * single live member AND nobody has dismissed the card. Both halves are counted
 * server-side so the pantry never has to fetch a member list to decide whether
 * to render a card.
 */
export const getHouseholdNudges = createServerFn({ method: "GET" })
  .validator((data: unknown) => householdIdInput.parse(data))
  .handler(async ({ data }): Promise<HouseholdNudges> => {
    const { assertMember } = await import("../authz");
    const { getServerSession } = await import("./session");
    const { getDb } = await import("#/lib/db");
    const { sql } = await import("kysely");
    const { redirect } = await import("@tanstack/react-router");

    const session = await getServerSession();
    const did = session?.user.did ?? null;
    if (!did) throw redirect({ to: "/login" });
    await assertMember(did, data.householdId);

    const row = await getDb()
      .selectFrom("household as h")
      .where("h.id", "=", data.householdId)
      .where("h.deleted_at", "is", null)
      .select((eb) => [
        eb
          .selectFrom("household_member as hm")
          .whereRef("hm.household_id", "=", "h.id")
          .where("hm.deleted_at", "is", null)
          .where("hm.tombstoned", "=", false)
          .select(eb.fn.countAll<string>().as("cnt"))
          .as("memberCount"),
        // Raw `sql` for this one expression: `settings` is typed `Json`, so the
        // builder's `ref(..., "->>").key()` has no key union to check against and
        // resolves the argument to `never`. The path is a constant, not input.
        sql<string | null>`h.settings ->> ${INVITE_NUDGE_DISMISSED_AT}`.as("dismissedAt"),
      ])
      .executeTakeFirst();

    if (!row) return { inviteNudge: false };
    return { inviteNudge: Number(row.memberCount ?? 0) === 1 && row.dismissedAt == null };
  });

/**
 * Remember that this household has been told to invite people.
 *
 * Merges the key rather than replacing `settings`, so a concurrent write of some
 * future key is not clobbered. Idempotent: re-dismissing just re-stamps the
 * timestamp, which is fine — only its presence is read.
 */
export const dismissInviteNudge = createServerFn({ method: "POST" })
  .validator((data: unknown) => householdIdInput.parse(data))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { assertMember } = await import("../authz");
    const { getServerSession } = await import("./session");
    const { getDb } = await import("#/lib/db");
    const { sql } = await import("kysely");
    const { redirect } = await import("@tanstack/react-router");

    const session = await getServerSession();
    const did = session?.user.did ?? null;
    if (!did) throw redirect({ to: "/login" });
    await assertMember(did, data.householdId);

    await getDb()
      .updateTable("household")
      .set({
        settings: sql`settings || jsonb_build_object(${INVITE_NUDGE_DISMISSED_AT}::text, to_jsonb(now()))`,
        updated_at: sql`now()`,
      })
      .where("id", "=", data.householdId)
      .where("deleted_at", "is", null)
      .execute();

    return { ok: true };
  });
