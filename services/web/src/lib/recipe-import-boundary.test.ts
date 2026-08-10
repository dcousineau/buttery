import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The §2.5 / D30 importer boundary, pinned (acceptance §16.19: "the rule is
 * committed with a test that it actually fires").
 *
 * ── WHY A TEST AND NOT JUST THE RULE ─────────────────────────────────────
 * `pnpm lint` only proves the boundary holds for the files that exist *today*.
 * It says nothing about whether the rule is still wired up: flat config is
 * order-sensitive and last-match-wins, so moving the exemption block above the
 * restriction block, widening the top-level `ignores`, or fat-fingering one glob
 * in the `files` array all disable the rule silently — every module in the repo
 * still passes lint, because none of them violate a rule that no longer applies
 * to them. The boundary is exactly the kind of invariant that is invisible until
 * the day someone needs it.
 *
 * So this loads the **real** `eslint.config.js` through ESLint's Node API and
 * lints synthetic source at synthetic paths. Nothing here restates the pattern
 * list — a copy of the patterns would pass while the shipped config was broken,
 * which is the failure this test exists to prevent. `lintText` resolves the
 * config for `filePath` exactly the way a CLI run over that file would, so what
 * is asserted is the config's behaviour, not its text.
 *
 * The files are synthetic on purpose: a real path would make the test depend on
 * some module continuing to exist at a path nobody promised to keep.
 */

const RULE = "no-restricted-imports";

/** The import every guarded directory must be refused. */
const PAPRIKA_IMPORT = `import { paprikaImporter } from "@buttery/recipe-extract/paprika";\nexport const importer = paprikaImporter;\n`;

/** Something legal, to prove the rule is discriminating rather than blanket-on. */
const GENERIC_IMPORT = `import type { ImportCandidate } from "@buttery/recipe-extract/import";\nexport type Candidate = ImportCandidate;\n`;

/**
 * Walk up for the flat config rather than counting `../`, so moving this test
 * within the workspace cannot turn a real failure into a "config not found".
 */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "eslint.config.js"))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error("Could not find eslint.config.js above " + fileURLToPath(import.meta.url));
    dir = up;
  }
}

const ROOT = repoRoot();

type LintFn = (code: string, repoRelativePath: string) => Promise<string[]>;

/** Rule ids reported for `code` had it been the file at `repoRelativePath`. */
let ruleIdsFor: LintFn;

beforeAll(async () => {
  // `eslint` is a root devDependency (the repo lints from the root), so it is
  // resolved by walking up out of `services/web` — not declared here.
  const { ESLint } = await import("eslint");
  const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: join(ROOT, "eslint.config.js") });
  ruleIdsFor = async (code, repoRelativePath) => {
    // `warnIgnored: false` so a path covered by the top-level `ignores` comes
    // back as a plain empty result instead of an "ignored file" warning that
    // would read like a passing lint.
    const [result] = await eslint.lintText(code, { filePath: join(ROOT, repoRelativePath), warnIgnored: false });
    return (result?.messages ?? []).map((m) => m.ruleId ?? "<fatal>");
  };
}, 30_000);

/**
 * One representative file per glob in the rule's `files` array. If a glob is
 * dropped or narrowed, exactly one of these stops reporting.
 */
const GUARDED = [
  ["services/web/src/server/recipe-import*", "services/web/src/server/recipe-import.ts"],
  ["services/web/src/server/recipe-import*", "services/web/src/server/recipe-import-telemetry.ts"],
  ["services/web/src/server/recipe-import/**", "services/web/src/server/recipe-import/commit.ts"],
  ["services/web/src/lib/recipe-import/**", "services/web/src/lib/recipe-import/machine.ts"],
  ["services/web/src/components/recipes/import/**", "services/web/src/components/recipes/import/ReviewList.tsx"],
  ["packages/recipe-extract/src/import/**", "packages/recipe-extract/src/import/entry-source.ts"],
] as const;

describe("the recipe-import boundary rule is live (§2.5 / D30, §16.19)", () => {
  it.each(GUARDED)("reports for %s — e.g. %s", async (_glob, filePath) => {
    expect(await ruleIdsFor(PAPRIKA_IMPORT, filePath)).toContain(RULE);
  });

  /**
   * Every path form a determined refactor could reach the importer by. These are
   * the patterns beyond the bare subpath, and each one is load-bearing: relative
   * hops are exactly what a "let me just move this file" change produces, and
   * they are the forms the bare-subpath pattern does not cover.
   */
  it.each([
    ['the bare subpath', 'import { parsePaprikaRecipe } from "@buttery/recipe-extract/paprika";'],
    ["a deep source path", 'import { parsePaprikaRecipe } from "../../../../packages/recipe-extract/src/paprika/recipe.ts";'],
    ["a bare relative module", 'import { parsePaprikaRecipe } from "./paprika";'],
    ["a relative file", 'import { parsePaprikaRecipe } from "../paprika.ts";'],
    ["a relative directory", 'import { parsePaprikaRecipe } from "../paprika/recipe.ts";'],
  ])("reports for %s", async (_label, statement) => {
    expect(await ruleIdsFor(`${statement}\nexport const p = parsePaprikaRecipe;\n`, "services/web/src/lib/recipe-import/machine.ts")).toContain(RULE);
  });

  /**
   * The exemption, and the reason this is a separate assertion rather than a
   * comment: the registry is the ONE module allowed to name Paprika (§2.5), and
   * an exemption that quietly stopped applying would break `pnpm lint` on a
   * shipped file — loudly, and someone would "fix" it by widening the rule.
   */
  it("does NOT report for the importer registry, the sole documented exemption", async () => {
    expect(await ruleIdsFor(PAPRIKA_IMPORT, "services/web/src/lib/recipe-import/importers.ts")).not.toContain(RULE);
  });

  /**
   * Two negative controls. Without these, a config that reported
   * `no-restricted-imports` on *everything* — the shape a bad `files` glob
   * produces — would pass every assertion above.
   */
  it("does NOT report a generic pipeline import inside a guarded directory", async () => {
    expect(await ruleIdsFor(GENERIC_IMPORT, "services/web/src/lib/recipe-import/machine.ts")).not.toContain(RULE);
  });

  it("does NOT report a Paprika import from a module outside the pipeline", async () => {
    expect(await ruleIdsFor(PAPRIKA_IMPORT, "services/web/src/lib/unrelated-module.ts")).not.toContain(RULE);
  });

  /**
   * The message is what a reader gets at 5pm on a Friday, and the plan reference
   * in it is the only path from "lint failed" to "here is why the boundary
   * exists". Asserting it keeps a future edit from reducing it to "no.".
   */
  it("explains itself, citing the plan", async () => {
    const { ESLint } = await import("eslint");
    const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: join(ROOT, "eslint.config.js") });
    const [result] = await eslint.lintText(PAPRIKA_IMPORT, { filePath: join(ROOT, "services/web/src/lib/recipe-import/machine.ts"), warnIgnored: false });
    const message = result.messages.find((m) => m.ruleId === RULE)?.message ?? "";
    expect(message).toContain("importers.ts");
    expect(message).toContain("§16.19");
  });
});
