import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { authClient } from "#/lib/auth-client";
import { fetchAdminIdentity } from "#/server/session";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";

/**
 * Email + password, and nothing else.
 *
 * There is no "create an account" link and there never will be one on this page:
 * `disableSignUp` closes the endpoint server-side, and operator accounts are
 * minted from a shell (`pnpm --filter @buttery/admin admin:create`). A sign-up
 * form here would be a form whose submit button 403s.
 */
export const Route = createFileRoute("/login")({
  validateSearch: z.object({ redirect: z.string().optional() }),
  beforeLoad: async ({ search }) => {
    // Already signed in? Don't show a form that will just bounce them.
    const identity = await fetchAdminIdentity();
    if (identity) throw redirect({ to: search.redirect ?? "/" });
  },
  component: LoginPage,
});

function LoginPage() {
  const router = useRouter();
  const search = Route.useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const result = await authClient.signIn.email({ email, password });

    if (result.error) {
      // better-auth deliberately does not distinguish "no such account" from
      // "wrong password", and neither do we — the message is theirs, unedited,
      // rather than something friendlier that would leak which accounts exist.
      setError(result.error.message ?? "Sign-in failed.");
      setPending(false);
      return;
    }

    // A full router invalidation, not just a navigate: `_authed`'s `beforeLoad`
    // already ran once and cached its "no session" answer for this router
    // instance, so navigating without invalidating bounces straight back here.
    await router.invalidate();
    await router.navigate({ to: search.redirect ?? "/" });
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/30 p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Buttery admin</CardTitle>
          <CardDescription>Operator sign-in. This is not a Buttery account — the admin has its own.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {error ? (
              // `role="alert"` so the failure is announced rather than only
              // appearing — the field values are unchanged, so a screen-reader
              // user gets no other signal that the submit did anything.
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
