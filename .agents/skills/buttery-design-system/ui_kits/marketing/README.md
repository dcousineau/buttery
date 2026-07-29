# UI kit — Buttery public web (buttery.recipes)

The signed-out surfaces of the Buttery web app, recreated from
`services/web/src/routes/` in the attached codebase.

| File | Source of truth |
| --- | --- |
| `../shared/Chrome.jsx` | `src/components/Header.tsx`, `Footer.tsx`, `ThemeToggle.tsx`, `HouseholdSwitcher.tsx` |
| `Landing.jsx` | `src/routes/index.tsx` (hero, recipe-lookup card, "Fresh from the pantry", "What's in the pantry") |
| `Login.jsx` | `src/routes/login.tsx` |
| `RecipeDetail.jsx` | `src/routes/recipes.$id.tsx` |

## Click-through

Sign in → header nav → recipe card → recipe detail → back. The theme toggle
really toggles `.dark` on `<html>`, so both palettes are inspectable.

## Deliberate omissions

- **Recipe photography.** The source has no bundled recipe imagery, so every image
  slot renders the app's real fallback: a `--muted` panel with the Lucide
  `utensils-crossed` glyph. Drop real photos in and the slots take them as-is.
- The `/terms`, `/privacy`, `/ai-usage` legal pages are a shared `LegalPage`
  prose shell and are not recreated — footer links are inert.
- The `COMING_SOON` holding page (`src/components/ComingSoon.tsx`) is the same
  header + hero + footer composition as the landing hero; not duplicated here.
