/**
 * Service-worker registration and the update handshake (offline plan §4.4).
 *
 * **No `skipWaiting()` in the worker.** A new build waits until the page asks
 * for it, and the page only asks when the user presses "Reload". Silently
 * swapping the JS bundle under a running cook-mode timer — a 40-minute bake with
 * an alarm pending — is not acceptable, and it is exactly what an eager
 * `skipWaiting()` + `clients.claim()` does.
 *
 * So the flow is: worker installs → sits in `waiting` → this hook notices →
 * `AppShell` renders a toast → user taps Reload → `postMessage({type:
 * "SKIP_WAITING"})` → `controllerchange` → one `location.reload()`.
 *
 * Registration is deliberately late (`load`) and production-only. In dev a
 * service worker intercepts HMR and serves yesterday's chunks after a restart,
 * which turns "did my change apply?" into a coin flip; the build plugin does not
 * even emit `sw.js` outside a production build, so this would 404 anyway.
 */

import { useEffect, useState } from "react";

export interface ServiceWorkerState {
  /** A new build is installed and waiting for permission to take over. */
  updateReady: boolean;
  /** Tell the waiting worker to activate, then reload once it has. */
  applyUpdate: () => void;
}

export function useServiceWorker(): ServiceWorkerState {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!import.meta.env.PROD) return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    let cancelled = false;

    function watch(registration: ServiceWorkerRegistration): void {
      if (cancelled) return;
      // Already waiting when we registered — a previous visit installed it.
      if (registration.waiting) setWaiting(registration.waiting);

      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          // `installed` + an existing controller means "a NEW version is ready";
          // `installed` with no controller is the very first install, which has
          // nothing to replace and must not prompt anyone to reload.
          if (installing.state === "installed" && navigator.serviceWorker.controller) setWaiting(installing);
        });
      });
    }

    function register(): void {
      void navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then(watch)
        .catch(() => {
          // A failed registration costs the offline shell, nothing else. The app
          // is fully functional online without it, and Query's IndexedDB cache
          // is independent of the worker (§2.2).
        });
    }

    // After `load`, so registration never competes with first paint for the
    // main thread on a phone.
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    return () => {
      cancelled = true;
      window.removeEventListener("load", register);
    };
  }, []);

  return {
    updateReady: waiting !== null,
    applyUpdate: () => {
      if (!waiting) return;
      // Reload when the new worker actually takes control, not immediately: an
      // early reload races the activation and can come back on the old bundle.
      // `once` matters — `controllerchange` also fires on the first-ever claim.
      navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), { once: true });
      waiting.postMessage({ type: "SKIP_WAITING" });
    },
  };
}
