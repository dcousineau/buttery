import { createServerFn } from "@tanstack/react-start";
import type { Kysely } from "kysely";
import * as z from "zod";
import type { JsonObject, JsonValue } from "@buttery/recipe-extract/import";
import type { DB } from "#/db/types";
import { IMPORTER_IDS, type ImporterId } from "#/lib/recipe-import-ids";
import { DEDUPE_NS, type AttributionChoice, type RecipeRecordInput } from "./recipes-write";

/**
 * Batch recipe import — the **pipeline** server contracts (plan §7).
 *
 * docs/plans/2026-08-09-paprika-import.md, §7.1–§7.7, §11 (server half), §12.5,
 * §13. Everything here is generic: it consumes probe keys and `ImportCandidate`-
 * shaped commit items and never learns which app produced them.
 *
 * ── THE BOUNDARY (§2.5, §16.19) ───────────────────────────────────────────
 * No module under `services/web/src/server/recipe-import*` may import from
 * `@buttery/recipe-extract/paprika`, and ESLint enforces it. The importer's own
 * vocabulary travels as an opaque `meta` bag this module writes to the sidecar
 * without reading a key out of it. The one importer fact the server needs — the
 * list of legal ids — is data, in `#/lib/recipe-import-ids`, which imports
 * nothing.
 *
 * ── PUBLISHING IS STRUCTURALLY IMPOSSIBLE HERE (§2.1, §7.4) ───────────────
 * This module does not import `publishLocalRecipe`, does not import
 * `publishOrScopeError`, and never reads `isAtprotoPublishEnabled`. It reaches
 * persistence through `persistRecipeDraft`, which by contract has NO publish
 * step (see its doc comment), and it always passes `visibility: "private"` —
 * never `"draft"`, and never a user-scoped visibility, because the household is
 * the minimum privacy scope (§2.2). The result is that a 341-recipe batch has
 * no code path to a PDS at all: there is nothing to disable and no flag to get
 * wrong. A user who wants an imported recipe public opens it and publishes it
 * individually through the existing reviewed flow. Do not add an import-time
 * publish branch here — add it to that flow, where a human is looking at one
 * recipe. A DB test asserts every committed import has `uri = null`.
 *
 * ── SHAPE ─────────────────────────────────────────────────────────────────
 * Same idiom as `server/meal-plan.ts`: each `createServerFn` is a thin wrapper
 * that resolves the DID from the validated session, the household from
 * `session.active_household_id` (NEVER a client argument) and gates through
 * `assertMember`; all behaviour lives in a plain exported `run*` function taking
 * `(db, did, householdId, input)` so the DB suites can drive it without faking a
 * session. Server-only deps are pulled in with dynamic `import()` inside the
 * handlers so this module stays safe to reference from the client bundle.
 */

// --- §7.1 probe: shapes -------------------------------------------------

/** One item's dedupe keys. **Keys only** — no recipe bodies, no ingredient text. */
export interface ProbeItem {
  /** Client-minted (`crypto.randomUUID()`), stable for this session; joins probe → commit. */
  clientId: string;
  sourceUrlKey: string | null;
  contentFp: string;
  /**
   * Raw candidate name. Compared with `similarity(recipe.name, $1)` against the
   * existing trigram index — there is no normalized-title column (§6.4).
   */
  title: string;
}

export interface ProbeInput {
  sessionId: string;
  items: ProbeItem[];
}

/** Identity of a matched recipe. The review screen renders all four fields (§10.2, D20). */
export interface ExistingRef {
  recipeId: string;
  name: string;
  /** ISO. `household_recipe.added_at` for a box match, `recipe.indexed_at` for a public one. */
  addedAt: string;
  /** "@handle", already prefixed. DIDs are resolved in ONE batched query, not per item. */
  addedByHandle: string | null;
}

/**
 * What the probe says about one item (§6.3).
 *
 * `dupe_in_batch` is not in §6.3's four-corpus table because the plan expects the
 * client to collapse same-key entries before it calls. The server reports it
 * anyway rather than silently returning two identical `new` verdicts for one
 * recipe: the collapse is a client behaviour and the server cannot assume it ran.
 * The FIRST item to claim a key gets the corpus verdict; every later item sharing
 * that key gets `dupe_in_batch` pointing at the first.
 */
export type ProbeVerdict =
  | { clientId: string; verdict: "new" }
  | { clientId: string; verdict: "in_box"; existing: ExistingRef }
  | { clientId: string; verdict: "public_exists"; existing: ExistingRef }
  | { clientId: string; verdict: "maybe"; candidates: ExistingRef[] }
  | { clientId: string; verdict: "dupe_in_batch"; duplicateOfClientId: string };

// --- §7.2 commit: shapes ------------------------------------------------

/**
 * A user's free-text attribution classification (§8.1), resolved in review.
 *
 * Aliased rather than redefined: the plan calls this `AttributionInput`, but the
 * one implementation that turns a classification into a lexicon attribution is
 * `resolveAttribution` in `recipes-write.ts` and it already owns this type. A
 * second shape here is a second place §8.2's "never auto-invent attribution" rule
 * could be broken.
 */
export type AttributionInput = AttributionChoice;

export interface CommitItemBase {
  clientId: string;
  /** Human-facing provenance ("Beef Bourguignon 2.html"). Written to the sidecar (§12.5). */
  entryName: string;
}

export type CommitItem =
  | (CommitItemBase & {
      action: "import";
      /** Lexicon-shaped, minus server-owned fields; MAY be user-edited (§10.2, D25). */
      record: RecipeRecordInput;
      sourceUrl: string | null;
      /** Resolved in review (§8). Ignored when `sourceUrl` is set — the server builds Website itself. */
      attribution: AttributionInput | null;
      /** Remote URL only (§11). Local bytes are never uploaded in phase 1. */
      imageSourceUrl: string | null;
      notes: string | null;
      tags: string[];
      /**
       * The candidate's verbatim source string, preserved in the sidecar under the
       * reserved `source_text` key **whatever the user classified it as** (§8.2,
       * §12.5).
       *
       * DEVIATION from §7.2's literal item shape, which omits it: §12.5 makes
       * `source_text` a row the pipeline is *required* to write, and the pipeline
       * has no other way to learn it — `meta` cannot carry it (the key is
       * reserved and rejected) and the record does not contain it. Without this
       * field the reserved key would be permanently null.
       */
      sourceText: string | null;
      /** User deliberately re-imported an `in_box` match (§6.3, D23). */
      override?: "duplicate";
      /**
       * `ImportCandidate.meta`, verbatim. Written to the sidecar (§12.5); the
       * server never reads a key out of it. Adding an importer adds no field here.
       */
      meta: JsonObject;
    })
  | (CommitItemBase & {
      action: "link";
      /** The `ExistingRef.recipeId` the probe returned for a `public_exists` verdict the user accepted (§6.3, D22). */
      existingRecipeId: string;
      notes: string | null;
      sourceText: string | null;
      meta: JsonObject;
    })
  | (CommitItemBase & {
      action: "skip";
      /**
       * Why this entry produced nothing (§10.2, D24): `duplicate` — the probe
       * already said it is in the box or duplicates an earlier entry in the same
       * drop; `user` — the user took it off the list.
       *
       * DEVIATION from §7.2's literal item shape, which returns a flat
       * `skipped: "user"`. D24 requires the summary AND the session row to keep
       * the two reasons apart, and the server cannot infer this one: a skip item
       * deliberately carries no record and no keys (that is what makes 341
       * no-ops cheap), and `dupe_in_batch` — two copies inside one drop, neither
       * in the box — is not visible to the server at all. The count itself is
       * still derived from rows, never taken from the client (§7.7); only the
       * label on a row is the client's to state, and it is the only party that
       * knows it. Absent reads as `user`, the conservative half.
       */
      reason?: SkipReason;
    });

export interface CommitChunkInput {
  sessionId: string;
  items: CommitItem[];
}

/**
 * Per-item outcome. Deliberately does NOT carry the entry name: the client holds
 * the `clientId → entryName` map from the parse and joins locally to render the
 * "didn't make it" list (§7.2, §10.1). Do not add a server field for it.
 */
export type CommitItemResult =
  | { clientId: string; status: "imported"; recipeId: string }
  | { clientId: string; status: "linked"; recipeId: string }
  | { clientId: string; status: "skipped"; reason: SkipReason }
  | { clientId: string; status: "failed"; message: string };

/** The two reasons an item produced no recipe, kept apart all the way to the summary (§10.2, D24). */
export type SkipReason = "duplicate" | "user";

// --- §7.6 comparison: shapes --------------------------------------------

export interface ComparisonInput {
  sessionId: string;
  /** ≤ 25 per call. */
  recipeIds: string[];
}

export interface ComparisonEntry {
  name: string;
  recipeYield: string | null;
  hasImage: boolean;
  ingredients: string[];
  instructions: string[];
  addedAt: string;
  addedByHandle: string | null;
}

