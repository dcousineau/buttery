/**
 * The wire DTOs — every payload that crosses the client↔server boundary.
 *
 * These used to be declared beside the `createServerFn` that returned them, which
 * made "what does the client actually receive" a question you answered by reading
 * `src/server/**`. Offline mode needs the opposite arrangement: the client caches
 * these shapes in IndexedDB, versions them (`CACHE_SCHEMA_VERSION`), and must be
 * able to talk about them without importing a server module at all. So the types
 * live here and **the server imports them from here** (offline plan §4.3, §7).
 *
 * Nothing in this file imports anything server-side, by construction: it is types
 * only, plus the two client-safe unions (`Aisle`, `PlanDate`, …) the payloads are
 * built from. When the API service in §7 is extracted, this file is what gets
 * promoted to `@buttery/api-types` — unchanged.
 *
 * Rule of thumb for what belongs here: if a value of the type is ever serialized
 * over `/_serverFn/*`, it is a wire DTO. Inputs that only ever exist server-side
 * (query row shapes, validator internals) stay where they are.
 */

import type { Aisle } from "#/lib/grocery/aisles";
import type { UnitDim } from "#/lib/grocery/units";
import type { MealSlot, PlanDate } from "#/lib/plan/week";

// --- provenance ---------------------------------------------------------

/** The three provenance glyphs the design maps: web / handwritten-note / atproto handle. */
export type SourceKind = "web" | "note" | "handle";

/** A recipe's display provenance: an icon-keyed kind, a label, and an optional link. */
export interface RecipeSource {
  kind: SourceKind;
  label: string;
  url: string | null;
}

// --- the household recipe box -------------------------------------------

/** One ledger row (left pane). Filter/sort/search happen client-side over these. */
export interface HouseholdRecipeRow {
  recipeId: string;
  title: string;
  favorite: boolean;
  sourceKind: RecipeSource["kind"];
  sourceLabel: string;
  sourceUrl: string | null;
  /** Total time in whole minutes, or null (sorts last under "Quickest"). */
  totalMinutes: number | null;
  /** Pre-formatted display string for `totalMinutes` ("1h 30m"), or null. */
  totalTimeDisplay: string | null;
  keywords: string[];
  thumbUrl: string | null;
  /** ISO timestamp the recipe was added to the box (`household_recipe.added_at`). */
  addedAt: string;
  /** "@handle" of whoever added it, already prefixed; null when unresolvable. */
  addedByHandle: string | null;
  /** Source went unavailable on the network; still renders from cache. */
  unavailable: boolean;
  /** A local draft/private recipe with no atproto record yet (shows a lock). */
  unpublished: boolean;
}

/** Per-serving nutrition; individual cells are null when the value is absent. */
export interface RecipeNutrition {
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
}

/** The shared private note on a boxed recipe. */
export interface HouseholdRecipeNoteView {
  body: string;
  updatedAt: string;
}

/** Full detail for a boxed recipe (right pane). */
export interface HouseholdRecipeDetail {
  recipeId: string;
  title: string;
  description: string | null;
  source: RecipeSource;
  images: Array<{ url: string; alt: string | null }>;
  ingredients: string[];
  instructions: string[];
  keywords: string[];
  recipeYield: string | null;
  /** Parsed leading integer of `recipeYield`, or null. */
  serves: number | null;
  totalMinutes: number | null;
  totalTimeDisplay: string | null;
  cuisine: string | null;
  category: string | null;
  nutrition: RecipeNutrition;
  favorite: boolean;
  note: HouseholdRecipeNoteView | null;
  /** Best-effort handle of whoever added it to the box ("saved by @handle"). */
  addedByHandle: string | null;
  unavailable: boolean;
  /** ISO timestamp the source went unavailable, when known. */
  unavailableSince: string | null;
  /** A local draft/private recipe with no atproto record yet (publishable). */
  unpublished: boolean;
  /**
   * Whether (and when next) this recipe is on the household's meal plan, so the
   * remove-from-box flow can warn without a second round trip (plan §7.2 / D8).
   * Nullable so a caller must guard: the field is absent-shaped for any payload
   * built before the planner shipped.
   */
  plannedUsage: PlannedUsage | null;
}

