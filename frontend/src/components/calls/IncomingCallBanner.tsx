"use client";

import { useEffect, useId, useRef } from "react";
import { Phone, PhoneOff } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { useCall } from "@/contexts/call-context";

/** A ring, top-anchored so it doesn't block the screen underneath (the
 * ringtone is already playing — see call-context). Focus moves to Accept
 * so a keyboard user can answer with Enter; focus goes back where it was
 * when the banner closes. */
export function IncomingCallBanner() {
  const { incomingCall, acceptIncomingCall, declineIncomingCall } = useCall();
  const acceptRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descId = useId();
  const ringing = !!incomingCall;

  useEffect(() => {
    if (!ringing) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    acceptRef.current?.focus({ preventScroll: true });
    return () => {
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus({ preventScroll: true });
    };
  }, [ringing]);

  if (!incomingCall) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[70] flex justify-center px-3 pt-[max(12px,env(safe-area-inset-top))]">
      <div
        role="alertdialog"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="pop-in pointer-events-auto w-full max-w-[420px] rounded-[var(--radius-lg)] border border-line bg-raised p-4 shadow-lg"
        style={{ transformOrigin: "top" }}
      >
        <div className="flex items-center gap-3.5">
          <div className="pulse-ring shrink-0 rounded-full">
            <Avatar colorId={incomingCall.fromUserId} name={incomingCall.fromUsername} size={52} />
          </div>
          <div className="min-w-0 flex-1">
            <div id={titleId} className="truncate text-[17px] font-bold text-fg">
              {incomingCall.fromUsername}
            </div>
            <div id={descId} className="truncate text-[14px] text-muted">
              {incomingCall.isPrivate ? "Incoming call" : "Incoming group call"}
            </div>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2.5">
          <Button variant="danger" onClick={declineIncomingCall}>
            <PhoneOff className="size-[18px]" strokeWidth={2} aria-hidden />
            Decline
          </Button>
          <Button ref={acceptRef} onClick={acceptIncomingCall} className="bg-success text-canvas hover:bg-success hover:brightness-110">
            <Phone className="size-[18px]" strokeWidth={2} aria-hidden />
            Accept
          </Button>
        </div>
      </div>
    </div>
  );
}
