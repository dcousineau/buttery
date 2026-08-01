// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTimerStore, remainingMs, TIMER_STATE_VERSION, type AddTimerInput, type Timer } from "./store";
import type { AlarmDelivery } from "./alarm-delivery";

/**
 * Global timer store (plan §6, §9.1). Wall-clock remaining, pause/resume, expiry
 * → alarming, ack/dismiss removal, the cap that never drops an alarming timer,
 * fire-on-return, and persistence (round-trip, version mismatch, TTL, restore).
 */

const KEY = `buttery:timers:v${TIMER_STATE_VERSION}`;
const BASE = new Date("2026-07-31T12:00:00Z").getTime();

function makeDelivery() {
  return {
    arm: vi.fn(),
    scheduleAlarm: vi.fn(),
    cancelAlarm: vi.fn(),
    fire: vi.fn(),
    setMuted: vi.fn(),
    onFire: vi.fn(() => () => {}),
  } satisfies AlarmDelivery;
}

const INPUT = (over: Partial<AddTimerInput> = {}): AddTimerInput => ({
  recipeId: "r1",
  recipeTitle: "Brown-butter cornbread",
  label: "Bake",
  seconds: 60,
  ...over,
});

// jsdom's default about:blank origin is opaque → no localStorage. Back it with a
// simple in-memory map for these tests.
function installMemoryLocalStorage() {
  const mem = new Map<string, string>();
  const ls: Storage = {
    get length() {
      return mem.size;
    },
    clear: () => mem.clear(),
    getItem: (k) => (mem.has(k) ? (mem.get(k) as string) : null),
    key: (i) => [...mem.keys()][i] ?? null,
    removeItem: (k) => void mem.delete(k),
    setItem: (k, v) => void mem.set(k, String(v)),
  };
  Object.defineProperty(window, "localStorage", { value: ls, configurable: true });
  Object.defineProperty(globalThis, "localStorage", { value: ls, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
  installMemoryLocalStorage();
  localStorage.clear();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("timer lifecycle", () => {
  it("adds a running timer with wall-clock remaining from endsAt", () => {
    const store = createTimerStore(makeDelivery());
    const id = store.add(INPUT({ seconds: 90 }));
    const timer = store.getSnapshot().timers[0];
    expect(timer.id).toBe(id);
    expect(timer.status).toBe("running");
    expect(timer.endsAt).toBe(BASE + 90_000);
    expect(remainingMs(timer, BASE + 30_000)).toBe(60_000);
  });

  it("arms delivery on add (audio unlock / notification gesture)", () => {
    const delivery = makeDelivery();
    const store = createTimerStore(delivery);
    store.add(INPUT());
    expect(delivery.arm).toHaveBeenCalledTimes(1);
    expect(delivery.scheduleAlarm).toHaveBeenCalledTimes(1);
  });

  it("expires to alarming and fires the alarm exactly once", () => {
    const delivery = makeDelivery();
    const store = createTimerStore(delivery);
    store.add(INPUT({ seconds: 1 }));
    vi.advanceTimersByTime(2000); // interval ticks past expiry
    const timer = store.getSnapshot().timers[0];
    expect(timer.status).toBe("alarming");
    expect(timer.firedAt).toBe(BASE + 1000);
    expect(delivery.fire).toHaveBeenCalledTimes(1);
    // Further ticks must not re-fire.
    vi.advanceTimersByTime(2000);
    expect(delivery.fire).toHaveBeenCalledTimes(1);
  });

  it("pauses and resumes preserving remaining", () => {
    const store = createTimerStore(makeDelivery());
    const id = store.add(INPUT({ seconds: 100 }));
    vi.setSystemTime(BASE + 40_000);
    store.pause(id);
    let timer = store.getSnapshot().timers[0];
    expect(timer.status).toBe("paused");
    expect(timer.pausedRemainingMs).toBe(60_000);
    expect(timer.endsAt).toBeUndefined();

    vi.setSystemTime(BASE + 100_000);
    store.resume(id);
    timer = store.getSnapshot().timers[0];
    expect(timer.status).toBe("running");
    expect(timer.endsAt).toBe(BASE + 100_000 + 60_000);
  });

  it("ack removes an alarming timer and stops its alarm", () => {
    const delivery = makeDelivery();
    const store = createTimerStore(delivery);
    const id = store.add(INPUT({ seconds: 1 }));
    vi.advanceTimersByTime(2000);
    expect(store.getSnapshot().timers[0].status).toBe("alarming");
    store.ack(id);
    expect(store.getSnapshot().timers).toHaveLength(0);
    expect(delivery.cancelAlarm).toHaveBeenCalledWith(id);
  });

  it("ack is a no-op on a still-running timer", () => {
    const store = createTimerStore(makeDelivery());
    const id = store.add(INPUT());
    store.ack(id);
    expect(store.getSnapshot().timers).toHaveLength(1);
  });

  it("dismiss removes a running timer", () => {
    const store = createTimerStore(makeDelivery());
    const id = store.add(INPUT());
    store.dismiss(id);
    expect(store.getSnapshot().timers).toHaveLength(0);
  });
});

describe("cap", () => {
  it("caps at 8, dropping the oldest running, prepending newest", () => {
    const store = createTimerStore(makeDelivery());
    const ids = Array.from({ length: 10 }, (_, i) => store.add(INPUT({ label: `T${i}` })));
    const timers = store.getSnapshot().timers;
    expect(timers).toHaveLength(8);
    expect(timers[0].label).toBe("T9"); // newest first
    expect(timers.map((t) => t.id)).not.toContain(ids[0]); // oldest dropped
  });

  it("never drops an alarming timer to make room", () => {
    const store = createTimerStore(makeDelivery());
    const first = store.add(INPUT({ seconds: 1 }));
    vi.advanceTimersByTime(2000); // first → alarming
    for (let i = 0; i < 12; i++) store.add(INPUT({ seconds: 600 }));
    const timers = store.getSnapshot().timers;
    expect(timers).toHaveLength(8);
    expect(timers.some((t) => t.id === first && t.status === "alarming")).toBe(true);
  });
});

describe("fire-on-return", () => {
  it("fires a timer that expired while the page was hidden, on refocus", () => {
    const delivery = makeDelivery();
    const store = createTimerStore(delivery);
    store.hydrate(); // attaches visibility/focus listeners
    store.add(INPUT({ seconds: 60 }));
    // Simulate a frozen background tab: jump the clock WITHOUT running the interval.
    vi.setSystemTime(BASE + 120_000);
    expect(delivery.fire).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("focus"));
    expect(store.getSnapshot().timers[0].status).toBe("alarming");
    expect(delivery.fire).toHaveBeenCalledTimes(1);
    store._reset();
  });
});

describe("persistence", () => {
  it("round-trips timers through localStorage", () => {
    const a = createTimerStore(makeDelivery());
    a.add(INPUT({ seconds: 600, label: "Simmer" }));
    vi.advanceTimersByTime(300); // flush debounced save

    const b = createTimerStore(makeDelivery());
    b.hydrate();
    const timers = b.getSnapshot().timers;
    expect(timers).toHaveLength(1);
    expect(timers[0].label).toBe("Simmer");
    expect(timers[0].status).toBe("running");
    b._reset();
  });

  it("discards a payload whose version does not match", () => {
    localStorage.setItem(KEY, JSON.stringify({ version: TIMER_STATE_VERSION + 99, timers: [{ id: "x", status: "running", endsAt: BASE + 999_999 }] }));
    const store = createTimerStore(makeDelivery());
    store.hydrate();
    expect(store.getSnapshot().timers).toHaveLength(0);
    store._reset();
  });

  it("drops timers older than the 6h TTL", () => {
    const stale: Timer = { id: "old", recipeId: "r", recipeTitle: "R", label: "Bake", totalMs: 1000, status: "alarming", firedAt: BASE - 7 * 60 * 60 * 1000 };
    localStorage.setItem(KEY, JSON.stringify({ version: TIMER_STATE_VERSION, timers: [stale] }));
    const store = createTimerStore(makeDelivery());
    store.hydrate();
    expect(store.getSnapshot().timers).toHaveLength(0);
    store._reset();
  });

  it("restores a timer that expired while away as alarming", () => {
    const expired: Timer = { id: "e", recipeId: "r", recipeTitle: "R", label: "Bake", totalMs: 60_000, status: "running", endsAt: BASE - 60_000 };
    localStorage.setItem(KEY, JSON.stringify({ version: TIMER_STATE_VERSION, timers: [expired] }));
    const store = createTimerStore(makeDelivery());
    store.hydrate();
    const timer = store.getSnapshot().timers[0];
    expect(timer.status).toBe("alarming");
    expect(timer.firedAt).toBe(BASE - 60_000);
    store._reset();
  });

  it("restores a still-running timer with correct remaining", () => {
    const running: Timer = { id: "run", recipeId: "r", recipeTitle: "R", label: "Bake", totalMs: 600_000, status: "running", endsAt: BASE + 300_000 };
    localStorage.setItem(KEY, JSON.stringify({ version: TIMER_STATE_VERSION, timers: [running] }));
    const store = createTimerStore(makeDelivery());
    store.hydrate();
    const timer = store.getSnapshot().timers[0];
    expect(timer.status).toBe("running");
    expect(remainingMs(timer, BASE)).toBe(300_000);
    store._reset();
  });
});
