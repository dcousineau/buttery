# Handoff: Buttery — Recipes index (master–detail)

## Overview

The signed-in **Recipes** screen for Buttery, a social recipe / kitchen-management app
built on atproto. It replaces a "click through to a full-page recipe" pattern with a
**two-pane master–detail browser**: a dense, scannable ledger of the household's recipes on
the left, and the full recipe rendered in the right column as soon as a row is selected.
The screen is optimized for fast browsing and comparison — no page transitions, no
scroll-to-top, no lost place in the list.

Scope: this household's shared recipes only. Everything on the screen is **read-only**
except: `Add` (new recipe), the per-recipe action row, the Scale & convert control, and
the private Notes field.

## About the Design Files

`AppScreen.dc.html` in this bundle is a **design reference created in HTML** — a working
prototype demonstrating intended layout, density, states, and behavior. It is not
production code to copy.

The task is to **recreate this design in the target codebase's existing environment**
(the real Buttery app is TanStack Start + React + Tailwind v4 + shadcn/ui on Base UI
primitives, `base-nova` style, with the neo-brutalist construction vendored into
`src/components/ui/*.tsx`). Compose the existing primitives — do not restyle raw markup
to imitate them, and do not port the prototype's inline styles. If no environment exists,
pick the most appropriate framework and implement there.

`AppScreen.dc.html` needs the sibling `support.js`, `ds-base.js`, and the
`_ds/buttery-design-system-.../` folder to render; `AppScreen.standalone.html` is a
single self-contained copy that opens offline with no dependencies. Open either in a
browser to see live behavior.

## Fidelity

**High-fidelity.** Final colors, typography, spacing, density, copy, and interactions.
All values come from the Buttery design system's semantic tokens — recreate pixel-for-pixel
using the codebase's tokens and primitives, not the literal hex values below (those are
given for reference only).

---

## Screens / Views

### 1. App shell (unchanged from the existing app)

- **Purpose**: persistent chrome; identifies the active household and account.
- **Layout**: `height: 100vh; display:flex; column; overflow:hidden` — the shell never
  scrolls; only the two inner panes do.
- **Header** (`flex:none`, `border-bottom: 2px solid var(--border)`, background
  `var(--background)`): 8px/16px padding row containing the `ButterStick` mark (22px tall),
  the wordmark "Buttery" in Alfa Slab One 1rem, then right-aligned: household switcher
  (`Button variant="outline" size="sm"` — "The Cousineau kitchen"), account
  (`Badge variant="secondary"` — "@dcousineau.com"), and `Button variant="ghost" size="sm"`
  — "Sign out". A 14px `.gingham-band` sits on the header's bottom edge.
- **Nav rail**: the design system `Sidebar` (16rem). Order: Home, **Recipes** (active),
  Collections `soon`, Shopping list `soon`, Meal planner `soon`, Randomizer `soon`.
  Group label "The pantry". Active item = butter fill + 2px ink border + `pop-sm`.
- **No footer.** The screen is a fixed-height application view, so the marketing footer
  from the app-screen template was removed.

### 2. Recipe ledger (left pane)

- **Purpose**: scan, filter, and select. Selection is the primary interaction.
- **Layout**: grid column `minmax(320px, 380px)`, `border-right: 2px solid var(--border)`,
  `display:flex; column; min-height:0`. Filter bar is `flex:none`; the list below is
  `flex:1; min-height:0; overflow:auto`.

**Filter bar** (`padding: 8px 10px`, `border-bottom: 2px solid var(--border)`,
background `var(--card)`, two rows with 6px gap — deliberately compact, _not_ a card):

- Row 1 (`display:flex; gap:6px`):
  - Search field: 30px tall, `2px solid var(--border)`, `--radius-lg`, background
    `var(--background)`, 9px horizontal padding, leading Lucide `book-open-text` at 13px,
    borderless transparent `<input>` at 0.8125rem/500. Placeholder: "Search 10 recipes".
  - Sort `<select>`: 30px, 0.75rem/600, options **Recent** (default) · Quickest · A–Z.
  - `Button size="sm"` — "Add". The only creation affordance on the screen.
