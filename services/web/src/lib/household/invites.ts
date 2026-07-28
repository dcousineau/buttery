import { createServerFn } from "@tanstack/react-start";
import { redirect } from "@tanstack/react-router";
import type { Role } from "./errors";

/**
 * Invite lifecycle server functions (§6, §9): create / revoke / list / preview /
 * accept / decline. Server-only — heavy deps are dynamically imported per
 * handler (see `households.ts` for the rationale). Ordered acceptance validation
 * (§6.3) is fail-closed and factored through the pure `assessInviteForAcceptance`
 * so every branch is unit-tested without a DB.
 *
 * FROZEN §9 contract — names, inputs, and RETURN shapes are Agent C's UI surface.
 */

/** One pending invite, safe to expose to owners. Never includes `token_hash`. */
export interface InviteSummary {
  id: string;
  role: Role;
  /** DID this invite is locked to (bound invite), or null for an open link. */
  boundToDid: string | null;
  maxUses: number;
  uses: number;
  /** ISO timestamp, or null for a never-expiring invite. */
  expiresAt: string | null;
  createdAt: string;
  status: string;
}

/** Public-ish acceptance-screen preview — no use consumed, no auth required. */
export interface InvitePreview {
  householdName: string;
  inviterHandle: string | null;
  role: Role;
}

const MAX_USES_CAP = 100;
const DEFAULT_OPEN_MAX_USES = 5;
const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TOKEN_MAX_LEN = 512;

function asRole(role: string): Role {
  return role === "owner" ? "owner" : "member";
}

function validateHouseholdId(id: unknown): string {
  if (typeof id !== "string" || id.length === 0) throw new Error("householdId is required.");
  return id;
}

function validateToken(token: unknown): string {
  if (typeof token !== "string" || token.length === 0 || token.length > TOKEN_MAX_LEN) throw new Error("A valid invite token is required.");
  return token;
}

/**
 * Mint an invite (owners only) and return its shareable link. The RAW token
 * lives ONLY in the returned link; the DB stores `sha256(token)`.
 *
 * - Bound (`boundHandle` given): resolve the handle → DID, set `bound_to_did`,
 *   force `max_uses = 1`.
 * - Open: `bound_to_did = null`, `max_uses` = caller's (clamped to
 *   1..${MAX_USES_CAP}, default ${DEFAULT_OPEN_MAX_USES}).
 * - `expires_at`: caller's `expiresAt` if given, else now + 7 days.
 * - Only owners may mint `role="owner"` — enforced because the whole call is
 *   owner-gated.
 *
 * → `{ link }`  where link = `${APP_URL}/invite/<rawToken>`
 */
export const createInvite = createServerFn({ method: "POST" })
  .validator((data: { householdId: string; role?: Role; boundHandle?: string; maxUses?: number; expiresAt?: string }) => {
    const householdId = validateHouseholdId(data?.householdId);
    let role: Role = "member";
    if (data?.role !== undefined) {
      if (data.role !== "owner" && data.role !== "member") throw new Error("role must be 'owner' or 'member'.");
      role = data.role;
    }
    const boundHandle = data?.boundHandle !== undefined ? String(data.boundHandle).trim() : undefined;
    let maxUses: number | undefined;
    if (data?.maxUses !== undefined) {
      if (typeof data.maxUses !== "number" || !Number.isInteger(data.maxUses) || data.maxUses < 1) throw new Error("maxUses must be a positive integer.");
      maxUses = Math.min(data.maxUses, MAX_USES_CAP);
    }
    let expiresAt: string | undefined;
    if (data?.expiresAt !== undefined) {
      const ts = new Date(data.expiresAt);
      if (Number.isNaN(ts.getTime())) throw new Error("expiresAt must be a valid date.");
      expiresAt = ts.toISOString();
    }
    return { householdId, role, boundHandle: boundHandle || undefined, maxUses, expiresAt };
  })
  .handler(async ({ data }): Promise<{ link: string }> => {
    const { requireSessionDid } = await import("./session");
    const { assertMember } = await import("./authz");
    const { getDb } = await import("#/lib/db");
    const { generateInviteToken, hashInviteToken } = await import("./invite-token");
    const { resolveHandleToDid } = await import("./handle-resolve");
    const { ulid } = await import("./ids");
    const { APP_URL } = await import("#/lib/atproto/oauth-node");

    const did = await requireSessionDid();
    await assertMember(did, data.householdId, "owner");

    // Bound vs. open shape.
    let boundToDid: string | null = null;
    let maxUses: number;
    if (data.boundHandle) {
      const resolved = await resolveHandleToDid(data.boundHandle);
      if (!resolved) throw new Error(`Could not resolve the handle "${data.boundHandle}" to an account.`);
      boundToDid = resolved;
      maxUses = 1; // bound invites are single-use
    } else {
      maxUses = data.maxUses ?? DEFAULT_OPEN_MAX_USES;
    }
    const expiresAt = new Date(data.expiresAt ?? Date.now() + DEFAULT_EXPIRY_MS);

    const token = generateInviteToken();
    const tokenHash = hashInviteToken(token);
    const id = ulid();

    await getDb()
      .insertInto("household_invite")
      .values({
        id,
        household_id: data.householdId,
        created_by_did: did,
        role: data.role,
        token_hash: tokenHash,
        bound_to_did: boundToDid,
        max_uses: maxUses,
        expires_at: expiresAt,
        status: "pending",
      })
      .execute();

    // TODO(email): if this is a bound invite and `boundToDid` has a known contact
    // path, send the transactional invite email here (§6.2 / §11).

    return { link: `${APP_URL}/invite/${token}` };
  });