/** One picker result (global public search, excludes already-boxed). */
export interface GlobalRecipeResult {
  recipeId: string;
  title: string;
  description: string | null;
  source: RecipeSource;
  thumbUrl: string | null;
  /** "@handle" of the publishing repo, already prefixed; null when unresolvable. */
  handle: string | null;
}

// --- the meal plan ------------------------------------------------------

export interface PlanRecipeEntry {
  id: string;
  kind: "recipe";
  position: number;
  recipeId: string;
  title: string;
  /** Popover hero (4:3). Null ⇒ the design's utensils placeholder. */
  imageUrl: string | null;
  totalMinutes: number | null;
  totalTimeDisplay: string | null;
  source: RecipeSource;
  /** Still in the household box? False ⇒ "not in box" flag + "Add back to your box". */
  inBox: boolean;
  /** Source went unavailable on the network; still renders from the local cache. */
  unavailable: boolean;
  /** A local draft with no atproto record yet ("private draft" flag). */
  unpublished: boolean;
  cookedAt: string | null;
  /** "@sam", already prefixed; null when unresolvable. */
  cookedByHandle: string | null;
  addedByHandle: string | null;
}

export interface PlanNoteEntry {
  id: string;
  kind: "note";
  position: number;
  body: string;
  /** Notes are never "cooked" — kept so callers can read `.cookedAt` uniformly. */
  cookedAt: null;
  addedByHandle: string | null;
}

export type PlanEntry = PlanRecipeEntry | PlanNoteEntry;

export interface PlanDay {
  date: PlanDate;
  isToday: boolean;
  /** The design dims past days. Dimming is not disabling — they stay editable (D6). */
  isPast: boolean;
  /** Always all 4 keys, possibly empty arrays. */
  slots: Record<MealSlot, PlanEntry[]>;
}

export interface PlanWeek {
  weekStart: PlanDate;
  weekEnd: PlanDate;
  timezone: string;
  weekStartDay: number;
  today: PlanDate;
  /** Exactly 7. */
  days: PlanDay[];
  /** Panel stats + the shopping button's "Add all N to shopping list" label. */
  recipeEntryCount: number;
  /** Slots (of 28) with no live entry — the panel's "N of 28 slots still empty". */
  emptySlotCount: number;
  cookedCount: number;
}

/** Powers the remove-from-box warning (§7.2). */
export interface PlannedUsage {
  total: number;
  upcoming: number;
  nextDate: PlanDate | null;
}

/** What a write returns about a row it created. */
export interface CreatedPlanEntry {
  id: string;
  kind: "recipe" | "note";
  position: number;
  recipeId: string | null;
}

/** What a copy did, in the server's own (re-snapped) terms. */
export interface CopiedWeek {
  copied: number;
  fromWeek: PlanDate;
  toWeek: PlanDate;
  /** The destination week's last date — the toast's "… to Aug 10 – Aug 16". */
  toWeekEnd: PlanDate;
}

// --- the grocery list ---------------------------------------------------

/** A row as the list renders it. */
export interface GroceryItemRow {
  id: string;
  foodSlug: string | null;
  displayName: string;
  aisle: Aisle;
  /** Rendered total: `1 lb 8 oz`, `2½ cups`, `3 cloves`. `null` when unknown. */
  quantityDisplay: string | null;
  /** Raw base-unit total, so the client can re-render after an inline edit. */
  quantity: number | null;
  unit: string | null;
  unitDim: string | null;
  isManual: boolean;
  checkedAt: string | null;
  checkedByHandle: string | null;
  /** The recipes that put this on the list, resolved to titles. */
  sources: GroceryItemSourceRow[];
}

export interface GroceryItemSourceRow {
  recipeId: string | null;
  title: string | null;
  /** The ingredient line, verbatim, as it read when it was added. */
  rawText: string;
  scale: number;
}

