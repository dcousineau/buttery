# Results: Cook mode ("Apron on") + global recipe timers

Execution log for the plan at [`../05-cook-mode.md`](../05-cook-mode.md). Built in a single pass on branch
`feat/cook-mode` against the live local dev server (Vite on `127.0.0.1:3000`), verified end-to-end in a real
browser (Claude-in-Chrome) as each piece landed. This document records **what was actually built**, how it was
verified, and the deliberate deviations.

## Summary

All 16 acceptance criteria (§14) are met. `pnpm typecheck` is clean, `pnpm test` passes **95/95** (34 new:
19 for the step-time parser, 15 for the timer store + persistence). The feature is pure client — **no** server
function, DB table, or migration was added. Cook mode is the codebase's first `React.lazy`/`<Suspense>` boundary
and its first `<ClientOnly>` usage; both are documented in `CookModeLauncher.tsx` as the template.

Verified live: tapping "5 minutes" in the detail method list started a global "Cook" timer (verb-derived label);
the header badge incremented and a per-recipe strip appeared; the header popover grouped In progress / Done;
"Apron on" opened the fullscreen dark modal on mise; prep checks dimmed with a gold border (no strikethrough);
"Start cooking" entered the focus-scroll cook phase where the same global timer was visible; keyboard ↓ and
click-to-centre advanced steps; exiting cook mode left the timer running and returned focus to "Apron on"; an
injected already-expired timer restored as **alarming** on a fresh tab with the header shaking (red alarm ring),
and **Ack** removed it and cleared the shake; `/acknowledgements` renders (AIL-4, CC0 credit).

## What was built (file → purpose)

