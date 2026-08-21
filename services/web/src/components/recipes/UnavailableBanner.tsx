import { Unlink } from "lucide-react";

/**
 * Quiet inline banner shown when a boxed recipe's source has gone unavailable on
 * the network (plan §3.4). The content still renders in full from the cached
 * rendered layer; this only signals that the public source is gone.
 */
export function UnavailableBanner({ since }: { since: string | null }) {
  const date = since ? new Date(since).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : null;
  return (
    <div className="flex items-start gap-2 rounded-lg border-2 border-border bg-muted px-3 py-2 text-[0.75rem] text-muted-foreground">
      <Unlink className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span>No longer publicly available — showing your saved copy{date ? ` (source removed ${date})` : ""}.</span>
    </div>
  );
}
