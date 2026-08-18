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
 * `AppShell` renders a banner → user taps Reload → `postMessage({type:
 * "SKIP_WAITING"})` → `controllerchange` → one `location.reload()`.
 *
 * Registration is deliberately late (`load`) and production-only. In dev a
 * service worker intercepts HMR and serves yesterday's chunks after a restart,
 * which turns "did my change apply?" into a coin flip; the build plugin does not
 * even emit `sw.js` outside a production build, so this would 404 anyway.
 */

import { useEffect, useState } from "react";

/**
 * How often to ask the browser to re-fetch `sw.js`.
 *
 * The browser's own soft update runs on navigation — and an installed Buttery
 * has essentially no navigations: it opens once and every screen after that is
 * client-side routing. Without this, a phone left on the home screen can sit on
 * a build from days ago and never learn otherwise, which makes the whole
 * waiting-worker handshake below theatre. An hour is cheap: `update()` is one
 * conditional GET of a file measured in kilobytes.
 */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Floor between checks, so returning to the app repeatedly does not hammer it. */
const UPDATE_CHECK_MIN_GAP_MS = 15 * 60 * 1000;

export interface ServiceWorkerState {
  /** A new build is installed and waiting for permission to take over. */
  updateReady: boolean;
  /** Tell the waiting worker to activate, then reload once it has. */
  applyUpdate: () => void;
  /**
   * Put the offer away without taking it. The worker stays waiting — nothing is
   * cancelled, and the next build re-offers — but the banner stops occupying the
   * bottom of the screen. See `UpdateBanner` for why that matters mid-cook.
   */
  dismissUpdate: () => void;
}

export function useServiceWorker(): ServiceWorkerState {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  // Which worker the user has waved away, by identity rather than a boolean: a
  // *newer* build produces a different `ServiceWorker` object, so the offer
  // comes back on its own without any bookkeeping to reset.
  const [dismissedFor, setDismissedFor] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!import.meta.env.PROD) return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    let onVisible: (() => void) | undefined;

    /**
     * Offer a worker as "the new version", now or when it finishes installing.
     *
     * Called for `waiting` **and** `installing`, which is the whole fix here.
     * The browser fires `updatefound` at the *start* of a navigation, well
     * before this hook's `load`-deferred `register()` resolves, so by the time
     * we get the registration the event has already been and gone: `waiting` is
     * still `null` (the install is in flight), the `updatefound` listener below
     * is attached to something that already fired, and nobody ever notices the
     * deploy. That is the ordinary case after a release — not an edge one — and
     * it is why the banner "usually never appeared".
     */
    function offer(worker: ServiceWorker | null): void {
      if (!worker || cancelled) return;
      // `installed` + an existing controller means "a NEW version is ready";
      // `installed` with no controller is the very first install, which has
      // nothing to replace and must not prompt anyone to reload.
      const ready = () => worker.state === "installed" && navigator.serviceWorker.controller !== null;
      if (ready()) {
        setWaiting(worker);
        return;
      }
      // Already past `installed` (activating/activated) or dead: nothing to
      // wait for, and `statechange` will never come back round to `installed`.
      if (worker.state !== "installing") return;
      worker.addEventListener("statechange", () => {
        if (!cancelled && ready()) setWaiting(worker);
      });
    }

    function watch(registration: ServiceWorkerRegistration): void {
      if (cancelled) return;
      // Installed on a previous visit and parked.
      offer(registration.waiting);
      // Installing *right now* — the case the `updatefound` listener cannot see,
      // because that event fired before this code existed on the page.
      offer(registration.installing);
      // And any update that starts from here on: a periodic check below, or the
      // browser's own on the next real navigation.
      registration.addEventListener("updatefound", () => offer(registration.installing));

      let lastCheck = Date.now(); // `register()` itself just performed one
      const check = (): void => {
        if (cancelled) return;
        if (Date.now() - lastCheck < UPDATE_CHECK_MIN_GAP_MS) return;
        // `navigator.onLine` is a weak signal (see `use-online.ts`), but it is
        // exactly strong enough for "don't bother" — a failed check costs
        // nothing but a console entry, so being wrong in either direction is
        // harmless here.
        if (!navigator.onLine) return;
        lastCheck = Date.now();
        void registration.update().catch(() => undefined);
      };

      interval = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
      // A phone in a pocket does not run timers reliably; coming back to the app
      // is the moment worth checking, and the gap floor keeps it from firing on
      // every glance.
      onVisible = () => {
        if (document.visibilityState === "visible") check();
      };
      document.addEventListener("visibilitychange", onVisible);
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
      if (interval !== undefined) clearInterval(interval);
      if (onVisible) document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return {
    updateReady: waiting !== null && waiting !== dismissedFor,
    applyUpdate: () => {
      if (!waiting) return;
      // Reload when the new worker actually takes control, not immediately: an
      // early reload races the activation and can come back on the old bundle.
      // `once` matters — `controllerchange` also fires on the first-ever claim.
      navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), { once: true });
      waiting.postMessage({ type: "SKIP_WAITING" });
    },
    dismissUpdate: () => setDismissedFor(waiting),
  };
}
