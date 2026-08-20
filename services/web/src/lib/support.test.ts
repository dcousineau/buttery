import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "posthog-js";
import {
  attachSupport,
  closeSupport,
  isSupportReady,
  loadSupportThread,
  getSupportSnapshot as snapshot,
  markSupportRead,
  openSupport,
  resetSupportForTests,
  sendSupportMessage,
  type SupportConversations,
} from "./support";

/**
 * The store behind "Help & support": it decides whether the account menu offers
 * support at all, holds whether the dialog is open, counts unseen replies, and
 * is the only thing in the app that talks to PostHog's conversations API.
 *
 * The fake below is that API's contract and nothing else — no DOM, because the
 * rewrite onto `sendMessage`/`getMessages` left the widget (and its container,
 * its launcher and its domain allowlist) out of the picture entirely.
 */
class FakeConversations implements SupportConversations {
  /** Whether the lazily-loaded conversations bundle has landed. */
  loaded = true;
  reason: ReturnType<SupportConversations["getUnavailableReason"]> = "not_loaded";
  ticketId: string | null = null;
  messages: Message[] = [];
  unread = 0;
  hideCalls = 0;
  readCalls = 0;
  sent: string[] = [];
  /** Set to make the next request reject, like a 500 or a dropped connection. */
  failRequests = false;

  isAvailable() {
    return this.loaded;
  }

  getUnavailableReason() {
    return this.loaded ? null : this.reason;
  }

  hide() {
    this.hideCalls++;
  }

  getCurrentTicketId() {
    return this.ticketId;
  }

  sendMessage(message: string) {
    if (!this.loaded) return Promise.resolve(null); // what the real one does when unavailable
    if (this.failRequests) return Promise.reject(new Error("network"));
    this.sent.push(message);
    this.ticketId ??= "ticket-1";
    this.messages.push(message_(message, "customer"));
    return Promise.resolve({ ticket_id: this.ticketId, message_id: `m${this.messages.length}`, ticket_status: "open" as const, created_at: NOW, unread_count: 0 });
  }

  getMessages() {
    if (this.failRequests) return Promise.reject(new Error("network"));
    return Promise.resolve({ ticket_id: this.ticketId ?? "", ticket_status: "open" as const, messages: this.messages, has_more: false, unread_count: this.unread });
  }

  markAsRead() {
    if (this.failRequests) return Promise.reject(new Error("network"));
    this.readCalls++;
    this.unread = 0;
    return Promise.resolve({ success: true, ticket_id: this.ticketId ?? "", unread_count: 0 });
  }
}

const NOW = "2026-08-20T12:00:00.000Z";
const message_ = (content: string, author_type: Message["author_type"]): Message => ({
  id: `m-${content}`,
  content,
  author_type,
  created_at: NOW,
  is_private: false,
});

let api: FakeConversations;

beforeEach(() => {
  resetSupportForTests();
  api = new FakeConversations();
});

afterEach(() => {
  resetSupportForTests();
  vi.useRealTimers();
});

describe("availability", () => {
  it("is ready once the conversations bundle has loaded", () => {
    attachSupport(api);
    expect(isSupportReady()).toBe(true);
  });

  it("takes PostHog's own widget off the page, in case the project still has it enabled", () => {
    attachSupport(api);
    // The dialog is the only support UI; a floating bubble beside it is the bug
    // the account-menu item exists to fix.
    expect(api.hideCalls).toBe(1);
  });

  it("waits for a bundle that has not landed yet, then reports ready", async () => {
    vi.useFakeTimers();
    api.loaded = false;
    attachSupport(api);
    expect(isSupportReady()).toBe(false);

    api.loaded = true;
    await vi.advanceTimersByTimeAsync(300);

    expect(isSupportReady()).toBe(true);
    expect(api.hideCalls).toBe(1);
  });

  it("gives up on a bundle that never lands rather than polling forever", async () => {
    vi.useFakeTimers();
    api.loaded = false;
    attachSupport(api);

    await vi.advanceTimersByTimeAsync(21_000);
    api.loaded = true;
    await vi.advanceTimersByTimeAsync(5_000);

    // Live-checked at open time, so this stays true — but the store has stopped
    // waiting, which is what the menu item reads.
    expect(api.hideCalls).toBe(0);
  });

  it("stops immediately on a reason that will never resolve itself", async () => {
    vi.useFakeTimers();
    api.loaded = false;
    api.reason = "disabled_in_project";
    attachSupport(api);

    await vi.advanceTimersByTimeAsync(1_000);
    api.loaded = true;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(api.hideCalls).toBe(0);
  });

  it("reports unavailable with no live client at all — every environment but production", () => {
    attachSupport(null);
    expect(isSupportReady()).toBe(false);
  });

  it("answers the live client, not a cached verdict — posthog.reset() kills conversations mid-page", () => {
    attachSupport(api);
    expect(isSupportReady()).toBe(true);

    api.loaded = false; // what `posthog.reset()` leaves behind

    expect(isSupportReady()).toBe(false);
  });
});

