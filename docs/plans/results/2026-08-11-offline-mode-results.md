# Results: Offline mode — Milestone 1 (offline reads)

Execution log for [`../2026-08-11-offline-mode.md`](../2026-08-11-offline-mode.md), **M1 only**.
M2 (idempotent offline writes) and M3 (sync hardening) are untouched.

M1's promise, in one sentence: **install Buttery on a phone, walk into a dead-wifi
kitchen or a shop, and the recipe box — list and every detail — the plan week and the
shopping list all still render.** Writes stay online-only and disable with an
affordance, because M2 is what makes them replay-safe.

---

## What shipped

### The port layer — `src/lib/api/` (§4.2, §4.3, §7)

| File                        | What it is                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `types.ts`                  | Every wire DTO, **declared here**; the server imports them from here. Reverses the old direction (§7).            |
| `transport.ts`              | The only client module allowed to name `#/server/**`. Plain functions, natural arguments, no `{ data }` envelope. |
| `keys.ts`                   | The §4.2 key namespace = the future REST namespace. `householdId` in every household key, in no validator.        |
| `queries.ts`                | `queryOptions` factories. **The offline boundary**: a route is offline-capable iff its data comes from here.      |
| `mutations.ts`              | `mutationOptions` with the optimistic lifecycle. Online-only in M1; the shape M2 slots into.                      |
| `errors.ts`                 | `isSessionExpired` / `isForbidden` / `isOffline` / `shouldRetry`, as predicates over wire shapes.                 |
| `index.ts`                  | The port surface consumers import.                                                                                |
| `no-server-imports.test.ts` | The scanner that pins the boundary (below).                                                                       |

~50 client modules moved onto the port. Two files moved with it, because the new rule
made their old homes wrong: `server/recipe-provenance.ts` → `lib/` (it always was a
client-safe pure module, and says so in its own header), and `lib/gate.ts` →
`server/gate.ts` (a `createServerFn` with a dynamic-import prologue is server business
logic by the AGENTS.md convention).

### Query, wired into the router (§4.1)

`getRouter()` builds a QueryClient per request/tab with `staleTime: 30s`,
`gcTime: 24h` — that one is not about memory, it is what gives the persister something
to write — plus `refetchOnReconnect` and `refetchOnWindowFocus`.
`setupRouterSsrQueryIntegration` streams the server cache into the client's.

Four routes migrated: `/household/recipes` (+ `$id`), `/household/plan`,
`/household/list`. Loaders call `ensureQueryData`, components call `useSuspenseQuery`
on the same factory. **Zero `router.invalidate()` remains on the migrated routes**;
invalidation is prefix-scoped.

Migrating the two optimistic-update libraries deleted more than it added. Both routes
carried a hand-rolled `useOptimistic` + transition + `whenLoaderCommits()` promise + a
1s escape hatch, all of it there to bridge two caches: `router.invalidate()` resolves
_before_ React commits the router's matches, leaving a window where the optimistic
value had been dropped and the settled one had not arrived — one frame of pre-write
data on every write, which both files document at length. Query has no such window
(the patch and the settled value are the same cache entry at different times), so the
machinery went with it. The pure patch functions and their tests are unchanged.

### Persistence — `src/lib/offline/` (§4.5)

Per-query IndexedDB persistence via `experimental_createQueryPersister` over
`idb-keyval`. `buster` folds in `CACHE_SCHEMA_VERSION` **and** the `(did, householdId)`
partition, so a household switch invalidates by construction (§2.4); `wipeCachePartition`
deals with the bytes already on disk, because "invalid on next read" is not a privacy
answer on a shared iPad (§2.7).

Quota: a refused write evicts the oldest half and retries once. It never rejects — an
app that fails to _render_ because it failed to _cache_ has the tradeoff backwards.

Three root-level reads used to make the app unusable offline and now fall back to a
persisted snapshot — **client-side only, and failing open**: the gate verdict, the
session (chrome only), and `requireActiveHousehold` (which is load-bearing, because a
household id is what every cache key is partitioned by). None of them authorizes
anything; every read they key is still a server function gated by `assertMember`.

