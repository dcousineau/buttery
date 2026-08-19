/**
 * "Stop offering the install chip on this device" — remembered as durably as a
 * browser allows.
 *
 * There is no single storage that survives everything, so this writes **two**
 * and believes **either**: localStorage (fast, synchronous, but the first thing
 * cleared by "remove site data" flows and some private modes) and a dedicated
 * IndexedDB database (heavier, but the store browsers are most reluctant to
 * evict, and the one `navigator.storage.persist()` — requested at boot in
 * `useCachePartition` — actually protects). A read that finds the flag in only
 * one re-writes the other, so a partial clear heals instead of re-nagging.
 *
 * Deliberately **outside** every store the cache wipes touch. `buttery-queries`
 * is cleared on sign-out, household switch and `forbidden`
 * (`wipeCachePartition`), and `clearOfflineFallbacks` takes the localStorage
 * snapshots — but "this person said no to the install nag" is a fact about the
 * *device*, not about who is signed in, and a sign-out must not resurrect it.
 * Hence its own DB and a key none of the wipe paths know about.
 *
 * The honest ceiling: for a site that is NOT installed, Safari's seven-day rule
 * erases localStorage and IndexedDB alike, so a dismissal there lives at most a
 * week of non-use. That cannot be beaten from the browser — it is, in fact, the
 * exact problem the chip is trying to sell the fix for.
 */

import { createClientOnlyFn } from "@tanstack/react-start";
import { createStore, get, set, type UseStore } from "idb-keyval";
import { readJSON, writeJSON } from "#/lib/timers/storage";

/** Same key both stores. The pre-redesign localStorage payload (`{at}` with a
 * 90-day rule) parses as truthy here, so anyone who already said "not now"
 * stays dismissed — strictly longer than they were promised, per the new rule. */
const DISMISSED_KEY = "buttery:install-prompt-dismissed";

const PREFS_DB = "buttery-prefs";
const PREFS_STORE = "prefs";

let store: UseStore | null = null;

function prefsStore(): UseStore {
  store ??= createStore(PREFS_DB, PREFS_STORE);
  return store;
}

/** Has this device said no? Checks localStorage first (synchronous), then IDB —
 * and mirrors a hit back into whichever store had lost it. */
export const readInstallPromptDismissed = createClientOnlyFn(async (): Promise<boolean> => {
  if (readJSON<{ at: number }>(DISMISSED_KEY)) return true;
  try {
    const stored = await get<{ at: number }>(DISMISSED_KEY, prefsStore());
    if (stored) {
      writeJSON(DISMISSED_KEY, stored);
      return true;
    }
  } catch {
    // IDB unavailable (private mode, insecure context). localStorage already
    // answered no; that is the answer.
  }
  return false;
});

/** Record the no, everywhere at once. Never throws — a nag that cannot be
 * dismissed because storage is full would be worse than the nag. */
export const writeInstallPromptDismissed = createClientOnlyFn((): void => {
  const record = { at: Date.now() };
  writeJSON(DISMISSED_KEY, record);
  void (async () => {
    try {
      await set(DISMISSED_KEY, record, prefsStore());
    } catch {
      /* best-effort; localStorage carries it */
    }
  })();
});