| File                                                             | Purpose                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/web/src/lib/timers/parse.ts` (+ `.test.ts`)            | Pure step-time parser (§10): `parseStep` splits a step into text/time tokens; time regex handles single/decimal/range with word units (range → upper bound); `labelFor` verb-stems the ~14 words nearest the duration → verb table → prefix match → noun table → "Timer". 19 tests.                                                                                   |
| `services/web/src/lib/timers/store.ts`                           | Global `TimerStore` singleton via `useSyncExternalStore` (§6). Wall-clock `endsAt` (never a decremented counter), single tick driving re-render, visibility/focus recompute + **fire-on-return**, cap 8 (never drops an alarming timer), persistence (§9.1), `TIMER_STATE_VERSION`, and the `useTimers`/`useRecipeTimers`/`useTimerSummary`/`useHydrateTimers` hooks. |
| `services/web/src/lib/timers/store.test.ts`                      | 15 tests: wall-clock remaining, pause/resume, expiry→alarming (fires once), ack/dismiss removal, cap-never-drops-alarming, fire-on-return, persistence round-trip, version-mismatch discard, TTL drop, restore-expired-as-alarming, restore-running-remaining.                                                                                                        |
| `services/web/src/lib/timers/storage.ts`                         | `createClientOnlyFn`-guarded `readJSON`/`writeJSON`/`removeKey` — the single client-only localStorage seam (§4.1a) shared by the timer store and cook persistence.                                                                                                                                                                                                    |
| `services/web/src/lib/timers/alarm-delivery.ts`                  | `AlarmDelivery` interface + `ForegroundAlarmDelivery` (§7.4), with the **PWA seam** comment. Foreground impl: lazy-loads the sound module on the first `arm()` gesture, loops while ≥1 timer fires, posts a Notification when granted + hidden, vibrates where supported — all feature-detected.                                                                      |
| `services/web/src/lib/timers/alarm-sound.ts`                     | Lazy sound module (dynamically imported by the delivery). `DEFAULT_ALARM_URL = "/sounds/alarm-default.mp3"` (single swappable constant, not bundled). iOS unlock-on-gesture, loop, stop, mute.                                                                                                                                                                        |
| `services/web/src/components/timers/HeaderTimerIndicator.tsx`    | Always-mounted header button + count badge + shake (`motion-safe:` with a static alarm ring as the non-motion equivalent) + popover grouping Done/In-progress + mute toggle. Hydrates the store in an effect after first render. Mounted in `Header.tsx`.                                                                                                             |
| `services/web/src/components/timers/TimerRow.tsx`                | Shared timer row (popover, on-recipe strip, cook panel): live remaining, progress bar, recipe-title link; alarming rows lead with **Ack** + 1 min, otherwise Pause/Resume + Dismiss.                                                                                                                                                                                  |
| `services/web/src/components/timers/RecipeTimerStrip.tsx`        | The on-recipe strip (§6.5) — the store filtered to one recipe; renders nothing when empty.                                                                                                                                                                                                                                                                            |
| `services/web/src/components/timers/TimeToken.tsx`               | The tappable duration `<button>` (§10); `stopPropagation` so a cook-mode tap doesn't also centre the step. Detail (subtle) vs cook (gold) styling.                                                                                                                                                                                                                    |
| `services/web/src/components/recipes/StepText.tsx`               | Shared step renderer — `parseStep` → text + `TimeToken`s. Used by the detail method list and cook `StepView`.                                                                                                                                                                                                                                                         |
| `services/web/src/components/recipes/CookModeLauncher.tsx`       | "Apron on" + the `React.lazy`/`<Suspense>`/`<ClientOnly>` boundary. The only cook-mode thing `DetailPane` imports.                                                                                                                                                                                                                                                    |
| `services/web/src/components/recipes/cook/CookMode.tsx`          | The lazy shell (default export): fullscreen DS `Dialog` in the dark theme, ambient blobs, phase state, per-recipe persistence + Resume prompt, wake lock, Fullscreen-API escalation, Esc-from-cook→mise handling.                                                                                                                                                     |
| `.../cook/MisePhase.tsx`                                         | Large scaled checklist (custom `xl` check rows: gold border + dim, no strikethrough), prep progress, de-emphasized scale/unit controls that write back through `RecipesView`, "Start cooking".                                                                                                                                                                        |
| `.../cook/CookPhase.tsx`                                         | Focus-scroll steps (38vh spacers, opacity/blur by distance, ~700ms scroll-lock), keyboard nav (↓/→/Space next, ↑/← prev), click-to-centre, IngredientRail + TimersPanel + Back/Next/Finish.                                                                                                                                                                           |
| `.../cook/StepView.tsx`, `IngredientRail.tsx`, `TimersPanel.tsx` | The centred step (a clickable `<li>`, not a button — see deviations), the collapsible ingredient reference, and the cook timers panel (global store filtered + mute).                                                                                                                                                                                                 |
| `.../cook/useWakeLock.ts`                                        | Screen Wake Lock while the cook phase is active, re-acquired on refocus, released on exit; `createClientOnlyFn`-guarded request; feature-detected no-op.                                                                                                                                                                                                              |
| `.../cook/useCookPersistence.ts`                                 | `COOK_STATE_VERSION`, `loadCookState`/`saveCookState`/`clearCookState` — per-recipe `buttery:cookmode:v{N}:{recipeId}`, version-gated, 6h TTL.                                                                                                                                                                                                                        |
| `services/web/src/components/ui/popover.tsx`                     | New base-ui Popover wrapper (rich content) for the header tray, styled to match the dropdown-menu popup.                                                                                                                                                                                                                                                              |
| `services/web/src/routes/acknowledgements.tsx`                   | New ungated `LegalPage` (AIL-4) crediting the CC0 alarm sound; structured for future OSS entries (§11b).                                                                                                                                                                                                                                                              |
| `services/web/src/styles.css`                                    | `timer-shake`, `cook-alarm-flash`, `cook-blob-a/b` keyframes + utility classes, all reduced-motion-guarded (applied via `motion-safe:`).                                                                                                                                                                                                                              |
| Edits                                                            | `DetailPane.tsx` (StepText method list, per-recipe strip, launcher replaces the stub), `Header.tsx` (mount indicator), `__root.tsx` + `AppShell.tsx` (`/acknowledgements` ungated + navless), `Footer.tsx` (link), `ui/button.tsx`/`ui/checkbox.tsx`/`ui/switch.tsx` already carried the `xl`/`2xl` cook tier.                                                        |

## Verification (§14 acceptance criteria)

| #   | Criterion                                                                                       | Evidence                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Duration → global recipe-tagged timer, same StepText in both surfaces                           | Live: tapped "5 minutes" in the detail method list → "Cook" timer (verb-derived). Same `StepText`/`TimeToken` renders in cook `StepView`.                                                                                                          |
| 2   | App-level state; survives leaving cook mode                                                     | Started in detail, seen in cook `TimersPanel`; exited cook mode → still running in the header + strip. No private cook-mode timer state (cook reads `useRecipeTimers`).                                                                            |
| 3   | Count badge, popover groups, continuous shake, ack removes + stops shake                        | Badge showed "1"; popover grouped In-progress/Done; injected expired timer → header shook with red ring; Ack removed it and cleared the shake. Reduced-motion: `motion-safe:` shake + static ring fallback.                                        |
| 4   | Expiry → alarming, sound (mute-aware), banner, Notification where available, silent iOS degrade | Alarming state + banner verified; sound/notification behind `ForegroundAlarmDelivery` with feature-detection; mute toggle in popover + panel.                                                                                                      |
| 5   | Wake lock on cook phase (re-acquire/release); fire-on-return                                    | `useWakeLock(phase==="cook")`; store recomputes on visibility/focus and fires expired-while-hidden timers (unit-tested + design).                                                                                                                  |
| 6   | Modal on mise; no cook code/asset in the route bundle; lazy chunks                              | "Apron on" opens the fullscreen modal on mise. `DetailPane` imports only `CookModeLauncher`; cook subtree behind `React.lazy(() => import("./cook/CookMode"))`; alarm asset referenced by URL, sound module dynamically imported on first `arm()`. |
| 7   | Mise + cook parity                                                                              | Large checklist + prep progress + Start cooking; focus-scroll, keyboard nav, click-to-centre, Back/Next/Finish — all exercised.                                                                                                                    |
| 8   | Version-gated + 6h-TTL persistence; Resume / Start fresh; restore states                        | `buttery:timers:v1` + `buttery:cookmode:v1:{id}`; version-mismatch/TTL discard + restore-as-alarming unit-tested; Resume prompt renders from a saved session.                                                                                      |
| 9   | Ingredients reuse detail factor/metric, write back through context                              | Cook seeds from `RecipesView`, `scaleIngredients` shared; the de-emphasized stepper/switch call `setFactor`/`setMetric`.                                                                                                                           |
| 10  | Go fullscreen where supported, hidden where not; immersive overlay always                       | Feature-detected (incl. `webkit` prefixes); the fixed dark overlay is always present.                                                                                                                                                              |
| 11  | `AlarmDelivery` interface + PWA seam; `endsAt` model; no SW/push                                | Interface + `ForegroundAlarmDelivery` + seam comment; timers store absolute `endsAt`. No service worker added.                                                                                                                                     |
| 12  | Reduced-motion disables animations; focus trap + return; a11y review                            | Dialog traps focus and returned it to "Apron on" (verified `document.activeElement`); all keyframes `motion-safe:`; passed the `accessibility-compliance` review (two issues found + fixed — see below).                                           |
| 13  | Strictly client-only, no hydration mismatch                                                     | `<ClientOnly>` + `React.lazy`; store hydrates from localStorage in an effect after first render (server + first client render both empty). No hydration warnings after the nested-button fix.                                                      |
| 14  | CC0 asset via swappable constant, fetched on first timer; ungated AIL-4 acknowledgements page   | `DEFAULT_ALARM_URL`; `/acknowledgements` added to `UNGATED_ROUTES` + navless + footer, renders the BigSoundBank/CC0 credit.                                                                                                                        |
| 15  | No server fn / table / migration                                                                | None added — pure client over the loaded `HouseholdRecipeDetail` + localStorage.                                                                                                                                                                   |
| 16  | Build log                                                                                       | This file.                                                                                                                                                                                                                                         |

## Deviations & notes

- **Nested-button fix (a11y).** The first `StepView` made the whole centred step a `<button>`, which then
  contained the `<button>` time tokens — invalid nested interactives (confirmed by a React hydration error in
  the live console). Fixed: the step is now a clickable `<li>` (pointer affordance only; keyboard users advance
  with the arrow keys), leaving the `TimeToken`s as the only interactive descendants. The header `aria-live`
  status region was also moved out of the labelled trigger button to avoid double-announcing. Both re-verified.
- **Server-throw guard is build-time, not test-time.** `createClientOnlyFn` is an identity stub in the test/runtime
  package; the throwing behaviour is injected by the TanStack Start Vite plugin for the server bundle. So the §13
  "guarded helpers throw server-side" behaviour holds in the real build but is not asserted in a unit test; the
  store's own SSR-safety (empty server snapshot, effect-based hydration) is what the tests cover.
- **Lazy-boundary acceptance** was verified structurally (dynamic `import()`, `DetailPane` importing only the
  launcher, asset-by-URL) rather than via a production chunk-graph diff — the dev server serves modules
  individually. A prod-build chunk assertion would be a good follow-up if desired.
- **Modal + immersive overlay** are unified onto the DS `Dialog` `fullscreen` size (focus-trap + body-scroll-lock
  - Esc in one), rendered in `.dark`; "Go fullscreen" escalates to the browser Fullscreen API on top. This
    satisfies both "appears in a modal" and "immersive fixed overlay always present".
- **TimeToken target size**: inline-in-text durations rely on WCAG 2.2 2.5.8's inline exception; all standalone
  controls (steppers, nav, popover rows, header button) meet the 24×24 minimum.

## Design revisions (post-review, 2026-08-01)

Feedback from a live design pass against the design-system cook-mode reference. All verified in-browser.

- **Cook phase is now two columns** (`CookPhase`). A left rail (`hidden md:flex`, `clamp(18rem,26vw,22rem)`)
  holds a checkable ingredient list — sharing the mise `prepped` state — plus a "Back to mise en place" link,
  with the per-recipe **Timers** panel pinned to the rail foot. The main column keeps the focus-scroll steps and
  moves Back / Next step to the bottom-right. Narrow screens (`md:hidden`) keep the previous collapsible
  ingredient rail + timers stacked above the nav, so mobile loses nothing.
- **Ingredient amount split**: new pure helper `splitIngredient(line)` in `recipe-scale.ts` (3 unit tests) lifts a
  leading quantity + _measurement_ unit into a right-aligned amount chip ("6 tbsp Butter" → `6 tbsp` / `Butter`),
  while a bare count keeps the following word in the name ("2 Eggs" → `2` / `Eggs`).
- **Header top bar**: gold (`text-secondary`) recipe title + a `Cook mode · serves N · about <time>` subtitle;
  the live "Step X of Y" counter moved into the bar (`md:inline`, mobile keeps the footer counter — the two
  `aria-live` regions never overlap).
- **Instruction text scale** (`useCookTextScale`): a persisted (`buttery:cookscale:v1`) multiplier applied via a
  `--cook-text-scale` CSS var on the cook root, driven by an `A-`/`A+` group left of "Go fullscreen". Step font is
  `max(1rem, calc(var(--cook-text-scale) * clamp(1.7rem,3.4vw,2.7rem)))` — bigger by default, floored at 16px;
  the buttons disable at the 0.7–1.7 bounds.
- **Full-width steps**: dropped the `max-w-3xl` cap; steps now use the full column width with wide side padding
  (`px-6 sm:px-12 lg:px-20`). Inter-step gap tightened to `7vh`.
- **Timer rows show the configured duration** next to remaining (`Cook 5:00` label + `4:56`), from `timer.totalMs`
  (never mutated by +1 min). The alarming primary action is relabelled **Dismiss** (was "Ack").
- **Red → butter accents in cook mode**: recipe title, the `TimerRow` progress bar + link (new `accent` prop,
  cook passes `"secondary"`), and the Next-step button are now gold. The step number **stays red** (deliberate),
  and the alarming state keeps its semantic `destructive` red.
- **Header timer indicator** trigger shrunk `size-9` → `size-7` (28px) to match the `h-7` household switcher.
