/**
 * Alarm delivery (plan §7.4). The mechanism that turns an expired timer into a
 * sound / notification is isolated behind {@link AlarmDelivery} so the store and
 * UI never call audio or `Notification` directly.
 *
 * ┌─ PWA SEAM ──────────────────────────────────────────────────────────────┐
 * │ This project injects `ForegroundAlarmDelivery` (audio + a Notification    │
 * │ when granted, backed by the cook-mode wake lock so the page stays         │
 * │ foreground). A future PWA project adds `ServiceWorkerPushDelivery` — a    │
 * │ service worker + Web Push where the server schedules a push at the        │
 * │ timer's absolute `endsAt` — and swaps it in behind THIS SAME interface,   │
 * │ with THE SAME timer model (which already stores absolute `endsAt`, exactly │
 * │ what a scheduled push needs). Do not add SW / push infra here (§1.2).      │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
import type { Timer } from "./store";

export interface AlarmDelivery {
  /**
   * Called inside the timer-start user gesture: unlock audio autoplay and (once)
   * request notification permission. Safe to call repeatedly.
   */
  arm(): void;
  /** A timer began/resumed. Foreground delivery no-ops; a push delivery would
   * register a scheduled push at `timer.endsAt`. */
  scheduleAlarm(timer: Timer): void;
  /** A timer was acked/paused/dismissed — stop its alarm / deschedule its push. */
  cancelAlarm(id: string): void;
  /** The store detected (in the foreground) that a timer expired — sound it now. */
  fire(timer: Timer): void;
  /** Mute/unmute the audible alarm (visual alarm is unaffected). */
  setMuted(muted: boolean): void;
  /** Subscribe to fire events (e.g. to announce politely); returns an unsubscribe. */
  onFire(cb: (timer: Timer) => void): () => void;
}

/**
 * Foreground delivery: lazily imports the sound module on the first `arm()`
 * gesture, loops the alarm while ≥1 timer is firing, posts a Web Notification
 * when the API exists + permission is granted + the page is hidden, and vibrates
 * where supported (Android; no-op iOS). Everything feature-detected — on an iOS
 * Safari tab it degrades to the visual/banner alarm silently (§7.2).
 */
export class ForegroundAlarmDelivery implements AlarmDelivery {
  private soundPromise: Promise<typeof import("./alarm-sound")> | null = null;
  private firing = new Set<string>();
  private muted = false;
  private notificationRequested = false;
  private listeners = new Set<(timer: Timer) => void>();

  private sound() {
    // Lazy: the sound module + audio asset load only once a first timer exists.
    this.soundPromise ??= import("./alarm-sound");
    return this.soundPromise;
  }

  arm(): void {
    void this.sound().then((m) => m.unlock());
    this.requestNotificationPermission();
  }

  private requestNotificationPermission(): void {
    if (this.notificationRequested) return;
    this.notificationRequested = true;
    // iOS Safari tabs have no Notification constructor — feature-detect.
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") {
      void Notification.requestPermission().catch(() => {});
    }
  }

  scheduleAlarm(_timer: Timer): void {
    // No-op for foreground delivery: the store's wall-clock tick drives firing.
    // PWA seam: a ServiceWorkerPushDelivery registers a push at _timer.endsAt here.
  }

  cancelAlarm(id: string): void {
    this.firing.delete(id);
    if (this.firing.size === 0) void this.sound().then((m) => m.stop());
  }

  fire(timer: Timer): void {
    this.firing.add(timer.id);
    void this.sound().then((m) => m.play());

    if (typeof Notification !== "undefined" && Notification.permission === "granted" && typeof document !== "undefined" && document.hidden) {
      try {
        const n = new Notification(`${timer.label} · done`, { body: timer.recipeTitle, tag: timer.id });
        n.onclick = () => {
          window.focus();
          n.close();
        };
      } catch {
        /* construction can throw on some engines — ignore */
      }
    }

    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate([200, 100, 200]);
    }

    for (const cb of this.listeners) cb(timer);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    void this.sound().then((m) => m.setMuted(muted));
  }

  isMuted(): boolean {
    return this.muted;
  }

  onFire(cb: (timer: Timer) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