- Row 2: tag chips, `display:flex; flex-wrap:wrap; gap:4px`. Each chip: 22px tall,
  0–9px padding, `2px solid var(--border)`, `--radius-pill`, 0.6875rem/600. Inactive =
  `background:var(--background); color:var(--foreground)`; active = `background:var(--primary);
color:var(--primary-foreground)`. Chips are **single-select**: `All` (default), then every
  distinct tag in the data, in first-seen order — Baking, Sides, Vegetarian, Weeknight,
  Sunday, Beef, Noodles, Chicken, Snacks, Weekend, Sauces, Basics, Breakfast.

**Row** (`grid-template-columns: 44px minmax(0,1fr) auto; gap:10px; align-items:center;
padding: 7px 10px`, bottom divider `2px solid color-mix(in oklab, var(--border) 45%, transparent)`):

- **Thumb**: 44×44, `2px solid var(--border)`, `--radius-sm`, `background: var(--muted)`,
  centered Lucide `utensils-crossed` at 16px in `--muted-foreground`. This is the design
  system's documented no-photo fallback; when real recipe images exist, they render here
  with the same border and radius, `object-fit: cover`.
- **Middle stack** (`min-width:0`, 2px gap, all three lines ellipsized, `nowrap`):
  1. Title — 0.8125rem/700, line-height 1.2. If favorited, a 12px Lucide `star` in
     `--primary` follows the title.
  2. Source — 0.6875rem/600 `--muted-foreground`, with an 11px leading glyph keyed to
     source kind: web = `external-link`, handwritten/offline note = `pencil`,
     atproto handle = `book-open-text`. **Not a link** — this is a provenance label.
  3. Tags — 0.6875rem `--muted-foreground`, joined with " · ".
- **Trailing**: total time, 0.6875rem/700 `--muted-foreground`, `nowrap`.
- **Selected row**: `background: var(--accent)`. Unselected: `transparent`.
  Row is `role="button" tabindex="0"`, cursor pointer.

**Empty state** (search/filter yields nothing): centered column, 2.5rem/1.25rem padding,
Lucide `utensils-crossed` at 32px, "Nothing matches that." (0.8125rem/700) and
"Clear the tag filter to see the whole household's shelf again." (0.75rem, muted).

### 3. Recipe detail (right pane)

- **Purpose**: read the recipe and act on it. Scrolls independently
  (`overflow:auto`); content column capped at `max-width: 54rem`, `padding: 16px 20px 32px`,
  14px gap.

**Title block**

- `h1` — Alfa Slab One 1.625rem, line-height 1.1, `text-wrap: pretty`.
- Meta line — one wrapping flex row, `gap: 4px 8px`, 0.75rem/600 `--muted-foreground`;
  each icon+text pair is its own `nowrap` span, separated by `·` siblings:
  `[source icon] source · [clock] time · tags · saved by @handle`.

**Action row** (`flex; wrap; gap: 8px`)

1. **"Apron on"** — primary. 36px tall, 16px padding, `2px solid var(--border)`,
   `--radius-lg`, `background: var(--primary)`, `color: var(--primary-foreground)`,
   `box-shadow: var(--shadow-pop)`, 0.875rem/700, leading Lucide `cooking-pot` 16px.
   Full sticker physics: hover `translate(-2px,-2px)` + `--shadow-pop-lg`, active
   `translate(2px,2px)` + `--shadow-pop-sm`, 100ms linear. This is the cook-mode entry
   point — deliberately _not_ a play triangle.
2. **Favorite** — 32px, `--shadow-pop-sm`, Lucide `star` 14px. **Toggle**: label swaps
   "Favorite" ⇄ "Favorited", fill swaps `var(--card)` ⇄ `var(--primary)`, and the ledger
   row picks up its star. Carries `aria-pressed`.
3. **"Add to shopping list"** — 32px, `background: var(--card)`, hover `var(--accent)`,
   Lucide `shopping-basket` 14px. **One-shot action, not a toggle.**
4. **"Add to meal planner"** — same treatment, Lucide `calendar-range` 14px. One-shot.
5. **Confirmation chip** — appears after 3 or 4 for **2400ms**, then disappears: 32px,
   `background: var(--secondary)`, `color: var(--secondary-foreground)`, Lucide `check`
   14px, text "Added to the shopping list" / "Added to this week's plan". A real
   implementation should use the design system `Toast` + `useToasts` here.

