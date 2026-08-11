/**
 * The global timer store (plan §6) — the single source of truth for every timer,
 * whether started from cook mode or the recipe detail method list. Timers are
 * **application state**, not cook-mode state: they keep running when you leave
 * cook mode, surface from the header indicator anywhere in the app, and persist
 * across reload / tab-close (§9.1).
 *
 * A module singleton exposed via `useSyncExternalStore` (usable from anywhere
 * without a provider). Running timers store an absolute `endsAt` and **never**
 * decrement a stored counter — remaining is always `endsAt - now()`, so a page
 * returning from the background snaps to the correct time and fires anything that
 * expired while hidden (§7.3). Strictly client state: persistence goes through
 * `createClientOnlyFn`-guarded helpers and hydration happens in an effect, after
 * first render, so SSR and first client render agree (§4.1a).
 */
import { useEffect, useSyncExternalStore } from "react";
import { readJSON, removeKey, writeJSON } from "./storage";
import { ForegroundAlarmDelivery, type AlarmDelivery } from "./alarm-delivery";

/** `alarming` = expired, sounding + flashing, awaiting the user's ack. */
export type TimerStatus = "running" | "paused" | "alarming";

export interface Timer {
  id: string;
  recipeId: string;
  recipeTitle: string;
  label: string;
  totalMs: number;
  /** Epoch ms; present while running. */
  endsAt?: number;
  /** Present while paused. */
  pausedRemainingMs?: number;
  status: TimerStatus;
  /** Epoch ms the timer expired; set when it entered `alarming`. */
  firedAt?: number;
}

export interface AddTimerInput {
  recipeId: string;
  recipeTitle: string;
  label: string;
  seconds: number;
}

interface Snapshot {
  timers: Timer[];
  muted: boolean;
}

interface PersistShape {
  version: number;
  timers: Timer[];
}

/**
 * Bump TIMER_STATE_VERSION on any breaking change to the persisted timer shape.
 * Mismatched payloads are discarded, not migrated.
 */
export const TIMER_STATE_VERSION = 1;

const STORAGE_KEY = `buttery:timers:v${TIMER_STATE_VERSION}`;
/** Drop timers whose expiry is older than this on load — no zombie alarms (§9.1). */
const TTL_MS = 6 * 60 * 60 * 1000;
/** Bound the popover; newest prepended, oldest running dropped past the cap (§6.1). */
const CAP = 8;
/** Re-render cadence while a timer runs; drives re-render only, never a counter. */
const TICK_MS = 500;

const EMPTY_SNAPSHOT: Snapshot = Object.freeze({ timers: Object.freeze([]) as unknown as Timer[], muted: false });

function now(): number {
  return Date.now();
}

/** Live remaining ms for a timer (0 floor). Pure — the only source of "remaining". */
export function remainingMs(timer: Timer, at: number = now()): number {
  if (timer.status === "paused") return Math.max(0, timer.pausedRemainingMs ?? 0);
  if (timer.status === "alarming") return 0;
  return Math.max(0, (timer.endsAt ?? at) - at);
}

let idCounter = 0;
function genId(): string {
  idCounter += 1;
  return `t${now().toString(36)}-${idCounter}`;
}

/**
 * Every member is an arrow-function *property*, not a method: the store is one
 * closure with no `this`, and its members are pulled off the object and passed
 * around bare (`useSyncExternalStore(timerStore.subscribe, ...)`, the `useTimers`
 * re-export below). Method syntax would type those detached references as
 * `this`-bearing methods — which is exactly what `unbound-method` reports.
 */
export interface TimerStore {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => Snapshot;
  getServerSnapshot: () => Snapshot;
  hydrate: () => void;
  /** Unlock audio + request notification permission from a gesture (e.g. the
   * "Start cooking" click) so a later-firing timer sounds without a fresh tap. */
  arm: () => void;
  add: (input: AddTimerInput) => string;
  pause: (id: string) => void;
  resume: (id: string) => void;
  ack: (id: string) => void;
  dismiss: (id: string) => void;
  addMinute: (id: string) => void;
  reset: (id: string) => void;
  setMuted: (muted: boolean) => void;
  /** Test-only: clear all state + persisted key. */
  _reset: () => void;
}

