import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Plug, Unlink } from "lucide-react";
import { ConfirmDialog } from "#/components/ConfirmDialog";
import { Button } from "#/components/ui/button";
import { Img } from "#/components/ui/img";
import { relativeTimeFromNow } from "#/lib/relative-time";
import { disconnectMcpConnection, type McpConnection } from "#/lib/api";

const ABSOLUTE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function When({ iso }: { iso: string }) {
  const date = new Date(iso);
  // Relative text depends on "now", so the server and client renders can differ by a tick.
  return (
    <time dateTime={iso} title={ABSOLUTE.format(date)} suppressHydrationWarning>
      {relativeTimeFromNow(date)}
    </time>
  );
}

function AppMark({ connection }: { connection: McpConnection }) {
  const initial = (
    <span aria-hidden="true" className="display-title flex size-full items-center justify-center bg-secondary text-lg text-secondary-foreground">
      {connection.name.slice(0, 1).toUpperCase()}
    </span>
  );
  return (
    <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border-2 border-border bg-card">
      <Img src={connection.iconUrl} alt="" referrerPolicy="no-referrer" className="size-full object-contain" fallback={initial} />
    </span>
  );
}

/** The AI apps that can currently work with this account, each with a Disconnect. */
export function McpConnectedApps({ connections }: { connections: McpConnection[] | null }) {
  const router = useRouter();
  const [target, setTarget] = useState<McpConnection | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  function close(open: boolean) {
    if (open || pending) return;
    setTarget(null);
    setFailure(null);
  }

  async function confirm() {
    if (!target) return;
    setPending(true);
    setFailure(null);
    try {
      await disconnectMcpConnection(target.clientId);
      await router.invalidate();
      setTarget(null);
    } catch {
      setFailure("We couldn't disconnect that app just now. Nothing changed, so it's still connected. Try again in a moment.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="mcp-connected-apps" className="flex flex-col gap-3">
      <h3 id="mcp-connected-apps" className="display-title m-0 text-lg">
        Connected apps
      </h3>

      {connections === null ? (
        <p className="m-0 rounded-lg border-2 border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-foreground" role="alert">
          We couldn't load your connected apps. Refresh the page to try again.
        </p>
      ) : connections.length === 0 ? (
        <div className="flex items-start gap-3 rounded-lg border-2 border-dashed border-border px-4 py-5 text-sm text-muted-foreground">
          <Plug className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <p className="m-0">Nothing connected yet — add the URL above to an AI app and it'll show up here. You can disconnect it whenever you like.</p>
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {connections.map((connection) => (
            <li key={connection.clientId} className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border-2 border-border bg-card p-3">
              <AppMark connection={connection} />
              <div className="flex min-w-0 flex-1 flex-col">
                <p className="m-0 truncate font-semibold text-foreground">{connection.name}</p>
                <p className="m-0 text-xs text-muted-foreground">
                  Connected <When iso={connection.connectedAt} />
                  {" · "}
                  {connection.lastActiveAt ? (
                    <>
                      Last active <When iso={connection.lastActiveAt} />
                    </>
                  ) : (
                    "Not used yet"
                  )}
                </p>
              </div>
              <Button type="button" variant="destructive" size="sm" onClick={() => setTarget(connection)}>
                <Unlink aria-hidden="true" />
                Revoke
                <span className="sr-only"> access for {connection.name}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={target !== null}
        onOpenChange={close}
        title={`Disconnect ${target?.name ?? "this app"}?`}
        description="It will lose access to your Buttery account right away. You can connect it again whenever you like."
        confirmLabel={pending ? "Disconnecting…" : "Disconnect"}
        cancelLabel="Keep connected"
        destructive
        pending={pending}
        onConfirm={() => void confirm()}
      >
        {failure && (
          <p className="m-0 rounded-lg border-2 border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-foreground" role="alert">
            {failure}
          </p>
        )}
      </ConfirmDialog>
    </section>
  );
}
