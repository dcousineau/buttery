import type { DroppedFile, ImportCandidate, ImportParseFailure } from "@buttery/recipe-extract/import";

/**
 * The message contract between the route and the parse worker (plan §9, §4.2).
 *
 * Split out of `parse.worker.ts` deliberately: importing the worker module from the main
 * thread just to reach its types would pull the importer registry — and through it a
 * parser — into the page bundle, which is exactly the §2.5 boundary the worker exists to
 * keep. This file imports **types only**, so it costs nothing at runtime on either side.
 *
 * Everything here must survive structured cloning: plain objects, strings, numbers, and
 * `File` handles (which clone by reference and stay lazy — a 15 MB export costs no copy).
 */

/**
 * Start a parse run. The worker is single-shot per run; the route terminates and re-creates
 * it for a second drop, which is also how cancel works (§9: leaving the screen mid-parse).
 *
 * The importer is named by **id**, not passed as a value: functions do not survive
 * `postMessage`, and resolving the id inside the worker is what keeps `importers.ts` the
 * only module that names one (§2.5, §16.19).
 */
export interface ImportWorkerStart {
  type: "start";
  importerId: string;
  files: DroppedFile[];
}

export type ImportWorkerRequest = ImportWorkerStart;

/**
 * One candidate plus the two dedupe keys computed for it (§6.1, §9).
 *
 * Keys are computed in the worker, next to the parse, for two reasons: `contentFingerprint`
 * is async WebCrypto over 341 recipes and would otherwise land on the main thread mid-render,
 * and keeping the pair adjacent to the candidate makes it impossible for a later refactor to
 * ship a `clientId` to the probe with a fingerprint computed from a different recipe.
 */
export interface ParsedItem {
  candidate: ImportCandidate;
  /** `normalizeSourceUrl(candidate.sourceUrl)`, or null when there is no URL / it is unusable. */
  sourceUrlKey: string | null;
  /** `contentFingerprint(name, ingredients)` — `"sha256:…"`. Always present (§6.1). */
  contentFp: string;
}

export interface ParseResult {
  items: ParsedItem[];
  failures: ImportParseFailure[];
}

/**
 * Progress stages, in the order they occur.
 *
 * The walk comes first and is **indeterminate**: `RecipeImporter.entries()` is a lazy
 * `AsyncIterable`, so the total is not knowable until it is exhausted. The design's
 * "{n} of 341" counter is therefore the *parse* stage, which runs against a known total —
 * which is why the walk is drained into an array before parsing starts rather than parsed
 * as it yields. The cost is the retained entry HTML (~15 MB for the reference export, in
 * the worker's heap, freed the moment the run ends); the benefit is a determinate progress
 * bar for the phase that actually takes the time.
 */
export type ImportWorkerEvent =
  /** Walking the drop. `entries` is what has been found so far; there is no total yet. */
  | { type: "read"; entries: number }
  /** Parsing HTML → candidates. */
  | { type: "parse"; done: number; total: number }
  /** Computing `sourceUrlKey` + `contentFp`. */
  | { type: "keys"; done: number; total: number }
  | { type: "done"; result: ParseResult }
  /**
   * The run failed as a whole — a guardrail rejection, an unusable drop, an unknown
   * importer id. Per-entry parse failures are *not* errors; they ride in
   * `ParseResult.failures` and the import continues without them (§7.2, §10.1).
   */
  | { type: "error"; code: ImportWorkerErrorCode; message: string };

/**
 * Machine-readable failure reasons, so the drop screen picks its own copy per case instead
 * of string-matching a message (§10.2: "that folder is too big" reads nothing like "that
 * doesn't look like an export").
 *
 * `too_large`, `too_many_entries`, and `path_escape` are `EntrySourceError.code` verbatim;
 * `not_recognized` is any importer-thrown open/walk error (a missing `index.html`, an empty
 * folder); `unknown` is the backstop for anything that escapes both.
 */
export type ImportWorkerErrorCode = "too_large" | "too_many_entries" | "path_escape" | "not_recognized" | "unknown";
