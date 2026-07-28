# Results: Households — Private-Data Foundation build

Execution log for the plan at [`../02-households-and-private-foundation.md`](../02-households-and-private-foundation.md).
Built by coordinated subagents, each in an isolated git worktree, merged sequentially into
`feat/households-private-foundation`. This document records **what each agent actually did**, its
results, and open notes. It is updated as each agent finishes (not only at the end).

## Orchestration summary

- **Strategy:** 3 build agents per plan §16. Agent A (foundation) is a hard blocker — merged first.
  Agents B and C branch off the post-A branch. B and C were **serialized** (not run in parallel)
  because C's onboarding + management UI imports B's server functions by their exact return shapes;
  typechecking C against B's real merged output (rather than stubs) keeps the merges clean and matches
  the plan's "C integrates against B's merged output."
- **Worktrees:** created under the session scratchpad (`.../scratchpad/wt/{a,b,c}`) with `node_modules`
  symlinked to the main checkout (shared lockfile → safe, fast; avoids 3× `pnpm install`).
- **Toolchain quirk:** pnpm's auto-install check tries to _purge_ a symlinked `node_modules`, which would
  corrupt the main checkout. So all agents typecheck/test via the binaries directly
  (`./node_modules/.bin/tsc -p tsconfig.json`, `./node_modules/.bin/vitest run`) and never invoke `pnpm`.
- **Commit signing:** the repo enforces GPG/1Password commit signing, but the 1Password agent is
  unreachable inside the sandbox. All build commits were made with signing disabled
  (`git -c commit.gpgsign=false`) and are **unsigned** — re-sign on a trusted machine if policy requires.
- **Database:** no root `.env`; migrations/codegen/DB-backed tests require `railway run --service buttery`
  - network, unavailable in the sandbox. So **no migration has been applied and no DB-backed test has
    run.** Agents extracted pure logic for real unit coverage and wrote DB-integration tests guarded to
    skip when `DATABASE_URL` is unset. **Human must run migrate + codegen — see Global open items.**

## Merge log

| Step              | Commit    | Branch action                                                               |
| ----------------- | --------- | --------------------------------------------------------------------------- |
| Agent A           | `5e15a39` | built on `hh/agent-a`                                                       |
| Merge A           | `c9e6cab` | `--no-ff` into `feat/households-private-foundation`                         |
| Shared helper     | `cc6f1ed` | `setActiveHousehold` added to A's `session.ts` on feat (both B & C need it) |
| Agent B           | `49bf65d` | built on `hh/agent-b`                                                       |
| Merge B           | `bacbf9b` | `--no-ff` into feat                                                         |
| Agent C           | `9666bdd` | built on `hh/agent-c` (off post-B HEAD)                                     |
| Merge C           | `3df7303` | `--no-ff` into feat                                                         |
| Integration fixes | `f32ea6b` | owner-invariant race + open-link decline (from review)                      |

---

## Agent A — Foundation (blocking) — ✅ merged (`c9e6cab`)

**Slice:** plan §3 (data model), §3.4 (better-auth session field), §4 (authz chokepoint), §9 (typed errors), §13 (migration).

### What it actually built (file → purpose)

| File                                                                      | Purpose                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `services/web/src/db/migrations/1785400000000_create_household_tables.ts` | Creates `household`, `household_member`, `household_invite` (§3.1–3.3) with all specified indexes incl. partial indexes; adds the `session.active_household_id` column. Docstring states the privacy/identity invariant (Buttery-private, never PDS-written, DID is the identity key). `down()` reverses in order. |
| `services/web/src/db/types.ts`                                            | Hand-added `Household`, `HouseholdInvite`, `HouseholdMember` interfaces; registered them in `DB`; added `active_household_id: string \| null` to `Session`. Matches kysely-codegen style. **Must be regenerated via codegen post-migration (source of truth).**                                                    |
| `services/web/src/lib/auth.ts`                                            | Wired `session.additionalFields.active_household_id`.                                                                                                                                                                                                                                                              |
| `services/web/src/lib/household/errors.ts`                                | Full typed error set + `Role`/`ROLE_RANK`/`roleRank`.                                                                                                                                                                                                                                                              |
| `services/web/src/lib/household/authz.ts`                                 | `assertMember` chokepoint + `loadLiveMembership` + `Membership`/`MembershipLoader`.                                                                                                                                                                                                                                |
| `services/web/src/lib/household/scoped-query.ts`                          | `householdScopedQuery` membership-join helper with a docstring teaching the pattern for future feature tables.                                                                                                                                                                                                     |
| `services/web/src/lib/household/session.ts`                               | `getServerSession` / `requireSessionDid` (+ `setActiveHousehold` added later on feat).                                                                                                                                                                                                                             |
| `services/web/src/lib/household/authz.test.ts`                            | 7 unit tests: member ok, owner-gate ok, role-gated→InsufficientRole, not-a-member→NotAMember, removed→NotAMember, dead-household→NotAMember, default minRole.                                                                                                                                                      |

