# 2026-08-19 — Onboarding lands in the pantry

Status: **spec — ready to implement**
Depends on: `02-households-and-private-foundation.md` (the §5 state machine, invites,
`resolveOnboarding`/`requireActiveHousehold`), `2026-08-11-offline-mode.md` (the cache
partition and the "refresh the session before you navigate" rule this plan preserves).

> Implementer: log outcomes to `docs/plans/results/2026-08-19-onboarding-to-pantry-results.md`
> (what was built, how it was verified, deliberate deviations).

---

## 1. Context

A first-time user signs in, has no household, and lands on `/onboarding`. Today that screen is
a stack — invites, then paste-a-link, then a separator, then a demoted create form — and every
way out of it (onboarding accept, onboarding create, `/invite/$token` accept,
`/households/switch` pick) dumps the user on `/households`, the **management** page. Every
later login goes to `/household`, the pantry. So the first thing a new user sees is a settings
surface, and the second thing is a different home page.

This plan makes onboarding a **chooser** — join or create, per the Claude Design spec — that
holds the user until they are a member of at least one household, then hands them to the
**pantry**, the same place every future login lands. A household with only one member then
gets one dismissible nudge in the pantry to invite the rest of the house.

The happy path is exactly one household per user. Multi-household stays supported and gets no
new UI: the account-menu switcher and `/households/switch` are the whole story.

---

## 2. Design source

Claude Design project:
`https://claude.ai/design/p/79273972-00fe-40a9-bb25-884aa0e4e762?file=OnboardingChooser.dc.html`

Pull it with the `claude_design` MCP / `DesignSync` tool (auth via `/design-login` if the tool
401s):

- `projectId`: `79273972-00fe-40a9-bb25-884aa0e4e762`
- Implement: `OnboardingChooser.dc.html`
- Supporting, read as needed: `support.js` and the design-system bundle under
  `_ds/buttery-design-system-79cab411-a51c-4fb9-b7d0-09da0ef462ec/` (`_ds_bundle.js`,
  `styles.css`, `tokens/{base,brand-utilities,colors,elevation,fonts,motion,spacing,typography}.css`)
- Ignore the sibling files `Onboarding Current.dc.html` and `Onboarding - Create vs Join.dc.html`
  — the before state and an alternate.

The design's `<header>`/`<footer>` are just the app chrome: `AppShell` already renders them for
`/onboarding` (it is in `NAVLESS_ROUTES`). Build the `<main>` content only. Map
`x-import ButteryDesignSystem_79cab4.X` → `#/components/ui/*` (`Badge`, `Button`, `Card`,
`CardContent`, `Field`, `FieldGroup`, `FieldLabel`, `FieldDescription`, `Input`, `Spinner`);
`page-wrap`, `rise-in`, `display-title`, `gingham-band` are existing global classes in
`services/web/src/styles.css`. §5 below transcribes the design closely enough to build it if
the MCP is unavailable.

Load before touching UI (per `AGENTS.md`): the `buttery-design-system` skill + `docs/BRAND.md`,
`accessibility-compliance`, and `local-dev` for the dev stack.

---

## 3. Decisions (settled with the product owner — do not relitigate)

1. **Onboarding holds** until the caller has ≥1 live membership. `/onboarding` with an active
   household redirects to `/household`. The `pick` verdict (2+ memberships, none active) keeps
   redirecting to `/households/switch` — the pantry cannot render without an active household,
   so that redirect _is_ the multi-household exit.
2. **Everything lands in the pantry.** Onboarding accept, onboarding create, `/invite/$token`
   accept, and the `/households/switch` pick all navigate to `/household`, not `/households`.
3. **Invite arrival is manual.** The design's "Check again" button re-runs the loader. No
   polling, no focus refetch.
4. **No "Taking you in…" interstitial.** Inline button spinner, then navigate.
5. **Pantry nudge.** Any household with exactly one live member, not dismissed, shows a
   dismissible "invite the rest of the house" card. Dismissal persists in a new generic
   `household.settings` jsonb column; the card auto-hides at ≥2 members (derived — no extra
   state, and one member dismissing is enough for the household).
6. **`returnTo` after login is out of scope.** The condition was "only if better-auth supports
   it natively", and it does not here: `callbackURL` is a built-in / generic-OAuth-plugin
   feature, while this app's custom atproto plugin hard-redirects to `/`
   (`services/web/src/lib/atproto/better-auth-plugin.ts:160`), where `resolveHomeRedirect`
   routes by the §5 state machine. Record it in the results doc as a known gap.
7. **No new multi-household UI.**

---

## 4. Landing changes

