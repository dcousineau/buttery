import type { CommitItem } from "./contracts.ts";

/**
 * Upload a commit chunk's photos to Buttery's storage before the chunk is sent.
 *
 * §11's client half. It runs per chunk of 25 rather than once for the whole
 * drop, for the same reason the commit itself is chunked: an import of 341
 * recipes must be resumable, and work done for a chunk that never lands is work
 * thrown away. A chunk's uploads are also the only thing standing between its
 * photos and oblivion — the alternative for these bytes is nothing at all.
 *
 * Two sources, and the first is the one the server could never have:
 *
 *   - **`localImagePath`** — a photo that came out of the dropped export. The
 *     tab holds it as a `File`; there is no URL, remote or otherwise, and no
 *     amount of server-side fetching would ever have found it. Before this,
 *     every such photo was silently dropped on import.
 *   - **`imageUrl`** — a remote hero, fetched cross-origin by the tab. It is
 *     served where our backend is refused (hotlink protection keys on Referer
 *     and datacenter IPs), and when the fetch fails — a host with no
 *     `Access-Control-Allow-Origin`, the common case — that is the end of it.
 *     There is no server-side fetch behind this any more: it was the losing
 *     fetcher, and it was the only reason a third-party URL was ever storable.
 *
 * Failure is never fatal and never blocks: an item whose upload did not work
 * goes out exactly as it would have before, carrying no image, and an item with
 * no photo at all is untouched. The one thing that cannot happen is a stored
 * URL.
 */

/** Concurrent uploads. Bounded so a 341-recipe drop does not open 341 sockets at once. */
const UPLOAD_CONCURRENCY = 4;

export interface StageImagesDeps {
  /**
   * `ImportApi.uploadImage` — bytes in, opaque upload id out, null on failure.
   * Behind it: a signed upload URL from the server and a PUT straight to the
   * bucket, so a 341-recipe drop costs the web service 341 signatures rather
   * than 341 megabytes.
   */
  uploadImage(blob: Blob): Promise<string | null>;
  /** The dropped folder's `File` for a source-relative path, or null. */
  localFile(path: string): File | null;
  /**
   * Cross-origin fetch of a remote hero. Injected rather than imported so the
   * flow's unit tests need no network — the same reasoning as `ImportApi`.
   */
  fetchRemote(url: string): Promise<Blob | null>;
}

/** What the machine knows about an item's photo, keyed by the commit's `clientId`. */
export interface ItemImageSource {
  clientId: string;
  localImagePath: string | null;
  imageUrl: string | null;
}

/**
 * Stage every photo in `items` and return the chunk with `imageUploadId` filled
 * in where it worked.
 *
 * Pure in the shape that matters: it takes the commit items, returns new ones,
 * and mutates neither the machine's state nor the caller's array.
 */
export async function stageChunkImages(items: readonly CommitItem[], sources: readonly ItemImageSource[], deps: StageImagesDeps): Promise<CommitItem[]> {
  const sourceById = new Map(sources.map((s) => [s.clientId, s]));
  // Only `import` items carry a photo — a `skip` claims no recipe and a `link`
  // attaches to one that already has its own.
  const targets = items.filter((item): item is Extract<CommitItem, { action: "import" }> => item.action === "import" && hasImage(sourceById.get(item.clientId)));
  if (!targets.length) return items.slice();

  const uploadIds = new Map<string, string>();
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= targets.length) return;
      const item = targets[index];
      const source = sourceById.get(item.clientId);
      if (!source) continue;
      const uploadId = await stageOne(source, deps);
      if (uploadId) uploadIds.set(item.clientId, uploadId);
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, targets.length) }, worker));

  return items.map((item) => {
    if (item.action !== "import") return item;
    const uploadId = uploadIds.get(item.clientId);
    return uploadId ? { ...item, imageUploadId: uploadId } : item;
  });
}

function hasImage(source: ItemImageSource | undefined): boolean {
  return Boolean(source && (source.localImagePath || source.imageUrl));
}

/**
 * One item's bytes → an upload id, or null for a recipe that imports without a
 * photo.
 *
 * The local file wins when there is one: it is bytes we already hold, so it
 * costs no network and cannot be refused, whereas the remote URL is a request
 * that may or may not be answered. Paprika writes both for a recipe it
 * downloaded and only the local path for one the user photographed.
 */
async function stageOne(source: ItemImageSource, deps: StageImagesDeps): Promise<string | null> {
  if (source.localImagePath) {
    const file = deps.localFile(source.localImagePath);
    if (file) {
      const uploadId = await deps.uploadImage(file);
      if (uploadId) return uploadId;
    }
  }
  if (source.imageUrl) {
    const blob = await deps.fetchRemote(source.imageUrl);
    if (blob) return await deps.uploadImage(blob);
  }
  return null;
}
