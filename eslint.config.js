import js from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/.tanstack/**", "**/.nitro/**", "**/.output/**", "services/web/src/routeTree.gen.ts", "packages/lexicons/src/generated/**"],
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
);
