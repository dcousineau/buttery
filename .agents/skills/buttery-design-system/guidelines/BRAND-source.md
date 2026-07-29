# Buttery — Brand & Design Guide

Reference for anyone (human or agent) making design decisions in this app. Rough by
design; update it as decisions harden.

## What Buttery is

A social recipe app built on atproto. "Buttery" is the **noun**: a pantry, a room where
the good stuff is kept. Not the adjective. The app is your well-stocked pantry of
recipes, shared on the open web.

Planned features: private recipe collections, shopping list generator, meal planner,
recipe randomizer. **Top priority: recipe display while cooking.** Every design decision
defers to that — someone with flour on their hands, phone propped against the toaster,
squinting from a meter away.

## The two inspirations

1. **Betty Crocker cookbooks** — red-and-white gingham, confident 1950s American kitchen
   graphics, the red spoon, heritage warmth.
2. **Gen-Z pop-art butter sticks** — flat bold color, thick ink outlines, sticker-like
   hard offset shadows, a butter stick drawn like it's the star of a poster.

The blend: _a 1950s grocery ad reprinted as a sticker pack._ Heritage shapes, modern
loudness.

## Palette

| Token           | Light     | Dark ("toasted") | Use                                                                  |
| --------------- | --------- | ---------------- | -------------------------------------------------------------------- |
| `--butter`      | `#FFD84D` | `#FFD84D`        | The star. Butter stick fill, highlights, active states               |
| `--butter-pale` | `#FFE9A0` | `#3D2B10`        | Butter top-face, soft fills, hover tints                             |
| `--crock-red`   | `#E2231A` | `#FF6242`        | Betty Crocker red. Primary actions, gingham, links                   |
| `--ink`         | `#2A1E12` | `#FFF4DA`        | Text + pop-art outlines. Brown-black, never pure black in light mode |
| `--cream`       | `#FFF6E3` | `#1C1106`        | Page background                                                      |
| `--paper`       | `#FFFDF4` | `#2A1B0C`        | Card / surface background                                            |

Dark mode is "toasted": butter and red glow against deep brown-black, like butter on
dark toast. Butter yellow stays identical across themes — it's the brand constant.

## Typography

- **Display: Alfa Slab One** (Google Fonts). Wordmark, page titles, big numbers. Loud,
  chunky, vintage-poster. Use sparingly — one or two display moments per screen, never
  body copy, never below ~1.25rem.
- **Body/UI: Rubik** (Google Fonts, 400/500/600/700). Everything else. Slightly rounded,
  big x-height, stays legible at cooking-mode sizes.
- No third face. Data/captions are Rubik at smaller sizes with `600` weight.

## Design system: shadcn/ui (Base UI primitives, `base-nova` style)

The component library is shadcn — components are vendored source in
`src/components/ui/` and are **ours to edit**. The pop-art construction lives inside
those files; app code composes primitives and never re-implements them.

Rules for app code:

- Use `Button`, `Card`, `Badge`, `Input`, `Field`, `Sidebar`, `Sheet`, etc. — never
  hand-rolled styled divs for things a primitive covers.
- Use **semantic tokens only** (`bg-primary`, `text-muted-foreground`, `border-border`);
  never raw brand hexes or `bg-[var(--butter)]` in app code. Brand colors are exposed as
  `bg-butter` / `bg-butter-pale` / `bg-butter-deep` for rare brand moments (the mascot,
  hero highlights).
- `className` on a primitive is for layout (margin, width, grid) — not for overriding
  its colors/typography. Landing-page `FeatureCard` highlight (`bg-secondary`) is the
  sanctioned exception.
- New primitives: `pnpm dlx shadcn@latest add <component>`, then pop-art-ify it
  (border-2, hard shadow) to match the kit before use.

### Semantic token mapping (defined in `src/styles.css`)

