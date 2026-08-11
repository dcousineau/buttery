import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotAMemberError } from "./household/errors";

/**
 * The §4.1 authorization gate, pinned **at the entry points** (acceptance
 * §16.17: "a member of another household cannot probe, compare, or commit into
 * this household").
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 * `authz.test.ts` proves `assertMember` decides correctly, and the DB suites
 * prove every `run*` helper scopes its queries by `household_id`. Neither proves
 * the gate is *called*: every household test drives the exported `run*` helpers
 * directly, passing a `householdId` the caller is simply trusted to have earned,
 * so deleting `await assertMember(did, householdId)` from any of the eight
 * server functions here fails nothing. Scoping-by-household is the second lock;
 * `assertMember` is the first, and it is the one that answers "is this caller a
 * live member at all" — a session id is *opaque* (§ validators), and `runOpen…`
 * and `runFail…` take a household id straight from the request context.
 *
 * ── HOW ──────────────────────────────────────────────────────────────────
 * `createServerFn` is faked so `.handler(fn)` hands back the handler itself,
 * wrapped in the same input-validation step the real server-side execution
 * performs (`execValidator` before `serverFn`). Everything else — the handler
 * body, the `activeContext()` → `assertMember()` → `run*()` sequence — is the
 * shipped code. This is not "testing the mock": the fake stands in only for the
 * RPC transport, which is the one part of the path that cannot exist in a unit
 * test, and the assertions are all about what the handler does.
 *
 * `#/lib/db` is faked to a `getDb` that throws a sentinel, which makes the
 * boundary observable in both directions with no database:
 *
 *   - authorized  → the sentinel escapes, so control provably reached the
 *                   post-authorization work;
 *   - unauthorized → `NotAMemberError` escapes and `getDb` was never called, so
 *                   no query ran on behalf of a non-member.
 */

const DID = "did:test:import-authz";
const HH = "hh-import-authz";

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
const activeContext = vi.fn(() => Promise.resolve({ did: DID, householdId: HH }));

vi.mock("#/lib/db", () => ({ getDb }));
vi.mock("./recipe-context", () => ({ activeContext }));
vi.mock("./authz", async (importOriginal) => ({ ...(await importOriginal<object>()), assertMember }));

/**
 * The server-side half of `createServerFn`, and nothing more: validate the input
 * with the declared validator, then call the handler with `{ data }`. The real
 * builder's client half is an RPC round trip, which is not what any assertion
 * here is about.
 */
vi.mock("@tanstack/react-start", async (importOriginal) => {
  type Validator = (data: unknown) => unknown;
  const builder = (validator: Validator | null) => ({
    validator: (v: Validator) => builder(v),
    inputValidator: (v: Validator) => builder(v),
    middleware: () => builder(validator),
    // Deferred so a throwing validator/handler rejects, exactly as the real
    // (async) server fn does — several tests assert on the rejection.
    handler: (fn: (ctx: { data: unknown }) => unknown) => (opts?: { data?: unknown }) => Promise.resolve().then(() => fn({ data: validator ? validator(opts?.data) : opts?.data })),
  });
  return { ...(await importOriginal<object>()), createServerFn: () => builder(null) };
});

const imports = await import("./recipe-import");
const writes = await import("./recipes-write");

/**
 * Every server function that takes a household action, with a payload its
 * validator accepts. A new entry point added without a gate is caught by this
 * list only if it is added here too — which is why the count is asserted below.
 */
const GATED: readonly [name: string, call: () => Promise<unknown>][] = [
  ["openImportSession", () => imports.openImportSession({ data: { importer: "paprika", fileName: "My Recipes", totalCount: 1 } })],
  ["probeImportDuplicates", () => imports.probeImportDuplicates({ data: { sessionId: "s1", items: [] } })],
  ["commitImportChunk", () => imports.commitImportChunk({ data: { sessionId: "s1", items: [] } })],
  ["getImportComparison", () => imports.getImportComparison({ data: { sessionId: "s1", recipeIds: [] } })],
  [
    "finalizeImportSession",
    () =>
      imports.finalizeImportSession({
        data: {
          sessionId: "s1",
          outcome: {
            total: 0,
            imported: 0,
            linked: 0,
            skippedDuplicate: 0,
            skippedUser: 0,
            failed: 0,
            overriddenDuplicate: 0,
            editedBeforeCommit: 0,
            parseFailures: 0,
            distinctSourceStringsClassified: 0,
          },
        },
      }),
  ],
  ["failImportSession", () => imports.failImportSession({ data: { sessionId: "s1", stage: "parse", message: "boom" } })],
  ["saveRecipe", () => writes.saveRecipe({ data: { record: { name: "X", text: "", ingredients: ["a"], instructions: ["b"] }, visibility: "private", publish: false } })],
  ["publishRecipe", () => writes.publishRecipe({ data: { recipeId: "r1" } })],
];

// `reset`, not `clear`: a `mockRejectedValueOnce` that the case under test never
// consumed — precisely what happens when a gate goes missing — would otherwise
// leak into the next entry point and report the failure against the wrong one.
beforeEach(() => {
  vi.resetAllMocks();
  getDb.mockImplementation(() => {
    throw new DatabaseReached();
  });
  assertMember.mockImplementation(() => Promise.resolve({} as never));
  activeContext.mockImplementation(() => Promise.resolve({ did: DID, householdId: HH }));
});

describe.each(GATED)("%s", (_name, call) => {
  it("calls assertMember with the request context's did + household before doing any work", async () => {
    await expect(call()).rejects.toBeInstanceOf(DatabaseReached);

    expect(assertMember).toHaveBeenCalledTimes(1);
    expect(assertMember).toHaveBeenCalledWith(DID, HH);
    // The gate ran first: `getDb()` is what threw, and it threw after the gate.
    expect(assertMember.mock.invocationCallOrder[0]).toBeLessThan(getDb.mock.invocationCallOrder[0]);
  });

  it("refuses a caller assertMember rejects, and issues no query on their behalf", async () => {
    assertMember.mockRejectedValueOnce(new NotAMemberError());

    await expect(call()).rejects.toBeInstanceOf(NotAMemberError);
    expect(getDb).not.toHaveBeenCalled();
  });
});

/**
 * `describe.each` can only gate the entry points it is handed, so the list above
 * is only as good as its completeness. This reads the two modules' source and
 * fails when a `createServerFn` appears that nothing here drives — a new entry
 * point cannot ship un-gated *and* unnoticed.
 *
 * Source text rather than the module namespace, deliberately: the fake
 * `createServerFn` erases every runtime marker that would tell a server function
 * apart from an ordinary exported function, so a namespace-based check here
 * would quietly degrade to "the list equals itself".
 */
describe("the gated list covers every exported server function", () => {
  it("names all of them", async () => {
    const { readFileSync } = await import("node:fs");
    const declared = ["./recipe-import.ts", "./recipes-write.ts"].flatMap((rel) =>
      [...readFileSync(new URL(rel, import.meta.url), "utf8").matchAll(/export const (\w+) = createServerFn\b/g)].map((m) => m[1]),
    );

    expect(declared.length).toBeGreaterThan(0); // the regex still matches the idiom
    expect(declared.sort()).toEqual(GATED.map(([n]) => n).sort());
  });
});
