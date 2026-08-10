import type { ExtractedRecipe } from "@buttery/recipe-schemas/bridge";

/**
 * Re-exported so a consumer of `@buttery/recipe-extract/import` needs exactly one
 * import to type an `ImportCandidate` — the same courtesy `src/types.ts` does for
 * the scrape path.
 */
export type { ExtractedRecipe };

/** Everything crossing a worker boundary or landing in `jsonb` is JSON, and the type
 *  says so. `Record<string, unknown>` admits functions, `bigint`, and cycles, which
 *  fail `postMessage` structured cloning or `JSON.stringify` *before* the boundary
 *  check in §7.2 can turn them into a clean per-item failure. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

/** A file plus the path it was found at. The path is supplied by the caller, because
 *  only one of the two acquisition paths puts it on the `File`.
 *
 *  `<input type="file" webkitdirectory>` populates `File.webkitRelativePath`; directory
 *  **drag** traversal does not — `FileSystemFileEntry.file()` hands back a `File` whose
 *  `webkitRelativePath` is `""`, and the only path that exists is the one the traversal
 *  accumulated (or `FileSystemEntry.fullPath`). Reducing both inputs to `File[]` silently
 *  discards every drag path, which is the primary interaction the design draws (§4.2, D40). */
export interface DroppedFile {
  path: string;
  file: File;
}

/** The generic drop payload the route hands to `RecipeImporter.open()`.
 *
 *  Not spelled out in the plan; it is an object rather than a bare `DroppedFile[]` so a
 *  future importer that arrives over something other than a folder drop (an archive, an
 *  OAuth token, a single file) can add a variant here without changing `open()`'s arity
 *  and breaking every importer at once. The route owns the adaptation from
 *  `DataTransfer` / `<input type="file">` into this shape (§4.2). */
export interface ImporterDropInput {
  files: DroppedFile[];
}

/** A bag of lazily-readable relative paths — what any folder- or archive-shaped importer
 *  needs. Generic on purpose: root detection and entry filtering are the importer's job
 *  (`index.html` and `Recipes/` are Paprika facts), the size and path-escape guardrails
 *  are properties of "a pile of files a user handed us" and live here (§4.2). */
export interface EntrySource {
  /** Every entry path, relative to whatever the user handed us, in no guaranteed order. */
  paths(): readonly string[];
  /** Decoded UTF-8 text for one path. */
  text(path: string): Promise<string>;
  /** Raw bytes for one path — used for review thumbnails only (§11). */
  bytes(path: string): Promise<Uint8Array>;
  /** Total byte size across all entries, for the guardrails in `entry-source.ts`. */
  totalBytes(): number;
}

/** One recipe's worth of bytes, handed to `RecipeImporter.parse`. */
export interface ImportEntry {
  /** Root-relative, human-facing: `"Beef Bourguignon 2.html"`. Goes in the sidecar. */
  entryName: string;
  /** Source-relative, machine-facing: what `EntrySource` was keyed by. Sibling assets
   *  (images) resolve against this, never against `entryName` (§4.1 note 4). */
  sourcePath: string;
  html: string;
}

/** What every importer produces. The pipeline consumes only this. */
export interface ImportCandidate {
  /** Discriminant. See `isParseFailure` for why this is an explicit tag and not a
   *  duck-typed check on `recipe` / `message`. */
  readonly kind: "candidate";
  /** Importer-minted (`crypto.randomUUID()`), stable for the session; joins probe→commit. */
  clientId: string;
  /** Lexicon-shaped, the same type every other extractor produces. */
  recipe: ExtractedRecipe;
  sourceUrl: string | null;
  /** Free text when `sourceUrl` is null — drives the §8 attribution grouping. */
  sourceText: string | null;
  /** → `household_recipe_note` (§12.2). */
  notes: string | null;
  /** Personal tags → keywords (§12.3). Already split by the importer. */
  tags: string[];
  /** Remote image URL — what the commit path stores (§11). */
  imageUrl: string | null;
  /** **Source-relative** path — directly passable to `EntrySource.bytes()` with no
   *  further joining, for review thumbnails only (§4.2, §11). Resolving it is the
   *  importer's job, not the caller's. */
  localImagePath: string | null;
  /** Human-facing provenance; what the failure list shows (§7.2, §10.1). */
  entryName: string;
  /** Opaque to the pipeline. The importer owns the keys; written verbatim to the
   *  sidecar under `ns='import'` (§12.5). Must not use a pipeline-reserved key
   *  (§12.5) — the boundary rejects the item if it does. */
  meta: JsonObject;
}

