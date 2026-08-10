import js from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/.docusaurus/**",
      "**/.tanstack/**",
      "**/.nitro/**",
      "**/.output/**",
      ".agents/**",
      ".claude/**",
      "services/web/src/routeTree.gen.ts",
      "packages/lexicons/src/generated/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // Allow intentional throwaways: `_`-prefixed vars/args (convention) and
      // rest-sibling strips like `const { drop, ...rest } = obj` (common way to
      // omit a key). Everything else still flags as unused.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  reactHooks.configs.flat.recommended,
  { ...jsxA11y.flatConfigs.recommended, files: ["**/*.{jsx,tsx}"] },
  {
    files: ["**/*.{jsx,tsx}"],
    rules: {
      // Base UI's `render={<a/>}` / `render={<label/>}` indirection (our standard
      // primitive idiom — see AGENTS.md "Design system") hides the anchor content
      // and label→control association from jsx-a11y's static analysis, so both
      // rules fire false positives on correct code. The rest of jsx-a11y stays on.
      "jsx-a11y/anchor-has-content": "off",
      "jsx-a11y/label-has-associated-control": "off",
    },
  },
  {
    // Recipe-import boundary (paprika-import plan §2.5 / D30, acceptance §16.19).
    //
    // The importer is disposable; the pipeline is not. Everything downstream of
    // "here is a list of parsed candidates" — dedupe, probe/commit/comparison,
    // attribution, the review flow, the session row, telemetry — is generic and
    // consumes `ImportCandidate` from `@buttery/recipe-extract/import`. Adding
    // Mela or AnyList must mean writing a new importer module, not refactoring
    // these ones, and the only thing that keeps that true is that no pipeline
    // module can name Paprika. Review will not catch this on a Friday.
    files: [
      "services/web/src/server/recipe-import*",
      "services/web/src/server/recipe-import/**",
      "services/web/src/lib/recipe-import/**",
      "services/web/src/components/recipes/import/**",
      "packages/recipe-extract/src/import/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                // The bare subpath — the normal way to reach it.
                "@buttery/recipe-extract/paprika",
                "@buttery/recipe-extract/paprika/**",
                // Any path form that names the module: deep source paths, and the
                // relative hops available from inside `packages/recipe-extract`.
                "**/recipe-extract/paprika*",
                "**/recipe-extract/paprika*/**",
                "**/recipe-extract/src/paprika*",
                "**/recipe-extract/src/paprika*/**",
                "**/paprika",
                "**/paprika.*",
                "**/paprika/**",
              ],
              message:
                "The importer is replaceable; the pipeline is not (plan §2.5 / D30). No module in the import pipeline may name Paprika — consume `ImportCandidate` from `@buttery/recipe-extract/import` and reach the importer through the registry, `services/web/src/lib/recipe-import/importers.ts`, which is the sole legal importer of Paprika code. Adding an importer must be a new module, not a refactor of this one. See docs/plans/2026-08-09-paprika-import.md §2.5 and acceptance criterion §16.19.",
            },
          ],
        },
      ],
    },
  },
  {
    // The one exemption: the importer registry maps importer id → `RecipeImporter`
    // and is the only place the string `paprika` is allowed to appear (§2.5).
    files: ["services/web/src/lib/recipe-import/importers.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
);
