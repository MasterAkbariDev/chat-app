"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Video } from "lucide-react";
import { cn } from "@/lib/cn";

export type RecordMode = "voice" | "video";

const MODE_KEY = "chat:record-mode";
const HOLD_MS = 300;

function readMode(): RecordMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === "video" ? "video" : "voice";
  } catch {
    return "voice";
  }
}

/** One button for both kinds of recorded message, like Telegram: **tap** to
 * switch between voice and video (remembered per browser), **hold** to start
 * recording in the current mode. Keyboard: hold Enter/Space the same way;
 * a quick press switches. Once recording starts the recorder takes over
 * (pause, review, send, discard), so letting go doesn't send. */
export function RecordButton({
  onStart,
  voice = true,
  video = true,
}: {
  onStart: (mode: RecordMode) => void;
  /** Which modes are offered; with only one, tapping doesn't switch. */
  voice?: boolean;
  video?: boolean;
}) {
  const both = voice && video;
  const [mode, setMode] = useState<RecordMode>(() => (both ? readMode() : video && !voice ? "video" : "voice"));
  const [holding, setHolding] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const pressed = useRef(false);
  const handledByKeyOrPointer = useRef(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (hintTimer.current) clearTimeout(hintTimer.current);
    },
    [],
  );

  function showHint(next: RecordMode) {
    setHint(next === "voice" ? "Voice message — hold to record" : "Video message — hold to record");
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), 1800);
  }

  function toggle() {
    if (!both) {
      showHint(mode);
      return;
    }
    const next: RecordMode = mode === "voice" ? "video" : "voice";
    setMode(next);
    try {
      window.localStorage.setItem(MODE_KEY, next);
    } catch {
      // Storage unavailable (private mode) — the switch still works this session.
    }
    showHint(next);
  }

  function press() {
    if (pressed.current) return;
    pressed.current = true;
    fired.current = false;
    setHolding(true);
    timer.current = setTimeout(() => {
      fired.current = true;
      setHolding(false);
      navigator.vibrate?.(12);
      onStart(mode);
    }, HOLD_MS);
  }

  function release(commit: boolean) {
    if (!pressed.current) return;
    pressed.current = false;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
    if (commit && !fired.current) toggle();
  }

  const Icon = mode === "voice" ? Mic : Video;
  const other = mode === "voice" ? "video" : "voice";
  const label = both
    ? `${mode === "voice" ? "Voice" : "Video"} message. Tap to switch to ${other}, hold to record`
    : `${mode === "voice" ? "Voice" : "Video"} message. Hold to record`;

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-label={label}
        title={label}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          handledByKeyOrPointer.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          press();
        }}
        onPointerUp={() => release(true)}
        onPointerCancel={() => release(false)}
        onLostPointerCapture={() => release(false)}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
            e.preventDefault();
            handledByKeyOrPointer.current = true;
            press();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            release(true);
          }
        }}
        // Assistive tech "clicks" without pointer or key events — treat that
        // as a tap (switch); everything else is handled above.
        onClick={() => {
          if (handledByKeyOrPointer.current) {
            handledByKeyOrPointer.current = false;
            return;
          }
          toggle();
        }}
        onContextMenu={(e) => e.preventDefault()}
        className={cn(
          "pressable relative flex size-11 select-none items-center justify-center rounded-full bg-accent text-accent-fg hover:bg-accent-hover [-webkit-touch-callout:none] [touch-action:none]",
          holding && "scale-110",
        )}
      >
        <Icon key={mode} className="pop-in size-[21px]" strokeWidth={2} aria-hidden />
        <svg className="pointer-events-none absolute -inset-1 -rotate-90" viewBox="0 0 52 52" aria-hidden>
          <circle
            cx="26"
            cy="26"
            r="24"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={2 * Math.PI * 24}
            strokeDashoffset={holding ? 0 : 2 * Math.PI * 24}
            style={{ opacity: holding ? 1 : 0, transition: holding ? `stroke-dashoffset ${HOLD_MS}ms linear, opacity 80ms` : "none" }}
          />
        </svg>
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {hint ?? ""}
      </span>
      {hint ? (
        <span aria-hidden className="pop-in pointer-events-none absolute bottom-full end-0 mb-2 whitespace-nowrap rounded-[var(--radius-sm)] bg-fg px-2.5 py-1.5 text-[12.5px] font-semibold text-canvas shadow-md">
          {hint}
        </span>
      ) : null}
    </div>
  );
}
