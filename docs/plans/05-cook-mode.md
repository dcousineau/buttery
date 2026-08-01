# 05 — Cook mode ("Apron on") + global recipe timers

Status: **spec / pre-development**
Depends on: `03-household-recipe-collection.md` (the `/household/recipes/{id}`
detail pane, `HouseholdRecipeDetail` payload, `recipe-scale.ts`, the
`RecipesView` context that owns `factor`/`metric`); the app shell / top header
(`AppShell`) that hosts the new timer indicator.
Design handoff: Claude Design project `bbec8e32-c3aa-4351-a4fa-5155b24c7604`,
file `CookMode.dc.html` (+ `AppScreen.dc.html` for the launch surface; the
`_ds` bundle is the vendored Buttery design system these prototypes render
against). The prototype's `support.js`/`ds-base.js` are the DC runtime harness —
**not** production code; recreate the design with the real vendored primitives
(`src/components/ui/*`) and semantic tokens, never the prototype's literal hexes.

> **Implementation output (do this without being reminded):** when this project
> is built, write the build log / decisions / deviations to
> `docs/plans/results/05-cook-mode-results.md`, matching the existing
> `02-…-results.md` / `03-…-results.md` files in that directory. This is a
> standing requirement of every plan in `docs/plans/`.

---

## 1. Overview

**Cook mode** is a full-immersion, hands-messy cooking surface launched from the
"Apron on" button on a household recipe's detail pane (`DetailPane.tsx:129`,
today a `pushToast("Cook mode coming soon")` stub — plan 03 §7). It replaces the
dense reading layout with a large-type, one-step-at-a-time driver tuned for a
**propped-up iPad in a kitchen** (iOS Safari is the prime target; desktop Chrome
and Firefox are supported).

Cook mode is one of two surfaces this project builds. The other is a
**global timer system**: tapping anything that looks like a duration — in a cook
step **or** in the recipe detail method list — starts a countdown that lives in
**app-wide state**, not inside cook mode. Timers keep running when you leave cook
mode, surface from a **top-header indicator + popover** anywhere in the app, and
carry the recipe they belong to.

Three goals shape everything below and are **hard requirements**, not polish:

1. **Zero page-load cost for the heavy surface.** Cook mode (audio, wake lock,
   the large step renderer, ambient CSS) must be **lazy-loaded** — it contributes
   **nothing** to the `/household/recipes/{id}` initial bundle or first paint, and
   loads only when "Apron on" is pressed. The **global timer store** is separate:
   small and eager (the header indicator is always mounted); the alarm **audio
   module + asset** load lazily on the **first timer created**, not on page load
   (§4.1), so a user who never starts a timer never fetches them.
2. **Global, recipe-tagged timers.** Timers are app-level state; each carries the
   `recipeId` (+ title) it was started from. They persist across leaving cook
   mode, across route changes, and across reload/tab-close (§9). A header
   indicator shows the count and gives a popover of in-progress and finished-but-
   unacked timers (§6).
3. **Survivable cook session state.** Step position, prepped ingredients, and
   scale settings are cached per-recipe (localStorage, version-gated, 6h TTL) so a
   reload/nav-away/reopen mid-bake doesn't lose the cook's place; reopening offers
   **Resume** (§9). (Timers are persisted separately, in the global store.)

### 1.1 In scope

- **Global timer store** (§6): app-level state, recipe-tagged, persisted; the
  single source of truth for every timer whether started from cook mode or the
  detail view.
- **Top-header timer indicator + popover** (§6.4): a clock/timer button in the
  app header with a **count badge**; click → popover listing **In progress** and
  **Done — needs ack** timers with controls. **Shakes continuously** while any
  timer is in the **alarming-unacked** state, until acked.
- **Time-amount → timer linking in two places** (§10): the same "tap a duration
  to start a timer" affordance in **cook-mode steps** and in the
  **`/household/recipes/{id}` detail pane method list**.
- Lazy-loaded `CookMode` + `CookModeLauncher` (wires "Apron on").
- Launch as a **modal** (DS `Dialog`) with a **"Go fullscreen"** escalation
  (immersive overlay + browser Fullscreen API where supported — §5).
- Two phases from the design — **mise en place** and **cook** (focus-scroll
  steps) — with real DS primitives (§4).
- **Alarm** on expiry: bundled **sound** + in-page banner + **Web Notification**
  (where granted) + **Screen Wake Lock** to keep the iPad awake so foreground
  alarms fire reliably (§7).
- **Ingredient scaling reused** from the detail pane, de-emphasized in-cook
  controls (§8).
- A **pure step-time parser util** (`lib/timers/parse.ts`), unit-tested (§10).
- **PWA forward-compatibility**: timer alarm **delivery** isolated behind an
  interface (§7.4).

### 1.2 Out of scope (explicit)

- **PWA install, service worker, Web Push, server-scheduled notifications.**
  Deferred. iOS Safari in a plain tab **freezes** a backgrounded/locked page — no
  JS, no sound, no alarm until foregrounded. This project accepts that and
  mitigates with Wake Lock + wall-clock anchoring + **fire-on-return** (§7.3); it
  does **not** attempt true background/locked-screen alarms. The delivery
  interface (§7.4) lets the PWA project add that later. **Do not** add a service
  worker or push infra here.
