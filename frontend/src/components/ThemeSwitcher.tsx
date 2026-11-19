"use client";

import { useRef } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "@/contexts/theme-context";
import { THEME_KEYS, THEMES } from "@/lib/themes";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { cn } from "@/lib/cn";

export function ThemeSwitcher() {
  const { theme, setTheme, mode, setMode } = useTheme();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  // It's exposed as a radiogroup, so it needs the radio keyboard model:
  // arrows move (and pick) and only the checked swatch is a Tab stop —
  // previously all five were separate Tab stops and arrows did nothing.
  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl" && (e.key === "ArrowRight" || e.key === "ArrowLeft");
    const next = (index + (rtl ? -delta : delta) + THEME_KEYS.length) % THEME_KEYS.length;
    setTheme(THEME_KEYS[next]);
    refs.current[next]?.focus();
  }

  return (
    <div className="flex flex-col gap-6">
      <div role="radiogroup" aria-label="Colour theme" className="grid grid-cols-3 gap-3 sm:grid-cols-5">
        {THEME_KEYS.map((key, i) => {
          const t = THEMES[key];
          const active = key === theme;
          return (
            <button
              key={key}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              onClick={() => setTheme(key)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn(
                "pressable group flex flex-col gap-2 rounded-[var(--radius-md)] border p-2 text-start",
                active ? "border-accent bg-accent-soft" : "border-line bg-panel hover:border-line-strong",
              )}
            >
              <span className="relative flex h-14 overflow-hidden rounded-[var(--radius-sm)] border border-line" aria-hidden>
                <span className="flex-1" style={{ background: mode === "dark" ? t.dark : t.light }} />
                <span className="absolute bottom-2 end-2 h-3 w-8 rounded-full" style={{ background: t.accent }} />
                <span className="absolute start-2 top-2 h-3 w-10 rounded-full opacity-60" style={{ background: mode === "dark" ? "#ffffff33" : "#00000014" }} />
                {active ? (
                  <span className="absolute start-2 bottom-2 flex size-4 items-center justify-center rounded-full bg-accent text-accent-fg">
                    <Check className="size-3" strokeWidth={3} />
                  </span>
                ) : null}
              </span>
              <span className="px-0.5 text-[13.5px] font-semibold text-fg">{t.label}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-2">
        <div className="text-[13.5px] font-semibold text-fg-2" id="mode-label">
          Brightness
        </div>
        <SegmentedTabs
          aria-label="Brightness"
          value={mode}
          onChange={setMode}
          options={[
            { key: "light", label: "Light" },
            { key: "dark", label: "Dark" },
          ]}
          className="max-w-[320px]"
        />
      </div>
    </div>
  );
}

// Re-exported for places that want the mode icon without the full picker.
export const ModeIcon = { light: Sun, dark: Moon, system: Monitor };