**Body** — `grid-template-columns: minmax(0,1fr) minmax(0,1.35fr); gap: 20px; align-items:start`.

_Left column:_

- Photo well — full width, `aspect-ratio: 4/3`, `2px solid var(--border)`, `--radius-lg`,
  `background: var(--muted)`, centered `utensils-crossed` at 40px (no-photo fallback).
- **Ingredients** header row: `h2` (Alfa Slab One 1rem) with a **quiet** right-aligned
  "Scale & convert" button — borderless, transparent, 22px tall, 0.6875rem/700
  `--muted-foreground`, Lucide `settings-2` 12px, hover fills `var(--accent)` and darkens
  to `--foreground`. When a non-default setting is active the label becomes the current
  state, e.g. `2× · metric`. Carries `aria-expanded`.
- **Scale & convert panel** (collapsed by default): `2px solid var(--border)`,
  `--radius-lg`, `background: var(--card)`, 8px padding, wrapping flex row —
  - `Scale` select, 26px: 0.5× · **1× (default)** · 1.5× · 2× · 3×
  - `Units` select, 26px: **Imperial (US) (default)** · Metric
  - right-aligned underlined "Reset" text button → returns to 1× / US.
- Ingredient list — unstyled `ul`, 5px gap, 0.8125rem/1.35, each item a 5px `--primary`
  dot (5px top offset) + text.
- **Nutrition strip** — `2px solid var(--border)`, `--radius-lg`, `background: var(--card)`,
  overflow hidden. Header row (6px/10px, bottom border 2px): "Nutrition" in Alfa Slab One
  0.8125rem, right side "per serving · {N} servings" at 0.6875rem/600 muted. Body is a
  `repeat(auto-fit, minmax(74px, 1fr))` grid with `gap: 2px` over a
  `color-mix(in oklab, var(--border) 45%, transparent)` background (the gap draws the
  rules; cells are `var(--card)`), each cell 7px/10px: value 0.9375rem/700 `nowrap`, then
  a 0.625rem/600 uppercase 0.04em-tracked muted label — **kcal · protein · carbs · fat**.

The two body columns are a wrapping flex row (left `flex: 1 1 240px`, right
`flex: 1.35 1 320px`), so the detail pane stacks Ingredients above Method rather than
crushing both when the window is narrow.

_Right column:_

- **Method** — `h2` Alfa Slab One 1rem; ordered list rendered as a flex column, 8px gap,
  0.875rem/1.45, `text-wrap: pretty`. Each step: a 20px circle (`2px solid var(--border)`,
  `border-radius: 50%`, `background: var(--primary)`, `color: var(--primary-foreground)`,
  0.6875rem/700 numeral) + step text, 9px gap.
- **Notes** — separated by `margin-top:6px; padding-top:12px; border-top: 2px solid
color-mix(in oklab, var(--border) 45%, transparent)`. Header: `h2` "Notes" (Alfa Slab One
  1rem) beside a privacy label — Lucide **`eye-off`** at 12px + "Never leaves this
  household", 0.6875rem/600 muted. (`eye-off` over a padlock: the note isn't
  access-controlled, it's simply not published to the network.) Field: `textarea`,
  4 rows, full width, 8px/10px padding, `2px solid var(--border)`, `--radius-lg`,
  `background: var(--card)`, 0.8125rem/1.45, `resize: vertical`. Placeholder:
  "What you'd change next time — the oven that runs hot, the swap that worked."
  Notes are stored **per recipe**.

---

## Interactions & Behavior

- **Select a row** → detail pane re-renders in place. No navigation, no scroll reset of
  the ledger. The detail pane should reset its own scroll to top on selection change.
- **Search** — case-insensitive substring across title + source + tags, applied live.
- **Tag chips** — single-select, `All` clears. Composes with search (AND).
- **Sort** — Recent (source array order) · Quickest (ascending total minutes) · A–Z
  (`localeCompare` on title).
