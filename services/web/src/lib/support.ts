import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { PostHog } from "posthog-js";
import { useAnalytics } from "./analytics";

/**
 * "Help & support" — Buttery's one support channel, driven from the account
 * menu instead of a floating bubble.
 *
 * The channel is PostHog Conversations. Its widget wants to live as a fixed
 * button in the bottom-right corner of every page, which collides with the
 * cook-mode controls, the timer tray, and the install prompt, and which is a
 * permanent visual tax for a thing people need twice a year. So this module
 * keeps the widget UNMOUNTED and hands `UserMenu` a menu item that mounts and
 * opens it on demand.
 *
 * Production-only, like the rest of analytics: outside production
 * `posthog.conversations` is permanently undefined, {@link useSupport} reports
 * `available: false`, and the menu item is not rendered (see `./analytics`).
 *
 * ## Why this pokes at the DOM
 *
 * posthog-js exposes `show()` (mount the widget, restoring its saved
 * open/closed state) and `hide()` (unmount it) — and nothing that opens the
 * chat panel. The panel is opened by the user clicking the launcher bubble,
 * whose handler is private to the widget's Preact tree. So "open the panel"
 * here means: mount the widget, then click the launcher we never wanted to
 * show. The two selectors below are the whole surface of that coupling.
 *
 * They are also how we read the widget's state: it renders EITHER the launcher
 * OR the panel, so "is the launcher in the DOM" is "is the panel closed"
 * (`isVisible()` only answers whether the widget is mounted at all).
 *
 * If PostHog renames either selector the failure is soft and visible: the
 * launcher stops being suppressed and the app is back to today's floating
 * bubble, which still opens support when clicked.
 */

/** The element the Conversations bundle appends to `<body>` when it mounts. */
export const SUPPORT_CONTAINER_ID = "ph-conversations-widget-container";

/**
 * The closed-state launcher bubble. Prefix match because the label carries an
 * unread count when an agent has replied (`Open chat (2 unread)`).
 */
export const SUPPORT_LAUNCHER_SELECTOR = 'button[aria-label^="Open chat"]';

/** The slice of posthog-js's conversations API this module drives. */
export type SupportConversations = Pick<NonNullable<PostHog["conversations"]>, "show" | "hide" | "isAvailable" | "getUnavailableReason">;

/**
 * Reasons the widget is not available *yet* rather than not at all. Everything
 * else — disabled in the project, remote config rejected, bundle blocked by a
 * content blocker — is terminal, and hides the menu item rather than offering a
 * support channel that cannot open.
 */
const TRANSIENT_UNAVAILABLE = new Set<string>(["remote_config_pending", "initializing", "not_loaded"]);

/** How long to wait for the widget to mount after `show()` before giving up. */
const OPEN_TIMEOUT_MS = 5_000;
/** How long the bundle gets to load before support is called unavailable. */
const AVAILABILITY_TIMEOUT_MS = 20_000;
const POLL_MS = 250;

export type SupportAvailability = "pending" | "ready" | "unavailable";

/**
 * Mounts, opens, and unmounts the Conversations widget.
 *
 * A plain object rather than component state: the menu item that calls `open()`
 * lives inside the account menu's popup, which Base UI unmounts the instant the
 * item is clicked. Anything watching for the panel to close has to outlive it.
 *
 * Exported for its tests; the app gets one via {@link useSupport}.
 */