/** Keyed by recipe id. An id the caller cannot see is simply ABSENT — never a 403. */
export type ComparisonResult = Record<string, ComparisonEntry>;

// --- §5.3 / §7.7 session: shapes ----------------------------------------

/** `parsing` → `reviewing` → `committing` → `complete`, plus terminal `failed`/`abandoned` (§5.3). */
export type ImportSessionStatus = "parsing" | "reviewing" | "committing" | "complete" | "failed" | "abandoned";

export interface OpenImportSessionInput {
  /** `RecipeImporter.id`. Validated against {@link IMPORTER_IDS}; an unknown id is a 400, not a row (§5.3). */
  importer: ImporterId;
  /** What the user handed us, e.g. "My Recipes". */
  fileName?: string | null;
  /** Optional; the parse usually has not finished when the session opens. Finalize overwrites it. */
  totalCount?: number;
}

export interface ImportSessionView {
  sessionId: string;
  importer: string;
  status: ImportSessionStatus;
  fileName: string | null;
  totalCount: number;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * What the client actually observed across every chunk. **Reconciled, not
 * trusted** — the counters the sidecar can answer are derived by querying (§7.7);
 * these are the reporting figures no row can answer (what the user skipped, what
 * failed to parse, what they edited).
 */
export interface FinalizeOutcome {
  total: number;
  imported: number;
  linked: number;
  /**
   * IGNORED by `finalizeImportSession`, like `imported` and `linked` and for the
   * same reason: every skipped item is sent to the commit endpoint and recorded
   * as a row, so both halves are derived (§7.7). They stay on the type because
   * the done screen computes the same shape from its own observed results and
   * there is nothing to gain from two of them.
   */
  skippedDuplicate: number;
  /** IGNORED — see {@link FinalizeOutcome.skippedDuplicate}. */
  skippedUser: number;
  failed: number;
  overriddenDuplicate: number;
  editedBeforeCommit: number;
  parseFailures: number;
  distinctSourceStringsClassified: number;
}

export interface FinalizeInput {
  sessionId: string;
  outcome: FinalizeOutcome;
}

/** The reconciled truth: derived counts win where rows can answer. */
export interface FinalizeResult {
  sessionId: string;
  status: ImportSessionStatus;
  finishedAt: string;
  /** True only for the call that actually completed the session; false on every replay. */
  firstFinalize: boolean;
  counters: {
    total: number;
    /** DERIVED: recipes this session created privately in this box. */
    imported: number;
    /** DERIVED: existing public records this session linked into this box. */
    linked: number;
    skippedDuplicate: number;
    skippedUser: number;
    failed: number;
  };
}

/** Where an import died, for `recipe_import_failed` (§13). */
export type ImportFailureStage = "parse" | "probe" | "comparison" | "commit";

export interface FailImportSessionInput {
  sessionId: string;
  stage: ImportFailureStage;
  message: string;
}

// --- constants ----------------------------------------------------------

/** `household_recipe_meta` namespace every importer shares (§5.2). */
const IMPORT_NS = "import";

/**
 * Skips are rows, not a reported number.
 *
 * Every item that produces no recipe — the user's own exclusions AND the ones
 * the commit path declines as duplicates — writes one `recipe_import_skip` row
 * keyed `(session_id, client_id)`, so BOTH of §7.7's skip counters are derived
 * by querying, exactly like `imported` and `linked`. See the migration header
 * for why it is a table of its own rather than a `household_recipe_meta`
 * namespace: a user skip has no recipe to hang a marker on, and a skip is a fact
 * about an item in a session rather than about a recipe.
 *
 * The write is an upsert on the primary key, so a replayed chunk rewrites the
 * same rows and no count moves — which is the property a client-supplied
 * `skipped_count` could never have.
 */
const SKIP_TABLE = "recipe_import_skip" as const;

/**
 * Pipeline-owned keys in `ns='import'`. An item whose `meta` contains any of them
 * is REJECTED, not merged and not silently overwritten (§7.2, §12.5, D42): all
 * rows land in one key space, so an importer emitting one of these would clobber
 * the provenance the pipeline is required to write. A constant beside the writer,
 * not a comment.
 *
 * `client_id` is a FIFTH key beyond §12.5's four. It is the idempotency ledger
 * (see {@link findLedgerRecipe}): `(session_id, client_id)` is what makes a
 * replayed chunk return the recipe it already created instead of creating a
 * second one, and unlike the dedupe re-check it keeps holding after the user
 * edits the recipe or force-imports a known duplicate. It is reserved for the
 * same reason the other four are — an importer that could write `client_id`
 * could point this household's ledger at an arbitrary recipe.
 */
export const RESERVED_META_KEYS = ["importer", "session_id", "entry_name", "source_text", "client_id"] as const;

/** Serialized `meta` cap per item (§7.2). Generous next to a sub-1 KB importer blob. */
export const META_MAX_BYTES = 8 * 1024;

/** §7.2. The client drives the loop; anything larger is a 400. */
export const COMMIT_CHUNK_SIZE = 25;

/** §7.6. */
const COMPARISON_MAX_IDS = 25;

/** §7.1 is sized for one call per ~200 items; the client chunks if larger. */
const PROBE_MAX_ITEMS = 500;

/** §6.4. `similarity(r.name, $1) > 0.85` against the existing `recipe_name_trgm_idx`. */
export const FUZZY_TITLE_THRESHOLD = 0.85;

/** Advisory verdict; a handful of names is all the review screen can show (§6.4). */
const FUZZY_MAX_CANDIDATES = 3;

/**
 * §11. Image fetches run as a bounded pass AFTER every item in the chunk has
 * committed, never inside an item's transaction.
 *
 * The plan left this open ("bound concurrency inside the commit path or make
 * image fetching a deferred pass — decide during implementation and record it").
 * Both, in the cheapest form: a chunk of 25 issues at most 4 concurrent outbound
 * fetches, and it issues them with no transaction open, so a slow third-party
 * host cannot hold row locks. 341 recipes therefore peak at 4 concurrent fetches
 * instead of 25 — no self-inflicted outbound spike, and no interaction with the
 * `scrape:<did>` Redis limiter, which guards user-triggered page scrapes and
 * would make a 250-image import take four hours if it were applied here.
 */
const IMAGE_FETCH_CONCURRENCY = 4;

// --- validators ---------------------------------------------------------

/**
 * Ids are app-minted ULIDs, but the shape is deliberately NOT asserted (the rule
 * recipe and plan-entry ids follow): existence *in the caller's household* is the
 * only source of truth, and every read and write below re-asserts `household_id`,
 * so a guessed id is inert regardless of how well-formed it looks. The cap only
 * keeps a hostile parameter bounded.
 */
const opaqueId = z.string().min(1).max(512);

const probeItem = z.object({
  clientId: z.string().min(1).max(128),
  sourceUrlKey: z.string().max(2048).nullable(),
  contentFp: z.string().max(128),
  title: z.string().max(1024),
});

const probeInput = z.object({
  sessionId: opaqueId,
  items: z.array(probeItem).max(PROBE_MAX_ITEMS),
});

/**
 * `meta` is opaque to the pipeline's *logic* and still validated at the
 * *boundary*. Zod only proves "an object arrived"; {@link validateItemMeta} does
 * the three real checks (size, JSON shape, reserved keys) because each of them
 * has to fail the ITEM with a message, never the chunk.
 */
const looseMeta = z.unknown();

const commitItem = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("import"),
    clientId: z.string().min(1).max(128),
    entryName: z.string().max(1024),
    record: z.custom<RecipeRecordInput>((v) => typeof v === "object" && v !== null),
    sourceUrl: z.string().max(4096).nullable(),
    attribution: z.custom<AttributionInput>((v) => typeof v === "object" && v !== null).nullable(),
    imageSourceUrl: z.string().max(4096).nullable(),
    notes: z.string().max(10_000).nullable(),
    tags: z.array(z.string().max(256)).max(100),
    sourceText: z.string().max(4096).nullable(),
    override: z.literal("duplicate").optional(),
    meta: looseMeta,
  }),
  z.object({
    action: z.literal("link"),
    clientId: z.string().min(1).max(128),
    entryName: z.string().max(1024),
    /**
     * Bounded but NOT `.min(1)`, unlike {@link opaqueId}. A wire schema that
     * rejects the empty string rejects the whole 25-item chunk before the
     * per-item try/catch ever runs, which breaks §7.5's isolation guarantee for
     * the other 24 items. Emptiness and existence are both checked in
     * {@link commitLink}, where they fail exactly one item.
     */
    existingRecipeId: z.string().max(512),
    notes: z.string().max(10_000).nullable(),
    sourceText: z.string().max(4096).nullable(),
    meta: looseMeta,
  }),
  z.object({
    action: z.literal("skip"),
    clientId: z.string().min(1).max(128),
    entryName: z.string().max(1024),
    /**
     * Loose on purpose, like `existingRecipeId` above: a chunk of 25 is mostly
     * skips on a re-import, and an unrecognised reason must not 400 the other 24
     * items. {@link skipReasonOf} narrows it, and anything that is not
     * `"duplicate"` reads as `"user"`.
     */
    reason: z.string().max(32).optional(),
  }),
]);

