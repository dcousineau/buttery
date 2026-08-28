import { createServerFn } from "@tanstack/react-start";
import type { Kysely } from "kysely";
import * as z from "zod";
import type { DB, Json } from "#/db/types";
import type { CounterpartView, LlmEnrichTriggerResult, RecipeDebugPayload } from "#/devtools/types";

/**
 * Server read surface for the recipe devtools panel (`devtools/RecipeInspector`).
 * The wire contract (`RecipeDebugPayload` and friends) is owned by
 * `devtools/types.ts`, written once so the panel and this module could be built
 * independently against it — read that file's comments before this one, they
 * explain the section design and the `published` flag.
 *
 * Modelled closely on `recipe-enrichment.ts`, its sibling dev-panel module:
 * same authorization, same double dev gate, same "plain function holds the
 * behaviour, the server fn is a thin session-resolving wrapper" split.
 *
 * ── ONE DIFFERENCE FROM recipe-enrichment.ts's SHAPE ───────────────────────
 * `getRecipeEnrichment(db, recipeId)` takes no household at all — enrichment
 * isn't household data, so its wrapper does the box check itself before
 * calling in. This module's payload is mostly household-scoped private data
 * (notes, box entry, collections, meal plan, import provenance), so
 * `householdId` has to reach nearly every query in the plain function anyway.
 * Rather than split "is this recipe boxed here" out into the wrapper the way
 * recipe-enrichment.ts does, `getRecipeDebug` below does that check itself —
 * still the box-check `recipe-enrichment.ts` uses (`household_recipe`
 * existence for `(householdId, recipeId)`), just relocated so the db test can
 * exercise `found: false` for a real-but-foreign recipe without faking a
 * session. The wrapper still owns the one piece that NEEDS a session:
 * `assertMember(did, householdId)`.
 *
 * ── THE DEV GATE IS DOUBLE, AND THE SERVER SIDE IS THE REAL ONE ────────────
 * The panel renders on the client only when `import.meta.env.DEV`, but that is
 * a build-time flag baked into the client bundle — a production bundle simply
 * never ships the panel's code, and nothing stops a caller from POSTing at
 * `getRecipeDebugPayload` directly regardless of what shipped. So the handler
 * re-checks `process.env.NODE_ENV` on the SERVER, which is the process
 * actually deciding whether to run the query, and refuses outright in
 * production. Bypassing the client gate reaches nothing.
 *
 * ── NEVER LEAKS ANOTHER HOUSEHOLD'S PRIVATE DATA ON A SHARED RECIPE ROW ────
 * A `recipe` row (especially `origin='sync'`) can be boxed by many households
 * at once. Every household-scoped table this module reads
 * (`household_recipe`, `household_recipe_note`, `household_recipe_meta`,
 * `recipe_collection_entry`, `meal_plan_entry`) is filtered on BOTH
 * `recipe_id` and `household_id = householdId` — dropping the household half
 * would show the caller another household's private notes on a recipe they
 * happen to share.
 *
 * ── COUNTERPARTS ARE NOT AUTHORIZATION-FILTERED, BY DESIGN ─────────────────
 * The dedupe sidecar match (plan b) intentionally searches every household's
 * recipes, not just the caller's — that IS the point of a "same dish, other
 * origin/visibility" view. `CounterpartView` only ever carries the fields the
 * contract lists (id/name/origin/visibility/did/matchedOn/inBox); this module
 * never builds a private-layers section for a counterpart, so there is nothing
 * further to leak. `inBox` is set from the caller's own household only.
 *
 * ── `unknown` VS. createServerFn's SERIALIZABILITY CHECK ───────────────────
 * `DebugSection.rows` and `AtprotoRecordView.record` are `unknown` in
 * `devtools/types.ts`, deliberately — that file is off limits here. But
 * TanStack Start's `createServerFn().handler()` statically rejects a bare
 * `unknown` in a handler's return type (it cannot prove an arbitrary unknown
 * is serializable — see `ValidateSerializableMapped` in
 * `@tanstack/router-core`), even though every ACTUAL value this module
 * builds (raw `pg`/Kysely rows — strings, numbers, `Date`s, `jsonb` already
 * typed `Json` in `#/db/types`) is fully serializable. So `computeRecipeDebug`
 * below is deliberately left WITHOUT an explicit `RecipeDebugPayload`
 * annotation: TS then infers its real, narrower, fully-serializable type from
 * what it actually returns, and that is what `getRecipeDebugPayload`'s
 * handler passes to `.handler()`. `getRecipeDebug`, the plain function the
 * contract asks for, is a two-line wrapper that widens that same value to the
 * documented `RecipeDebugPayload` type for its callers (the db test
 * included) — a safe, ordinary upcast, not a runtime change.
 */