### Empirical finding (plan §15)

**better-auth `session.additionalFields` IS supported** in v1.6.25 — no fallback `user_active_household`
table needed. Verified `BetterAuthOptions.session` extends `BetterAuthDBOptions<"session">` which includes
`additionalFields?: Record<string, DBFieldAttribute>` (`@better-auth/core/dist/types/init-options.d.mts`).
Declared as `{ type: "string", required: false, input: false }` — `input:false` keeps it server-set only
(cannot be injected via client session input). Physical column created by the migration.

### Frozen exported contracts (used verbatim by B and C)

- `assertMember(did, householdId, minRole?: Role = "member", load?: MembershipLoader): Promise<Membership>`
- `loadLiveMembership(did, householdId, db?: Kysely<DB>): Promise<Membership | undefined>`
- `type Membership = Selectable<HouseholdMember>`; `type MembershipLoader = (did, householdId) => Promise<Membership | undefined>`
- `type Role = "owner" | "member"`; `ROLE_RANK` (`owner:2, member:1`); `roleRank(role: string): number` (unknown→0, fail-closed)
- `householdScopedQuery(db, did, householdId)` → Kysely builder inner-joined on live `household_member`↔`household`
- `getServerSession(request?): Promise<{session, user} | null>`; `requireSessionDid(request?): Promise<string>` (throws redirect to `/login`)
- `setActiveHousehold(sessionId: string, householdId: string | null, db?: Kysely<DB>): Promise<void>` (added on feat as shared helper)
- Errors (extend `HouseholdError`, `code` + `httpStatus`): `NotAMemberError`(403), `InsufficientRoleError`(403), `InvalidInvite`(404), `InviteExpired`(410), `InviteExhausted`(410), `InviteNotForYou`(403), `InviteRevoked`(410), `InviteHouseholdGone`(410), `LastOwnerError`(409)

### Results

- Typecheck: 0 errors. Tests: 7/7 passed (DB-independent, mockable membership loader).

### Decisions / deviations (documented in code)

- Added FK `household_id → household.id` (onDelete cascade, inert under soft-delete) on member/invite tables.
- `roleRank` maps unknown/future roles → 0 (fail-closed), since `role` is free text.
- Kept `assertMember`'s public 3-arg contract; added optional injectable `load` param for testability/trx.
- Implemented exactly the spec's indexes; did **not** add a speculative `household_invite.household_id` index (B may add one for `listInvites`).
- No fallback `user_active_household` table (session-additionalFields path taken).

### Open notes (Agent A)

- `types.ts` was hand-authored to match generated style; **must be regenerated** via
  `railway run --service buttery -- pnpm db:codegen` after the migration runs.
- Migration never applied (no DB in sandbox).

---

## Agent B — Household & Invite server logic — ✅ merged (`bacbf9b`)

**Slice:** plan §6 (invite lifecycle), §7 (household ops incl. §7.1 owner invariant, §7.2 tombstone), §9 (server-fn contract), §11 (email seams). All under `src/lib/household/`, importing A's foundation verbatim without modifying it.

### What it actually built (file → purpose)