const commitInput = z.object({
  sessionId: opaqueId,
  items: z.array(commitItem).max(COMMIT_CHUNK_SIZE),
});

/**
 * The commit wire boundary, exported so a test can assert what it does and does
 * NOT reject: everything a per-item path can turn into one `failed` result must
 * get through here, or one malformed item 400s the other 24 (§7.5).
 */
export function parseCommitChunk(data: unknown): CommitChunkInput {
  return commitInput.parse(data) as CommitChunkInput;
}

const comparisonInput = z.object({
  sessionId: opaqueId,
  recipeIds: z.array(opaqueId).max(COMPARISON_MAX_IDS),
});

/** §5.3: legal values are exactly the ids in the registry. An unknown id is a 400, not a row. */
const openSessionInput = z.object({
  importer: z.enum(IMPORTER_IDS),
  fileName: z.string().max(1024).nullable().optional(),
  totalCount: z.number().int().min(0).max(1_000_000).optional(),
});

const counter = z.number().int().min(0).max(1_000_000);

const finalizeInput = z.object({
  sessionId: opaqueId,
  outcome: z.object({
    total: counter,
    imported: counter,
    linked: counter,
    skippedDuplicate: counter,
    skippedUser: counter,
    failed: counter,
    overriddenDuplicate: counter,
    editedBeforeCommit: counter,
    parseFailures: counter,
    distinctSourceStringsClassified: counter,
  }),
});

const failInput = z.object({
  sessionId: opaqueId,
  stage: z.enum(["parse", "probe", "comparison", "commit"]),
  message: z.string().max(2000),
});

// --- server functions ---------------------------------------------------

/** Open a session (§5.3). Status starts at `parsing`; the client parses, then probes. */
export const openImportSession = createServerFn({ method: "POST" })
  .validator((data: unknown) => openSessionInput.parse(data))
  .handler(async ({ data }): Promise<ImportSessionView> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return runOpenImportSession(getDb(), did, householdId, data);
  });

/**
 * §7.1. Read-only, keys-only, no writes beyond advancing the session to
 * `reviewing`. Reveals only recipes the caller's household can already see, or
 * public records — no new information leaks (§2.2).
 */
export const probeImportDuplicates = createServerFn({ method: "POST" })
  .validator((data: unknown) => probeInput.parse(data))
  .handler(async ({ data }): Promise<ProbeVerdict[]> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return runProbeImportDuplicates(getDb(), did, householdId, data);
  });

/** §7.2. Chunk size 25; a per-item failure fails that item only. */
export const commitImportChunk = createServerFn({ method: "POST" })
  .validator((data: unknown) => parseCommitChunk(data))
  .handler(async ({ data }): Promise<CommitItemResult[]> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return runCommitImportChunk(getDb(), did, householdId, data);
  });

/** §7.6. Lazy bodies for the compare overlay — fetched for what the user opens. */
export const getImportComparison = createServerFn({ method: "POST" })
  .validator((data: unknown) => comparisonInput.parse(data))
  .handler(async ({ data }): Promise<ComparisonResult> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return runGetImportComparison(getDb(), did, householdId, data);
  });

/** §7.7. Idempotent; counters are derived, never incremented. Emits §13's completion event. */
export const finalizeImportSession = createServerFn({ method: "POST" })
  .validator((data: unknown) => finalizeInput.parse(data))
  .handler(async ({ data }): Promise<FinalizeResult> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return runFinalizeImportSession(getDb(), did, householdId, data);
  });

/** §13. Terminal failure for a session that died before it could finalize. */
export const failImportSession = createServerFn({ method: "POST" })
  .validator((data: unknown) => failInput.parse(data))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    return runFailImportSession(getDb(), did, householdId, data);
  });

// --- session helpers ----------------------------------------------------

/**
 * The three statuses a session never leaves (§5.3). ONE list, used by every
 * guard: `advanceSession`, the commit gate, finalize's conditional update and
 * fail's. They drifted once — finalize guarded only `complete`, so a finalize
 * arriving after a `failed` flipped the session to `complete` and emitted
 * `recipe_import_completed` for a session that had already emitted
 * `recipe_import_failed`. Two events, one session. Do not re-split them.
 */
const TERMINAL_STATUSES = ["complete", "failed", "abandoned"] as const satisfies readonly ImportSessionStatus[];

function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * A session row scoped to the caller's household (§16.17). Every entry point
 * loads through here, so a session id from another household is simply not found
 * — a member of another household cannot probe, compare, or commit into this one.
 *
 * `requireLive` additionally refuses a session that has already ended. Only the
 * WRITE path sets it: a probe or a comparison against a finished session is a
 * harmless read (the client re-probes on re-entry, §7.5), but a chunk that
 * arrives after finalize would create rows against a session whose counters are
 * already derived, stored and reported — recipes that belong to no session
 * anyone will ever look at again. `advanceSession` alone did not stop that: it
 * declines to reopen the session and then the chunk commits anyway.
 */
async function loadSession(db: Kysely<DB>, householdId: string, sessionId: string, opts?: { requireLive?: boolean }) {
  const row = await db.selectFrom("recipe_import_session").selectAll().where("id", "=", sessionId).where("household_id", "=", householdId).executeTakeFirst();
  if (!row) throw new Error("Import session not found.");
  if (opts?.requireLive && isTerminal(row.status)) throw new Error(`This import session has already finished (${row.status}).`);
  return row;
}

/**
 * Advance the session, but never backwards out of a terminal state: a chunk
 * arriving after finalize must not reopen a `complete` session.
 */
async function advanceSession(db: Kysely<DB>, sessionId: string, status: ImportSessionStatus): Promise<void> {
  await db.updateTable("recipe_import_session").set({ status }).where("id", "=", sessionId).where("status", "not in", TERMINAL_STATUSES).execute();
}

