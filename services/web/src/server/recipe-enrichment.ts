import { createServerFn } from "@tanstack/react-start";
import type { Kysely } from "kysely";
import * as z from "zod";
import type { DB, JsonValue } from "#/db/types";

/**
 * Read surface for the recipe-enrichment pipeline (recipe-enrichment plan §10).
 * Server-only, and deliberately thin: `getRecipeEnrichment` is a `select` over
 * `recipe_enrichment` plus its labels, grouped by dimension, and nothing else.
 *
 * ── NEVER WRITTEN BACK (D1) ────────────────────────────────────────────────
 * Everything here is READ-ONLY. The enrichment pipeline's derived facts are
 * never written to `recipe.suitable_for_diet`, `recipe.calories` or any
 * `*_content` column — those are what the author declared, and a derived
 * verdict never overwrites a declaration. When the two disagree, both stand;
 * this module just shows them side by side. This module writes nothing at
 * all — the pipeline (`services/pipeline`) is the only writer of
 * `recipe_enrichment` / `recipe_enrichment_label`.
 *
 * ── NEVER PUBLISHED ────────────────────────────────────────────────────────
 * Same rule `recipe-meta.ts` states: nothing read here is ever written into an
 * `exchange.recipe.recipe` record or published to a PDS. Derived facts are
 * Buttery-internal.
 *
 * ── `not_detected` IS NOT A SAFETY CLAIM (§3.2) ────────────────────────────
 * An `allergen` label's `not_detected` verdict means the rules found nothing,
 * over free text they may not have fully parsed — NOT that the dish is free of
 * that allergen. No caller of this module, including the dev panel it feeds,
 * may render `not_detected` as "free of", "safe" or anything else a reader
 * could act on.
 *
 * ── THE DEV GATE IS DOUBLE, AND THE SERVER SIDE IS THE REAL ONE (D16) ──────
 * The panel renders on the client only when `import.meta.env.DEV`, but that is
 * a build-time flag baked into the client bundle — a production bundle simply
 * never ships the panel's code, and nothing stops a caller from POSTing at
 * `getRecipeEnrichmentDebug` directly regardless of what shipped. So
 * `getRecipeEnrichmentDebug` below re-checks `process.env.NODE_ENV` on the
 * SERVER, which is the process actually deciding whether to run the query, and
 * refuses outright in production. Bypassing the client gate reaches nothing.
 */

/** Recipe-id validator, mirroring the sibling server modules: non-empty, capped. */
const recipeIdInput = z.object({ recipeId: z.string().min(1).max(512) });

/** One `recipe_enrichment_label` row, as the panel wants to read it. */
export interface RecipeEnrichmentLabelView {
  dimension: string;
  slug: string;
  verdict: string;
  confidence: number;
  method: string;
  /** Which lines and food slugs fired, and which rule (§8.3). Shape is per-classifier. */
  evidence: JsonValue | null;
  updatedAt: string;
}

/** `recipe_enrichment` plus its labels, grouped by dimension (`diet` / `allergen`). */
export interface RecipeEnrichmentView {
  recipeId: string;
  status: string;
  classifierVersion: number;
  inputHash: string | null;
  enrichedAt: string | null;
  /** A message, not a stack (§3.1) — safe to render as-is. */
  error: string | null;
  labels: Record<string, RecipeEnrichmentLabelView[]>;
}

/** `numeric` comes back from `pg` as a string. Mirrors `grocery.ts` / `household-recipes.ts`. */
function toNum(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The `recipe_enrichment` row plus its labels, grouped by dimension.
 *
 * `null` when nothing has run for this recipe yet — no writer has ever marked
 * it `stale`, so there is no row at all. That is a real, distinct state from
 * `status: "error"` (a job ran and failed) and from `status: "stale"` (a write
 * landed and the worker hasn't caught up), and callers should tell them apart.
 *
 * Plain exported function taking `db` first, per the `grocery.ts` pattern, so
 * `recipe-enrichment.db.test.ts` can reach it without faking a session.
 */
export async function getRecipeEnrichment(db: Kysely<DB>, recipeId: string): Promise<RecipeEnrichmentView | null> {
  const row = await db.selectFrom("recipe_enrichment").selectAll().where("recipe_id", "=", recipeId).executeTakeFirst();
  if (!row) return null;

  const labelRows = await db.selectFrom("recipe_enrichment_label").selectAll().where("recipe_id", "=", recipeId).orderBy("dimension").orderBy("slug").execute();

  const labels: Record<string, RecipeEnrichmentLabelView[]> = {};
  for (const label of labelRows) {
    const bucket = labels[label.dimension] ?? (labels[label.dimension] = []);
    bucket.push({
      dimension: label.dimension,
      slug: label.slug,
      verdict: label.verdict,
      confidence: toNum(label.confidence),
      method: label.method,
      evidence: label.evidence ?? null,
      updatedAt: new Date(label.updated_at).toISOString(),
    });
  }

  return {
    recipeId: row.recipe_id,
    status: row.status,
    classifierVersion: row.classifier_version,
    inputHash: row.input_hash,
    enrichedAt: row.enriched_at ? new Date(row.enriched_at).toISOString() : null,
    error: row.error,
    labels,
  };
}

/**
 * The panel's server fn. Authorized through the existing
 * `recipe-context.ts` / `authz.ts` path — the same membership chokepoint every
 * other household-scoped read uses — so this cannot leak another household's
 * recipe. `householdId` is never a client argument; it comes from
 * `activeContext()`'s server-validated session, exactly like every sibling
 * module.
 *
 * `null` covers two cases a client-side dev panel does not need to tell apart:
 * the recipe is not in this household's box (same as `getHouseholdRecipe`'s
 * authorization gate), or it is boxed but nothing has enriched it yet.
 */
export const getRecipeEnrichmentDebug = createServerFn({ method: "GET" })
  .validator((data: unknown) => recipeIdInput.parse(data))
  .handler(async ({ data }): Promise<RecipeEnrichmentView | null> => {
    // THE REAL GATE (D16). `import.meta.env.DEV` only decides whether the
    // client ships the panel; this is what decides whether the server will run
    // the query at all, checked against the process actually serving the
    // request. A production deploy refuses here no matter what a caller sends.
    if (process.env.NODE_ENV === "production") {
      throw new Error("The enrichment debug panel is not available in production.");
    }

    const { getDb } = await import("#/lib/db");
    const { assertMember } = await import("./authz");
    const { activeContext } = await import("./recipe-context");
    const { householdScopedQuery } = await import("./household/scoped-query");

    const { did, householdId } = await activeContext();
    await assertMember(did, householdId);
    const db = getDb();

    // Same authorization `getHouseholdRecipe` uses: the recipe must be boxed in
    // THIS household. Without this a live member could read another
    // household's private recipe's diagnostics by guessing its id.
    const boxed = await householdScopedQuery(db, did, householdId)
      .innerJoin("household_recipe as hr", "hr.household_id", "hm.household_id")
      .where("hr.recipe_id", "=", data.recipeId)
      .select("hr.recipe_id")
      .executeTakeFirst();
    if (!boxed) return null;

    return getRecipeEnrichment(db, data.recipeId);
  });
