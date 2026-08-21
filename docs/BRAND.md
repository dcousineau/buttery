# Buttery — Brand & Design Guide

Reference for anyone (human or agent) making design decisions in this app. Rough by
design; update it as decisions harden.

## What Buttery is

A social recipe app built on atproto. "Buttery" is the **noun**: a pantry, a room
where the good stuff is kept. Not the adjective. The app is your well-stocked
pantry of recipes, shared on the open web.

Shipped beyond the recipe box: meal planner, shopping list. Still planned:
private recipe collections, recipe randomizer. **Top priority: recipe display
while cooking.** Every
design decision defers to that — someone with flour on their hands, phone propped
against the toaster, squinting from a meter away.

## The aesthetic: neo-brutalism

The construction is **neo-brutalism** — 2px ink outlines on everything, flat
fills, hard un-blurred offset shadows, and controls that behave like physical
stickers. That is the name to use in docs, commits and design conversations.
(Earlier revisions of this file called it "the pop-art kit"; same rules, better
name.)

Two influences feed into it:

1. **Betty Crocker cookbooks** — red-and-white gingham, confident 1950s American
   kitchen graphics, the red spoon, heritage warmth.
2. **Gen-Z pop-art butter sticks** — flat bold color, thick ink outlines,
   sticker-like hard offset shadows, a butter stick drawn like it's the star of a
   poster.

The blend: _a 1950s grocery ad reprinted as a sticker pack._ Heritage shapes,
modern loudness, neo-brutalist construction.

## Palette

| Token           | Light     | Dark ("toasted") | Use                                                          |
| --------------- | --------- | ---------------- | ------------------------------------------------------------ |
| `--butter`      | `#FFD84D` | `#FFD84D`        | The star. Butter stick fill, highlights, active states       |
| `--butter-pale` | `#FFE9A0` | `#3D2B10`        | Butter top-face, soft fills, hover tints                     |
| `--crock-red`   | `#E2231A` | `#FF6242`        | Betty Crocker red. Primary actions, gingham, links           |
| `--ink`         | `#2A1E12` | `#FFF4DA`        | Text + outlines. Brown-black, never pure black in light mode |
| `--cream`       | `#FFF6E3` | `#1C1106`        | Page background                                              |
| `--paper`       | `#FFFDF4` | `#2A1B0C`        | Card / surface background                                    |

Dark mode is "toasted": butter and red glow against deep brown-black, like butter
on dark toast. Butter yellow stays identical across themes — it's the brand
constant. **Light butter mode is the default**; toasted is opt-in via the theme
toggle (and `auto` follows the OS).

## Typography

- **Display: Alfa Slab One**. Wordmark, page titles, dialog titles, big numbers.
  Loud, chunky, vintage-poster. Use sparingly — one or two display moments per
  screen, never body copy, never below ~1.25rem.
- **Body/UI: Rubik** (400/500/600/700). Everything else. Slightly rounded, big
  x-height, stays legible at cooking-mode sizes.
- No third face. Data/captions are Rubik at smaller sizes with `600` weight.
- Both are OFL faces from Google Fonts, but **self-hosted** — the app and the
  docs site serve them from their own `/fonts/`, and the OG renderer carries its
  own TrueType copies. Nothing fetches type from a CDN at runtime. Refresh them
  with `scripts/update-fonts.sh`; the generated CSS and `.woff2` are not
  hand-edited.

## Design system: shadcn/ui (Base UI primitives, `base-nova` style)

The component library is shadcn — components are vendored source in
`src/components/ui/` and are **ours to edit**. The neo-brutalist construction
lives inside those files; app code composes primitives and never re-implements
them.

Rules for app code:

- Use `Button`, `Card`, `Badge`, `Input`, `Select`, `Textarea`, `Checkbox`,
  `RadioGroup`, `Switch`, `Field`, `Accordion`, `Toast`, `Sidebar`, `Sheet`, etc.
  — never hand-rolled styled divs for things a primitive covers.