export interface ImportParseFailure {
  /** Discriminant. See `isParseFailure`. */
  readonly kind: "failure";
  clientId: string;
  entryName: string;
  message: string;
}

/** A link the drop screen renders beside the export instructions. */
export interface ImporterDropLink {
  label: string;
  href: string;
}

/**
 * The drop screen's importer-specific copy (§9, §10.2 D19).
 *
 * The *field set* is generic — every importer's launch point has to say what to drop, why
 * it is safe, and how to produce it from the source app — while every *value* is a fact
 * about one export format ("Paprika writes a folder, not a single file"). Keeping the copy
 * on the importer is what lets `/household/recipes/import` render a launch screen without
 * ever naming an importer, which is the §2.5 boundary the ESLint rule enforces.
 *
 * Copy is plain text, not markup: the route owns typography and emphasis, and a string
 * carrying `<strong>` would have to be dangerously-set to render.
 */
export interface ImporterDropCopy {
  /** Page heading — "Import from Paprika". */
  title: string;
  /** Lede under the heading. `{household}` is substituted by the route with the
   *  household's display name; it is a token rather than a slot so the sentence stays
   *  translatable and the importer stays ignorant of household types. */
  lede: string;
  /** Dropzone headline. */
  heading: string;
  /** Dropzone sub-line: what "the folder" actually contains, so the user recognizes it. */
  body: string;
  /** Dropzone button label. */
  cta: string;
  /** "How do I get this file in the first place?" — the card beneath the dropzone. */
  help: {
    title: string;
    /** Ordered steps, rendered as an `<ol>`. */
    steps: readonly string[];
    /** Vendor documentation, per platform. */
    links: readonly ImporterDropLink[];
  };
}

/** The entire importer-specific surface. Phase 1 ships exactly one implementation. */
export interface RecipeImporter {
  /** Stable, lowercase, no spaces. Stored on the session (§5.3) and in the sidecar (§12.5). */
  readonly id: string;
  /** Product name for UI copy — "Paprika 3". The only place the brand is a string. */
  readonly label: string;
  /** What the launch screen renders (§9). Generic field, importer-specific value. */
  readonly dropCopy: ImporterDropCopy;
  /** Launch point: turn whatever the browser handed us into an entry source. */
  open(input: ImporterDropInput): Promise<EntrySource>;
  /** Lazily yield one entry per recipe. Drives the "Reading your recipe box…" progress. */
  entries(source: EntrySource): AsyncIterable<ImportEntry>;
  /** Pure, synchronous, worker-safe. */
  parse(entry: ImportEntry): ImportCandidate | ImportParseFailure;
}

/**
 * Discriminate a parse result. The pipeline splits `parse()` output into candidates and
 * a failure list (§7.2, §10.1) and needs a cheap, total check.
 *
 * **Deliberate deviation from §2.5:** the plan's two interfaces carry no tag, so the
 * only guard available would be duck-typing on `"recipe" in v` or `"message" in v`.
 * That is fragile exactly where it matters — parse results cross a worker boundary via
 * `postMessage`, so what the pipeline receives is a structured clone, and any later
 * field addition (a `message` on a candidate, a partial `recipe` on a failure) silently
 * flips the guard for every caller at once with no type error. An explicit
 * `kind: "candidate" | "failure"` is a plain string that survives cloning unchanged,
 * costs one field, and makes the union exhaustive for TypeScript rather than inferred.
 */
export function isParseFailure(v: ImportCandidate | ImportParseFailure): v is ImportParseFailure {
  return v.kind === "failure";
}
