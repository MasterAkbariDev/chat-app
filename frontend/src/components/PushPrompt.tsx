"use client";

import { useState } from "react";
import { Bell, BellOff, BellRing, MessageSquare, PhoneCall, type LucideIcon } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { Spinner } from "@/components/ui/Spinner";
import { enablePushNotifications, isPushConfigured } from "@/lib/push";

/** Asked once per account on this browser: "Turn on notifications?". Either answer is remembered, and
 *  Settings → Notifications still has the switch. Only shown while the browser hasn't answered yet. */
const seenKey = (userId: string) => `hearth.pushPrompt.${userId}`;

/** True while this account still owes an answer to the notification question on this browser. */
export function pushQuestionPending(userId: string): boolean {
  if (typeof window === "undefined" || typeof Notification === "undefined") return false;
  if (!isPushConfigured() || Notification.permission !== "default") return false;
  try {
    return !window.localStorage.getItem(seenKey(userId));
  } catch {
    return false;
  }
}

function remember(userId: string) {
  try {
    window.localStorage.setItem(seenKey(userId), "1");
  } catch {
    // Not stored: the prompt may show again next time, which is harmless.
  }
}

export function PushPrompt({ userId, onDone }: { userId: string; onDone?: () => void }) {
  // Decided once, when this account's session starts (the parent remounts it per account).
  const [open, setOpen] = useState(() => pushQuestionPending(userId));
  const [busy, setBusy] = useState(false);
  if (!open) return null;

  function later() {
    remember(userId);
    setOpen(false);
    onDone?.();
  }

  async function turnOn() {
    setBusy(true);
    try {
      // Runs from the tap, so the browser can show its own permission prompt.
      await enablePushNotifications();
    } catch {
      // A failed enable shows nothing here; Settings has the switch and its own message.
    } finally {
      remember(userId);
      setBusy(false);
      setOpen(false);
      onDone?.();
    }
  }

  return (
    <Dialog
      onClose={later}
      title="Turn on notifications"
      size="sm"
      footer={
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
            onClick={turnOn}
            disabled={busy}
            aria-busy={busy || undefined}
            data-autofocus
            className="pressable inline-flex h-11 w-full sm:flex-1 items-center justify-center gap-2 rounded-full bg-accent px-5 text-[15px] font-semibold text-accent-fg shadow-sm hover:bg-accent-hover disabled:opacity-80"
          >
            {busy ? <Spinner className="size-4 text-accent-fg" label="Turning on notifications" /> : <BellRing className="size-[18px]" strokeWidth={2} aria-hidden />}
            {busy ? "Turning on…" : "Turn on"}
          </button>
        </>
      }
    >
      <div className="flex flex-col items-center gap-4 pb-1 text-center">
        <span className="flex size-16 items-center justify-center rounded-full bg-accent-soft text-accent-text">
          <Bell className="size-8" strokeWidth={1.8} aria-hidden />
        </span>
        <p className="text-[14.5px] leading-relaxed text-fg-2">Know when something arrives while Chat is closed. You can change this anytime in Settings.</p>
        <ul className="w-full space-y-2.5 text-start">
          <Benefit icon={MessageSquare} text="New messages as they arrive" />
          <Benefit icon={PhoneCall} text="Incoming calls ring on this device" />
          <Benefit icon={BellOff} text="Mute any chat whenever you like" />
        </ul>
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