| shadcn token                 | Light                 | Dark                 | Meaning                             |
| ---------------------------- | --------------------- | -------------------- | ----------------------------------- |
| `background` / `foreground`  | cream / ink           | toast / cream-text   | page                                |
| `card`, `popover`            | paper                 | dark paper           | surfaces                            |
| `primary`                    | crocker red           | lifted red `#FF6242` | actions, links                      |
| `secondary`                  | butter                | butter               | brand accent actions, active states |
| `muted` / `muted-foreground` | deep cream / soft ink | deep brown / tan     | de-emphasis                         |
| `accent`                     | butter-pale           | `#3D2B10`            | hovers                              |
| `destructive`                | `#C21807`             | `#FF6242`            | dangerous actions                   |
| `border`, `input`            | **ink**               | cream-text           | pop-art outlines everywhere         |
| `ring`                       | red                   | butter               | focus                               |
| `sidebar-accent`             | butter                | butter               | active nav item                     |

Dark mode keys off the `.dark` class on `<html>` (set by the theme init script +
ThemeToggle) via `@custom-variant dark`.

### The pop-art kit (signature construction)

Built into the ui components; shadow utilities registered in `@theme`:

- **2px solid `border-border` (ink)** on buttons, cards, badges, inputs, menus.
- **Hard offset shadows, never blurred**: `shadow-pop-sm` (2px) / `shadow-pop` (3px) /
  `shadow-pop-md` (4px) / `shadow-pop-lg` (6px), all `var(--shadow-hard)`.
- **Sticker physics** (solid Button variants): hover translate `-2px,-2px` + shadow
  grows to `pop-lg`; press translate `2px,2px` + shadow shrinks to `pop-sm`.
  Ghost/link variants stay flat.
- Flat fills only. No gradients, no glassmorphism, no backdrop-blur.

Button variant map: `default` = red (primary CTA), `secondary` = butter,
`outline` = paper w/ ink border, `ghost`/`link` = flat, `destructive` = dark red fill.

Brand utilities still in `src/styles.css`: `.display-title`, `.page-wrap`, `.gingham`,
`.gingham-band`, `.rise-in`.

## Gingham rules

Gingham is **trim, not wallpaper**. Thin bands (header bottom edge, footer tablecloth
strip, section dividers). Cream stays dominant so recipe content breathes. Built in CSS
(`.gingham` — two overlapping repeating gradients), never an image. If a future screen
wants a full tablecloth moment (e.g. empty states), content sits on `--paper` cards on
top of it.

## The butter stick

The mascot/mark: a flat pop-art stick of butter (SVG, `src/components/ButterStick.tsx`)
— yellow front, pale top, ink outlines, "BUTTER" on the wrapper. Appears in the header
wordmark (small) and hero (large). Don't redraw it per-page; reuse the component.

## Voice & copy

- Warm, plain, a little cheeky. Butter puns allowed but max one per screen.
- Buttons say what they do: "Sign in with atproto", "Save recipe", not "Get started".
- Never hide the atproto-ness: users own their recipes, on their own PDS. Say so plainly.
- The noun joke is the tagline territory: "the pantry where the good stuff is kept."

## Layout

- Logged-in app: **top bar** (brand + auth state + theme toggle) and **left nav rail**
  (desktop ≥1024px) / slide-in drawer (mobile). Nav lists features; unbuilt ones show a
  "soon" chip and are non-interactive.
- Home (`/`) is a marketing-ish landing while logged out; still shows the shell.
- Content column: `min(1080px, 100% - 2rem)`.

## Accessibility floor (non-negotiable)

- **WCAG A minimum, aim for AA** (per AGENTS.md). AA color-contrast rules may be loosely
  interpreted — no strict ratio enforcement, but decisions lean toward AA, never away.
- Focus visible everywhere: 3px `--ring` outline, 2px offset.
- `prefers-reduced-motion`: all transforms/animations off.
- Body text stays high-contrast in both themes (ink-on-cream, cream-on-toast); red is for
  large text/borders/fills with cream text, not small body text.
- Keyboard operability, labels/roles, and touch targets are strict-AA territory — no
  loose interpretation there.
- Cooking mode (future): min 1.25rem body, high contrast, no hover-dependent controls.

## Don't

- No blurred shadows, gradients, or glass effects.
- No pure `#000`/`#FFF` in light mode — everything warm.
- No third typeface, no thin font weights (<400).
- Don't put Alfa Slab One in body copy or small UI labels.
- Don't add gingham to content areas where recipes render.
- Don't bypass the shadcn primitives with custom styled markup, and don't use raw
  brand hexes in app code — semantic tokens only.