export interface GroceryListPayload {
  items: GroceryItemRow[];
  /** Server time at read, so the client can apply the TTL without clock skew. */
  readAt: string;
  /** How long a checked row stays visible, in seconds (plan D10). */
  checkedTtlSeconds: number;
}

/** A candidate row in the confirm-preview dialog (plan D9). Nothing written. */
export interface GroceryPreviewRow {
  /** Stable within one preview; the client sends back the ones it wants. */
  key: string;
  foodSlug: string | null;
  nameNorm: string;
  displayName: string;
  aisle: Aisle;
  quantity: number | null;
  quantityMax: number | null;
  quantityDisplay: string | null;
  unit: string | null;
  /**
   * Not `string`: a preview row is handed straight back to `commitGroceryAdd`,
   * whose validator only accepts the three real dimensions. Widening this to
   * `string` makes that round trip fail to typecheck, which is exactly what
   * `grocery.db.test.ts` caught.
   */
  unitDim: UnitDim;
  mergeUnit: string | null;
  /** Shown but unchecked by default (plan D9). */
  isStaple: boolean;
  /** True when this food already has a live row that this would merge into. */
  mergesInto: string | null;
  sources: Array<{ recipeId: string | null; planEntryId: string | null; rawText: string; scale: number; quantityBase: number | null }>;
}

/**
 * What `previewGroceryAdd` is asked for: some recipes (optionally scaled), a
 * plan week, or both. A **request** contract rather than a response one — §7's
 * migration path for these is a shared Zod schema used by the server validator
 * and the port alike; M1 gets as far as one shared TypeScript shape, which is
 * what stops the client from guessing the field names.
 */
export interface GroceryPreviewInput {
  recipes?: Array<{ recipeId: string; scale?: number }>;
  /** A week start; the server snaps it to the household's week-start day. */
  planWeek?: PlanDate;
}

/** One row handed back to `commitGroceryAdd` — a `GroceryPreviewRow` minus the
 * fields the dialog owns (`key`, `isStaple`, `mergesInto`), with the quantity
 * as edited. */
export interface GroceryCommitRow {
  foodSlug: string | null;
  nameNorm: string;
  displayName: string;
  aisle: Aisle;
  quantity: number | null;
  quantityMax: number | null;
  unit: string | null;
  unitDim: UnitDim | null;
  mergeUnit: string | null;
  sources: Array<{ recipeId: string | null; planEntryId?: string | null; rawText: string; scale?: number; quantityBase: number | null }>;
}

/** An absolute patch of one list row. Absolute by construction, which is what
 * lets it queue offline unchanged in M2 (§5.2). */
export interface GroceryItemPatch {
  itemId: string;
  displayName?: string;
  quantity?: number | null;
  unit?: string | null;
}

export interface GroceryPreview {
  rows: GroceryPreviewRow[];
  /** Recipes the preview drew from, for the dialog's header copy. */
  recipes: Array<{ recipeId: string; title: string; scale: number }>;
}

// --- households, members, invites ---------------------------------------

/** The two membership ranks. Ordered: an owner can do everything a member can. */
export type Role = "owner" | "member";

/** A caller's membership in one household, for list/summary UIs. */
export interface HouseholdSummary {
  id: string;
  name: string;
  role: Role;
  memberCount: number;
}

/** One live member for the household-management members list. */
export interface HouseholdMemberView {
  did: string;
  role: Role;
  /** ISO timestamp. */
  joinedAt: string;
  /** Denormalized handle from `atproto_repo` (best-effort, may be null). */
  handle: string | null;
  invitedByDid: string | null;
  /** True when this row is the caller (so the UI can label "you"). */
  isSelf: boolean;
}

/** A pending BOUND invite for the caller, surfaced on the onboarding screen. */
export interface PendingInvite {
  /**
   * Bound-invite rows are surfaced by their `id` because the raw token is
   * unrecoverable (only `token_hash` is stored). Accept/decline therefore go
   * through `acceptBoundInviteById` / `declineBoundInviteById`, NOT the
   * token-based `acceptInvite`/`declineBoundInvite` (which need the raw token
   * from a shareable link).
   */
  inviteId: string;
  householdName: string;
  inviterHandle: string | null;
  role: Role;
  /** ISO timestamp the invite was created — the chooser dates it ("· 2 days ago"). */
  createdAt: string;
}