// --- bounds ---------------------------------------------------------------

/** Cap on rows returned per `DebugSection`, and on the counterparts list. A
 * recipe with hundreds of ingredient lines (or a dish dedupe-matched against
 * dozens of imports) must not blow up the payload silently — it gets capped
 * and the truncation is named in `warnings`. */
const MAX_SECTION_ROWS = 200;

/** Counterparts get their own, smaller cap — the dedupe match is a fan-out
 * across every recipe in the index, not one recipe's own children. */
const MAX_COUNTERPARTS = 50;

const recipeIdInput = z.object({ recipeId: z.string().min(1).max(512) });

// --- small helpers ---------------------------------------------------------

function iso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Cap an already-fetched (limit+1)-sized array to `MAX_SECTION_ROWS`, naming the table in `warnings` when it truncated. */
function cap<T>(rows: T[], table: string, warnings: string[]): T[] {
  if (rows.length <= MAX_SECTION_ROWS) return rows;
  warnings.push(`${table}: capped at ${MAX_SECTION_ROWS} rows (more exist).`);
  return rows.slice(0, MAX_SECTION_ROWS);
}

/** `numeric` comes back from `pg` as a string. Mirrors `recipe-enrichment.ts`'s `toNum` / `grocery.ts`'s equivalent. */
function toNum(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The gate both the read (`computeRecipeDebug`) and the trigger
 * (`triggerLlmEnrichPayload`) share: does `recipeId` belong to `householdId`'s
 * box at all. Extracted so the trigger doesn't have to re-derive the "found:
 * false collapses a deleted id and a foreign id" reasoning documented on
 * `computeRecipeDebug` below — it reuses the exact same query.
 */
async function isRecipeBoxed(db: Kysely<DB>, householdId: string, recipeId: string): Promise<boolean> {
  const boxed = await db.selectFrom("household_recipe").select("recipe_id").where("household_id", "=", householdId).where("recipe_id", "=", recipeId).executeTakeFirst();
  return boxed !== undefined;
}

// --- (b) counterparts -------------------------------------------------------

/**
 * Recipe ids sharing one dedupe key with `recipeId`, via the same expression
 * (`value #>> '{}'`) the `recipe_meta_dedupe` partial index is built on —
 * mirrors `recipe-import.ts`'s `findInBoxMatches`/`findPublicMatches`, just
 * without their household/visibility restriction (see module doc).
 */
async function matchRecipeIds(db: Kysely<DB>, key: "content_fp" | "source_url_key", value: string, excludeId: string): Promise<string[]> {
  const { sql } = await import("kysely");
  const rows = await db
    .selectFrom("recipe_meta")
    .select("recipe_id")
    .where("ns", "=", "dedupe")
    .where("key", "=", key)
    .where("recipe_id", "!=", excludeId)
    .where(sql<boolean>`value #>> '{}' = ${value}`)
    .limit(MAX_COUNTERPARTS + 1)
    .execute();
  return rows.map((r) => r.recipe_id);
}

async function loadCounterparts(
  db: Kysely<DB>,
  recipeId: string,
  householdId: string,
  dedupe: { contentFp: string | null; sourceUrlKey: string | null },
  warnings: string[],
): Promise<CounterpartView[]> {
  if (!dedupe.contentFp && !dedupe.sourceUrlKey) return [];

  // `content_fp` (identical ingredients) is the stronger signal — see
  // `devtools/types.ts`'s `CounterpartView` doc. Written url-key ids first so
  // a content_fp match for the same id overwrites it below.
  const matchedOn = new Map<string, "content_fp" | "source_url_key">();
  if (dedupe.sourceUrlKey) {
    for (const id of await matchRecipeIds(db, "source_url_key", dedupe.sourceUrlKey, recipeId)) matchedOn.set(id, "source_url_key");
  }
  if (dedupe.contentFp) {
    for (const id of await matchRecipeIds(db, "content_fp", dedupe.contentFp, recipeId)) matchedOn.set(id, "content_fp");
  }
  if (!matchedOn.size) return [];

  let ids = [...matchedOn.keys()].sort();
  if (ids.length > MAX_COUNTERPARTS) {
    warnings.push(`counterparts: capped at ${MAX_COUNTERPARTS} matches (more exist).`);
    ids = ids.slice(0, MAX_COUNTERPARTS);
  }

  const recipes = await db.selectFrom("recipe").select(["id", "name", "origin", "visibility", "did"]).where("id", "in", ids).execute();

  const boxed = await db.selectFrom("household_recipe").select("recipe_id").where("household_id", "=", householdId).where("recipe_id", "in", ids).execute();
  const inBoxIds = new Set(boxed.map((r) => r.recipe_id));

  const views: CounterpartView[] = recipes
    .map((r) => ({
      recipeId: r.id,
      name: r.name,
      origin: r.origin,
      visibility: r.visibility,
      did: r.did,
      matchedOn: matchedOn.get(r.id) ?? "content_fp",
      inBox: inBoxIds.has(r.id),
    }))
    .sort((a, b) => a.recipeId.localeCompare(b.recipeId));

  const outsideBox = views.filter((v) => !v.inBox).length;
  if (outsideBox > 0) {
    warnings.push(`${outsideBox} counterpart(s) are outside your household's box — only id/name/origin/visibility are shown, no private layers.`);
  }

  return views;
}

// --- the plain function -----------------------------------------------------

/**
 * Holds ALL of the behaviour, `db` first, per `grocery.ts`'s module doc — so
 * `recipe-debug.db.test.ts` reaches it directly, without faking a session.
 * Deliberately unannotated (no `: Promise<RecipeDebugPayload>`) — see the
 * module doc's note on `unknown` vs. createServerFn's serializability check.
 * `getRecipeDebug` below is the contract-typed function to call from outside
 * this module; this one exists so `getRecipeDebugPayload`'s handler can reach
 * the real, narrower, serializable-safe return type.
 *
 * `found: false` covers both a genuinely absent `recipe` row and a real
 * recipe that is not boxed in `householdId` — a "foreign id" per
 * `devtools/types.ts`'s doc. Both collapse to the same result so this panel
 * can never be used to probe whether an id exists in a household the caller
 * cannot see into.
 */
async function computeRecipeDebug(db: Kysely<DB>, householdId: string, recipeId: string) {
  const notFound = () => ({
    recipeId,
    found: false as const,
    summary: null,
    atprotoRecord: null,
    counterparts: [] as CounterpartView[],
    llmEnrichment: null,
    rendered: [],
    privateLayers: [],
    warnings: [] as string[],
  });

  const recipe = await db.selectFrom("recipe").selectAll().where("id", "=", recipeId).executeTakeFirst();
  if (!recipe) return notFound();

  // The box check (recipe-enrichment.ts's gate, relocated — see module doc).
  if (!(await isRecipeBoxed(db, householdId, recipeId))) return notFound();

  const warnings: string[] = [];

  const summary = {
    name: recipe.name,
    origin: recipe.origin,
    visibility: recipe.visibility,
    did: recipe.did,
    rkey: recipe.rkey,
    cid: recipe.cid,
    rev: recipe.rev,
    publishedAt: iso(recipe.published_at),
  };

  // --- (a) the raw atproto record --------------------------------------
  // Deliberately not annotated `AtprotoRecordView | null` — see the module
  // doc's note on `unknown`. `record: Json` (db/types.ts) is a real,
  // recursively-serializable type, and that is what must flow through here.
  let atprotoRecord: { uri: string; cid: string; rev: string; validationStatus: string; indexedAt: string | null; deletedAt: string | null; record: Json } | null = null;
  if (recipe.did && recipe.rkey) {
    const raw = await db.selectFrom("atproto_collection_recipe").selectAll().where("did", "=", recipe.did).where("rkey", "=", recipe.rkey).executeTakeFirst();
    if (raw) {
      atprotoRecord = {
        uri: raw.uri,
        cid: raw.cid,
        rev: raw.rev,
        validationStatus: raw.validation_status,
        indexedAt: iso(raw.indexed_at),
        deletedAt: iso(raw.deleted_at),
        record: raw.record,
      };
    } else {
      warnings.push("recipe has did/rkey but no matching atproto_collection_recipe row — deleted from the index, or never swept.");
    }
  }

  // --- rendered: recipe + children (mostly published: true) -----------
  const [ingredients, instructions, images, keywords, attribution] = await Promise.all([
    db
      .selectFrom("recipe_ingredient")
      .selectAll()
      .where("recipe_id", "=", recipeId)
      .orderBy("ordinal")
      .limit(MAX_SECTION_ROWS + 1)
      .execute(),
    db
      .selectFrom("recipe_instruction")
      .selectAll()
      .where("recipe_id", "=", recipeId)
      .orderBy("ordinal")
      .limit(MAX_SECTION_ROWS + 1)
      .execute(),
    db
      .selectFrom("recipe_image")
      .selectAll()
      .where("recipe_id", "=", recipeId)
      .orderBy("ordinal")
      .limit(MAX_SECTION_ROWS + 1)
      .execute(),
    db
      .selectFrom("recipe_keyword")
      .selectAll()
      .where("recipe_id", "=", recipeId)
      .orderBy("keyword")
      .limit(MAX_SECTION_ROWS + 1)
      .execute(),
    db.selectFrom("recipe_attribution").selectAll().where("recipe_id", "=", recipeId).executeTakeFirst(),
  ]);

  // Not annotated `DebugSection[]` — see the module doc's note on `unknown`.
  const rendered = [
    {
      table: "recipe",
      note: "The canonical rendered recipe row — the app's normalized projection of the record content (or, for a still-private local draft, what publish will turn into record content).",
      published: true,
      rows: [recipe],
    },
    { table: "recipe_ingredient", note: "Ordered ingredient lines, rendered from record.ingredients.", published: true, rows: cap(ingredients, "recipe_ingredient", warnings) },
    {
      table: "recipe_instruction",
      note: "Ordered instruction steps, rendered from record.instructions.",
      published: true,
      rows: cap(instructions, "recipe_instruction", warnings),
    },
    {
      table: "recipe_image",
      note: "Embedded image blob refs — only populated once the recipe is actually published to a PDS; a private draft's hero lives in recipe_pending_image instead.",
      published: true,
      rows: cap(images, "recipe_image", warnings),
    },
    { table: "recipe_keyword", note: "Open-vocabulary tags, rendered from record.keywords.", published: true, rows: cap(keywords, "recipe_keyword", warnings) },
    { table: "recipe_attribution", note: "The flattened attribution union, rendered from record.attribution.", published: true, rows: attribution ? [attribution] : [] },
  ];

  // --- (b) counterparts --------------------------------------------------
  const dedupeRows = await db.selectFrom("recipe_meta").select(["key", "value"]).where("recipe_id", "=", recipeId).where("ns", "=", "dedupe").execute();
  const dedupe = {
    contentFp: (dedupeRows.find((r) => r.key === "content_fp")?.value as string | undefined) ?? null,
    sourceUrlKey: (dedupeRows.find((r) => r.key === "source_url_key")?.value as string | undefined) ?? null,
  };
  const counterparts = await loadCounterparts(db, recipeId, householdId, dedupe, warnings);

  // --- (c) private layers --------------------------------------------------
  const [enrichment, enrichmentLabels, recipeMeta, householdRecipeMeta, householdRecipe, householdRecipeNote, collectionEntries, mealPlanEntries, pendingImage] = await Promise.all(
    [
      db.selectFrom("recipe_enrichment").selectAll().where("recipe_id", "=", recipeId).executeTakeFirst(),
      db
        .selectFrom("recipe_enrichment_label")
        .selectAll()
        .where("recipe_id", "=", recipeId)
        .orderBy("dimension")
        .orderBy("slug")
        .limit(MAX_SECTION_ROWS + 1)
        .execute(),
      db
        .selectFrom("recipe_meta")
        .selectAll()
        .where("recipe_id", "=", recipeId)
        .orderBy("ns")
        .orderBy("key")
        .limit(MAX_SECTION_ROWS + 1)
        .execute(),
      db
        .selectFrom("household_recipe_meta")
        .selectAll()
        .where("recipe_id", "=", recipeId)
        .where("household_id", "=", householdId)
        .orderBy("ns")
        .orderBy("key")
        .limit(MAX_SECTION_ROWS + 1)
        .execute(),
      db.selectFrom("household_recipe").selectAll().where("recipe_id", "=", recipeId).where("household_id", "=", householdId).executeTakeFirst(),
      db
        .selectFrom("household_recipe_note")
        .selectAll()
        .where("recipe_id", "=", recipeId)
        .where("household_id", "=", householdId)
        .orderBy("created_at")
        .limit(MAX_SECTION_ROWS + 1)
        .execute(),
      db
        .selectFrom("recipe_collection_entry as rce")
        .innerJoin("recipe_collection as rc", "rc.id", "rce.collection_id")
        .selectAll("rce")
        .select(["rc.name as collection_name"])
        .where("rce.recipe_id", "=", recipeId)
        .where("rce.household_id", "=", householdId)
        .orderBy("rce.position")
        .limit(MAX_SECTION_ROWS + 1)
        .execute(),
      db
        .selectFrom("meal_plan_entry")
        .selectAll()
        .where("recipe_id", "=", recipeId)
        .where("household_id", "=", householdId)
        .orderBy("plan_date", "desc")
        .limit(MAX_SECTION_ROWS + 1)
        .execute(),
      db.selectFrom("recipe_pending_image").selectAll().where("recipe_id", "=", recipeId).executeTakeFirst(),
    ],
  );

  // --- import provenance (only when the recipe actually came from one) --
  // Computed BEFORE `privateLayers` below so both conditional sections fold
  // into that single array literal via spreads, rather than `.push()`ing onto
  // an already-inferred array type — see the module doc's note on `unknown`
  // for why the array's inferred (unannotated) type matters here.
  const sessionIds = [...new Set(householdRecipeMeta.filter((r) => r.ns === "import" && r.key === "session_id").map((r) => r.value as string))];
  const importSessions = sessionIds.length ? await db.selectFrom("recipe_import_session").selectAll().where("id", "in", sessionIds).execute() : null;

  // `recipe_import_attempt` has no FK to `recipe` at all (single-URL scrape
  // logs the attempt before a recipe exists — see recipe-scrape.ts). Best
  // effort only: match on the household that boxed this recipe and the URL
  // its attribution locked to, which is the only thing tying the two rows
  // together in practice.
  const attributionUrl = attribution?.url ?? null;
  const importAttempts = attributionUrl
    ? await db
        .selectFrom("recipe_import_attempt")
        .selectAll()
        .where("household_id", "=", householdId)
        .where("url", "=", attributionUrl)
        .orderBy("created_at", "desc")
        .limit(MAX_SECTION_ROWS + 1)
        .execute()
    : [];
  if (importAttempts.length) {
    warnings.push("recipe_import_attempt: matched by (household, source URL) — there is no direct foreign key to recipe, so this is a heuristic, not a guaranteed link.");
  }

  // Not annotated `DebugSection[]` — see the module doc's note on `unknown`.
  const privateLayers = [
    {
      table: "recipe_enrichment",
      note: "Pipeline status for the derived allergen/diet classifier run. `classifier_version` gates which slugs a missing recipe_enrichment_label row may be read as the default for (see that section's note) — never written back to `recipe.suitable_for_diet` or any `*_content` column, and never reaches a published record.",
      published: false,
      rows: enrichment ? [enrichment] : [],
    },
    {
      table: "recipe_enrichment_label",
      note: "Derived allergen/diet verdicts — SPARSE: a row exists only when it says something its dimension's default does not, so seeing fewer rows here than recipe_vocab has slugs is expected, not a broken classifier. Absence IS a verdict: for allergen it means not_detected, for diet it means not excluded — but only for slugs this recipe's classifier_version actually evaluated. `not_detected`, whether stored or implied by absence, is NOT a safety claim — it means the rules found nothing over free text they may not have fully parsed, never 'free of'.",
      published: false,
      rows: cap(enrichmentLabels, "recipe_enrichment_label", warnings),
    },
    {
      table: "recipe_meta",
      note: "Buttery-only key/value sidecar about the recipe itself, namespaced by `ns` — the dedupe keys (`ns='dedupe'`, keys `content_fp`/`source_url_key`) live here. Never reaches a published record.",
      published: false,
      rows: cap(recipeMeta, "recipe_meta", warnings),
    },
    {
      table: "household_recipe_meta",
      note: "Buttery-only key/value sidecar about this (household, recipe) pair — import provenance (`ns='import'`) and anything else stashed per household. Scoped to your active household; never reaches a published record.",
      published: false,
      rows: cap(householdRecipeMeta, "household_recipe_meta", warnings),
    },
    {
      table: "household_recipe",
      note: "Your household's box entry for this recipe — favorite state and who added it. Scoped to your active household.",
      published: false,
      rows: householdRecipe ? [householdRecipe] : [],
    },
    {
      table: "household_recipe_note",
      note: "Free-text notes your household attached to this recipe. Scoped to your active household.",
      published: false,
      rows: cap(householdRecipeNote, "household_recipe_note", warnings),
    },
    {
      table: "recipe_collection_entry",
      note: "Which of your household's collections file this recipe, and in what order — collection name joined in as `collection_name`.",
      published: false,
      rows: cap(collectionEntries, "recipe_collection_entry", warnings),
    },
    {
      table: "meal_plan_entry",
      note: "Meal-plan slots in your household that reference this recipe, including soft-deleted ones (`deleted_at`).",
      published: false,
      rows: cap(mealPlanEntries, "meal_plan_entry", warnings),
    },
    {
      table: "recipe_pending_image",
      note: "An uploaded or imported hero image waiting to be published — bytes in the blob store (or a source URL), not yet on a PDS.",
      published: false,
      rows: pendingImage ? [pendingImage] : [],
    },
    ...(importSessions
      ? [
          {
            table: "recipe_import_session",
            note: "The batch-import session that brought this recipe in, found via household_recipe_meta (ns='import', key='session_id').",
            published: false,
            rows: importSessions,
          },
        ]
      : []),
    ...(importAttempts.length
      ? [
          {
            table: "recipe_import_attempt",
            note: "Scrape attempts (success or failure) whose source URL matches this recipe's attribution — best-effort, not a guaranteed link (see warnings).",
            published: false,
            rows: cap(importAttempts, "recipe_import_attempt", warnings),
          },
        ]
      : []),
  ];

  // --- (d) the LLM enrichment highlight ------------------------------------
  //
  // A typed VIEW of the SAME `enrichment` / `enrichmentLabels` rows already
  // fetched above for the generic `recipe_enrichment` / `recipe_enrichment_label`
  // privateLayers sections — no second query. See devtools/types.ts's
  // `LlmEnrichmentSummary` doc for why this exists as a deliberate exception
  // to "SECTIONS ARE GENERIC ON PURPOSE" (this file's own module doc).
  //
  // Not annotated `LlmEnrichmentSummary | null` — see the module doc's note
  // on `unknown` vs createServerFn's serializability check; every field below
  // is a plain string/number/boolean, so the annotation would add nothing
  // besides opting back into the exact inference this file avoids elsewhere.
  let llmEnrichment = null;
  if (enrichment) {
    // `@buttery/food/classify` is SERVER-ONLY (its own module doc) — dynamic
    // import, same rule as `pg`/`bullmq` elsewhere in this app, so it never
    // reaches the client bundle via this file's `getRecipeDebugPayload`
    // re-export chain (`lib/api/transport.ts`).
    const { CLASSIFIER_VERSION } = await import("@buttery/food/classify");

    // `method`'s `llm:` prefix is the schema's actual ownership rule
    // (db/types.ts's `recipe_enrichment_label.method` comment) — restated
    // here rather than imported from services/pipeline, same "web does not
    // depend on the pipeline's internals" reasoning as recipe-enrichment.ts's
    // module doc.
    const LLM_METHOD_PREFIX = "llm:";
    const labelsByDimension: Record<
      string,
      { dimension: string; slug: string; verdict: string; confidence: number; source: "rules" | "llm"; method: string; updatedAt: string }[]
    > = {};
    for (const label of enrichmentLabels) {
      const bucket = labelsByDimension[label.dimension] ?? (labelsByDimension[label.dimension] = []);
      bucket.push({
        dimension: label.dimension,
        slug: label.slug,
        verdict: label.verdict,
        confidence: toNum(label.confidence),
        source: label.method.startsWith(LLM_METHOD_PREFIX) ? "llm" : "rules",
        method: label.method,
        // `updated_at` is a non-null generated timestamp column; `iso()`
        // only ever returns null for an unparseable Date, which a DB-written
        // timestamp never is — the `?? ""` is a type-level fallback, not one
        // this code path can actually reach.
        updatedAt: iso(label.updated_at) ?? "",
      });
    }

    llmEnrichment = {
      status: enrichment.llm_status,
      enrichedAt: iso(enrichment.llm_enriched_at),
      error: enrichment.llm_error,
      model: enrichment.llm_model,
      promptVersion: enrichment.llm_prompt_version,
      llmVersion: enrichment.llm_version,
      classifierVersion: enrichment.classifier_version,
      rulesStatus: enrichment.status,
      rulesVersionCurrent: enrichment.classifier_version === CLASSIFIER_VERSION,
      inputHash: enrichment.input_hash,
      llmInputHash: enrichment.llm_input_hash,
      freshAgainstRules: enrichment.llm_status === "ok" && enrichment.llm_input_hash !== null && enrichment.llm_input_hash === enrichment.input_hash,
      labelsByDimension,
    };
  }

  return { recipeId, found: true as const, summary, atprotoRecord, counterparts, llmEnrichment, rendered, privateLayers, warnings };
}

/**
 * The contract-typed entry point: `computeRecipeDebug` widened to
 * `RecipeDebugPayload`, a safe, ordinary upcast (every field
 * `computeRecipeDebug` actually returns is a subtype of its
 * `RecipeDebugPayload` counterpart). This is the function to call from
 * outside this module — `recipe-debug.db.test.ts` included.
 */
export async function getRecipeDebug(db: Kysely<DB>, householdId: string, recipeId: string): Promise<RecipeDebugPayload> {
  return computeRecipeDebug(db, householdId, recipeId);
}

// --- the server fn wrapper ---------------------------------------------------

/**
 * The panel's server fn. Named `getRecipeDebugPayload` (not `getRecipeDebug`)
 * only to avoid colliding with the plain function above — this is the export
 * `#/lib/api/transport.ts` wraps, and it re-exposes the friendlier
 * `getRecipeDebug` name to callers there.
 *
 * Calls `computeRecipeDebug` directly, NOT `getRecipeDebug` — the handler
 * must receive the narrower, unwidened return type for createServerFn's
 * serializability check to pass (see the module doc's note on `unknown`).
 *
 * Authorized through the existing `recipe-context.ts` / `authz.ts` path, the
 * same membership chokepoint every other household-scoped read uses, so this
 * cannot leak another household's recipe. `householdId` is never a client
 * argument; it comes from `activeContext()`'s server-validated session,
 * exactly like every sibling module. The box check is inside
 * `computeRecipeDebug` itself — see that function's doc for why.
 */
export const getRecipeDebugPayload = createServerFn({ method: "GET" })
  .validator((data: unknown) => recipeIdInput.parse(data))
  .handler(async ({ data }) => {
    // THE REAL GATE. `import.meta.env.DEV` only decides whether the client
    // ships the panel; this is what decides whether the server will run the
    // query at all, checked against the process actually serving the request.
    // A production deploy refuses here no matter what a caller sends.
    if (process.env.NODE_ENV === "production") {
      throw new Error("The recipe debug panel is not available in production.");
    }

    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");

    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);

    return computeRecipeDebug(getDb(), householdId, data.recipeId);
  });

