# API port

The one door between client code and `#/server/**` — plain async functions in, `queryOptions` / `mutationOptions` factories out.

## works when

- passes test "scans a client tree that actually exists"
- passes test "has no `#/server/**` import outside the two port modules"
- passes test "keeps the import-flow contract module type-only"
- passes test "routes every server function through the transport, by name"

## refutations

- one client module imports `#/server/**`: appended a **type-only** `import type { HouseholdRecipeRow } from "#/server/household-recipes"` to `src/lib/utils.ts` -> RED, "1 failed | 3 passed", naming the offender `lib/utils.ts -> #/server/household-recipes`. Reverted. Type-only is deliberately not a loophole: the exemption in `recipe-import/contracts.ts` is the only one, and it is asserted separately.

## why

This directory is its own component because it is the only place in the client tree
that is allowed to know `#/server/**` exists. That single rule is load-bearing three
times over, and none of the three is derivable from the code:

- **Offline is legible.** A route is offline-capable _if and only if_ its data comes
  from a factory in `queries.ts` — persister, refetch-on-reconnect, prefix
  invalidation and the mirror arrive together or not at all. A component that reaches
  past the port gets none of them, and nothing in its source would say so.
- **Extracting the API service is a one-file change.** Every call site speaks natural
  arguments (`getHouseholdRecipe(id)`), never the `{ data }` envelope TanStack Start
  actually wants. Rewriting `transport.ts` to `fetch()` is the whole migration.
- **Bundle hygiene has one place to look.** "Did this component just drag a server
  module into the client bundle?" is answered by reading one directory.

`transport.ts` is 78 exports of one-line wrappers on purpose. The wrappers are what
buy the exemption: a bare `export * from "#/server/…"` would leak the envelope to
every call site and make the port a barrel instead of a boundary — which is why the
fourth claim above asserts the wrapping is still happening.

The rule is pinned by a **scanner**, not only by the `no-restricted-imports` rule in
`.oxlintrc.json`, because those two fail differently. The lint rule gives a developer
a good error at the moment they type the import, but it only proves the boundary holds
for files that exist today — it says nothing about whether the rule is still _wired
up_. oxlint `overrides` are order-sensitive and last-match-wins, so widening a glob or
adding a fourth exemption disables it silently and every module still passes lint. The
scanner reads the client tree and asserts on the text, so it cannot be switched off
from configuration.

**No `## invariants` section yet, deliberately.** A `boundary` claim needs a chokepoint
symbol that exists in the code graph, and this invariant has none: it is a property of
the module _tree_, not of any one function, and the graph indexes exported declarations
only (measured — `transport`, and the scanner's own `ALLOWED` / `SERVER_IMPORT` consts,
all fail chokepoint lookup). Anchoring on an arbitrary export such as
`listHouseholdRecipes` would satisfy the parser while telling a reader nothing true.
The change that _would_ earn the anchor is real and small: lift the scanner's `ALLOWED`
exemption set out of the test into an exported const in this directory, so the
exemption becomes data with one home that both the oracle and a reader can find. The
claim then becomes `boundary "one client module imports #/server/**" at <that const>
via test "the client reaches the server only through src/lib/api (§4.3)"` — and the
oracle already passes the meta-oracle's live-domain analysis, so it would be a real
totality, not a hand-list wearing the label.
