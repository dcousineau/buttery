# @buttery/lexicons

atproto lexicon schemas for buttery, plus the TypeScript generated from them via
[`@atproto/lex`](https://www.npmjs.com/package/@atproto/lex).

- **Source of truth (committed):** `lexicons/*.json` schema documents,
  `lexicons.json` manifest + resolutions, and `lexicons/PATCHES.md` (diffs from
  the on-network lexicons — see that file).
- **Generated (gitignored):** `src/generated/` — regenerate with `pnpm build`.

Consumers import generated modules by subpath, e.g.

```ts
import recipe from "@buttery/lexicons/exchange/recipe/recipe";
```

`@atproto/lex` is a runtime dependency: generated modules import the schema
util `l` from it.

## Scripts

- `pnpm build` — regenerate `src/generated/` from the JSON lexicons.
- `pnpm lex:install` — fetch/update lexicon documents + resolutions in
  `lexicons.json`.