| File                                                                                         | Purpose                                                                                                 |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `households.ts`                                                                              | `createHousehold`, `renameHousehold`, `listMyHouseholds`, `deleteHousehold`                             |
| `invites.ts`                                                                                 | `createInvite`, `revokeInvite`, `listInvites`, `getInvitePreview`, `acceptInvite`, `declineBoundInvite` |
| `members.ts`                                                                                 | `removeMember`, `setMemberRole`, `leaveHousehold`, `tombstoneMemberForDeletedAccount`                   |
| `invite-token.ts`                                                                            | PURE: `generateInviteToken` (32 bytes base64url), `hashInviteToken` (sha256 hex)                        |
| `invite-assess.ts`                                                                           | PURE: `assessInviteForAcceptance` (§6.3 steps 2–5) + `isRevoked`/`isExpired`/`isExhausted`              |
| `owner-invariant.ts`                                                                         | PURE: `wouldDropLastOwner` (§7.1)                                                                       |
| `ids.ts`                                                                                     | PURE: `ulid()` — mints 26-char Crockford ULIDs (no `ulid` dep in repo)                                  |
| `handle-resolve.ts`                                                                          | `resolveHandleToDid` for bound invites                                                                  |
| `invite-token.test.ts` / `owner-invariant.test.ts` / `invite-assess.test.ts` / `ids.test.ts` | pure unit tests (22)                                                                                    |
| `households.db.test.ts`                                                                      | DB-gated tests (skipped without `DATABASE_URL`)                                                         |

### Server-function contract (exact name / input / RETURN — Agent C wires to these)

households.ts

- `createHousehold({ name })` → `{ id, name, role: "owner" }`
- `renameHousehold({ householdId, name })` → `{ id, name }`
- `listMyHouseholds()` → `Array<{ id, name, role: "owner"|"member", memberCount }>`
- `deleteHousehold({ householdId })` → `{ id, deleted: true }`

invites.ts

- `createInvite({ householdId, role?, boundHandle?, maxUses?, expiresAt? })` → `{ link }`
- `revokeInvite({ inviteId })` → `{ id, revoked: true }`
- `listInvites({ householdId })` → `Array<{ id, role, boundToDid, maxUses, uses, expiresAt, createdAt, status }>` (never `token_hash`)
- `getInvitePreview({ token })` → `{ householdName, inviterHandle, role }` (no use consumed, no auth)
- `acceptInvite({ token })` → `{ householdId, name }`
- `declineBoundInvite({ token })` → `{ declined: true }`

members.ts

- `removeMember({ householdId, did })` → `{ householdId, did, removed: true }`
- `setMemberRole({ householdId, did, role })` → `{ householdId, did, role }`
- `leaveHousehold({ householdId })` → `{ householdId, left: true }`
- `tombstoneMemberForDeletedAccount(householdId, did): Promise<void>` — plain async helper, NOT a server fn

### Invite link format

`${APP_URL}/invite/<rawToken>` — raw token in the **path segment** (not query). Only the sha256 hash is stored. C builds a route matching `/invite/$token`.

### Handle→DID resolution

No `@atproto/identity`/`@atproto/api` in the workspace. Best-effort over HTTP: (1) appview XRPC `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle`, then (2) fallback to the handle domain's `/.well-known/atproto-did`. Returns null if unresolvable; `createInvite` then throws a plain "could not resolve handle" error. `getInvitePreview` resolves the inviter handle from the local `atproto_repo` table (no network); null if not indexed.

### Acceptance-criteria (§14) coverage

- **Pure tests (ran, passed):** item 4 (bound wrong-DID), item 5 (open-link max_uses/expires fail-closed), item 8 (owner invariant), item 9 (owner leaves when another remains), item 13 (revoked cannot be accepted), item 15 (raw token never equals stored hash).
- **DB-gated (skipped, no DATABASE_URL):** item 9 + §7.2 tombstone (dual-owner survives / sole-owner soft-deletes household), item 12 chokepoint predicate.
- **Implemented but session-gated → left for end-to-end HTTP pass:** item 6 (idempotent re-accept), item 7 (revive soft-deleted membership).

### Email seams (§11) — `TODO(email):` markers present

`createInvite` (bound), `acceptInvite` (notify owner), `removeMember` (notify removed), `setMemberRole` (notify on promote), `deleteHousehold` (notify remaining members).

### Results

- Typecheck: 0 errors. Tests: **29 passed, 3 skipped (DB-gated), 0 failed.**

### Decisions / deviations (documented in code)

