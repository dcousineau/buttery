import { useEffect, useSyncExternalStore } from "react";
import type { Message, PostHog, SendMessageResponse, UserProvidedTraits } from "posthog-js";
import { useAnalytics } from "./analytics";

/**
 * "Submit a bug" — Buttery's one support channel, opened from the account
 * menu.
 *
 * The channel is PostHog Support (its SDK namespace is `conversations`). PostHog
 * ships a drop-in widget for this, and Buttery does not use it: it is a fixed
 * bubble in the bottom-right corner of every page, colliding with cook mode's
 * controls, the timer tray and the install prompt, and it is styled as PostHog
 * rather than as Buttery. So this module drives the JSON API underneath it —
 * `sendMessage` / `getMessages` / `markAsRead` — and `components/SupportDialog`
 * renders the conversation with the app's own primitives.
 *
 * That is the arrangement PostHog documents for exactly this case ("build a
 * custom chat UI while disabling the default widget", Support JavaScript API).
 * Two consequences worth knowing:
 *
 *   - **The widget's domain allowlist does not apply.** It gates rendering, not
 *     the API, so support works on localhost and preview deploys as well as on
 *     buttery.recipes — which is also the only reason any of this is testable
 *     outside production.
 *   - **The bundle loads on Support being enabled, not on the widget being
 *     enabled.** Turning the in-app widget off in PostHog's settings leaves
 *     everything here working and stops anything from auto-mounting.
 *
 * Production-only, like the rest of analytics: outside production
 * `posthog.conversations` is permanently undefined, {@link useSupport} reports
 * `available: false`, and the menu item is not rendered (see `./analytics`).
 */

/** The slice of posthog-js's conversations API this module drives. */
export type SupportConversations = Pick<
  NonNullable<PostHog["conversations"]>,
  "isAvailable" | "getUnavailableReason" | "hide" | "sendMessage" | "getMessages" | "markAsRead" | "getCurrentTicketId"
>;

/**
 * Reasons support is not available *yet* rather than not at all. Everything
 * else — disabled in the project, remote config rejected, bundle blocked by a
 * content blocker — is terminal, and hides the menu item rather than offering a
 * channel that cannot send.
 */
const TRANSIENT_UNAVAILABLE = new Set<string>(["remote_config_pending", "initializing", "not_loaded"]);

/** How long the lazily-loaded bundle gets before support is called unavailable. */
const AVAILABILITY_TIMEOUT_MS = 20_000;
const POLL_MS = 250;

export type SupportStatus = "pending" | "ready" | "unavailable";

export type SupportSnapshot = {
  status: SupportStatus;
  /** Whether the support dialog is open. Lives here because the account menu
   * that opens it is unmounted by Base UI the instant the item is clicked. */
  open: boolean;
  /** Replies from the team that this browser has not seen yet. */
  unread: number;
};

const INITIAL: SupportSnapshot = Object.freeze({ status: "pending", open: false, unread: 0 });