export function createSupportController(conversations: SupportConversations, doc: Document = document) {
  /** Whether the widget is mounted because someone asked for support. While
   * false, any widget that appears is one PostHog auto-mounted on load. */
  let requested = false;
  let openTimer: ReturnType<typeof setInterval> | null = null;
  let openDeadline: ReturnType<typeof setTimeout> | null = null;
  let closeWatcher: MutationObserver | null = null;

  const container = (): HTMLElement | null => doc.getElementById(SUPPORT_CONTAINER_ID);
  const launcher = (): HTMLElement | null => container()?.querySelector<HTMLElement>(SUPPORT_LAUNCHER_SELECTOR) ?? null;

  function stopOpening() {
    if (openTimer) clearInterval(openTimer);
    if (openDeadline) clearTimeout(openDeadline);
    openTimer = null;
    openDeadline = null;
  }

  /**
   * The widget mounts itself on load whenever the project has it enabled, and
   * remounts on `reset()`. This is what takes it back off the page — the one
   * behaviour change this module exists for.
   */
  const autoMountWatcher = new MutationObserver(() => {
    if (requested || !container()) return;
    conversations.hide();
  });
  autoMountWatcher.observe(doc.body, { childList: true });
  if (container()) conversations.hide(); // already mounted before we got here

  /** Unmount once the user closes the panel, so the bubble does not linger. */
  function watchForClose() {
    const el = container();
    if (!el || closeWatcher) return;
    closeWatcher = new MutationObserver(() => {
      if (!launcher()) return; // still open (or gone entirely)
      close();
    });
    closeWatcher.observe(el, { childList: true, subtree: true });
  }

  function open() {
    requested = true;
    stopOpening();
    // Mounts the widget in whatever state it was last left in. No-op — with a
    // console warning — until the bundle has loaded, hence the retry below.
    conversations.show();

    const attempt = (): boolean => {
      // Re-issue `show()` while the widget is not mounted: the first one may
      // have landed before the bundle did, when it is only a console warning.
      if (!container() && conversations.isAvailable()) conversations.show();
      if (!container()) return false;
      // Launcher present ⇒ the panel is closed ⇒ this is the click the user
      // came for. Absent ⇒ it restored itself open, nothing to click.
      launcher()?.click();
      watchForClose();
      return true;
    };

    if (attempt()) return;
    openTimer = setInterval(() => {
      if (attempt()) stopOpening();
    }, POLL_MS);
    openDeadline = setTimeout(stopOpening, OPEN_TIMEOUT_MS);
  }

  function close() {
    requested = false;
    stopOpening();
    closeWatcher?.disconnect();
    closeWatcher = null;
    conversations.hide();
  }

  function dispose() {
    stopOpening();
    closeWatcher?.disconnect();
    closeWatcher = null;
    autoMountWatcher.disconnect();
  }

  return { open, close, dispose };
}

export type SupportController = ReturnType<typeof createSupportController>;

/**
 * One controller per page, not per component. Both consumers — the root, which
 * mounts it so the auto-mounted widget is suppressed everywhere, and the
 * account menu, which opens it — share this instance.
 */
let controller: SupportController | null = null;
let availability: SupportAvailability = "pending";
let availabilityTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function setAvailability(next: SupportAvailability) {
  if (availability === next) return;
  availability = next;
  for (const listener of listeners) listener();
}

function start(posthog: PostHog) {
  const conversations = posthog.conversations;
  if (!conversations) {
    // No live client (every environment but production): nothing to mount, and
    // nothing for the menu to offer.
    setAvailability("unavailable");
    return;
  }
  if (controller) return;
  controller = createSupportController(conversations);

  const started = Date.now();
  const check = () => {
    if (conversations.isAvailable()) {
      setAvailability("ready");
    } else {
      const reason = conversations.getUnavailableReason();
      const waiting = (!reason || TRANSIENT_UNAVAILABLE.has(reason)) && Date.now() - started < AVAILABILITY_TIMEOUT_MS;
      if (waiting) return;
      setAvailability("unavailable");
    }
    if (availabilityTimer) clearInterval(availabilityTimer);
    availabilityTimer = null;
  };
  check();
  if (availability === "pending") availabilityTimer = setInterval(check, POLL_MS * 2);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type Support = {
  /** Whether a support conversation can actually be opened. False everywhere
   * but production, and in production until the bundle has loaded. */
  available: boolean;
  /** Mount and open the chat panel. */
  open: () => void;
  /** Close and unmount it — e.g. entering an immersive surface. */
  close: () => void;
};

/**
 * The app's handle on support. Mount it at the root to keep PostHog's
 * auto-mounted widget off the page; call it in the account menu to render and
 * drive the "Help & support" item.
 */
export function useSupport(): Support {
  const { posthog, enabled } = useAnalytics();

  // In an effect, not in render: `start` touches `document` and installs a
  // MutationObserver, neither of which exists during SSR.
  useEffect(() => {
    if (enabled) start(posthog);
  }, [enabled, posthog]);

  const state = useSyncExternalStore(
    subscribe,
    () => availability,
    () => "pending" as const,
  );

  const open = useCallback(() => controller?.open(), []);
  const close = useCallback(() => controller?.close(), []);

  return { available: state === "ready", open, close };
}
