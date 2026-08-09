# @buttery/recipe-schemas

The recipe interchange vocabularies Buttery speaks, co-located so each can be read and updated against its own spec.

| Directory     | What it owns                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `schema-org/` | [schema.org/Recipe](https://schema.org/Recipe) — read (imports) and write (the JSON-LD we publish) |
| `hrecipe/`    | [microformats hRecipe](https://microformats.org/wiki/hrecipe) and mf2 `h-recipe` — read only       |
| `bridge/`     | Crosswalks to `exchange.recipe.*`, the atproto lexicon that stays the canonical model              |
| `normalize/`  | Shared value cleanup: whitespace, relative URLs, ISO-8601 durations                                |

The atproto lexicon itself lives in `@buttery/lexicons` and is generated from `lexicons/*.json` — it is not duplicated here.

## Rules

- **Pure data.** No DOM, no network, no runtime dependencies. Finding a recipe inside an HTML document is `@buttery/recipe-extract`'s job.
- **Vocabularies don't know about each other, or about us.** `schema-org/` and `hrecipe/` never import each other or `@buttery/lexicons`. `bridge/` is the only place both sides meet.
- **Hand-written types are the source of truth.** `zod` is an _optional peer dependency_ and is imported only inside `*/zod.ts`, behind its own subpath export — code that needs compile-time types never pulls zod into its graph. Each zod schema is `satisfies`-checked against its type, with an exported `Assert*` alias closing the loop the other way.

## Imports

```ts
import type { SchemaOrgRecipe } from "@buttery/recipe-schemas/schema-org";
import { coerceRecipe, isRecipeNode } from "@buttery/recipe-schemas/schema-org";
import { HRECIPE_PROPERTY_CLASSES } from "@buttery/recipe-schemas/hrecipe";
import { lexiconToSchemaOrg, schemaOrgToLexicon } from "@buttery/recipe-schemas/bridge";

// Only this one needs zod installed:
import { schemaOrgRecipeSchema } from "@buttery/recipe-schemas/schema-org/zod";
```

## Reading a page

Parsers hand a vocabulary-shaped object to a crosswalk; they never map fields themselves:

```
HTML ─┬─ <script ld+json>        ─┐
      ├─ [itemprop] walk         ─┴─► WireRecipe ─► schemaOrgToLexicon() ─┐
      └─ .h-recipe / .hrecipe    ───► RawHRecipe ─► hRecipeToLexicon()  ──┴─► ExtractedRecipe
```

Because microdata's `itemprop` names _are_ schema.org property names, JSON-LD and microdata converge on one `WireRecipe` and share a single crosswalk — a coercion fix for one is a fix for both.

## Writing a page

```
RecipeDetailData ─► lexiconToSchemaOrg() ─► SchemaOrgRecipe ─► JSON.stringify ─► <script type="application/ld+json">
```

`lexiconToSchemaOrg` takes a structural `SchemaOrgEmitSource` rather than a lexicon record: the web app emits from its rendered read model, which carries app vocab slugs and display strings. The `SchemaOrgRecipe` return type is the fence — a property that isn't in the spec model can't be shipped by accident.

## Adding a field

1. Add it to the vocabulary's `types.ts`.
2. Narrow it in that vocabulary's `coerce.ts`.
3. Map it in `bridge/` (both directions for schema.org).
4. Mirror it in `zod.ts` — the `Assert*` alias fails to compile until you do.
