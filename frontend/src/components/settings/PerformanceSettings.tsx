"use client";

import { useId } from "react";
import { Feather, Repeat, Sparkles, Wind } from "lucide-react";
import { usePerformance } from "@/contexts/performance-context";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { Switch } from "@/components/ui/Switch";
import type { AnimatedMediaPref, MotionPref } from "@/lib/performance";
import { cn } from "@/lib/cn";

/** Motion & performance — saved on this device only, since the same person
 * may want everything on a laptop and lite mode on an old phone. */
export function PerformanceSettings() {
  const { prefs, setPrefs, reduceMotion, animatedMedia } = usePerformance();
  const liteId = useId();
  const liteDescId = useId();
  const replayId = useId();
  const replayDescId = useId();
  const locked = prefs.lite;

  return (
    <section aria-labelledby="perf-heading" className="flex flex-col gap-2">
      <h2 id="perf-heading" className="px-1 text-[13.5px] font-semibold text-muted">
        Motion &amp; performance
      </h2>
      <div className="overflow-hidden rounded-[var(--radius-md)] border border-line bg-panel [&>*+*]:border-t [&>*+*]:border-line">
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-sunken text-fg-2">
            <Feather className="size-[18px]" strokeWidth={1.8} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div id={liteId} className="text-[15px] font-medium text-fg">
              Lite mode
            </div>
            <p id={liteDescId} className="mt-0.5 text-[13px] leading-snug text-muted">
              For older or slower devices. Turns off animations and animated emoji, and skips the wallpaper blur.
            </p>
          </div>
          <Switch checked={prefs.lite} onChange={(lite) => setPrefs({ lite })} aria-labelledby={liteId} aria-describedby={liteDescId} />
        </div>

        <Row
          icon={Wind}
          title="Reduce motion"
          description={
            locked
              ? "On while Lite mode is on."
              : prefs.motion === "system"
                ? `Following your device setting — currently ${reduceMotion ? "on" : "off"}.`
                : "Fewer moving transitions and effects."
          }
          disabled={locked}
        >
          <SegmentedTabs<MotionPref>
            aria-label="Reduce motion"
            value={locked ? "reduce" : prefs.motion}
            onChange={(motion) => setPrefs({ motion })}
            options={[
              { key: "system", label: "Device" },
              { key: "reduce", label: "On" },
              { key: "full", label: "Off" },
            ]}
          />
        </Row>

        <Row
          icon={Sparkles}
          title="Animated emoji & stickers"
          description={
            locked
              ? "Off while Lite mode is on — you'll see the first frame."
              : animatedMedia !== prefs.animatedMedia
                ? "Playing on hover because Reduce motion is on."
                : prefs.animatedMedia === "auto"
                  ? "Play while they're on screen."
                  : prefs.animatedMedia === "interact"
                    ? "Play when you point at or tap them."
                    : "Show the first frame only."
          }
          disabled={locked}
        >
          <SegmentedTabs<AnimatedMediaPref>
            aria-label="Animated emoji and stickers"
            value={locked ? "off" : prefs.animatedMedia}
            onChange={(animatedMedia) => setPrefs({ animatedMedia })}
            options={[
              { key: "auto", label: "Play" },
              { key: "interact", label: "On hover" },
              { key: "off", label: "Off" },
            ]}
          />
        </Row>

        <div className="flex items-center gap-3 px-4 py-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-sunken text-fg-2">
            <Repeat className="size-[18px]" strokeWidth={1.8} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div id={replayId} className="text-[15px] font-medium text-fg">
              Replay short videos
            </div>
            <p id={replayDescId} className="mt-0.5 text-[13px] leading-snug text-muted">
              In the viewer, videos of 20 seconds or less start again when they end.
            </p>
          </div>
          <Switch checked={prefs.replayShort} onChange={(replayShort) => setPrefs({ replayShort })} aria-labelledby={replayId} aria-describedby={replayDescId} />
        </div>
      </div>
      <p className="px-1 text-[13px] leading-relaxed text-muted">Saved on this device only.</p>
    </section>
  );
}

function Row({
  icon: Icon,
  title,
  description,
  disabled,
  children,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  description: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-3 px-4 py-3", disabled && "pointer-events-none opacity-55")} aria-disabled={disabled || undefined}>
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-sunken text-fg-2">
          <Icon className="size-[18px]" strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium text-fg">{title}</div>
          <p className="mt-0.5 text-[13px] leading-snug text-muted">{description}</p>
        </div>
      </div>
      <div className="ps-12">{children}</div>
    </div>
  );
}
