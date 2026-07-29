import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { authClient, signOutAndGoHome } from "../lib/auth-client";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { Skeleton } from "#/components/ui/skeleton";
import { Spinner } from "#/components/ui/spinner";
import { seo } from "../lib/seo";
import type { FormEvent, ReactNode } from "react";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { auth_error?: string } => (typeof search.auth_error === "string" ? { auth_error: search.auth_error } : {}),
  head: () => ({
    meta: seo({ title: "Sign in · Buttery", description: "Sign in to Buttery with your atproto account." }),
  }),
  component: LoginPage,
});

/** Inline text link to somewhere off Buttery — always gets the external-link icon. */
function ExternalTextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-semibold text-primary underline underline-offset-4 [&_svg]:size-3.5 [&_svg]:shrink-0"
    >
      {children}
      <ExternalLink aria-hidden="true" />
    </a>
  );
}

function LoginPage() {
  return (
    <div className="page-wrap px-4 pt-10 pb-12 sm:pt-14">
      <div className="rise-in mx-auto flex max-w-md flex-col gap-6">
        <header className="flex flex-col items-start">
          <Badge variant="secondary" className="mb-3">
            Sign in
          </Badge>
          <h1 className="display-title m-0 text-3xl leading-[1.1] text-foreground sm:text-4xl">Welcome to the pantry</h1>
          <p className="mt-3 mb-0 text-sm text-muted-foreground sm:text-base">
            Buttery keeps your recipes on <strong className="text-foreground">your own atproto account</strong> — not our servers. Sign in with your internet handle to open your
            pantry.
          </p>
        </header>

        <SignInCard />

        <CreateAccountCard />

        <p className="m-0 text-center text-xs text-muted-foreground">
          New to accounts that work like this? <ExternalTextLink href="https://internethandle.org/">Learn about internet handles</ExternalTextLink>
        </p>
      </div>
    </div>
  );
}

function CreateAccountCard() {
  return (
    <Card size="sm" className="bg-secondary text-secondary-foreground">
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="display-title text-lg">
          Don't have an account yet?
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-4">
        <p className="m-0 text-sm text-secondary-foreground">
          Buttery doesn't host accounts — you bring your own. The easiest place to start is a free Bluesky account, which gives you an internet handle that works here.
        </p>
        <Button variant="outline" render={<a href="https://bsky.app" target="_blank" rel="noreferrer" />} nativeButton={false}>
          Create an account with Bluesky
          <ExternalLink data-icon="inline-end" aria-hidden="true" />
        </Button>
      </CardContent>
    </Card>
  );
}

function SignInCard() {
  const { data: session, isPending } = authClient.useSession();
  const { auth_error: authError } = Route.useSearch();
  const [handle, setHandle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!handle.trim()) return;
    setError(null);
    setPending(true);
    const { data, error: signInError } = await authClient.atproto.signIn({
      handle: handle.trim(),
    });
    if (signInError || !data?.url) {
      setError(signInError?.message ?? "Sign-in failed");
      setPending(false);
      return;
    }
    // Hand the browser to the atproto authorization server; it returns to
    // /api/auth/atproto/callback which sets the session cookie.
    window.location.href = data.url;
  }

  const failureMessage = error ?? (authError ? "Sign-in was not completed. Try again." : null);

  if (isPending) {
    return (
      <Card>
        <CardContent>
          <Skeleton className="h-9 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (session) {
    return (
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={2} className="display-title text-xl">
            You're signed in
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-4">
          <p className="m-0 text-sm">
            Signed in as <code className="break-all">{session.user.name}</code>
          </p>
          <div className="flex flex-wrap gap-3">
            <Button render={<Link to="/pantry" />} nativeButton={false}>
              Go to your pantry
            </Button>
            <Button variant="outline" onClick={() => void signOutAndGoHome()}>
              Sign out
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="display-title text-xl">
          Sign in with your handle
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <Field data-invalid={failureMessage ? true : undefined}>
              <FieldLabel htmlFor="atproto-handle">Internet Handle</FieldLabel>
              <Input
                id="atproto-handle"
                type="text"
                size="lg"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="alice.bsky.social"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={failureMessage ? true : undefined}
                aria-describedby={failureMessage ? "atproto-handle-error" : "atproto-handle-hint"}
              />
            </Field>
          </FieldGroup>
          <p id="atproto-handle-hint" className="mt-2 mb-0 text-xs text-muted-foreground">
            The handle from your account provider — for most people that's a Bluesky handle like <code>alice.bsky.social</code>.
          </p>
          <Button type="submit" disabled={pending} className="mt-4">
            {pending ? <Spinner data-icon="inline-start" /> : null}
            {pending ? "Redirecting…" : "Sign in with atproto"}
          </Button>
          {failureMessage && (
            <p id="atproto-handle-error" role="alert" className="mt-3 mb-0 text-sm font-semibold text-destructive">
              {failureMessage}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
