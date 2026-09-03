import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { redirect } from "@tanstack/react-router";
import type { Role } from "./errors";
import type { HouseholdMemberView, OnboardingVerdict, PendingInvite } from "#/lib/api/types";

/**
 * Onboarding & active-household session context (Agent C's slice — §5, §8, and
 * the two session-mutating server fns from §9). Server-only: every heavy dep
 * (`getDb`, kysely `sql`, the authz/session helpers) is pulled in via dynamic
 * `import()` inside each handler so this module stays safe to reference from the
 * client bundle — the same pattern `households.ts`/`invites.ts` use. Only
 * `createServerFn`, `redirect`, and type-only imports are static.
 *
 * This module OWNS (per §16): `resolveOnboarding`, `switchActiveHousehold`, the
 * per-request stale-active guard (`requireActiveHousehold`), a read-only member
 * list for the management UI (`listHouseholdMembers`), and the by-id accept /
 * decline of pending BOUND invites (see the note on those functions).
 */

/**
 * The wire DTOs this module returns are declared in the port's `types.ts` and
 * imported from there (offline plan §4.3 / §7): the client caches these shapes
 * in IndexedDB, versions them, and must be able to name them without importing
 * a server module — so it owns the declaration. Re-exported here for the
 * server-side callers that already reach for them through this module.
 */
export type { HouseholdMemberView, OnboardingVerdict, PendingInvite };

/** Coerce a free-text DB role to the ranked `Role` union (unknown → member). */
function asRole(role: string): Role {
  return role === "owner" ? "owner" : "member";
}

function validateHouseholdId(id: unknown): string {
  if (typeof id !== "string" || id.length === 0) throw new Error("householdId is required.");
  return id;
}

function validateInviteId(id: unknown): string {
  if (typeof id !== "string" || id.length === 0) throw new Error("inviteId is required.");
  return id;
}

/**
 * The §5 resolution, as a plain server-only function so BOTH `resolveOnboarding`
 * (returns the verdict) and `requireActiveHousehold` (translates it to a
 * redirect) can share one implementation without a server-fn-calling-server-fn
 * hop. Reads the ambient request via `getServerSession()` → `getRequest()`, so
 * it only runs inside a server-fn handler / server context.
 *
 * Also performs the stale-active clear: if `active_household_id` points at a
 * household the caller is no longer a live member of, it is cleared here and
 * resolution re-runs (§5 / §8, acceptance items 10 & 14).
 */
const computeOnboarding = createServerOnlyFn(async (): Promise<OnboardingVerdict> => {
  const { getServerSession, setActiveHousehold } = await import("./session");
  const { loadLiveMembership } = await import("../authz");
  const { getDb } = await import("#/lib/db");
  const { sql } = await import("kysely");

  const session = await getServerSession();
  if (!session?.user.did) throw redirect({ to: "/login" });
  const did = session.user.did;
  const sessionId = session.session.id;
  const active = session.session.active_household_id;
  const db = getDb();

  // 1. Confirmed-active fast path: pointer set AND still a live membership.
  if (active) {
    const membership = await loadLiveMembership(did, active);
    if (membership) {
      const h = await db.selectFrom("household").select(["name"]).where("id", "=", active).where("deleted_at", "is", null).executeTakeFirst();
      if (h) return { kind: "active", householdId: active, name: h.name };
    }
    // Stale pointer (household deleted, or membership removed/tombstoned while
    // active) → clear it and fall through to re-resolve. Never render against a
    // household the caller is no longer a live member of.
    await setActiveHousehold(sessionId, null);
  }

  // 2. Count live memberships for this DID.
  const mine = await db
    .selectFrom("household_member as hm")
    .innerJoin("household as h", "h.id", "hm.household_id")
    .where("hm.did", "=", did)
    .where("hm.deleted_at", "is", null)
    .where("hm.tombstoned", "=", false)
    .where("h.deleted_at", "is", null)
    .select(["h.id as id", "h.name as name", "hm.role as role"])
    .execute();

  if (mine.length === 1) {
    const only = mine[0];
    await setActiveHousehold(sessionId, only.id);
    return { kind: "active", householdId: only.id, name: only.name };
  }

  if (mine.length >= 2) {
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
    return {
      kind: "pick",
      households: mine.map((m) => ({ id: m.id, name: m.name, role: asRole(m.role), memberCount: countByHousehold.get(m.id) ?? 0 })),
    };
  }

  // 3. Zero memberships → onboarding, carrying pending BOUND invites (§5). A
  // pending bound invite is: bound to my DID, still `pending`, not revoked, not
  // expired, and its parent household is live.
  const invites = await db
    .selectFrom("household_invite as i")
    .innerJoin("household as h", "h.id", "i.household_id")
    .where("i.bound_to_did", "=", did)
    .where("i.status", "=", "pending")
    .where("i.revoked_at", "is", null)
    .where("h.deleted_at", "is", null)
    .where((eb) => eb.or([eb("i.expires_at", "is", null), eb("i.expires_at", ">", sql<Date>`now()`)]))
    .select(["i.id as id", "i.role as role", "i.created_by_did as createdByDid", "i.created_at as createdAt", "h.name as householdName"])
    .orderBy("i.created_at", "desc")
    .execute();

  // Best-effort inviter handles from our indexed atproto repos (no network).
  const inviterDids = [...new Set(invites.map((i) => i.createdByDid))];
  const repos = inviterDids.length ? await db.selectFrom("atproto_repo").select(["did", "handle"]).where("did", "in", inviterDids).execute() : [];
  const handleByDid = new Map(repos.map((r) => [r.did, r.handle]));

  return {
    kind: "onboard",
    pendingInvites: invites.map((i) => ({
      inviteId: i.id,
      householdName: i.householdName,
      inviterHandle: handleByDid.get(i.createdByDid) ?? null,
      role: asRole(i.role),
      createdAt: new Date(i.createdAt).toISOString(),
    })),
  };
});