export function createTimerStore(delivery: AlarmDelivery = new ForegroundAlarmDelivery()): TimerStore {
  let timers: Timer[] = [];
  let muted = false;
  let snapshot: Snapshot = { timers, muted };
  const listeners = new Set<() => void>();
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let saveTimeout: ReturnType<typeof setTimeout> | null = null;
  let hydrated = false;

  function publish(): void {
    snapshot = { timers, muted };
    for (const cb of listeners) cb();
  }

  function persistNow(): void {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    if (timers.length === 0) {
      removeKey(STORAGE_KEY);
      return;
    }
    writeJSON(STORAGE_KEY, { version: TIMER_STATE_VERSION, timers } satisfies PersistShape);
  }

  function persistDebounced(): void {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(persistNow, 250);
  }

  function ensureTick(): void {
    if (intervalId != null) return;
    if (!timers.some((t) => t.status === "running")) return;
    intervalId = setInterval(tick, TICK_MS);
  }

  function maybeStopTick(): void {
    if (intervalId != null && !timers.some((t) => t.status === "running")) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  /** Recompute expiries against the wall clock; fire anything newly expired. */
  function tick(): void {
    const t = now();
    const fired: Timer[] = [];
    timers = timers.map((timer) => {
      if (timer.status === "running" && (timer.endsAt ?? Infinity) <= t) {
        const alarming: Timer = { ...timer, status: "alarming", firedAt: timer.endsAt, endsAt: undefined };
        fired.push(alarming);
        return alarming;
      }
      return timer;
    });
    for (const f of fired) delivery.fire(f);
    if (fired.length) persistDebounced();
    publish();
    maybeStopTick();
  }

  function afterChange(): void {
    ensureTick();
    maybeStopTick();
    persistDebounced();
    publish();
  }

  /** Drop the oldest droppable (running, then paused; never alarming) over the cap. */
  function enforceCap(list: Timer[]): Timer[] {
    if (list.length <= CAP) return list;
    for (const status of ["running", "paused"] as const) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].status === status) {
          return [...list.slice(0, i), ...list.slice(i + 1)];
        }
      }
    }
    return list; // all alarming — never silently drop one
  }

  function onVisibilityOrFocus(): void {
    // Snap to correct remaining and fire anything that expired while hidden.
    tick();
    ensureTick();
  }

  function onHide(): void {
    persistNow(); // flush before the page freezes / unloads
  }

  function hydrate(): void {
    if (hydrated) return;
    hydrated = true;
    if (typeof window === "undefined") return;

    timers = loadPersisted();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") onVisibilityOrFocus();
      else onHide();
    });
    window.addEventListener("focus", onVisibilityOrFocus);
    window.addEventListener("pagehide", onHide);

    ensureTick();
    publish();
  }

  function loadPersisted(): Timer[] {
    const data = readJSON<PersistShape>(STORAGE_KEY);
    if (!data || data.version !== TIMER_STATE_VERSION || !Array.isArray(data.timers)) return [];
    const t = now();
    const cutoff = t - TTL_MS;
    const out: Timer[] = [];
    for (const timer of data.timers) {
      if (timer.status === "running") {
        if (timer.endsAt == null) continue;
        if (timer.endsAt <= t) {
          if (timer.endsAt < cutoff) continue; // too old → drop the zombie alarm
          out.push({ ...timer, status: "alarming", firedAt: timer.endsAt, endsAt: undefined });
        } else {
          out.push(timer);
        }
      } else if (timer.status === "alarming") {
        if ((timer.firedAt ?? 0) < cutoff) continue;
        out.push(timer);
      } else if (timer.status === "paused") {
        out.push(timer); // paused is intentional; no wall-clock anchor to expire it
      }
    }
    return out.slice(0, CAP);
  }

  function update(id: string, fn: (timer: Timer) => Timer | null): void {
    let touched = false;
    const next: Timer[] = [];
    for (const timer of timers) {
      if (timer.id !== id) {
        next.push(timer);
        continue;
      }
      touched = true;
      const result = fn(timer);
      if (result) next.push(result);
    }
    if (!touched) return;
    timers = next;
    afterChange();
  }

  return {
    subscribe: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY_SNAPSHOT,
    hydrate,
    arm: () => {
      delivery.arm();
    },
    add: (input) => {
      const id = genId();
      const totalMs = Math.max(1000, Math.round(input.seconds * 1000));
      const timer: Timer = {
        id,
        recipeId: input.recipeId,
        recipeTitle: input.recipeTitle,
        label: input.label,
        totalMs,
        endsAt: now() + totalMs,
        status: "running",
      };
      timers = enforceCap([timer, ...timers]);
      // Runs inside the user gesture: unlock audio + request notification perm.
      delivery.arm();
      delivery.scheduleAlarm(timer);
      afterChange();
      return id;
    },
    pause: (id) => {
      update(id, (timer) => (timer.status === "running" ? { ...timer, status: "paused", pausedRemainingMs: remainingMs(timer), endsAt: undefined } : timer));
    },
    resume: (id) => {
      update(id, (timer) => {
        if (timer.status !== "paused") return timer;
        const resumed: Timer = { ...timer, status: "running", endsAt: now() + (timer.pausedRemainingMs ?? 0), pausedRemainingMs: undefined };
        delivery.scheduleAlarm(resumed);
        return resumed;
      });
    },
    ack: (id) => {
      delivery.cancelAlarm(id);
      update(id, (timer) => (timer.status === "alarming" ? null : timer));
    },
    dismiss: (id) => {
      delivery.cancelAlarm(id);
      update(id, () => null);
    },
    addMinute: (id) => {
      update(id, (timer) => {
        if (timer.status === "running") return { ...timer, endsAt: (timer.endsAt ?? now()) + 60_000 };
        if (timer.status === "paused") return { ...timer, pausedRemainingMs: (timer.pausedRemainingMs ?? 0) + 60_000 };
        // Re-arm an alarming timer for another minute.
        delivery.cancelAlarm(id);
        const rearmed: Timer = { ...timer, status: "running", endsAt: now() + 60_000, firedAt: undefined };
        delivery.scheduleAlarm(rearmed);
        return rearmed;
      });
    },
    reset: (id) => {
      update(id, (timer) => {
        delivery.cancelAlarm(id);
        const rearmed: Timer = { ...timer, status: "running", endsAt: now() + timer.totalMs, pausedRemainingMs: undefined, firedAt: undefined };
        delivery.scheduleAlarm(rearmed);
        return rearmed;
      });
    },
    setMuted: (next) => {
      muted = next;
      delivery.setMuted(next);
      publish();
    },
    _reset: () => {
      if (intervalId != null) {
        clearInterval(intervalId);
        intervalId = null;
      }
      if (saveTimeout) {
        clearTimeout(saveTimeout);
        saveTimeout = null;
      }
      timers = [];
      muted = false;
      hydrated = false;
      removeKey(STORAGE_KEY);
      publish();
    },
  };
}