/**
 * Revoke an invite (owners only). Household is resolved from the invite id.
 * → `{ id, revoked: true }`
 */
export const revokeInvite = createServerFn({ method: "POST" })
  .validator((data: { inviteId: string }) => {
    if (typeof data?.inviteId !== "string" || data.inviteId.length === 0) throw new Error("inviteId is required.");
    return { inviteId: data.inviteId };
  })
  .handler(async ({ data }): Promise<{ id: string; revoked: true }> => {
    const { requireSessionDid } = await import("./session");
    const { assertMember } = await import("./authz");
    const { getDb } = await import("#/lib/db");
    const { sql } = await import("kysely");
    const { InvalidInvite } = await import("./errors");

    const did = await requireSessionDid();
    const db = getDb();

    const invite = await db.selectFrom("household_invite").select(["household_id"]).where("id", "=", data.inviteId).executeTakeFirst();
    if (!invite) throw new InvalidInvite();

    await assertMember(did, invite.household_id, "owner");

    await db
      .updateTable("household_invite")
      .set({ status: "revoked", revoked_at: sql`now()` })
      .where("id", "=", data.inviteId)
      .execute();

    return { id: data.inviteId, revoked: true };
  });

/**
 * List an owner's pending, un-revoked invites for the management UI. Token
 * hashes are never selected; raw tokens are unrecoverable by design.
 * → `Array<InviteSummary>`
 */
export const listInvites = createServerFn({ method: "GET" })
  .validator((data: { householdId: string }) => ({ householdId: validateHouseholdId(data?.householdId) }))
  .handler(async ({ data }): Promise<InviteSummary[]> => {
    const { requireSessionDid } = await import("./session");
    const { assertMember } = await import("./authz");
    const { getDb } = await import("#/lib/db");

    const did = await requireSessionDid();
    await assertMember(did, data.householdId, "owner");

    const rows = await getDb()
      .selectFrom("household_invite")
      .select(["id", "role", "bound_to_did", "max_uses", "uses", "expires_at", "created_at", "status"])
      .where("household_id", "=", data.householdId)
      .where("status", "=", "pending")
      .where("revoked_at", "is", null)
      .orderBy("created_at", "desc")
      .execute();

    return rows.map((r) => ({
      id: r.id,
      role: asRole(r.role),
      boundToDid: r.bound_to_did,
      maxUses: r.max_uses,
      uses: r.uses,
      expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
      createdAt: new Date(r.created_at).toISOString(),
      status: r.status,
    }));
  });

/**
 * Preview an invite for the acceptance screen. Does NOT consume a use and does
 * NOT require auth. Fails closed on invalid / revoked / expired / dead-household.
 * → `{ householdName, inviterHandle, role }`
 */
export const getInvitePreview = createServerFn({ method: "GET" })
  .validator((data: { token: string }) => ({ token: validateToken(data?.token) }))
  .handler(async ({ data }): Promise<InvitePreview> => {
    const { getDb } = await import("#/lib/db");
    const { hashInviteToken } = await import("./invite-token");
    const { isRevoked, isExpired } = await import("./invite-assess");
    const { InvalidInvite, InviteRevoked, InviteExpired, InviteHouseholdGone } = await import("./errors");

    const db = getDb();
    const tokenHash = hashInviteToken(data.token);

    const invite = await db.selectFrom("household_invite").selectAll().where("token_hash", "=", tokenHash).executeTakeFirst();
    if (!invite) throw new InvalidInvite();
    if (isRevoked(invite)) throw new InviteRevoked();
    if (isExpired(invite, new Date())) throw new InviteExpired();

    const household = await db.selectFrom("household").select(["name", "deleted_at"]).where("id", "=", invite.household_id).executeTakeFirst();
    if (!household || household.deleted_at !== null) throw new InviteHouseholdGone();

    // Best-effort inviter handle from our indexed atproto repos (no network).
    const inviter = await db.selectFrom("atproto_repo").select(["handle"]).where("did", "=", invite.created_by_did).executeTakeFirst();

    return { householdName: household.name, inviterHandle: inviter?.handle ?? null, role: asRole(invite.role) };
  });

