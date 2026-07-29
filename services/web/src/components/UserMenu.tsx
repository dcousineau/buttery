import { Link } from "@tanstack/react-router";
import { LogOut, Monitor, Moon, Sun } from "lucide-react";
import { authClient, signOutAndGoHome } from "../lib/auth-client";
import UserAvatar from "./UserAvatar";
import { Button } from "#/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "#/components/ui/dropdown-menu";
import { Skeleton } from "#/components/ui/skeleton";
import { serviceNameFromPds } from "#/lib/atproto/service-name";
import { useTheme, type ThemeMode } from "#/lib/theme";

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
 */
export default function UserMenu() {
  const { data: session, isPending } = authClient.useSession();
  const { mode, setMode } = useTheme();

  if (isPending) {
    return <Skeleton className="size-9 rounded-full" />;
  }

  if (!session) {
    return (
      <Button render={<Link to="/login" />} nativeButton={false}>
        Sign in
      </Button>
    );
  }

  const { handle, name, image } = session.user;
  const displayHandle = handle ?? name;
  const service = serviceNameFromPds(session.user.pds);
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
