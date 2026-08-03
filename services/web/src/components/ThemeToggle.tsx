import { Button } from "#/components/ui/button";
import { useTheme } from "#/lib/hooks/use-theme";
import { Moon, Sun, SunMoon } from "lucide-react";

/**
 * Standalone single-button theme cycler (light → dark → auto). Used on the
 * public marketing + waitlist holding pages, where there's no account menu to fold it
 * into. The in-app chrome uses the explicit picker inside `UserMenu` instead;
 * both share theme state via `useTheme()`.
 */
export default function ThemeToggle() {
  const { mode, setMode } = useTheme();

  function toggleMode() {
    setMode(mode === "light" ? "dark" : mode === "dark" ? "auto" : "light");
  }

  const label = mode === "auto" ? "Theme mode: auto (system). Click to switch to light mode." : `Theme mode: ${mode}. Click to switch mode.`;

  return (
    <Button variant="outline" size="sm" onClick={toggleMode} aria-label={label} title={label}>
      {mode === "auto" ? <SunMoon /> : mode === "dark" ? <Moon /> : <Sun />}
    </Button>
  );
}
