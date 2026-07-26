# Lexicons & the `exchange.recipe.*` Schema

Verified 2026-07-25 by fetching the raw JSON from recipe.exchange and the canonical lexicons from
`bluesky-social/atproto`.

---

## 1. The publisher chain — verified end to end

- DNS TXT `_lexicon.recipe.exchange` → `did=did:plc:4cx7ts7lqgjtsfquo53qo3sz`
- That repo holds exactly four `com.atproto.lexicon.schema` records, rkey = the full NSID:
  - `at://did:plc:4cx7ts7lqgjtsfquo53qo3sz/com.atproto.lexicon.schema/exchange.recipe.recipe`
  - `.../exchange.recipe.collection`
  - `.../exchange.recipe.defs`
  - `.../exchange.recipe.profile`
- Mirrored as static JSON at `https://recipe.exchange/lexicons/<nsid>.json`
- **`exchange.recipe.recipe` record CID: `bafyreid2sk4riiiibh7hjm5f7f74cc6iikby33wujupr2rhpupu`**
- Author: [@joshhuckabee.com](https://bsky.app/profile/joshhuckabee.com). Listed in
  [awesome-lexicons](https://github.com/lexicon-community/awesome-lexicons).
- recipe.exchange itself is **closed source and uses app passwords, not OAuth**. Their
  [May 2026 update](https://recipe.exchange/updates) explicitly invites other developers to use the
  schemas. **Buttery would be the second app on the namespace and the first open one.**

⚠️ **Action:** vendor a pinned copy of the JSON and diff against the live record in CI. The publisher
can `putRecord` a new schema version at any time and your codegen would silently drift.

---

## 2. `exchange.recipe.recipe` — verbatim structure

`type: record`, `key: tid`.
Required: `name`, `text`, `ingredients`, `instructions`, `createdAt`, `updatedAt`.

| Field                                 | Type       | Req | Constraints                                                                    |
| ------------------------------------- | ---------- | :-: | ------------------------------------------------------------------------------ |
| `name`                                | string     |  ✔  | maxLength 255                                                                  |
| `text`                                | string     |  ✔  | maxLength 3000 — the description                                               |
| `ingredients`                         | `string[]` |  ✔  | items maxLength 500. **Flat strings. No quantity/unit structure.**             |
| `instructions`                        | `string[]` |  ✔  | items maxLength 1000                                                           |
| `createdAt`                           | string     |  ✔  | format `datetime`                                                              |
| `updatedAt`                           | string     |  ✔  | format `datetime`                                                              |
| `attribution`                         | union      |     | 6 refs into `defs` — see below                                                 |
| `langs`                               | `string[]` |     | maxLength 3, format `language` (BCP 47)                                        |
| `embed`                               | ref        |     | `#imagesEmbed`                                                                 |
| `prepTime` / `cookTime` / `totalTime` | string     |     | format `duration`                                                              |
| `recipeYield`                         | string     |     | free text                                                                      |
| `recipeCategory`                      | string     |     | `knownValues: ["exchange.recipe.defs#recipeCategory"]`                         |
| `recipeCuisine`                       | string     |     | `knownValues: ["exchange.recipe.defs#recipeCuisine"]`                          |
| `cookingMethod`                       | string     |     | `knownValues: ["exchange.recipe.defs#cookingMethod"]`                          |
| `suitableForDiet`                     | `string[]` |     | items `knownValues: ["exchange.recipe.defs#diet"]`                             |
| `nutrition`                           | object     |     | `calories` (int), `fatContent`/`proteinContent`/`carbohydrateContent` (number) |
| `keywords`                            | `string[]` |     | items maxLength 64                                                             |

**Sub-defs:**

- `#imagesEmbed` → `{ images: ref[] → #image, maxLength 4 }` (required)
- `#image` → required `image` (**blob**, `accept: ["image/*"]`, **`maxSize: 1000000` = 1 MB**) and
  `alt` (string, required); optional `aspectRatio` → **`app.bsky.embed.defs#aspectRatio`**
  ← note this drags a Bluesky lexicon into your codegen inputs
- `#view` / `#viewImage` → AppView projection: `thumb`, `fullsize` (uri), `alt`, `aspectRatio`.
  Descriptions say "CDN location provided by recipe.exchange" — **Buttery serves its own** or reads
  blobs from the user's PDS via `com.atproto.sync.getBlob`.

### ⚠️ Schema defect: the `knownValues` are dangling refs

`exchange.recipe.defs` defines **tokens** named `categoryAppetizer`, `cuisineItalian`,
`cookingMethodBaking`, `dietVegan`, etc. It does **not** define defs named `recipeCategory`,
`recipeCuisine`, `cookingMethod`, or `diet` — confirmed by fetching the file.

All four `knownValues` entries point at nonexistent defs. Practically harmless (`knownValues` is
non-enforcing by spec — "Values are not limited to this set"), but it means **there is no
machine-readable enum**. Consequences:

- Buttery must hardcode the vocabulary from `defs.json`.
- In practice these fields are **free strings**.
- The intended wire value is ambiguous: bare `cuisineItalian` vs full
  `exchange.recipe.defs#cuisineItalian`. **Check what recipe.exchange actually writes** before
  choosing, and be liberal on read.

### The `defs` vocabulary (verified counts)

- 11 `cookingMethod*` — air frying, baking, broiling, grilling, frying, roasting, sautéing,
  steaming, slow cooking, pressure cooking, no cook
- ~11 `diet*` — low fat, low calorie, low carb, vegetarian, vegan, gluten free, diabetic, halal,
  kosher, paleo, keto
- ~15 `category*` — appetizer, beverage, breakfast, brunch, cocktail, dessert, dinner, entree,
  garnish, kid friendly, lunch, salad, side, snack, soup
- ~31–33 `cuisine*` — African … Vietnamese
- 6 `license*` — all rights, CC-BY, CC-BY-SA, CC-BY-NC, CC-BY-NC-SA, public domain
- 2 `publicationType*`, 2 `profileType*`, ~18–21 `businessType*`

**`attribution*` are objects, not tokens** (this part is well designed):

| Def                      | Required                                         | Optional                                            |
| ------------------------ | ------------------------------------------------ | --------------------------------------------------- |
| `attributionOriginal`    | `license` (inline enum of the 6 license strings) | `url`                                               |
| `attributionPerson`      | `name`                                           | `url`, `notes`                                      |
| `attributionPublication` | `title`, `author`                                | `publisher`, `isbn`, `page`, `type`, `url`, `notes` |
| `attributionWebsite`     | `name`, `url`                                    | `notes`                                             |
| `attributionShow`        | `title`, `network`                               | `episode`, `airDate`, `url`, `notes`                |
| `attributionProduct`     | `brand`, `name`                                  | `upc`, `url`, `notes`                               |

---

## 3. `exchange.recipe.collection` — verbatim

`type: record`, `key: tid`. Required: `name`, `createdAt`, `updatedAt`.

```jsonc
{
  "name": { "type": "string", "maxLength": 100 }, // required
  "text": { "type": "string", "maxLength": 1000 },
  "langs": { "type": "array", "maxLength": 3, "items": { "type": "string", "format": "language" } },
  "recipes": {
    "type": "array", // ← NO maxLength
    "items": { "type": "ref", "ref": "com.atproto.repo.strongRef" },
  },
  "createdAt": { "type": "string", "format": "datetime" }, // required
  "updatedAt": { "type": "string", "format": "datetime" }, // required
}
```

Two things follow immediately, and both are load-bearing for Buttery:

1. **The community lexicon chose the embedded-array pattern for cookbooks.** All the tradeoffs of
   that choice — read-modify-write cost, lost updates, size ceiling, no reverse lookup — are now
   yours. See `03-record-crud-and-collections`.
2. **There is no visibility field.** Private collections and the meal planner **cannot** be PDS
   records under the current lexicon, regardless of how you feel about it. recipe.exchange's own
   "private recipes" feature is therefore app-side state too. `[inferred, strong]`

## 4. `exchange.recipe.profile`

`key: literal:self`. Required `createdAt`, `profileType` (union → `profileTypePersonal` /
`profileTypeBusiness`). Optional: `businessType` (union of the businessType tokens), `about` (2000),
`email` (format email, 255), `phone` (20), `address` (street1, street2, city, state, postalCode,
country, latitude/longitude as numbers), `links` (max 5 of `{title ≤100, url ≤2048}`), `updatedAt`.

---

## 5. Lexicon fundamentals you'll actually need

### NSID rules

ASCII only, ≥3 segments, ≤317 chars. Domain authority ≤253 chars, ≥2 segments, each 1–63 chars,
`[a-z0-9-]`, no leading/trailing hyphen, TLD can't start with a digit, **normalized to lowercase**.
Final _name_ segment: 1–63 chars, **letters and digits only — no hyphens**, must start with a
letter, **case-sensitive and NOT normalized**.

So `app.buttery.cookBook` is valid; `app.buttery.cook-book` is not.

### Types

Concrete: `boolean`, `integer`, `string`, `bytes`, `cid-link`, `blob` (with `accept` MIME patterns +
`maxSize`). Containers: `array`, `object`. Meta: `token` (an empty named constant — never referenced
via ref/union), `ref`, `union`, `unknown`. Sub-types: `params`, `permission`.

String formats: `at-identifier`, `at-uri`, `cid`, `datetime`, `did`, `handle`, `nsid`, `tid`,
`record-key`, `uri`, `language`. `datetime` requires uppercase `T`, **mandatory timezone**, ≥ms
precision recommended; `-00:00` is invalid.

`maxLength`/`minLength` on strings are **UTF-8 bytes**; `maxGraphemes`/`minGraphemes` are separate.

### `knownValues` vs `enum`

`knownValues` is an **open** suggestion list — validation does _not_ fail on unlisted values.
`enum` is a **closed**, enforced set. (Which is why the dangling-ref defect above is harmless.)

### Unions

Default is **open** (`closed: false`) — future revisions may add refs, so validators must be
permissive and pass unrecognized variants through. **Union variants always carry `$type`**; a plain
`ref` to an object does not. Refs cannot chain.

### Evolution rules — the constraint that shapes Buttery

> _All old data must still be valid under the updated Lexicon, and new data must be valid under the
> old Lexicon._

| Compatible                                 | Breaking                                  |
| ------------------------------------------ | ----------------------------------------- |
| Adding fields — **but only optional ones** | Changing a field's type                   |
| Marking fields deprecated (they must stay) | Renaming or removing a field              |
| Adding refs to an **open** union           | Making an optional field required         |
| Adding `knownValues`                       | Adding to a **closed** union or an `enum` |
|                                            | Tightening `maxLength`                    |

Breaking changes **require a new NSID**.

**Therefore: you cannot extend `exchange.recipe.recipe`.** Everything Buttery-specific —
structured ingredients (quantity/unit/item parsed out of those flat strings), private notes,
meal-plan slots, cook-along step timings, household provenance — must live in:

- **separate records under a namespace you control** (public, interoperable-if-anyone-cares), or
- **Postgres** (private, or app-canonical data like a normalized ingredient catalog).

**Steal Bookhive's "hive" split.** They keep a canonical shared book catalog (`hive_book`) **only in
the app DB**, and the user's PDS record carries a `hiveId` pointer plus their own opinion. That is
exactly your `ingredients: string[]` problem — someone has to own the parse into
{quantity, unit, ingredient}, and it can't be the community lexicon. Own it in Postgres, key public
records to it by reference.

---

## 6. Publishing & resolving lexicons — it's live

Two-step: NSID → authority domain → DNS → DID → repo record.

1. Reverse the NSID authority. `exchange.recipe.recipe` → authority `exchange.recipe` → domain
   `recipe.exchange`.
2. TXT at `_lexicon.recipe.exchange` → `did=did:plc:...`
3. Fetch `at://<DID>/com.atproto.lexicon.schema/<full-NSID>` (rkey type is `nsid` — the rkey _is_
   the full NSID string).

**No hierarchical fallback.** If DNS resolution at the exact authority fails, resolution fails — no
parent-domain retry. Corollary: **all NSIDs sharing an authority must publish to the same DID.**

The `com.atproto.lexicon.schema` record's only declared property is `lexicon: integer` (must be `1`);
`id` and `defs` are described in prose because Lexicon can't express its own schema language.

Tooling: [`goat`](https://github.com/bluesky-social/goat) CLI — `goat lex pull <NSID>`,
`goat lex new record <NSID>`, `goat lex publish`, with diff/lint/verify. Runtime resolution:
[`@atproto/lexicon-resolver`](https://www.npmjs.com/package/@atproto/lexicon-resolver) and
`com.atproto.lexicon.resolveLexicon`. `ts-lex install <nsid>` pulls by NSID over the network.

Publishing is **not mandatory and not enforced** — nothing rejects records for unpublished lexicons.
It establishes a canonical authoritative representation.

**For Buttery's own namespace:** you need a domain whose reverse is your authority. `app.buttery.*`
requires controlling `buttery.app` and setting `_lexicon.buttery.app` TXT → your DID. NSIDs aren't
verified against DNS at write time, but using an authority you don't control breaks resolution and
is bad citizenship.

**What "pinning" to a community lexicon means** `[synthesis, not a spec term]`: Buttery writes
records with `$type: "exchange.recipe.recipe"` into the _user's_ repo, conforming to a schema Buttery
doesn't control. You don't own the evolution path; any app speaking that NSID can read and write your
users' recipes (that's the interop win); and you must pin + diff in CI.

---

## 7. Codegen and validation in TypeScript

**Current:** `@atproto/lex` 0.3.0 with the `ts-lex` CLI. This is what Statusphere uses and what the
`@atproto/api` README now points new projects at.

```
ts-lex build --importExt="" --out=./lib/lexicons --override
ts-lex install exchange.recipe.recipe          # pull from the network by NSID
```

Output is **generated at build, not committed**. Lexicon JSON files carry
`"$type": "com.atproto.lexicon.schema"` and live at NSID-shaped paths.

**Legacy:** `@atproto/lex-cli` (`lex gen-api`, `lex gen-server`) + `@atproto/lexicon` runtime
(`Lexicons` class → `validate()` / `assertValidRecord()`). Still maintained (0.10.6 / 0.7.7), but
`gen-server` is only relevant if Buttery exposes its own XRPC endpoints — which it doesn't need to.

**Alternative ecosystem:** `@atcute/*` (mary-ext) is a real, aggressively modular, ESM-first
alternative used in production by Bookhive (including `@atcute/oauth-node-client` for server-side
OAuth). It has runtime adapters the official SDK lacks (Cloudflare Workers, Deno, Bun). Caveats: one
maintainer, fast genuinely-breaking versioning, no LTS. **Recommendation: official packages for auth
(more eyes on the DPoP/PAR/refresh paths), atcute opportunistically elsewhere.** `[inferred]`

### Handling records that don't validate

The governing rule: _"If an individual record fails to validate for any reason, the entire record
should be ignored, but other records from the same repository should be processed."_

`validationStatus` on write responses is `"valid"` or `"unknown"` — **there is no `"invalid"`**.
`"unknown"` means the PDS had no schema for that NSID and stored it unvalidated.

**Buttery's ingest policy** `[inferred]`:

- Validate at ingest, but **persist raw JSON alongside a parsed projection**, marking rows
  `valid | unknown | invalid` rather than dropping. Anyone can write anything to their own repo.
- **Preserve unknown fields on `putRecord`.** Users' repos will contain recipes written by
  recipe.exchange and future apps, potentially with extra fields (legal under open unions). Never
  round-trip through a lossy parse — you'll destroy other apps' data on edit. This is a real risk the
  moment two apps share a namespace, and Buttery is deliberately the second app.
- Treat everything off the firehose as untrusted input.

---

## Sources

[recipe.exchange lexicons](https://recipe.exchange/lexicons/) ·
[recipe.exchange updates](https://recipe.exchange/updates) ·
[Lexicon spec](https://atproto.com/specs/lexicon) ·
[NSID spec](https://atproto.com/specs/nsid) ·
[Record key spec](https://atproto.com/specs/record-key) ·
[Data validation guide](https://atproto.com/guides/data-validation) ·
[Publishing lexicons](https://atproto.com/guides/publishing-lexicons) ·
[awesome-lexicons](https://github.com/lexicon-community/awesome-lexicons) ·
[goat](https://github.com/bluesky-social/goat) ·
[@atproto/lex](https://www.npmjs.com/package/@atproto/lex) ·
[@atproto/lexicon-resolver](https://www.npmjs.com/package/@atproto/lexicon-resolver) ·
[atcute](https://codeberg.org/mary-ext/atcute) ·
[bookhive](https://github.com/nperez0111/bookhive)
