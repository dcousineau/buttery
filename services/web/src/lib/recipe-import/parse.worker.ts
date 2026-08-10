/// <reference lib="webworker" />
import { type ImportEntry, type ImportParseFailure, EntrySourceError, isParseFailure } from "@buttery/recipe-extract/import";
import { contentFingerprint, normalizeSourceUrl } from "@buttery/recipe-schemas/normalize";
import { requireImporter } from "./importers.ts";
import type { ImportWorkerErrorCode, ImportWorkerEvent, ImportWorkerRequest, ParsedItem } from "./worker-protocol.ts";

/**
 * The parse worker (plan §9, §4.2).
 *
 * Everything between "the user dropped a folder" and "here are candidates with dedupe keys"
 * happens here, off the main thread: 341 files' worth of `node-html-parser` plus 341
 * SHA-256 digests freezes the tab for seconds if it runs on the UI thread, and the design's
 * whole reading screen is a progress bar that could not paint.
 *
 * It never names an importer. It receives an **id** and resolves it through the registry,
 * which is the one module allowed to import a parser (§2.5, §16.19).
 */

declare const self: DedicatedWorkerGlobalScope;

/** Progress is posted at most this often. 341 entries × one message each would flood the
 *  main thread with renders for a bar that only moves in fractions of a percent. */
const PROGRESS_INTERVAL_MS = 80;

function post(event: ImportWorkerEvent): void {
  self.postMessage(event);
}

/** Rate-limited progress emitter. Always emits the final tick so the bar lands on 100%. */
function throttled<T extends ImportWorkerEvent>(build: (done: number) => T) {
  let last = 0;
  return (done: number, isFinal: boolean) => {
    const now = Date.now();
    if (!isFinal && now - last < PROGRESS_INTERVAL_MS) return;
    last = now;
    post(build(done));
  };
}

/**
 * Hand the event loop back so `postMessage` actually flushes and a `terminate()` from the
 * main thread can land mid-run. Without this the whole parse is one synchronous block and
 * every progress event arrives at once, after the work it was describing.
 */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** How many items to process between yields. Small enough to stay responsive, large enough
 *  that the scheduler overhead stays under the parse cost. */
const BATCH = 25;

function errorCode(error: unknown): ImportWorkerErrorCode {
  if (error instanceof EntrySourceError) return error.code;
  // Anything the importer itself threw while opening or walking means "this drop is not
  // the export we know how to read" — a missing index, an empty folder, unreadable bytes.
  if (error instanceof Error) return "not_recognized";
  return "unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function run(request: ImportWorkerRequest): Promise<void> {
  const importer = requireImporter(request.importerId);
  const source = await importer.open({ files: request.files });

  // --- walk (indeterminate) ---------------------------------------------
  // Drained into an array before parsing so the parse stage has a real total; see
  // `ImportWorkerEvent` for why that trade is made.
  const entries: ImportEntry[] = [];
  const emitRead = throttled((done: number): ImportWorkerEvent => ({ type: "read", entries: done }));
  emitRead(0, true);
  for await (const entry of importer.entries(source)) {
    entries.push(entry);
    emitRead(entries.length, false);
    if (entries.length % BATCH === 0) await yieldToLoop();
  }
  emitRead(entries.length, true);

  // --- parse (determinate) ----------------------------------------------
  const total = entries.length;
  const candidates: ParsedItem["candidate"][] = [];
  const failures: ImportParseFailure[] = [];
  const emitParse = throttled((done: number): ImportWorkerEvent => ({ type: "parse", done, total }));
  emitParse(0, true);

  for (let i = 0; i < total; i++) {
    const entry = entries[i];
    try {
      const result = importer.parse(entry);
      if (isParseFailure(result)) failures.push(result);
      else candidates.push(result);
    } catch (error) {
      // `parse` is specified as pure and total, but a thrown parser must not cost the user
      // the other 340 recipes — it becomes one more line in the failure list (§7.2, §10.1).
      failures.push({
        kind: "failure",
        clientId: crypto.randomUUID(),
        entryName: entry.entryName,
        message: errorMessage(error),
      });
    }
    // Free the HTML as we go: entries are the bulk of the worker's heap and nothing reads
    // them after parsing.
    entries[i] = undefined as unknown as ImportEntry;
    emitParse(i + 1, i + 1 === total);
    if ((i + 1) % BATCH === 0) await yieldToLoop();
  }
  emitParse(total, true);

  // --- keys (determinate) -----------------------------------------------
  // `sourceUrlKey` + `contentFp` are the *only* things the probe is allowed to send (§7.1);
  // computing them here is what makes "keys leave the browser, recipe bodies do not" a
  // property of the code rather than a promise.
  const items: ParsedItem[] = [];
  const keyTotal = candidates.length;
  const emitKeys = throttled((done: number): ImportWorkerEvent => ({ type: "keys", done, total: keyTotal }));
  emitKeys(0, true);

  for (let i = 0; i < keyTotal; i++) {
    const candidate = candidates[i];
    const sourceUrlKey = candidate.sourceUrl ? normalizeSourceUrl(candidate.sourceUrl) : null;
    // `ExtractedRecipe` types both as optional; the server computes the fingerprint from the
    // same two fields (§6.1), so the fallbacks must match what the commit will send — an
    // untitled recipe fingerprints as the empty name, not as its file name.
    const contentFp = await contentFingerprint(candidate.recipe.name ?? "", candidate.recipe.ingredients ?? []);
    items.push({ candidate, sourceUrlKey, contentFp });
    emitKeys(i + 1, i + 1 === keyTotal);
    if ((i + 1) % BATCH === 0) await yieldToLoop();
  }
  emitKeys(keyTotal, true);

  post({ type: "done", result: { items, failures } });
}

self.addEventListener("message", (event: MessageEvent<ImportWorkerRequest>) => {
  void run(event.data).catch((error: unknown) => {
    post({ type: "error", code: errorCode(error), message: errorMessage(error) });
  });
});
