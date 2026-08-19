import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The §4.3 port boundary, pinned: **no client module imports `#/server/**`.**
 *
 * ── WHY A TEST WHEN THERE IS ALREADY A LINT RULE ─────────────────────────
 * `.oxlintrc.json` has the `no-restricted-imports` rule, and it is the thing
 * that gives a developer a good error message at the moment they write the
 * import. But `pnpm lint` only proves the boundary holds for the files that
 * exist today — it says nothing about whether the rule is still *wired up*.
 * oxlint `overrides` are order-sensitive and last-match-wins, so widening a
 * glob, reordering two blocks, or adding a fourth exemption disables the rule
 * silently: every module in the repo still passes lint, because none of them
 * violates a rule that no longer applies to them.
 *
 * This scanner cannot be disabled that way. It reads the source of the client
 * tree and asserts on the text, so it is indifferent to lint configuration
 * entirely. Modelled on the `createServerFn`-coverage scanner in
 * `src/server/import-authz.test.ts`, which exists for the same reason.
 *
 * ── WHY THE BOUNDARY MATTERS ─────────────────────────────────────────────
 * Three things ride on it (offline plan §4.3, §7):
 *   1. **Offline is legible.** A route is offline-capable iff its data comes
 *      from a `queryOptions` factory in `src/lib/api/queries.ts`. A component
 *      that reaches past the port gets no persistence, no refetch-on-reconnect
 *      and no invalidation — and nothing about the code would say so.
 *   2. **The API service (§7) stays a one-file change.** Every call site speaks
 *      plain functions with natural arguments; extracting a REST service is a
 *      rewrite of `transport.ts` and nothing else.
 *   3. **Bundle hygiene.** "Did this component just drag a server module into
 *      the client bundle?" has one place to look.
 */

const SRC = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Directories that are *not* client code and may name server modules freely.
 *
 * - `server/` is the server tree; its modules import each other.
 * - `routes/api/` and the OG-image route are server route handlers. They render
 *   on the server only and never ship to a client bundle, so "reach the server
 *   through the port" would mean an HTTP round trip to themselves.
 */
const SERVER_TREE = [
  /^server\//,
  /^routes\/api\//,
  /^routes\/[^/]*og\[\.\]png\.ts$/,
  // This file. Its prose spells out the specifiers it is looking for, which the
  // regex below cannot tell from the real thing — a scanner that fails on its
  // own documentation teaches people to delete the documentation.
  /^lib\/api\/no-server-imports\.test\.ts$/,
];

/**
 * The two modules that are *supposed* to know `src/server/**` exists.
 *
 * `transport.ts` is the point of the whole exercise: exactly one client module
 * holds those imports. `recipe-import/contracts.ts` is the import flow's
 * pre-existing type-only port — it restates no shape, `import type` is erased at
 * build time, and the offline plan keeps the whole import flow online-only and
 * uncached forever (§1.1), so the reason the other DTOs had to move does not
 * apply to it. Its exemption is **type-only**, asserted separately below, so it
 * cannot quietly grow a value import.
 */
const ALLOWED = new Set(["lib/api/transport.ts", "lib/recipe-import/contracts.ts"]);

/** Both spellings a module could use to reach the server tree. */
const SERVER_IMPORT = /(?:from\s*|import\s*\(\s*)["'](#\/server\/[^"']*|(?:\.\.?\/)+server\/[^"']*)["']/g;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
      continue;
    }
    if (/\.(?:ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

/** Repo-relative-to-`src` paths, so failures name something a reader can open. */
function clientFiles(): string[] {
  return sourceFiles(SRC)
    .map((file) => relative(SRC, file).split(/[\\/]/).join("/"))
    .filter((path) => !SERVER_TREE.some((pattern) => pattern.test(path)))
    .sort();
}

function serverImportsIn(path: string): string[] {
  const source = readFileSync(join(SRC, path), "utf8");
  return [...source.matchAll(SERVER_IMPORT)].map((match) => match[1]);
}

describe("the client reaches the server only through src/lib/api (§4.3)", () => {
  it("scans a client tree that actually exists", () => {
    // Without this, a broken `SRC` or a renamed directory would make every
    // assertion below vacuously true — the failure mode this whole file exists
    // to rule out, reproduced inside the file itself.
    const files = clientFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("lib/api/transport.ts");
    expect(files).toContain("routes/household.list.tsx");
  });

  it("has no `#/server/**` import outside the two port modules", () => {
    const offenders = clientFiles()
      .filter((path) => !ALLOWED.has(path))
      .flatMap((path) => serverImportsIn(path).map((specifier) => `${path} → ${specifier}`));

    expect(offenders).toEqual([]);
  });

  it("keeps the import-flow contract module type-only", () => {
    const source = readFileSync(join(SRC, "lib/recipe-import/contracts.ts"), "utf8");
    // Whole statements, not lines: the specifier of a multi-line
    // `import type { … } from "#/server/…"` sits on a line with no `type` on
    // it. Every `#/server/**` mention in that file must belong to an
    // `import type` / `export type`; a value import there would put a
    // `createServerFn` handle back in the client tree behind an exemption
    // written for types.
    const valueImports = [...source.matchAll(/(?:^|\n)\s*(import|export)\s+([^;]*?)from\s*["']#\/server\/[^"']*["']/g)]
      .filter((match) => !/^\s*type\b/.test(match[2]))
      .map((match) => match[0].trim());
    expect(valueImports).toEqual([]);
  });

  it("routes every server function through the transport, by name", () => {
    // The transport is allowed to import server modules; this asserts it is
    // still doing the job that buys it the exemption, rather than having become
    // a barrel that re-exports `createServerFn` handles for others to call.
    const source = readFileSync(join(SRC, "lib/api/transport.ts"), "utf8");
    expect(source).not.toMatch(/export\s*\*\s*from\s*["']#\/server\//);
    // Server fns are imported under an `…Fn` alias and wrapped; a bare
    // re-export would leak the `{ data }` envelope to every call site.
    expect(source).toMatch(/as \w+Fn/);
  });
});
