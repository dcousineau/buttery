import { readJSON, removeKey, writeJSON } from "#/lib/timers/storage";

/**
 * Cook-view session persistence (plan §9.2) — step position, prepped ingredients,
 * and scale settings cached per-recipe so a reload / nav-away / reopen mid-bake
 * doesn't lose the cook's place. **Not** timers (those are global, §9.1). All
 * reads/writes go through the `createClientOnlyFn`-guarded storage helpers.
 */

/**
 * Bump COOK_STATE_VERSION on any breaking change to the persisted cook-view
 * shape. Mismatched payloads are discarded, not migrated.
 */
export const COOK_STATE_VERSION = 1;

/** 6h from `updatedAt` — a next-day reopen starts fresh, not mid-stale. */
const TTL_MS = 6 * 60 * 60 * 1000;

export interface CookState {
  version: number;
  updatedAt: number;
  phase: "mise" | "cook";
  focus: number;
  prepped: number[];
  factor: number;
  metric: boolean;
}

function keyFor(recipeId: string): string {
  return `buttery:cookmode:v${COOK_STATE_VERSION}:${recipeId}`;
}

/** Load a valid, in-version, non-stale entry — else `null` (and clear a rejected one). */
export function loadCookState(recipeId: string): CookState | null {
  const key = keyFor(recipeId);
  const data = readJSON<CookState>(key);
  if (!data || data.version !== COOK_STATE_VERSION) {
    if (data) removeKey(key); // wrong version → discard
    return null;
  }
  if (typeof data.updatedAt !== "number" || Date.now() - data.updatedAt > TTL_MS) {
    removeKey(key); // stale → discard
    return null;
  }
  return data;
}

export function saveCookState(recipeId: string, state: Omit<CookState, "version" | "updatedAt">): void {
  writeJSON(keyFor(recipeId), { ...state, version: COOK_STATE_VERSION, updatedAt: Date.now() } satisfies CookState);
}

export function clearCookState(recipeId: string): void {
  removeKey(keyFor(recipeId));
}
