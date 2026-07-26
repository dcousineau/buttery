import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/.tanstack/**", "**/.nitro/**", "**/.output/**", "services/web/src/routeTree.gen.ts", "packages/lexicons/src/generated/**"],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
);
