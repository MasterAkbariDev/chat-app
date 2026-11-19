"use client";

import dynamic from "next/dynamic";
import { PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { IncomingCallBanner } from "@/components/calls/IncomingCallBanner";
import { useCall } from "@/contexts/call-context";

// `livekit-client` + `@livekit/components-react` are a genuinely heavy
// dependency (WebRTC, media-device handling) needed only the instant a call
// actually starts or rings — not on every `/app/*` page load, which is what
// a static import here would cost (Architecture Rules #27: "call UI" is
// named explicitly as something that must be `next/dynamic`). `ssr: false`
// since LiveKit's client SDK assumes browser APIs (WebRTC, MediaDevices)
// that don't exist during server rendering.
const CallView = dynamic(() => import("@/components/calls/CallView").then(m => m.CallView), { ssr: false });

/** Mounted once in AppShell (same spot as NotificationsHost/ResyncHost) so a
 * ring or an active call renders full-screen regardless of which route is
 * open underneath it. */
export function CallOverlay() {
  const { activeCall, incomingCall, error, endCall, dismissError } = useCall();

  return (
    <>
      {activeCall ? <CallView call={activeCall} onLeave={endCall} /> : incomingCall ? <IncomingCallBanner /> : null}
      {error ? (
        <div className="pointer-events-none fixed inset-x-0 top-0 z-[80] flex justify-center px-3 pt-[max(12px,env(safe-area-inset-top))]">
          <div
            role="alert"
            className="pop-in pointer-events-auto flex w-full max-w-[420px] items-center gap-3 rounded-[var(--radius-md)] border border-line bg-raised py-2 pe-2 ps-3.5 shadow-lg"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger">
              <PhoneOff className="size-4" strokeWidth={2} aria-hidden />
            </span>
            <span className="min-w-0 flex-1 text-[14px] font-medium text-fg">{error}</span>
            <Button variant="ghost" size="sm" onClick={dismissError}>
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
