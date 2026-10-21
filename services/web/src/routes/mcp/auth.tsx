import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Check, ExternalLink, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "#/components/ui/card";
import { Spinner } from "#/components/ui/spinner";
import UserAvatar from "#/components/UserAvatar";
import { decideMcpConsent, getMcpConsent } from "#/lib/api";
import { seo } from "../../lib/seo";

// better-auth sends the browser here with a signed OAuth query; we pass it back
// verbatim (`oauth_query`) when the user decides. Rendered chrome-less — see
// BARE_ROUTES in AppShell — so nothing competes with the decision.

/**
 * The signature covers the exact query better-auth issued, so rebuild it from what
 * the router parsed: repeated keys (`ba_param`) arrive as arrays and numeric-looking
 * values arrive as numbers, and both must round-trip to the original text.
 */
function toQuery(search: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, String(item));
  }
  return query.toString();
}

export const Route = createFileRoute("/mcp/auth")({
  validateSearch: (search: Record<string, unknown>): Record<string, unknown> => search,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ deps }) => getMcpConsent(toQuery(deps.search)),
  head: () => ({
    meta: [...seo({ title: "Connect an app · Buttery", description: "Choose whether an app can use your Buttery account." }), { name: "robots", content: "noindex" }],
  }),
  component: ConsentPage,
});

/** What each scope lets the app do, in plain words. Unknown scopes show verbatim. */
const SCOPE_COPY: Record<string, string> = {
  openid: "Know who you are on Buttery",
  profile: "See your name and profile picture",
  email: "See your account's contact address",
  offline_access: "Stay connected until you disconnect it",
};

function ClientMark({ client }: { client: { id: string; name: string | null; logo: string | null } }) {
  const label = client.name ?? client.id;
  return client.logo ? (
    <img src={client.logo} alt="" referrerPolicy="no-referrer" className="size-14 rounded-lg border-2 border-border bg-card object-contain" />
  ) : (
    <div aria-hidden="true" className="display-title flex size-14 items-center justify-center rounded-lg border-2 border-border bg-secondary text-xl text-secondary-foreground">
      {label.slice(0, 1).toUpperCase()}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="page-wrap flex min-h-dvh items-center px-4 py-10">
      <div className="rise-in mx-auto flex w-full max-w-md flex-col gap-6">
        <p className="display-title m-0 text-center text-2xl">Buttery</p>
        {children}
      </div>
    </div>
  );
}

function ConsentPage() {
  const context = Route.useLoaderData();
  const search = Route.useSearch();
  const query = toQuery(search);
  const [pending, setPending] = useState<"accept" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (context.status === "invalid") {
    return (
      <Shell>
        <Alert variant="destructive">
          <AlertTitle>This link has expired</AlertTitle>
          <AlertDescription>Nothing was shared. Head back to your app and start the connection again.</AlertDescription>
        </Alert>
      </Shell>
    );
  }

  if (context.status === "signed-out") {
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={1} className="display-title text-xl">
              Sign in first
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-start gap-4">
            <p className="m-0 text-sm text-muted-foreground">Sign in to Buttery, then start the connection again from your app.</p>
            <Button render={<a href="/login" />} nativeButton={false}>
              Go to sign in
            </Button>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  const { client, scopes, account, redirectHost } = context;
  const clientName = client.name ?? "An app";

  async function submit(accept: boolean) {
    setError(null);
    setPending(accept ? "accept" : "deny");
    try {
      const { url } = await decideMcpConsent(query, accept);
      // Off-site hop back to the app's own redirect URI, so a full navigation.
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
      setPending(null);
    }
  }

  return (
    <Shell>
      <div className="flex flex-col items-center gap-3 text-center">
        <Badge variant="secondary">
          <ShieldCheck data-icon="inline-start" aria-hidden="true" />
          Connect an app
        </Badge>
        <ClientMark client={client} />
        <h1 className="display-title m-0 text-3xl">Let {clientName} use your Buttery account?</h1>
        {client.uri ? (
          <a
            href={client.uri}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm font-semibold text-primary underline underline-offset-4 [&_svg]:size-3.5"
          >
            {new URL(client.uri).host}
            <ExternalLink aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : (
          <p className="m-0 text-sm break-all text-muted-foreground">{client.id}</p>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2} className="display-title text-lg">
            {clientName} will be able to
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {(scopes.length ? scopes : ["openid"]).map((scope) => (
              <li key={scope} className="flex items-start gap-2 text-sm">
                <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
                <span>{SCOPE_COPY[scope] ?? scope}</span>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-3 border-t-2 border-border pt-4">
            <UserAvatar displayName={account.name} image={account.image} size="lg" />
            <p className="m-0 min-w-0 text-sm">
              Signed in as <code className="break-all">{account.name}</code>
            </p>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col items-stretch gap-3">
          <div className="flex flex-wrap gap-3">
            <Button size="lg" disabled={pending !== null} onClick={() => void submit(true)}>
              {pending === "accept" ? <Spinner data-icon="inline-start" /> : null}
              {pending === "accept" ? "Authorizing…" : "Allow access"}
            </Button>
            <Button size="lg" variant="outline" disabled={pending !== null} onClick={() => void submit(false)}>
              {pending === "deny" ? <Spinner data-icon="inline-start" /> : null}
              {pending === "deny" ? "Cancelling…" : "Deny"}
            </Button>
          </div>
          {error ? (
            <p role="alert" className="m-0 text-sm font-semibold text-destructive">
              {error}
            </p>
          ) : null}
        </CardFooter>
      </Card>

      <p className="m-0 text-center text-xs text-muted-foreground">
        {redirectHost ? (
          <>
            You'll be sent back to <code className="break-all">{redirectHost}</code>.{" "}
          </>
        ) : null}
        Only continue if you started this from an app you trust.
      </p>
    </Shell>
  );
}
