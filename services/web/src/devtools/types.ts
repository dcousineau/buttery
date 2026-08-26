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