// --- the LLM enrichment trigger -----------------------------------------

/**
 * The devtools panel's "run LLM enrichment now" server fn (`LlmEnrichButton.tsx`,
 * via `lib/api/transport.ts`'s `triggerLlmEnrich`). Same double gate as
 * `getRecipeDebugPayload` above (`import.meta.env.DEV` client-side, this
 * `NODE_ENV` check as the real server-side one), same authorization
 * (`activeContext()` + `assertMember`), and the same box check
 * (`isRecipeBoxed`) `computeRecipeDebug` uses — a caller must not be able to
 * enqueue a job for a recipe id they cannot even read through this panel.
 *
 * `POST`, unlike the `GET` read above: this call has a side effect (it
 * enqueues a BullMQ job), which is the whole reason it exists.
 *
 * Returns `LlmEnrichTriggerResult` (`devtools/types.ts`) — `enqueueLlmEnrich`'s
 * `LlmEnrichEnqueueOutcome` widened to that structurally-identical, panel-
 * owned type, mirroring how `getRecipeDebugPayload` widens its own return
 * value to `RecipeDebugPayload`. No `unknown` is involved here (every field
 * is a plain string), so unlike `computeRecipeDebug` this handler can be
 * annotated directly without tripping createServerFn's serializability check.
 */
export const triggerLlmEnrichPayload = createServerFn({ method: "POST" })
  .validator((data: unknown) => recipeIdInput.parse(data))
  .handler(async ({ data }): Promise<LlmEnrichTriggerResult> => {
    // THE REAL GATE — see getRecipeDebugPayload's identical comment above.
    if (process.env.NODE_ENV === "production") {
      throw new Error("The recipe debug panel is not available in production.");
    }

    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { enqueueLlmEnrich } = await import("./enrichment-queue");

    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);

    const db = getDb();
    if (!(await isRecipeBoxed(db, householdId, data.recipeId))) {
      // Same "found: false" collapse as the read side (computeRecipeDebug's
      // doc): a caller must not be able to tell "no such recipe" apart from
      // "a real recipe in a household you can't see" by whether this action
      // behaves differently from the read above.
      return { status: "error", message: "no such recipe in your active household" };
    }

    return enqueueLlmEnrich(data.recipeId);
  });
