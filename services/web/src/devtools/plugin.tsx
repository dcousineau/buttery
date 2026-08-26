import { createReactPlugin } from "@tanstack/devtools-utils/react";
import { RecipeInspectorPanel } from "./RecipeInspectorPanel";

/**
 * Registers the recipe inspector with the TanStack Devtools shell
 * (`__root.tsx`'s `<TanStackDevtools plugins={[...]}>`).
 *
 * ── `createReactPlugin` RETURNS A PAIR OF FACTORIES, NOT PLUGINS ──────────
 * Verified against the installed `@tanstack/devtools-utils@0.7.0` types
 * (`dist/react/esm/plugin.d.ts`): the pair is `[() => TanStackDevtoolsPlugin,
 * () => TanStackDevtoolsPlugin]` — each element is a zero-arg function that
 * *produces* the `{ name, id, defaultOpen, render }` shape, not the shape
 * itself. So the pair is called once, immediately below, to pick one; it is
 * not spread straight into `plugins={[...]}`.
 *
 * ── WHY THE NO-OP HALF MATTERS ────────────────────────────────────────────
 * The real half's `render` closes over `RecipeInspectorPanel`, which pulls in
 * `getRecipeDebug` from `#/lib/api` — the only path allowed to reach
 * `#/server/recipe-debug`'s `createServerFn` handle (see `api.spec.md`; a
 * devtools module can't import `#/server/**` directly). The no-op half's
 * `render` is a bare `<Fragment />` that never touches `Component`, so
 * picking it by `import.meta.env.DEV` is what a production build's dead-code
 * elimination needs to drop this panel — and that server-fn reference —
 * entirely, rather than just hiding it behind a runtime flag.
 */
const [createRecipeInspectorPlugin, createNoOpRecipeInspectorPlugin] = createReactPlugin({
  name: "Recipe inspector",
  id: "recipe-inspector",
  defaultOpen: false,
  Component: ({ theme }) => <RecipeInspectorPanel theme={theme} />,
});

export const recipeInspectorPlugin = import.meta.env.DEV ? createRecipeInspectorPlugin() : createNoOpRecipeInspectorPlugin();
