import { useEffect } from "react";
import { useLocalStorage } from "@mantine/hooks";

/**
 * Theme mode state, shared by the standalone `ThemeToggle` (cycle button, public
 * holding page) and the in-app `UserMenu` (explicit light/dark/auto picker).
 *
 * There is no theme provider: mode is owned per-consumer via `useTheme()` and
 * persisted to `localStorage["theme"]`, applied by toggling the `light`/`dark`
 * class + `data-theme` on `<html>`. `auto` follows `prefers-color-scheme` and
 * live-updates when the OS theme changes.
 */
export type ThemeMode = "light" | "dark" | "auto";

const STORAGE_KEY = "theme";

function isThemeMode(value: string | undefined): value is ThemeMode {
  return value === "light" || value === "dark" || value === "auto";
}

export function applyThemeMode(mode: ThemeMode): void {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = mode === "auto" ? (prefersDark ? "dark" : "light") : mode;

  document.documentElement.classList.remove("light", "dark");
  document.documentElement.classList.add(resolved);

  if (mode === "auto") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", mode);
  }

  document.documentElement.style.colorScheme = resolved;
}

/**
 * Owns theme mode state for a consumer: applies it, persists it, and keeps
 * `auto` in sync with the OS. `setMode` both stores and applies immediately.
 */
export function useTheme(): { mode: ThemeMode; setMode: (mode: ThemeMode) => void } {
  // Identity serialize/deserialize keeps the raw string in storage (not JSON),
  // matching the pre-hydration `THEME_INIT_SCRIPT` in `__root.tsx` that reads it.
  const [mode, setMode] = useLocalStorage<ThemeMode>({
    key: STORAGE_KEY,
    defaultValue: "auto",
    serialize: (value) => value,
    deserialize: (value) => (isThemeMode(value) ? value : "auto"),
  });

  useEffect(() => {
    applyThemeMode(mode);
  }, [mode]);

  useEffect(() => {
    if (mode !== "auto") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyThemeMode("auto");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [mode]);

  return { mode, setMode };
}
