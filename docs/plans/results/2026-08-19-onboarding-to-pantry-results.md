# 2026-08-19 — Onboarding lands in the pantry — results

Status: **shipped**
Plan: `docs/plans/2026-08-19-onboarding-to-pantry.md`

---

## 1. What was built

### The chooser (`services/web/src/routes/onboarding.tsx`)

Rewritten from a stack (invites → paste-a-link → separator → demoted create form) into
the two-chip chooser from the Claude Design source. The loader is unchanged: same
`resolveOnboarding()`, same `active → /household` / `pick → /households/switch` arms.

- `role="tablist"` with two real `Button`s (`size="lg"`, `rounded-full`, `role="tab"`,
  `aria-selected`, `aria-controls`). Active chip is `secondary` + `shadow-pop-sm`, inactive
  `outline`; the create chip takes the `accent` nudge fill only when nothing is chosen and
  nothing is waiting. Join carries a primary count pill when invites exist.
- Tab state is local component state — default `"join"` when invites exist, otherwise `null`.
  No URL param.
- Three panels: the no-choice explainer (two rows, hairline-split, "Name my household"
  switches tabs), join (invite cards + the standing help card), create (one `Card`).
- The create submit is now the **default** variant. Reaching that panel is already a
  deliberate choice, so the guardrail moved into the copy rather than the button weight.
- `PendingInviteCard`, `extractToken()`, the paste-link form and the create submit logic
  (including `posthog.capture("household_created", { creation_surface: "onboarding" })`) are
  carried over, along with every `await refreshSession()` and its comment.

### `PendingInvite.createdAt` (§5.1)

`lib/api/types.ts` gained `createdAt: string`; `computeOnboarding` selects `i.created_at`
(the query already ordered by it) and maps to `new Date(...).toISOString()`. Rendered with
`formatPublished` — "Invited by @handle · 3 days ago", or "Invited 3 days ago" with no
inviter handle.

### Landing changes (§4)

`navigate({ to: "/households" })` → `{ to: "/household" }` in `onboarding.tsx` (accept and
create), `invite.$token.tsx` (token accept) and `households.switch.tsx` (the picker's
"Enter"). Every preceding `refreshSession()` and its comment kept. `/households` decline /
leave / delete → `/onboarding` left alone, as were `resolveHomeRedirect` and the marketing
path.

### The pantry nudge (§6)

- **Migration** `1787183960210_household_settings_jsonb` — `household.settings jsonb not
null default '{}'::jsonb`, created via `db:migrate:new` (never hand-named), then
  `db:migrate:up` + `db:codegen`.
- **`server/household/settings.ts`** — `getHouseholdNudges({ householdId })` (GET,
  `assertMember`, one query: live member count `= 1` AND `settings->>'inviteNudgeDismissedAt'`
  null) and `dismissInviteNudge({ householdId })` (POST, `assertMember`, `settings ||
jsonb_build_object(...)`). Both use the dynamic-`import()`-inside-the-handler pattern.
  Exported through `lib/api/transport.ts`.
- **`components/pantry/InviteYourHouseCard.tsx`** — primary link to `/households` (where the
  invite form lives) plus a ghost "Not now" that dismisses optimistically.
- **Wiring** — `household.index.tsx`'s loader fetches it best-effort
  (`getHouseholdNudges(...).catch(() => null)`), exactly like the network strip, because the
  pantry is the PWA front door and has to cold-launch offline. Rendered above both the
  empty-box welcome and the overview.

---

## 2. Deliberate deviations from the plan

1. **The handle row hides on a bare DID.** §5 says the handle comes from
   `session.user.handle ?? session.user.name` and to "render nothing when both are null". In
   practice `name` falls back to the **DID** whenever the auth plugin could not read a handle
   out of the DID doc, so the plan's fallback rendered `@did:plc:wjubb…` under "your internet
   handle". That string is not merely ugly — `resolveHandleToDid` requires a domain-shaped
   handle and rejects a DID outright, so it is a value the inviter cannot use. The row (and
   its hairline, via `useGiveableHandle()` lifted into the card) is dropped instead.
   Root-caused and fixed separately — see §3.
2. **Raw `sql` for one jsonb path.** `settings` is typed `Json`, so Kysely's
   `ref(..., "->>").key()` has no key union and resolves its argument to `never`. The
   `->>` extraction is a `sql<string | null>` fragment with a constant path; everything else
   in both handlers stays on the query builder, per `AGENTS.md`.
3. **Accept/Decline are `size="lg"`.** §5 names the variants but not the size; the design
   source has both at `lg`, and that matches the surrounding controls.

### Known gap (§3.6, recorded as required)

**Login `returnTo` is not implemented and cannot be, natively.** `callbackURL` is a built-in
/ generic-OAuth-plugin feature of better-auth, while this app's custom atproto plugin
hard-redirects to `/` (`services/web/src/lib/atproto/better-auth-plugin.ts`), where
`resolveHomeRedirect` routes by the §5 state machine. Out of scope per the plan's own
condition ("only if better-auth supports it natively").

---

## 3. Work beyond the plan (requested mid-implementation)

### The `invited` access gate is gone

Removed at the product owner's request — everyone is let in from here on. Deleted
`server/gate.ts` and `components/Waitlist.tsx`; dropped `GateState`, `fetchGateState`,
`OFFLINE_FALLBACK_KEYS.gate`, `readCachedGateState`/`cacheGateState`/`gateStateOffline`, the
root loader and `UNGATED_ROUTES`; removed `INVITED_FLAG` and `isInvited` from
`lib/posthog-server.ts`. The PostHog flag itself is the owner's to delete.

