# Local patches to the recipe.exchange lexicons

The `exchange.recipe.*` lexicons published on the AT Protocol network
(`did:plc:4cx7ts7lqgjtsfquo53qo3sz`, resolved via the `_lexicon.recipe.exchange`
DNS record) predate `@atproto/lex`'s stricter Lexicon validator. `@atproto/api`'s
older, laxer validator accepts them as-is, but `@atproto/lex` (lex-schema 0.2.2)
rejects several non-conformant constructs.

To generate typed code we vendor the four lexicons into `lexicons/` and apply the
patches below. **Re-check these whenever you re-pull the upstream lexicons** (they
are hand edits, not tracked by `lexicons.json`'s CID manifest — that manifest only
covers the network-installed deps `app.bsky.embed.defs` and
`com.atproto.repo.strongRef`).

## Patches

| File         | Path                                                              | Upstream                | Patched to                     | Why                                                                                                                                                                          |
| ------------ | ----------------------------------------------------------------- | ----------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| recipe.json  | `nutrition.fatContent` / `proteinContent` / `carbohydrateContent` | `type: number`          | `type: string`                 | Lexicon has no float type; **on the wire these are strings** (e.g. `"5.0"`), so `string` is both valid and wire-accurate. `calories` is a genuine integer and is left as-is. |
| recipe.json  | `nutrition` (property)                                            | inline `type: object`   | `ref` → `#nutrition` def       | Lexicon forbids inline nested objects; must be a named def.                                                                                                                  |
| defs.json    | `attributionShow.airDate`                                         | `format: date`          | (format removed)               | `date` format unsupported by lex-schema 0.2.2 (only `datetime` is).                                                                                                          |
| profile.json | `email`                                                           | `format: email`         | (format removed)               | `email` format unsupported by lex-schema 0.2.2.                                                                                                                              |
| profile.json | `address.latitude` / `longitude`                                  | `type: number`          | `type: string`                 | No float type. Wire encoding **unverified** (no live profile records exist yet); `string` chosen to match the recipe nutrition convention.                                   |
| profile.json | `address` (property)                                              | inline `type: object`   | `ref` → `#address` def         | Inline nested object → named def.                                                                                                                                            |
| profile.json | `links.items`                                                     | inline `type: object`   | `ref` → `#link` def            | Lexicon forbids arrays of inline objects.                                                                                                                                    |
| profile.json | `profileType` / `businessType`                                    | `union` of `token` defs | `type: string` + `knownValues` | Lexicon unions are for object defs, not tokens. Rewritten to match recipe.exchange's **own** enum pattern (`recipeCategory` etc. already use `string`+`knownValues`).        |

## Read path

`exchange.recipe.recipe` records fetched over XRPC arrive as JSON. Blobs, bytes,
and CID links must be lifted into lex's data model with `jsonToLex(...)` before
`$parse` / `$safeParse` — otherwise valid blobs fail with `expected: ['blob']`.
See `src/lib/atproto/recipes.ts`.
