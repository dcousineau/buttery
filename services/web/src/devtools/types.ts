/**
 * The wire shape of the Buttery devtools panel: everything known about one
 * recipe, in as raw a form as is still readable.
 *
 * Written by the coordinator rather than by either half, because the server
 * helper (`server/recipe-debug.ts`) and the panel (`devtools/RecipeInspector`)
 * are built against it independently and neither should have to import the
 * other to find out what it looks like.
 *
 * ── SECTIONS ARE GENERIC ON PURPOSE ──────────────────────────────────────────
 * A section is `{ table, note, published, rows }` and the panel renders it
 * without knowing what table it is. That is the whole design: this schema grows
 * a private sidecar every other month, and a typed-per-table panel would need a
 * UI change for each one. With a generic section, adding `recipe_whatever` to
 * the inspector is one server-side query and nothing else.
 *
 * ── EVERYTHING HERE IS DEV-ONLY ──────────────────────────────────────────────
 * This payload deliberately carries another household's-worth of private data
 * about one recipe: box membership, notes, import provenance, dedupe keys,
 * derived allergen verdicts. It is gated twice — `import.meta.env.DEV` decides
 * whether the panel ships at all, and the server fn re-checks
 * `process.env.NODE_ENV` before it reads anything — and it is authorized like
 * every other recipe read, through the session's active household.
 */

/**
 * One table's worth of rows, rendered generically.
 *
 * `rows` is `unknown[]` rather than a typed row: the point of this panel is to
 * show what is actually in the column, including the shapes nobody modelled.
 */
export interface DebugSection {
  /** The Postgres table these rows came from. Shown as the section heading. */
  table: string;
  /** One line: what this table is for, in the panel's own words. */
  note: string;
  /**
   * Whether anything in these rows reaches an `exchange.recipe.recipe` record.
   * `false` means Buttery-internal and never published — the sidecars, the
   * enrichment tables, box membership. The panel says so on the section, so a
   * reader never has to guess which half of the split they are looking at.
   */
  published: boolean;
  rows: unknown[];
}

/** The atproto record as the network holds it — plan (a). */
export interface AtprotoRecordView {
  uri: string;
  cid: string;
  rev: string;
  /** `valid` | `invalid` | whatever the sweep wrote. */
  validationStatus: string;
  indexedAt: string | null;
  /** Non-null once a sweep found the record gone from its repo. */
  deletedAt: string | null;
  /** The raw jsonb, untouched. This is the point of the panel. */
  record: unknown;
}

/**
 * A different `recipe` row that is the same dish — plan (b).
 *
 * Found through the dedupe sidecar (`recipe_meta` ns `dedupe`, keys
 * `content_fp` and `source_url_key`), which is the only thing in the schema
 * that relates two rows by content rather than by id. `matchedOn` says which
 * key tied them together, because a `content_fp` match and a `source_url_key`
 * match mean different things: identical ingredients versus the same source
 * page.
 */
export interface CounterpartView {
  recipeId: string;
  name: string;
  origin: string;
  visibility: string;
  did: string | null;
  matchedOn: "content_fp" | "source_url_key";
  /** True when this row is in the caller's household box, not just the index. */
  inBox: boolean;
}

/** What the panel asks for, and the only input it takes. */
export interface RecipeDebugInput {
  recipeId: string;
}

/**
 * One `recipe_enrichment_label` row lifted into the LLM highlight, tagged
 * with which provider actually wrote it.
 *
 * `source` is derived from `method`'s `llm:` prefix — the schema's own
 * ownership rule (`db/types.ts`'s `recipe_enrichment_label.method` comment,
 * and the pipeline's `writeEnrichment`/`writeLlmEnrichment`, which
 * delete-and-replace by exactly this prefix), not a guess from `dimension`
 * or anything else. `method` is kept in full alongside `source`
 * (`rules@2` or `llm:moonshot:kimi-k2-0905-preview@v1`) because the tail
 * after the prefix is itself information: which classifier version, or
 * which model, actually produced this row.
 */
export interface LlmHighlightLabel {
  dimension: string;
  slug: string;
  verdict: string;
  confidence: number;
  source: "rules" | "llm";
  method: string;
  updatedAt: string;
}

/**
 * The typed exception to "SECTIONS ARE GENERIC ON PURPOSE" (see the file doc
 * above) — lifted out of the raw `recipe_enrichment` / `recipe_enrichment_label`
 * rows (still shown in full, unedited, in `privateLayers` alongside every
 * other table; this is a second VIEW of those same rows, not a second
 * source of truth) because the LLM half of this schema carries invariants a
 * generic `DebugSection` would either drop or force the panel to
 * reimplement per table: a null `promptVersion` is a real state, not
 * "unknown"; a missing slug in `labelsByDimension` means different things
 * for different dimensions depending on `status`/`llmVersion`; there is no
 * web-visible "current" to compare `llmVersion` against (see that field's
 * doc). This summary answers those questions once, here, so the panel does
 * not have to re-derive them from raw rows.
 */
