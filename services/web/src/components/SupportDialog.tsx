import { useCallback, useEffect, useRef, useState } from "react";
import type { Message } from "posthog-js";
import { Button } from "#/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "#/components/ui/dialog";
import { Spinner } from "#/components/ui/spinner";
import { Textarea } from "#/components/ui/textarea";
import { isSupportReady, loadSupportThread, markSupportRead, sendSupportMessage, useSupport } from "#/lib/support";
import { cn } from "#/lib/utils";

/**
 * "Submit a bug" — the conversation with the team, in Buttery's own chrome.
 *
 * PostHog Support is the channel underneath (see `lib/support`); everything
 * visible here is the app's own primitives, because the alternative was
 * PostHog's floating bubble sitting on top of cook mode in PostHog's colours.
 *
 * **This is the only place a reply is ever seen.** Widget-channel tickets are
 * not emailed to the customer, so the copy points at the account menu rather
 * than at an inbox, and the menu item carries the unread count.
 *
 * Mounted at the root, not in the account menu: the menu's popup is unmounted
 * the instant the item is clicked, so it cannot host what it opens. Whether it
 * is open lives in the module store for the same reason.
 */
export function SupportDialog() {
  const { isOpen, close } = useSupport();
  // Unmounted while closed, so every open starts from a fresh fetch and an
  // empty composer without a single reset.
  if (!isOpen) return null;
  return <SupportConversation onClose={close} />;
}

/** How often to look for a reply while the dialog is open. */
const POLL_MS = 10_000;

function SupportConversation({ onClose }: { onClose: () => void }) {
  // Read live rather than from the store: `posthog.reset()` can tear the
  // conversations manager down between the menu rendering the item and this
  // opening, and a dialog that says so beats a Send button that does nothing.
  const [ready] = useState(isSupportReady);
  const [thread, setThread] = useState<Message[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    return loadSupportThread()
      .then((messages) => {
        setThread(messages);
        setLoadFailed(false);
      })
      .catch(() => setLoadFailed(true));
  }, []);

  useEffect(() => {
    if (!ready) return;
    void refresh().then(() => markSupportRead());
    // A reply arrives without any signal to the browser, so while the dialog is
    // open — and only while it is open — we ask. Closing it stops the polling.
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [ready, refresh]);

  // Follow the conversation as it grows, including after a send.
  useEffect(() => {
    if (!thread?.length) return;
    bottom.current?.scrollIntoView({ block: "end" });
  }, [thread]);

  const body = draft.trim();

  async function send() {
    if (!body || sending) return;
    setSending(true);
    setSendFailed(false);
    try {
      await sendSupportMessage(body);
      setDraft("");
      await refresh();
    } catch {
      // The draft is deliberately left in the box: it is the only copy.
      setSendFailed(true);
    } finally {
      setSending(false);
    }
  }

  // Enter breaks a line — people describe bugs in paragraphs. ⌘/Ctrl+Enter sends.
  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    void send();
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogTitle>Submit a bug</DialogTitle>

        {!ready ? (
          <>
            <DialogDescription>Support didn’t load on this page. Reload and try again — nothing you’ve sent before is lost.</DialogDescription>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" size="sm" />}>Close</DialogClose>
              <Button size="sm" onClick={() => window.location.reload()}>
                Reload the page
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogDescription>
              {thread && thread.length > 0
                ? "Replies land here. The account menu shows a count when one arrives."
                : "Tell us what’s going on and we’ll answer right here. Whatever page you were on comes along with the message."}
            </DialogDescription>

            <Thread thread={thread} loadFailed={loadFailed} bottom={bottom} />

            <Textarea
              autosize
              rows={2}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              disabled={sending}
              placeholder="What’s going on?"
              aria-label="Your message"
              className="max-h-40"
            />

            {sendFailed ? (
              <p role="alert" className="m-0 text-sm text-destructive">
                That didn’t send. Check your connection and try again — your message is still in the box.
              </p>
            ) : null}

            <DialogFooter>
              <DialogClose render={<Button variant="ghost" size="sm" />}>Close</DialogClose>
              <Button size="sm" disabled={!body || sending} onClick={() => void send()}>
                {sending ? "Sending…" : "Send"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Thread({ thread, loadFailed, bottom }: { thread: Message[] | null; loadFailed: boolean; bottom: React.RefObject<HTMLDivElement | null> }) {
  if (thread === null && !loadFailed) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Spinner />
        Fetching your conversation…
      </div>
    );
  }

  if (loadFailed) {
    return (
      <p role="alert" className="m-0 text-sm text-destructive">
        Your earlier messages didn’t load. You can still send a new one.
      </p>
    );
  }

  // `is_private` marks an internal note between agents. The API should not be
  // handing those out at all; drop them rather than trust that it doesn't.
  const messages = (thread ?? []).filter((message) => !message.is_private);
  if (messages.length === 0) return null;

  return (
    <div className="flex max-h-64 flex-col gap-2.5 overflow-y-auto pr-0.5">
      {messages.map((message) => (
        <Bubble key={message.id} message={message} />
      ))}
      <div ref={bottom} />
    </div>
  );
}

function Bubble({ message }: { message: Message }) {
  const mine = message.author_type === "customer";
  return (
    <div className={cn("flex flex-col gap-0.5", mine ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg border-2 border-border px-2.5 py-1.5 text-sm whitespace-pre-wrap",
          mine ? "bg-primary text-primary-foreground" : "bg-card text-card-foreground",
        )}
      >
        {/* Plain text, not the `rich_content` TipTap document: a reply is prose,
            and a rich renderer is a lot of surface for the occasional link. */}
        {message.content}
      </div>
      <span className="text-[0.6875rem] font-semibold text-muted-foreground">
        {mine ? "You" : (message.author_name ?? "Buttery")} · {when(message.created_at)}
      </span>
    </div>
  );
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DATE_TIME = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Time alone for today, date and time for anything older. */
function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const now = new Date();
  const today = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  return (today ? TIME : DATE_TIME).format(at);
}