- Use **semantic tokens only** (`bg-primary`, `text-muted-foreground`,
  `border-border`); never raw brand hexes or `bg-[var(--butter)]` in app code.
  Brand colors are exposed as `bg-butter` / `bg-butter-pale` / `bg-butter-deep`
  for rare brand moments (the mascot, hero highlights).
- `className` on a primitive is for layout (margin, width, grid) — not for
  overriding its colors/typography. Landing-page `FeatureCard` highlight
  (`bg-secondary`) is the sanctioned exception.
- New primitives: `pnpm dlx shadcn@latest add <component>`, then neo-brutalise it
  (border-2, hard shadow, sticker physics) to match the kit before use.

### Semantic token mapping (defined in `src/styles.css`)

| shadcn token                 | Light                 | Dark                 | Meaning                             |
| ---------------------------- | --------------------- | -------------------- | ----------------------------------- |
| `background` / `foreground`  | cream / ink           | toast / cream-text   | page                                |
| `card`, `popover`            | paper                 | dark paper           | surfaces                            |
| `primary`                    | crocker red           | lifted red `#FF6242` | actions, links                      |
| `secondary`                  | butter                | butter               | brand accent actions, active states |
| `muted` / `muted-foreground` | deep cream / soft ink | deep brown / tan     | de-emphasis                         |
| `accent`                     | butter-pale           | `#3D2B10`            | hovers                              |
| `destructive`                | `#C21807`             | `#FF6242`            | dangerous actions, blocking errors  |
| `warning`                    | toffee `#9A6400`      | butter               | advisory form state (see below)     |
| `border`, `input`            | **ink**               | cream-text           | outlines everywhere                 |
| `ring`                       | red                   | butter               | focus                               |
| `sidebar-accent`             | butter                | butter               | active nav item                     |

Dark mode keys off the `.dark` class on `<html>` (set by the theme init script +
ThemeToggle) via `@custom-variant dark`.

### The neo-brutalist kit (signature construction)

Built into the ui components; shadow utilities registered in `@theme`:

- **2px solid `border-border` (ink)** on buttons, cards, badges, inputs, menus,
  checkboxes, radios, switches, accordion items, toasts.
- **Hard offset shadows, never blurred**: `shadow-pop-sm` (2px) / `shadow-pop`
  (3px) / `shadow-pop-md` (4px) / `shadow-pop-lg` (6px), all `var(--shadow-hard)`.
- **Sticker physics** (solid Button variants): hover translate `-2px,-2px` +
  shadow grows to `pop-lg`; press translate `2px,2px` + shadow shrinks to
  `pop-sm`. Ghost/link variants stay flat. Checkboxes, radios and rows get the
  press half only (`active:translate-[1px]`, shadow to none).
- Flat fills only. No gradients, no glassmorphism, no backdrop-blur — the single
  exception is the 2px blur behind the dialog scrim.

Button variant map: `default` = red (primary CTA), `secondary` = butter,
`outline` = paper w/ ink border, `ghost`/`link` = flat, `destructive` = dark red
fill.

Brand utilities in `src/styles.css`: `.display-title`, `.page-wrap`, `.gingham`,
`.gingham-band`, `.rise-in`.

### One control-height scale (non-negotiable)

Every inline control — `Button`, `Badge`, `Input`, `Select`, `Textarea` — takes the
same `size` prop and resolves to the same height. Never set a control height by
hand; pick a size.

| `size`    | Height | Tailwind | Where                               |
| --------- | ------ | -------- | ----------------------------------- |
| `xs`      | 24px   | `h-6`    | inline chips, row actions           |
| `sm`      | 28px   | `h-7`    | dense toolbars, member-row controls |
| `default` | 32px   | `h-8`    | standard app density                |
| `lg`      | 36px   | `h-9`    | primary forms, mobile touch targets |
| `xl`      | 48px   | `h-12`   | **cook mode**                       |
| `2xl`     | 64px   | `h-16`   | **cook mode, full screen**          |

This deliberately harmonises what used to be a 32px button sitting next to a 36px
input. `Badge`'s default is now 32px so it aligns with a default button; the old
24px chip is `size="xs"`.

### Cook mode: the extra-large tier