export async function runOpenImportSession(db: Kysely<DB>, did: string, householdId: string, input: OpenImportSessionInput): Promise<ImportSessionView> {
  const { ulid } = await import("./household/ids");
  const id = ulid();
  const row = await db
    .insertInto("recipe_import_session")
    .values({
      id,
      household_id: householdId,
      did,
      importer: input.importer,
      status: "parsing" satisfies ImportSessionStatus,
      file_name: input.fileName ?? null,
      total_count: input.totalCount ?? 0,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return sessionView(row);
}

function sessionView(row: {
  id: string;
  importer: string;
  status: string;
  file_name: string | null;
  total_count: number;
  started_at: Date;
  finished_at: Date | null;
}): ImportSessionView {
  return {
    sessionId: row.id,
    importer: row.importer,
    status: row.status as ImportSessionStatus,
    fileName: row.file_name,
    totalCount: row.total_count,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
  };
}

// --- §6.3 / §6.4 the dedupe queries -------------------------------------

/** The identity half of a match, before handles are resolved. */
interface MatchRow {
  recipeId: string;
  name: string;
  addedAt: Date;
  addedByDid: string | null;
}

/** What a probe item contributes to the batched key queries. */
interface KeyItem {
  clientId: string;
  sourceUrlKey: string | null;
  contentFp: string;
}

/**
 * §6.3 row 1 — recipes already in THIS household's box carrying either dedupe
 * key. One statement for the whole batch, matched back in memory.
 *
 * This is also step 2 of §7.3's per-item commit re-check, called with a single
 * item: the probe's verdict is advisory (a user can edit a recipe into an exact
 * duplicate after it ran), and a second implementation of this query is exactly
 * the thing that would drift.
 *
 * Never consults another household's private recipes (§2.2) — the
 * `household_recipe` join IS the authorization.
 */
export async function findInBoxMatches(db: Kysely<DB>, householdId: string, items: readonly KeyItem[]): Promise<{ byUrlKey: Map<string, MatchRow>; byFp: Map<string, MatchRow> }> {
  const { sql } = await import("kysely");
  const byUrlKey = new Map<string, MatchRow>();
  const byFp = new Map<string, MatchRow>();
  const urlKeys = [...new Set(items.map((i) => i.sourceUrlKey).filter((v): v is string => Boolean(v)))];
  const fps = [...new Set(items.map((i) => i.contentFp).filter(Boolean))];
  if (!urlKeys.length && !fps.length) return { byUrlKey, byFp };

  const rows = await db
    .selectFrom("household_recipe as hr")
    .innerJoin("recipe as r", "r.id", "hr.recipe_id")
    .innerJoin("recipe_meta as m", "m.recipe_id", "r.id")
    .where("hr.household_id", "=", householdId)
    .where("m.ns", "=", DEDUPE_NS)
    // `value #>> '{}'` is the expression the partial `recipe_meta_dedupe` index is
    // built on (§5.1), so this is an index scan, not a jsonb table sweep.
    .where(
      sql<boolean>`(
        (m.key = 'source_url_key' and m.value #>> '{}' = any(${urlKeys}::text[]))
        or (m.key = 'content_fp' and m.value #>> '{}' = any(${fps}::text[]))
      )`,
    )
    .select([
      "r.id as recipe_id",
      "r.name as name",
      "hr.added_at as added_at",
      "hr.added_by_did as added_by_did",
      "m.key as meta_key",
      sql<string>`m.value #>> '{}'`.as("meta_value"),
    ])
    // Oldest box row wins so a household with two copies reports a stable one.
    .orderBy("hr.added_at", "asc")
    .orderBy("r.id", "asc")
    .execute();

  for (const row of rows) {
    const target = row.meta_key === "source_url_key" ? byUrlKey : byFp;
    if (target.has(row.meta_value)) continue;
    target.set(row.meta_value, { recipeId: row.recipe_id, name: row.name, addedAt: row.added_at, addedByDid: row.added_by_did });
  }
  return { byUrlKey, byFp };
}

/**
 * §6.3 row 2 — the public atproto index, matched on the URL key only. A
 * fingerprint match against a public record is deliberately NOT a
 * `public_exists`: the fingerprint is a weaker signal and offering to link a
 * stranger's record on it is how a user ends up with someone else's recipe.
 */
async function findPublicMatches(db: Kysely<DB>, urlKeys: readonly string[]): Promise<Map<string, MatchRow>> {
  const { sql } = await import("kysely");
  const out = new Map<string, MatchRow>();
  if (!urlKeys.length) return out;

  const rows = await db
    .selectFrom("recipe as r")
    .innerJoin("recipe_meta as m", "m.recipe_id", "r.id")
    .where("m.ns", "=", DEDUPE_NS)
    .where("m.key", "=", "source_url_key")
    .where(sql<boolean>`m.value #>> '{}' = any(${[...urlKeys]}::text[])`)
    .where("r.visibility", "=", "public")
    .where("r.uri", "is not", null)
    .select(["r.id as recipe_id", "r.name as name", "r.indexed_at as indexed_at", "r.did as did", sql<string>`m.value #>> '{}'`.as("meta_value")])
    .orderBy("r.indexed_at", "asc")
    .orderBy("r.id", "asc")
    .execute();

  for (const row of rows) {
    if (out.has(row.meta_value)) continue;
    out.set(row.meta_value, { recipeId: row.recipe_id, name: row.name, addedAt: row.indexed_at, addedByDid: row.did });
  }
  return out;
}

/**
 * §6.4 row 3 — fuzzy title, in ONE statement for the whole batch.
 *
 * `r.name % t.title` is the index-accelerated prefilter (the gin
 * `recipe_name_trgm_idx` from `1785300000000_create_recipe_rendered.ts`, default
 * `pg_trgm.similarity_threshold` 0.3); the explicit `similarity(...) >` applies
 * §6.4's real 0.85 cut, which is a strict subset of what `%` admits. Raw name on
 * both sides — there is no `normalized_title` column and this plan does not add
 * one, because a stored normalized column needs a second writer (the cron render
 * path) that goes stale.
 *
 * `LATERAL … LIMIT` caps candidates per item, so 341 near-identical titles cannot
 * turn one probe into a cross join.
 */
async function findTitleMatches(db: Kysely<DB>, householdId: string, items: readonly { clientId: string; title: string }[]): Promise<Map<string, MatchRow[]>> {
  const { sql } = await import("kysely");
  const out = new Map<string, MatchRow[]>();
  const usable = items.filter((i) => i.title.trim().length > 0);
  if (!usable.length) return out;

  const clientIds = usable.map((i) => i.clientId);
  const titles = usable.map((i) => i.title);
  const result = await sql<{ client_id: string; recipe_id: string; name: string; added_at: Date; added_by_did: string | null }>`
    select t.client_id as client_id, x.id as recipe_id, x.name as name, x.added_at as added_at, x.added_by_did as added_by_did
    from unnest(${clientIds}::text[], ${titles}::text[]) as t(client_id, title)
    cross join lateral (
      select r.id, r.name, hr.added_at, hr.added_by_did
      from household_recipe hr
      join recipe r on r.id = hr.recipe_id
      where hr.household_id = ${householdId}
        and r.name % t.title
        and similarity(r.name, t.title) > ${FUZZY_TITLE_THRESHOLD}
      order by similarity(r.name, t.title) desc, r.id
      limit ${FUZZY_MAX_CANDIDATES}
    ) x
  `.execute(db);

  for (const row of result.rows) {
    const list = out.get(row.client_id) ?? [];
    list.push({ recipeId: row.recipe_id, name: row.name, addedAt: row.added_at, addedByDid: row.added_by_did });
    out.set(row.client_id, list);
  }
  return out;
}

/**
 * Resolve DIDs to display handles in ONE query (§7.1: "DIDs resolved in ONE
 * batched query, not per item"). `atproto_repo.handle` is the same source
 * `getHouseholdRecipe`'s `addedByHandle` uses.
 */
async function resolveHandles(db: Kysely<DB>, dids: Iterable<string | null>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const distinct = [...new Set([...dids].filter((d): d is string => Boolean(d)))];
  if (!distinct.length) return out;
  const rows = await db.selectFrom("atproto_repo").select(["did", "handle"]).where("did", "in", distinct).execute();
  for (const row of rows) if (row.handle) out.set(row.did, `@${row.handle}`);
  return out;
}

function toRef(match: MatchRow, handles: Map<string, string>): ExistingRef {
  return {
    recipeId: match.recipeId,
    name: match.name,
    addedAt: new Date(match.addedAt).toISOString(),
    addedByHandle: match.addedByDid ? (handles.get(match.addedByDid) ?? null) : null,
  };
}

// --- §7.1 probe ----------------------------------------------------------

/**
 * The probe, in four statements for the whole batch (box keys, public keys,
 * fuzzy titles, handles) plus the one session advance — never one query per item.
 *
 * Verdicts follow §6.3's precedence exactly:
 *   dupe_in_batch → in_box → public_exists → maybe → new
 *
 * `in_box` outranks `public_exists` because a recipe the household already holds
 * is a duplicate whatever else is true of it, and offering to link a public copy
 * of something already in the box is noise.
 */
export async function runProbeImportDuplicates(db: Kysely<DB>, _did: string, householdId: string, input: ProbeInput): Promise<ProbeVerdict[]> {
  await loadSession(db, householdId, input.sessionId);
  // The parse is done by definition once keys exist; the user is now reviewing.
  await advanceSession(db, input.sessionId, "reviewing");
  if (!input.items.length) return [];

  const urlKeys = [...new Set(input.items.map((i) => i.sourceUrlKey).filter((v): v is string => Boolean(v)))];
  const [box, publicByKey, titles] = await Promise.all([
    findInBoxMatches(db, householdId, input.items),
    findPublicMatches(db, urlKeys),
    findTitleMatches(db, householdId, input.items),
  ]);

  const handleDids: Array<string | null> = [];
  for (const m of box.byUrlKey.values()) handleDids.push(m.addedByDid);
  for (const m of box.byFp.values()) handleDids.push(m.addedByDid);
  for (const m of publicByKey.values()) handleDids.push(m.addedByDid);
  for (const list of titles.values()) for (const m of list) handleDids.push(m.addedByDid);
  const handles = await resolveHandles(db, handleDids);

  // First item to claim a key owns it; later items sharing it are batch dupes.
  const claimedUrlKey = new Map<string, string>();
  const claimedFp = new Map<string, string>();

  return input.items.map((item): ProbeVerdict => {
    const priorUrl = item.sourceUrlKey ? claimedUrlKey.get(item.sourceUrlKey) : undefined;
    const priorFp = item.contentFp ? claimedFp.get(item.contentFp) : undefined;
    const prior = priorUrl ?? priorFp;
    if (prior) return { clientId: item.clientId, verdict: "dupe_in_batch", duplicateOfClientId: prior };
    if (item.sourceUrlKey) claimedUrlKey.set(item.sourceUrlKey, item.clientId);
    if (item.contentFp) claimedFp.set(item.contentFp, item.clientId);

    const inBox = (item.sourceUrlKey ? box.byUrlKey.get(item.sourceUrlKey) : undefined) ?? (item.contentFp ? box.byFp.get(item.contentFp) : undefined);
    if (inBox) return { clientId: item.clientId, verdict: "in_box", existing: toRef(inBox, handles) };

    const pub = item.sourceUrlKey ? publicByKey.get(item.sourceUrlKey) : undefined;
    if (pub) return { clientId: item.clientId, verdict: "public_exists", existing: toRef(pub, handles) };

    const candidates = titles.get(item.clientId);
    if (candidates?.length) return { clientId: item.clientId, verdict: "maybe", candidates: candidates.map((c) => toRef(c, handles)) };

    return { clientId: item.clientId, verdict: "new" };
  });
}

// --- §7.2 meta boundary --------------------------------------------------

type MetaCheck = { ok: true; meta: JsonObject } | { ok: false; message: string };

/**
 * Coerce an untrusted value to `JsonValue`, or throw. Rejects functions,
 * `bigint`, symbols, `undefined`, non-finite numbers and cycles — every shape
 * that would either fail `JSON.stringify` or silently become `null` in the
 * column (§2.5, §7.2).
 */
function asJsonValue(value: unknown, seen: Set<object>, path: string): JsonValue {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "boolean") return value as JsonValue;
  if (t === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} is not a finite number`);
    return value as number;
  }
  if (t !== "object") throw new Error(`${path} is ${t === "undefined" ? "undefined" : t}, which is not JSON`);
  const obj = value as object;
  if (seen.has(obj)) throw new Error(`${path} is a circular reference`);
  seen.add(obj);
  try {
    if (Array.isArray(obj)) return obj.map((v, i) => asJsonValue(v, seen, `${path}[${i}]`));
    if (Object.getPrototypeOf(obj) !== Object.prototype && Object.getPrototypeOf(obj) !== null) {
      throw new Error(`${path} is not a plain object`);
    }
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) out[k] = asJsonValue(v, seen, `${path}.${k}`);
    return out;
  } finally {
    seen.delete(obj);
  }
}

/**
 * The §7.2 metadata boundary: **size, shape, reserved keys** — in that order,
 * failing the ITEM and never the chunk.
 *
 * This is a security boundary, not a nicety. `meta` is client-supplied `jsonb`
 * that the pipeline writes without inspecting, into the same `ns='import'` key
 * space the pipeline's own provenance rows live in (§12.5). Without the reserved
 * list, an item could overwrite `session_id` and make the derived counters of
 * §7.7 report someone else's import; without the size cap it could park 8 MB per
 * recipe in a table nothing prunes.
 */
export function validateItemMeta(value: unknown): MetaCheck {
  if (value === undefined || value === null) return { ok: true, meta: {} };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, message: "Importer metadata must be a JSON object." };

  let meta: JsonObject;
  try {
    meta = asJsonValue(value, new Set(), "meta") as JsonObject;
  } catch (err) {
    return { ok: false, message: `Importer metadata is not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  const reserved = RESERVED_META_KEYS.filter((k) => Object.hasOwn(meta, k));
  if (reserved.length) {
    return { ok: false, message: `Importer metadata may not use the reserved key${reserved.length > 1 ? "s" : ""} ${reserved.join(", ")}.` };
  }

  const bytes = Buffer.byteLength(JSON.stringify(meta), "utf8");
  if (bytes > META_MAX_BYTES) return { ok: false, message: `Importer metadata is ${bytes} bytes; the limit is ${META_MAX_BYTES}.` };

  return { ok: true, meta };
}

// --- §7.2 commit ---------------------------------------------------------

/** An image the chunk owes a fetch, queued for the bounded post-commit pass (§11). */
interface PendingImage {
  recipeId: string;
  sourceUrl: string;
  alt: string | null;
}

/**
 * §7.2. Commit one chunk of at most 25 reviewed items.
 *
 * Each item is wrapped independently — its own transaction, its own try/catch —
 * so a validation failure or a bad row fails THAT item and the chunk still
 * returns results for the other 24 (§7.5 resumability, §16.11). The wire schema
 * is deliberately loose for the same reason: anything a per-item path can turn
 * into a `failed` result must not be a 400 for the whole chunk.
 *
 * The chunk deliberately does not increment session counters; they are derived
 * at finalize (§7.7). Replaying a chunk is a no-op because each item is keyed by
 * `(session_id, client_id)` in the sidecar ledger (see {@link findLedgerRecipe})
 * — the derived counters are what makes that visible, not what makes it true.
 *
 * Nothing here can publish (§7.4) — see the module header.
 */
export async function runCommitImportChunk(db: Kysely<DB>, did: string, householdId: string, input: CommitChunkInput): Promise<CommitItemResult[]> {
  // `requireLive`: a chunk that arrives after the session ended is refused
  // outright rather than quietly creating rows nothing will ever count.
  const session = await loadSession(db, householdId, input.sessionId, { requireLive: true });
  await advanceSession(db, input.sessionId, "committing");

  // Every skip in the chunk in ONE upsert, before the per-item loop. A re-import
  // sends ~14 chunks of nothing but skips (§16.12) and none of them deserves a
  // transaction, an advisory lock, or a row-at-a-time round trip: a skip claims
  // no recipe, so it races nothing and needs no serialization — the primary key
  // makes the replay converge instead. If the statement throws, the whole chunk
  // errors and the client re-sends it (§7.5); that is the right failure, because
  // a silently unrecorded skip would come back as a missing recipe in the
  // finalize counters.
  await recordSkips(
    db,
    householdId,
    session.id,
    input.items
      .filter((item): item is Extract<CommitItem, { action: "skip" }> => item.action === "skip")
      .map((item) => ({ clientId: item.clientId, reason: skipReasonOf(item.reason) })),
  );

  const results: CommitItemResult[] = [];
  const images: PendingImage[] = [];

  for (const item of input.items) {
    try {
      const outcome = await commitOne(db, did, householdId, session.id, session.importer, item);
      results.push(outcome.result);
      if (outcome.image) images.push(outcome.image);
    } catch (err) {
      // Per-item isolation (§7.2): one bad row never fails the chunk.
      results.push({ clientId: item.clientId, status: "failed", message: err instanceof Error ? err.message : String(err) });
    }
  }

  // §11: remote-URL heroes, fetched AFTER every row is committed and bounded to
  // IMAGE_FETCH_CONCURRENCY. A dead or hotlink-blocked source loses the image,
  // never the recipe — the row is already saved and the failure is swallowed.
  await fetchChunkImages(db, images);

  return results;
}

/**
 * Narrow a wire `reason` to the two the column accepts. Absent, unknown, or
 * misspelled all read as `"user"`: the conservative half, because "the user
 * chose to drop this" is true of every skip the client sends and "Buttery
 * declined to duplicate it" is the stronger claim.
 */
function skipReasonOf(reason: string | undefined): SkipReason {
  return reason === "duplicate" ? "duplicate" : "user";
}

/**
 * Record skipped items so §7.7 can DERIVE both skip counters instead of
 * believing a client number a replay would inflate (see {@link SKIP_TABLE}).
 *
 * One statement for the whole chunk, and idempotent by primary key: re-sending
 * the same 25 skips rewrites the same 25 rows. `do update` rather than
 * `do nothing` so a re-sent item's reason reflects the latest claim rather than
 * the first one — the count is identical either way, but the split is not.
 *
 * Callable inside an item's transaction (the commit-time duplicate path) or on
 * the pooled connection (the bulk chunk path); it holds no state either way.
 */
async function recordSkips(db: Kysely<DB>, householdId: string, sessionId: string, skips: readonly { clientId: string; reason: SkipReason }[]): Promise<void> {
  if (skips.length === 0) return;
  const { sql } = await import("kysely");
  await db
    .insertInto(SKIP_TABLE)
    .values(skips.map((skip) => ({ session_id: sessionId, client_id: skip.clientId, household_id: householdId, reason: skip.reason })))
    .onConflict((oc) => oc.columns(["session_id", "client_id"]).doUpdateSet({ reason: (eb) => eb.ref("excluded.reason"), updated_at: sql`now()` }))
    .execute();
}

/** One item's outcome plus the image the post-commit pass owes it. */
interface ItemOutcome {
  result: CommitItemResult;
  image?: PendingImage;
}

/**
 * Serialize every commit of one `(household, session, clientId)` item.
 *
 * The ledger check below is a read followed by a write, so two replays of the
 * same chunk racing each other would both read "no row" and both create a
 * recipe. There is no unique constraint that could stop them —
 * `household_recipe_meta`'s primary key is `(household, recipe, ns, key)` and
 * the whole problem is that a second recipe id makes a *different* row — so the
 * mutual exclusion is a transaction-scoped advisory lock instead, taken as the
 * first statement of the item's transaction and released by COMMIT/ROLLBACK
 * whatever happens. Nothing else in the codebase takes advisory locks, so the
 * only contention possible is the one this exists to serialize; a hash
 * collision costs an unnecessary wait and nothing else.
 */
async function lockImportItem(trx: Kysely<DB>, householdId: string, sessionId: string, clientId: string): Promise<void> {
  const { sql } = await import("kysely");
  const key = `recipe-import ${householdId} ${sessionId} ${clientId}`;
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(trx);
}

/**
 * §7.5/§16.13's idempotency ledger: the recipe this exact `(session, clientId)`
 * item already produced, or null.
 *
 * **This, not the dedupe re-check, is what makes a replay converge.** The
 * re-check in `commitImport` compares content, so it silently does nothing for
 * the two cases that matter most: an item the user force-imported with
 * `override: "duplicate"` (which deliberately bypasses it — a replayed override
 * therefore imported a SECOND copy), and a recipe edited after it was committed
 * (whose `content_fp` no longer matches the row it created). The ledger keys on
 * the client's own item id, so it survives both.
 *
 * `client_id` is written into `ns='import'` beside the §12.5 provenance in the
 * same statement, inside the same transaction as the recipe, so a recipe from
 * this pipeline can never exist without its ledger entry — and it cascades away
 * with the recipe, so deleting an imported recipe correctly makes a re-run
 * import it again.
 *
 * The `session_id` leg is the indexed one (`household_recipe_meta_session`,
 * §5.2); `client_id` is the join, filtered from the handful of rows a session
 * has for one key.
 */
async function findLedgerRecipe(trx: Kysely<DB>, householdId: string, sessionId: string, clientId: string): Promise<string | null> {
  const { sql } = await import("kysely");
  const row = await trx
    .selectFrom("household_recipe_meta as s")
    .innerJoin("household_recipe_meta as c", (join) =>
      join.onRef("c.household_id", "=", "s.household_id").onRef("c.recipe_id", "=", "s.recipe_id").on("c.ns", "=", IMPORT_NS).on("c.key", "=", "client_id"),
    )
    .where("s.household_id", "=", householdId)
    .where("s.ns", "=", IMPORT_NS)
    .where("s.key", "=", "session_id")
    .where(sql<boolean>`s.value #>> '{}' = ${sessionId}`)
    .where(sql<boolean>`c.value #>> '{}' = ${clientId}`)
    .select("s.recipe_id as recipe_id")
    .executeTakeFirst();
  return row?.recipe_id ?? null;
}

async function commitOne(db: Kysely<DB>, did: string, householdId: string, sessionId: string, importer: string, item: CommitItem): Promise<ItemOutcome> {
  if (item.action === "skip") {
    // Its row was already written in one statement for the whole chunk (see
    // `runCommitImportChunk`), which is the whole of a skip's work: no recipe, no
    // transaction, no lock. §7.2's "it exists so the client can report a complete
    // accounting of the session without the server having to infer absence" is
    // now literal — the server records the absence rather than being told a total.
    return { result: { clientId: item.clientId, status: "skipped", reason: skipReasonOf(item.reason) } };
  }

  const checked = validateItemMeta(item.meta);
  if (!checked.ok) return { result: { clientId: item.clientId, status: "failed", message: checked.message } };

  // The four pipeline-owned rows (§12.5), written by the pipeline for every
  // importer. They are added AFTER the item's own keys, and the reserved-key
  // check above guarantees they collide with nothing.
  const provenance: JsonObject = {
    ...checked.meta,
    importer,
    session_id: sessionId,
    entry_name: item.entryName,
    // The idempotency ledger's other half (see `findLedgerRecipe`). Written in
    // the same statement as the rest of the provenance, inside the recipe's own
    // transaction, so it can never be missing from a row this path created.
    client_id: item.clientId,
    source_text: item.sourceText ?? null,
  };

  return item.action === "link" ? await commitLink(db, did, householdId, sessionId, item, provenance) : await commitImport(db, did, householdId, sessionId, item, provenance);
}

/**
 * `action: "link"` — add the exact public record the user reviewed to the box and
 * write the sidecar rows. No `persistRecipeDraft`, no new `recipe` row (§6.3 D22).
 *
 * **The server revalidates `existingRecipeId` rather than trusting it.** A
 * client-supplied id that reached the box unchecked would be an
 * arbitrary-row-into-my-box primitive reachable by anyone who can call the
 * endpoint; the probe having returned the id earlier is not a check, because the
 * server does not remember what it returned.
 */
async function commitLink(
  db: Kysely<DB>,
  did: string,
  householdId: string,
  sessionId: string,
  item: Extract<CommitItem, { action: "link" }>,
  provenance: JsonObject,
): Promise<ItemOutcome> {
  // The emptiness check the wire schema deliberately does NOT do, so a client
  // that emits `existingRecipeId: ""` loses that item and not the chunk.
  const existingRecipeId = item.existingRecipeId.trim();
  if (!existingRecipeId) {
    return { result: { clientId: item.clientId, status: "failed", message: "This item has no recipe to link to." } };
  }

  const { setManyHouseholdRecipeMeta } = await import("./recipe-meta");
  return await db.transaction().execute(async (trx): Promise<ItemOutcome> => {
    await lockImportItem(trx, householdId, sessionId, item.clientId);

    // A replay of this exact item links what it linked before, whatever has
    // happened to the recipe's visibility since.
    const prior = await findLedgerRecipe(trx, householdId, sessionId, item.clientId);
    const recipeId = prior ?? existingRecipeId;

    if (!prior) {
      const recipe = await trx.selectFrom("recipe").select(["id", "visibility", "uri"]).where("id", "=", existingRecipeId).executeTakeFirst();
      if (!recipe || recipe.visibility !== "public" || recipe.uri === null) {
        return { result: { clientId: item.clientId, status: "failed", message: "That recipe is no longer available to add." } };
      }

      const alreadyBoxed = await trx
        .selectFrom("household_recipe")
        .select("recipe_id")
        .where("household_id", "=", householdId)
        .where("recipe_id", "=", existingRecipeId)
        .executeTakeFirst();
      if (alreadyBoxed) {
        // Distinguish another item of THIS session having linked it — the
        // client failed to collapse two entries onto one public record — from a
        // recipe that was already in the box before the import started. The
        // first converges (§7.5) and reports `linked` again; the second is the
        // "already in your box" case §7.2 says to fail. (An exact replay of
        // this item never reaches here: the ledger answered it above.)
        const owned = await trx
          .selectFrom("household_recipe_meta")
          .select("value")
          .where("household_id", "=", householdId)
          .where("recipe_id", "=", existingRecipeId)
          .where("ns", "=", IMPORT_NS)
          .where("key", "=", "session_id")
          .executeTakeFirst();
        if (owned?.value !== sessionId) {
          return { result: { clientId: item.clientId, status: "failed", message: "That recipe is already in your box." } };
        }
      }
    }

    await trx
      .insertInto("household_recipe")
      .values({ household_id: householdId, recipe_id: recipeId, added_by_did: did })
      .onConflict((oc) => oc.columns(["household_id", "recipe_id"]).doNothing())
      .execute();
    await writeNote(trx, householdId, recipeId, did, item.notes);
    await setManyHouseholdRecipeMeta(trx, householdId, [{ recipeId, ns: IMPORT_NS, entries: provenance }]);

    return { result: { clientId: item.clientId, status: "linked", recipeId } };
  });
}

/**
 * `action: "import"` — attribution → recomputed dedupe keys → ledger check →
 * household re-check → `persistRecipeDraft` → notes, keywords, sidecar rows.
 *
 * Everything from the ledger check down runs in ONE transaction, opened by the
 * advisory lock on `(household, session, clientId)`. That ordering is the whole
 * idempotency guarantee: two replays of a lost chunk cannot both read "no
 * ledger row" and both create a recipe, because the second one waits for the
 * first to commit and then finds it.
 *
 * The content re-check (§7.3) still runs for EVERY item, and is a different
 * question — it is what makes the earlier probe advisory rather than
 * load-bearing, since the review screen lets the user edit a recipe into an
 * exact match of something already in the box after the probe ran (§10.2, D25).
 * It is NOT sufficient for replay convergence: it does not fire for an
 * `override: "duplicate"` item, and it stops matching once the recipe is edited.
 */
async function commitImport(
  db: Kysely<DB>,
  did: string,
  householdId: string,
  sessionId: string,
  item: Extract<CommitItem, { action: "import" }>,
  provenance: JsonObject,
): Promise<ItemOutcome> {
  const { computeDedupeKeys, persistRecipeDraft, resolveAttribution } = await import("./recipes-write");
  const { setManyHouseholdRecipeMeta } = await import("./recipe-meta");

  const sourceUrl = item.sourceUrl?.trim() || null;
  const attribution = resolveAttribution(item.record, sourceUrl, item.attribution);
  if (!attribution) {
    return { result: { clientId: item.clientId, status: "failed", message: "This recipe has no source we can attribute it to." } };
  }

  // Tags → keywords (and, if one happens to match, the single category column).
  // §12.3: personal tags are not a controlled vocabulary, so EVERY value becomes
  // a keyword whether or not it matched; almost nothing will match, which is
  // correct. The raw list also reaches the sidecar via `meta`.
  const record = await applyTags(item.record, item.tags);

  // Keys are recomputed from the SUBMITTED record, never taken from the client
  // (§6.1, §7.3) — the review screen can rename a recipe after the probe ran.
  const keys = await computeDedupeKeys(record, sourceUrl);

  return await db.transaction().execute(async (trx): Promise<ItemOutcome> => {
    await lockImportItem(trx, householdId, sessionId, item.clientId);

    // §7.5/§16.13: this item already produced a recipe. Report that same recipe
    // — never a second one, and never a phantom `skipped` the client would then
    // count as a duplicate on top of the derived import (§7.7).
    const prior = await findLedgerRecipe(trx, householdId, sessionId, item.clientId);
    if (prior) {
      // No image is queued: the first attempt already queued it, and the row it
      // belongs to is committed either way.
      return { result: { clientId: item.clientId, status: "imported", recipeId: prior } };
    }

    const box = await findInBoxMatches(trx, householdId, [{ clientId: item.clientId, sourceUrlKey: keys.sourceUrlKey, contentFp: keys.contentFp }]);
    const existing = (keys.sourceUrlKey ? box.byUrlKey.get(keys.sourceUrlKey) : undefined) ?? box.byFp.get(keys.contentFp);
    if (existing && item.override !== "duplicate") {
      // The correct outcome, not an error: the summary reports it, the chunk is
      // fine. Recorded like any other skip (§7.7) so `skipped_count` is DERIVED
      // like the other counters instead of trusting a client number that a
      // replay would double — and recorded as `duplicate` whatever the client
      // called this item, because the server is the one that just declined it.
      await recordSkips(trx, householdId, sessionId, [{ clientId: item.clientId, reason: "duplicate" }]);
      return { result: { clientId: item.clientId, status: "skipped", reason: "duplicate" } };
    }

    const persisted = await persistRecipeDraft(
      trx,
      { did, householdId },
      {
        record,
        attribution,
        sourceUrl,
        // §11: the hero is fetched by the bounded post-commit pass, not inside
        // this transaction. Passing it here would hold the chunk's row locks
        // open across a third-party HTTP request.
        imageSourceUrl: null,
        // §2.1/§2.2. Private, household-scoped, and there is no publish step to
        // reach from here even if this said otherwise.
        visibility: "private",
      },
    );
    if (persisted.status === "invalid") {
      const message = persisted.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ") || "Recipe failed validation.";
      return { result: { clientId: item.clientId, status: "failed", message } };
    }

    const recipeId = persisted.recipeId;
    await writeNote(trx, householdId, recipeId, did, item.notes);
    await setManyHouseholdRecipeMeta(trx, householdId, [{ recipeId, ns: IMPORT_NS, entries: provenance }]);

    const imageUrl = item.imageSourceUrl?.trim() || null;
    return {
      result: { clientId: item.clientId, status: "imported", recipeId },
      ...(imageUrl ? { image: { recipeId, sourceUrl: imageUrl, alt: record.name ?? null } } : {}),
    };
  });
}

/**
 * §12.2. The candidate carries at most one notes blob and the table is keyed
 * `(household_id, recipe_id)`, so this is a clean 1:1. Empty notes write no row.
 */
async function writeNote(trx: Kysely<DB>, householdId: string, recipeId: string, did: string, notes: string | null): Promise<void> {
  const body = notes?.trim();
  if (!body) return;
  const { sql } = await import("kysely");
  await trx
    .insertInto("household_recipe_note")
    .values({ household_id: householdId, recipe_id: recipeId, author_did: did, body })
    .onConflict((oc) => oc.columns(["household_id", "recipe_id"]).doUpdateSet({ body, author_did: did, updated_at: sql`now()` }))
    .execute();
}

/**
 * §12.3. Merge the importer's personal tags into the record: every value becomes
 * a keyword, and the FIRST value that resolves to a known category label fills
 * `recipeCategory` if the user did not already choose one.
 */
async function applyTags(record: RecipeRecordInput, tags: readonly string[]): Promise<RecipeRecordInput> {
  const clean = tags.map((t) => t.trim()).filter(Boolean);
  if (!clean.length) return record;
  const { slugForLabel, tokenForSlug } = await import("#/lib/recipe-vocab");

  // The lexicon caps a keyword at 64 characters; an over-long personal tag is
  // dropped rather than failing the whole record on validation.
  const keywords = [...new Set([...(record.keywords ?? []), ...clean].filter((k) => k.length <= 64))];

  let recipeCategory = record.recipeCategory;
  if (!recipeCategory) {
    for (const tag of clean) {
      const token = tokenForSlug("category", slugForLabel("category", tag));
      if (token) {
        recipeCategory = token;
        break;
      }
    }
  }
  return { ...record, keywords, ...(recipeCategory ? { recipeCategory } : {}) };
}

/**
 * §11's whole server half: fetch each hero from its REMOTE url and store it the
 * same way the single-recipe import path does — `storePendingImageFromUrl`, which
 * is SSRF-guarded and size-capped. No local byte from the export ever reaches the
 * server in phase 1; the browser reads those for review thumbnails and revokes
 * the object URLs on unmount.
 *
 * Bounded to {@link IMAGE_FETCH_CONCURRENCY} and run with no transaction open.
 */
async function fetchChunkImages(db: Kysely<DB>, images: readonly PendingImage[]): Promise<void> {
  if (!images.length) return;
  const { storePendingImageFromUrl } = await import("./recipes-write");
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= images.length) return;
      const image = images[index];
      try {
        await storePendingImageFromUrl(db, image.recipeId, image.sourceUrl, image.alt);
      } catch {
        // A dead, paywalled or hotlink-blocked source loses the image, never the
        // recipe — the row committed before this pass ran (§11, accepted cost).
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMAGE_FETCH_CONCURRENCY, images.length) }, worker));
}

