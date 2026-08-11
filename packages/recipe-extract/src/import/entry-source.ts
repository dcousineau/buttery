import type { DroppedFile, EntrySource } from "./types.ts";

/**
 * Guardrails for "a pile of files a user handed us" (§4.2). They belong to the generic
 * entry source rather than to any one importer, so every future source — archive-backed
 * included — inherits them instead of re-deriving them.
 *
 * 200 MB is ~13× the measured 341-recipe reference export (15 MB, §3), so it is a
 * runaway-drop backstop and not a ceiling a real library will reach.
 */
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

/** Same shape of backstop as `MAX_TOTAL_BYTES`: ~15× the reference export's 341 recipes. */
export const MAX_ENTRIES = 5000;

/**
 * A guardrail rejection, carrying a machine-readable `code` so the launch screen can pick
 * its own copy per failure ("that folder is too big" reads very differently from "that
 * folder contains something we won't open") without string-matching a message.
 */
export class EntrySourceError extends Error {
  constructor(
    public readonly code: "too_large" | "too_many_entries" | "path_escape",
    message: string,
  ) {
    super(message);
    this.name = "EntrySourceError";
  }
}

/**
 * Collapse `//`, drop `.` segments, resolve `..`, and reject anything that escapes the
 * root. Exported because the Paprika walker needs the *same* normalization to resolve an
 * `<img src>` against its recipe file's directory (§4.1 note 4) — two implementations of
 * this would be two chances for `localImagePath` to name a key the source does not hold.
 *
 * Only `/` is treated as a separator: both acquisition paths are web-platform APIs
 * (`webkitRelativePath`, `FileSystemEntry.fullPath`) and both use `/` regardless of host
 * OS, so treating `\` as a separator would only ever mangle a legitimate filename. A
 * leading `\` or a drive-letter prefix is still rejected, because those mean "absolute"
 * and never mean "a name that happens to start that way".
 *
 * Path-escape rejection is cheap insurance today — a `File` from a directory picker
 * cannot really escape — that stops being theoretical the moment an archive-backed
 * source lands (§4.2, §17).
 *
 * @throws {EntrySourceError} code `path_escape`
 */
export function normalizeEntryPath(path: string): string {
  if (path.startsWith("/") || path.startsWith("\\")) {
    throw new EntrySourceError("path_escape", `Absolute entry path rejected: ${JSON.stringify(path)}`);
  }
  if (/^[a-zA-Z]:[/\\]/.test(path)) {
    throw new EntrySourceError("path_escape", `Absolute entry path rejected: ${JSON.stringify(path)}`);
  }

  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue; // "" covers both "//" and a trailing "/"
    if (segment === "..") {
      if (out.length === 0) throw new EntrySourceError("path_escape", `Entry path escapes the root: ${JSON.stringify(path)}`);
      out.pop();
      continue;
    }
    out.push(segment);
  }

  if (out.length === 0) {
    throw new EntrySourceError("path_escape", `Entry path resolves to nothing: ${JSON.stringify(path)}`);
  }
  return out.join("/");
}

function assertEntryCount(count: number): void {
  if (count > MAX_ENTRIES) {
    throw new EntrySourceError("too_many_entries", `Import holds ${count} entries; the limit is ${MAX_ENTRIES}.`);
  }
}

function assertTotalBytes(totalBytes: number): void {
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new EntrySourceError("too_large", `Import totals ${totalBytes} bytes; the limit is ${MAX_TOTAL_BYTES}.`);
  }
}

function missingEntry(path: string): Error {
  return new Error(`No such entry: ${JSON.stringify(path)}`);
}

/**
 * The one `EntrySource` phase 1 ships: a dropped (or picked) directory.
 *
 * **Nothing is read at construction.** `File` handles are lazy, so a 15 MB export costs
 * nothing until `text()` or `bytes()` asks — which is what lets the launch screen accept
 * a folder instantly and only then show parse progress. `totalBytes()` sums `File.size`,
 * which is metadata the browser already has and is free to read.
 *
 * Paths come from `DroppedFile.path`, never from `File.webkitRelativePath`: the drag
 * acquisition path leaves that empty (§4.2, D40).
 *
 * Duplicate normalized paths are last-wins, matching what a filesystem would have given
 * the user anyway.
 *
 * @throws {EntrySourceError} on the §4.2 guardrails, at construction — the caller learns
 *   the drop is unusable before any parsing starts.
 */
export function directoryEntrySource(files: DroppedFile[]): EntrySource {
  assertEntryCount(files.length);

  const byPath = new Map<string, File>();
  let total = 0;
  for (const { path, file } of files) {
    byPath.set(normalizeEntryPath(path), file);
    total += file.size;
  }
  assertTotalBytes(total);

  const paths = Object.freeze([...byPath.keys()]);

  function resolve(path: string): File {
    const file = byPath.get(normalizeEntryPath(path));
    if (!file) throw missingEntry(path);
    return file;
  }

  // `text`/`bytes` are `async` so an unknown path *rejects* rather than throwing
  // synchronously — callers await these in a loop over hundreds of entries and a
  // synchronous throw from a promise-returning method escapes the surrounding
  // `.catch()`/`try`-around-`await` and takes the whole walk down.
  return {
    paths: () => paths,
    text: async (path) => await resolve(path).text(),
    bytes: async (path) => new Uint8Array(await resolve(path).arrayBuffer()),
    totalBytes: () => total,
  };
}

/**
 * In-memory `EntrySource` over a `Map<path, string | Uint8Array>` — no filesystem, no
 * `File`, no DOM.
 *
 * This is the stub every importer test walks against (§4.3, §14), which is why it lives
 * here beside the interface rather than under `paprika/`: the second importer's walker
 * tests need exactly the same fixture shape, and a stub buried in one importer's folder
 * gets copy-pasted instead of reused. It runs the *same* normalization and the *same*
 * guardrail helpers as `directoryEntrySource`, so a test that proves a path escape is
 * rejected here proves it for the real source too.
 *
 * @throws {EntrySourceError} on the §4.2 guardrails, at construction.
 */
export function memoryEntrySource(entries: Map<string, string | Uint8Array>): EntrySource {
  assertEntryCount(entries.size);

  const encoder = new TextEncoder();
  const byPath = new Map<string, Uint8Array>();
  let total = 0;
  for (const [path, value] of entries) {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    byPath.set(normalizeEntryPath(path), bytes);
    total += bytes.byteLength;
  }
  assertTotalBytes(total);

  const paths = Object.freeze([...byPath.keys()]);
  const decoder = new TextDecoder();

  function resolve(path: string): Uint8Array {
    const bytes = byPath.get(normalizeEntryPath(path));
    if (!bytes) throw missingEntry(path);
    return bytes;
  }

  // Deferred through `Promise.resolve().then` for the same reason as
  // `directoryEntrySource`: reject, never throw sync. Nothing here is actually
  // async — the bytes are already in memory — so the promise is the contract
  // (and the error channel), not a wait.
  return {
    paths: () => paths,
    text: (path) => Promise.resolve().then(() => decoder.decode(resolve(path))),
    bytes: (path) => Promise.resolve().then(() => resolve(path)),
    totalBytes: () => total,
  };
}