Cook mode isn't designed yet, but it is the stated top priority and it is
**full-screen, arm's-length UI operated with flour on your hands**. Every primitive
already carries an oversized tier so cook mode is assembled from this system
rather than a parallel one:

- `Button` — `xl` / `2xl`, plus `icon-xl` / `icon-2xl`.
- `Checkbox` / `CheckboxRow` — `xl`: 40px box in a 1.5rem row.
- `Radio` / `RadioCard` / `Switch` — `xl` (40px dot, 80×44px track).
- `Input` / `Select` / `Textarea` — `xl` / `2xl`.
- `Card` — `lg` / `xl` spacing steps (`xl` bumps the title to 1.5rem, shadow to 6px).
- `Accordion` — `size="xl"`, for stepping through recipe stages.
- `Toast` — `size="xl"`, bottom-center.
- `Dialog` — `size="fullscreen"`: no scrim, no border, no radius, 3rem display title.

Tier rules: minimum 44px hit target, body never below 1.25rem, high contrast, and
**no hover-dependent controls** — a phone propped against a toaster has no hover.

### Checklists are a first-class pattern

Ingredients, shopping lists and meal-plan claims are the highest-traffic
interaction in the product. `CheckboxRow` encodes the pattern: the **entire row is
the hit target**, and a checked row **strikes through and drops its shadow** so
remaining work stands proud of done work. Use `Checkbox` bare only inside a form
field. `indeterminate` is for a partially-checked group (a recipe, a store aisle).

Small checkbox radii are tighter than the global radius scale on purpose — 3px at
16px, 4px at 20px, 6px at 28px, 8px at 40px — because a rounded 16px square reads
as a radio button. At small sizes the square corner _is_ what separates check from
choose.

### Form fields have three states, not two

