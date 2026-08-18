import { Link } from "@tanstack/react-router";
import { LogOut, Monitor, Moon, Sun } from "lucide-react";
import { signOutAndGoHome, useHydratedSession } from "../lib/auth-client";
import { useSessionSnapshot } from "#/lib/offline/use-household";
import UserAvatar from "./UserAvatar";
import { Button } from "#/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "#/components/ui/dropdown-menu";
import { Skeleton } from "#/components/ui/skeleton";
import { serviceNameFromPds } from "#/lib/atproto/service-name";
import { useTheme, type ThemeMode } from "#/lib/hooks/use-theme";

// Single-item theme control: clicking cycles light → dark → auto. The icon and
// label reflect the CURRENT mode; `next` is what the click will switch to.
const THEME_META: Record<ThemeMode, { label: string; icon: typeof Sun; next: ThemeMode }> = {
  light: { label: "Light", icon: Sun, next: "dark" },
  dark: { label: "Dark", icon: Moon, next: "auto" },
  auto: { label: "Auto", icon: Monitor, next: "light" },
};

/**
 * The account control in the app chrome: an avatar-circle button that opens a
 * dropdown with who you're signed in as (handle + atproto service), a theme
 * picker (light / dark / auto), and sign out. Replaces the old handle badge +
 * separate sign-out and theme buttons.
 *
 * Signed out (or still loading) it shows the sign-in affordance instead, so the
 * header can render it unconditionally.
 *
 * **Offline it falls back to the persisted session snapshot** (offline plan
 * §4.4). `authClient.useSession()` is a network read, so without it this control
 * would show "Sign in" to someone who is signed in — the cookie is fine, the
 * network is not, and offering to re-authenticate is both a lie and a dead end
 * (the sign-in flow needs the network too). The snapshot carries a handle and a
 * name and nothing else: no avatar, no PDS label, and never a credential.
 */
export default function UserMenu() {
  // `useHydratedSession`, not the raw hook: the server has no session and the
  // client's store answers from cache immediately, so reading the raw one here
  // renders the menu during hydration against a skeleton in the SSR HTML.
  const { data: session, isPending } = useHydratedSession();
  const snapshot = useSessionSnapshot();
  const { mode, setMode } = useTheme();

  if (isPending) {
    return <Skeleton className="size-9 rounded-full" />;
  }

  if (!session && !snapshot) {
    return (
      <Button render={<Link to="/login" />} nativeButton={false}>
        Sign in
      </Button>
    );
  }

  const handle = session?.user.handle ?? snapshot?.handle ?? null;
  const name = session?.user.name ?? snapshot?.name ?? null;
  const image = session?.user.image ?? undefined;
  const displayHandle = handle ?? name;
  const service = session ? serviceNameFromPds(session.user.pds) : null;
  const ThemeIcon = THEME_META[mode].icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account menu — @${displayHandle}`}
        title={`@${displayHandle}`}
        // The avatar carries its own ink border; the trigger adds the sticker
        // physics (hard shadow, lift on hover, press down) + focus ring.
        className="rounded-full shadow-pop transition-all outline-none hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-pop-lg active:translate-x-0.5 active:translate-y-0.5 active:shadow-pop-sm focus-visible:ring-3 focus-visible:ring-ring/50"
        render={
          <button type="button">
            <UserAvatar handle={handle} image={image} size="lg" className="size-9" />
          </button>
        }
      />
      <DropdownMenuContent align="end" sideOffset={8} className="min-w-60">
        {/* Identity header: who you're signed in as. */}
        <div className="flex items-center gap-2.5 px-1.5 py-1.5">
          <UserAvatar handle={handle} image={image} size="lg" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold" title={`@${displayHandle}`}>
              @{displayHandle}
            </div>
            {service ? <div className="truncate text-xs text-muted-foreground">{service}</div> : null}
          </div>
        </div>

        <DropdownMenuSeparator />

        {/* Cycles light → dark → auto in place; stays open so you can keep tapping. */}
        <DropdownMenuItem closeOnClick={false} onClick={() => setMode(THEME_META[mode].next)}>
          <ThemeIcon aria-hidden="true" />
          Theme: {THEME_META[mode].label}
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem variant="destructive" onClick={() => void signOutAndGoHome()}>
          <LogOut aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