Two collateral removals, both dead once the gate went: `isDevOrTest()` (only `isInvited`
called it) and the server-side `identify()` (only the gate called it — the browser already
does the same durable person write from `__root.tsx`, so no capability was lost).
`isAtprotoPublishEnabled` and `captureServerEvent` keep their real callers, and the
posthog-server tests were re-pointed at `captureServerEvent`.

### Local dev now resolves atproto handles

Reported during the walkthrough and root-caused: three call sites hardcoded production
endpoints, so a `@atproto/dev-env` account's DID document was looked up in the _public_ PLC
directory, which has never heard of it. The lookup failed, `alsoKnownAs` was never read, and
**every local account signed in with `handle: null` and `name` set to the bare DID** — which
is what surfaced as the DID in the handle row above. Bound invites were broken the same way:
`resolveHandleToDid` asked the public appview about `chef.test`.

New `lib/atproto/endpoints.ts` centralises `plcDirectoryUrl()`, `handleResolverUrl()` and
`didDocumentUrl()`, each defaulting to production so an unset environment behaves exactly as
the hardcoded values did. It uses the override names already in `.env.example` and already
honoured by `oauth-node.ts` and `services/atproto-cron-sync/src/identity.ts`. Adopted by
`better-auth-plugin.ts` (the handle bug), `handle-resolve.ts` (bound invites) and
`recipes.ts`.

Verified: a fresh sign-in now stores `handle: chef.test` **and** `pds:
http://localhost:2583` (both previously null), and a bound invite to `baker.test` — a second
account created on the dev PDS — resolves and mints.

### `mise run setup:reset`

`setup:env` and `setup:mcp` are bootstrap-only by design, so a pull that adds a key to a
`.env.example` leaves every existing checkout's rendered file stale and silently short that
key. `scripts/dev/reset-config.mjs` (task `setup:reset`) re-renders both services' `.env`
and `.mcp.json` from the committed templates, delegating to those two scripts rather than
duplicating them.

Backups over a prompt: a prompt cannot be answered by CI, a hook or an agent, and "are you
sure?" is a poor guard for a file that may hold the only copy of real blob-storage
credentials. Each replaced file is renamed `<name>.bak.<YYYYMMDD-HHMMSS>` beside itself
(gitignored via `*.bak.[0-9]*`) before anything is written. `--dry-run` and `--no-backup`
are supported. Documented in `README.md` under the `.env` section.

---

## 4. Verification

Full walkthrough of plan §7 against the local stack at `http://127.0.0.1:3000`, driven with
the Playwright MCP, from a true zero-household state (`db:reset:users --yes`) with two real
atproto dev-env accounts (`chef.test`, and `baker.test` created on the dev PDS).

| §   | Step                                                                                                                                     | Result |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | Fresh sign-in, no invites → chooser, no tab selected, nudge fill on the create chip; "Name my household" switches tabs                   | pass   |
| 2   | Create → lands `/household`; nudge card present; "Not now" hides it and it stays hidden after reload                                     | pass   |
| 3   | Owner sends a bound invite → invitee's chooser opens on join with a count badge; "Check again" re-runs the loader; accept → `/household` | pass   |
| 4   | Both accounts see no nudge at two members, though only one dismissed                                                                     | pass   |
| 5   | Decline drops the card, join tab stays, count 2 → 1 → the "No invitations yet" block returns                                             | pass   |
| 6   | Paste an invite link → `/invite/$token`; accepting there also lands `/household`                                                         | pass   |
| 7   | `/onboarding` holding a household → `/household`; two households none active → `/households/switch`, "Enter" → `/household`              | pass   |
| 8   | Copy puts `@baker.test` on the clipboard; label flips "Copied" → "Copy"                                                                  | pass   |

Also checked: dark ("toasted") mode, a 390px mobile pass (chips wrap, nothing overflows,
touch targets stay at the `lg` height), tab order following visual order, the 3px focus ring
on both chips, and the `aria-*` wiring (`tablist` label, `aria-selected`, `aria-controls` /
`aria-labelledby` pairs, `tabIndex={-1}` panel). No new animation was introduced, so the
existing global `prefers-reduced-motion` reset covers the screen.

`mise run setup:reset` was exercised for real (dry run, then live): three files backed up,
all three re-rendered, backups correctly ignored by git.

### Checks

| Command                                    | Result                  |
| ------------------------------------------ | ----------------------- |
| `pnpm typecheck`                           | pass                    |
| `pnpm lint`                                | pass                    |
| `pnpm format`                              | clean                   |
| `pnpm test`                                | 490 passed, 179 skipped |
| `vitest run --project db` (schema changed) | 179 passed              |

`pnpm test:db` itself was not used — it wraps `railway run`, which has no login in a cloud
session; the DB project was run directly with `DATABASE_URL` from `services/web/.env`, per
`docs/CLAUDE_CLOUD.md`.

### One trap worth recording

`db:migrate:new` writes an empty stub, and the stack's `migrate` process applied that stub
before the body was filled in — leaving the migration marked applied with no column, and
`db:migrate:down` then failing on the column it was trying to drop. The fix was to delete
the ledger row and re-run `up`. The `local-dev` skill already says to restart the `migrate`
process rather than hand-running `db:migrate:up` after adding a migration; the sharper rule
is to **write the migration body before anything can pick the file up**.