// --- §7.6 comparison -----------------------------------------------------

/**
 * §7.6. Bodies for the compare overlay, for the recipes the user actually opened.
 *
 * Scoped exactly as the probe is (§2.2): a recipe is returned only if it is in
 * this household's box or is a public record. An id the caller cannot see is
 * simply absent from the result — never a 403, which would confirm the row
 * exists. The diff itself is computed client-side; there is no server-side diff,
 * no match score, and no per-line similarity field. Do not add one.
 */
export async function runGetImportComparison(db: Kysely<DB>, _did: string, householdId: string, input: ComparisonInput): Promise<ComparisonResult> {
  await loadSession(db, householdId, input.sessionId);
  const ids = [...new Set(input.recipeIds)];
  if (!ids.length) return {};

  const { sql } = await import("kysely");
  const rows = await db
    .selectFrom("recipe as r")
    .leftJoin("household_recipe as hr", (join) => join.onRef("hr.recipe_id", "=", "r.id").on("hr.household_id", "=", householdId))
    .where("r.id", "in", ids)
    // Visible = boxed here, or public. Same corpora the probe consults.
    .where((eb) => eb.or([eb("hr.recipe_id", "is not", null), eb.and([eb("r.visibility", "=", "public"), eb("r.uri", "is not", null)])]))
    .select([
      "r.id as id",
      "r.name as name",
      "r.recipe_yield as recipe_yield",
      "r.indexed_at as indexed_at",
      "r.did as did",
      "hr.added_at as added_at",
      "hr.added_by_did as added_by_did",
      sql<boolean>`exists (select 1 from recipe_image ri where ri.recipe_id = r.id)
        or exists (select 1 from recipe_pending_image rp where rp.recipe_id = r.id)`.as("has_image"),
    ])
    .execute();
  if (!rows.length) return {};

  const visible = rows.map((r) => r.id);
  const [ingredients, instructions, handles] = await Promise.all([
    db.selectFrom("recipe_ingredient").select(["recipe_id", "text"]).where("recipe_id", "in", visible).orderBy("recipe_id").orderBy("ordinal").execute(),
    db.selectFrom("recipe_instruction").select(["recipe_id", "text"]).where("recipe_id", "in", visible).orderBy("recipe_id").orderBy("ordinal").execute(),
    resolveHandles(
      db,
      rows.flatMap((r) => [r.added_by_did, r.did]),
    ),
  ]);

  const group = (list: Array<{ recipe_id: string; text: string }>): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const row of list) {
      const bucket = out.get(row.recipe_id) ?? [];
      bucket.push(row.text);
      out.set(row.recipe_id, bucket);
    }
    return out;
  };
  const byIngredient = group(ingredients);
  const byInstruction = group(instructions);

  const out: ComparisonResult = {};
  for (const row of rows) {
    const attributedDid = row.added_by_did ?? row.did;
    out[row.id] = {
      name: row.name,
      recipeYield: row.recipe_yield,
      hasImage: Boolean(row.has_image),
      ingredients: byIngredient.get(row.id) ?? [],
      instructions: byInstruction.get(row.id) ?? [],
      addedAt: new Date(row.added_at ?? row.indexed_at).toISOString(),
      addedByHandle: attributedDid ? (handles.get(attributedDid) ?? null) : null,
    };
  }
  return out;
}

