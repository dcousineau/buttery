import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The §2.5 / D30 importer boundary, pinned (acceptance §16.19: "the rule is
 * committed with a test that it actually fires").
 *
 * ── WHY A TEST AND NOT JUST THE RULE ─────────────────────────────────────
 * `pnpm lint` only proves the boundary holds for the files that exist *today*.
 * It says nothing about whether the rule is still wired up: `overrides` are
 * order-sensitive and last-match-wins, so moving the exemption block above the
 * restriction block, widening the top-level `ignorePatterns`, or fat-fingering
 * one glob in the `files` array all disable the rule silently — every module in
 * the repo still passes lint, because none of them violate a rule that no longer
 * applies to them. The boundary is exactly the kind of invariant that is
 * invisible until the day someone needs it.
 *
 * So this runs the **real** oxlint binary against the **real** `.oxlintrc.json`,
 * over synthetic source at paths chosen to exercise one glob each. Nothing here
 * restates the pattern list — a copy of the patterns would pass while the shipped
 * config was broken, which is the failure this test exists to prevent.
 *
 * ── WHY FILES ON DISK ────────────────────────────────────────────────────
 * oxlint has no `lintText`/stdin entry point, and the whole question being asked
 * is "which config block matches this path?", so the fixtures have to exist at
 * real paths. They are written under the guarded directories with an obvious
 * throwaway prefix and deleted in `afterAll`; the filenames are synthetic on
 * purpose, so the test does not depend on some module continuing to exist at a
 * path nobody promised to keep.
 */

const RULE = "no-restricted-imports";

/** The import every guarded directory must refuse. */
const PAPRIKA_IMPORT = `import { paprikaImporter } from "@buttery/recipe-extract/paprika";\nexport const importer = paprikaImporter;\n`;

/** Something legal, to prove the rule is discriminating rather than blanket-on. */
const GENERIC_IMPORT = `import type { ImportCandidate } from "@buttery/recipe-extract/import";\nexport type Candidate = ImportCandidate;\n`;

const FIXTURE = "__boundary-fixture";

/**
 * Walk up for the lint config rather than counting `../`, so moving this test
 * within the workspace cannot turn a real failure into a "config not found".
 */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, ".oxlintrc.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error("Could not find .oxlintrc.json above " + fileURLToPath(import.meta.url));
    dir = up;
  }
}

const ROOT = repoRoot();

type Fixture = { readonly label: string; readonly path: string; readonly code: string };

/**
 * One representative file per glob in the rule's `files` array. If a glob is
 * dropped or narrowed, exactly one of these stops reporting. The first name is
 * deliberately `recipe-import`-prefixed rather than nested: that glob matches a
 * filename prefix, not a directory.
 */
const GUARDED: readonly Fixture[] = [
  { label: "services/web/src/server/recipe-import*", path: `services/web/src/server/recipe-import-${FIXTURE}.ts`, code: PAPRIKA_IMPORT },
  { label: "services/web/src/server/recipe-import/**", path: `services/web/src/server/recipe-import/${FIXTURE}.ts`, code: PAPRIKA_IMPORT },
  { label: "services/web/src/lib/recipe-import/**", path: `services/web/src/lib/recipe-import/${FIXTURE}.ts`, code: PAPRIKA_IMPORT },
  { label: "services/web/src/components/recipes/import/**", path: `services/web/src/components/recipes/import/${FIXTURE}.ts`, code: PAPRIKA_IMPORT },
  { label: "packages/recipe-extract/src/import/**", path: `packages/recipe-extract/src/import/${FIXTURE}.ts`, code: PAPRIKA_IMPORT },
];

/**
 * Every path form a determined refactor could reach the importer by. These are
 * the patterns beyond the bare subpath, and each one is load-bearing: relative
 * hops are exactly what a "let me just move this file" change produces, and
 * they are the forms the bare-subpath pattern does not cover.
 */
const PATH_FORMS: readonly Fixture[] = [
  {
    label: "the bare subpath",
    path: `services/web/src/lib/recipe-import/${FIXTURE}-bare.ts`,
    code: 'import { parsePaprikaRecipe } from "@buttery/recipe-extract/paprika";\nexport const p = parsePaprikaRecipe;\n',
  },
  {
    label: "a deep source path",
    path: `services/web/src/lib/recipe-import/${FIXTURE}-deep.ts`,
    code: 'import { parsePaprikaRecipe } from "../../../../../packages/recipe-extract/src/paprika/recipe.ts";\nexport const p = parsePaprikaRecipe;\n',
  },
  {
    label: "a bare relative module",
    path: `services/web/src/lib/recipe-import/${FIXTURE}-relative-module.ts`,
    code: 'import { parsePaprikaRecipe } from "./paprika";\nexport const p = parsePaprikaRecipe;\n',
  },
  {
    label: "a relative file",
    path: `services/web/src/lib/recipe-import/${FIXTURE}-relative-file.ts`,
    code: 'import { parsePaprikaRecipe } from "../paprika.ts";\nexport const p = parsePaprikaRecipe;\n',
  },
  {
    label: "a relative directory",
    path: `services/web/src/lib/recipe-import/${FIXTURE}-relative-dir.ts`,
    code: 'import { parsePaprikaRecipe } from "../paprika/recipe.ts";\nexport const p = parsePaprikaRecipe;\n',
  },
];

