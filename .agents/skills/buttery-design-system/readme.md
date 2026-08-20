# Buttery Design System

**Buttery** is a social recipe and kitchen-management app built on **atproto**. The
name is the *noun*: a buttery is a pantry — a room where the good stuff is kept.
Recipes live as portable atproto records in the user's own PDS, so many apps can
share one public recipe database; private household collections, meal planning and
cook mode sit on top.

Live: <https://buttery.recipes/>

## The aesthetic: neo-brutalism

The design language is **neo-brutalism** — 2px ink outlines on everything, flat
fills, hard un-blurred offset shadows, and controls that behave like physical
stickers (lift on hover, sink on press). Two influences feed into it:

1. **Betty Crocker cookbooks** — red-and-white gingham, confident 1950s American
   kitchen graphics, heritage warmth.
2. **Gen-Z pop-art butter sticks** — flat bold color, thick ink outlines,
   sticker-like hard offsets.

The blend, in the brand's own words: *a 1950s grocery ad reprinted as a sticker
pack.* Heritage shapes, modern loudness, neo-brutalist construction.

> **Terminology note.** The source `docs/BRAND.md` calls this construction "the
> pop-art kit". The design system standardises on **neo-brutalism** as the name
> for the same set of rules — 2px borders, hard shadows, sticker physics, flat
> fills, no gradients or glass. Both names describe the same thing; prefer
> "neo-brutalism" in new docs.

## Products

There is one product — the Buttery web app — with two surface families, and one
supporting service with no UI:

| Surface | What it is | UI kit |
| --- | --- | --- |
| Public web (`buttery.recipes`) | Marketing landing, sign-in, public recipe pages, legal pages, `COMING_SOON` holding page | `ui_kits/marketing/` |
| Signed-in app | Nav-rail shell, pantry home, household management, onboarding, invites | `ui_kits/app/` |
| `worker` | Headless Temporal worker; its `atproto-sync` workflow pulls recipe records from the atmosphere into Postgres | no UI |

**Shipped today:** landing, login/OAuth via atproto, public recipe detail,
household create/rename/delete, members and roles, bound + shareable invites,
onboarding, theme toggle, legal pages.
**Named but unbuilt (visible as `soon` chips in the nav):** Recipes, Collections,
Shopping list, Meal planner, Randomizer — and **cook mode**, which the brand doc
names as the top priority. Nothing in this design system invents those screens.

Stack: TanStack Start + React + Tailwind v4 + **shadcn/ui on Base UI primitives
(`base-nova` style)**, Postgres via Kysely. shadcn components are vendored into
`src/components/ui/` and edited in place — the neo-brutalist construction lives
inside those files, and app code composes primitives rather than restyling them.

## Sources this system was built from

- **Codebase** (attached, read-only local folder `buttery/`) — a pnpm monorepo:
  - `services/web/` — the app. `src/styles.css` is the token source of truth;
    `src/components/ui/*.tsx` is the component inventory; `src/routes/*.tsx` are
    the screens.
  - `services/worker/` — Temporal worker (the atproto sweep and future pipelines).
  - `packages/lexicons/` — atproto lexicon definitions.
  - `docs/BRAND.md` — the brand guide, copied verbatim to
    `guidelines/BRAND-source.md`.
  - `docs/ECOSYSTEM.md`, `docs/research/*` — atproto architecture notes.
- **Live site** — <https://buttery.recipes/>
- No Figma file, no slide deck, and no design mocks were provided.

## Index

| Path | What's in it |
| --- | --- |
| `styles.css` | The single entry point consumers link. `@import` lines only. |
| `tokens/` | `fonts` · `colors` · `typography` · `spacing` · `elevation` · `motion` · `base` · `brand-utilities` |
| `components/core/` | `Button` `Badge` `Card` `Alert` `Separator` |
| `components/forms/` | `Input` `Select` `Textarea` `Label` `Field` `Checkbox` + `CheckboxRow` `Radio` + `RadioCard` `Switch` |
| `components/feedback/` | `Skeleton` `Spinner` `Tooltip` `Toast` + `useToasts` |
| `components/navigation/` | `Sidebar` `DropdownMenu` `Sheet` |
| `components/disclosure/` | `Accordion` |
| `components/overlay/` | `Dialog` + `ConfirmDialog` |
| `components/brand/` | `ButterStick` `GinghamBand` |
| `ui_kits/marketing/` | Public web click-through (landing, login, recipe detail) |
| `ui_kits/app/` | Signed-in app click-through (nav rail, pantry, household, onboarding) |
| `ui_kits/shared/` | `Chrome.jsx` — Header, Footer, Icon helper, recipe image slot |
| `templates/marketing-page/` | Starting template — public-web page shell (header, hero, feature grid, footer) |
| `templates/app-screen/` | Starting template — signed-in shell (header, nav rail, content column, footer) |
| `guidelines/` | Foundation specimen cards + `BRAND-source.md` (verbatim source brand doc) |
| `assets/` | Favicons, PWA logos, OG image (all placeholder-mark based) |
| `handoff/` | **Drop-in patch set for the `buttery` repo** — replacement `BRAND.md`, `styles.css` token additions, size-scale patches for Button/Badge/Input/Card/Dialog, and repo-ready TSX for the seven new primitives |
| `SKILL.md` | Agent-Skills front matter for use outside this project |

