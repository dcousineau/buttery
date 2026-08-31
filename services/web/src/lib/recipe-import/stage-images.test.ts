import { describe, expect, it, vi } from "vitest";
import type { CommitItem } from "./contracts.ts";
import { stageChunkImages, type ItemImageSource, type StageImagesDeps } from "./stage-images.ts";

/**
 * §11's client half: the browser gets a chunk's photos into Buttery's storage
 * before the chunk is sent.
 *
 * The properties worth pinning are all about what happens when it *doesn't*
 * work, because that is the common case in the field — most recipe CDNs send no
 * CORS headers — and the wrong failure here is silent data loss (an import that
 * dies over a photo) or a hotlink (a URL that survives into storage).
 */

function importItem(clientId: string): CommitItem {
  return {
    clientId,
    entryName: `${clientId}.html`,
    action: "import",
    record: { name: clientId, text: "", ingredients: [], instructions: [] },
    sourceUrl: null,
    attribution: null,
    imageSourceUrl: null,
    notes: null,
    tags: [],
    sourceText: null,
    meta: {},
  };
}

function skipItem(clientId: string): CommitItem {
  return { clientId, entryName: `${clientId}.html`, action: "skip", reason: "user" };
}

function blob(): Blob {
  return { size: 4, type: "image/jpeg" } as unknown as Blob;
}

function file(): File {
  return { name: "hero.jpg", size: 4, type: "image/jpeg" } as unknown as File;
}

/** The id a successful upload comes back with; asserted on, so it is named once. */
const UPLOAD_ID = "01JABCDEF0123456789ABCDEFG";

/**
 * The three injected dependencies as standalone spies plus the object built
 * from them.
 *
 * Split apart because asserting on `deps.uploadImage` would be passing an
 * unbound method to `expect`; holding each spy in its own binding is both what
 * the linter wants and what reads better at the call site.
 */
function harness(over: { localFile?: () => File | null; fetchRemote?: () => Blob | null; uploadId?: string | null } = {}) {
  const uploadImage = vi.fn(() => Promise.resolve<string | null>(over.uploadId === undefined ? UPLOAD_ID : over.uploadId));
  const localFile = vi.fn(() => over.localFile?.() ?? null);
  const fetchRemote = vi.fn((_url: string) => Promise.resolve<Blob | null>(over.fetchRemote?.() ?? null));
  const deps: StageImagesDeps = { uploadImage, localFile, fetchRemote };
  return { deps, uploadImage, localFile, fetchRemote };
}

function sources(...list: ItemImageSource[]): ItemImageSource[] {
  return list;
}

describe("stageChunkImages", () => {
  it("uploads a photo that came out of the dropped folder", async () => {
    // The case the server could never have covered: these bytes exist only in
    // the tab. Before the upload path they were silently dropped, and every
    // hand-photographed recipe in a Paprika export imported with no image.
    const h = harness({ localFile: file });
    const out = await stageChunkImages([importItem("a")], sources({ clientId: "a", localImagePath: "Recipes/a/hero.jpg", imageUrl: null }), h.deps);

    expect(h.uploadImage).toHaveBeenCalledTimes(1);
    expect(out[0]).toMatchObject({ clientId: "a", imageUploadId: UPLOAD_ID });
  });

  it("prefers the local file over a remote URL, and never fetches when it has one", async () => {
    // Paprika writes both for a recipe it downloaded. Bytes we already hold
    // cannot be refused; a request can.
    const h = harness({ localFile: file });
    await stageChunkImages([importItem("a")], sources({ clientId: "a", localImagePath: "Recipes/a/hero.jpg", imageUrl: "https://img.example/a.jpg" }), h.deps);

    expect(h.fetchRemote).not.toHaveBeenCalled();
  });

  it("falls back to fetching the remote hero when the export has no local copy", async () => {
    const h = harness({ fetchRemote: blob });
    const out = await stageChunkImages([importItem("a")], sources({ clientId: "a", localImagePath: null, imageUrl: "https://img.example/a.jpg" }), h.deps);

    expect(h.fetchRemote).toHaveBeenCalledWith("https://img.example/a.jpg");
    expect(out[0]).toMatchObject({ imageUploadId: UPLOAD_ID });
  });

  it("leaves the item untouched when the browser cannot read the image", async () => {
    // A CDN with no `Access-Control-Allow-Origin` — the ordinary case. The item
    // goes out exactly as it would have, carrying `imageSourceUrl`, and the
    // server tries its own SSRF-guarded fetch. What must NOT happen is the
    // import failing, or a URL being treated as the stored image.
    const out = await stageChunkImages([importItem("a")], sources({ clientId: "a", localImagePath: null, imageUrl: "https://img.example/a.jpg" }), harness().deps);

    expect(out[0]).not.toHaveProperty("imageUploadId");
    expect(out).toHaveLength(1);
  });

  it("leaves the item untouched when the upload itself fails", async () => {
    const h = harness({ fetchRemote: blob, uploadId: null });
    const out = await stageChunkImages([importItem("a")], sources({ clientId: "a", localImagePath: null, imageUrl: "https://img.example/a.jpg" }), h.deps);

    expect(out[0]).not.toHaveProperty("imageUploadId");
  });

  it("falls through to the remote URL when the local file is missing from the drop", async () => {
    // Real in exports where the photo was never synced: `localImagePath` names
    // an asset the folder does not hold.
    const h = harness({ localFile: () => null, fetchRemote: blob });
    const out = await stageChunkImages([importItem("a")], sources({ clientId: "a", localImagePath: "Recipes/a/missing.jpg", imageUrl: "https://img.example/a.jpg" }), h.deps);

    expect(out[0]).toMatchObject({ imageUploadId: UPLOAD_ID });
  });

  it("touches nothing for items with no photo, and never for a skip", async () => {
    const h = harness({ localFile: file });
    const items = [importItem("a"), skipItem("b")];
    const out = await stageChunkImages(items, sources({ clientId: "a", localImagePath: null, imageUrl: null }, { clientId: "b", localImagePath: "x.jpg", imageUrl: null }), h.deps);

    expect(h.uploadImage).not.toHaveBeenCalled();
    expect(out).toEqual(items);
  });

  it("returns a new array and mutates neither input", async () => {
    const h = harness({ localFile: file });
    const items = [importItem("a")];
    const out = await stageChunkImages(items, sources({ clientId: "a", localImagePath: "hero.jpg", imageUrl: null }), h.deps);

    expect(out).not.toBe(items);
    expect(items[0]).not.toHaveProperty("imageUploadId");
  });

  it("stages every item in a full chunk", async () => {
    // Concurrency is bounded (4), so the loop has to keep pulling work — an
    // off-by-one in the worker would quietly stage only the first four.
    const h = harness({ localFile: file });
    const ids = Array.from({ length: 25 }, (_, i) => `c${i}`);
    const out = await stageChunkImages(
      ids.map(importItem),
      ids.map((clientId) => ({ clientId, localImagePath: `${clientId}.jpg`, imageUrl: null })),
      h.deps,
    );

    expect(h.uploadImage).toHaveBeenCalledTimes(25);
    expect(out.every((item) => "imageUploadId" in item)).toBe(true);
  });
});
