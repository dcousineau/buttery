import type { PlanEntry, PlanRecipeEntry, PlanWeek } from "#/server/meal-plan";
import type { HouseholdRecipeRow } from "#/server/household-recipes";
import { MEAL_SLOTS, type MealSlot, type PlanDate } from "#/lib/plan/week";

/**
 * Pure patches over a `PlanWeek` payload — the optimistic half of §8.2.
 *
 * Every mutation on `/household/plan` paints its result immediately and
 * reconciles with `router.invalidate()` when the server answers. These are what
 * "paints immediately" means: given the week the loader returned and the change
 * the user asked for, they produce the week the user should already be looking
 * at. Nothing here touches the network, React, or the loader — the route holds
 * the patched week in state and drops it once the real one arrives.
 *
 * Two invariants every patch restores, so a half-second of optimistic state is
 * never internally inconsistent:
 *
 * - `position` stays dense `0..n-1` inside each slot, mirroring what §3.6's
 *   transaction does server-side.
 * - `recipeEntryCount` / `emptySlotCount` / `cookedCount` are recomputed, so the
 *   "This week" panel's numbers can't disagree with the grid beside them.
 *
 * Nothing is mutated in place: the loader's payload is shared with the router
 * cache, so every function clones the days and slots it touches and rebuilds
 * any entry whose `position` changed.
 */

/** Where an entry currently sits. */
export interface EntryLocation {
  entry: PlanEntry;
  date: PlanDate;
  slot: MealSlot;
}

/** Locate an entry by id across the whole week. Null when it isn't visible. */
export function findEntry(week: PlanWeek, entryId: string): EntryLocation | null {
  for (const day of week.days) {
    for (const slot of MEAL_SLOTS) {
      const entry = day.slots[slot].find((candidate) => candidate.id === entryId);
      if (entry) return { entry, date: day.date, slot };
    }
  }
  return null;
}

/** Shallow-clone the week down to (and including) every slot array. */
function cloneWeek(week: PlanWeek): PlanWeek {
  return {
    ...week,
    days: week.days.map((day) => ({
      ...day,
      slots: {
        breakfast: [...day.slots.breakfast],
        lunch: [...day.slots.lunch],
        dinner: [...day.slots.dinner],
        snack: [...day.slots.snack],
      },
    })),
  };
}

/**
 * Renumber every slot densely and recount the week's stats. Run at the end of
 * each patch so callers never have to remember to.
 */
function settle(week: PlanWeek): PlanWeek {
  let recipeEntryCount = 0;
  let cookedCount = 0;
  let emptySlotCount = 0;

  for (const day of week.days) {
    for (const slot of MEAL_SLOTS) {
      const entries = day.slots[slot];
      if (entries.length === 0) emptySlotCount += 1;
      // Rebuild only the entries whose index moved — a stable reference keeps
      // React from re-rendering cards that did not change.
      day.slots[slot] = entries.map((entry, position) => (entry.position === position ? entry : { ...entry, position }));
      for (const entry of entries) {
        if (entry.kind !== "recipe") continue;
        recipeEntryCount += 1;
        if (entry.cookedAt) cookedCount += 1;
      }
    }
  }

  return { ...week, recipeEntryCount, emptySlotCount, cookedCount };
}

/** Soft-remove an entry (§6.5). Unknown ids leave the week untouched. */
export function withEntryRemoved(week: PlanWeek, entryId: string): PlanWeek {
  const next = cloneWeek(week);
  for (const day of next.days) {
    for (const slot of MEAL_SLOTS) {
      day.slots[slot] = day.slots[slot].filter((entry) => entry.id !== entryId);
    }
  }
  return settle(next);
}

/**
 * Move an entry to another day and/or slot, appending to the destination tail
 * (D14). A move onto its current slot, or a move to a day outside the visible
 * week, both come back unchanged — the former is the server's no-op, the latter
 * simply leaves the grid with one fewer card until the refetch lands.
 */
