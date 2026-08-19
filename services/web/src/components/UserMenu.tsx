import { Link } from "@tanstack/react-router";
import { ArrowLeftRight, Home, LogOut, Monitor, Moon, Settings, Sun } from "lucide-react";
import { signOutAndGoHome, useHydratedSession } from "../lib/auth-client";
import UserAvatar from "./UserAvatar";
import { Button } from "#/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "#/components/ui/dropdown-menu";
import { Skeleton } from "#/components/ui/skeleton";
import { serviceNameFromPds } from "#/lib/atproto/service-name";
import { useOnboardingVerdict } from "#/lib/hooks/use-onboarding-verdict";
import { useTheme, type ThemeMode } from "#/lib/hooks/use-theme";
import type { OnboardingVerdict } from "#/server/household/onboarding";

// Single-item theme control: clicking cycles light → dark → auto. The icon and
// label reflect the CURRENT mode; `next` is what the click will switch to.
const THEME_META: Record<ThemeMode, { label: string; icon: typeof Sun; next: ThemeMode }> = {
  light: { label: "Light", icon: Sun, next: "dark" },
  dark: { label: "Dark", icon: Moon, next: "auto" },
  auto: { label: "Auto", icon: Monitor, next: "light" },
};

/**
 * The household block inside the account menu: which household you're working
 * in, then the two things you can do about it. There is no "create" entry — the
 * switcher screen carries that affordance.
 *
 * Renders nothing while the verdict is unknown or the caller has no household
 * yet (onboarding); a caller with memberships but no active one gets a single
 * "Choose household" entry instead of an indicator.
 *
 * The verdict is a PROP, not a hook call: this renders inside the menu popup,
 * which Base UI unmounts while the menu is closed (`Menu.Portal` defaults to
 * `keepMounted={false}`). Fetching here would only re-validate the active
 * household when someone opened the menu — see `UserMenu`.
 */
function HouseholdSection({ verdict }: { verdict: OnboardingVerdict | null }) {
  if (!verdict || verdict.kind === "onboard") return null;

  if (verdict.kind === "pick") {
    return (
      <>
        <DropdownMenuItem render={<Link to="/households/switch" />}>
          <Home aria-hidden="true" />
          Choose household
        </DropdownMenuItem>
        <DropdownMenuSeparator />
      </>
    );
  }

  return (
    <>
      {/* Indicator, not a control: the household this session is working in. The
          avatar is the menu's only circle, so this stays plain text. */}
      <div className="min-w-0 px-1.5 py-1.5">
        <div className="text-xs text-muted-foreground">Household</div>
        <div className="truncate text-sm font-semibold" title={verdict.name}>
          {verdict.name}
        </div>
      </div>

      <DropdownMenuItem render={<Link to="/households" />}>
        <Settings aria-hidden="true" />
        Manage household
      </DropdownMenuItem>
      <DropdownMenuItem render={<Link to="/households/switch" />}>
        <ArrowLeftRight aria-hidden="true" />
        Switch household
      </DropdownMenuItem>

      <DropdownMenuSeparator />
    </>
  );
}

/**
 * The account control in the app chrome: an avatar-circle button that opens a
 * dropdown with who you're signed in as (handle + atproto service), which
 * household you're in (plus manage / switch), a theme picker (light / dark /
 * auto), and sign out.
 *
 * Signed out (or still loading) it shows the sign-in affordance instead, so the
 * header can render it unconditionally.
 *
 * The household verdict is fetched HERE rather than in the popup: this component
 * is mounted on every page, the popup only while the menu is open. Resolving it
 * on mount is what re-validates the session's active household (and clears a
 * stale pointer) on every page, as the old header switcher did.
 */
export default function UserMenu() {
  // `useHydratedSession`, not the raw hook: the server has no session and the
  // client's store answers from cache immediately, so reading the raw one here
  // renders the menu during hydration against a skeleton in the SSR HTML.
  const { data: session, isPending } = useHydratedSession();
  const verdict = useOnboardingVerdict();
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

        <HouseholdSection verdict={verdict} />

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