- **Favorite** — toggles; reflected immediately in the ledger row.
- **Add to shopping list / meal planner** — fire-and-forget; show the confirmation chip
  for 2400ms (one at a time; a second click restarts the timer).
- **Scale & convert** — recomputes the ingredient list and the servings count in the
  nutrition header (`round(serves × factor)`). Per-serving nutrition values do **not**
  change. Setting persists while browsing (it is a reading preference, not per recipe);
  a real implementation should decide whether to persist it per user.
- **Apron on** — enters cook mode (not designed yet; wire to the future full-screen route).
- **Notes** — free text, saved per recipe, household-visible, never published.
- **Motion** — 100ms linear sticker physics on the primary button only. Nothing else
  animates. Honor `prefers-reduced-motion` (design system reduces everything to 0.01ms).
- **Focus** — 3px `var(--ring)` at 2px offset on every interactive element, including rows.
- **Responsive** — below ~1024px the two panes should collapse to a single column:
  ledger first, detail pushed to a route/sheet. The nav rail becomes an 18rem left `Sheet`
  below 768px (existing app behavior). This was not designed in the prototype.

### Ingredient scaling & conversion rules (as prototyped)

Parse a leading quantity from each ingredient string; if none is found, pass the line
through unchanged ("Lemon, to finish", "A pot of boiling water").

- Accepted quantity forms: `2`, `1.5`, `1/2`, `½`, `1¼`. Unicode fractions
  ¼ ½ ¾ ⅓ ⅔ ⅛.
- Multiply by the scale factor.
- **To metric**: cup/cups ×236.6 → ml; tbsp ×14.8 → ml; tsp ×4.9 → ml; lb ×453.6 → g;
  oz ×28.35 → g. Metric results round to the nearest 5, or nearest 10 above 100.
- **To US**: g ÷28.35 → oz; ml ÷236.6 → cups.
- Non-convertible units ("can", "head", "sprigs", "eggs") and bare counts are scaled
  and re-emitted verbatim.
- **US display formatting**: values ≥10 round to whole numbers; below 10, round to the
  nearest eighth and render with unicode fractions (`1½`, `¾`, `2⅛`).
- Production note: pluralization is not handled ("2 can coconut milk"), and volume-to-mass
  conversion for dry goods (flour, cornmeal) is not attempted. A real implementation
  should store structured quantities on the recipe record rather than parsing strings.

## State Management

Local view state (no server round-trip needed for any of it except persistence):

| State       | Type                      | Default        | Drives                                       |
| ----------- | ------------------------- | -------------- | -------------------------------------------- |
| `q`         | string                    | `""`           | search filter                                |
| `tag`       | string                    | `"All"`        | tag chip filter                              |
| `sort`      | `recent \| time \| title` | `"recent"`     | list order                                   |
| `open`      | recipe id                 | first recipe   | which recipe the detail pane shows           |
| `favs`      | id[]                      | `["potroast"]` | star in ledger + Favorite button             |
| `flash`     | string                    | `""`           | confirmation chip; cleared by a 2400ms timer |
| `scaleOpen` | boolean                   | `false`        | scale panel disclosure                       |
| `factor`    | number                    | `1`            | ingredient scaling + servings count          |
| `metric`    | boolean                   | `false`        | unit system (false = Imperial/US)            |
| `notes`     | `{ [recipeId]: string }`  | `{}`           | Notes textarea                               |

Persistence needed in the real app: `favs`, `notes`, and the shopping-list / meal-planner
writes. Recipes themselves are atproto records in the user's PDS; the ledger reads the
household's shared collection.

**Data shape per recipe** (as used by the prototype):
`{ id, title, source, kind: 'web'|'note'|'handle', mins, time, tags[], saver,
ingredients[], steps[] }` plus a nutrition record
`{ serves, kcal, protein, carbs, fat }`. `time` is the display string for `mins`;
derive it rather than storing both. `source` is a bare domain for web recipes
("smittenkitchen.com"), a plain description for offline sources ("Index card, Ro's box",
"Handwritten, Dad"), or an atproto handle ("@maddy.kitchen").

## Design Tokens

Use the semantic tokens from the Buttery design system — never raw brand hexes in
product code. Hex values are reference only.

