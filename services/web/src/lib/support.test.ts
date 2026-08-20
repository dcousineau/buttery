// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupportController, SUPPORT_CONTAINER_ID, SUPPORT_LAUNCHER_SELECTOR, type SupportConversations, type SupportController } from "./support";

/**
 * The controller behind "Help & support": it keeps PostHog's Conversations
 * widget off the page until someone asks for it, opens the chat panel, and
 * takes the widget back off the page when they close it.
 *
 * The fake below stands in for the widget as posthog-js renders it — a
 * container appended to `<body>` holding EITHER the launcher bubble (closed) or
 * the chat panel (open) — because the only contract the controller has with the
 * real thing is that DOM shape plus `show`/`hide`/`isAvailable`.
 */
class FakeWidget implements SupportConversations {
  /** Whether the lazily-loaded conversations bundle has landed. */
  loaded = true;
  /** Persisted across mounts by PostHog, so it survives `hide()` here too. */
  state: "open" | "closed" = "closed";
  showCalls = 0;
  hideCalls = 0;
  private container: HTMLElement | null = null;

  show() {
    this.showCalls++;
    if (!this.loaded) return; // real one logs "Conversations not loaded yet"
    if (!this.container) {
      this.container = document.createElement("div");
      this.container.id = SUPPORT_CONTAINER_ID;
      document.body.appendChild(this.container);
    }
    this.render();
  }

  hide() {
    this.hideCalls++;
    this.container?.remove();
    this.container = null;
  }

  isAvailable() {
    return this.loaded;
  }

  getUnavailableReason() {
    return this.loaded ? null : ("not_loaded" as const);
  }

  /** Mounted, whatever it is showing. */
  get isMounted() {
    return document.getElementById(SUPPORT_CONTAINER_ID) !== null;
  }

  private render() {
    if (!this.container) return;
    this.container.replaceChildren();
    const button = document.createElement("button");
    if (this.state === "closed") {
      button.setAttribute("aria-label", "Open chat");
      button.addEventListener("click", () => {
        this.state = "open";
        this.render();
      });
      this.container.appendChild(button);
      return;
    }
    const panel = document.createElement("div");
    panel.setAttribute("data-testid", "panel");
    button.setAttribute("aria-label", "Close");
    button.addEventListener("click", () => {
      this.state = "closed";
      this.render();
    });
    panel.appendChild(button);
    this.container.appendChild(panel);
  }
}

const launcher = () => document.querySelector<HTMLElement>(`#${SUPPORT_CONTAINER_ID} ${SUPPORT_LAUNCHER_SELECTOR}`);
const panel = () => document.querySelector(`#${SUPPORT_CONTAINER_ID} [data-testid="panel"]`);
/** MutationObserver callbacks are microtasks — let them run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let controller: SupportController | null = null;

function makeController(widget: FakeWidget): SupportController {
  controller = createSupportController(widget);
  return controller;
}

afterEach(() => {
  controller?.dispose();
  controller = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("support controller", () => {
  it("unmounts the widget PostHog mounts by itself", async () => {
    const widget = new FakeWidget();
    makeController(widget);

    widget.show(); // what the conversations bundle does on load
    expect(widget.isMounted).toBe(true);
    await settle();

    // The whole point of the change: no floating bubble on any page.
    expect(widget.isMounted).toBe(false);
    expect(widget.hideCalls).toBe(1);
  });

  it("unmounts a widget that was already on the page when it started", () => {
    const widget = new FakeWidget();
    widget.show();

    makeController(widget);

    expect(widget.isMounted).toBe(false);
  });

  it("opens the chat panel, and keeps it mounted", async () => {
    const widget = new FakeWidget();
    const support = makeController(widget);

    support.open();

    expect(panel()).not.toBeNull();
    expect(launcher()).toBeNull();
    // The auto-mount watcher must not pull the widget out from under the user.
    await settle();
    expect(widget.isMounted).toBe(true);
  });

  it("leaves an already-open panel alone", () => {
    const widget = new FakeWidget();
    widget.state = "open"; // PostHog restored it from a previous visit
    const support = makeController(widget);

    support.open();

    expect(panel()).not.toBeNull();
  });

  it("waits for the conversations bundle before opening", async () => {
    vi.useFakeTimers();
    const widget = new FakeWidget();
    widget.loaded = false;
    const support = makeController(widget);

    support.open();
    expect(widget.isMounted).toBe(false);

    widget.loaded = true;
    await vi.advanceTimersByTimeAsync(300);

    expect(panel()).not.toBeNull();
  });

  it("gives up waiting rather than polling forever", async () => {
    vi.useFakeTimers();
    const widget = new FakeWidget();
    widget.loaded = false;
    const support = makeController(widget);

    support.open();
    await vi.advanceTimersByTimeAsync(6_000);
    const attempts = widget.showCalls;

    widget.loaded = true;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(widget.showCalls).toBe(attempts);
    expect(widget.isMounted).toBe(false);
  });

  it("unmounts the widget again when the user closes the panel", async () => {
    const widget = new FakeWidget();
    const support = makeController(widget);
    support.open();

    document.querySelector<HTMLElement>('[aria-label="Close"]')?.click();
    await settle();

    // Closed leaves the launcher behind, which is what we are here to prevent.
    expect(widget.isMounted).toBe(false);
  });

  it("reopens after a close", async () => {
    const widget = new FakeWidget();
    const support = makeController(widget);

    support.open();
    document.querySelector<HTMLElement>('[aria-label="Close"]')?.click();
    await settle();
    support.open();

    expect(panel()).not.toBeNull();
  });

  it("closes on request, e.g. when cook mode takes the screen", async () => {
    const widget = new FakeWidget();
    const support = makeController(widget);
    support.open();

    support.close();

    expect(widget.isMounted).toBe(false);
    // And a widget that reappears afterwards is suppressed again, not adopted.
    widget.show();
    await settle();
    expect(widget.isMounted).toBe(false);
  });
});
