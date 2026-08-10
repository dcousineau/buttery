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

  it("keeps every thumbnail of a reference-sized export live at once", () => {
    // The list mounts a row per recipe (no windowing), so 250 photos ask for a URL in one
    // pass. Anything evicted here would be a revoked URL under a live `<img>`.
    const paths = Array.from({ length: 250 }, (_, i) => `Box/Images/${i}.jpg`);
    const cache = createLocalImageCache(drop(...paths));

    for (const path of paths) expect(cache.get(path)).not.toBeNull();

    expect(cache.size()).toBe(250);
    expect(revoked).toHaveLength(0);
  });

  it("evicts oldest-first once past the bound, revoking as it goes", () => {
    const paths = Array.from({ length: 1100 }, (_, i) => `Box/Images/${i}.jpg`);
    const cache = createLocalImageCache(drop(...paths));

    for (const path of paths) cache.get(path);

    expect(cache.size()).toBe(1024);
    expect(revoked).toEqual(created.slice(0, 1100 - 1024));
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