**Color (light):** `--background` paper `#fffdf4` · `--card` / `--muted` cream `#fff6e3`
· `--foreground` / `--border` / `--shadow-hard` ink `#2a1e12` · `--primary` butter
`#ffd84d` with ink `--primary-foreground` · `--accent` butter-pale (nav/row highlight) ·
`--secondary` · `--muted-foreground` · `--ring`. Dark mode ("toasted") flips background
to `#1c1106`, relaxes borders to `#4d3a22`, and keeps butter byte-identical.

**Type:** Alfa Slab One 400 (display: wordmark, h1, section headings, nutrition header) ·
Rubik 400/500/600/700 (everything else). Sizes used: 1.625rem h1 · 1rem section h2 ·
0.9375rem nutrition value · 0.875rem method body / primary button · 0.8125rem row title,
ingredients, notes · 0.75rem meta, selects · 0.6875rem source, tags, time, chips, quiet
button · 0.625rem nutrition labels.

**Spacing:** 2 · 4 · 5 · 6 · 7 · 8 · 10 · 14 · 16 · 20 px in this screen (Tailwind
0.25rem step).

**Radii:** `--radius: 0.75rem`; `--radius-sm` 8px (thumb, small selects) ·
`--radius-lg` 12px (buttons, inputs, panels) · `--radius-pill` (chips) · 50% (step numerals).

**Control heights** (the shared scale — never hand-set a height):
`xs` 24 · `sm` 28 · default 32 · `lg` 36 · `xl` 48 · `2xl` 64. This screen uses 22px chips
and 26/30px filter-bar controls as intentionally-dense exceptions inside the filter bar,
32px for secondary actions, 36px for the primary.

**Borders:** 2px solid `--border` on every surface; internal dividers use
`color-mix(in oklab, var(--border) 45%, transparent)`.

**Shadows** (zero blur, ink, offset only): `--shadow-pop-sm` 2px · `--shadow-pop` 3px ·
`--shadow-pop-md` 4px · `--shadow-pop-lg` 6px.

## Assets

- **Icons**: [Lucide](https://lucide.dev) only — outline, 2px stroke, `currentColor`,
  `aria-hidden` unless the icon is the control's sole content. Used here:
  `book-open-text`, `utensils-crossed`, `external-link`, `pencil`, `clock`, `star`,
  `cooking-pot`, `shopping-basket`, `calendar-range`, `check`, `settings-2`, `eye-off`.
  The prototype loads Lucide from `unpkg.com/lucide@0.474.0`; the app uses `lucide-react`.
- **Brand mark**: `ButterStick` from the design system. Note the repo states the mark is a
  placeholder.
- **No photography.** Every image position renders the documented no-photo fallback.
  Recipe photos are user/network content: warm, unfiltered, 2px ink border, 4:3 box.

## Files

- `screenshots/` — reference captures at 1440×840:
  `1-default.png` (first recipe selected) · `2-tag-filtered.png` (Weeknight chip active,
  list narrowed) · `3-scale-convert.png` (Scale & convert panel open) ·
  `4-favorited-and-added.png` (Favorited state + the transient "Added to the shopping list"
  chip, with the star mirrored onto the ledger row).
- `AppScreen.dc.html` — the design (template + logic, with the recipe fixture data).
- `AppScreen.standalone.html` — self-contained offline copy; open this to review.
- Design system source: `_ds/buttery-design-system-79cab411-a51c-4fb9-b7d0-09da0ef462ec/`
  (`styles.css` + `tokens/*.css` are the token source of truth).
- In the real repo, the counterpart surfaces are `services/web/src/routes/*.tsx` and the
  vendored primitives in `services/web/src/components/ui/*.tsx`.

## Open questions for the spec

1. What does "Add to meal planner" actually do — does it need a day/slot picker, or does it
   drop into an unscheduled tray? The prototype treats it as fire-and-forget.
2. Should the scale/units preference persist per user, per recipe, or reset each visit?
3. Does the ledger need pagination or virtualization at real household sizes?
4. Where do public/network recipes appear, if at all? This screen is household-scoped only.
5. Cook mode ("Apron on") is undesigned — it is the product's stated top priority and needs
   its own spec against the `xl`/`2xl` control tier.
