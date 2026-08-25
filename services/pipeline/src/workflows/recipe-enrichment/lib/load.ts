import type { Pool } from "pg";
import { categorizeWith, loadLexicon } from "@buttery/food/categorize";
import { parseIngredientLine } from "@buttery/food/parse";
import { loadTraits, traitsFor } from "@buttery/food/traits";
import type { ClassifierLine, Label } from "#/workflows/recipe-enrichment/types.ts";

/**
 * Everything `enrich` and `backfill` need from Postgres and from `@buttery/food`
 * — deliberately **not** `classify.ts`. The one thing every function here needs
 * from that module is `CLASSIFIER_VERSION`, and every function below takes it
 * as a parameter instead of importing the constant, on purpose: `classify.ts`
 * is being written in parallel by another agent and did not exist for part of
 * this file's own development. Keeping this module classify-free means its own
 * `*.db.test.ts` runs against the real thing today, rather than either
 * stubbing `classify.ts` (which the task forbids) or blocking on it landing
 * first. `steps.ts` is the one place that imports `classify.ts` and threads
 * `CLASSIFIER_VERSION` through.
 *
 * Named `load.ts` per the plan's suggested layout, though it has grown to
 * cover writes too — `enrich`'s one transaction and `backfill`'s claim query
 * live here rather than in `steps.ts` for the same test-independence reason:
 * a `*.db.test.ts` importing `steps.ts` would drag `classify.ts` in with it.
 */

// --- reading a recipe --------------------------------------------------

export interface IngredientRow {
  ordinal: number;
  text: string;
}

export interface LoadedRecipe {
  name: string;
  lines: readonly IngredientRow[];
}

/**
 * Load one recipe's name and its ordered ingredient lines. `null` when the
 * recipe no longer exists — the caller's job, not this function's: a deleted
 * recipe is not a failure, jobs outlive rows (plan §7.1 step 1).
 */
export async function loadRecipe(pool: Pool, recipeId: string): Promise<LoadedRecipe | null> {
  const recipeRes = await pool.query<{ name: string }>(`select name from recipe where id = $1`, [recipeId]);
  const recipe = recipeRes.rows[0];
  if (!recipe) return null;

  const linesRes = await pool.query<IngredientRow>(`select ordinal, text from recipe_ingredient where recipe_id = $1 order by ordinal`, [recipeId]);
  return { name: recipe.name, lines: linesRes.rows };
}

// --- parse + match: recipe_ingredient rows -> ClassifierLine[] ---------

/**
 * Parse every line and match it against the food lexicon, carrying the
 * original `ordinal` through untouched — that is what lets a label's evidence
 * cite "line 7" and have it mean something (plan §8.3).
 *
 * A group header ("For the sauce:") is dropped rather than turned into a
 * `ClassifierLine`: it names no food, so there is nothing for a classifier to
 * match against it, and letting it through as an unresolved miss would only
 * dilute the "how many lines resolved" signal `allergen.ts`'s `unknown`
 * threshold depends on (plan §8.1).
 */
export async function buildClassifierLines(lines: readonly IngredientRow[]): Promise<ClassifierLine[]> {
  const [lexicon, traits] = await Promise.all([loadLexicon(), loadTraits()]);

  const out: ClassifierLine[] = [];
  for (const line of lines) {
    const parsed = parseIngredientLine(line.text);
    if (parsed.isGroupHeader) continue;

    const match = categorizeWith(lexicon, parsed.name);
    // traitsFor returns `{}` for a slug the traits file has never heard of, or
    // when nothing matched at all — collapse that to `null` here so a
    // classifier can tell "resolved, no traits" from "never resolved" without
    // checking `Object.keys` itself on every line (ClassifierLine's own doc).
    const foodTraits = match.foodSlug ? traitsFor(traits, match.foodSlug) : {};

    out.push({
      ordinal: line.ordinal,
      text: line.text,
      name: parsed.name,
      quantity: parsed.quantity,
      unit: parsed.unit,
      foodSlug: match.foodSlug,
      via: match.via,
      traits: Object.keys(foodTraits).length > 0 ? foodTraits : null,
    });
  }
  return out;
}

// --- short-circuit state -------------------------------------------------

export interface EnrichmentState {
  status: string;
  classifierVersion: number;
  inputHash: string | null;
}

