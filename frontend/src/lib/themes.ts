export type ThemeKey = "daybreak" | "aurora" | "meadow" | "rose" | "mono";
export type ThemeMode = "dark" | "light";

export interface ThemeSwatch {
  label: string;
  /** Short plain-language description shown under the picker. */
  description: string;
  /** Preview-only colours for the picker swatch (accent, light canvas, dark
   * canvas) — the real token sets live in globals.css, keyed by
   * [data-theme][data-mode]. */
  accent: string;
  light: string;
  dark: string;
}

export const THEMES: Record<ThemeKey, ThemeSwatch> = {
  daybreak: { label: "Daybreak", description: "Indigo", accent: "#4c4fd6", light: "#f3f4f9", dark: "#151722" },
  aurora: { label: "Aurora", description: "Teal", accent: "#0b7a71", light: "#f0f6f5", dark: "#101b1a" },
  meadow: { label: "Meadow", description: "Olive", accent: "#4b7410", light: "#f4f4ec", dark: "#161910" },
  rose: { label: "Rose", description: "Rose", accent: "#c2244b", light: "#faf3f4", dark: "#1c1317" },
  mono: { label: "Mono", description: "Graphite", accent: "#27272b", light: "#f3f3f4", dark: "#141416" },
};

export const THEME_KEYS = Object.keys(THEMES) as ThemeKey[];

export const DEFAULT_THEME: ThemeKey = "daybreak";
export const DEFAULT_MODE: ThemeMode = "dark";

export const THEME_STORAGE_KEY = "chat:theme";
export const MODE_STORAGE_KEY = "chat:mode";

/** Runs inline in <head> before first paint so a stored light-mode or
 * non-default theme never flashes the default dark palette first. Must stay
 * dependency-free and in sync with theme-context.tsx's own read logic. */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var p=${JSON.stringify(process.env.NEXT_PUBLIC_LEGACY_STORAGE_PREFIX ?? "")};if(p)for(var i=localStorage.length-1;i>=0;i--){var o=localStorage.key(i);if(o&&o.indexOf(p)===0){var n="chat:"+o.slice(p.length);if(localStorage.getItem(n)===null)localStorage.setItem(n,localStorage.getItem(o));localStorage.removeItem(o);}}}catch(e){}try{var d=document.documentElement,t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)}),m=localStorage.getItem(${JSON.stringify(MODE_STORAGE_KEY)});var k=${JSON.stringify(
  Object.keys({ daybreak: 1, aurora: 1, meadow: 1, rose: 1, mono: 1 }),
)};if(k.indexOf(t)<0)t=${JSON.stringify(DEFAULT_THEME)};if(m!=="dark"&&m!=="light")m=window.matchMedia&&matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";d.setAttribute("data-theme",t);d.setAttribute("data-mode",m);}catch(e){}})();`;
