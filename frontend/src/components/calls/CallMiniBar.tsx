"use client";

import { forwardRef } from "react";
import { useIsSpeaking, useLocalParticipant, useRemoteParticipants, useSpeakingParticipants } from "@livekit/components-react";
import type { Participant } from "livekit-client";
import { Maximize2, Mic, MicOff, PhoneOff } from "lucide-react";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/ui/Avatar";
import type { ActiveCall } from "@/contexts/call-context";
import { useParticipantDisplay } from "./call-hooks";
import { DraggableCorner } from "./DraggableCorner";

/** The call, minimized: a small draggable card so the user can keep
 * chatting. The room stays connected underneath (audio keeps playing, your
 * camera keeps publishing). Tap the card to go back to the full screen. */
export const CallMiniBar = forwardRef<
  HTMLButtonElement,
  { call: ActiveCall; status: React.ReactNode; onExpand: () => void; onLeave: () => void }
>(function CallMiniBar({ call, status, onExpand, onLeave }, expandRef) {
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();
  const remotes = useRemoteParticipants();
  const speakers = useSpeakingParticipants();
  const featured: Participant | undefined = speakers.find((p) => !p.isLocal) ?? remotes[0];

  return (
    <DraggableCorner
      fixed
      label="Ongoing call"
      width="min(320px, calc(100vw - 24px))"
      height={64}
      defaultCorner="top-end"
      offsets={{
        top: "calc(max(12px, env(safe-area-inset-top)) + 60px)",
        bottom: "calc(max(12px, env(safe-area-inset-bottom)) + 76px)",
        side: "12px",
      }}
      className="z-[65]"
    >
      <div
        data-call-mini
        className="pop-in flex h-full items-center gap-1 rounded-full border border-white/10 bg-[var(--call-bg)] py-1.5 pe-1.5 ps-1.5 text-white shadow-lg [color-scheme:dark]"
      >
        <button
          ref={expandRef}
          type="button"
          onClick={onExpand}
          aria-label={`Return to call with ${call.title}`}
          className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-full pe-2 text-start outline-offset-2 focus-visible:outline-white"
        >
          {featured ? <SpeakerAvatar participant={featured} /> : <FallbackAvatar call={call} />}
          <span className="min-w-0 flex-1">
            <bdi className="block truncate text-[14px] font-semibold leading-tight">{call.title}</bdi>
            <span className="block truncate text-[12.5px] leading-tight text-white/65">{status}</span>
          </span>
          <Maximize2 className="size-4 shrink-0 text-white/60" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled).catch(() => {})}
          aria-pressed={!isMicrophoneEnabled}
          aria-label={isMicrophoneEnabled ? "Mute" : "Unmute"}
          title={isMicrophoneEnabled ? "Mute" : "Unmute"}
          className={cn(
            "pressable flex size-11 shrink-0 items-center justify-center rounded-full",
            isMicrophoneEnabled ? "bg-white/12 hover:bg-white/20" : "bg-white text-[var(--call-bg)]",
          )}
        >
          {isMicrophoneEnabled ? <Mic className="size-5" aria-hidden /> : <MicOff className="size-5" aria-hidden />}
        </button>
        <button
          type="button"
          onClick={onLeave}
          aria-label="End call"
          title="End call"
          className="pressable flex size-11 shrink-0 items-center justify-center rounded-full bg-[var(--call-danger)] hover:brightness-110"
        >
          <PhoneOff className="size-5" aria-hidden />
        </button>
      </div>
    </DraggableCorner>
  );
});

function SpeakerAvatar({ participant }: { participant: Participant }) {
  const { name, photo, colorId } = useParticipantDisplay(participant);
  const speaking = useIsSpeaking(participant);
  return (
    <span className={cn("shrink-0 rounded-full p-0.5 ring-2 transition-shadow", speaking ? "ring-[var(--call-speaking)]" : "ring-transparent")}>
      <Avatar colorId={colorId} name={name} src={photo} size={40} />
    </span>
  );
}

function FallbackAvatar({ call }: { call: ActiveCall }) {
  return (
    <span className="shrink-0 p-0.5">
      <Avatar colorId={call.peerId ?? call.channelId} name={call.title} src={call.photo} size={40} shape={call.isPrivate ? "circle" : "square"} />
    </span>
  );
}
