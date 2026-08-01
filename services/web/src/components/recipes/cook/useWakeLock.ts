import { useEffect, useRef } from "react";
import { createClientOnlyFn } from "@tanstack/react-start";

/**
 * Hold a Screen Wake Lock while `active` (plan §7.3) — keeps the propped-up iPad
 * awake and foreground, the condition under which foreground timer alarms fire
 * reliably. The lock drops when the tab hides, so re-acquire on
 * `visibilitychange` → visible. Feature-detected; a silent no-op where the API is
 * absent (older Safari). Released on exit / unmount.
 */

// Browser-only: throws loudly if ever reached during SSR (§4.1a). Only ever
// called from inside the effect below, i.e. on the client.
const requestScreenLock = createClientOnlyFn(async (): Promise<WakeLockSentinel | null> => {
  if (!("wakeLock" in navigator)) return null;
  try {
    return await navigator.wakeLock.request("screen");
  } catch {
    return null; // user gesture required / permission denied — degrade silently
  }
});

export function useWakeLock(active: boolean): void {
  const sentinel = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    async function acquire() {
      const lock = await requestScreenLock();
      if (cancelled) {
        void lock?.release().catch(() => {});
        return;
      }
      sentinel.current = lock;
    }

    void acquire();

    function onVisible() {
      if (document.visibilityState === "visible" && !cancelled) void acquire();
    }
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel.current?.release().catch(() => {});
      sentinel.current = null;
    };
  }, [active]);
}