- **Any server function, DB table, or migration.** Cook mode and timers are
  **pure client**. Timers are **local, per-browser** — not server-persisted, not
  cross-device (deferred, §15). No `server/` code, no schema.
- **Editing the recipe** from cook mode. Read-only.
- **A timer history / log** after ack. Acking **removes** a timer from the store
  (§6.3); there is no persisted completed-timer archive this round.
- **Voice control, TTS narration, multi-recipe parallel cook UI.** Later.

---

## 2. Design reference

Recreate `CookMode.dc.html` using the codebase's semantic tokens and vendored
primitives (`src/components/ui/*`), **never** the prototype's literal hexes or
its `_ds` bundle. The prototype's palette is the app's **dark theme** — cook mode
renders inside `.dark` regardless of the app's current theme (an immersive,
lights-down cooking surface). Map the prototype's colors to tokens:

- Surfaces `#1c1106` / `#2a1b0c` → dark `--background` / `--card`; borders
  `rgba(255,244,218,.16)` / `#4d3a22` → `--border`; muted text `#cbb789` →
  `--muted-foreground`; gold `#ffd84d` → butter `--primary`; coral `#ff6242` →
  the alarm/destructive accent. Confirm exact mapping against
  `_ds/…/tokens/colors.css` and the local `styles.css`.
- The **control size tier already exists**: `styles.css:55-56` defines
  `--control-h-xl: 48px` / `--control-h-2xl: 64px` ("cook mode"). The `Button`
  must support `size="xl"`/`size="2xl"`; add them if `button.tsx` stops at `lg`
  (they are why the tokens exist). Same for a large checkbox row.
- Ambient **blurred gradient blobs** (drift keyframes), the **alarm flash**
  keyframe, and the new **header-shake** keyframe are decorative — all behind
  `@media (prefers-reduced-motion: reduce)` guards (the prototype already reduces
  its animations to `.01ms`; the header shake must degrade to a steady/pulsing
  alarm color instead).

The prototype's DC `Component` class is the **canonical behavior spec** for
phases, focus-scroll, keyboard nav, step-time parsing, and the timer state
machine — this document maps that behavior onto production React, promotes the
timer state to **global**, and adds persistence, sound, wake lock, and the header
indicator.

---

## 3. Data — no fetch, reuse the detail payload

Cook mode renders from the **`HouseholdRecipeDetail`** already loaded by the
`/household/recipes/{id}` route (`#/server/household-recipes`); it receives that
object as a prop, does **not** re-fetch, and adds **no** server function. It uses
`recipe.title`, `recipe.serves`, `recipe.totalTimeDisplay`, `recipe.ingredients`
(scaled via `recipe-scale.ts`), and `recipe.instructions` (steps; time tokens
parsed at render, §10).

The global timer store needs a **display title** per timer; the recipe id + title
come from whatever surface started the timer (detail pane or cook mode both have
them). An `unavailable` recipe (plan 03 §3.4) still cooks and still times — the
cached copy is exactly what you want in the kitchen.

---

## 4. Component structure & lazy loading

### 4.1 The two load tiers (requirement 1)

**Eager & light — always mounted:**

- `TimerStore` (§6): the global state + tick + persistence. A module singleton
  exposed via `useSyncExternalStore` (preferred — usable from anywhere without a
  provider wrapper) or a context provider mounted in `__root.tsx` / `AppShell`.
  No heavy deps.
- `HeaderTimerIndicator` (§6.4): the header button + count badge + popover. Small.
- The time-token buttons rendered inside the detail-pane method list (§10) — a few
  lines added to `DetailPane`.

**Lazy — loaded on demand:**

- `CookMode` and its subtree (phases, step renderer, wake lock, ambient CSS) via
  `React.lazy(() => import("./cook/CookMode"))`, gated by `<Suspense>`. Reached
  **only** through `CookModeLauncher`. `DetailPane` imports only the tiny
  launcher, never `CookMode`.
- The **alarm sound**: a **static public asset** at
  `services/web/public/sounds/alarm-default.mp3` (served at
  `/sounds/alarm-default.mp3`), **not** bundled into a JS chunk. It is fetched
  only when the (small, dynamically-imported) alarm module first needs it — on the
  **first timer's** audio-unlock gesture — never at page load. A user who never
  starts a timer never fetches it; a user who starts one from the detail view
  (without opening cook mode) still gets sound. The default file is already in the
  repo (**CC0**, see §7.1); make the source path a single config constant so it is
  swappable.

**Acceptance for the lazy boundary:** the `/household/recipes/{id}` production
chunk contains **no** cook-mode code and **no** alarm asset (verify in the chunk
graph); opening cook mode triggers one lazy chunk; starting a first timer triggers
the alarm-module chunk. The eager timer store adds only a small, bounded cost to
the shared app bundle.

> The codebase currently has **no** `React.lazy`/`Suspense` usage (`grep` empty).
> This is the first; keep it clean and documented as the template.

### 4.1a Client-only rendering — cook mode never server-renders (requirement)