// --- §7.7 finalize -------------------------------------------------------

/**
 * The derived half of §7.7's counters, read from the `household_recipe_meta` rows
 * carrying this `session_id` — which is exactly what the partial
 * `household_recipe_meta_session` index (§5.2) exists to serve.
 *
 * **Never incremented.** Per-chunk `count = count + n` is not idempotent: a chunk
 * whose response is lost is retried and the counters gain a phantom skip while
 * keeping the original import. Deriving makes a replayed chunk a no-op by
 * construction — but only for the counters that are actually derived, which is
 * why `skippedDuplicate` is one of them: it used to come from the client, and a
 * replay reported the same 25 recipes once as derived `imported` and again as
 * client-supplied `skippedDuplicate`.
 *
 * `imported` vs `linked` is read off the recipe itself rather than another
 * sidecar key: §7.4 guarantees everything this path CREATES is `uri is null`, and
 * everything it LINKS is a public record with a `uri`.
 *
 * **Both skip counters are derived too**, from `recipe_import_skip` — one row per
 * `(session, clientId)` that produced no recipe, upserted, so a replayed chunk
 * rewrites the same rows and no count moves. `skippedUser` used to be the one
 * figure taken from the client, on the reasoning that a user skip writes nothing
 * anywhere; the client answered that by not sending its skips at all, at which
 * point the screen and the row disagreed about what 341 recipes had become. The
 * client sends them, the server records them, nothing here is told a total.
 */
