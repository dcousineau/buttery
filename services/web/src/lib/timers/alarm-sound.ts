/**
 * The alarm sound module (plan §4.1 / §7.1). Dynamically imported by
 * `ForegroundAlarmDelivery` on the **first timer's** gesture, so neither this
 * module nor the audio asset is fetched on page load — a user who never starts a
 * timer never pays for it.
 *
 * The asset is a static public file referenced by URL (never bundled) via the
 * single swappable {@link DEFAULT_ALARM_URL} constant. Looped until the timer is
 * acked/paused. A muted play during the timer-start gesture unlocks iOS autoplay
 * so a later-firing timer sounds without a fresh gesture.
 */

/** Swap the default alarm by pointing this at a different `/sounds/*` file. */
export const DEFAULT_ALARM_URL = "/sounds/alarm-default.mp3";

let el: HTMLAudioElement | null = null;
let unlocked = false;
let muted = false;

function element(): HTMLAudioElement {
  if (!el) {
    el = new Audio(DEFAULT_ALARM_URL);
    el.loop = true;
    el.preload = "auto";
  }
  return el;
}

/**
 * Unlock playback inside a user gesture (iOS). Plays the element muted once so a
 * later programmatic `play()` (a timer firing) is allowed without a fresh tap.
 * Idempotent.
 */
export async function unlock(): Promise<void> {
  if (unlocked) return;
  const audio = element();
  const wasMuted = audio.muted;
  try {
    audio.muted = true;
    await audio.play();
    audio.pause();
    audio.currentTime = 0;
    unlocked = true;
  } catch {
    /* gesture too indirect / blocked — fire-on-return + banner still cover it */
  } finally {
    audio.muted = wasMuted || muted;
  }
}

/** Start (or restart) the looping alarm, unless muted. */
export async function play(): Promise<void> {
  const audio = element();
  audio.muted = muted;
  audio.currentTime = 0;
  try {
    await audio.play();
  } catch {
    /* autoplay blocked — visual alarm still shows */
  }
}

/** Stop the alarm and rewind. */
export function stop(): void {
  if (!el) return;
  el.pause();
  el.currentTime = 0;
}

/** Mute/unmute the currently-playing (and future) alarm; visual alarm is unaffected. */
export function setMuted(next: boolean): void {
  muted = next;
  if (el) el.muted = next;
}
