import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "#/db/types";
import { ulid } from "./household/ids";
import type { SaveRecipeInput, SaveRecipeResult } from "./recipes-write";

/**
 * DB-backed integration tests for `saveRecipe` — the create-recipe write path
 * (docs/plans/2026-08-02-create-recipes.md §A2), re-pinned after the
 * paprika-import refactor pulled its middle out into `persistRecipeDraft`
 * (2026-08-09-paprika-import.md §7.3, acceptance §16.14).
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 * §16.14 reads "`saveRecipe` behaves identically and its tests pass untouched",
 * and `saveRecipe` had no tests, which made the criterion true by vacuum. The
 * refactor moved validation, insertion and the dedupe-key write out of `runSave`
 * and into a function two callers share; what stayed behind is precisely the
 * part no other test covers — attribution resolution, the publish-time duplicate
 * probe, and the ORDER of the two.
 *
 * `persistRecipeDraft` itself is covered by `recipe-meta.db.test.ts`; this file
 * deliberately does not re-test it, and asserts only what `runSave` decides.
 *
 * ── HOW ──────────────────────────────────────────────────────────────────
 * `saveRecipe` is a `createServerFn`, so two things stand in for the transport:
 * `createServerFn` is faked down to its server half (validate → call handler)
 * and `activeContext()` returns this suite's fixture identity. Everything below
 * that line is shipped code against the real database — including `assertMember`,
 * which passes because the fixture inserts a genuine household membership.
 *
 *   pnpm test:db      # = vitest run --project db; DATABASE_URL comes from services/web/.env
 *
 * With no reachable database the suite SKIPS rather than fails, so `pnpm test`
 * stays green on a machine that has never booted the stack.
 */

// --- reachability probe --------------------------------------------------

function announceSkip(reason: string): void {
  process.stderr.write(`\nSKIPPING recipes-write DB tests — ${reason}.\nRun them against the local dev stack with \`pnpm test:db\`.\n\n`);
}