async function deriveSessionCounts(
  db: Kysely<DB>,
  householdId: string,
  sessionId: string,
): Promise<{ imported: number; linked: number; skippedDuplicate: number; skippedUser: number }> {
  const { sql } = await import("kysely");
  const [rows, skips] = await Promise.all([
    db
      .selectFrom("household_recipe_meta as m")
      .innerJoin("recipe as r", "r.id", "m.recipe_id")
      .where("m.household_id", "=", householdId)
      .where("m.ns", "=", IMPORT_NS)
      .where("m.key", "=", "session_id")
      .where(sql<boolean>`m.value #>> '{}' = ${sessionId}`)
      .select([
        sql<number>`count(distinct m.recipe_id) filter (where r.uri is null)::int`.as("imported"),
        sql<number>`count(distinct m.recipe_id) filter (where r.uri is not null)::int`.as("linked"),
      ])
      .executeTakeFirst(),
    // One row per skipped item, split by reason (D24). `(household_id,
    // session_id)` is the index; `reason` is a two-value column, so the filtered
    // counts cost nothing over the same scan.
    db
      .selectFrom(SKIP_TABLE)
      .where("household_id", "=", householdId)
      .where("session_id", "=", sessionId)
      .select([sql<number>`count(*) filter (where reason = 'duplicate')::int`.as("duplicate"), sql<number>`count(*) filter (where reason = 'user')::int`.as("user")])
      .executeTakeFirst(),
  ]);
  return { imported: rows?.imported ?? 0, linked: rows?.linked ?? 0, skippedDuplicate: skips?.duplicate ?? 0, skippedUser: skips?.user ?? 0 };
}

