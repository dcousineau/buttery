import { type DroppedFile, normalizeEntryPath } from "@buttery/recipe-extract/import";

/**
 * Local image previews for the review screen (§11, D26).
 *
 * Reading is not uploading. The review pane shows the photo that came out of the dropped
 * folder, straight off the `File` handle the browser already has, while the commit path
 * sends `imageSourceUrl` — the **remote** URL — and no bytes ever leave the tab. That is
 * the entire scope of phase 1's image work.
 *
 * Object URLs are the hazard this module exists to contain. A session that previews 250
 * recipes leaks 250 blob URLs — each pinning its `File`'s decoded bytes — unless every one
 * is revoked. So: a bounded LRU that revokes on eviction, plus a `dispose()` the route calls
 * on unmount, on a second drop, and on leaving review.
 */

/**
 * Live object URLs held at once.
 *
 * It has to exceed the number of thumbnails **mounted** at once, not the number visible:
 * the review list renders a row per recipe and leans on `content-visibility` rather than
 * windowing, so all 250 photos of a reference export ask for a URL in one pass. Evicting
 * below that revokes URLs that are still an `<img src>` — measured on the real export, the
 * first 200 rows ended up with dead blobs and rendered only because the decode had already
 * won the race. A revoked URL under a live element does not re-request; it just breaks.
 *
 * The bound is cheap, because an object URL pins a `Blob` this cache is already holding in
 * `byPath` for the life of the session: the marginal cost is a handle, not the bytes. The
 * eviction path stays as the backstop for a drop far larger than a recipe box (entries are
 * capped at 5,000), and `dispose()` — not the LRU — is what makes the session leak-free.
 */
const MAX_LIVE_URLS = 1024;

export interface LocalImageCache {
  /**
   * An object URL for a source-relative path, or null when the drop has no such entry
   * (a candidate whose `localImagePath` points at a missing asset — real in exports where
   * the photo was never synced).
   */
  get(path: string): string | null;
  /** Revoke everything. Idempotent; the cache is unusable afterwards. */
  dispose(): void;
  /** Live URL count — asserted by the leak test rather than trusted. */
  size(): number;
}

/**
 * Build a cache over the files the user dropped.
 *
 * Paths are normalized with the **same** helper the entry source uses, so a
 * `localImagePath` the importer resolved against a recipe's directory looks up the same
 * entry here that `EntrySource.bytes()` would have returned.
 */
export function createLocalImageCache(files: readonly DroppedFile[]): LocalImageCache {
  const byPath = new Map<string, File>();
  for (const { path, file } of files) {
    try {
      byPath.set(normalizeEntryPath(path), file);
    } catch {
      // A path the guardrails reject cannot be an entry either; the entry source already
      // failed the drop if it mattered. Skipping keeps the cache from throwing during render.
    }
  }

  // Insertion-ordered, so the oldest key is the first one `keys().next()` yields — a Map is
  // a serviceable LRU as long as a re-read re-inserts.
  const live = new Map<string, string>();
  let disposed = false;

  function evictIfNeeded(): void {
    while (live.size > MAX_LIVE_URLS) {
      const oldest = live.keys().next();
      if (oldest.done) return;
      const url = live.get(oldest.value);
      live.delete(oldest.value);
      if (url) URL.revokeObjectURL(url);
    }
  }

  return {
    get(path) {
      if (disposed) return null;
      let key: string;
      try {
        key = normalizeEntryPath(path);
      } catch {
        return null;
      }
      const existing = live.get(key);
      if (existing) {
        // Re-insert to mark as recently used.
        live.delete(key);
        live.set(key, existing);
        return existing;
      }
      const file = byPath.get(key);
      if (!file) return null;
      const url = URL.createObjectURL(file);
      live.set(key, url);
      evictIfNeeded();
      return url;
    },
    dispose() {
      disposed = true;
      for (const url of live.values()) URL.revokeObjectURL(url);
      live.clear();
      byPath.clear();
    },
    size() {
      return live.size;
    },
  };
}