Cook mode is **strictly client-only**. It touches browser-only APIs everywhere
(`localStorage`, `AudioContext`, `navigator.wakeLock`, `requestFullscreen`,
`document`/`window`, `visibilitychange`) and must **never** run during SSR or
hydration. The `React.lazy` boundary already keeps it out of the server render
(its chunk isn't imported until a client click), but make client-only **explicit
and belt-and-suspenders**, using TanStack Start's own primitives (verified
against `@tanstack/react-router` / `@tanstack/react-start`, latest):

- **`<ClientOnly fallback={…}>`** (from `@tanstack/react-router`): wrap the lazy
  `CookMode` render (inside `CookModeLauncher`) so its children mount **only after
  hydration**. Fallback = a small spinner (the same one used for the `<Suspense>`
  fallback). This composes with `React.lazy`: `<ClientOnly><Suspense><CookMode/>…`.
- **`createClientOnlyFn(...)`** (from `@tanstack/react-start`): wrap browser-only
  utilities so a server call throws loudly instead of silently misbehaving — the
  `localStorage` read/write helpers in `lib/timers/**` and `useCookPersistence`,
  the `AudioContext` unlock, the wake-lock request, and `requestFullscreen`.
- **Route `ssr: false` does not apply here** — cook mode is a **modal on**
  `/household/recipes/{id}`, not its own route, so there is no route to flag. (If
  a future iteration promotes cook mode to a dedicated route, e.g.
  `/household/recipes/{id}/cook`, set `ssr: false` on **that** route as the
  primary guard and drop the `<ClientOnly>` wrapper. Note the seam.)

**Hydration-safety for the eager pieces.** The `HeaderTimerIndicator` and the
per-recipe timer strip **are** in the server-rendered tree (the header is on
every page). They must not read `localStorage` during SSR/first render, or React
throws a hydration mismatch. Initialize the timer store **empty** on the server
and first client render, then **hydrate from `localStorage` in an effect** (or
render the indicator's dynamic content inside its own `<ClientOnly>`), so server
HTML and first client HTML agree. All `TimerStore` persistence reads/writes go
through `createClientOnlyFn`-guarded helpers.

### 4.2 Cook-mode tree (inside the lazy chunk)

`CookMode` (shell: phase, audio unlock, wake lock, cook-view persistence,
fullscreen) → `MisePhase` (ingredient checklist + de-emphasized scale controls) →
`CookPhase` (focus-scroll steps + Back/Next/Finish) → `IngredientRail`
(collapsible) → `TimersPanel` (renders the **global** store filtered to this
recipe, plus a global toggle) → `StepView` (parsed step; time tokens spawn global
timers). Hooks: `useWakeLock`, `useAlarm`. It reads/writes the **shared**
`TimerStore` — cook mode has **no** private timer state.

### 4.3 Behavior parity checklist (from the prototype)

- **Focus-scroll steps**: centered step sharp; neighbors dim + blur by distance
  (`[1,.44,.26,.16]` opacity, `[0,1,2.4,3.8]`px blur). 38vh spacers top/bottom;
  click centers a step; on-scroll observer picks nearest-to-center (with the
  ~700ms scroll-lock guarding programmatic scroll).
- **Keyboard nav**: `↓`/`→`/`Space` next, `↑`/`←` prev, `Esc` back to mise (second
  `Esc`/close → exit). Trap focus while open.
- **Progress** "Step X of Y"; **Next**→**Finish** on the last step. **Prep**
  "N of M prepped"; checked rows dim (no strikethrough), gold border
  (`cm-soft-check`).
- **Rubberband overscroll**: polish, flag don't block (drop if it fights iOS
  momentum scrolling).

---

## 5. Launch, modal, and fullscreen

Per the answered decision — **immersive overlay always + Fullscreen API where
supported**:

1. **Apron on** (kept as the `lg` primary sticker button with `CookingPot`) opens
   cook mode as a **modal** (DS `Dialog`), app dimmed behind — the "appears in a
   modal" requirement. Opens on **mise en place**.
2. The header carries **"Go fullscreen"**. Content is always a
   `position: fixed; inset: 0` immersive layer; "go fullscreen" additionally calls
   `element.requestFullscreen()` on the overlay root to hide **browser** chrome:
   - Desktop Chrome/Firefox: true browser fullscreen.
   - iPadOS Safari: element Fullscreen API is **flaky/limited** — feature-detect
     (`document.fullscreenEnabled` + method, incl. `webkit` prefixes); if
     unsupported, **hide the button** (the fixed overlay is already immersive).
   - Track `fullscreenchange`, offer "Exit fullscreen", restore on exit/unmount.
3. **Exit paths**: "Exit cook mode", `Esc` from mise, or dialog close — exit
   fullscreen first if active, then close. Exit **releases the wake lock** and
   **suspends** audio, but **does not stop timers** (they are global — they keep
   running and appear in the header, §6) and **persists** cook-view state (§9).
4. **Body scroll lock + focus trap** while open (Dialog provides both).

---

## 6. Global timer store (`TimerStore`, `useTimers`)

The heart of the change: timers are **application state**, not cook-mode state.
One store, read/written by cook mode, the detail-view time tokens, the header
indicator, and the popover.

### 6.1 Model