Replace `navigate({ to: "/households" })` with `navigate({ to: "/household" })` in:

- `services/web/src/routes/onboarding.tsx` — invite accept and household create
- `services/web/src/routes/invite.$token.tsx` — token accept (~line 80)
- `services/web/src/routes/households.switch.tsx` — the picker's "Enter"

**Keep the `await refreshSession()` that precedes each one, and its comment.** It is there
because these calls move `session.active_household_id` server-side while better-auth's client
store still names the old household; navigating first files the new household's rows under the
old cache buster (offline plan §2.4/§2.7).

Leave alone: `/households` decline / leave / delete → `/onboarding` (still correct), and
`resolveHomeRedirect` in `services/web/src/server/household/onboarding.ts` (already
`active → /household`).

---

## 5. The chooser (`/onboarding`)

`services/web/src/routes/onboarding.tsx`. The loader is unchanged: `resolveOnboarding()`,
`active` → `/household`, `pick` → `/households/switch`, otherwise `{ pendingInvites }`.

Reuse from the current file: `PendingInviteCard` (accept/decline + `refreshSession`),
`extractToken()`, the paste-link form, and the create form's submit logic including
`posthog.capture("household_created", { creation_surface: "onboarding" })`.

Layout: the existing `page-wrap` + `rise-in`, `max-w-xl` column, `gap-6`.

**Header** — `Badge variant="secondary"` "Get started"; `h1.display-title` "Welcome to the
pantry"; body copy:

> A **household** is your private, shared space in Buttery — the recipes, the list, the week's
> plan. You need one to get going, and there are exactly two ways in.

**Chooser chips** — `div role="tablist" aria-label="How you're getting in"` holding two
`Button`s (`size="lg"`, `rounded-full`, `role="tab"`, `aria-selected`, `aria-controls` naming
the panel): the active chip is `variant="secondary"` with `shadow-pop-sm`, the inactive one
`variant="outline"`.

- "Join a household" (`Mail`) plus a count pill (primary, bordered) when
  `pendingInvites.length > 0`.
- "Create a household" (`Plus`). When no tab is chosen _and_ there are zero invites, this chip
  takes the `accent` nudge background the design uses.

Tab state is local component state: default `"join"` when invites exist, otherwise `null`. No
URL param. The panel is `role="tabpanel"`, `aria-labelledby` the active chip, `tabIndex={-1}`.

**Panel — nothing chosen (zero invites).** One `Card`, two rows split by a hairline:

- `Mail` — "Someone's inviting you" / "Pick **join** and any invitation shows up there the
  moment it lands. Nothing to do but wait."
- `House` — "Nobody's invited you yet" / "Start your own. It takes one name, and you can invite
  the rest of the house the minute it exists." plus `Button size="sm" variant="secondary"`
  "Name my household", which switches to the create tab.

**Panel — join.**

1. One `Card` per pending invite: household name (`display-title`), "Invited by @{handle} ·
   {when}", role `Badge`, then `Accept invite` (default) and `Decline` (ghost). Accept →
   `acceptBoundInviteById` → `refreshSession()` → `/household`, with the pending label
   "Joining…". Decline → `declineBoundInviteById` → `router.invalidate()`, so the card drops
   out and the join tab stays put. Errors keep the existing `role="alert"` treatment.
2. One `Card` below it, in this order:
   - **Only when there are zero invites**: `MailQuestion` + "No invitations yet" / "Waiting is
     the easiest way in — you don't have to build anything yourself. When someone adds you, the
     invite lands right here.", plus `Button size="sm" variant="ghost"` "Check again" →
     `router.invalidate()`, labelled "Checking…" while pending. Hairline after it.
   - "Give them your handle" / "Whoever's inviting you needs your internet handle — it's how
     Buttery finds you.", then a pill showing `@{handle}` and an `outline` "Copy" button
     (`navigator.clipboard.writeText`; the label flips to "Copied" for ~1.6s). The handle comes
     from `useHydratedSession()` → `session.user.handle ?? session.user.name`, the same
     fallback `components/UserMenu.tsx:118` uses; render nothing here when both are null.
   - Hairline, then "Got a link already?" with the existing paste-link field
     (`placeholder="https://buttery.recipes/invite/…"`) and a `secondary` "Open invite" button
     → `extractToken` → `/invite/$token`. Keep the "Paste the full invite link you were given."
     validation error.

**Panel — create.** One `Card`: "Name your household", the guardrail line "Only start one if
nobody's invited you — two half-full pantries can't be merged later.", a `Field` labelled
"Household name" with `Input size="lg" maxLength={100}` placeholder "The Cousineau kitchen" and
`FieldDescription` "You can rename it later — nothing here is permanent.". Submit is a `Button
size="lg"` in the **default** variant — reaching this panel is already a deliberate choice, so
the create form is no longer visually demoted — disabled while the name is empty or the request
is in flight, labelled "Creating…" while pending, followed by the muted line "You'll be the
owner. Invite the rest of the house next."