/**
 * Accept an invite: join (or revive a prior membership in) the household and set
 * it active. Validates §6.3 steps 1–7 in order, failing closed; the whole
 * mutation is one transaction. Idempotent when already a live member.
 * → `{ householdId, name }`
 */
export const acceptInvite = createServerFn({ method: "POST" })
  .validator((data: { token: string }) => ({ token: validateToken(data?.token) }))
  .handler(async ({ data }): Promise<{ householdId: string; name: string }> => {
    const { getServerSession, setActiveHousehold } = await import("./session");
    const { getDb } = await import("#/lib/db");
    const { sql } = await import("kysely");
    const { hashInviteToken } = await import("./invite-token");
    const { assessInviteForAcceptance } = await import("./invite-assess");
    const { loadLiveMembership } = await import("./authz");
    const { InvalidInvite, InviteHouseholdGone } = await import("./errors");

    const session = await getServerSession();
    if (!session?.user.did) throw redirect({ to: "/login" });
    const did = session.user.did;
    const sessionId = session.session.id;

    const tokenHash = hashInviteToken(data.token);

    return getDb()
      .transaction()
      .execute(async (trx) => {
        // Step 1: token hashes to an existing invite. Lock the row so a
        // concurrent accept can't over-consume `uses`.
        const invite = await trx.selectFrom("household_invite").selectAll().where("token_hash", "=", tokenHash).forUpdate().executeTakeFirst();
        if (!invite) throw new InvalidInvite();

        // Steps 2–5 (pure, ordered, fail-closed).
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

        // Insert, or REVIVE a soft-deleted `(household_id, did)` row (the PK) to
        // avoid a unique-violation on re-accept after removal.
        const prior = await trx
          .selectFrom("household_member")
          .select(["did"])
          .where("household_id", "=", invite.household_id)
          .where("did", "=", did)
          .executeTakeFirst();

        if (prior) {
          await trx
            .updateTable("household_member")
            .set({ deleted_at: null, tombstoned: false, role: invite.role, invited_by_did: invite.created_by_did, joined_at: sql`now()` })
            .where("household_id", "=", invite.household_id)
            .where("did", "=", did)
            .execute();
        } else {
          await trx
            .insertInto("household_member")
            .values({ household_id: invite.household_id, did, role: invite.role, invited_by_did: invite.created_by_did })
            .execute();
        }

        // Consume a use; flip to `accepted` once exhausted (single-use/bound flip
        // immediately, multi-use links stay pending until the last use).
        const newUses = invite.uses + 1;
        const newStatus = newUses >= invite.max_uses ? "accepted" : invite.status;
        await trx.updateTable("household_invite").set({ uses: newUses, status: newStatus }).where("id", "=", invite.id).execute();

        await setActiveHousehold(sessionId, invite.household_id, trx);

        // TODO(email): notify the inviting owner (`invite.created_by_did`) that
        // the invite was accepted (§6.3 / §11).

        return { householdId: invite.household_id, name: household.name };
      });
  });

/**
 * Decline a bound invite (§6.4): mark it `declined` so it no longer auto-surfaces
 * on the invitee's onboarding screen. Only meaningful for bound invites; a
 * non-target caller is rejected.
 * → `{ declined: true }`
 */
export const declineBoundInvite = createServerFn({ method: "POST" })
  .validator((data: { token: string }) => ({ token: validateToken(data?.token) }))
  .handler(async ({ data }): Promise<{ declined: true }> => {
    const { requireSessionDid } = await import("./session");
    const { getDb } = await import("#/lib/db");
    const { hashInviteToken } = await import("./invite-token");
    const { InvalidInvite, InviteNotForYou } = await import("./errors");

    const did = await requireSessionDid();
    const db = getDb();
    const tokenHash = hashInviteToken(data.token);

    const invite = await db.selectFrom("household_invite").select(["id", "bound_to_did"]).where("token_hash", "=", tokenHash).executeTakeFirst();
    if (!invite) throw new InvalidInvite();
    if (invite.bound_to_did !== null && invite.bound_to_did !== did) throw new InviteNotForYou();

    await db.updateTable("household_invite").set({ status: "declined" }).where("id", "=", invite.id).execute();

    return { declined: true };
  });