Every `.jsx` component has a sibling `.d.ts` (props contract) and `.prompt.md`
(one-line "what & when", usage example, variant notes).

---

# CONTENT FUNDAMENTALS

## Voice

Warm, plain, a little cheeky. A knowledgeable friend in a kitchen, not a brand.
Butter and pantry puns are allowed but **capped at one per screen** — the landing
page spends its one on "spread generously" and then plays it straight.

## Person

**You / your** for the reader. **We** almost never appears; when the product must
speak as itself it says what it does rather than what it feels ("Buttery keeps
your recipes on your own atproto account"). Never "our platform", never "users".

Buttery uses the reader's own possessive constantly: *your pantry*, *your
household*, *your invitations*, *your own atproto account*, *your recipes*.

## Casing and punctuation

- **Sentence case everywhere** — headings, buttons, labels, badges. No Title Case.
- Buttons and labels take no terminal punctuation; body copy does.
- Dialog titles are questions ending in `?` — "Leave this household?", "Delete
  this household?", "Create another household?"
- Real typographic characters: `—` em dashes (spaced), `·` middots as metadata
  separators, `…` a single ellipsis character in pending labels, curly apostrophes.
- `atproto` is lowercase, always. `Bluesky` is capitalised. "internet handle" is
  lowercase prose; the form label is "Internet Handle".
- The dictionary joke is set as a real dictionary entry: **but·ter·y** *(noun)*.

## Buttons say what they do

| Do | Don't |
| --- | --- |
| Sign in with atproto | Get started |
| Save recipe · Fetch · Open invite | Submit |
| Create a household · Create invite | Continue |
| Leave · Delete household | Yes, I'm sure |
| Back to the pantry | ← Back |

Pending states swap the label to a present-progressive with an ellipsis:
"Fetching…", "Redirecting…".

## Headings and eyebrows

The house pattern is a butter `Badge` eyebrow, then a display-font `h1`, then a
muted lead paragraph:

> `A social recipe box on the open web`
> **Good recipes, spread generously.**
> but·ter·y *(noun)* — a pantry; a room where the good stuff is kept…

Section headings are short and domestic: "What's in the pantry", "Fresh from the
pantry", "Your pantry", "The pantry" (the nav group label), "Join a household",
"Welcome to the pantry", "Starting fresh?", "Danger zone".

## Empty and unbuilt states

Empty states explain and reassure rather than prompt — "When someone invites you
to their household, it'll appear here for you to accept. Waiting for an invite is
the easiest way in — you don't need to create anything yourself." Unbuilt features
stay visible in the nav with a `soon` chip: the roadmap is part of the copy.

## Honesty about atproto

Never hide the atproto-ness — say plainly that recipes live in the user's own PDS
and that they can leave with everything. "Buttery doesn't host accounts — you
bring your own." Portability is a feature, described in plain words, not jargon.

## Emoji

**None.** Zero emoji appear anywhere in the product, and none belong in Buttery
copy. Iconography does that job (see ICONOGRAPHY).

## Sample copy to imitate

- "The whole point. Recipes rendered huge and glare-proof for the counter — no
  sleep, no scrolling with buttery thumbs."
- "Can't decide? Roll the dice, dinner picks itself."
- "Lay the week out on the table before it starts."
- "Share this link with the person you're inviting. It's the only time it's shown."
- "Most people only need one household. If you really need a separate space,
  create another."
- "© 2026 Buttery — the pantry where the good stuff is kept."

---

# VISUAL FOUNDATIONS

## Color

Warm from top to bottom. **No pure `#000` or `#FFF` exists in light mode** — the
darkest value is ink `#2a1e12` (a brown-black) and the lightest is paper
`#fffdf4`. Four brand colors do everything: butter `#ffd84d`, Crocker red
`#e2231a`, ink, cream `#fff6e3`.

Dark mode is called **"toasted"**: butter and a lifted red `#ff6242` glowing on
deep brown-black `#1c1106`, like butter on dark toast. **Butter yellow is byte-identical
in both themes** — it is the brand constant. Dark mode also relaxes the border
from ink to `#4d3a22` and switches the shadow color to true black.

Product code uses **semantic tokens only** (`--primary`, `--border`,
`--muted-foreground`). Raw brand values (`--butter`, `--crock-red`) are reserved
for brand moments: the mark, hero highlights. Red is for large text, borders and
fills-with-cream-text — never small body copy.

## Type

Two faces, no third, nothing thinner than 400.

- **Alfa Slab One** (display) — wordmark, page titles, big numbers, dialog titles,
  card titles that are page-level moments. Loaded at 400 only, letter-spacing
  `0.01em`, line-height `1.08–1.1` on large sizes. Floor ≈ 1.25rem. Never body
  copy, never a small UI label.
- **Rubik** 400/500/600/700 (everything else). Big x-height, slightly rounded,
  legible at arm's length — chosen for cook mode.

One or two display moments per screen, maximum. Both fonts come from Google Fonts.

## Spacing and layout

Tailwind's 0.25rem step; 4/6/8 (`1rem`/`1.5rem`/`2rem`) carry most of the rhythm.
Fixed layout facts:

- Content column: `min(1080px, 100% - 2rem)`, centred (`.page-wrap`).
- Header is **`position: fixed`** full-width (not sticky — so macOS overscroll
  can't rubber-band it), and publishes its measured height to `--header-height`.
- The 16rem nav rail is fixed and starts *below* the header; it becomes an 18rem
  left `Sheet` drawer under 768px. Below 1024px, layouts collapse to one column.
- Page padding: `pt-10 pb-8` mobile, `pt-14` from `sm` up.

## The control-height scale

**Every inline control shares one height scale**, so a badge, a button, an input
and a select at the same `size` line up pixel-for-pixel with no hand-tuning:

| `size` | Height | Where it's used |
| --- | --- | --- |
| `xs` | 24px | inline chips, table-row actions |
| `sm` | 28px | dense toolbars, member-row controls |
| `default` | 32px | the standard app density |
| `lg` | 36px | primary forms, mobile touch targets |
| `xl` | 48px | **cook mode** |
| `2xl` | 64px | **cook mode, full screen** |

Tokens: `--control-h-*` and `--control-px-*` in `tokens/spacing.css`. This
*harmonises* the source app, which shipped 32px buttons next to 36px inputs — the
36px step is still there as `lg`, but the two are no longer accidentally
different. Never set a height on a control by hand; pick a `size`.

## Cook mode: the extra-large tier

Cook mode is not designed yet, but it is the product's stated top priority and it
is **full-screen, arm's-length UI operated with flour on your hands**. Every
primitive therefore carries an oversized tier now, so cook mode can be assembled
from the same system rather than a parallel one:

- **Button** — `xl` (48px) and `2xl` (64px), plus `icon-xl` / `icon-2xl`.
- **Checkbox / CheckboxRow** — `xl`: a 40px box in a 1.5rem row. Checklists are
  the highest-traffic interaction in the product, so `CheckboxRow` makes the
  entire row the hit target and strikes through when checked.
- **Radio / RadioCard / Switch** — `xl` (40px dot, 80×44px track).
- **Input / Select / Textarea** — `xl` / `2xl` on the shared scale.
- **Card** — `lg` / `xl` spacing steps (`xl` also bumps the title to 1.5rem and
  the shadow to 6px).
- **Accordion** — `size="xl"`, for stepping through recipe stages.
- **Toast** — `size="xl"`, bottom-center, legible from the counter.
- **Dialog** — `size="fullscreen"`: no scrim, no border, no radius, 3rem display
  title. That is the cook-mode shape.

Rules for the tier: minimum 44px hit target, body never below 1.25rem, high
contrast, and **no hover-dependent controls** — a phone propped against a toaster
has no hover.

## Corner radii

One knob: `--radius: 0.75rem`. Buttons and inputs `radius-lg` (12px); cards
`radius-xl` (16px); menu items `radius-sm` (8px); badges are fully pill
(`rounded-4xl`); step numbers and ingredient bullets are true circles. Small
buttons clamp with `min(var(--radius-md), 10–12px)` so the corner never eats the
control. Checkboxes tighten further at the small end — 3px at 16px, 4px at 20px,
6px at 28px — because a rounded 16px square reads as a radio button; at that size
the square corner *is* what separates check from choose.

## Borders

**2px solid ink** is the signature: buttons, cards, badges, inputs, menus, the
header's bottom edge, the footer's top edge, the nav rail's right edge, recipe
images. 1px is rare and deliberate — `Alert` and internal row dividers (which use
`border` at 60% opacity). There are no borderless surfaces except the tooltip.

## Shadows

Four steps, **zero blur, always ink** (`--shadow-hard`):
`pop-sm 2px` · `pop 3px` · `pop-md 4px` · `pop-lg 6px`. Cards sit at `pop-md`,
buttons rest at `pop`, menus at `pop-md`. There is **no inner shadow system, no
glow, no blurred shadow anywhere.** Elevation is communicated by offset distance
alone.

## Hover, press, focus, disabled

- **Hover (solid buttons):** translate `-2px, -2px` and grow the shadow to
  `pop-lg`. The sticker lifts off the page. `outline` also fills to `--accent`.
- **Press:** translate `+2px, +2px` and shrink to `pop-sm`. The sticker is pushed
  down. No color change, no scale.
- **Hover (flat things):** ghost buttons and menu items fill to `--muted` /
  `--accent` (butter-pale). No transform.
- **Hover (cards):** recipe cards translate `-2px` on Y only; the image inside
  scales to `1.03` over 300ms.
- **Focus:** 3px `--ring` ring at 2px offset, visible on everything. Inputs
  additionally gain a `pop` hard shadow — a focused field looks physically lifted.
- **Disabled:** `opacity: .5`, pointer-events off, and the shadow is *pinned* at
  `pop` so it can't lift.
- **Active nav item:** butter fill **plus** 2px ink border **plus** `pop-sm` — the
  most emphatic state in the system.

## Backgrounds

Flat cream. **No gradients, no imagery behind content, no textures, no noise.**
The only patterned surface is gingham, and gingham is **trim, not wallpaper**:
14px bands at the header's bottom edge and the footer's top edge, built from two
overlapping `repeating-linear-gradient`s in CSS — never an image. A full gingham
field is permitted only if content sits on `--paper` cards on top of it, and
never behind recipe content.

There are no protection gradients and no scrims over imagery: the system has no
text-on-photo pattern. Contrast comes from solid fills and ink borders.

## Transparency and blur

Almost never. Sanctioned uses, all of them:
`--muted` at 40–50% for footer/aside fills, `--destructive` at 10–30% for the
destructive badge, danger-zone border and invalid-field ring, `--warning` at
25% for the advisory-field ring, `border` at 60% for row dividers, and a
**2px backdrop-blur behind the dialog scrim only** (`supports-backdrop-filter`).
There is no glassmorphism, no frosted chrome, no translucent header.

## Imagery

Recipe photography is user/network content, warm and unfiltered — no duotone, no
grain overlay, no b&w treatment. Every image gets a 2px ink border and lives in a
4:3 box. When a record has no photo the app renders a `--muted` panel with the
Lucide `utensils-crossed` glyph at `size-10`/`size-14` — that fallback is part of
the design, not a gap. No stock illustration system exists.

## Animation

Small and mechanical. `100ms` for menus and tooltips, `150ms` dialogs and sheets,
`200ms` `linear` for nav chrome, `300ms` for the card image zoom, and one page
entrance: `.rise-in` — `opacity 0→1` with `translateY(10px→0)` over `500ms` on
`cubic-bezier(.16, 1, .3, 1)`. Menus and dialogs add a `zoom-in-95` +
`fade-in` and a 2px directional slide. No springs, no parallax, no scroll
animation, no loading skeleton shimmer beyond a 2s opacity pulse. Under
`prefers-reduced-motion` **everything** is reduced to `0.01ms`.

## Accessibility floor

WCAG A minimum, aiming AA. Focus visible everywhere. Keyboard operability,
labels/roles and touch targets are strict — no loose interpretation. Body text
stays high-contrast in both themes. Cook mode (future) mandates ≥1.25rem body,
high contrast, and **no hover-dependent controls**.

## Don't

No blurred shadows, gradients or glass. No pure `#000`/`#FFF` in light mode. No
third typeface, no weights under 400. No Alfa Slab One in body copy or small
labels. No gingham where recipes render. No emoji. No raw brand hexes in product
code — semantic tokens only. Don't bypass the primitives with custom styled
markup.

---

# ICONOGRAPHY

**System: [Lucide](https://lucide.dev)**, via `lucide-react` in the app. That is
the only icon set, and it is used exclusively — there is no custom glyph set, no
icon font, no PNG icons, and no SVG sprite sheet in the repo.

- **Style:** outline only, 2px stroke, round caps and joins, `currentColor`. Never
  filled, never duotone, never coloured independently of its text.
- **Sizes:** `1rem` (16px) inline in buttons, menu items and nav rows;
  `0.75rem` (12px) in badges and `xs` buttons; `1.25rem` (20px) beside card
  titles; `2.5rem`/`3.5rem` (40/56px) for the empty-state `utensils-crossed`.
- **Placement:** always a sibling of the label inside the control, spaced by the
  control's own `gap` (4–8px). Leading icons are the norm; `external-link` is the
  one trailing icon, and it appears on *every* off-site link.
- **Decorative by default:** `aria-hidden="true"` unless the icon is the control's
  only content, in which case the control carries `aria-label`.

**Glyph vocabulary in use** (copy these rather than picking new ones):

| Concept | Lucide name |
| --- | --- |
| Home / household | `house` |
| Recipes | `book-open-text` |
| Collections | `folder-lock` |
| Shopping list | `shopping-basket` |
| Meal planner | `calendar-range` |
| Randomizer | `dices` |
| Cook mode / calories | `cooking-pot` |
| No-image fallback | `utensils-crossed` |
| Members | `users` · owner `crown` · promote `shield` · remove `user-minus` · invite `user-plus` |
| Invites | `mail` · none yet `mail-question` · link `link-2` |
| Time | `clock` · yield `users` |
| Edit / confirm / copy | `pencil` · `check` · `copy` |
| Destructive | `trash-2` · leave `log-out` |
| Nav mechanics | `panel-left` · `chevrons-up-down` · `chevron-right` · `arrow-left` · `x` |
| Theme | `sun` · `moon` · auto `sun-moon` |
| Off-site | `external-link` · settings `settings-2` · overview `compass` |
| Pending | `loader-2` (as `Spinner`) |

**In this design system**, Lucide is loaded from CDN
(`https://unpkg.com/lucide@0.474.0/dist/umd/lucide.js`) and rendered through the
`Icon` helper in `ui_kits/shared/Chrome.jsx`. The only icon shipped as a real file
is the brand mark. **No icon was substituted** — Lucide is genuinely the source's
set. `Spinner` inlines the `loader-2` path so the primitive has no CDN dependency.

**Emoji and unicode:** no emoji, ever. The only non-icon glyphs used as UI are the
middot `·` as a metadata separator and `—` in prose.

## Logo & mark

`components/brand/ButterStick.jsx` is ported verbatim (geometry, strokes, fills)
from `src/components/ButterStick.tsx`: a flat stick of butter, ink outlines,
"BUTTER" in Alfa Slab One on the wrapper. `assets/` holds the derived favicons,
PWA icons and OG image copied from `services/web/public/`.

> **The mark is a placeholder.** The source repo says so explicitly, and the user
> confirmed it. Do not treat it as final brand identity; where a real logo is
> needed, set the wordmark "Buttery" in Alfa Slab One instead.

## Intentional additions

These have **no counterpart in the source yet** — they were authored at the user's
direction, ahead of the features that need them, so the whole suite shares one
visual grammar instead of being bolted on later. Each is neo-brutalised the same
way the vendored shadcn components are (2px border, hard shadow, sticker press):

| Addition | Why |
| --- | --- |
| `Checkbox` + `CheckboxRow` | Checklists are the product's core interaction (ingredients, shopping list, meal-plan claims). `CheckboxRow` encodes the row-as-hit-target + strike-through-when-done pattern, with a cook-mode `xl` step. |
| `Radio` + `RadioCard` | The invite form currently uses bare native radios; `RadioCard` is the pick-one pattern diets/portions/invite modes will need. |
| `Switch` | Household settings and cook-mode preferences ("keep the screen awake"). |
| `Textarea` | Recipe notes and the future draft/importer flow. |
| `Select` | Promotes the invite form's inline-styled raw `<select>` into a primitive so it isn't re-styled per screen. `NativeSelect` is an alias. |
| `Accordion` | Recipe stages, shopping list grouped by aisle, FAQ prose. |
| `Toast` + `useToasts` | Reversible successes ("Invite link copied") that currently have no home. |
| `GinghamBand` | The source ships `.gingham` / `.gingham-band` as CSS utilities only; wrapping them makes the "trim, not wallpaper" rule enforceable rather than advisory. |

Sizes on all of the above sit on the shared control scale, and each has an
oversized step for cook mode — see "Cook mode: the extra-large tier".

## Still not built

No Tabs, Avatar, Table, Popover, Command/Combobox, Slider, Progress, Breadcrumb or
Pagination primitive exists. Those have no product driver yet; nothing was
invented for them. If you need one, `pnpm dlx shadcn@latest add <component>` in
the app and neo-brutalise it first.
