# Open Questions & Things to Verify Before Shipping

Compiled 2026-07-25. These are the places where research hit a wall, the answer was ambiguous, or
something is likely to change. Resolve each empirically rather than trusting this dossier.

---

## Must verify before writing production code

**1. The exact OAuth scope string that `bsky.social` accepts for `exchange.recipe.*`.**
There is no canonical `atproto.com/specs/permissions` page (404s). The grammar in
`01-identity-and-oauth` §3 is reconstructed from four sources. Run one live authorization flow
against `bsky.social` with your intended scope string and read back
`await session.getTokenInfo()`. Remember `session.scope` returns `undefined`.

**2. Whether `blob:image/*` alone is sufficient for `uploadBlob`,** or whether you also need
`rpc:com.atproto.repo.uploadBlob`. Test with a real image upload.

**3. Whether recipe.exchange publishes a permission set** you should `include:` rather than
enumerating `repo:` scopes. Ask in the community.

**4. The intended wire format for `recipeCategory` / `recipeCuisine` / `cookingMethod` /
`suitableForDiet`.** The `knownValues` refs are dangling (`02-lexicons` §2), so there's no
machine-readable enum. Bare token name (`cuisineItalian`) or full NSID
(`exchange.recipe.defs#cuisineItalian`)? **Read what recipe.exchange actually writes** — pull a few
real records via `listRecords` against a recipe.exchange user's repo. Be liberal on read regardless.

**5. How long a full network sweep actually takes.**
`listReposByCollection?collection=exchange.recipe.recipe` → count the DIDs → time a full
`listRecords` pass. That number decides your cron interval and whether Stage 1 (cron-only) is viable
past launch. Measure it before assuming.

**6. `@atproto/oauth-client-node` under TanStack Start's Vite/srvx server.**
No public example exists — you're first. Specifically test: does `ssr.external` correctly keep it out
of the bundle; does the callback route handler receive the raw query string; does the session cookie
survive the redirect. Budget a day.

---

## Watch for changes

**Permissioned data / spaces.** Proposals PR #94 is a draft; the Diary series runs to 2026-07-17 and
is ongoing. The moment `com.atproto.simplespace` is implementable against `bsky.social`, revisit
`05-private-vs-public-data`. Subscribe to [dholms.leaflet.pub](https://dholms.leaflet.pub/).

**The `exchange.recipe.*` schemas.** The publisher can `putRecord` a new version at any time.
Pin `bafyreid2sk4riiiibh7hjm5f7f74cc6iikby33wujupr2rhpupu` and **diff in CI**.

**Jetstream's rewrite.** `main` describes a full-network archive service, not yet in production, with
backwards-incompatible on-disk format changes. Irrelevant if you go with Tap.

**[jetstream#42](https://github.com/bluesky-social/jetstream/issues/42)** (drop/reorder at replay
cutover) — still open at last check. Also irrelevant with Tap.

**TanStack Start GA.** Still formally RC as of research date. Watch for the GA release and the
Nitro/srvx story settling.

**`@atproto/lex` vs `@atproto/api`.** The API README points new projects at `lex`, but there's no
formal deprecation in the changelog. Expect the split to clarify.

**PLC governance** moving to an independent PLC Organization. No action, but it's the layer your
users' identities depend on.

---

## Unresolved / no good answer exists

**Jetstream public-instance rate and connection limits.** Undocumented anywhere findable. Treat as
best-effort, unmetered-but-unpromised.

**Whether Bluesky operates a public hosted Tap instance.** Not mentioned in the announcement —
assume self-host.

**Constellation's exact endpoint paths.** Its docs are served from the live host, which was
unreachable through the research proxy. Hit `constellation.microcosm.blue` directly.

**`applyWrites` batch size limits.** No `maxLength` in the lexicon; PDS implementations impose their
own. Find the practical ceiling empirically before building a bulk importer.

**What happens to shared household artifacts when a member deletes their atproto account.** atproto
gives no guidance — this is a product decision. Recommendation in `05-private-vs-public-data` §4, but
**decide it and document it in your privacy policy.**

---

## Product decisions this research surfaced but can't make for you

**Should the meal planner and shopping list be public records at all?**
They _could_ be (in a namespace you control), which would make them portable and interoperable. They
probably _shouldn't_ be — "what my household is eating this week" is exactly the kind of thing people
assume is private, and a public record is permanently harvestable. Recommendation: private, in
Postgres, record-shaped. But it's a values call.

**How hard do you lean on the "pinned version" feature?**
Because strongRef CIDs go stale on every edit (`03-record-crud` §4), you _can_ offer "Grandma's
brisket, as it was when you saved it — the author has since changed the oven temp." That's a
genuinely differentiating feature for a recipe app, and it requires storing a full snapshot rather
than just a reference. Decide early; it changes your schema.

**Do you file the `collection.recipes` `maxLength` gap upstream?**
The lexicon sets no bound on a field that will fail writes at ~2 MB. Worth raising with
@joshhuckabee.com along with the dangling `knownValues` — you'd be improving the shared namespace,
and it starts a relationship with the only other app in it.

**Do you mint your own namespace now or later?**
Structured ingredients (quantity/unit/item) are the obvious first `<authority>.*` lexicon, and it's a
real contribution to the ecosystem. But it requires a domain whose reverse is your authority plus a
`_lexicon` TXT record, and every NSID under that authority must publish to the same DID. Cheap to do,
annoying to change. Decide the authority string before you write the first custom record.