/** The app-wide singleton. Hydrated once by `HeaderTimerIndicator` (always mounted). */
export const timerStore = createTimerStore();

/** Full timer state + bound actions. */
export function useTimers() {
  const snapshot = useSyncExternalStore(timerStore.subscribe, timerStore.getSnapshot, timerStore.getServerSnapshot);
  return {
    timers: snapshot.timers,
    muted: snapshot.muted,
    arm: timerStore.arm,
    add: timerStore.add,
    pause: timerStore.pause,
    resume: timerStore.resume,
    ack: timerStore.ack,
    dismiss: timerStore.dismiss,
    addMinute: timerStore.addMinute,
    reset: timerStore.reset,
    setMuted: timerStore.setMuted,
  };
}

/** Timers for one recipe (the on-recipe strip, §6.5). Newest first (store order). */
export function useRecipeTimers(recipeId: string): Timer[] {
  const snapshot = useSyncExternalStore(timerStore.subscribe, timerStore.getSnapshot, timerStore.getServerSnapshot);
  return snapshot.timers.filter((t) => t.recipeId === recipeId);
}

export interface TimerSummary {
  inProgress: number; // running + paused
  alarming: number; // done, needs ack
  total: number;
}

/** Header-indicator counts. */
export function useTimerSummary(): TimerSummary {
  const snapshot = useSyncExternalStore(timerStore.subscribe, timerStore.getSnapshot, timerStore.getServerSnapshot);
  const timers = snapshot.timers;
  let inProgress = 0;
  let alarming = 0;
  for (const t of timers) {
    if (t.status === "alarming") alarming += 1;
    else inProgress += 1;
  }
  return { inProgress, alarming, total: timers.length };
}

/** Run the store's one-time client hydration in an effect (SSR-safe): the store
 * starts empty on the server + first client render, then loads localStorage
 * after mount so the two agree (no hydration mismatch, §4.1a). */
export function useHydrateTimers(): void {
  useEffect(() => {
    timerStore.hydrate();
  }, []);
}
