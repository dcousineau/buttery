import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DroppedFile } from "@buttery/recipe-extract/import";
import { createLocalImageCache } from "./image-cache.ts";

/**
 * The leak property, asserted rather than trusted (§11, D26).
 *
 * `URL.createObjectURL` does not exist in the unit environment, which is convenient: a stub
 * is also a ledger, so "every URL handed out was revoked" is a comparison of two sets rather
 * than a claim in a comment.
 */

let created: string[];
let revoked: string[];
let seq: number;

beforeEach(() => {
  created = [];
  revoked = [];
  seq = 0;
  vi.stubGlobal("URL", {
    createObjectURL: () => {
      const url = `blob:test/${seq++}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url: string) => void revoked.push(url),
  });
});

afterEach(() => vi.unstubAllGlobals());

function file(name: string): File {
  return { name } as unknown as File;
}

function drop(...paths: string[]): DroppedFile[] {
  return paths.map((path) => ({ path, file: file(path) }));
}

describe("createLocalImageCache", () => {
  it("returns a URL for a path the drop holds and null for one it does not", () => {
    const cache = createLocalImageCache(drop("Box/Recipes/Images/a/1.jpg"));

    expect(cache.get("Box/Recipes/Images/a/1.jpg")).toBe("blob:test/0");
    expect(cache.get("Box/Recipes/Images/a/missing.jpg")).toBeNull();
    expect(created).toHaveLength(1);
  });

  it("normalizes the lookup the same way the entry source keys it", () => {
    // `resolveSibling` yields `Recipes/./Images/…` shapes; a raw Map lookup would miss.
    const cache = createLocalImageCache(drop("Box/Recipes/Images/a/1.jpg"));

    expect(cache.get("Box/Recipes/./Images/a/1.jpg")).toBe("blob:test/0");
    expect(cache.get("Box/Recipes/other/../Images/a/1.jpg")).toBe("blob:test/0");
    expect(created).toHaveLength(1); // one URL, re-served — not one per spelling
  });

  it("hands back the same URL for a repeat read instead of minting a second one", () => {
    const cache = createLocalImageCache(drop("Box/1.jpg"));

    expect(cache.get("Box/1.jpg")).toBe(cache.get("Box/1.jpg"));
    expect(created).toHaveLength(1);
    expect(revoked).toHaveLength(0);
  });

  it("keeps a windowed list's worth of thumbnails live at once", () => {
    // The list is windowed, so what is mounted is a viewport of rows plus overscan — around
    // 25 — plus the preview and the compare dialog. Anything evicted inside one window would
    // be a revoked URL under a live `<img>`; the bound has to clear it several times over.
    const paths = Array.from({ length: 64 }, (_, i) => `Box/Images/${i}.jpg`);
    const cache = createLocalImageCache(drop(...paths));

    for (const path of paths) expect(cache.get(path)).not.toBeNull();

    expect(cache.size()).toBe(64);
    expect(revoked).toHaveLength(0);
  });

  it("evicts oldest-first once past the bound, revoking as it goes", () => {
    // Scrolling the whole of a 341-recipe export past the window does reach the bound now —
    // which is the point: it is a live LRU, not a number picked to never bind.
    const paths = Array.from({ length: 341 }, (_, i) => `Box/Images/${i}.jpg`);
    const cache = createLocalImageCache(drop(...paths));

    for (const path of paths) cache.get(path);

    expect(cache.size()).toBe(128);
    expect(revoked).toEqual(created.slice(0, 341 - 128));
  });

  it("revokes everything on dispose and goes inert", () => {
    const cache = createLocalImageCache(drop("Box/1.jpg", "Box/2.jpg"));
    cache.get("Box/1.jpg");
    cache.get("Box/2.jpg");

    cache.dispose();

    expect(revoked.sort()).toEqual(created.sort());
    expect(cache.size()).toBe(0);
    expect(cache.get("Box/1.jpg")).toBeNull();
  });

  it("is idempotent on a second dispose", () => {
    const cache = createLocalImageCache(drop("Box/1.jpg"));
    cache.get("Box/1.jpg");

    cache.dispose();
    cache.dispose();

    expect(revoked).toEqual(created);
  });

  it("skips a path the guardrails reject rather than throwing during a render", () => {
    const cache = createLocalImageCache(drop("/etc/passwd.jpg", "Box/1.jpg"));

    expect(cache.get("Box/1.jpg")).toBe("blob:test/0");
    expect(cache.get("/etc/passwd.jpg")).toBeNull();
    expect(cache.get("../outside.jpg")).toBeNull();
  });
});
