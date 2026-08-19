import { WifiOff } from "lucide-react";

/**
 * The visible half of "M1 writes are online-only" (offline plan §4.1).
 *
 * Every offline-disabled control carries `OFFLINE_WRITE_HINT` in its `title`,
 * and that is the *invisible* half: a `title` needs hover, phones have none,
 * and a disabled control is skipped by keyboard focus — so the primary device
 * saw every action grey out with no stated reason. This strip says it once,
 * where everyone can read it, instead of once per control where nobody can.
 *
 * Always mounted, content conditional. A live region that appears *with* its
 * announcement is a coin-flip for screen readers — the region must exist before
 * its content changes for the change to be announced — so the wrapper stays in
 * the DOM and only the text comes and goes. Empty, it has no height and no
 * border; nothing to see and nothing to skip.
 *
 * `role="status"` (polite), not an alert: going offline mid-aisle is news that
 * can wait for a gap, and the reads this page exists for still work.
 */
export function OfflineNotice({ online, children }: { online: boolean; children: string }) {
  return (
    <div role="status" aria-live="polite">
      {online ? null : (
        <p className="m-0 flex flex-none items-center justify-center gap-2 border-b-2 border-border bg-muted px-3 py-1.5 text-[0.8125rem] font-semibold text-muted-foreground">
          <WifiOff className="size-3.5 shrink-0" aria-hidden="true" />
          {children}
        </p>
      )}
    </div>
  );
}