`aria-invalid` is **red and blocking**: the form will refuse this. `data-warning="true"`
is **amber and advisory**: worth a look, and fine to ignore. Everything else is neutral.
`Input`, `Textarea` and `Select` all key off both attributes, invalid always wins, and
`FieldWarning` is the matching message (⚠︎, `--warning`, no `role="alert"` — a note in
the margin doesn't get to interrupt).

Reach for warning whenever the app is guessing on the user's behalf: an ingredient with
no readable amount, a step that mentions a time we couldn't parse. Those recipes save
perfectly well. Painting them red teaches people that red means nothing.

Warning copy is **≤10 words**, names the upside rather than the mistake, and says the
fix is optional — "No amount read — optional, but “2 tbsp” helps lists." Light mode uses
a deep toffee `#9A6400` rather than butter, because butter on cream is ~1.6:1 and a
warning you cannot see is worse than no warning; dark mode gets the brand butter, which
clears 12:1 on toast.

## Gingham rules

Gingham is **trim, not wallpaper**. Thin bands (header bottom edge, footer
tablecloth strip, section dividers). Cream stays dominant so recipe content
breathes. Built in CSS (`.gingham` — two overlapping repeating gradients), never
an image. If a future screen wants a full tablecloth moment (e.g. empty states),
content sits on `--paper` cards on top of it.

## The butter stick

The mascot/mark: a flat pop-art stick of butter (SVG,
`src/components/ButterStick.tsx`) — yellow front, pale top, ink outlines, "BUTTER"
on the wrapper. Appears in the header wordmark (small) and hero (large). Don't
redraw it per-page; reuse the component.

**This mark is a placeholder.** Where a final identity is needed, set the wordmark
"Buttery" in Alfa Slab One instead of shipping the stick as a logo.

## Iconography

**Lucide only**, via `lucide-react`. No custom glyph set, no icon font, no PNG
icons, no sprite sheet.

- Outline only, 2px stroke, round caps/joins, `currentColor`. Never filled.
- Sizes: 16px inline in buttons/menus/nav; 12px in badges and `xs` buttons; 20px
  beside card titles; 40/56px for the empty-state `utensils-crossed`.
- Leading icons are the norm. `external-link` is the one trailing icon, and it
  appears on **every** off-site link.
- `aria-hidden="true"` unless the icon is the control's only content, in which
  case the control carries `aria-label`.

Established glyph vocabulary — reuse rather than picking new ones: `house`,
`book-open-text`, `folder-lock`, `shopping-basket`, `calendar-range`, `dices`,
`cooking-pot`, `utensils-crossed`, `users`, `crown`, `shield`, `user-minus`,
`user-plus`, `mail`, `mail-question`, `link-2`, `clock`, `pencil`, `check`, `copy`,
`trash-2`, `log-out`, `panel-left`, `chevrons-up-down`, `chevron-right`,
`chevron-up`, `chevron-down`, `arrow-left`, `x`, `sun`, `moon`, `sun-moon`,
`external-link`, `settings-2`, `compass`, `loader-2`, `globe`, `refresh-cw`.

`globe` is "public on the atproto network" and `lock` is its opposite — the pair
that says whether a recipe or a collection has left the household.

**No emoji, ever.** The only non-icon glyphs used as UI are `·` as a metadata
separator and `—` in prose.

## Voice & copy

- Warm, plain, a little cheeky. Butter puns allowed but max one per screen.
- **You / your** for the reader; "we" almost never appears.
- **Sentence case everywhere** — headings, buttons, labels, badges. No Title Case.
- Buttons say what they do: "Sign in with atproto", "Save recipe", not
  "Get started". Pending states swap to a present-progressive with a real ellipsis
  character: "Fetching…", "Redirecting…".
- Dialog titles are questions ending in `?`; confirm labels restate the verb
  ("Leave", "Delete household"), never "OK"/"Yes".
- Real typography: spaced em dashes, `·` middots, `…`, curly apostrophes.
- `atproto` is always lowercase. `Bluesky` is capitalised.
- Never hide the atproto-ness: users own their recipes, on their own PDS. Say so
  plainly.
- The noun joke is the tagline territory: "the pantry where the good stuff is
  kept." Set the dictionary entry as **but·ter·y** _(noun)_.
- Empty and unbuilt states explain and reassure rather than prompt. Unbuilt
  features stay visible in the nav with a `soon` chip — the roadmap is part of the
  copy.

## Layout

- Logged-in app: **top bar** (brand + auth state + theme toggle) and **left nav
  rail** (desktop ≥1024px) / slide-in drawer (mobile). Nav lists features; unbuilt
  ones show a "soon" chip and are non-interactive.
- Home (`/`) is a marketing-ish landing while logged out; still shows the shell.
- Content column: `min(1080px, 100% - 2rem)`.
- The header is `fixed` (not `sticky`) so macOS overscroll can't rubber-band it,
  and publishes its measured height to `--header-height`.

## Motion

Small and mechanical. 100ms menus/tooltips · 150ms dialogs/sheets · 200ms `linear`
nav chrome · 300ms recipe-card image zoom · 500ms `.rise-in`
(`cubic-bezier(.16,1,.3,1)`) as the one page entrance. No springs, no parallax, no
scroll animation. `prefers-reduced-motion` kills all of it.

## Accessibility floor (non-negotiable)

- **WCAG A minimum, aim for AA** (per AGENTS.md). AA color-contrast rules may be
  loosely interpreted — no strict ratio enforcement, but decisions lean toward AA,
  never away.
- Focus visible everywhere: 3px `--ring` outline, 2px offset. Inputs additionally
  gain a hard `pop` shadow on focus.
- `prefers-reduced-motion`: all transforms/animations off.
- Body text stays high-contrast in both themes (ink-on-cream, cream-on-toast); red
  is for large text/borders/fills with cream text, not small body text.
- Keyboard operability, labels/roles, and touch targets are strict-AA territory —
  no loose interpretation there.
- Cooking mode: min 1.25rem body, high contrast, no hover-dependent controls.

## Don't

- No blurred shadows, gradients, or glass effects (dialog scrim blur excepted).
- No pure `#000`/`#FFF` in light mode — everything warm.
- No third typeface, no thin font weights (<400).
- Don't put Alfa Slab One in body copy or small UI labels.
- Don't add gingham to content areas where recipes render.
- No emoji.
- Don't hand-set a control height — pick a `size`.
- Don't bypass the shadcn primitives with custom styled markup, and don't use raw
  brand hexes in app code — semantic tokens only.