describe("the thread", () => {
  it("does not go to the network for someone who has never opened support", async () => {
    attachSupport(api);
    const spy = vi.spyOn(api, "getMessages");

    expect(await loadSupportThread()).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("fetches the conversation once there is a ticket", async () => {
    api.ticketId = "ticket-1";
    api.messages = [message_("my oven exploded", "customer"), message_("that is not ideal", "human")];
    attachSupport(api);

    expect((await loadSupportThread()).map((m) => m.content)).toEqual(["my oven exploded", "that is not ideal"]);
  });

  it("marks a read thread as read, and stays quiet when there is nothing to mark", async () => {
    attachSupport(api);
    await markSupportRead();
    expect(api.readCalls).toBe(0);

    api.ticketId = "ticket-1";
    await markSupportRead();
    expect(api.readCalls).toBe(1);
  });

  it("swallows a failed markAsRead — a stale count is not worth an error", async () => {
    api.ticketId = "ticket-1";
    api.failRequests = true;
    attachSupport(api);

    await expect(markSupportRead()).resolves.toBeUndefined();
  });
});

describe("sending", () => {
  it("sends the message", async () => {
    attachSupport(api);

    const response = await sendSupportMessage("the timer keeps resetting");

    expect(api.sent).toEqual(["the timer keeps resetting"]);
    expect(response.ticket_id).toBe("ticket-1");
  });

  it("rejects when the request fails, so the dialog can say so", async () => {
    attachSupport(api);
    api.failRequests = true;

    await expect(sendSupportMessage("hello")).rejects.toThrow();
  });

  it("rejects rather than resolving with null when support is not loaded", async () => {
    api.loaded = false;
    attachSupport(api);

    // The real API resolves `null` here. Silently succeeding is how the previous
    // version lost messages; this is the whole point of the wrapper.
    await expect(sendSupportMessage("hello")).rejects.toThrow(/not loaded/i);
  });

  it("rejects when there is no live client", async () => {
    attachSupport(null);
    await expect(sendSupportMessage("hello")).rejects.toThrow(/not loaded/i);
  });
});

describe("the dialog's open state", () => {
  it("opens and closes", () => {
    attachSupport(api);

    openSupport();
    expect(snapshot().open).toBe(true);

    closeSupport();
    expect(snapshot().open).toBe(false);
  });

  it("clears the unread badge on open — the thread is about to be read", async () => {
    api.ticketId = "ticket-1";
    api.unread = 3;
    attachSupport(api);
    await vi.waitFor(() => expect(snapshot().unread).toBe(3));

    openSupport();

    expect(snapshot().unread).toBe(0);
  });
});

describe("the unread count", () => {
  it("is fetched for a browser that has a ticket", async () => {
    api.ticketId = "ticket-1";
    api.unread = 2;
    attachSupport(api);

    await vi.waitFor(() => expect(snapshot().unread).toBe(2));
  });

  it("costs nothing for a browser that does not", async () => {
    const spy = vi.spyOn(api, "getMessages");
    attachSupport(api);

    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();
    expect(snapshot().unread).toBe(0);
  });

  it("stays at zero when the fetch fails", async () => {
    api.ticketId = "ticket-1";
    api.failRequests = true;
    attachSupport(api);

    await Promise.resolve();
    expect(snapshot().unread).toBe(0);
  });
});
