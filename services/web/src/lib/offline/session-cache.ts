/**
 * The two root-level reads that must answer offline (offline plan §4.4).
 *
 * Everything else the app renders is a household-scoped query with a key, a
 * persister and an invalidation story. These two are neither:
 *
 * - `__root.tsx`'s gate loader (`fetchGateState`) runs on **every** page. Offline
 *   it throws, and a throwing root loader takes the whole tree down — the
 *   installed app shows an error screen instead of a shopping list.
 * - `authClient.useSession()` is a network call owned by better-auth. Offline it
 *   never resolves to a user, so the header, the household name and the active
 *   household id all blank out, and `useActiveHouseholdId()` — the thing every
 *   query key is partitioned by — returns null, which would make the cached rows
 *   unreachable even though they are sitting right there in IndexedDB.
 *
 * **Both fall back to the last known good value, and both fail _open_.** That is
 * a deliberate security posture, not an oversight: neither value authorizes
 * anything. The gate decides whether to render a waitlist screen; the session
 * snapshot decides what name to show and which cache partition to read. Every
 * actual authorization happens server-side, in `assertMember` and the session
 * lookup, on a request that by definition reached the server. A user who is
 * offline holding a stale "invited: true" sees a shell whose every write is
 * disabled — which is exactly what they should see.
 *
 * localStorage, not IndexedDB, and synchronous on purpose: both values are read
 * during the first render pass, before any async restore could have completed,
 * and both are tiny. They ride on the same `createClientOnlyFn` helpers as the
 * timer store (`src/lib/timers/storage.ts`).
 */

import { OFFLINE_FALLBACK_KEYS } from "#/lib/api";
import type { GateState } from "#/lib/api";
import { readJSON, removeKey, writeJSON } from "#/lib/timers/storage";
import { clearCachedActiveHousehold } from "./active-household";

/** Bump to discard every stored snapshot rather than migrating it (§2.1). */
const SNAPSHOT_VERSION = 1;

/** Two weeks, matching the query persister's `maxAge`. */
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14;

interface Snapshot<T> {
  version: number;
  savedAt: number;
  value: T;
}

/**
 * The parts of a session the *chrome* needs. Deliberately not the whole session
 * object: a snapshot is something that gets stale, and the smaller it is, the
 * less there is to be wrong about. No tokens, ever — there is nothing here that
 * could be replayed as credentials.
 */
export interface SessionSnapshot {
  did: string;
  handle: string | null;
  name: string | null;
  activeHouseholdId: string | null;
}

function read<T>(key: string): T | null {
  const stored = readJSON<Snapshot<T>>(key);
  if (!stored || stored.version !== SNAPSHOT_VERSION) return null;
  if (Date.now() - stored.savedAt > MAX_AGE_MS) return null;
  return stored.value;
}

function write<T>(key: string, value: T): void {
  writeJSON(key, { version: SNAPSHOT_VERSION, savedAt: Date.now(), value } satisfies Snapshot<T>);
}

// --- the gate -----------------------------------------------------------

export function readCachedGateState(): GateState | null {
  return read<GateState>(OFFLINE_FALLBACK_KEYS.gate);
}

export function cacheGateState(gate: GateState): void {
  write(OFFLINE_FALLBACK_KEYS.gate, gate);
}

/**
 * The gate loader's offline arm.
 *
 * The fallback order is: what the server just said → what it last said → **fail
 * open**. The last step is the one worth defending: an uninvited visitor's
 * cached shell is not a security boundary (the server functions are), whereas a
 * *signed-in, invited* user being shown a waitlist screen because their phone
 * lost signal in a kitchen is a real failure of the feature this plan exists to
 * build. Erring toward the app is the correct direction here.
 */
export function gateStateOffline(): GateState {
  return readCachedGateState() ?? { authed: true, invited: true };
}

// --- the session --------------------------------------------------------

export function readCachedSession(): SessionSnapshot | null {
  return read<SessionSnapshot>(OFFLINE_FALLBACK_KEYS.session);
}

export function cacheSession(snapshot: SessionSnapshot): void {
  write(OFFLINE_FALLBACK_KEYS.session, snapshot);
}

/**
 * Drop both snapshots. Called from `wipeCachePartition` — on sign-out, household
 * switch, membership failure, and schema bump. A session snapshot that outlived a
 * sign-out would keep the previous user's name on a shared iPad's header, which
 * is the exact thing §2.7 refuses.
 */
export function clearOfflineFallbacks(): void {
  removeKey(OFFLINE_FALLBACK_KEYS.gate);
  removeKey(OFFLINE_FALLBACK_KEYS.session);
  clearCachedActiveHousehold();
}