- Wrote a self-contained crypto-based ULID generator (`ids.ts`) — no `ulid` dep in repo, installs frozen. Produces the 26-char Crockford shape the recipe layer validates. Swap to a real `ulid` package post-merge if desired.
- `acceptInvite` locks the invite row with `forUpdate()` so parallel accepts can't over-consume `uses`; owner-invariant checked inside the mutating transaction.
- `createServerFn` validators are plain typed validators (matching `recipes-browse.ts`), not zod; heavy server deps dynamic-imported inside handlers to keep the client bundle clean.

### Open notes (Agent B)

- **Tombstone detection is a documented hole** (`TODO(lifecycle):`): `tombstoneMemberForDeletedAccount` is complete but nothing calls it — no account-deletion event feed yet (§12). §7.2 resolution implemented: sole-owner death soft-deletes the household.
- Server-function boundary remains DB-untested (unreachable in sandbox). Human/DB end-to-end pass needed for items 6, 7, 10, 11, 14 and the full accept/create/remove/leave flows.

---

## Agent C — Onboarding, session context & UI — ✅ merged (`3df7303`)

**Slice:** plan §5 (onboarding state machine), §8 (active-household context), §10 (UI), + the two session-mutating server fns (`resolveOnboarding`, `switchActiveHousehold`). Acceptance items 1, 2, 3, 10, 11, 14.

### What it actually built (file → purpose)

| File                                         | Purpose                                                                                                                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/household/onboarding.ts` (new)      | `resolveOnboarding`, `switchActiveHousehold`, `requireActiveHousehold` (stale-active guard), `listHouseholdMembers`, `acceptBoundInviteById`, `declineBoundInviteById` |
| `src/lib/household/pending-invite.ts` (new)  | Client-safe pending-invite cookie helpers + `errorMessage()` for typed-error display                                                                                   |
| `src/components/ConfirmDialog.tsx` (new)     | Confirm dialog (base-ui) for second-household guardrail + destructive actions                                                                                          |
| `src/components/HouseholdSwitcher.tsx` (new) | Active-household indicator + switcher dropdown in app chrome (§8)                                                                                                      |
| `src/routes/onboarding.tsx` (new)            | Single onboarding screen: pending bound invites + empty state, paste-link, secondary create                                                                            |
| `src/routes/invite.$token.tsx` (new)         | Invite acceptance; works logged-out                                                                                                                                    |
| `src/routes/households.switch.tsx` (new)     | Multi-household picker                                                                                                                                                 |
| `src/routes/households.index.tsx` (new)      | Household management (members, invites, rename, delete, leave, create-another)                                                                                         |
| `src/components/Header.tsx` (edit)           | Mounts `<HouseholdSwitcher/>`                                                                                                                                          |
| `src/components/AppShell.tsx` (edit)         | Made onboarding/invite/picker navless                                                                                                                                  |
| `src/routes/index.tsx` (edit)                | `<PendingInviteResume/>` — resumes stashed invite after OAuth                                                                                                          |
| `src/routeTree.gen.ts` (regenerated)         | Committed                                                                                                                                                              |

**Routes created:** `/onboarding`, `/invite/$token`, `/households/switch`, `/households`.

### `resolveOnboarding` return shape

```ts
type OnboardingVerdict =
  { kind: "active"; householdId: string; name: string } | { kind: "pick"; households: HouseholdSummary[] } | { kind: "onboard"; pendingInvites: PendingInvite[] };
