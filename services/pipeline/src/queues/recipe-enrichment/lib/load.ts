import type { Pool } from "pg";
import { categorizeWith, loadLexicon } from "@buttery/food/categorize";
import { parseIngredientLine } from "@buttery/food/parse";
import { loadTraits, traitsFor } from "@buttery/food/traits";
import { contentFingerprint } from "@buttery/recipe-schemas/normalize";
import type { ClassifierLine, Label } from "@buttery/food/classify";

/**
 * Everything `enrich`/`llm-enrich` need from Postgres and `@buttery/food` —
 * deliberately not `@buttery/food/classify` or `@buttery/food/llm`. `CLASSIFIER_VERSION` and
 * `LLM_ENRICHMENT_VERSION` come in as parameters rather than imports, so this
 * module stays free of `zod` and its own `*.db.test.ts` has no dependency on
 * either. `index.ts` is the one place that imports both and threads them
 * through.
 */

/**
 * The `method` prefix every LLM-written label carries — `llm:<provider>:<model>@vN`
 * (`@buttery/food/llm`'s `llmMethod()`). Restated here rather than imported, for
 * the same classify/schema-free reason as above — keep the two in sync by
 * hand if the prefix ever changes.
 */
const LLM_METHOD_PREFIX = "llm:";
const LLM_METHOD_LIKE_PATTERN = `${LLM_METHOD_PREFIX}%`;

// --- reading a recipe --------------------------------------------------

export interface IngredientRow {
  ordinal: number;
  text: string;
}

export interface LoadedRecipe {
  name: string;
  /**
   * `'local'` (somebody's own) or `'sync'` (pulled from the network). Read here
   * rather than separately in `index.ts` because it is one more column on a
   * query that was already happening, and because it decides something
   * load-bearing: the LLM capture layer sends a generation's input and output
   * CONTENT to PostHog only for `sync` recipes (llm plan L10). Public network
   * content may be inspected in a trace; a person's own recipe may not.
   */
  origin: string;
  lines: readonly IngredientRow[];
}

/**
 * Load one recipe's name and its ordered ingredient lines. `null` when the
 * recipe no longer exists — the caller's job, not this function's: a deleted
 * recipe is not a failure, jobs outlive rows (plan §7.1 step 1).
 */
export async function loadRecipe(pool: Pool, recipeId: string): Promise<LoadedRecipe | null> {
  const recipeRes = await pool.query<{ name: string; origin: string }>(`select name, origin from recipe where id = $1`, [recipeId]);
  const recipe = recipeRes.rows[0];
  if (!recipe) return null;

  const linesRes = await pool.query<IngredientRow>(`select ordinal, text from recipe_ingredient where recipe_id = $1 order by ordinal`, [recipeId]);
  return { name: recipe.name, origin: recipe.origin, lines: linesRes.rows };
}