```ts
type TimerStatus = "running" | "paused" | "alarming"; // alarming = expired, awaiting ack

interface Timer {
  id: string;
  recipeId: string;
  recipeTitle: string; // for the popover / off-recipe display
  label: string; // verb-derived, e.g. "Bake"
  totalMs: number;
  endsAt?: number; // epoch ms, present while running
  pausedRemainingMs?: number; // present while paused
  status: TimerStatus;
  firedAt?: number; // set when it entered "alarming"
}
```

- **Running** timers store absolute `endsAt`; `remaining = endsAt - now()`.
  **Never** decrement a stored counter.
- **Paused** store `pausedRemainingMs`; resume → `endsAt = now() +
pausedRemainingMs`, status `running`.
- A single global `setInterval` (250–1000ms) drives **re-render only** (recompute
  from `endsAt`), plus recompute on `visibilitychange`/`focus` so a returning page
  snaps to correct remaining and **fires anything that expired while hidden**
  (§7.3).
- On `remaining ≤ 0`: status → **`alarming`**, set `firedAt`, trigger the alarm
  side effects **once** (§7).
- **Cap:** a modest global cap (default **8**) to bound the popover; newest
  prepended, oldest **running** dropped past the cap (never silently drop an
  `alarming` one). Reconsider if real use wants more.

### 6.2 Actions

- `addTimer({ recipeId, recipeTitle, label, seconds })` → creates a `running`
  timer; unlocks/loads audio on the (gesture-driven) call (§4.1, §7.1). Returns
  the id.
- `pause(id)` / `resume(id)` — toggle running/paused.
- `ack(id)` — **only meaningful for `alarming`**: stops that alarm and **removes
  the timer from the store** (§6.3). This is the primary finish action.
- `dismiss(id)` — cancel a still-running/paused timer (removes it).
- `addMinute(id)` / `reset(id)` — optional conveniences (extend by 60s / re-arm to
  `totalMs`); nice-to-have, not required.

### 6.3 Alarm-unacked lifecycle (explicit requirement)

- Expiry moves a timer to **`alarming`** (not removed). It stays in the store,
  shown in the popover's **"Done — needs ack"** group and on the recipe, sounding
  - flashing, until the user **acks** it.
- **`ack` removes it from the global list.** No archive/history remains (§1.2).
- While **≥1** timer is `alarming`, the header indicator **shakes continuously**
  (§6.4) and its alarm affordance persists until **all** are acked.

### 6.4 Header timer indicator + popover (new UI)

Mount a timer button in the **app top header** (`AppShell` header, visible on
every signed-in screen — confirm the header component and slot). Behavior:

- **Icon**: a clock/timer (`lucide-react` — e.g. `Timer`/`AlarmClock`; pick one
  consistent with the icon set the app already uses).
- **Count badge (dot accessory)**: shows the number of **in-progress** timers
  (`running` + `paused`). Hidden when zero. When any timer is `alarming`, the
  badge/icon adopt the **alarm accent** in addition to the shake.
- **Shake**: while ≥1 `alarming` timer, the button shakes on a continuous loop
  (a small keyframe, §2) until all acked. **Reduced-motion**: no shake — use a
  steady/pulsing alarm-color ring instead. Never rely on motion alone (a11y).
- **Popover** (DS popover/`dropdown-menu` or a small custom popover) on click,
  two groups:
  - **Done — needs ack** (`alarming`, listed first): label · recipe title ·
    "Time!" + **Ack** (primary, removes) [+ optional Add a minute / Reset].
  - **In progress** (`running`/`paused`): label · recipe title · live remaining +
    progress bar · **Pause/Resume** · **Dismiss**.
  - Empty state when no timers.
  - Each row's recipe title is a link to `/household/recipes/{recipeId}`.
- The indicator reads the global store; opening/closing it never affects timers.

### 6.5 On-recipe display