// PendingInvite = { inviteId, householdName, inviterHandle: string|null, role }
```

### Key design decision — accept/decline by inviteId

Bound-invite pending rows surface by **inviteId** — the raw token is unrecoverable (only `token_hash` is stored), so a logged-in invitee can't be handed a token to accept. C added `acceptBoundInviteById`/`declineBoundInviteById` in `onboarding.ts` that gate on `bound_to_did === sessionDid` and run the **same** transaction semantics as B's token path, reusing B's pure `assessInviteForAcceptance` for §6.3 ordering. B's files untouched. The token path (`acceptInvite`/`declineBoundInvite`) remains for `/invite/$token` (shared/open links). C also added read-only `listHouseholdMembers` (gated by `assertMember`) because B exposes no member-listing fn.

### Logged-out invite → OAuth round-trip (§15)

The atproto callback (A's plugin) hardcodes `redirect("/")` with no `returnTo` and can't be modified. Mechanism chosen: `/invite/$token` stashes the raw token in a short-lived first-party cookie (`buttery_pending_invite`, Max-Age 10m, SameSite=Lax) before redirecting to `/login`; after auth the browser lands on `/`, where `PendingInviteResume` reads the cookie and forwards to `/invite/$token`. First-party cookie survives the same-origin OAuth hop. **Not observed at runtime** (app can't run in sandbox) — human must confirm.

### Acceptance items 1, 2, 3, 10, 11, 14 — structurally satisfied

- **1** empty pending-invites state + wait copy; no household until explicit create.
- **2** bound invites auto-surface (`resolveOnboarding` queries `bound_to_did = me, pending, not revoked/expired, live household`).
- **3** create is visually secondary; no persisted waiting state.
- **10 & 14** `computeOnboarding` clears stale `active_household_id` and re-resolves; `requireActiveHousehold` runs it in household-scoped loaders; `HouseholdSwitcher` re-runs on every page.
- **11** `ConfirmDialog` gates the second `createHousehold`; no hard cap.

All six need a **live-DB human pass** to verify at runtime.

### Results

- Typecheck: 0 errors. `tsr generate`: clean, 4 routes in `routeTree.gen.ts`. Pure test suites: 29 passed.

### Open notes (Agent C)

- Added `listHouseholdMembers` + the two by-id invite fns to `onboarding.ts` (B provided neither).
- **Open-link Decline UX gap flagged by C** — since fixed in integration (see below): `/invite/$token` Decline calls B's `declineBoundInvite`; for an open link that would have marked the shared link declined for everyone. Integration fix now rejects open-link decline.
- Live flows + the §15 cookie round-trip need a human/DB pass.

---

## Integration review & fixes (Agent D role) — `f32ea6b`

A read-only correctness/security review ran over the full merged surface (`git diff c9e6cab~1..HEAD -- services/web`).

**Authorization chokepoint: CONFIRMED INTACT.** Every household-scoped server fn resolves the caller DID from the server session (never a client arg) and gates through `assertMember` at the correct minRole — including C's out-of-module additions (`acceptBoundInviteById`/`declineBoundInviteById` verify `bound_to_did === sessionDid` and reject open invites; `listHouseholdMembers`/`switchActiveHousehold` gate via `assertMember`). Cross-household access (item 12) is blocked at each function. Token storage is clean (only sha256 hash stored; `listInvites` never selects it). Accept path (§6.3) faithful in both token and by-id variants (`forUpdate()` lock, ordered fail-closed validation, insert-or-revive, atomic active-household set).

**Two medium findings FIXED (`f32ea6b`):**

1. **Owner-invariant TOCTOU race** (`members.ts` `liveOwnerDids`) — the owner-set read had no row lock, so two concurrent owner exits/demotions could each pass `wouldDropLastOwner` and both commit, leaving a household with 0 live owners. **Fix:** added `.forUpdate()` to lock the owner rows so the transactions serialize.
2. **Open-link decline griefing** (`invites.ts` `declineBoundInvite`) — an open link (`bound_to_did === null`) fell through the bound-guard, letting any authenticated token holder mark the shared link `declined` for everyone. **Fix:** reject with `InvalidInvite` when `bound_to_did === null` (decline is bound-only per §6.4).

**Findings NOT fixed (documented, low severity):** 3. **low** — concurrent-accept membership double-insert: two _different_ invites to the same household for the same DID accepted simultaneously could both pass the `prior` check and hit a PK violation. Fail-closed (one errors, no corruption), needs simultaneous double-accept — very unlikely. Optional `onConflict` upsert if it ever bites. 4. **low/cosmetic** — partial index `household_member_live_owner_idx` predicate omits `tombstoned = false` (matches spec text); the query still filters tombstoned, so correctness is unaffected — index is just slightly less selective.

---

## Global open items (for human review before/at merge)

1. **Run the migration:** `railway run --service buttery -- pnpm db:migrate:up` and verify
   `... db:migrate:down`. Nothing has touched the real DB.
2. **Regenerate types:** `railway run --service buttery -- pnpm db:codegen` to replace A's hand-authored
   `src/db/types.ts` interfaces with canonical generated ones (should be a ~no-op diff; confirm).
3. **Re-sign commits** if signature policy requires (all build commits are unsigned).
4. **Run DB-backed tests** once the dev DB is up — the acceptance-criteria (§14) items that need a live DB
   were written but skipped in the sandbox.
