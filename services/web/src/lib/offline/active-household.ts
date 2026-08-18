/**
 * `requireActiveHousehold`, made survivable offline (offline plan §4.4).
 *
 * Every `/household/*` route starts by calling `requireActiveHousehold()` — the
 * stale-active guard, which confirms the session's `active_household_id` still
 * points at a live membership and redirects if it does not. It is a server
 * function, so on a phone with no signal it throws, and a `beforeLoad` that
 * throws is a route that does not render.
 *
 * That makes it the **third** root-level read the offline shell depends on,
 * alongside the gate and the session (§4.4), and the most load-bearing of them:
 * a household id is what partitions every query key, so without one the rows
 * sitting in IndexedDB cannot even be *addressed*, let alone rendered.
 *
 * The fallback is narrow on purpose:
 *
 * - It only applies **client-side**. On the server a failure is a real failure.
 * - It only applies to a **network** failure (`isOffline`). A thrown
 *   `redirect({ to: "/login" })` or a genuine membership error must still
 *   propagate — those are the guard doing its job, and swallowing them would
 *   leave someone stranded on a household they were removed from.
 * - It only applies when there is **something cached to fall back to**. No
 *   snapshot means the app has never successfully loaded here, so there is
 *   nothing to render offline anyway.
 *
 * As with the gate, none of this authorizes anything: the id is a cache
 * partition and a display name. Every read it keys is a server function that has
 * to reach the server, where `assertMember` is the actual gate.
 */

import { isOffline, requireActiveHousehold } from "#/lib/api";
import { readJSON, removeKey, writeJSON } from "#/lib/timers/storage";

const KEY = "buttery:offline:active-household";
const VERSION = 1;

export interface ActiveHousehold {
  householdId: string;
  name: string;
}

interface Snapshot {
  version: number;
  value: ActiveHousehold;
}

function readCached(): ActiveHousehold | null {
  const stored = readJSON<Snapshot>(KEY);
  if (!stored || stored.version !== VERSION) return null;
  return stored.value;
}

/** Dropped by `wipeCachePartition` along with the other fallbacks. */
export function clearCachedActiveHousehold(): void {
  removeKey(KEY);
}

/**
 * The offline-tolerant `requireActiveHousehold`. Use this in every migrated
 * route's `beforeLoad`; the household it returns goes into the router context,
 * which is where loaders and components read the cache partition from.
 */
export async function ensureActiveHousehold(): Promise<ActiveHousehold> {
  try {
    const active = await requireActiveHousehold();
    if (typeof window !== "undefined") writeJSON(KEY, { version: VERSION, value: active } satisfies Snapshot);
    return active;
  } catch (error) {
    if (typeof window === "undefined" || !isOffline(error)) throw error;
    const cached = readCached();
    if (!cached) throw error;
    return cached;
  }
}