async function connectOrSkip(): Promise<Kysely<DB> | null> {
  if (!process.env.DATABASE_URL) {
    announceSkip("DATABASE_URL is not set");
    return null;
  }
  const { getDb } = await import("#/lib/db");
  const db = getDb();
  try {
    await Promise.race([sql`select 1 from recipe limit 0`.execute(db), new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 5s")), 5_000).unref?.())]);
    return db;
  } catch (error) {
    announceSkip(`no reachable migrated database (${error instanceof Error ? error.message : String(error)})`);
    await db.destroy().catch(() => {});
    return null;
  }
}

const db = await connectOrSkip();

// --- fixture -------------------------------------------------------------

/** One id space per run so a crashed run can never collide with the next. */
const RUN = ulid();

const HH = `hh-write-${RUN}`;
const DID = `did:test:write-${RUN}`;
const PUB_DID = `did:test:write-pub-${RUN}`;

/** A public, indexed record citing `PUBLISHED_URL` — the duplicate corpus. */
const PUBLISHED = `rec-write-published-${RUN}`;
const PUBLISHED_URL = `https://published.example/${RUN}/roast-chicken`;

/**
 * The RPC transport, and nothing else, replaced by its server half: validate the
 * input with the declared validator, then call the handler with `{ data }`. The
 * handler body — `activeContext()` → `assertMember()` → `runSave()` — is shipped
 * code, and `runSave` is not exported, so this is the only way to reach it.
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

vi.mock("./recipe-context", () => ({ activeContext: () => Promise.resolve({ did: DID, householdId: HH }) }));

// Loaded lazily so a skipped run never imports the server modules at all.
type RecipesWrite = typeof import("./recipes-write");
let write: RecipesWrite;

/** Recipes `saveRecipe` created; we only learn their ULIDs from the result. */
const created: string[] = [];

async function cleanup(): Promise<void> {
  if (!db) return;
  const ids = [PUBLISHED, ...created];
  await db.deleteFrom("recipe_meta").where("recipe_id", "in", ids).execute();
  await db.deleteFrom("household_recipe_meta").where("household_id", "=", HH).execute();
  await db.deleteFrom("household_recipe").where("household_id", "=", HH).execute();
  await db.deleteFrom("recipe_pending_image").where("recipe_id", "in", ids).execute();
  await db.deleteFrom("recipe_search").where("recipe_id", "in", ids).execute();
  await db.deleteFrom("recipe_ingredient").where("recipe_id", "in", ids).execute();
  await db.deleteFrom("recipe_instruction").where("recipe_id", "in", ids).execute();
  await db.deleteFrom("recipe_keyword").where("recipe_id", "in", ids).execute();
  await db.deleteFrom("recipe_attribution").where("recipe_id", "in", ids).execute();
  await db.deleteFrom("recipe").where("id", "in", ids).execute();
  await db.deleteFrom("household_member").where("household_id", "=", HH).execute();
  await db.deleteFrom("household").where("id", "=", HH).execute();
}

async function reset(): Promise<void> {
  if (!db) return;
  await cleanup();
  created.length = 0;

  await db
    .insertInto("household")
    .values({ id: HH, name: `write ${RUN}`, created_by_did: DID })
    .execute();
  // A real membership: `assertMember` inside the handler is NOT mocked, so the
  // happy paths below only pass because the caller genuinely belongs here.
  await db.insertInto("household_member").values({ household_id: HH, did: DID, role: "owner" }).execute();

  // The public duplicate corpus: `visibility='public'` AND `uri IS NOT NULL`
  // (the probe requires both — an unindexed public row is not offerable).
  await db
    .insertInto("recipe")
    .values({
      id: PUBLISHED,
      origin: "atproto",
      visibility: "public",
      name: "Someone Else's Roast Chicken",
      did: PUB_DID,
      rkey: PUBLISHED,
      uri: `at://${PUB_DID}/exchange.recipe.recipe/${PUBLISHED}`,
    })
    .execute();
  await db
    .insertInto("recipe_attribution")
    .values({ recipe_id: PUBLISHED, kind: "website", display_name: "published.example", url: PUBLISHED_URL, raw: JSON.stringify({}) })
    .execute();
}

if (db) {
  write = await import("./recipes-write");
  beforeEach(reset);
  afterAll(async () => {
    await cleanup();
    await db.destroy();
  });
}

const describeDb = db ? describe : describe.skip;

// --- helpers -------------------------------------------------------------

/** A record that satisfies the lexicon: `name`, `text`, `ingredients`, `instructions`. */
function validRecord(overrides: Partial<SaveRecipeInput["record"]> = {}): SaveRecipeInput["record"] {
  return {
    name: `Roast Chicken ${RUN}`,
    text: "A weeknight bird.",
    ingredients: ["1 whole chicken", "Salt"],
    instructions: ["Season the bird.", "Roast until done."],
    ...overrides,
  };
}

/** Call the real handler, remembering any recipe it created so cleanup can find it. */
async function save(input: SaveRecipeInput): Promise<SaveRecipeResult> {
  const result = await write.saveRecipe({ data: input });
  if ("recipeId" in result) created.push(result.recipeId);
  return result;
}

const attributionOf = (recipeId: string) => db!.selectFrom("recipe_attribution").selectAll().where("recipe_id", "=", recipeId).executeTakeFirst();

/**
 * A one-pixel JPEG's opening bytes, padded.
 *
 * Nothing sniffs these bytes any more — the mime is declared and then bound by
 * the upload's signature — so a real encoder would prove nothing this does not.
 * They stay JPEG-shaped only so a failure reads as a real photo would.
 */
function jpegBytes(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

/**
 * The image suites need a bucket as well as a database, so they carry their own
 * skip. The RustFS container in the repo's docker-compose.yml is what
 * satisfies this locally (`pnpm dev` starts it and creates the bucket); without
 * BLOB_S3_* they skip rather than fail, exactly like the database probe above.
 */
const hasBucket = Boolean(process.env.BLOB_S3_ENDPOINT && process.env.BLOB_S3_BUCKET && process.env.BLOB_S3_ACCESS_KEY_ID && process.env.BLOB_S3_SECRET_ACCESS_KEY);
if (db && !hasBucket) {
  process.stderr.write("\nSKIPPING recipes-write image tests — BLOB_S3_* is not set.\nStart the dev stack (`pnpm dev`) so the RustFS container and its bucket exist.\n\n");
}
const describeImages = db && hasBucket ? describe : describe.skip;

// --- tests ---------------------------------------------------------------

describeDb("saveRecipe — the private save", () => {
  it("writes the recipe, boxes it in the caller's household, and publishes nothing", async () => {
    const result = await save({
      record: validRecord({ attribution: { $type: "exchange.recipe.defs#attributionPerson", name: "Grandma" } as never }),
      visibility: "private",
      publish: false,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.published).toBe(false);

    const row = await db!.selectFrom("recipe").selectAll().where("id", "=", result.recipeId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ origin: "local", visibility: "private", uri: null, did: null, name: `Roast Chicken ${RUN}` });

    const boxed = await db!.selectFrom("household_recipe").selectAll().where("recipe_id", "=", result.recipeId).executeTakeFirstOrThrow();
    expect(boxed).toMatchObject({ household_id: HH, added_by_did: DID });

    // The children the create form's users actually see back.
    const ingredients = await db!.selectFrom("recipe_ingredient").select("text").where("recipe_id", "=", result.recipeId).orderBy("ordinal").execute();
    const instructions = await db!.selectFrom("recipe_instruction").select("text").where("recipe_id", "=", result.recipeId).orderBy("ordinal").execute();
    expect(ingredients.map((r) => r.text)).toEqual(["1 whole chicken", "Salt"]);
    expect(instructions.map((r) => r.text)).toEqual(["Season the bird.", "Roast until done."]);
  });

  it("keeps a lexicon attribution the record already carries when there is no source URL", async () => {
    const result = await save({
      record: validRecord({ attribution: { $type: "exchange.recipe.defs#attributionPerson", name: "Grandma" } as never }),
      visibility: "private",
      publish: false,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    expect(await attributionOf(result.recipeId)).toMatchObject({ kind: "person", display_name: "Grandma", url: null });
  });

  it("rejects a URL-less record with no attribution at all, before touching the recipe table", async () => {
    const before = await db!
      .selectFrom("recipe")
      .select(sql<number>`count(*)::int`.as("n"))
      .executeTakeFirstOrThrow();

    const result = await save({ record: validRecord(), visibility: "private", publish: false });

    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.issues).toEqual([{ path: "attribution", message: "Choose where this recipe came from." }]);

    const after = await db!
      .selectFrom("recipe")
      .select(sql<number>`count(*)::int`.as("n"))
      .executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);
  });
});

describeDb("saveRecipe — the lexicon gate", () => {
  it("returns `invalid` with a field-addressed issue rather than writing a partial row", async () => {
    // `text` is lexicon-required (`exchange.recipe.recipe`). A record missing it
    // is the shape the create form can produce and the DB would happily store,
    // which is exactly why the gate is the lexicon and not the column types.
    const record = validRecord({ attribution: { $type: "exchange.recipe.defs#attributionPerson", name: "Grandma" } as never });
    delete (record as { text?: string }).text;

    const result = await save({ record, visibility: "private", publish: false });

    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.issues.length).toBeGreaterThan(0);
    // A *missing* required property is reported at the object root (path ""),
    // with the field named in the message — unlike a *present but wrong* one,
    // which is addressed by path (see the length case below). Both forms have to
    // be usable by the form, so both are asserted rather than assumed alike.
    expect(result.issues.some((i) => `${i.path} ${i.message}`.includes("text"))).toBe(true);
    for (const issue of result.issues) expect(typeof issue.message).toBe("string");

    // Nothing landed: the gate runs before the insert, so there is no row to clean up.
    const rows = await db!.selectFrom("recipe").select("id").where("name", "=", record.name).execute();
    expect(rows).toEqual([]);
  });

  it("returns `invalid` for a record that violates a length bound", async () => {
    const result = await save({
      record: validRecord({ name: "x".repeat(300), attribution: { $type: "exchange.recipe.defs#attributionPerson", name: "Grandma" } as never }),
      visibility: "private",
      publish: false,
    });

    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.issues.map((i) => i.path)).toContain("name");
  });
});

describeDb("saveRecipe — the publish-time duplicate probe", () => {
  it("offers the existing public record instead of creating a second copy", async () => {
    const result = await save({ record: validRecord(), visibility: "private", publish: true, sourceUrl: PUBLISHED_URL });

    expect(result).toEqual({ status: "duplicate", existingRecipeId: PUBLISHED });

    // Nothing was written — no draft left behind for the user to trip over.
    const rows = await db!.selectFrom("recipe").select("id").where("name", "=", `Roast Chicken ${RUN}`).execute();
    expect(rows).toEqual([]);
  });

  it("matches the cited URL case-insensitively", async () => {
    const result = await save({ record: validRecord(), visibility: "private", publish: true, sourceUrl: PUBLISHED_URL.toUpperCase() });
    expect(result.status).toBe("duplicate");
  });

  /**
   * The probe is scoped to `publish`. A private save of the same URL is a
   * legitimate personal copy of a public recipe and must go through — the whole
   * point of §16.9's "imports are never published".
   */
  it("does NOT fire on a private save of the same URL", async () => {
    const result = await save({ record: validRecord(), visibility: "private", publish: false, sourceUrl: PUBLISHED_URL });
    expect(result.status).toBe("ok");
  });

  /**
   * ── DOCUMENTED BEHAVIOR CHANGE (deliberate) ──────────────────────────────
   * An input that is BOTH lexicon-invalid AND a publish-time duplicate now
   * returns `duplicate`; before the §7.3 refactor it returned `invalid`,
   * because validation happened inside `runSave` ahead of the probe and now
   * happens inside `persistRecipeDraft` behind it.
   *
   * This is pinned as the intended behavior, not merely observed. It is also the
   * better answer: the user's next action is "use the existing recipe", which no
   * amount of fixing the field issues changes. Restoring the old ordering would
   * mean validating twice or moving the probe into the shared core, and the
   * shared core deliberately does not dedupe (§7.3 — the two callers check
   * different corpora). If a future change flips this back, that is a decision
   * to make on purpose, and this test is where it gets made.
   */
  it("returns `duplicate`, not `invalid`, when the submission is both", async () => {
    const record = validRecord();
    delete (record as { text?: string }).text; // lexicon-invalid

    const result = await save({ record, visibility: "private", publish: true, sourceUrl: PUBLISHED_URL });

    expect(result.status).toBe("duplicate");
  });
});

describeDb("saveRecipe — attribution (§8.2: never invented, never client-trusted)", () => {
  it("rebuilds Website attribution from the source URL, overriding what the client sent", async () => {
    const sourceUrl = `https://www.Smitten-Kitchen.example/${RUN}/roast/?utm_source=newsletter`;

    const result = await save({
      record: validRecord({
        // A client claiming the recipe is Grandma's while also declaring where it
        // came from. The URL is the fact; the claim is not.
        attribution: { $type: "exchange.recipe.defs#attributionPerson", name: "Grandma" } as never,
      }),
      visibility: "private",
      publish: false,
      sourceUrl,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const attribution = await attributionOf(result.recipeId);
    expect(attribution).toMatchObject({
      kind: "website",
      // `www.` stripped, the rest of the URL kept verbatim — the client's
      // "person" attribution is gone entirely, not merged.
      display_name: "smitten-kitchen.example",
      url: sourceUrl,
    });
    expect(attribution?.author).toBeNull();
  });

  it("trims a whitespace-only source URL back to 'no source' rather than attributing to it", async () => {
    const result = await save({
      record: validRecord({ attribution: { $type: "exchange.recipe.defs#attributionPerson", name: "Grandma" } as never }),
      visibility: "private",
      publish: false,
      sourceUrl: "   ",
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(await attributionOf(result.recipeId)).toMatchObject({ kind: "person", display_name: "Grandma" });
  });
});

describeDb("saveRecipe — dedupe keys (§6, §6.6 writer 1)", () => {
  it("lands both keys under ns='dedupe', computed from the saved record", async () => {
    const sourceUrl = `https://www.Keys-Example.test/${RUN}/dish/?utm_campaign=x`;
    const record = validRecord({ attribution: { $type: "exchange.recipe.defs#attributionPerson", name: "Grandma" } as never });

    const result = await save({ record, visibility: "private", publish: false, sourceUrl });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const { normalizeSourceUrl, contentFingerprint } = await import("@buttery/recipe-schemas/normalize");
    const rows = await db!.selectFrom("recipe_meta").select(["ns", "key", "value"]).where("recipe_id", "=", result.recipeId).orderBy("key").execute();

    expect(rows.map((r) => r.ns)).toEqual(["dedupe", "dedupe"]);
    expect(Object.fromEntries(rows.map((r) => [r.key, r.value]))).toEqual({
      content_fp: await contentFingerprint(record.name, record.ingredients ?? []),
      source_url_key: normalizeSourceUrl(sourceUrl),
    });
  });

  it("writes only content_fp when there is no source URL — an absent key, never a null one", async () => {
    const result = await save({
      record: validRecord({ attribution: { $type: "exchange.recipe.defs#attributionPerson", name: "Grandma" } as never }),
      visibility: "private",
      publish: false,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const rows = await db!.selectFrom("recipe_meta").select(["ns", "key"]).where("recipe_id", "=", result.recipeId).execute();
    expect(rows).toEqual([{ ns: "dedupe", key: "content_fp" }]);
  });
});

describeDb("publishRecipe — publishing a draft that already exists", () => {
  /**
   * The regression this file was missing. `buildRecordFromRow` assembles the
   * record from the author's columns only, and `createdAt`/`updatedAt` are the
   * server's to stamp (`recipe-record.ts`) — so before the stamp was added,
   * every publish of an existing draft came back
   * `invalid: Missing required key "createdAt"` and nothing ever reached a PDS.
   *
   * The kill switch is forced OFF for the assertion, which puts
   * `publish_disabled` immediately after the validation gate in
   * `runPublishExisting`: reaching it proves the record validated, and stops the
   * test one step short of a PDS this suite has no session for.
   */
  it("gets past the lexicon gate — the record is stamped, not rejected for a missing createdAt", async () => {
    const saved = await save({
      record: validRecord({ attribution: { $type: "exchange.recipe.defs#attributionPerson", name: "Grandma" } as never }),
      visibility: "private",
      publish: false,
    });
    expect(saved.status).toBe("ok");
    if (saved.status !== "ok") return;

    const previous = process.env.ATPROTO_PUBLISH_ENABLED;
    process.env.ATPROTO_PUBLISH_ENABLED = "false";
    try {
      const result = await write.publishRecipe({ data: { recipeId: saved.recipeId } });
      expect(result.status).toBe("publish_disabled");
    } finally {
      if (previous === undefined) delete process.env.ATPROTO_PUBLISH_ENABLED;
      else process.env.ATPROTO_PUBLISH_ENABLED = previous;
    }
  });
});

describeImages("saveRecipe — the image is always OURS (never the origin's URL)", () => {
  /**
   * The invariant, asserted against a real bucket: a recipe that comes through
   * Buttery has Buttery's bytes, and they got there without passing through this
   * server. Each test does what the browser does — ask for a signed URL, PUT the
   * bytes at it, hand the save the id — so what is pinned here is the real
   * upload path, signature and all.
   */

  /** POST a presigned form the way a browser does: policy fields first, file last. */
  async function postForm(upload: { url: string; fields: Record<string, string> }, bytes: Uint8Array, over: Record<string, string> = {}): Promise<Response> {
    const form = new FormData();
    for (const [name, value] of Object.entries({ ...upload.fields, ...over })) form.append(name, value);
    form.append("file", new Blob([bytes as unknown as BlobPart], { type: over["Content-Type"] ?? upload.fields["Content-Type"] }));
    return await fetch(upload.url, { method: "POST", body: form });
  }

  /** The browser's half: sign, POST, return the id a save can redeem. */
  async function uploadAsBrowser(bytes: Uint8Array, mime = "image/jpeg"): Promise<string> {
    const ticket = await write.createRecipeImageUpload({ data: { mime, size: bytes.byteLength } });
    expect(ticket).not.toBeNull();
    expect((await postForm(ticket!, bytes)).ok).toBe(true);
    return ticket!.uploadId;
  }

  it("points the row at the very object the browser uploaded — no copy, no move", async () => {
    const { getBlob, uploadKey } = await import("#/lib/blob-storage");
    const uploadId = await uploadAsBrowser(jpegBytes());

    const result = await save({
      record: validRecord({ attribution: { $type: "exchange.recipe.defs#attributionPerson", name: "Grandma" } as never }),
      visibility: "private",
      publish: false,
      image: { uploadId, alt: "the bird" },
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const row = await db!.selectFrom("recipe_pending_image").selectAll().where("recipe_id", "=", result.recipeId).executeTakeFirstOrThrow();
    // The key the browser wrote to, unchanged. The previous design copied the
    // bytes to `pending/<recipeId>` through this server's memory.
    expect(row.object_key).toBe(uploadKey(DID, uploadId));
    expect(row.mime).toBe("image/jpeg");
    expect(row.alt).toBe("the bird");

    // The row is a promise about the bucket, so read the bucket.
    await expect(getBlob(row.object_key)).resolves.toHaveLength(64);
  });

  it("will not sign an upload over the 2 MB cap", async () => {
    // Bluesky's current blob limit, and the only place it has to be stated —
    // the signature is what makes it binding.
    const { MAX_IMAGE_BYTES } = await import("#/lib/recipe-image");
    await expect(write.createRecipeImageUpload({ data: { mime: "image/jpeg", size: MAX_IMAGE_BYTES + 1 } })).resolves.toBeNull();
    await expect(write.createRecipeImageUpload({ data: { mime: "image/jpeg", size: 0 } })).resolves.toBeNull();
  });

  it("will not sign a type that is not an image we serve", async () => {
    // `image/svg+xml` is the one worth naming: an SVG is a document that can
    // script, and these bytes are user-supplied and served back under our own
    // authorization.
    await expect(write.createRecipeImageUpload({ data: { mime: "image/svg+xml", size: 64 } })).resolves.toBeNull();
    await expect(write.createRecipeImageUpload({ data: { mime: "text/html", size: 64 } })).resolves.toBeNull();
  });

  it("the signed form itself refuses a body the policy does not allow", async () => {
    // The three conditions, checked where they are actually enforced. A client
    // that lies to `createRecipeImageUpload` gets a form that will not take the
    // bytes — which is what makes the 2 MB cap real rather than advisory, and
    // what stops a stolen form being pointed at another account's key.
    const { MAX_IMAGE_BYTES } = await import("#/lib/recipe-image");
    const ticket = await write.createRecipeImageUpload({ data: { mime: "image/jpeg", size: 64 } });
    expect(ticket).not.toBeNull();

    const tooBig = new Uint8Array(MAX_IMAGE_BYTES + 1);
    tooBig.set([0xff, 0xd8, 0xff, 0xe0]);
    expect((await postForm(ticket!, tooBig)).ok).toBe(false);

    expect((await postForm(ticket!, jpegBytes(), { "Content-Type": "image/png" })).ok).toBe(false);
    expect((await postForm(ticket!, jpegBytes(), { key: `uploads/elsewhere/${ulid()}` })).ok).toBe(false);
  });

  it("refuses an upload id belonging to another account", async () => {
    // The whole authorization for a claim: the key is rebuilt from the SESSION's
    // did, so an id lifted from someone else's upload names a key this account
    // does not own and resolves to nothing.
    const { presignUpload, uploadKey } = await import("#/lib/blob-storage");
    const uploadId = ulid();
    const upload = await presignUpload(uploadKey(`did:test:someone-else-${RUN}`, uploadId), "image/jpeg");
    expect((await postForm(upload, jpegBytes())).ok).toBe(true);

    const result = await save({
      record: validRecord({ attribution: { $type: "exchange.recipe.defs#attributionPerson", name: "Grandma" } as never }),
      visibility: "private",
      publish: false,
      image: { uploadId },
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const row = await db!.selectFrom("recipe_pending_image").selectAll().where("recipe_id", "=", result.recipeId).executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it("logs where an imported hero came from, beside the bytes and never instead of them", async () => {
    // `source_url` survived the migration that made `object_key` required, which
    // is what turned it from a fallback into a note. Pinned here from the outside:
    // a save that carries one records it, and a save that carries no bytes writes
    // no row at all — so there is no state where the URL is the image.
    const uploadId = await uploadAsBrowser(jpegBytes());
    const origin = `https://cdn.example/${RUN}/hero.jpg`;

    const result = await save({
      record: validRecord({ attribution: { $type: "exchange.recipe.defs#attributionPerson", name: "Grandma" } as never }),
      visibility: "private",
      publish: false,
      image: { uploadId, sourceUrl: origin },
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const row = await db!.selectFrom("recipe_pending_image").selectAll().where("recipe_id", "=", result.recipeId).executeTakeFirstOrThrow();
    expect(row.source_url).toBe(origin);
    expect(row.object_key).not.toBeNull();
  });

  it("saves the recipe with NO image when the upload never landed", async () => {
    // A well-formed id for bytes that are not there. The browser reporting
    // success is not evidence the bucket agreed, which is why the save HEADs the
    // object rather than trusting the id — and why a recipe without our bytes
    // has no row for a read path to render.
    const result = await save({
      record: validRecord({ attribution: { $type: "exchange.recipe.defs#attributionPerson", name: "Grandma" } as never }),
      visibility: "private",
      publish: false,
      image: { uploadId: ulid() },
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const row = await db!.selectFrom("recipe_pending_image").selectAll().where("recipe_id", "=", result.recipeId).executeTakeFirst();
    expect(row).toBeUndefined();
  });
});

describeDb("recipe_pending_image — a URL can never be the image again", () => {
  /**
   * The guard that goes red if the class comes back.
   *
   * The bug was not that a line of code stored a URL; it was that `object_key`
   * was NULLABLE, so "no bytes, here is someone else's URL instead" was a row
   * the table would accept — and once it was acceptable, three call sites wrote
   * it and a read path rendered it as an `<img src>` on our own page.
   *
   * `source_url` is still here, and that is deliberate: with `object_key`
   * required it cannot be a substitute for bytes, only a note about the bytes we
   * have. The not-null constraint is the whole difference between a log and a
   * fallback, so it is the thing this test pins. A migration that relaxes it
   * fails here, in a test whose name says why.
   */
  it("requires an object key and a mime, so `source_url` can only ever be a note", async () => {
    const columns = await sql<{ column_name: string; is_nullable: string }>`
      select column_name, is_nullable
      from information_schema.columns
      where table_name = 'recipe_pending_image'
    `.execute(db!);

    const nullable = new Map(columns.rows.map((c) => [c.column_name, c.is_nullable]));
    expect([...nullable.keys()].sort()).toEqual(["alt", "created_at", "mime", "object_key", "recipe_id", "source_url"]);

    // A row that exists is a row with our bytes behind it, which is what lets
    // every reader treat "row present" as "we have it" and never look further.
    expect(nullable.get("object_key")).toBe("NO");
    expect(nullable.get("mime")).toBe("NO");
    // And the log stays optional — an image the user picked off their own disk
    // came from nowhere, and saying so must not be a constraint violation.
    expect(nullable.get("source_url")).toBe("YES");
  });
});

// --- runCopyRemoteImage --------------------------------------------------

/**
 * The hop that exists because the browser's copy has no permission to make it: a
 * CDN that sends no `Access-Control-Allow-Origin` has no image at all as far as a
 * `fetch` from our page is concerned, so the server fetches those bytes instead
 * and POSTs them at a form it signed for itself.
 *
 * `fetchBytes` is injected in every test below, and that is not a convenience —
 * `safeFetchBytes` rejects loopback, so a test CANNOT point the real fetcher at
 * an HTTP server it started itself. Everything downstream of the injection point
 * is shipped code against the real bucket, which is where the assertions look: a
 * return value is a claim about an object, so the object gets read.
 */

type CopyDeps = import("./recipes-write").CopyRemoteImageDeps;

/** Canned bytes, plus what the remote CLAIMS they are. The claim is the part under test. */
function fetcherFor(bytes: Uint8Array, contentType: string | null = "image/jpeg"): CopyDeps["fetchBytes"] {
  return () => Promise.resolve({ bytes, contentType });
}

/**
 * Every object in one account's upload partition.
 *
 * This is how a test proves nothing was written: the key is `uploads/<sha256 of
 * the did>/<id>`, so a DID used by exactly one test owns a prefix of its own and
 * an empty listing there is a complete statement about that test.
 */
async function uploadsUnder(did: string): Promise<string[]> {
  const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const { getBlobClient, uploadKey } = await import("#/lib/blob-storage");
  const res = await getBlobClient().send(new ListObjectsV2Command({ Bucket: process.env.BLOB_S3_BUCKET, Prefix: uploadKey(did, "") }));
  return (res.Contents ?? []).map((object) => object.Key ?? "");
}

describeImages("runCopyRemoteImage — the server-side copy, for the photo a browser cannot reach", () => {
  /** Keys this suite wrote, deleted afterwards so a dev bucket doesn't accrete a run's worth of 64-byte objects. */
  const copiedKeys: string[] = [];

  afterAll(async () => {
    const { deleteBlob } = await import("#/lib/blob-storage");
    for (const key of copiedKeys) await deleteBlob(key).catch(() => {});
  });

  it("puts the remote bytes in OUR bucket, under this account's key, and the preview serves them back", async () => {
    const { getBlob, headBlob, uploadKey } = await import("#/lib/blob-storage");
    const { isValidUploadId } = await import("#/lib/recipe-image");
    const bytes = jpegBytes();

    const result = await write.runCopyRemoteImage(DID, "https://assets.example/no-cors/hero.jpg", { fetchBytes: fetcherFor(bytes) });

    expect(result).not.toBeNull();
    if (!result) return;
    expect(isValidUploadId(result.uploadId)).toBe(true);

    // The id is a claim about an object, so read the object. The stored mime is
    // the one the SNIFF decided and the signature bound — not the one the remote
    // sent, and the two are the same here only because the bytes are honest.
    const key = uploadKey(DID, result.uploadId);
    copiedKeys.push(key);
    expect(await headBlob(key)).toEqual({ size: bytes.byteLength, mime: "image/jpeg" });
    await expect(getBlob(key)).resolves.toEqual(bytes);

    // The preview is what the create form drops into an `<img src>`, so it has to
    // resolve to those bytes on its own — no session, no further signing.
    const preview = await fetch(result.previewUrl);
    expect(preview.ok).toBe(true);
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(bytes);
  });

  it("asks the fetcher for no more than the 2 MB cap, so the egress guard cannot silently widen", async () => {
    // The cap is enforced twice: here, before the bytes are ever in this
    // process's memory, and again by the presigned POST's own policy. This pins
    // the first one to the shared constant, so a copy can never buffer more than
    // a publish could carry.
    const { MAX_IMAGE_BYTES } = await import("#/lib/recipe-image");
    const { uploadKey } = await import("#/lib/blob-storage");
    const asked: Array<{ maxBytes: number }> = [];

    const result = await write.runCopyRemoteImage(DID, "https://assets.example/no-cors/cap.jpg", {
      fetchBytes: (_url, opts) => {
        asked.push(opts);
        return Promise.resolve({ bytes: jpegBytes(), contentType: "image/jpeg" });
      },
    });

    expect(asked).toEqual([{ maxBytes: MAX_IMAGE_BYTES }]);
    if (result) copiedKeys.push(uploadKey(DID, result.uploadId));
  });

  it("believes the bytes and not the `content-type` — an HTML hotlink refusal served as image/jpeg becomes no photo at all", async () => {
    // The case the sniffer exists for. A host with hotlink protection answers
    // HTTP 200 with `content-type: image/jpeg` and a refusal page in the body;
    // believing the header would store a document where a photo belongs and hand
    // a PDS a blob it cannot decode.
    const did = `did:test:imgcopy-html-${RUN}`;
    const html = new TextEncoder().encode("<!doctype html>\n<html><body>Hotlinking is not permitted.</body></html>");

    await expect(write.runCopyRemoteImage(did, "https://assets.example/hotlink/hero.jpg", { fetchBytes: fetcherFor(html, "image/jpeg") })).resolves.toBeNull();

    // Null on its own is not the property. The property is that no object exists
    // for a later save to redeem, so the bucket is what gets asked.
    expect(await uploadsUnder(did)).toEqual([]);
  });

  it("returns null rather than throwing when the fetch fails, because a photo is the one part of a recipe allowed to go missing", async () => {
    // Stands in for the whole failure population: the SSRF guard refusing a
    // private address, a dead CDN, a timeout, a 403. They are one outcome here,
    // and a throw would turn a missing photo into a failed import.
    const did = `did:test:imgcopy-fail-${RUN}`;
    const { SafeFetchError } = await import("#/lib/net/safe-fetch");

    await expect(
      write.runCopyRemoteImage(did, "http://169.254.169.254/latest/meta-data/", {
        fetchBytes: () => Promise.reject(new SafeFetchError("blocked", "That address isn't reachable.")),
      }),
    ).resolves.toBeNull();

    await expect(write.runCopyRemoteImage(did, "https://assets.example/gone.jpg", { fetchBytes: () => Promise.reject(new Error("socket hang up")) })).resolves.toBeNull();

    expect(await uploadsUnder(did)).toEqual([]);
  });

  it("cannot smuggle an oversize body past the policy by putting a JPEG's magic bytes on the front of it", async () => {
    // The cap that matters is the bucket's, which is what makes it binding rather
    // than advisory: the presigned POST carries a `content-length-range`, so the
    // bucket refuses the body and there is nothing at the key afterwards.
    const { MAX_IMAGE_BYTES } = await import("#/lib/recipe-image");
    const did = `did:test:imgcopy-big-${RUN}`;
    const tooBig = new Uint8Array(MAX_IMAGE_BYTES + 1);
    tooBig.set([0xff, 0xd8, 0xff, 0xe0]);

    await expect(write.runCopyRemoteImage(did, "https://assets.example/enormous.jpg", { fetchBytes: fetcherFor(tooBig) })).resolves.toBeNull();

    expect(await uploadsUnder(did)).toEqual([]);
  });
});

/**
 * The limiter is the only thing in this file that needs Redis, so it carries its
 * own probe — same arrangement as the bucket above. Without a reachable Redis the
 * copy deliberately fails OPEN, which means the assertion below would be testing
 * nothing rather than failing, so it skips instead.
 */
const redisForCopyLimit = await (async (): Promise<ReturnType<typeof import("#/lib/redis").getRedis> | null> => {
  if (!db || !hasBucket || !process.env.REDIS_URL) return null;
  try {
    const { getRedis } = await import("#/lib/redis");
    const redis = getRedis();
    await Promise.race([redis.ping(), new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 3s")), 3_000).unref?.())]);
    return redis;
  } catch (error) {
    process.stderr.write(`\nSKIPPING the copy rate-limit test — no reachable Redis (${error instanceof Error ? error.message : String(error)}).\n\n`);
    return null;
  }
})();
const describeCopyLimit = redisForCopyLimit ? describe : describe.skip;

describeCopyLimit("runCopyRemoteImage — the egress rate limit", () => {
  it("refuses the 31st copy in the window while the first 30 land, and the 31st is otherwise identical", async () => {
    // The discriminator matters: all 31 calls get the SAME valid JPEG bytes, so
    // the counter is the only thing that can explain the last one coming back
    // null. (Driving the first 30 with failures instead would make every call
    // return null and prove nothing.)
    const { deleteBlob, uploadKey } = await import("#/lib/blob-storage");
    const redis = redisForCopyLimit!;
    const did = `did:test:imgcopy-limit-${RUN}`;
    const counterKey = `imgcopy:${did}`;
    const written: string[] = [];

    await redis.del(counterKey);
    try {
      for (let n = 1; n <= 30; n++) {
        const result = await write.runCopyRemoteImage(did, `https://assets.example/limit/${n}.jpg`, { fetchBytes: fetcherFor(jpegBytes()) });
        expect(result, `copy ${n} of 30 was refused`).not.toBeNull();
        if (result) written.push(uploadKey(did, result.uploadId));
      }

      await expect(write.runCopyRemoteImage(did, "https://assets.example/limit/31.jpg", { fetchBytes: fetcherFor(jpegBytes()) })).resolves.toBeNull();

      // Refused before the fetch, so the refusal costs no egress and leaves no
      // object: thirty copies in, thirty objects out.
      expect(await uploadsUnder(did)).toHaveLength(30);

      // And the window is a window — the counter expires, so an account is not
      // locked out of hero photos forever after one bulk import.
      const ttl = await redis.ttl(counterKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(600);
    } finally {
      await redis.del(counterKey).catch(() => {});
      for (const key of written) await deleteBlob(key).catch(() => {});
    }
  });
});