/** Content fingerprint for a loaded recipe — order-independent, so re-ordering ingredients never trips a reclassify on its own. */
export function fingerprintRecipe(recipe: Pick<LoadedRecipe, "name" | "lines">): Promise<string> {
  return contentFingerprint(
    recipe.name,
    recipe.lines.map((line) => line.text),
  );
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

/**
 * Both halves of one `recipe_enrichment` row that `llm-enrich` needs before it
 * may even think about calling a model (llm plan §9.2 steps 3–4):
 *
 *   - `status`/`inputHash` — the RULES pass's own state. `llm-enrich` requires
 *     `status === 'ok'` and `inputHash` to match the current content
 *     fingerprint before it runs at all: the rules pass runs first, always,
 *     and an LLM judging content the rules haven't finished classifying (or
 *     classified against stale content) has nothing current to be a second
 *     opinion ABOUT. A `false` here means "mark `skipped`, the next `enrich`
 *     re-enqueues us" — not an error.
 *   - `llmStatus`/`llmVersion`/`llmInputHash` — the LLM pass's own short-circuit
 *     state (plan §3.1), read the same way `getEnrichmentState` reads the
 *     rules half.
 *
 * One query, not two `getEnrichmentState`-shaped round trips, on purpose: both
 * checks read the same row, and `llm-enrich` needs both answers before it can
 * decide anything (plan §9.2 steps 3 and 4 back to back).
 */
export interface LlmEnrichmentState {
  /** The rules pass's own `status` — must be `'ok'` before `llm-enrich` may run. */
  status: string;
  /** The rules pass's own `input_hash` — must match the current fingerprint before `llm-enrich` may run. */
  inputHash: string | null;
  /**
   * The rules pass's own `classifier_version`. `llm-enrich` requires it to equal
   * the deployed `CLASSIFIER_VERSION` before it runs, because that step
   * RE-DERIVES the rules labels rather than reading them back out of the table
   * — and re-deriving under a different classifier than the one that wrote the
   * rows would leave the merge reasoning about labels that are not there.
   */
  classifierVersion: number;
  /** `null` | `'ok'` | `'error'` | `'skipped'` — see the migration's column comment. */
  llmStatus: string | null;
  llmVersion: number;
  llmInputHash: string | null;
  /** `provider:model` of the run that wrote the current labels, e.g. `openrouter:mistralai/mistral-small-24b-instruct-2501`. `null` on a row no LLM run has completed. */
  llmModel: string | null;
  /** The PostHog prompt version that ran, or `null` when the code fallback text did. Both are inputs to {@link isLlmFresh}; see it for the asymmetry. */
  llmPromptVersion: number | null;
}

/** The current `recipe_enrichment` row's rules AND LLM state, or `null` when this recipe has never been classified at all. */
export async function getLlmEnrichmentState(pool: Pool, recipeId: string): Promise<LlmEnrichmentState | null> {
  const res = await pool.query<{
    status: string;
    input_hash: string | null;
    classifier_version: number;
    llm_status: string | null;
    llm_version: number;
    llm_input_hash: string | null;
    llm_model: string | null;
    llm_prompt_version: number | null;
  }>(`select status, input_hash, classifier_version, llm_status, llm_version, llm_input_hash, llm_model, llm_prompt_version from recipe_enrichment where recipe_id = $1`, [
    recipeId,
  ]);
  const row = res.rows[0];
  return row
    ? {
        status: row.status,
        inputHash: row.input_hash,
        classifierVersion: row.classifier_version,
        llmStatus: row.llm_status,
        llmVersion: row.llm_version,
        llmInputHash: row.llm_input_hash,
        llmModel: row.llm_model,
        llmPromptVersion: row.llm_prompt_version,
      }
    : null;
}

// --- freshness predicates ---------------------------------------------
//
// `classifierVersion`/`llmVersion` come in as parameters rather than imports
// of `@buttery/food/classify`'s `CLASSIFIER_VERSION` / `@buttery/food/llm`'s
// `LLM_ENRICHMENT_VERSION`, for the same reason the rest of this module does:
// see the module doc at the top of this file.

/** The rules pass already covers this content at this classifier version — `enrich` may short-circuit. */
export function isRulesFresh(state: EnrichmentState | null, inputHash: string, classifierVersion: number, force: boolean): boolean {
  return !force && state !== null && state.status === "ok" && state.classifierVersion === classifierVersion && state.inputHash === inputHash;
}

/** The recipe's ingredients changed since the last classification — not just a version bump. Decides whether a rules re-write also cascades away the LLM's rows. */
export function contentChanged(state: EnrichmentState | LlmEnrichmentState | null, inputHash: string): boolean {
  return state?.inputHash != null && state.inputHash !== inputHash;
}

/** The rules pass has finished, on this content, under the deployed classifier — `llm-enrich`'s precondition before it may reason about the rules labels at all. */
export function rulesPassCurrent(state: LlmEnrichmentState | null, inputHash: string, classifierVersion: number): state is LlmEnrichmentState {
  return state !== null && state.status === "ok" && state.inputHash === inputHash && state.classifierVersion === classifierVersion;
}

/** What is about to run, as far as the short-circuit is concerned: which model, and which prompt text. */
export interface LlmRunIdentity {
  /** `provider:model`, spelled exactly as `writeLlmEnrichment` stores it. */
  model: string;
  /** The PostHog prompt version that WOULD run, or `null` when the fetch degraded to the code fallback. */
  promptVersion: number | null;
}

/**
 * The LLM pass already covers this content, at this LLM version, from this
 * model and this prompt — `llm-enrich` may short-circuit.
 *
 * `llmVersion`/`inputHash` are the "is the question still the same?" half.
 * `run` is the "is the ANSWERER still the same?" half: a released prompt
 * version or a swapped model is a different second opinion, and a recipe
 * carrying the old one is stale even though nothing about the recipe changed.
 *
 * ── The two identity comparisons are deliberately NOT symmetric ────────────
 * The model is compared plainly: `llm_model` is always known for a row whose
 * `llm_status` is `'ok'` (`writeLlmEnrichment` writes both in one statement),
 * so a difference — including a `null` on some row that predates that
 * guarantee — is a real difference and re-running is the honest answer.
 *
 * The prompt version is compared ONLY when the current one is known. A `null`
 * current version means the PostHog fetch degraded to the code fallback (no
 * key, a timeout, PostHog down) — `prompt-fetch.ts` never throws, it
 * substitutes text. Treating that unknown as "differs from stored" would turn
 * every PostHog outage into a corpus-wide re-enrichment against the fallback
 * text, and then a SECOND one when PostHog came back and the versions were
 * knowable again. So an unknown current version cannot make a row stale; a
 * known one that differs from the stored version (`null` stored included —
 * that row was written by the fallback, and a real version supersedes it)
 * can.
 */
export function isLlmFresh(state: LlmEnrichmentState, inputHash: string, llmVersion: number, run: LlmRunIdentity, force: boolean): boolean {
  if (force) return false;
  if (state.llmStatus !== "ok" || state.llmVersion !== llmVersion || state.llmInputHash !== inputHash) return false;
  if (state.llmModel !== run.model) return false;
  if (run.promptVersion !== null && state.llmPromptVersion !== run.promptVersion) return false;
  return true;
}

// --- the write transaction -------------------------------------------------

/**
 * The one new option `writeEnrichment` gains for the LLM split (llm plan
 * §9.1). A dedicated options object rather than a bare trailing boolean —
 * `writeEnrichment(pool, id, hash, 2, labels, true)` reads as noise at the
 * call site; `{ contentChanged: true }` reads as what it is.
 */
export interface WriteEnrichmentOptions {
  /**
   * `true` when the step's freshly computed content fingerprint differs from
   * the previously stored `input_hash` — i.e. the recipe's ingredients
   * actually changed since the last classification, not just that a
   * classifier version bumped. Passed down rather than recomputed here: the
   * step already has both hashes in hand from its own short-circuit check
   * (plan §7.1 step 2 / §3.1), so recomputing would mean a second read of
   * `recipe_enrichment` this function has no other reason to do.
   */
  contentChanged: boolean;
}

/**
 * Replace this recipe's labels and mark it `ok`, in one transaction: delete
 * the existing `recipe_enrichment_label` rows THIS classifier owns, insert
 * the fresh set, upsert `recipe_enrichment`. Delete-then-insert rather than a
 * diff is deliberate — a verdict a classifier no longer emits (a rule that
 * used to fire and stopped) must not survive as a stale row nobody is looking
 * at anymore, the same reasoning `render.ts`'s dedupe-key replace uses.
 *
 * ── METHOD-SCOPED DELETE (llm plan §9.1, L9) — the one behavioral change ──
 *
 * The delete used to be unconditional: every row for this recipe, rules or
 * not, because there was only one provider. Now there are two providers
 * writing into the same table under disjoint `method` prefixes (`rules@N` and
 * `llm:<provider>:<model>@vN`, see `types.ts`'s "TWO VERSION COLUMNS" note),
 * and a rules re-run must not delete the other provider's work:
 *
 *   - `contentChanged: false` (the common case — a `CLASSIFIER_VERSION` bump,
 *     a `force` reclassify, or just noticing this recipe is stale) deletes
 *     only `method not like 'llm:%'` — the rules' own rows. The LLM's rows
 *     for this recipe are untouched; they still describe the same ingredients.
 *   - `contentChanged: true` deletes EVERYTHING, LLM rows included. LLM labels
 *     were derived by reading THIS recipe's ingredient lines; once those lines
 *     have actually changed, every LLM verdict is evidence about food that no
 *     longer exists in the recipe and is worse than having no opinion at all.
 *     `enrich` re-enqueues `llm-enrich` for every successful write (plan §9.2
 *     "`enrich` change"), so the LLM rebuilds its half unconditionally — the
 *     rules pass never has to know or care that it just orphaned it.
 *
 * ── ON CONFLICT: a rules insert can now collide with an LLM-owned row ──────
 *
 * Sparing `llm:%` rows on delete has a consequence for the INSERT half too:
 * this recipe's LLM rows can include one for a slug this classifier is ALSO
 * about to write (llm plan §8 — the LLM writes `allergen/fish` when it
 * resolves a rules `unknown`, replacing that row and taking over its
 * `(recipe_id, dimension, slug)` primary key). If the rules classifier later
 * re-runs on unchanged content — a version bump backfill, most likely — and
 * independently computes a verdict for that same slug, a plain `insert` hits
 * that same primary key and the whole transaction dies on a real 23505 unique
 * violation, not the "should be impossible" 23503 case `describeWriteError`
 * exists for.
 *
 * `on conflict (recipe_id, dimension, slug) do update` fixes the crash, and is
 * accepted as correct rather than merely tolerated: it only fires when the
 * rules classifier re-computes a value for a slug the LLM currently owns, on
 * content that has not changed enough to trigger the full cascade above.
 * `enrich` always re-enqueues `llm-enrich` immediately after this write
 * succeeds (plan §9.2), so any rules row that just overwrote an LLM
 * resolution is corrected within one more job — a rules row is never left
 * silently masking an LLM verdict for good, only until the next `llm-enrich`
 * lands.
 *
 * Throws on failure and writes nothing — `index.ts`'s `enrich` step is what
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
export async function writeEnrichment(
  pool: Pool,
  recipeId: string,
  inputHash: string,
  classifierVersion: number,
  labels: readonly Label[],
  opts: WriteEnrichmentOptions,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (opts.contentChanged) {
      await client.query(`delete from recipe_enrichment_label where recipe_id = $1`, [recipeId]);
    } else {
      await client.query(`delete from recipe_enrichment_label where recipe_id = $1 and method not like $2`, [recipeId, LLM_METHOD_LIKE_PATTERN]);
    }

    if (labels.length > 0) {
      const COLS = 7;
      const values: unknown[] = [];
      const placeholders = labels.map((label, i) => {
        const base = i * COLS;
        values.push(recipeId, label.dimension, label.slug, label.verdict, label.confidence, label.method, JSON.stringify(label.evidence));
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
      });
      // ON CONFLICT: see the doc comment above — an LLM-owned row can occupy
      // this same (recipe_id, dimension, slug) key when content is unchanged.
      await client.query(
        `insert into recipe_enrichment_label (recipe_id, dimension, slug, verdict, confidence, method, evidence)
         values ${placeholders.join(", ")}
         on conflict (recipe_id, dimension, slug) do update
           set verdict = excluded.verdict, confidence = excluded.confidence, method = excluded.method, evidence = excluded.evidence, updated_at = now()`,
        values,
      );
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
 * The LLM analogue of `writeEnrichment` (llm plan §9.1): one transaction that
 * replaces only this recipe's `llm:%`-owned labels, inserts the merge's
 * `writes` (llm plan §8), and marks the `llm_*` columns `ok`.
 *
 * Never touches `status`/`classifier_version`/`input_hash`/`enriched_at`/
 * `error` — those are the rules pass's columns, and `llm-enrich` runs strictly
 * after a successful rules write (plan §9.2 step 3 requires `status = 'ok'`
 * before this is ever reached), so a `recipe_enrichment` row always already
 * exists here. This is therefore a plain `update … where recipe_id = $1`, not
 * an upsert — and, unlike `writeEnrichment`'s upsert, a zero-row update is
 * treated as a bug, not a no-op: it means the precondition this function
 * depends on did not hold (the row vanished between the step's check and this
 * write), and writing labels while silently failing to record that they were
 * written would leave `llm_status` claiming "never attempted" for a recipe
 * that now has `llm:` rows — exactly the mismatch the short-circuit (plan
 * §3.1) depends on never happening.
 *
 * ── ON CONFLICT: replacing a rules row IN PLACE (llm plan §8, THE subtle part) ──
 *
 * The delete only clears `method like 'llm:%'` rows — it must not touch the
 * rules' own rows, that is the entire point of the split. But llm plan §8's
 * merge table has a case where the LLM's write is supposed to REPLACE a rules
 * row rather than sit beside it: "allergen, rules `unknown` (rules couldn't
 * read the line), LLM says contains ⇒ write LLM row, replacing the rules
 * `unknown` row." That rules row is still sitting on the
 * `(recipe_id, dimension, slug)` primary key this insert wants — deleting only
 * `llm:%` rows does not remove it, so a plain `insert` would hit that key and
 * fail with a real 23505 unique violation. `on conflict (recipe_id, dimension,
 * slug) do update` is what makes "replacing the rules row" true in SQL: the
 * LLM's verdict, confidence, method and evidence overwrite the rules row in
 * place, and the `method` column — now `llm:<provider>:<model>@vN` instead of
 * `rules@N` — is the durable record that the LLM now owns that slug. This is
 * the ONE place an LLM write is allowed to overwrite a rules row rather than
 * only add beside it, and it is deliberate: it is how the merge's
 * "resolves unknown" rows (llm plan §8) actually land.
 *
 * (The mirror-image collision — a later rules re-run finding an LLM-owned row
 * on a slug it wants to write — is `writeEnrichment`'s problem, handled there
 * with the same `on conflict` treatment; see that function's doc comment.)
 */
export interface LlmEnrichmentMeta {
  /** `@buttery/food/llm`'s `LLM_ENRICHMENT_VERSION` at the time this run happened. */
  llmVersion: number;
  /** Same content fingerprint as `input_hash` (D10) — the LLM classifies the same content the rules did. */
  llmInputHash: string;
  /** `'<provider>:<model>'` — which registry entry actually ran (plan §6.1), e.g. `'openrouter:mistralai/mistral-small-24b-instruct-2501'`. */
  llmModel: string;
  /** The PostHog prompt version actually used, or `null` when the code fallback ran (plan §6.2). */
  llmPromptVersion: number | null;
}

export async function writeLlmEnrichment(pool: Pool, recipeId: string, meta: LlmEnrichmentMeta, labels: readonly Label[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`delete from recipe_enrichment_label where recipe_id = $1 and method like $2`, [recipeId, LLM_METHOD_LIKE_PATTERN]);

    if (labels.length > 0) {
      const COLS = 7;
      const values: unknown[] = [];
      const placeholders = labels.map((label, i) => {
        const base = i * COLS;
        values.push(recipeId, label.dimension, label.slug, label.verdict, label.confidence, label.method, JSON.stringify(label.evidence));
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
      });
      // ON CONFLICT: see the doc comment above — this is the deliberate
      // "replace the rules row" case (llm plan §8's resolves-unknown rows).
      await client.query(
        `insert into recipe_enrichment_label (recipe_id, dimension, slug, verdict, confidence, method, evidence)
         values ${placeholders.join(", ")}
         on conflict (recipe_id, dimension, slug) do update
           set verdict = excluded.verdict, confidence = excluded.confidence, method = excluded.method, evidence = excluded.evidence, updated_at = now()`,
        values,
      );
    }

    const updated = await client.query(
      `update recipe_enrichment
       set llm_status = 'ok', llm_version = $2, llm_input_hash = $3, llm_model = $4, llm_prompt_version = $5, llm_enriched_at = now(), llm_error = null
       where recipe_id = $1`,
      [recipeId, meta.llmVersion, meta.llmInputHash, meta.llmModel, meta.llmPromptVersion],
    );
    if (updated.rowCount === 0) {
      // See the doc comment above: this function assumes a recipe_enrichment
      // row already exists (the rules pass always runs first). If it does
      // not, fail loudly and roll back rather than silently writing labels
      // with no llm_status to show for them.
      throw new Error(`writeLlmEnrichment: no recipe_enrichment row for recipe ${recipeId} — rules pass must run first`);
    }

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
 * The LLM analogue of `markError`. Touches only `llm_status` and `llm_error` —
 * `llm_version` and `llm_input_hash` are left exactly as they were, same
 * reasoning as `markError`: a fix that makes the next attempt succeed still
 * has something correct to compare the new fingerprint/version against, and
 * an error must not be readable as "ran successfully against an empty
 * fingerprint".
 *
 * Upserts (works when no `recipe_enrichment` row exists yet at all), same as
 * `markError` — though in practice `llm-enrich` only reaches an actual model
 * error after plan §9.2 step 3's precondition (`status = 'ok'`) already
 * passed, which means a row already exists. Kept as an upsert anyway: cheap,
 * and it means this function never has to trust that precondition to hold.
 */
export async function markLlmError(pool: Pool, recipeId: string, message: string): Promise<void> {
  await pool.query(
    `insert into recipe_enrichment (recipe_id, llm_status, llm_error) values ($1, 'error', $2)
     on conflict (recipe_id) do update set llm_status = 'error', llm_error = excluded.llm_error`,
    [recipeId, message],
  );
}

/**
 * Records that `llm-enrich` ran but the gate said no (env override forced it
 * off, the PostHog flag was off/unreachable, or plan §9.2 step 3's rules
 * precondition failed) — plan §3.1: "recorded so a backfill doesn't re-claim
 * it every run while the flag is off". Sets `llm_status = 'skipped'` and
 * clears `llm_error` (a skip is not an error; leaving a stale error message
 * behind would misreport why the row is in this state).
 *
 * ── DELIBERATELY DOES NOT TOUCH `llm_version` ───────────────────────────────
 *
 * This is the one place among the four LLM write functions that does NOT
 * stamp `llm_version` to the version that "ran". Two readings were possible
 * here and only one makes the plan's own claim-query language true:
 *
 *   - Stamp the current `LLM_ENRICHMENT_VERSION` on skip. Then a `skipped` row
 *     reads as "the current version looked at this and declined" — but
 *     `claimLlmBatch`'s non-force arm reclaims on `llm_status is null OR
 *     llm_status = 'error' OR llm_version < llmVersion`. A skipped row stamped
 *     to the current version would satisfy NONE of those once the flag turns
 *     back on, so it would sit unclaimed forever without a `force` backfill —
 *     directly contradicting plan §3.1's "cheap to reset by claiming
 *     `llm_version < current` when the flag turns on".
 *   - Leave `llm_version` untouched (this function's choice). A recipe
 *     `llm-enrich` has never successfully finished for still carries whatever
 *     `llm_version` it had before — the column's own `default 0` for a
 *     brand-new row, per the migration. `0 < LLM_ENRICHMENT_VERSION` is true
 *     for any real version, so the very next non-force `claimLlmBatch` call
 *     after the flag flips on reclaims it automatically — no `force` needed.
 *     This is exactly the "cheap to reset" plan §3.1 promises, and it is only
 *     true because this function stays out of the way of the column that
 *     makes it true.
 *
 * (A recipe that had already reached `llm_status = 'ok'` at the current
 * version and is THEN skipped — e.g. the flag flaps off again — keeps that
 * `llm_version` untouched too, so it is not auto-reclaimed until a version
 * bump or an explicit `force`. That is consistent with the same sentence: the
 * claim query treats `skipped` as a candidate via the version check or
 * `force`, never unconditionally.)
 */
export async function markLlmSkipped(pool: Pool, recipeId: string): Promise<void> {
  await pool.query(
    `insert into recipe_enrichment (recipe_id, llm_status, llm_error) values ($1, 'skipped', null)
     on conflict (recipe_id) do update set llm_status = 'skipped', llm_error = null`,
    [recipeId],
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
 * `recipe_enrichment` entirely — the backfill script's `--force`'s "re-classify
 * even when the fingerprint and classifier version already match" only means
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
  /** `classify.ts`'s `CLASSIFIER_VERSION`, threaded in by `index.ts` — see the module doc. */
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

// --- llm-backfill claim (llm plan §9.2) -----------------------------------

/**
 * `llm-backfill`'s claim, driven entirely off `recipe_enrichment` — unlike
 * `BACKFILL_CLAIM_SQL`'s `UNION` of "no row at all" with "row is out of date",
 * there is no "no row at all" arm here, and there does not need to be: every
 * arm of this predicate is gated on `e.status = 'ok'` (see `claimLlmBatch`'s
 * doc comment for why), and a recipe with no `recipe_enrichment` row has no
 * `status` to be `'ok'` — an inner join on the table already excludes it, the
 * same as a `WHERE status = 'ok'` would. One query, one index
 * (`recipe_enrichment_status_llm_version_idx`, on exactly
 * `(status, llm_status, llm_version)`), no `UNION` needed.
 *
 * `force`'s meaning here differs from `claimBatch`'s: `BACKFILL_FORCE_SQL` is
 * a second, index-bypassing query because `force` there means "ignore
 * `recipe_enrichment` entirely, scan `recipe`". Here `force` still requires
 * `status = 'ok'` (there is nothing to give a second opinion on otherwise) and
 * only widens the `llm_status`/`llm_version` half of the predicate to
 * "anything, including `skipped` and already-`ok`-at-the-current-version" — a
 * single boolean bind (`$1`) does that without a second SQL string.
 */
const LLM_BACKFILL_CLAIM_SQL = `
select e.recipe_id as id, r.origin, count(*) over () as total
from recipe_enrichment e
join recipe r on r.id = e.recipe_id
where e.status = 'ok'
  and (
    $1::boolean = true
    or e.llm_status is null
    or e.llm_status = 'error'
    or e.llm_version < $2
  )
  and ($3::boolean = false or r.origin = 'local')
order by
  (r.origin = 'local') desc,
  exists (select 1 from household_recipe hr where hr.recipe_id = e.recipe_id) desc,
  e.recipe_id
limit $4
`;

export interface ClaimLlmOptions {
  /** `@buttery/food/llm`'s `LLM_ENRICHMENT_VERSION`, threaded in by `index.ts` — see the module doc. */
  llmVersion: number;
  limit?: number;
  /** Claim anything `status = 'ok'`, regardless of `llm_status`/`llm_version` — including `skipped` and already-current `ok` rows. */
  force?: boolean;
  localOnly?: boolean;
}

/**
 * Claim a bounded batch for `llm-enrich` (llm plan §9.2). Same shape as
 * `claimBatch` — `{ids, remaining}` via the same `count(*) over ()` trick,
 * same local-first `ORDER BY`, same `limit` default/cap
 * (`DEFAULT_BACKFILL_LIMIT`/`MAX_BACKFILL_LIMIT`, shared with the rules claim
 * — one backfill-sizing policy for both providers) — but only ever considers
 * recipes where the RULES pass already succeeded (`status = 'ok'`).
 *
 * That restriction is not an oversight, it is the whole relationship between
 * the two providers: the LLM is a SECOND OPINION (llm plan L1/L2). There is
 * nothing for it to be a second opinion ABOUT until the rules pass has
 * produced a first one — a recipe the rules classifier has never successfully
 * classified (`status` is `'stale'` or `'error'`, or the row does not exist
 * yet) is the rules backfill's problem, not this one's. Once the rules pass
 * succeeds, `enrich` enqueues `llm-enrich` for it directly (plan §9.2
 * "`enrich` change") — `llm-backfill` exists for the recipes that fell
 * through that path (a failed enqueue, a version bump, a flag that was off
 * and is now on), not as the primary way recipes reach the LLM.
 */
export async function claimLlmBatch(pool: Pool, opts: ClaimLlmOptions): Promise<ClaimResult> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_BACKFILL_LIMIT)), MAX_BACKFILL_LIMIT);
  const localOnly = opts.localOnly === true;
  const force = opts.force === true;

  const res = await pool.query<{ id: string; total: string }>(LLM_BACKFILL_CLAIM_SQL, [force, opts.llmVersion, localOnly, limit]);

  const ids = res.rows.map((row) => row.id);
  const total = res.rows.length > 0 ? Number(res.rows[0].total) : 0;
  return { ids, remaining: Math.max(0, total - ids.length) };
}