/**
 * §5/§9 `resolveOnboarding()` — the state-machine verdict for the current user
 * in one round-trip. The `onboard` payload carries the caller's pending bound
 * invites so the screen renders them (or the empty state) without a second call.
 */
export const resolveOnboarding = createServerFn({ method: "GET" }).handler((): Promise<OnboardingVerdict> => computeOnboarding());

/** Read a single cookie value out of a raw `Cookie:` header (server-side). */
function readCookie(header: string, name: string): string | null {
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * The single, SERVER-SIDE decision for where the marketing home (`/`) should
 * send the caller. Called from `/`'s `beforeLoad`, so the routing is decided
 * before render — no client-effect race, no redirect flicker, and it runs
 * deterministically on the full-page load the atproto OAuth callback lands on.
 *
 * - Unauthenticated → `{ authed: false }`; the marketing page renders.
 * - Authenticated, with a pending-invite cookie carried through the logged-out
 *   invite → OAuth round-trip (§15) → resume it at `/invite/$token`.
 * - Authenticated otherwise → the §5 landing: `/household` (active/single),
 *   `/households/switch` (2+, none active), or `/onboarding` (no household).
 *
 * A signed-in user therefore never sits on the marketing page — they are always
 * routed into the app (or onward to onboarding until they have a household).
 */
export const resolveHomeRedirect = createServerFn({ method: "GET" }).handler(async (): Promise<{ authed: false }> => {
  const { getServerSession } = await import("./session");
  const { getRequest } = await import("@tanstack/react-start/server");
  const { PENDING_INVITE_COOKIE } = await import("./pending-invite");

  const session = await getServerSession();
  if (!session?.user.did) return { authed: false };

  // A stashed invite token (logged-out invite → OAuth round-trip) wins: resume it.
  const token = readCookie(getRequest().headers.get("cookie") ?? "", PENDING_INVITE_COOKIE);
  if (token) throw redirect({ to: "/invite/$token", params: { token } });

  const verdict = await computeOnboarding();
  if (verdict.kind === "active") throw redirect({ to: "/household" });
  if (verdict.kind === "pick") throw redirect({ to: "/households/switch" });
  throw redirect({ to: "/onboarding" });
});

/**
 * Per-request STALE-ACTIVE GUARD (§8). Every household-scoped screen calls this
 * from its loader so it never renders against a dead/exited household. Returns
 * the confirmed active household, or throws a redirect:
 * - `pick`    → the picker (`/households/switch`)
 * - `onboard` → the onboarding screen (`/onboarding`)
 *
 * Because {@link computeOnboarding} clears a stale pointer and re-resolves,
 * a caller whose `active_household_id` was removed/deleted is transparently
 * routed to onboarding/picker (acceptance items 10 & 14).
 */
export const requireActiveHousehold = createServerFn({ method: "GET" }).handler(async (): Promise<{ householdId: string; name: string }> => {
  const verdict = await computeOnboarding();
  if (verdict.kind === "active") return { householdId: verdict.householdId, name: verdict.name };
  if (verdict.kind === "pick") throw redirect({ to: "/households/switch" });
  throw redirect({ to: "/onboarding" });
});

/**
 * §9 `switchActiveHousehold({ householdId })` — point the session at a household
 * the caller is a live member of. Session-mutating, so it lives here (not in B's
 * modules). Gated by `assertMember` (any live member).
 * → `{ householdId }`
 */
export const switchActiveHousehold = createServerFn({ method: "POST" })
  .validator((data: { householdId: string }) => ({ householdId: validateHouseholdId(data?.householdId) }))
  .handler(async ({ data }): Promise<{ householdId: string }> => {
    const { getServerSession, setActiveHousehold } = await import("./session");
    const { assertMember } = await import("../authz");

    const session = await getServerSession();
    if (!session?.user.did) throw redirect({ to: "/login" });

    await assertMember(session.user.did, data.householdId);
    await setActiveHousehold(session.session.id, data.householdId);

    return { householdId: data.householdId };
  });

/**
 * Read-only members list for the management surface. Any LIVE member may view.
 * B did not expose a member-listing server function, so it lives here (a C-owned
 * read) rather than in B's frozen `members.ts`. Handles are best-effort from
 * `atproto_repo`.
 * → `Array<HouseholdMemberView>`
 */
export const listHouseholdMembers = createServerFn({ method: "GET" })
  .validator((data: { householdId: string }) => ({ householdId: validateHouseholdId(data?.householdId) }))
  .handler(async ({ data }): Promise<HouseholdMemberView[]> => {
    const { requireSessionDid } = await import("./session");
    const { assertMember } = await import("../authz");
    const { getDb } = await import("#/lib/db");

    const did = await requireSessionDid();
    await assertMember(did, data.householdId);

    const rows = await getDb()
      .selectFrom("household_member as hm")
      .innerJoin("household as h", "h.id", "hm.household_id")
      // Handle sources, best-effort: the better-auth `user` row (set on every
      // sign-in, so present for anyone who has logged in) is authoritative;
      // `atproto_repo` (populated only by the cron sweep, i.e. recipe authors)
      // is a fallback for members who haven't logged in via this app yet.
      .leftJoin("user as u", "u.did", "hm.did")
      .leftJoin("atproto_repo as r", "r.did", "hm.did")
      .where("hm.household_id", "=", data.householdId)
      .where("hm.deleted_at", "is", null)
      .where("hm.tombstoned", "=", false)
      .where("h.deleted_at", "is", null)
      .select([
        "hm.did as did",
        "hm.role as role",
        "hm.joined_at as joinedAt",
        "hm.invited_by_did as invitedByDid",
        "hm.autoimport_my_recipes as autoimportMyRecipes",
        "u.handle as userHandle",
        "r.handle as repoHandle",
      ])
      .orderBy("hm.joined_at", "asc")
      .execute();

    return rows.map((r) => ({
      did: r.did,
      role: asRole(r.role),
      joinedAt: new Date(r.joinedAt).toISOString(),
      invitedByDid: r.invitedByDid,
      handle: r.userHandle ?? r.repoHandle,
      isSelf: r.did === did,
      autoimportMyRecipes: r.autoimportMyRecipes,
    }));
  });

/**
 * Accept a pending BOUND invite from the onboarding screen, keyed by invite id.
 *
 * WHY BY-ID (not token): only `token_hash` is stored, so a logged-in invitee's
 * pending bound invite can't be accepted by re-deriving the raw token. This runs
 * the SAME acceptance semantics as B's `acceptInvite` (§6.3) — the ordered,
 * fail-closed validation via B's pure `assessInviteForAcceptance`, parent-
 * household liveness, idempotent already-a-member, insert-or-revive, use
 * consumption, and setting the active household — but selects the invite by `id`
 * and gates on `bound_to_did === sessionDid`. B's files are untouched; the
 * shared validation ordering is reused from `./invite-assess`.
 * → `{ householdId, name }`
 */
export const acceptBoundInviteById = createServerFn({ method: "POST" })
  .validator((data: { inviteId: string }) => ({ inviteId: validateInviteId(data?.inviteId) }))
  .handler(async ({ data }): Promise<{ householdId: string; name: string }> => {
    const { getServerSession, setActiveHousehold } = await import("./session");
    const { getDb } = await import("#/lib/db");
    const { sql } = await import("kysely");
    const { assessInviteForAcceptance } = await import("./invite-assess");
    const { loadLiveMembership } = await import("../authz");
    const { InvalidInvite, InviteNotForYou, InviteHouseholdGone } = await import("./errors");

    const session = await getServerSession();
    if (!session?.user.did) throw redirect({ to: "/login" });
    const did = session.user.did;
    const sessionId = session.session.id;

    return getDb()
      .transaction()
      .execute(async (trx) => {
        // Lock the row so a concurrent accept can't over-consume `uses`.
        const invite = await trx.selectFrom("household_invite").selectAll().where("id", "=", data.inviteId).forUpdate().executeTakeFirst();
        if (!invite) throw new InvalidInvite();

        // By-id acceptance is ONLY for bound invites the caller owns (open links
        // are accepted through the token route). Gate before anything else.
        if (invite.bound_to_did === null || invite.bound_to_did !== did) throw new InviteNotForYou();

        // Ordered §6.3 steps 2–5 (revoked → expired → exhausted → bound-mismatch).
        const problem = assessInviteForAcceptance(invite, did, new Date());
        if (problem) throw problem;

        // Step 6: parent household must be live.
        const household = await trx.selectFrom("household").select(["id", "name", "deleted_at"]).where("id", "=", invite.household_id).executeTakeFirst();
        if (!household || household.deleted_at !== null) throw new InviteHouseholdGone();

        // Step 7: already a live member → idempotent success, no dup, no use spent.
        const existing = await loadLiveMembership(did, invite.household_id, trx);
        if (existing) {
          await setActiveHousehold(sessionId, invite.household_id, trx);
          return { householdId: invite.household_id, name: household.name };
        }

        // Insert, or REVIVE a soft-deleted `(household_id, did)` row (the PK).
        const prior = await trx.selectFrom("household_member").select(["did"]).where("household_id", "=", invite.household_id).where("did", "=", did).executeTakeFirst();
        if (prior) {
          await trx
            .updateTable("household_member")
            .set({ deleted_at: null, tombstoned: false, role: invite.role, invited_by_did: invite.created_by_did, joined_at: sql`now()` })
            .where("household_id", "=", invite.household_id)
            .where("did", "=", did)
            .execute();
        } else {
          await trx.insertInto("household_member").values({ household_id: invite.household_id, did, role: invite.role, invited_by_did: invite.created_by_did }).execute();
        }

        // Consume a use; flip to `accepted` once exhausted (bound invites are
        // single-use, so this flips immediately).
        const newUses = invite.uses + 1;
        const newStatus = newUses >= invite.max_uses ? "accepted" : invite.status;
        await trx.updateTable("household_invite").set({ uses: newUses, status: newStatus }).where("id", "=", invite.id).execute();

        await setActiveHousehold(sessionId, invite.household_id, trx);

        // New member's public recipes become household recipes automatically when
        // their Autoimport My Recipes preference is on (default).
        const { importMemberRecipes } = await import("./autoimport");
        await importMemberRecipes(trx, invite.household_id, did);

        // TODO(email): notify the inviting owner (`invite.created_by_did`) that
        // the invite was accepted (§6.3 / §11) — mirrors B's acceptInvite seam.

        return { householdId: invite.household_id, name: household.name };
      });
  });

/**
 * Decline a pending BOUND invite from the onboarding screen, keyed by invite id
 * (see {@link acceptBoundInviteById} for why by-id). Mirrors B's
 * `declineBoundInvite` (§6.4): gates on `bound_to_did === sessionDid`, sets
 * `status = 'declined'` so it stops auto-surfacing on the onboarding screen.
 * → `{ declined: true }`
 */
export const declineBoundInviteById = createServerFn({ method: "POST" })
  .validator((data: { inviteId: string }) => ({ inviteId: validateInviteId(data?.inviteId) }))
  .handler(async ({ data }): Promise<{ declined: true }> => {
    const { requireSessionDid } = await import("./session");
    const { getDb } = await import("#/lib/db");
    const { InvalidInvite, InviteNotForYou } = await import("./errors");

    const did = await requireSessionDid();
    const db = getDb();

    const invite = await db.selectFrom("household_invite").select(["id", "bound_to_did"]).where("id", "=", data.inviteId).executeTakeFirst();
    if (!invite) throw new InvalidInvite();
    if (invite.bound_to_did === null || invite.bound_to_did !== did) throw new InviteNotForYou();

    await db.updateTable("household_invite").set({ status: "declined" }).where("id", "=", invite.id).execute();

    return { declined: true };
  });
