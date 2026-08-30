# @buttery/admin — backoffice

An internal instrument for looking at Buttery's data. It shares the app's
database and shares nothing else with it.

```
pnpm --filter @buttery/admin admin:create --email you@example.com --password '…' --name 'You'
BUTTERY_ADMIN_DISABLED=false pnpm dev        # whole stack + admin
# or, on a running stack: process-compose process start admin
```

Then <http://127.0.0.1:3100>.

## What it is for

The app resolves every recipe into one answer: it picks between the locally
stored copy and the atproto record, and the choice is invisible by design. That
is right for a cook and useless for anyone asking _why a recipe looks wrong_.

This tool never resolves. It shows both copies, side by side, with their
disagreements marked, and the raw rows behind them as evidence.

| Section                  | Answers                                                        |
| ------------------------ | -------------------------------------------------------------- |
| Dashboard                | How big is everything, and did the last sweep work             |
| Network → Recipe records | Every `exchange.recipe.recipe` the sweep has seen, raw         |
| Network → Recent changes | What changed on the network lately                             |
| Network → Repos          | Which DIDs we track, and what went wrong last time             |
| Network → Sync runs      | One row per sweep                                              |
| Local → Recipes          | `public.recipe`, including rows the network has never heard of |
| Access → Operators       | Who can get in here                                            |

The record detail page (`/network/recipes/$did/$rkey`) is the centre of it:
**Compare** (local vs network, field by field), **Record** (the record as
`path / type / value`, undeclared fields included), **Local** (the Postgres rows,
unmodified), **Revisions** (every change the sweep has observed), **Annotations**
(the seam for the tagging/labelling tables — see below).

## Authentication is separate, on purpose

An operator here is not a Buttery account and a Buttery account is not an
operator. Three things enforce that, and all three matter:

- **Its own tables**, in the `admin` Postgres schema — `admin_user`,
  `admin_session`, `admin_account`, `admin_verification`. The connection sets
  `search_path = admin, public`, and the tables are named `admin_*` inside
  `admin` so nothing shadows a `public` table of the same name.
- **Its own secret** — `ADMIN_BETTER_AUTH_SECRET`, never the app's
  `BETTER_AUTH_SECRET`. Sharing one would let a token minted by either app
  verify against the other, and the table split would be decoration.
- **Its own cookie prefix** — `buttery-admin.*`. Cookies ignore ports, so
  `127.0.0.1:3000` and `127.0.0.1:3100` are one jar; under the default prefix
  signing into the admin would sign you out of the app.

Sign-in is email + password for now. Google/OIDC drops into `socialProviders`
later with no schema change — better-auth stores a social login in the same
`admin_account` table.

**Sign-up is closed.** `disableSignUp` turns registration off everywhere,
including the server-side API, so an account requires shell access:

```bash
pnpm --filter @buttery/admin admin:create --email you@example.com --password '…' --name 'You'
```

Revoking is one statement, and takes effect on the operator's next request
rather than whenever their session happens to expire:

```sql
update admin.admin_user set disabled_at = now() where email = '…';
```

## Migrations

Admin tables live in the `admin` schema but their migrations live in the **web**
service, named `<timestamp>_admin_<description>` so they are greppable as a
group if they ever move to a migration pathway of their own:

```bash
pnpm --filter @buttery/web db:migrate:new admin_whatever_it_is
pnpm --filter @buttery/web db:migrate:up
pnpm --filter @buttery/admin db:codegen   # regenerate src/db/types.ts
```

Never hand-name a migration file — kysely-ctl stamps `Date.now()` and a
hand-picked prefix drifts ahead of the clock.

`services/web`'s own codegen excludes `admin.*`, so the app's `src/db/types.ts`
never learns about these tables. The admin's includes both schemas; admin tables
appear in its `DB` interface as `"admin.admin_user"` and friends.

Two migrations exist today:

- `*_admin_create_admin_schema` — the schema and the better-auth tables.
- `*_admin_create_atproto_record_revision` — `admin.atproto_record_revision`
  plus an `AFTER INSERT OR UPDATE` trigger on `public.atproto_collection_recipe`
  that captures a row whenever a record actually changes.

That trigger is the only thing the admin adds to the app's write path. It is
cheap (an unchanged re-sweep writes nothing) and it drops cleanly with the
migration's `down()`.

## Revision history is _observed_ history

atproto exposes no "list the revisions of this record" endpoint — a repo's
history lives in its commit log, which the sweep does not read. So the Revisions
tab shows what **we saw**, at sweep granularity: two edits between sweeps arrive
as one row, and history starts the day the migration ran (those rows are marked
`backfill`, not `created`). The page says so; do not let a reader mistake it for
the repo's log.

## The annotations seam

Recipe tagging/labelling tables are being added on another branch.
`src/server/annotations.ts` is where they plug in: give `loadAnnotations` a real
body, flip `ANNOTATIONS_WIRED`, and the Annotations tab lights up with no other
change. Until then it renders an explicit "not wired up yet" panel rather than
an empty list, so nobody has to guess which it is.

## Not deployed

There is no Railway service for this, deliberately — no `.railway/railway.ts`
entry, no build target, no domain. It is a local tool. If that changes, the
things to decide first are how operators authenticate (Google, presumably) and
whether the migrations move out of `services/web`.

## Design

Stock shadcn/ui, new-york style, neutral base — deliberately **not** the Buttery
design system, and `docs/BRAND.md` does not apply here. The visual distance is
the point: an operator can never mistake a backoffice screen for something a
cook sees, and nothing in `services/web` has to stay in sync with this app's CSS.
