import { useState, useEffect } from "react";
import type { Theme } from "../theme/tokens";

/**
 * Theme hook with system preference detection and persistence
 */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = globalThis.localStorage?.getItem("asteria-theme") ?? null;
    if (stored === "light" || stored === "dark") return stored;

    return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    globalThis.localStorage?.setItem("asteria-theme", theme);
  }, [theme]);

  useEffect(() => {
    const mediaQuery = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mediaQuery) return;
    const handler = (e: { matches: boolean }): void => {
      if (!globalThis.localStorage?.getItem("asteria-theme")) {
        setTheme(e.matches ? "dark" : "light");
      }
    };

    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, []);

  return [theme, setTheme];
}
