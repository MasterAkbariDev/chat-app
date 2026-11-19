"use client";

import { useId } from "react";
import { Bell, MessageSquareText, Timer, Volume2 } from "lucide-react";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/cn";
import { setToastPrefs, useToastPrefs, type ToastPrefs } from "@/lib/toast-prefs";

const DURATIONS: ToastPrefs["durationSec"][] = [3, 5, 8];

/** The in-app pop-up settings, as rows of the Notifications list. */
export function ToastSettings() {
  const prefs = useToastPrefs();
  const enabledId = useId();
  const soundId = useId();
  const textId = useId();
  const durationId = useId();
  return (
    <>
      <div className="flex min-h-[60px] items-center gap-3 px-4 py-2.5">
        <Row icon={Bell} />
        <div className="min-w-0 flex-1">
          <div id={enabledId} className="text-[15px] text-fg">In-app notifications</div>
          <div className="text-[13px] text-muted">Pop up when a message arrives while you&apos;re in another chat or screen.</div>
        </div>
        <Switch checked={prefs.enabled} onChange={(enabled) => setToastPrefs({ enabled })} aria-labelledby={enabledId} />
      </div>
      <div className={cn("flex min-h-[60px] items-center gap-3 px-4 py-2.5", !prefs.enabled && "opacity-50")}>
        <Row icon={Volume2} />
        <div className="min-w-0 flex-1">
          <div id={soundId} className="text-[15px] text-fg">Sound</div>
          <div className="text-[13px] text-muted">A short chime with each pop-up.</div>
        </div>
        <Switch checked={prefs.sound} disabled={!prefs.enabled} onChange={(sound) => setToastPrefs({ sound })} aria-labelledby={soundId} />
      </div>
      <div className={cn("flex min-h-[60px] items-center gap-3 px-4 py-2.5", !prefs.enabled && "opacity-50")}>
        <Row icon={MessageSquareText} />
        <div className="min-w-0 flex-1">
          <div id={textId} className="text-[15px] text-fg">Show message text</div>
          <div className="text-[13px] text-muted">Off shows only who wrote, not what they wrote.</div>
        </div>
        <Switch checked={prefs.showText} disabled={!prefs.enabled} onChange={(showText) => setToastPrefs({ showText })} aria-labelledby={textId} />
      </div>
      <div className={cn("flex min-h-[60px] items-center gap-3 px-4 py-2.5", !prefs.enabled && "opacity-50")}>
        <Row icon={Timer} />
        <div className="min-w-0 flex-1">
          <div id={durationId} className="text-[15px] text-fg">Stay on screen</div>
          <div className="text-[13px] text-muted">How long a pop-up stays before it closes.</div>
        </div>
        <div role="radiogroup" aria-labelledby={durationId} className="flex shrink-0 gap-1 rounded-full bg-sunken p-1">
          {DURATIONS.map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={prefs.durationSec === d}
              disabled={!prefs.enabled}
              onClick={() => setToastPrefs({ durationSec: d })}
              className={cn(
                "tabular h-8 min-w-10 rounded-full px-2.5 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed",
                prefs.durationSec === d ? "bg-raised text-fg shadow-sm" : "text-muted hover:text-fg",
              )}
            >
              {d} s
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function Row({ icon: Icon }: { icon: typeof Bell }) {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-sunken text-fg-2">
      <Icon className="size-[18px]" strokeWidth={1.8} aria-hidden />
    </span>
  );
}
