# UI kit — Buttery signed-in app

The authenticated shell and household surfaces, recreated from
`services/web/src/` in the attached codebase.

| File | Source of truth |
| --- | --- |
| `../shared/Chrome.jsx` | `src/components/Header.tsx`, `Footer.tsx`, `HouseholdSwitcher.tsx`, `ThemeToggle.tsx` |
| `PantryHome.jsx` | `src/components/AppSidebar.tsx` + `src/routes/pantry.tsx` |
| `HouseholdManage.jsx` | `src/routes/households.index.tsx` (rename, members, invites, create-another, danger zone) |
| `Onboarding.jsx` | `src/routes/onboarding.tsx` |

## Click-through

Nav rail (only **Home** is live — everything else carries the real `soon` chip
and is non-interactive) → *Manage household* → rename inline, switch invite mode,
create an invite link and copy it, open either destructive confirm dialog. The
household switcher in the header opens the real dropdown, including
*Join or create another* → onboarding, which renders **without** the nav rail
exactly as `AppShell`'s `NAVLESS_ROUTES` dictates.

## Deliberate omissions

- **Recipes, collections, shopping list, meal planner, randomizer** are unbuilt in
  the source. They exist here only as disabled nav items with `soon` badges — no
  invented screens.
- **Cook mode**, the source's stated top priority, has no implementation yet.
  Nothing is guessed for it.
- `/households/switch` and `/invite/$token` are simple list/confirm variants of
  the surfaces here and are not duplicated.
- Sidebar collapse is shown as a trigger button; the desktop collapse animation
  and the mobile Sheet drawer are described in `components/navigation/`.