export interface LlmEnrichmentSummary {
  /**
   * `recipe_enrichment.llm_status` verbatim: `null` (never attempted — the
   * llm-backfill claim signal) | `'ok'` | `'error'` | `'skipped'`. See
   * `db/types.ts`'s column comment for the full state machine.
   */
  status: string | null;
  enrichedAt: string | null;
  /**
   * Set only when `status === 'error'`. A message, never a stack — see
   * `recipe_enrichment.error`'s own comment for the repo-wide reason
   * (§3.1: an error nobody can see is a failure nobody can see).
   */
  error: string | null;
  /** `'<provider>:<model>'` that wrote the current `llm:` labels, e.g. `'moonshot:kimi-k2-0905-preview'`. `null` until a run has completed at least once. */
  model: string | null;
  /**
   * The PostHog prompt version actually used. **`null` does NOT mean
   * "unknown" — it means the committed fallback prompt
   * (`services/pipeline/…/lib/prompt.ts`) ran instead of a PostHog-served
   * one**, a real, queryable state worth labelling as such, not an absence
   * to apologize for.
   */
  promptVersion: number | null;
  /** `recipe_enrichment.llm_version` verbatim. `0` is the column's own default — "never run", not a real version number. */
  llmVersion: number;
  /** `recipe_enrichment.classifier_version` — the RULES pass's version, shown alongside because `llm-enrich` refuses to even call a model unless this is current (see `rulesVersionCurrent`). */
  classifierVersion: number;
  /** `recipe_enrichment.status` — the rules pass's own status. `llm-enrich` requires exactly `'ok'` here before it will run at all. */
  rulesStatus: string;
  /**
   * Whether `classifierVersion` matches the rules classifier this build of
   * web was compiled against (`CLASSIFIER_VERSION`, `@buttery/food/classify`
   * — the one package both this app and the pipeline import, so a mismatch
   * here is a real version drift, not two disagreeing sources of truth).
   * `false` is a real predictor that triggering LLM enrichment right now
   * will come back `skipped`, not `ok`.
   *
   * There is deliberately no equivalent "is `llmVersion` current" check:
   * `LLM_ENRICHMENT_VERSION` lives only inside `services/pipeline`
   * (`queues/recipe-enrichment/lib/schema.ts`), not in a package web is
   * allowed to depend on (`server/recipe-enrichment.ts`'s module doc: "Web
   * does not depend on services/pipeline"). `freshAgainstRules` below is the
   * closest honest signal this panel can give instead.
   */
  rulesVersionCurrent: boolean;
  inputHash: string | null;
  llmInputHash: string | null;
  /**
   * `status === 'ok' && llmInputHash !== null && llmInputHash === inputHash`
   * — the LLM's last opinion is about the SAME ingredient content the rules
   * pass most recently saw. This is the freshness signal the panel leads
   * with, in place of the version comparison `rulesVersionCurrent`'s doc
   * explains it cannot make for `llmVersion`.
   */
  freshAgainstRules: boolean;
  /**
   * Every `recipe_enrichment_label` row for this recipe, grouped by
   * `dimension`, each tagged with `source`. A dimension key with fewer
   * entries than expected, or absent entirely, is NOT a negative verdict —
   * see the panel's own caveat copy (`RecipeDebugSections.tsx`) for what an
   * absence means per dimension kind, which this type deliberately does not
   * encode: doing so accurately would mean duplicating
   * `EMITTED_DIET_SLUGS`/`LLM_ONLY_DIET_SLUGS`, pipeline-internal lists this
   * app is not allowed to depend on (same reasoning as `rulesVersionCurrent`
   * above).
   */
  labelsByDimension: Record<string, LlmHighlightLabel[]>;
}

/**
 * What `triggerLlmEnrich` (the panel's "run it now" button,
 * `LlmEnrichButton.tsx`) hands back. Deliberately its own type, structurally
 * mirroring `server/enrichment-queue.ts`'s `LlmEnrichEnqueueOutcome` rather
 * than importing it — same independence this file's doc states for the read
 * side: the panel and the queue module should be free to change their own
 * internals without a cross-import forcing them to agree mid-refactor.
 */
export type LlmEnrichTriggerResult =
  | { status: "disabled" }
  | { status: "already-running"; jobId: string; state: string }
  | { status: "enqueued"; jobId: string }
  | { status: "error"; message: string };

export interface RecipeDebugPayload {
  recipeId: string;
  /** False when the id resolves to no `recipe` row — a deleted or foreign id. */
  found: boolean;
  /** The headline facts, lifted out so the panel can render a header without parsing a section. */
  summary: {
    name: string;
    origin: string;
    visibility: string;
    did: string | null;
    rkey: string | null;
    cid: string | null;
    rev: string | null;
    publishedAt: string | null;
  } | null;
  /** (a) — null for a recipe that was never published. */
  atprotoRecord: AtprotoRecordView | null;
  /** (b) — empty when nothing else in the index is the same dish. */
  counterparts: CounterpartView[];
  /**
   * (d) — the LLM enrichment highlight. `null` only when this recipe has no
   * `recipe_enrichment` row at all (nothing, rules or LLM, has ever
   * classified it) — once a row exists, this is populated even when
   * `status` is `null` (LLM never attempted), so the panel can say that
   * explicitly instead of omitting the block. See `LlmEnrichmentSummary`'s
   * doc for the full shape and why it exists as a typed exception to
   * "SECTIONS ARE GENERIC ON PURPOSE" above.
   */
  llmEnrichment: LlmEnrichmentSummary | null;
  /** The rendered layer: `recipe` and its children. Published, mostly. */
  rendered: DebugSection[];
  /** (c) — every private layer Buttery keeps and never publishes. */
  privateLayers: DebugSection[];
  /**
   * Anything the reader should not take at face value: a section that was
   * truncated, a table that errored, a counterpart outside their household
   * whose contents were withheld. Empty is the normal case.
   */
  warnings: string[];
}