Accessibility: the chips are real buttons in a `tablist`, with visible focus and
`aria-selected`; errors keep `role="alert"`; touch targets stay at the `size="lg"` height.

### 5.1 `PendingInvite` gains `createdAt`

The design shows "Invited by @handle · 2 days ago".

- `services/web/src/lib/api/types.ts` — add `createdAt: string` (ISO) to `PendingInvite`.
- `services/web/src/server/household/onboarding.ts` — `computeOnboarding`'s invite query already
  orders by `i.created_at`; select it too and map to `new Date(...).toISOString()`.
- Render with `formatPublished` from `services/web/src/lib/format.ts` (relative under a week,
  absolute after). With no inviter handle: "Invited {when}".

---

## 6. The pantry invite nudge

**Migration.** `pnpm --filter @buttery/web db:migrate:new household_settings_jsonb` — never
hand-name a migration — then edit the generated file to add to `household`:
`settings jsonb not null default '{}'::jsonb`. Follow with `db:migrate:up` and `db:codegen`.
Both need the dev DB, so run them sandbox-disabled (`!` prefix), per `AGENTS.md`.

**Server.** New `services/web/src/server/household/settings.ts`, using the same
dynamic-`import()`-inside-the-handler pattern as its siblings so `pg` stays out of the client
bundle:

- `getHouseholdNudges({ householdId })` (GET) — `assertMember`, then one query returning
  `{ inviteNudge: boolean }`: true ⇔ the live member count (`deleted_at is null and tombstoned
= false`) is exactly 1 **and** `settings->>'inviteNudgeDismissedAt'` is null.
- `dismissInviteNudge({ householdId })` (POST) — `assertMember`, then merge
  `{"inviteNudgeDismissedAt": <now>}` into `settings` (`settings || jsonb_build_object(...)`).

Export both through `services/web/src/lib/api/transport.ts` beside the other household fns.

**Client.** `services/web/src/components/pantry/InviteYourHouseCard.tsx`, styled like its
neighbours (see `FillTheBoxCard.tsx` for the house idiom): copy along the lines of "Nobody else
is in here yet" / "Buttery is better with the rest of the house in it — send them an invite and
everything you add shows up for them too.", a primary `Button` linking to `/households` (where
the invite form lives), and a ghost "Not now" that calls `dismissInviteNudge` and hides the card
immediately (optimistic; a failure just leaves it hidden for the session).

**Wiring.** The `services/web/src/routes/household.index.tsx` loader fetches the nudge
**best-effort**, exactly as it does the network strip: `getHouseholdNudges(...).catch(() => null)`.
The pantry is the PWA front door and has to cold-launch offline, so an absent nudge is a
non-event, never an error. Render the card at the top of the pantry content — above both the
empty-box welcome and the overview — since it is a first-run action rather than part of either
state.

---

## 7. Verification

Bring the dev stack up per the `local-dev` skill and browse `http://127.0.0.1:3000` (never
`localhost` — atproto OAuth binds to loopback) with Chrome MCP, not `curl`.

Get to a true zero-household state with `pnpm --filter @buttery/web db:reset:users`
(sandbox-disabled).

Walk it:

1. Fresh sign-in with no invites → the chooser with no tab selected and the nudge styling on
   the create chip; "Name my household" switches tabs.
2. Create a household → lands on `/household`; the invite nudge card is there; "Not now" hides
   it and it stays hidden after a reload.
3. Second account: the owner sends a bound invite from `/households` → the invitee's chooser
   opens on the join tab with a count badge, "Check again" refreshes, accept → `/household`.
4. Both accounts now see no nudge (two members) even though only one of them dismissed it.
5. Decline an invite → the card drops, the join tab stays, the "No invitations yet" block
   returns.
6. Paste an invite link → `/invite/$token`; accepting there also lands on `/household`.
7. `/onboarding` while holding a household → `/household`. `/household` with zero memberships →
   `/onboarding`. Two households and no active one → `/households/switch`, and "Enter" →
   `/household`.
8. The copy button puts `@handle` on the clipboard.

Then `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm test:db` (the schema changed). Finish
with a keyboard pass over the chips and panels and a reduced-motion check.

---

## 8. Out of scope

Login `returnTo`; any new multi-household UI; changes to the `/households` management surface;
polling for invites; the marketing / `resolveHomeRedirect` path (already correct).