/** The current `recipe_enrichment` row, or `null` when this recipe has never been classified. */
export async function getEnrichmentState(pool: Pool, recipeId: string): Promise<EnrichmentState | null> {
  const res = await pool.query<{ status: string; classifier_version: number; input_hash: string | null }>(
    `select status, classifier_version, input_hash from recipe_enrichment where recipe_id = $1`,
    [recipeId],
  );
  const row = res.rows[0];
  return row ? { status: row.status, classifierVersion: row.classifier_version, inputHash: row.input_hash } : null;
}

// --- the write transaction (plan §7.1 step 5) -----------------------------

/**
 * Replace this recipe's labels wholesale and mark it `ok`, in one transaction:
 * delete every existing `recipe_enrichment_label` row, insert the fresh set,
 * upsert `recipe_enrichment`. Wholesale delete-then-insert rather than a diff
 * is deliberate — a verdict a classifier no longer emits (a rule that used to
 * fire and stopped) must not survive as a stale row nobody is looking at
 * anymore, the same reasoning `render.ts`'s dedupe-key replace uses.
 *
 * Throws on failure and writes nothing — `steps.ts`'s `enrich` step is what
 * catches that and records `status='error'`, deliberately OUTSIDE this
 * transaction (plan §7.1 step 5, the `atproto_sync_run` lesson: a failure
 * that writes nothing is a failure nobody can see).
 *
 * The one way this is expected to throw that is not "the database is down":
 * a classifier emitting a `(dimension, slug)` `recipe_vocab` has never seen.
 * `recipe_enrichment_label`'s FK to `recipe_vocab` makes that a foreign-key
 * violation (23503) that rolls the whole transaction back rather than landing
 * a half-written label set — "should be impossible" (classifiers only emit
 * seeded slugs), but a `describeWriteError` call away from being legible
 * instead of an opaque Postgres message if it ever does happen.
 */
