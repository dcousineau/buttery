import { Link } from "@tanstack/react-router";
import { authClient } from "../lib/auth-client";
import ButterStick from "./ButterStick";
import ThemeToggle from "./ThemeToggle";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { SidebarTrigger } from "#/components/ui/sidebar";
import { Skeleton } from "#/components/ui/skeleton";

function AuthState() {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return <Skeleton className="h-8 w-24 rounded-lg" />;
  }

  if (session) {
    return (
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="max-w-40 truncate" title={session.user.name}>
          @{session.user.name}
        </Badge>
        <Button variant="ghost" size="sm" onClick={() => void authClient.signOut()}>
          Sign out
        </Button>
      </div>
    );
  }

  return (
    <Button render={<Link to="/" hash="sign-in" />} nativeButton={false}>
      Sign in
    </Button>
  );
}

export default function Header() {
  return (
    <header className="sticky top-0 z-40 border-b-2 border-border bg-background">
      <div className="flex items-center gap-2 px-3 py-2.5 sm:px-5">
        <SidebarTrigger />

        <Link to="/" className="flex items-center gap-2 text-foreground no-underline md:hidden">
          <ButterStick className="h-6 w-auto" />
          <span className="display-title text-lg leading-none">Buttery</span>
        </Link>

        <div className="ml-auto flex items-center gap-2">
          <AuthState />
          <ThemeToggle />
        </div>
      </div>
      <div className="gingham-band" aria-hidden="true" />
    </header>
  );
}