### The mini-mirror (§4.6)

Walks the box in `requestIdleCallback` at concurrency 2, prefetching every detail not
already fresh. Pauses while hidden, offline, or in cook mode; parks after three
consecutive failures. Silent and best-effort, as §4.6 specifies — its only UI is that
offline recipe details work. Measured: **33 of 33 details cached within ~6 seconds** of
opening the box.

### The PWA shell (§4.4, §9)

- `manifest.json` had the right brand colors and was linked from nowhere — a CRA
  leftover, so nothing was ever installable. Now wired from `__root.tsx`, with
  `id`/`scope`/`start_url`, three shortcuts, and **maskable** icons.
- The shipped logos are the favicon with its own rounded corners baked in; a launcher
  rounds an already-rounded square and letterboxes it. `scripts/build-maskable-icons.ts`
  re-renders the same artwork full-bleed at the 80% safe zone, deterministically.
- `src/sw.ts`, hand-written, ~190 lines. §2.2 has to be auditable at a glance, and it
  is: `/_serverFn/*` and `/api/*` return `null` from `handle()` before anything else,
  so the worker is not in their path at all.
- `vite-plugins/service-worker.ts` runs a second Vite build in `closeBundle` (TanStack
  Start replaces the step `vite-plugin-pwa`/Serwist hook into — TanStack/router#4770).
- No `skipWaiting()`. A waiting worker surfaces a Reload banner; swapping the bundle
  under a running cook-mode timer is not acceptable.
- iOS install sheet, `viewport-fit=cover` + `env(safe-area-inset-*)` scoped to
  standalone display, `apple-mobile-web-app-*` meta.

### Writes, disabled offline (§4.1)

Every write affordance on the four migrated routes disables with one shared string.
Each has a reason it cannot simply queue, and the reason is in the code beside it:
the favourite toggle is server-side (replaying it flips twice), the shared recipe note
is where two people erase each other, the grocery sweeps touch a row set that _grows_
between queue-time and replay, and a manual grocery add merges quantities. §5.2 is the
list of which of these M2 fixes and how.

---

## Verification

`pnpm test` (490 passed, 179 DB-suite skipped), `tsc` for the app **and** for
`tsconfig.sw.json` (the worker needs `lib: WebWorker`, which contradicts `DOM`),
`oxlint`, `oxfmt --check`: all green. `pnpm --filter @buttery/web build` produces
`dist/client/sw.js`.

Beyond that, M1 was exercised **in a real browser against a production build** —
Chromium via Playwright, srvx serving `dist/`, signed in through the local atproto
dev-env, 33 seeded recipes. Offline was the browser's own offline mode
(`navigator.onLine === false`, every request fails), not a stopped server.

| §4.7 acceptance                                             | Result                                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Zero `#/server/**` imports outside `transport.ts`           | ✅ enforced by lint **and** by the scanner test                                                              |
| Migrated routes read via `queryOptions` only                | ✅                                                                                                           |
| SW registers, precaches, controls                           | ✅ 111 assets + `/offline`, activated, controlling                                                           |
| Offline hard reload renders the shell, not the browser page | ✅ full app chrome and sidebar at the requested URL                                                          |
| Box list renders offline                                    | ✅ all 33 rows                                                                                               |
| **An unvisited recipe's detail** renders offline            | ✅ full ingredients + method + timers, for a recipe never opened on that profile                             |
| Shopping list renders offline                               | ✅, with every write affordance disabled and the field reading "You're offline"                              |
| Update flow surfaces a toast, no silent swap                | ✅ the banner appeared on a second build; no `skipWaiting`                                                   |
| Household switch / sign-out wipes the partition             | ⚠️ implemented, not yet exercised (one household in the test environment)                                    |
| Lighthouse PWA audit                                        | ⚠️ not run — no Lighthouse in this container                                                                 |
| **Device pass on a real iPhone**                            | ❌ **not done, and required before shipping** — a simulator reproduces neither eviction nor the SW lifecycle |

### Four bugs the browser found that no unit test would have

1. **SSR-hydrated queries were never persisted.** The persister wraps `queryFn`; a
   query hydrated from the dehydrated payload never fetches, so on a cold SSR'd load
   the data was on screen, in memory, and nowhere on disk. Caught by seeing IndexedDB
   hold all 33 mirrored _details_ (prefetched, so they go through `queryFn`) and not
   the _list_ they came from. Fixed with `persistHydratedQueries` + a cache
   subscription (`persister.ts`).
2. **The gate snapshot was never written**, for the same reason one level up: the root
   loader runs on the server and the client-side one never executes, so a
   `cacheGateState` call inside it wrote nothing in the browser. Moved to the render.
3. **A partial install produced an active worker that could not serve offline.** Every
   precache entry used `cache.add(...).catch(() => undefined)`, so an install
   interrupted partway left a worker active with 75 of 105 entries and **no
   `/offline`** — offline navigation then failed outright with the browser's own error
   page. The shell is no longer optional: its rejection fails the install, so the
   browser keeps the previous working worker and retries.
4. **An uncached offline route was a dead end.** `/household/plan` with nothing stored
   fell through to the router's default boundary — a bare "Something went wrong!" and a
   Show Error button, on a page with no header and no way back. Now `OfflineRouteError`
   says "Not saved for offline yet" in the app's voice with a Try again, and re-throws
   anything that is not a network failure so a real bug is never disguised as a blip.

Also caught, by the scanner rather than the browser: **two shipped routes imported
`../server/recipes` by relative path**, which the lint rule's subpath globs had waved
through. Fixed, and the globs widened.

---

## Deliberate deviations from the plan

- **The `#/server/**` ban has two exemptions, not one.** `transport.ts` as specified,
  plus `lib/recipe-import/contracts.ts` — the import flow's pre-existing, documented,
  **type-only** port. It restates no shape (`import type` is erased at build time), and
  §1.1 keeps the whole import flow online-only and uncached permanently, so the reason
  the other DTOs had to move does not apply to it. Moving its ~20 interleaved contract
  types would have been a large diff for a flow that is out of scope by design. The
  scanner asserts the exemption stays type-only, so it cannot quietly grow a value
  import.
- **Wire types moved for the surfaces the client touches**, not for every type in
  `src/server/**`. The set is exactly what the client imports; server-internal row
  shapes stayed put.
- **`requireActiveHousehold` got an offline fallback**, which §4.4 does not list —
  it names the gate and the session. It has to: a household id is what partitions every
  cache key, so without one the rows in IndexedDB cannot be addressed at all.
- **Route context, not a hook, is how migrated routes get the household id.** §4.1 asks
  for `useActiveHouseholdId()`, and it exists and is used by components below the
  routes; the routes themselves resolve it in `beforeLoad` so loaders and the `$id`
  child share one SSR-stable value.
- **No `householdPreferencesQuery` / `householdMembersQuery`.** Both keys are reserved
  in `keys.ts`, but neither resource is read by a migrated route (the planner takes
  `weekStartDay`/`timezone` off the `PlanWeek` payload), and a factory is a promise
  that a resource is offline-capable.
- **`@resvg/resvg-js` added to the root `devDependencies`** so the icon script can
  resolve it. Already a dependency of `services/web`; the script is a root-level tool.

## Open items

1. **Device pass on a real iPhone — required.** Install to the home screen, airplane
   mode, full read cycle including cook mode with timers. §9.1's seven-day eviction and
   the SW lifecycle are the two things a container cannot reproduce.
2. **Lighthouse PWA audit** against a deployed build.
3. **Household switch / sign-out wipe**, verified with two real households.
4. `CACHE_SCHEMA_VERSION` is 1. Bump it on any breaking change to a DTO in
   `src/lib/api/types.ts` — mismatched payloads are discarded, never migrated.
5. The mutation keys in `mutations.ts` are a **wire contract from now, not from M2**:
   renaming one after M2 ships orphans whatever is already queued in someone's
   IndexedDB.