/**
 * Two negative controls. Without these, a config that reported
 * `no-restricted-imports` on *everything* — the shape a bad `files` glob
 * produces — would pass every assertion above.
 */
const ALLOWED: readonly Fixture[] = [
  { label: "a generic pipeline import inside a guarded directory", path: `services/web/src/lib/recipe-import/${FIXTURE}-generic.ts`, code: GENERIC_IMPORT },
  { label: "a Paprika import from a module outside the pipeline", path: `services/web/src/lib/${FIXTURE}-outside.ts`, code: PAPRIKA_IMPORT },
];

/**
 * The exemption, and the reason this is a separate assertion rather than a
 * comment: the registry is the ONE module allowed to name Paprika (§2.5), and an
 * exemption that quietly stopped applying would break `pnpm lint` on a shipped
 * file — loudly, and someone would "fix" it by widening the rule. This one is the
 * real file, not a fixture: it genuinely imports the importer, so linting it is
 * the whole assertion.
 */
const REGISTRY_PATH = "services/web/src/lib/recipe-import/importers.ts";

const FIXTURES = [...GUARDED, ...PATH_FORMS, ...ALLOWED];

type Diagnostic = { readonly code?: string; readonly help?: string; readonly filename?: string };

/** Rule ids oxlint reported per file, keyed by the repo-relative path passed in. */
let report: Map<string, Diagnostic[]>;

const run = promisify(execFile);

beforeAll(async () => {
  for (const { path, code } of FIXTURES) {
    mkdirSync(dirname(join(ROOT, path)), { recursive: true });
    writeFileSync(join(ROOT, path), code);
  }

  // oxlint exits 1 when it reports errors — which is the expected outcome here,
  // so the nonzero status is not a failure and stdout is read either way.
  const { stdout } = await run(join(ROOT, "node_modules/.bin/oxlint"), ["--format", "json", ...FIXTURES.map((f) => f.path), REGISTRY_PATH], { cwd: ROOT }).catch(
    (error: unknown) => {
      const stdout = (error as { stdout?: unknown }).stdout;
      if (typeof stdout !== "string" || !stdout.trim()) throw error;
      return { stdout };
    },
  );

  const diagnostics = (JSON.parse(stdout) as { diagnostics?: Diagnostic[] }).diagnostics ?? [];
  report = new Map([...FIXTURES.map((f) => f.path), REGISTRY_PATH].map((path) => [path, []]));
  for (const diagnostic of diagnostics) {
    // `filename` comes back exactly as the path was passed (repo-relative).
    report.get(diagnostic.filename ?? "")?.push(diagnostic);
  }
}, 60_000);

afterAll(() => {
  for (const { path } of FIXTURES) rmSync(join(ROOT, path), { force: true });
  // Created above by `recursive: true` and empty again now.
  rmSync(join(ROOT, "services/web/src/server/recipe-import"), { force: true, recursive: true });
});

/** The rule ids reported for a fixture path — `<fatal>` if oxlint never saw it. */
function ruleIdsFor(path: string): string[] {
  const diagnostics = report.get(path);
  if (!diagnostics) throw new Error(`No oxlint result for ${path}`);
  // Codes arrive as `eslint(no-restricted-imports)`; compare on the rule id.
  return diagnostics.map((d) => d.code?.replace(/^.*\((.*)\)$/, "$1") ?? "<fatal>");
}

describe("the recipe-import boundary rule is live (§2.5 / D30, §16.19)", () => {
  it.each(GUARDED)("reports for $label — e.g. $path", ({ path }) => {
    expect(ruleIdsFor(path)).toContain(RULE);
  });

  it.each(PATH_FORMS)("reports for $label", ({ path }) => {
    expect(ruleIdsFor(path)).toContain(RULE);
  });

  it("does NOT report for the importer registry, the sole documented exemption", () => {
    expect(ruleIdsFor(REGISTRY_PATH)).not.toContain(RULE);
  });

  it.each(ALLOWED)("does NOT report $label", ({ path }) => {
    expect(ruleIdsFor(path)).not.toContain(RULE);
  });

  /**
   * The message is what a reader gets at 5pm on a Friday, and the plan reference
   * in it is the only path from "lint failed" to "here is why the boundary
   * exists". Asserting it keeps a future edit from reducing it to "no.".
   * oxlint surfaces a configured `message` as the diagnostic's `help` text.
   */
  it("explains itself, citing the plan", () => {
    const path = `services/web/src/lib/recipe-import/${FIXTURE}.ts`;
    const help = report.get(path)?.find((d) => d.code?.includes(RULE))?.help ?? "";
    expect(help).toContain("importers.ts");
    expect(help).toContain("§16.19");
  });
});
