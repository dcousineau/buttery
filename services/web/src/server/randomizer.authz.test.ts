import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotAMemberError } from "./household/errors";

/**
 * `getRandomizerPool`'s entry-point gate (meal randomizer plan §3, §10's
 * "non-member **and no-active-household** fail closed").
 *
 * ── WHY THIS FILE EXISTS, BESIDE `randomizer.db.test.ts` ──────────────────
 * The db suite drives the exported `readRandomizerPool(db, did, householdId,
 * input)` directly, because that is the only way to reach the SQL without a
 * session. That proves the membership join scopes every query — but it cannot
 * prove the half of §3 that lives above it: that the household comes from
 * `session.active_household_id` and never from the caller, and that a request
 * with a session but NO active household is refused before a single query
 * runs. Deleting `activeContext()`'s `if (!householdId) throw` would fail
 * nothing in the db suite.
 *
 * ── HOW ───────────────────────────────────────────────────────────────────
 * The technique is `import-authz.test.ts`'s, verbatim in spirit:
 * `createServerFn` is faked down to "validate, then call the handler", and
 * `#/lib/db`'s `getDb` throws a sentinel. That makes the gate observable in
 * both directions with no database — the sentinel escaping means control
 * provably got past authorization, and `NotAMemberError` escaping with `getDb`
 * untouched means no query ever ran for an unauthorized caller.
 */

const DID = "did:test:randomizer-authz";
const HH = "hh-randomizer-authz";

/** Thrown by the faked `getDb` — "control got past the gate". */
class DatabaseReached extends Error {
  constructor() {
    super("the handler reached the database");
    this.name = "DatabaseReached";
  }
}

const getDb = vi.fn(() => {
  throw new DatabaseReached();
});
const assertMember = vi.fn((_did: string, _householdId: string) => Promise.resolve({} as never));
const getServerSession = vi.fn(() => Promise.resolve<unknown>({ user: { did: DID }, session: { active_household_id: HH } }));

vi.mock("#/lib/db", () => ({ getDb }));
vi.mock("./household/session", () => ({ getServerSession }));
vi.mock("./authz", async (importOriginal) => ({ ...(await importOriginal<object>()), assertMember }));

/** The server-side half of `createServerFn` and nothing more: validate, then call the handler. */
vi.mock("@tanstack/react-start", async (importOriginal) => {
  type Validator = (data: unknown) => unknown;
  const builder = (validator: Validator | null) => ({
    validator: (v: Validator) => builder(v),
    inputValidator: (v: Validator) => builder(v),
    middleware: () => builder(validator),
    handler: (fn: (ctx: { data: unknown }) => unknown) => (opts?: { data?: unknown }) => Promise.resolve().then(() => fn({ data: validator ? validator(opts?.data) : opts?.data })),
  });
  return { ...(await importOriginal<object>()), createServerFn: () => builder(null) };
});

const randomizer = await import("./randomizer");

beforeEach(() => {
  vi.resetAllMocks();
  getDb.mockImplementation(() => {
    throw new DatabaseReached();
  });
  assertMember.mockImplementation(() => Promise.resolve({} as never));
  getServerSession.mockImplementation(() => Promise.resolve({ user: { did: DID }, session: { active_household_id: HH } }));
});

describe("getRandomizerPool — the entry-point gate (§3, §10)", () => {
  it("gates on the session's active household, then reaches the database", async () => {
    await expect(randomizer.getRandomizerPool({ data: {} })).rejects.toBeInstanceOf(DatabaseReached);

    expect(assertMember).toHaveBeenCalledTimes(1);
    expect(assertMember).toHaveBeenCalledWith(DID, HH);
    // The gate ran FIRST: `getDb()` is what threw, and it threw after it.
    expect(assertMember.mock.invocationCallOrder[0]).toBeLessThan(getDb.mock.invocationCallOrder[0]);
  });

  it("fails closed with no active household — before any query", async () => {
    getServerSession.mockImplementation(() => Promise.resolve({ user: { did: DID }, session: { active_household_id: null } }));

    await expect(randomizer.getRandomizerPool({ data: {} })).rejects.toBeInstanceOf(NotAMemberError);
    expect(assertMember).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
  });

  it("fails closed for a non-member of the active household — before any query", async () => {
    assertMember.mockRejectedValueOnce(new NotAMemberError());

    await expect(randomizer.getRandomizerPool({ data: {} })).rejects.toBeInstanceOf(NotAMemberError);
    expect(getDb).not.toHaveBeenCalled();
  });

  it("fails closed with no session at all — before any query", async () => {
    getServerSession.mockImplementation(() => Promise.resolve(null));

    // `activeContext` throws a router redirect to /login, which is neither a
    // `NotAMemberError` nor a pass; all this asserts is that it did not pass.
    await expect(randomizer.getRandomizerPool({ data: {} })).rejects.toBeDefined();
    expect(assertMember).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
  });

  it("takes the household from the session, never from the caller's payload", async () => {
    // §3: "the active household resolved from `session.active_household_id`
    // (never a client argument)". A hostile client sends one anyway; the
    // validator drops it and the gate still runs against the session's.
    await expect(randomizer.getRandomizerPool({ data: { householdId: "hh-someone-else", source: "corpus" } })).rejects.toBeInstanceOf(DatabaseReached);
    expect(assertMember).toHaveBeenCalledWith(DID, HH);
  });
});