/**
 * The §5 state-machine verdict for the current caller.
 * - `active` — a live active household is confirmed (or was just auto-set for a
 *   single-membership user); render the app in it.
 * - `pick`  — 2+ live memberships; show the picker.
 * - `onboard` — 0 live memberships; show the single onboarding screen carrying
 *   the caller's pending bound invites (empty array → empty state).
 */
export type OnboardingVerdict =
  | { kind: "active"; householdId: string; name: string }
  | { kind: "pick"; households: HouseholdSummary[] }
  | { kind: "onboard"; pendingInvites: PendingInvite[] };

/** One pending invite, safe to expose to owners. Never includes `token_hash`. */
export interface InviteSummary {
  id: string;
  role: Role;
  /** DID this invite is locked to (bound invite), or null for an open link. */
  boundToDid: string | null;
  maxUses: number;
  uses: number;
  /** ISO timestamp, or null for a never-expiring invite. */
  expiresAt: string | null;
  createdAt: string;
  status: string;
}

/** Public-ish acceptance-screen preview — no use consumed, no auth required. */
export interface InvitePreview {
  householdName: string;
  inviterHandle: string | null;
  role: Role;
}

export interface HouseholdPreferences {
  /** ISO-8601 weekday numbering: 1 = Monday … 7 = Sunday. */
  weekStartDay: number;
  /** IANA zone name, e.g. "America/Chicago". */
  timezone: string;
}

// --- the public (non-household) recipe surface --------------------------

export interface RecipeCardData {
  id: string;
  name: string;
  description: string | null;
  /** ISO timestamp we consider the recipe "published", or null. */
  publishedAt: string | null;
  imageUrl: string | null;
  imageAlt: string | null;
  /** Who published it — the atproto handle, else a short DID, else null. */
  publishedBy: string | null;
  /** Link to the publisher's profile (Bluesky appview), or null. */
  publisherUrl: string | null;
  /** Which app it was published under, if we can tell. Often null. */
  app: string | null;
  /** Deep link to this recipe on the source app, or null. */
  appUrl: string | null;
}

export interface RecipeDetailData extends RecipeCardData {
  uri: string | null;
  did: string | null;
  images: Array<{ url: string; alt: string | null; aspectW: number | null; aspectH: number | null }>;
  ingredients: string[];
  instructions: string[];
  keywords: string[];
  recipeYield: string | null;
  prepTime: string | null;
  cookTime: string | null;
  totalTime: string | null;
  cuisine: string | null;
  category: string | null;
  cookingMethod: string | null;
  suitableForDiet: string[];
  calories: number | null;
  attribution: {
    kind: string;
    displayName: string | null;
    author: string | null;
    publisher: string | null;
    url: string | null;
  } | null;
}

// --- recipe authoring (online-only, §1.1, but still a wire contract) ------

/**
 * How the author classified a recipe's provenance. A request DTO: it rides
 * inside `SaveRecipeInput` and the import review screen builds one too, so both
 * sides need to name it without importing the writer.
 */
export type AttributionChoice =
  /** Cookbook or magazine. Both fields are lexicon-required; the UI collects the author and prefills nothing. */
  | { kind: "publication"; title: string; author: string }
  /** A person the recipe came from — family, a friend. */
  | { kind: "person"; name: string }
  /** A site the user supplied a URL for by hand (e.g. a bare "Tiktok" source string). */
  | { kind: "website"; name: string; url: string };

/**
 * The first-run nudges the pantry may show. Derived per request rather than
 * stored as flags: `inviteNudge` is "one live member, nobody has dismissed it",
 * so a household that grows past one member stops showing it with no cleanup.
 */
export interface HouseholdNudges {
  inviteNudge: boolean;
}