let snapshot: SupportSnapshot = INITIAL;
let conversations: SupportConversations | null = null;
let attached = false;
let waitTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function update(patch: Partial<SupportSnapshot>) {
  const next = { ...snapshot, ...patch };
  if (next.status === snapshot.status && next.open === snapshot.open && next.unread === snapshot.unread) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function stopWaiting() {
  if (waitTimer) clearInterval(waitTimer);
  waitTimer = null;
}

/**
 * Attaches to the live client and waits for the conversations bundle to land.
 *
 * The wait is bounded and it ends in an answer either way: `ready` once the API
 * reports itself available, `unavailable` on a terminal reason or on running out
 * of patience. There is no third state where the menu item offers a channel that
 * cannot send.
 */
export function attachSupport(api: SupportConversations | null) {
  if (attached) return;
  attached = true;
  if (!api) {
    // No live client (every environment but production).
    update({ status: "unavailable" });
    return;
  }
  conversations = api;

  const started = Date.now();
  const tick = () => {
    if (api.isAvailable()) {
      stopWaiting();
      // Belt and braces for the "Enable widget" project setting: with it off
      // nothing mounts and this is a no-op, and with it on this is what takes
      // the floating bubble back off the page. Unmounting the widget does not
      // touch the API the dialog talks to.
      api.hide();
      update({ status: "ready" });
      void refreshUnread();
      return;
    }
    const reason = api.getUnavailableReason();
    const waiting = (!reason || TRANSIENT_UNAVAILABLE.has(reason)) && Date.now() - started < AVAILABILITY_TIMEOUT_MS;
    if (waiting) return;
    stopWaiting();
    update({ status: "unavailable" });
  };

  tick();
  if (snapshot.status === "pending") waitTimer = setInterval(tick, POLL_MS);
}

/**
 * How many replies are waiting, for the badge on the menu item.
 *
 * Costs nothing for the overwhelming majority who have never opened support:
 * with no ticket on this browser there is nothing to fetch, and
 * `getCurrentTicketId()` answers that from local state without a request. A
 * failure leaves the count at zero — the badge is a courtesy, not the channel.
 */
async function refreshUnread() {
  if (!conversations?.getCurrentTicketId()) return;
  try {
    const response = await conversations.getMessages();
    update({ unread: response?.unread_count ?? 0 });
  } catch {
    /* ignored: see above */
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The store's current value — the `getSnapshot` half of the pair below. */
export function getSupportSnapshot(): SupportSnapshot {
  return snapshot;
}

/** Open the support dialog. A module function, so its identity is stable. */
export function openSupport() {
  update({ open: true, unread: 0 });
}

/** Close it — e.g. cook mode taking the screen. */
export function closeSupport() {
  update({ open: false });
}

/**
 * Whether support can be talked to *right now*, read live rather than from the
 * store.
 *
 * The two differ: `posthog.reset()` tears the conversations manager down and
 * posthog-js never rebuilds it (remote config is not re-fetched), so a page that
 * was `ready` a moment ago can be dead by the time someone opens the dialog. The
 * dialog checks this on open and says so, instead of failing silently.
 */
export function isSupportReady(): boolean {
  return conversations?.isAvailable() ?? false;
}

/** Every message on this browser's ticket, oldest first. Empty when there is no ticket yet. */
export async function loadSupportThread(): Promise<Message[]> {
  if (!conversations?.getCurrentTicketId()) return [];
  const response = await conversations.getMessages();
  return response?.messages ?? [];
}

/**
 * Send one message, starting a ticket if this browser has none.
 *
 * `name` and `email` ride along from the person properties PostHog already
 * holds when they are not passed — Buttery sets `name` at identify time and has
 * no email to give.
 *
 * Rejects when the API is not available or the request fails, which is the
 * whole reason the dialog can report a failure at all.
 */
export async function sendSupportMessage(body: string, traits?: UserProvidedTraits): Promise<SendMessageResponse> {
  if (!conversations) throw new Error("Support is not loaded.");
  // Resolves to null instead of throwing when the API is not available.
  const response = await conversations.sendMessage(body, traits);
  if (!response) throw new Error("Support is not loaded.");
  return response;
}

/** Clear the unread count on the server once the thread has been looked at. */
export async function markSupportRead(): Promise<void> {
  if (!conversations?.getCurrentTicketId()) return;
  try {
    await conversations.markAsRead();
  } catch {
    /* ignored: an unread count that stays stale is not worth an error state */
  }
}

export type Support = {
  /** Whether support can be offered at all. False everywhere but production,
   * and in production until the bundle has loaded. */
  available: boolean;
  /** Replies waiting on this browser's ticket. */
  unread: number;
  /** Whether the support dialog is open. */
  isOpen: boolean;
  open: () => void;
  close: () => void;
};

/**
 * The app's handle on support. `UserMenu` renders and opens the item from it;
 * the root mounts `SupportDialog` from it; cook mode closes it.
 */
export function useSupport(): Support {
  const { posthog, enabled } = useAnalytics();

  // In an effect rather than in render: attaching reaches into the live client
  // and schedules timers, neither of which belongs in an SSR pass.
  useEffect(() => {
    attachSupport(enabled ? (posthog.conversations ?? null) : null);
  }, [enabled, posthog]);

  const state = useSyncExternalStore(subscribe, getSupportSnapshot, () => INITIAL);

  return { available: state.status === "ready", unread: state.unread, isOpen: state.open, open: openSupport, close: closeSupport };
}

/** Test seam: drops every module-level singleton so each test starts clean. */
export function resetSupportForTests() {
  stopWaiting();
  conversations = null;
  attached = false;
  snapshot = INITIAL;
  listeners.clear();
}