export async function writeEnrichment(pool: Pool, recipeId: string, inputHash: string, classifierVersion: number, labels: readonly Label[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`delete from recipe_enrichment_label where recipe_id = $1`, [recipeId]);

    if (labels.length > 0) {
      const COLS = 7;
      const values: unknown[] = [];
      const placeholders = labels.map((label, i) => {
        const base = i * COLS;
        values.push(recipeId, label.dimension, label.slug, label.verdict, label.confidence, label.method, JSON.stringify(label.evidence));
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
      });
      await client.query(`insert into recipe_enrichment_label (recipe_id, dimension, slug, verdict, confidence, method, evidence) values ${placeholders.join(", ")}`, values);
    }

    await client.query(
      `insert into recipe_enrichment (recipe_id, status, classifier_version, input_hash, enriched_at, error)
       values ($1, 'ok', $2, $3, now(), null)
       on conflict (recipe_id) do update
         set status = 'ok', classifier_version = excluded.classifier_version, input_hash = excluded.input_hash, enriched_at = excluded.enriched_at, error = null`,
      [recipeId, classifierVersion, inputHash],
    );

    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Record a classification failure. Deliberately touches only `status` and
 * `error` — `classifier_version` and `input_hash` are left exactly as they
 * were (matching how `render.ts` marks a recipe `stale` without clobbering
 * them), so a fix that makes the next attempt succeed still has something
 * correct to compare the new fingerprint against.
 */
export async function markError(pool: Pool, recipeId: string, message: string): Promise<void> {
  await pool.query(
    `insert into recipe_enrichment (recipe_id, status, error) values ($1, 'error', $2)
     on conflict (recipe_id) do update set status = 'error', error = excluded.error`,
    [recipeId, message],
  );
}

/**
 * Turn a thrown error into a message worth putting in `recipe_enrichment.error`
 * (plan §3.1: "the message, not a stack"). The one case worth naming
 * specially is `writeEnrichment`'s FK violation (23503, see its doc) — `pg`
 * already carries the offending `(dimension, slug)` pair in `.detail`, this
 * just makes sure that detail survives into the one place anyone will look.
 */
export function describeWriteError(err: unknown): string {
  if (err instanceof Error) {
    const pgErr = err as Error & { code?: string; detail?: string; constraint?: string };
    if (pgErr.code === "23503") {
      return `label referenced an unseeded recipe_vocab slug (constraint ${pgErr.constraint ?? "unknown"}): ${pgErr.detail ?? pgErr.message}`;
    }
    return err.message;
  }
  return String(err);
}

// --- backfill claim (plan §7.2) -------------------------------------------

export const DEFAULT_BACKFILL_LIMIT = 500;
export const MAX_BACKFILL_LIMIT = 5000;

/**
 * The default claim: recipes with no `recipe_enrichment` row at all, unioned
 * with rows the table itself says are out of date. The second arm is driven
 * from `recipe_enrichment`, not `recipe` — that is what lets Postgres reach
 * for the `recipe_enrichment (status, classifier_version)` index to find the
 * out-of-date rows directly, instead of a nested-loop probe of that table
 * once per `recipe` row the way a single `recipe LEFT JOIN recipe_enrichment`
 * would.
 *
 * The ORDER BY is D-somebody's-own-recipes-first spelled out as SQL: local
 * first, then anything already in a household's box, then the long tail — a
 * run that gets cut short by its own `limit` has already spent its budget on
 * the recipes that matter most (plan §7.2).
 *
 * No `FOR UPDATE SKIP LOCKED`: two concurrent backfills claiming the same row
 * is harmless rather than a race worth guarding against — `enrichJobId`
 * (`@buttery/pipeline-contract`) makes the resulting `enrich` jobs collapse to
 * one via BullMQ's deterministic-id dedupe (plan D14), so a duplicate claim
 * costs nothing but a redundant `queue.add` that no-ops.
 */
const BACKFILL_CLAIM_SQL = `
with candidates as (
  select r.id, r.origin
  from recipe r
  where not exists (select 1 from recipe_enrichment e where e.recipe_id = r.id)

  union all

  select r.id, r.origin
  from recipe_enrichment e
  join recipe r on r.id = e.recipe_id
  where e.status <> 'ok' or e.classifier_version < $1
)
select id, count(*) over () as total
from candidates
where $2::boolean = false or origin = 'local'
order by
  (origin = 'local') desc,
  exists (select 1 from household_recipe hr where hr.recipe_id = candidates.id) desc,
  id
limit $3
`;

/**
 * `force`'s claim: every recipe (subject to `localOnly`), ignoring
 * `recipe_enrichment` entirely — `BackfillPayload.force`'s "re-classify even
 * when the fingerprint and classifier version already match" only means
 * something if the claim itself can select rows the default query's
 * staleness predicate would exclude. A deliberate, rare, full-corpus op (an
 * operator asking to reprocess without a `CLASSIFIER_VERSION` bump), so it
 * scans `recipe` directly rather than trying to stay index-guided the way the
 * default claim does.
 */
const BACKFILL_FORCE_SQL = `
select r.id, r.origin, count(*) over () as total
from recipe r
where $1::boolean = false or r.origin = 'local'
order by
  (r.origin = 'local') desc,
  exists (select 1 from household_recipe hr where hr.recipe_id = r.id) desc,
  r.id
limit $2
`;

export interface ClaimOptions {
  /** `classify.ts`'s `CLASSIFIER_VERSION`, threaded in by `steps.ts` — see the module doc. */
  classifierVersion: number;
  limit?: number;
  force?: boolean;
  localOnly?: boolean;
}

export interface ClaimResult {
  ids: string[];
  /** Candidates left after this batch, so a second POST is informed rather than a guess (plan §7.2). */
  remaining: number;
}

/** Claim a bounded batch. `limit` defaults to 500 and is hard-capped at 5000 regardless of what is asked for. */
export async function claimBatch(pool: Pool, opts: ClaimOptions): Promise<ClaimResult> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_BACKFILL_LIMIT)), MAX_BACKFILL_LIMIT);
  const localOnly = opts.localOnly === true;

  const res = opts.force
    ? await pool.query<{ id: string; total: string }>(BACKFILL_FORCE_SQL, [localOnly, limit])
    : await pool.query<{ id: string; total: string }>(BACKFILL_CLAIM_SQL, [opts.classifierVersion, localOnly, limit]);

  const ids = res.rows.map((row) => row.id);
  // `count(*) over ()` is computed over every row the WHERE matched, before
  // LIMIT clips the result set — exactly "how many candidates exist", not
  // "how many this page returned".
  const total = res.rows.length > 0 ? Number(res.rows[0].total) : 0;
  return { ids, remaining: Math.max(0, total - ids.length) };
}