/**
 * §7.7. The only call that knows the import ended, and the only emitter of §13's
 * `recipe_import_completed`.
 *
 * **Idempotent.** The status flip is a conditional UPDATE, so exactly one call
 * can transition the session; every later call recomputes, returns the stored
 * numbers, and emits nothing. That is what makes it safe for the client to retry
 * a lost finalize, and it is why the telemetry event fires here and nowhere else.
 *
 * The guard is {@link TERMINAL_STATUSES}, the SAME set `runFailImportSession`
 * uses — not `!= 'complete'`. A session that already failed is finished: a
 * finalize arriving afterwards (the client's error path and its retry racing)
 * must not resurrect it into `complete`, and must not emit
 * `recipe_import_completed` for a session that already emitted
 * `recipe_import_failed`. Between the two calls, exactly one event is emitted
 * per session, and the loser reports the terminal status that actually stuck.
 *
 * A session that is never finalized stays in `committing` forever and is harmless
 * (§5.3): the recipes are saved, the next run converges, and phase 1 has no
 * cleanup job.
 */
export async function runFinalizeImportSession(db: Kysely<DB>, did: string, householdId: string, input: FinalizeInput): Promise<FinalizeResult> {
  const { sql } = await import("kysely");
  const session = await loadSession(db, householdId, input.sessionId);
  const derived = await deriveSessionCounts(db, householdId, input.sessionId);

  const finished = await db
    .updateTable("recipe_import_session")
    .set({
      status: "complete" satisfies ImportSessionStatus,
      finished_at: sql<Date>`now()`,
      total_count: input.outcome.total,
      // Derived from rows (§7.7). `imported_count` is what this session CREATED;
      // linked records are reported in the result and the event but have no
      // column on a table this plan does not migrate.
      imported_count: derived.imported,
      // Both halves DERIVED from `recipe_import_skip` (§7.7). Summing them is
      // what this column has always meant; what changed is that neither half is
      // a number the client sent, so the done screen's five tiles and this row
      // cannot disagree about what happened to a recipe.
      skipped_count: derived.skippedDuplicate + derived.skippedUser,
      failed_count: input.outcome.failed,
    })
    .where("id", "=", input.sessionId)
    .where("household_id", "=", householdId)
    // The whole idempotency guarantee, in one predicate: only one caller can
    // move the row out of a live status, so only one caller emits — and that
    // one caller is either this or `runFailImportSession`, never both.
    .where("status", "not in", TERMINAL_STATUSES)
    .returning("id")
    .executeTakeFirst();

  const firstFinalize = Boolean(finished);
  // Re-read rather than trusting the update's RETURNING: on a replay there was
  // no update, and the stored numbers are what the first finalize wrote.
  const stored = await loadSession(db, householdId, input.sessionId);

  const counters = {
    total: stored.total_count,
    imported: derived.imported,
    linked: derived.linked,
    // Split all the way to the summary screen: they are different facts about
    // different user intent, and collapsing them hides recipes the user chose to
    // drop (§10.2, D24). The stored `skipped_count` is their sum.
    skippedDuplicate: derived.skippedDuplicate,
    skippedUser: derived.skippedUser,
    failed: stored.failed_count,
  };

  if (firstFinalize) {
    // §13: ONE event per session, importer-agnostic name with `importer` as a
    // property, so a second importer is a breakdown rather than a new funnel.
    // No recipe names, URLs, or ingredient text.
    const { captureServerEvent } = await import("#/lib/posthog-server");
    await captureServerEvent(did, "recipe_import_completed", {
      importer: session.importer,
      session_id: session.id,
      total: counters.total,
      imported: counters.imported,
      linked: counters.linked,
      skipped_duplicate: counters.skippedDuplicate,
      skipped_user: counters.skippedUser,
      overridden_duplicate: input.outcome.overriddenDuplicate,
      edited_before_commit: input.outcome.editedBeforeCommit,
      failed: counters.failed,
      parse_failures: input.outcome.parseFailures,
      distinct_source_strings_classified: input.outcome.distinctSourceStringsClassified,
      duration_ms: Date.now() - new Date(session.started_at).valueOf(),
    });
  }

  return {
    // The status that actually stuck, not an assumption. A finalize that lost
    // the race to `runFailImportSession` reports `failed`, because that is what
    // the session is.
    sessionId: session.id,
    status: stored.status as ImportSessionStatus,
    finishedAt: new Date(stored.finished_at ?? new Date()).toISOString(),
    firstFinalize,
    counters,
  };
}

/**
 * §13's other event. Terminal, and idempotent for the same reason finalize is:
 * only the call that actually moves the session out of a live status emits, and
 * both calls guard on the same {@link TERMINAL_STATUSES} set, so a session emits
 * `recipe_import_completed` or `recipe_import_failed` — exactly one, exactly
 * once, whichever call arrived first.
 */
export async function runFailImportSession(db: Kysely<DB>, did: string, householdId: string, input: FailImportSessionInput): Promise<{ ok: true }> {
  const { sql } = await import("kysely");
  const session = await loadSession(db, householdId, input.sessionId);
  const failed = await db
    .updateTable("recipe_import_session")
    .set({ status: "failed" satisfies ImportSessionStatus, finished_at: sql<Date>`now()` })
    .where("id", "=", input.sessionId)
    .where("household_id", "=", householdId)
    .where("status", "not in", TERMINAL_STATUSES)
    .returning("id")
    .executeTakeFirst();

  if (failed) {
    const { captureServerEvent } = await import("#/lib/posthog-server");
    await captureServerEvent(did, "recipe_import_failed", {
      importer: session.importer,
      session_id: session.id,
      stage: input.stage,
      message: input.message,
      duration_ms: Date.now() - new Date(session.started_at).valueOf(),
    });
  }
  return { ok: true };
}
