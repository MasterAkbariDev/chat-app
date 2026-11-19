"use client";

import { useState } from "react";
import { Check, Download, Maximize, Plus, Share, Smartphone, Zap, BellRing, type LucideIcon } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { Spinner } from "@/components/ui/Spinner";
import { promptInstall, useInstallState, type InstallState } from "@/lib/install-app";

/** Suggested once per browser, and only from the second visit: an app opened from the home screen is
 *  full screen and gets notifications reliably. Settings → App has the same options at any time. */
const DISMISSED_KEY = "hearth.installPrompt.dismissed";
const VISITS_KEY = "hearth.installPrompt.visits";
const MIN_VISITS = 2;

/** Counts one visit per browser session (a reload in the same tab doesn't count twice). */
function countVisit(): number {
  try {
    const counted = window.sessionStorage.getItem(VISITS_KEY);
    const visits = Number(window.localStorage.getItem(VISITS_KEY) ?? "0");
    if (counted) return visits;
    window.sessionStorage.setItem(VISITS_KEY, "1");
    window.localStorage.setItem(VISITS_KEY, String(visits + 1));
    return visits + 1;
  } catch {
    return 0;
  }
}

function wasDismissed(): boolean {
  try {
    return !!window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return true;
  }
}

function remember() {
  try {
    window.localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Not stored: it may be suggested again next visit.
  }
}

export function InstallPrompt() {
  const state = useInstallState();
  // Decided once per mount: a visit is counted only on the first mount in a browser session.
  const [open, setOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    const visits = countVisit();
    return visits >= MIN_VISITS && !wasDismissed();
  });
  const [busy, setBusy] = useState(false);
  if (!open || (state !== "ready" && state !== "ios")) return null;

  function later() {
    remember();
    setOpen(false);
  }

  async function install() {
    setBusy(true);
    try {
      // From the tap, so the browser can show its own install dialog.
      await promptInstall();
    } catch {
      // Settings → App explains the other ways to install.
    } finally {
      remember();
      setBusy(false);
      setOpen(false);
    }
  }

  const text = copy(state);
  return (
    <Dialog
      onClose={later}
      title={text.title}
      size="sm"
      footer={
        state === "ready" ? (
          <>
            <button
              type="button"
              onClick={later}
              disabled={busy}
              className="pressable inline-flex h-11 w-full sm:flex-1 items-center justify-center rounded-full border border-line bg-sunken px-5 text-[15px] font-semibold text-fg hover:border-line-strong disabled:opacity-50"
            >
              Not now
            </button>
            <button
              type="button"
              onClick={install}
              disabled={busy}
              aria-busy={busy || undefined}
              data-autofocus
              className="pressable inline-flex h-11 w-full sm:flex-1 items-center justify-center gap-2 rounded-full bg-accent px-5 text-[15px] font-semibold text-accent-fg shadow-sm hover:bg-accent-hover disabled:opacity-80"
            >
              {busy ? <Spinner className="size-4 text-accent-fg" label="Installing" /> : <Download className="size-[18px]" strokeWidth={2} aria-hidden />}
              {busy ? "Installing…" : "Install"}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={later}
            data-autofocus
            className="pressable inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-accent px-5 text-[15px] font-semibold text-accent-fg shadow-sm hover:bg-accent-hover"
          >
            <Check className="size-[18px]" strokeWidth={2.2} aria-hidden />
            Got it
          </button>
        )
      }
    >
      <div className="flex flex-col items-center gap-4 pb-1 text-center">
        {/* The app's own icon, so the prompt is recognisable before anything is installed. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- static app icon from /public */}
        <img src="/icons/icon-192.png" alt="" width={72} height={72} draggable={false} className="size-18 rounded-[22px] shadow-md" />
        <p className="text-[14.5px] leading-relaxed text-fg-2">{text.body}</p>
        {state === "ready" ? (
          <ul className="w-full space-y-2.5 text-start">
            <Benefit icon={Maximize} text="Full screen, like a real app" />
            <Benefit icon={Zap} text="Opens straight from your home screen" />
            <Benefit icon={BellRing} text="Notifications arrive more reliably" />
          </ul>
        ) : (
          <ol className="w-full space-y-2.5 text-start">
            <Step n={1} icon={Share} text="Tap the Share button in Safari" />
            <Step n={2} icon={Plus} text="Choose Add to Home Screen" />
            <Step n={3} icon={Smartphone} text="Open Chat from your home screen" />
          </ol>
        )}
      </div>
    </Dialog>
  );
}

function Benefit({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <li className="flex items-center gap-3 rounded-[var(--radius-md)] bg-sunken px-3 py-2.5 text-[14.5px] text-fg">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-raised text-accent-text">
        <Icon className="size-[17px]" strokeWidth={1.9} aria-hidden />
      </span>
      {text}
    </li>
  );
}

function Step({ n, icon: Icon, text }: { n: number; icon: LucideIcon; text: string }) {
  return (
    <li className="flex items-center gap-3 rounded-[var(--radius-md)] bg-sunken px-3 py-2.5 text-[14.5px] text-fg">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-[13px] font-bold text-accent-fg">{n}</span>
      <Icon className="size-[17px] shrink-0 text-accent-text" strokeWidth={1.9} aria-hidden />
      {text}
    </li>
  );
}

function copy(state: InstallState): { title: string; body: string } {
  return state === "ready"
    ? { title: "Install Chat", body: "Add Chat to your home screen and open it like any other app." }
    : { title: "Add Chat to your Home Screen", body: "It takes a few seconds, and then Chat opens like an app." };
}
