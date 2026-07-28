import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulid } from "./ids";

/**
 * DB-backed integration tests for the household server logic.
 *
 * These require a reachable Postgres with the household tables migrated. In this
 * worktree the DB is NOT reachable (no `.env`, no network), so the whole suite
 * SKIPS unless `DATABASE_URL` is set. Run it against a dev DB with:
 *
 *   railway run --service buttery -- ./node_modules/.bin/vitest run households.db
 *
 * We exercise the code paths that don't need an HTTP session context: the
 * tombstone path (§7.2) and the live-membership predicate that backs the §4
 * authorization chokepoint. The session-gated server functions (create/accept/
 * remove/leave) are covered by the pure suites for their decision logic and are
 * intended for an end-to-end HTTP pass once a dev DB + auth are wired.
 */

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("household DB integration", () => {
  // Namespace this run's rows so cleanup is precise and parallel runs don't clash.
  const OWNER_A = `did:test:${ulid()}`;
  const OWNER_B = `did:test:${ulid()}`;
  const soleHousehold = ulid();
  const dualHousehold = ulid();
  const createdHouseholdIds = [soleHousehold, dualHousehold];
  const testDids = [OWNER_A, OWNER_B];

  // Loaded lazily so the module import doesn't touch `getDb()` when skipped.
  let getDb: typeof import("#/lib/db").getDb;
  let tombstoneMemberForDeletedAccount: typeof import("./members").tombstoneMemberForDeletedAccount;
  let loadLiveMembership: typeof import("./authz").loadLiveMembership;

  beforeAll(async () => {
    ({ getDb } = await import("#/lib/db"));
    ({ tombstoneMemberForDeletedAccount } = await import("./members"));
    ({ loadLiveMembership } = await import("./authz"));

    const db = getDb();
    await db.insertInto("household").values({ id: soleHousehold, name: "Sole", created_by_did: OWNER_A }).execute();
    await db.insertInto("household_member").values({ household_id: soleHousehold, did: OWNER_A, role: "owner", invited_by_did: null }).execute();

    await db.insertInto("household").values({ id: dualHousehold, name: "Dual", created_by_did: OWNER_A }).execute();
    await db.insertInto("household_member").values({ household_id: dualHousehold, did: OWNER_A, role: "owner", invited_by_did: null }).execute();
    await db.insertInto("household_member").values({ household_id: dualHousehold, did: OWNER_B, role: "owner", invited_by_did: null }).execute();
  });

  afterAll(async () => {
    if (!getDb) return;
    const db = getDb();
    await db.deleteFrom("household_invite").where("household_id", "in", createdHouseholdIds).execute();
    await db.deleteFrom("household_member").where("household_id", "in", createdHouseholdIds).execute();
    await db.deleteFrom("household").where("id", "in", createdHouseholdIds).execute();
    // Belt-and-suspenders: remove any stray members keyed by our test DIDs.
    await db.deleteFrom("household_member").where("did", "in", testDids).execute();
  });

  it("loadLiveMembership returns a live owner and is the §4 chokepoint predicate (item 12)", async () => {
    const m = await loadLiveMembership(OWNER_A, dualHousehold);
    expect(m?.role).toBe("owner");
    // A DID with no membership must not resolve.
    expect(await loadLiveMembership("did:test:nobody", dualHousehold)).toBeUndefined();
  });

  it("tombstoning one of two owners leaves the household live (item 9)", async () => {
    await tombstoneMemberForDeletedAccount(dualHousehold, OWNER_B);
    const db = getDb();

    // Tombstoned member no longer live.
    expect(await loadLiveMembership(OWNER_B, dualHousehold)).toBeUndefined();
    const bRow = await db.selectFrom("household_member").select(["tombstoned", "deleted_at"]).where("household_id", "=", dualHousehold).where("did", "=", OWNER_B).executeTakeFirst();
    expect(bRow?.tombstoned).toBe(true);
    expect(bRow?.deleted_at).not.toBeNull();

    // Surviving owner + household still live.
    expect((await loadLiveMembership(OWNER_A, dualHousehold))?.role).toBe("owner");
    const hh = await db.selectFrom("household").select(["deleted_at"]).where("id", "=", dualHousehold).executeTakeFirst();
    expect(hh?.deleted_at).toBeNull();
  });

  it("tombstoning the SOLE owner soft-deletes the household (§7.2)", async () => {
    await tombstoneMemberForDeletedAccount(soleHousehold, OWNER_A);
    const db = getDb();

    const hh = await db.selectFrom("household").select(["deleted_at"]).where("id", "=", soleHousehold).executeTakeFirst();
    expect(hh?.deleted_at).not.toBeNull();
    // No live membership survives a dead household.
    expect(await loadLiveMembership(OWNER_A, soleHousehold)).toBeUndefined();
  });
});
