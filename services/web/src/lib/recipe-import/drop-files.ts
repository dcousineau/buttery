import type { DroppedFile } from "@buttery/recipe-extract/import";

/**
 * Turning what the browser hands us into `DroppedFile[]` (plan §4.2, D40).
 *
 * Two acquisition paths, and they do **not** agree on where the path lives:
 *
 *   - `<input type="file" webkitdirectory>` populates `File.webkitRelativePath`;
 *   - a directory **drag** does not — `FileSystemFileEntry.file()` returns a `File` whose
 *     `webkitRelativePath` is `""`, and the only path that exists is the one the traversal
 *     accumulated.
 *
 * Reducing both to `File[]` silently discards every drag path, which is the primary
 * interaction the design draws. So both paths produce `{ path, file }` pairs, and the
 * importer never learns which one it was.
 */

export interface DroppedFolder {
  files: DroppedFile[];
  /** The folder's own name ("My Recipes") for `recipe_import_session.file_name`, if known. */
  rootName: string | null;
}

/** Directory traversal is bounded so a symlink loop or a stray home directory cannot hang the tab. */
const MAX_FILES = 20_000;

/** `webkitGetAsEntry` types are not in lib.dom's `DataTransferItem` in every TS release. */
interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
}
interface FileSystemFileEntryLike extends FileSystemEntryLike {
  file(onSuccess: (file: File) => void, onError: (error: unknown) => void): void;
}
interface FileSystemDirectoryReaderLike {
  readEntries(onSuccess: (entries: FileSystemEntryLike[]) => void, onError: (error: unknown) => void): void;
}
interface FileSystemDirectoryEntryLike extends FileSystemEntryLike {
  createReader(): FileSystemDirectoryReaderLike;
}

function entryFile(entry: FileSystemFileEntryLike): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** `readEntries` returns at most ~100 entries per call and must be drained in a loop. */
async function readAll(reader: FileSystemDirectoryReaderLike): Promise<FileSystemEntryLike[]> {
  const all: FileSystemEntryLike[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntryLike[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

async function walkEntry(entry: FileSystemEntryLike, prefix: string, out: DroppedFile[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    out.push({ path, file: await entryFile(entry as FileSystemFileEntryLike) });
    return;
  }
  if (!entry.isDirectory) return;
  const entries = await readAll((entry as FileSystemDirectoryEntryLike).createReader());
  for (const child of entries) await walkEntry(child, path, out);
}

/**
 * Read a drop.
 *
 * Falls back to `DataTransfer.files` when the browser has no `webkitGetAsEntry` — that path
 * cannot carry a folder at all, so a single-file drop still produces something the importer
 * can reject with a real message instead of silence.
 */
export async function filesFromDataTransfer(transfer: DataTransfer): Promise<DroppedFolder> {
  const items = Array.from(transfer.items ?? []);
  const entries = items
    .map((item) => (typeof item.webkitGetAsEntry === "function" ? (item.webkitGetAsEntry() as FileSystemEntryLike | null) : null))
    .filter((entry): entry is FileSystemEntryLike => entry !== null);

  if (entries.length === 0) {
    const files = Array.from(transfer.files ?? []).map((file) => ({ path: file.webkitRelativePath || file.name, file }));
    return { files, rootName: rootNameOf(files) };
  }

  const out: DroppedFile[] = [];
  for (const entry of entries) await walkEntry(entry, "", out);
  return { files: out, rootName: rootNameOf(out) };
}

/** Read a `<input type="file" webkitdirectory>` selection. */
export function filesFromInput(list: FileList | null): DroppedFolder {
  const files = Array.from(list ?? []).map((file) => ({ path: file.webkitRelativePath || file.name, file }));
  return { files, rootName: rootNameOf(files) };
}

/**
 * The common first path segment, when every file shares one — the folder the user dropped.
 * Null when the drop was loose files, which is also a drop the importer will reject.
 */
function rootNameOf(files: readonly DroppedFile[]): string | null {
  if (files.length === 0) return null;
  const first = files[0].path.split("/")[0];
  if (!first || first === files[0].path) return null;
  return files.every((f) => f.path.startsWith(`${first}/`)) ? first : null;
}
