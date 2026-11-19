"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { DEFAULT_MODE, DEFAULT_THEME, MODE_STORAGE_KEY, THEME_STORAGE_KEY, THEMES, type ThemeKey, type ThemeMode } from "@/lib/themes";




function readStoredTheme(): ThemeKey {
  if (typeof window === "undefined") return DEFAULT_THEME;
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored && stored in THEMES ? (stored as ThemeKey) : DEFAULT_THEME;
}

function readStoredMode(): ThemeMode {
  if (typeof window === "undefined") return DEFAULT_MODE;
  const stored = window.localStorage.getItem(MODE_STORAGE_KEY);
  if (stored === "dark" || stored === "light") return stored;
  // No explicit choice yet — honor the OS preference once, rather than
  // always defaulting to dark, but still don't force a mismatched paint at
  // hydration time (this runs client-side in the initializer, so SSR/first
  // paint agree with what actually renders — same reasoning as the theme
  // read below).
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

interface ThemeContextValue {
  theme: ThemeKey;
  setTheme: (theme: ThemeKey) => void;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggleMode: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Read localStorage synchronously in the initializer (not in a mount
  // effect that runs alongside the persist-on-change effect below) — doing
  // it in a separate effect races the "write current theme" effect: both
  // fire on the same initial commit, and the write can clobber a
  // just-read, different stored value with the still-default state before
  // the read's setState has re-rendered, silently resetting the theme if
  // anything (e.g. navigation) interrupts before the follow-up re-render.
  const [theme, setThemeState] = useState<ThemeKey>(readStoredTheme);
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  }, [mode]);

  const setTheme = useCallback((next: ThemeKey) => setThemeState(next), []);
  const setMode = useCallback((next: ThemeMode) => setModeState(next), []);
  const toggleMode = useCallback(() => setModeState((prev) => (prev === "dark" ? "light" : "dark")), []);

  const value = useMemo(
    () => ({ theme, setTheme, mode, setMode, toggleMode }),
    [theme, setTheme, mode, setMode, toggleMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
