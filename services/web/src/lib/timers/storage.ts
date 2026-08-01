/**
 * Client-only localStorage JSON helpers (plan §4.1a, §9). Every read/write is
 * wrapped in `createClientOnlyFn` so a server-side call throws loudly instead of
 * silently misbehaving — cook mode and the timer store are strictly client state
 * and must never touch storage during SSR / first hydration.
 */
import { createClientOnlyFn } from "@tanstack/react-start";

/** Read + JSON-parse a key. Returns `null` on miss or malformed payload. */
export const readJSON = createClientOnlyFn(<T>(key: string): T | null => {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
});

/** JSON-stringify + write a key. Swallows quota / serialization errors. */
export const writeJSON = createClientOnlyFn((key: string, value: unknown): void => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota exceeded / private mode — persistence is best-effort */
  }
});

/** Remove a key. */
export const removeKey = createClientOnlyFn((key: string): void => {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
});