export function withEntryMoved(week: PlanWeek, entryId: string, toDate: PlanDate, toSlot: MealSlot): PlanWeek {
  const found = findEntry(week, entryId);
  if (!found) return week;
  if (found.date === toDate && found.slot === toSlot) return week;

  const next = cloneWeek(week);
  for (const day of next.days) {
    for (const slot of MEAL_SLOTS) {
      day.slots[slot] = day.slots[slot].filter((entry) => entry.id !== entryId);
    }
  }
  const destination = next.days.find((day) => day.date === toDate);
  if (destination) destination.slots[toSlot] = destination.slots[toSlot].concat([found.entry]);
  return settle(next);
}

/**
 * Set or clear the cooked mark (§6.6). `cookedAt` is a placeholder timestamp —
 * the server's real one arrives with the invalidate; the card only reads it as
 * a boolean.
 */
export function withEntryCooked(week: PlanWeek, entryId: string, cooked: boolean, cookedByHandle: string | null = null): PlanWeek {
  const next = cloneWeek(week);
  for (const day of next.days) {
    for (const slot of MEAL_SLOTS) {
      day.slots[slot] = day.slots[slot].map((entry) =>
        entry.id === entryId && entry.kind === "recipe" ? { ...entry, cookedAt: cooked ? new Date().toISOString() : null, cookedByHandle: cooked ? cookedByHandle : null } : entry,
      );
    }
  }
  return settle(next);
}

/** Replace a note's text (§6.3). An empty body is a removal, not a blank note. */
export function withNoteBody(week: PlanWeek, entryId: string, body: string): PlanWeek {
  const trimmed = body.trim();
  if (trimmed === "") return withEntryRemoved(week, entryId);
  const next = cloneWeek(week);
  for (const day of next.days) {
    for (const slot of MEAL_SLOTS) {
      day.slots[slot] = day.slots[slot].map((entry) => (entry.id === entryId && entry.kind === "note" ? { ...entry, body: trimmed } : entry));
    }
  }
  return settle(next);
}

/** Append already-shaped entries to a slot's tail. */
export function withEntriesAppended(week: PlanWeek, date: PlanDate, slot: MealSlot, entries: PlanEntry[]): PlanWeek {
  if (entries.length === 0) return week;
  const next = cloneWeek(week);
  const day = next.days.find((candidate) => candidate.date === date);
  if (!day) return week;
  day.slots[slot] = day.slots[slot].concat(entries);
  return settle(next);
}

/**
 * The optimistic stand-in for a recipe the server has not echoed back yet.
 *
 * Everything the CARD renders (title, time, "not in box") comes straight from
 * the box row the picker was showing, so the card is correct the instant it
 * appears. The three fields the box row cannot answer — the popover hero, and
 * who added it — settle on the invalidate a moment later: `imageUrl` borrows
 * the list thumbnail rather than showing the utensils placeholder and then
 * swapping, and `addedByHandle` is left null so the popover omits the line
 * instead of guessing a handle.
 *
 * The id is a client-side placeholder (`optimistic:`-prefixed so it can never
 * collide with a ULID). Nothing may be done to an entry while it wears one:
 * the real id lands with the invalidate.
 */
export function optimisticRecipeEntry(row: HouseholdRecipeRow, position: number): PlanRecipeEntry {
  return {
    id: `optimistic:${row.recipeId}:${position}`,
    kind: "recipe",
    position,
    recipeId: row.recipeId,
    title: row.title,
    imageUrl: row.thumbUrl,
    totalMinutes: row.totalMinutes,
    totalTimeDisplay: row.totalTimeDisplay,
    source: { kind: row.sourceKind, label: row.sourceLabel, url: row.sourceUrl },
    inBox: true,
    unavailable: row.unavailable,
    unpublished: row.unpublished,
    cookedAt: null,
    cookedByHandle: null,
    addedByHandle: null,
  };
}

/** The optimistic stand-in for a freshly written note. */
export function optimisticNoteEntry(body: string, position: number): PlanEntry {
  return { id: `optimistic:note:${position}:${body.length}`, kind: "note", position, body: body.trim(), cookedAt: null, addedByHandle: null };
}

/** True for a placeholder id — the entry exists only in this browser so far. */
export function isOptimisticId(id: string): boolean {
  return id.startsWith("optimistic:");
}