On `/household/recipes/{id}`, show the timers **for that recipe** (filter the
store by `recipeId`) as a compact strip/section in the detail pane (and in cook
mode's `TimersPanel`), so a cook looking at the recipe sees its running/alarming
timers without opening the header popover. Same controls (pause/resume/ack/
dismiss). This satisfies "see the timer running… on the recipe itself."

---

## 7. Alarm: sound, notification, wake lock (`useAlarm`, `useWakeLock`)

### 7.1 Sound

- No web API plays the **literal OS alarm sound**; ship an asset. The default is
  **already in the repo** at `services/web/public/sounds/alarm-default.mp3`
  (served `/sounds/alarm-default.mp3`) — a short digital alarm tone, **loaded
  lazily** on first timer (§4.1), **looped** until that timer is acked/paused.
  Reference it by a single swappable config constant (e.g.
  `DEFAULT_ALARM_URL = "/sounds/alarm-default.mp3"`). (A WebAudio-synth beep is an
  acceptable fallback; default to the asset.)
  - **License:** the default asset is **CC0 / public domain** — free for
    **commercial and personal** use, worldwide, **no attribution required**,
    redistribution permitted. Source: BigSoundBank "Electronic alarm (buzzer) #2"
    (see `public/sounds/README.md`). There is therefore **no legal attribution
    obligation**; the §11b acknowledgements page credits it **voluntarily** and
    seeds the future OSS-acknowledgements surface.
- **Audio unlock (iOS):** unlock an `AudioContext` (or play the muted element
  once) inside the **timer-start gesture** — which now can be a detail-view time
  tap **or** a cook-mode tap **or** the "Apron on"/"Start cooking" click. Persist
  the unlocked context so a later-firing timer sounds without a fresh gesture.
- **Mute toggle** (in the popover / timers panel): still show the visual alarm
  when muted. `navigator.vibrate()` on expiry where supported (Android; **no-op
  iOS**) as an additive cue only.

### 7.2 Notification

- On the **first timer start** (a gesture), request `Notification` permission if
  `default`. On expiry, if `granted` **and** `document.hidden`, post a
  `Notification` ("Bake · done — Brown-butter cornbread") that focuses the app on
  click.
- **iOS Safari tab:** `Notification` is **unavailable** outside an installed PWA —
  feature-detect and **degrade silently** (banner + fire-on-return sound cover
  it). Never assume it exists.

### 7.3 Wake lock + the background reality (chosen strategy)

- Acquire `navigator.wakeLock.request("screen")` on **entering the cook phase**
  (and re-acquire on `visibilitychange`→visible; the lock drops when hidden).
  Release on exit/unmount. Feature-detect; no-op where absent. This keeps the
  propped iPad awake and foreground — the condition under which alarms fire
  reliably. (Wake lock is cook-mode-scoped; timers started from the detail view
  without cook mode rely on the page staying foreground, same limit.)
- **If backgrounded/locked anyway** (iOS freezes the page): `endsAt` is absolute,
  so on **return to foreground** the visibility/focus recompute (§6.1) detects the
  expired timer and fires the alarm **then** (status already/becomes `alarming`,
  sound + banner + header shake). Make **fire-on-return** explicit and tested.

### 7.4 PWA forward-compatibility (answered requirement)

Isolate the **delivery** mechanism so a later PWA project extends/overrides it
without touching the store or UI:

- Define **`AlarmDelivery`** (`scheduleAlarm(timer)`, `cancelAlarm(id)`,
  `onFire(cb)`); inject **`ForegroundAlarmDelivery`** here (audio +
  Notification-if-granted + wake-lock-backed foreground firing). A future PWA adds
  **`ServiceWorkerPushDelivery`** (SW + Web Push, server schedules a push at
  `endsAt`) and swaps it in — same interface, same timer model (already stores
  absolute `endsAt`, exactly what a scheduled push needs). Mark the interface with
  a PWA-seam comment (mirror plan 03's stub comments).

---

## 8. Ingredients & scaling (reuse + de-emphasized in-cook controls)

Per the answered decision — **reuse the detail pane's scaling, editable in cook
mode but de-emphasized**:

- Cook mode seeds `factor`/`metric` from the **`RecipesView` context** and renders
  ingredients via `scaleIngredients(recipe.ingredients, factor, metric)` (the same
  util/values as the detail pane). No second fetch, no divergence on open.
- Cook mode exposes **small, quiet** scale/unit controls (compact stepper + metric
  switch, low-emphasis, in the mise header — **not** the prominent `ScalePanel`),
  defaulting to the seeded values; editing **writes back through the shared
  context** (`setFactor`/`setMetric`) so cook mode and the detail pane stay a
  single source of truth. Persisted in the cook-view state (§9); these remain
  ephemeral session reading prefs (plan 03 §4), not server-side.

---

## 9. Persistence (two stores)

### 9.1 Global timers — `buttery:timers:v{N}` (localStorage)

- The whole `Timer[]` (§6.1), one key, **not** per recipe (timers span recipes).
  localStorage so timers survive reload **and** tab close.
- Stored as wall-clock (`endsAt`/`pausedRemainingMs`): on load, recompute
  remaining; a timer that expired while away restores as **`alarming`** (fires on
  the next visibility/tick per §7.3).
- **Versioning:** a manual **`TIMER_STATE_VERSION`** constant with the comment:
  > `// Bump TIMER_STATE_VERSION on any breaking change to the persisted timer
shape. Mismatched payloads are discarded, not migrated.`
  > Load mismatch → discard.
- **TTL:** drop timers whose `endsAt`/`firedAt` is older than a cutoff on load so
  a days-old tab doesn't resurrect zombie alarms. Use the same **6h** cutoff as
  cook-view state unless a longer bound is wanted for long bakes (flag; 6h is the
  default).
- Save (debounced) on every store mutation + flush on `visibilitychange`→hidden.

### 9.2 Cook-view state — `buttery:cookmode:v{N}:{recipeId}` (localStorage)

Per the answered decision — **localStorage, per-recipe, version-gated, 6h TTL,
Resume** — **minus timers** (now global, §9.1):

- Shape: `{ version, updatedAt, phase, focus, prepped: number[], factor, metric }`.
- **Versioning:** manual **`COOK_STATE_VERSION`** constant with the same bump-me
  comment; mismatch → discard.
- **TTL:** 6h from `updatedAt`.
- **Resume UX:** opening cook mode with a valid (in-version, non-stale) entry →
  **"Resume where you left off?"** (Resume restores phase/focus/prepped/scale;
  Start fresh clears and begins at mise). Cold/no-entry → mise.
- **Clear:** on Start fresh, on Finish (offer), and on version/TTL rejection.
- Save debounced on change + flush on hide/exit.

---

## 10. Step-time linking + parser (`src/lib/timers/parse.ts`, pure + unit-tested)

The "duration → timer" affordance appears in **both** cook-mode steps and the
**detail-pane method list**, so the parser is a shared pure util (mirror
`recipe-scale.ts` + `.test.ts`).

- **`parseStep(text) → tokens[]`**: split a step into `{ isText, text }` and
  `{ isTime, text, seconds, label }`. Time regex matches `N`, `N.N`, and ranges
  `N to M` / `N–M` / `N-M` with units
  `sec(s)/second(s)/min(s)/minute(s)/hr(s)/hour(s)`; a **range uses the upper
  bound** (`m[2] || m[1]`); unit→seconds (`h→3600`, `m→60`, `s→1`).
- **`labelFor(prefixText) → string`**: verb-stemmer over the ~14 words before the
  time (then the whole prefix), stemming (`-ing/-ed/-es/-s/-d`, `-e` restore),
  matched against the verb table (`bake, roast, simmer, boil, rest, cool, chill,
heat, preheat, brown, whisk, melt, sauté, sear, steam, toast, fry, reduce,
marinate, knead, proof, soak, stir, cook, swirl, warm, broil, poach, braise,
set`), prefix-match fallback, then a noun table (`oven, skillet, pan, batter,
dough, butter`), else "Timer". Keep tables as data.
- **Rendering:** a shared `StepText`/`TimeToken` component renders the tokens;
  time tokens are `<button>`s that call `addTimer({ recipeId, recipeTitle, label,
seconds })` (stop propagation so tapping a time in cook mode doesn't also center
  the step). Used by both `StepView` (cook) and the detail-pane method list.
  - In the detail pane, style time tokens subtly (an underline/affordance) so
    they read as tappable without shouting; in cook mode they get the prototype's
    gold underlined treatment.
- **Tests:** each time form (single, decimal, each range dash, each unit), the
  upper-bound rule, verb stemming hits/misses, noun fallback, no-time pass-through,
  multiple times per step.
- **Known gaps (document, don't fix):** temperature-adjacent false positives,
  number words ("half an hour"), non-English. Best-effort.

---

## 11. Accessibility

- Focus trap + `Esc` via the `Dialog` overlay; return focus to "Apron on" on
  close. Header popover is keyboard-operable and returns focus to its trigger.
- Step arrow/space nav supplements tab order, doesn't replace it.
- Timers: announce **start** and **expiry** politely (`role="status"`,
  `aria-live="polite"`), not every tick; the header shake **must** have a
  non-motion equivalent (alarm color/ring) and an accessible name reflecting state
  (e.g. "Timers — 1 done, needs attention").
- `prefers-reduced-motion`: ambient blobs, alarm flash, smooth-scroll, and the
  **header shake** all reduce/disable.
- Large touch targets (the `xl`/`2xl` tier). Run the `accessibility-compliance`
  skill before sign-off.

---

## 11b. Acknowledgements page (`/acknowledgements`, AIL-4)

A new **ungated, content-only legal page** — the future home for open-source /
asset acknowledgements, seeded by this project with the alarm-sound credit.

- **Route:** `services/web/src/routes/acknowledgements.tsx`, mirroring the
  existing legal pages (`ai-usage.tsx`, `terms.tsx`, `privacy.tsx`): a
  `createFileRoute("/acknowledgements")` rendering the shared **`LegalPage`**
  component (`src/components/LegalPage.tsx`) with **`ail={4}`** — the page content
  is LLM-drafted and human-reviewed (AIL-4, per the app's AI Influence Level
  convention, same rubric the `LegalPage` `ail` prop already renders). Title /
  eyebrow like the other legal pages ("Acknowledgements").
- **Ungated:** add `"/acknowledgements"` to the **`UNGATED_ROUTES`** set in
  `src/routes/__root.tsx` (alongside `/terms`, `/privacy`, `/ai-usage`) so it
  stays reachable during the soft-launch gate. Content-only, no auth, no data
  loader.
- **Seed content:** a short intro framing it as where Buttery credits third-party
  content and open-source it builds on, then a first entry:
  - **Alarm sound** — "Electronic alarm (buzzer) #2" from **BigSoundBank**
    (link to the source page), **CC0 / public domain**. Credit the source by
    name; state plainly that CC0 requires **no** attribution and that this credit
    is offered voluntarily. A normal list entry — no special emphasis.
- **Forward:** structure it so future entries (OSS libraries, other assets) append
  cleanly — a simple list/section the next project can extend. Not exhaustively
  populated now.
- Optionally link it from the footer next to the other legal pages (nice-to-have,
  match wherever `/terms` etc. are linked).

> The alarm asset is CC0, so this page is **not** legally required — it exists
> because the user wants an acknowledgements surface seeded now for future
> open-source usage. Marked **AIL-4**.

---

## 12. File plan

**Code-structure convention (required):** everything _logic_-related to timers
lives in a **namespaced folder under `services/web/src/lib/`** —
`lib/timers/**` — including the store, context/hook, alarm delivery, the pure
parser, and persistence. Every timer _component_ lives in a **namespaced folder
under `services/web/src/components/`** — `components/timers/**`. Do not scatter
timer code across `recipes/` or the app shell; import from these two namespaces.
(Cook-mode-specific UI stays under `components/recipes/cook/**` and consumes the
`lib/timers` store; it is not itself "timer code.")

**Eager (shared bundle):**

- `services/web/src/lib/timers/store.ts` — the global `TimerStore` (state, tick,
  actions §6.2, persistence §9.1). Exports `TIMER_STATE_VERSION`, `useTimers`.
- `services/web/src/lib/timers/alarm-delivery.ts` — `AlarmDelivery` interface +
  `ForegroundAlarmDelivery` wiring + PWA-seam comment (§7.4).
- `services/web/src/lib/timers/parse.ts` + `parse.test.ts` — the pure step-time
  parser (`parseStep`/`labelFor`, §10). (Was `lib/cook-timers.ts`; lives under the
  timers namespace.)
- `services/web/src/components/timers/HeaderTimerIndicator.tsx` — header button +
  count badge + shake + popover (§6.4). Mounted in `AppShell`/header.
- `services/web/src/components/timers/TimerRow.tsx` — one timer row (shared by
  popover, detail strip, cook `TimersPanel`).
- `services/web/src/components/timers/TimeToken.tsx` — the tappable duration
  button (§10). Composed by a `StepText` renderer (used by the detail method list
  and cook `StepView`); `StepText` may sit in `components/recipes/` but the
  `TimeToken` timer control stays in the timers namespace.
- `services/web/src/components/recipes/CookModeLauncher.tsx` — "Apron on" +
  `React.lazy`/`<Suspense>` boundary; replaces the stub at `DetailPane.tsx:129`.

**Detail-pane edits:** `DetailPane.tsx` — render method steps through `StepText`
(time tokens live); add the per-recipe timer strip (§6.5).

**Acknowledgements page (§11b):**

- `services/web/src/routes/acknowledgements.tsx` — new ungated `LegalPage`
  (`ail={4}`), crediting the CC0 alarm sound; future OSS home.
- `services/web/src/routes/__root.tsx` — add `"/acknowledgements"` to
  `UNGATED_ROUTES`; optionally link it wherever `/terms` etc. are linked.

**Lazy (cook chunk):**

- `services/web/src/components/recipes/cook/CookMode.tsx` (+ `MisePhase`,
  `CookPhase`, `IngredientRail`, `TimersPanel`, `StepView`).
- `.../cook/useWakeLock.ts`, `.../cook/useCookPersistence.ts` (exports
  `COOK_STATE_VERSION`, §9.2).
- `services/web/src/lib/timers/alarm-sound.ts` — the sound module (creates/loops
  the `<audio>`/`AudioContext`), dynamically imported on first timer (§4.1/§7.1).
  References the asset by URL via a `DEFAULT_ALARM_URL` constant; does **not**
  import/bundle the audio. Timer logic stays in the `lib/timers` namespace even
  though this chunk is lazy.
- `services/web/public/sounds/alarm-default.mp3` — **already added** to the repo:
  the default alarm (CC0, served `/sounds/alarm-default.mp3`).
- `services/web/public/sounds/README.md` — **already added**: provenance +
  CC0 license note + swap instructions.

**Primitives:** `ui/button.tsx` — add `size="xl"`/`"2xl"` if absent; a large
checkbox-row composition for mise (compose `ui/checkbox.tsx`; DS has no prebuilt
`CheckboxRow`). `styles.css` — cook ambient/alarm keyframes + the header-shake
keyframe, all reduced-motion-guarded.

**Output:** `docs/plans/results/05-cook-mode-results.md` — **build log (required).**

No `services/web/src/server/**` changes. No migration.

---

## 13. Testing

- **Unit** (`lib/timers/parse.test.ts`): the full §10 matrix.
- **Client-only / SSR**: the `/household/recipes/{id}` server render contains no
  cook-mode markup (cook mode is behind `<ClientOnly>` + `React.lazy`); the
  `HeaderTimerIndicator` server render matches first client render (no hydration
  mismatch) and shows zero timers until the post-hydration `localStorage` load;
  `createClientOnlyFn`-guarded helpers throw if invoked server-side.
- **Timer store**: wall-clock remaining from `endsAt`; pause/resume; expiry →
  `alarming`; **ack removes**; dismiss removes; cap at 8 never drops an
  `alarming`; **fire-on-return** (expired while `document.hidden` → fires once on
  visibility/focus recompute). Fake timers + simulated `visibilitychange`.
- **Persistence**: timers store round-trips; **`TIMER_STATE_VERSION` mismatch →
  discarded**; TTL drops stale; a timer expired-on-restore comes back `alarming`.
  Cook-view store: round-trips (no timers in it); version/TTL discard; Resume vs
  Start-fresh.
- **Header indicator**: badge counts in-progress; shakes iff ≥1 `alarming`; shake
  replaced by color under reduced-motion; ack from the popover clears the shake
  when the last alarming timer goes; rows link to the recipe.
- **Cross-surface**: start a timer from the **detail view** → appears in the
  header + the per-recipe strip **without** opening cook mode; start one in cook
  mode, **exit** cook mode → still running in the header; return → still there.
- **Lazy boundary**: chunk-graph assertion that `/household/recipes/{id}` excludes
  cook-mode code and the alarm asset; opening cook mode = one lazy chunk; first
  timer = alarm-module chunk.
- **Launch/fullscreen**: Apron on opens the modal on mise; "Go fullscreen" calls
  `requestFullscreen` where supported, hidden where not; exit releases wake lock,
  restores focus, leaves timers running.
- **Manual / device**: iPad Safari — audio unlocks on a time tap, wake lock holds
  the screen in cook mode, an alarm sounds in foreground, a timer expired while
  backgrounded fires on return, the header shakes until acked. Desktop Chrome +
  Firefox — notifications, fullscreen, keyboard nav.

---

## 14. Acceptance criteria

1. Tapping a **duration** in a cook step **or** in the `/household/recipes/{id}`
   detail method list starts a **global**, recipe-tagged timer (verb-derived
   label, wall-clock `endsAt`); the same `StepText`/`TimeToken` renders in both.
2. Timers live in **app-level state**: starting one in cook mode and **exiting**
   cook mode leaves it running; it shows in the **top-header indicator** and in
   the **per-recipe strip** on the detail view. No timer state is private to cook
   mode.
3. The header indicator shows a **count badge** of in-progress timers, a popover
   grouping **In progress** and **Done — needs ack**, and **shakes continuously**
   while any timer is **alarming-unacked** (with a non-motion equivalent under
   reduced-motion); **ack removes** the timer from the store and, when it's the
   last alarming one, stops the shake.
4. On expiry a timer enters **`alarming`**, plays the bundled alarm sound (audio
   unlocked on the timer-start gesture, honoring mute), shows the in-page/banner
   alarm state, and posts a Web Notification **where the API exists and permission
   is granted**; degrades silently on iOS Safari tabs.
5. Entering the cook phase acquires a **Screen Wake Lock** (re-acquired on
   refocus, released on exit) where supported; a timer that expired while
   backgrounded **fires on return to foreground**.
6. "Apron on" opens cook mode as a **modal** on mise; the
   `/household/recipes/{id}` initial bundle contains **no** cook-mode code and
   **no** alarm asset (single lazy chunk on open; alarm chunk on first timer); the
   eager timer store/header add only a small bounded cost.
7. Mise + cook phases render at behavior-parity with the prototype (large scaled
   checklist, prep-progress, "Start cooking"; focus-scroll steps, keyboard nav,
   click-to-center, Back/Next/Finish).
8. Global timers persist to **`buttery:timers:v{N}`** and cook-view state to
   **`buttery:cookmode:v{N}:{recipeId}`** — both **version-gated** by manual
   constants (mismatch → discarded) with a **6h TTL**; reopening cook mode offers
   **Resume / Start fresh**; restored running timers show correct remaining and
   restored-expired ones show as `alarming`.
9. Ingredients reuse the detail pane's `factor`/`metric` (seeded from
   `RecipesView`, no re-fetch); de-emphasized in-cook scale controls edit them and
   write back through the shared context.
10. "Go fullscreen" escalates to the browser Fullscreen API where supported and is
    hidden where not (immersive fixed overlay always present).
11. Alarm delivery is behind an **`AlarmDelivery` interface** with a documented
    **PWA extension seam**; the timer model stores `endsAt` so a future
    service-worker/Web-Push delivery adopts it without a rewrite. **No** service
    worker / push infra is added here.
12. `prefers-reduced-motion` disables ambient/alarm/scroll/shake animations; focus
    is trapped in cook mode and returns to "Apron on" on close; passes the
    `accessibility-compliance` review.
13. Cook mode is **strictly client-only**: it never server-renders (guarded by
    `<ClientOnly>` + `React.lazy`), browser-only utilities are wrapped in
    `createClientOnlyFn`, and the eager `HeaderTimerIndicator` hydrates
    `localStorage` **after** first render with **no hydration mismatch**.
14. The default alarm asset (`public/sounds/alarm-default.mp3`, **CC0**) is
    referenced by a swappable config constant and fetched only on first timer; a
    new **ungated** `/acknowledgements` page (`LegalPage`, **AIL-4**, added to
    `UNGATED_ROUTES`) credits it and stands ready for future OSS acknowledgements.
15. **No** server function, DB table, or migration is added — cook mode and timers
    are pure client over the loaded `HouseholdRecipeDetail` + localStorage.
16. The build log lands at **`docs/plans/results/05-cook-mode-results.md`**.

---

## 15. Deferred / next

- **PWA project**: installable, service worker, Web Push subscription, and
  **server-scheduled notifications** so timers fire while the iPad is
  locked/backgrounded — adopting the §7.4 `AlarmDelivery` interface and the
  `endsAt` timer model unchanged.
- **Server-side / cross-device timers** (start on the iPad, glance on a phone) and
  a persisted **completed-timer history** (this round has no post-ack archive).
- Voice / hands-free step advance; per-step TTS narration.
- Smarter time parsing (number words, temp-vs-duration disambiguation, structured
  durations once recipes carry structured quantities).
- Multiple/parallel recipes in one cook session.
