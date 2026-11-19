"use client";

import { useState } from "react";
import { useLocalParticipant, useMediaDeviceSelect, useRoomContext } from "@livekit/components-react";
import { Track, type LocalVideoTrack } from "livekit-client";
import { CAMERA_RESOLUTION, enableCamera } from "./call-media";
import { Ear, Headphones, Mic, MicOff, MonitorUp, PhoneOff, Settings2, SwitchCamera, Video, VideoOff, Volume2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { toDeviceIssue, useIsTouchDevice, type DeviceIssue } from "./call-hooks";
import { IOS_ROUTE_HINT, type CallAudioRouteState } from "./call-audio-route";

/** Front ↔ back on phones (`facingMode`); on anything else, the next camera
 * in the list. Resolves to false when there was nothing to switch to. */
export async function flipCamera(
  room: ReturnType<typeof useRoomContext>,
  videoDevices: MediaDeviceInfo[],
  preferFacingMode: boolean,
): Promise<boolean> {
  const track = room.localParticipant.getTrackPublication(Track.Source.Camera)?.track as LocalVideoTrack | undefined;
  if (!track) return false;
  const settings = track.mediaStreamTrack?.getSettings?.() ?? {};
  // Phones report which way the camera faces — flip that (works even when
  // the browser lists a single "camera" for both). A laptop webcam reports
  // nothing, so cycle through the actual devices instead.
  if (settings.facingMode || (preferFacingMode && videoDevices.length < 2)) {
    const next = settings.facingMode === "environment" ? "user" : "environment";
    await track.restartTrack({ facingMode: next, resolution: CAMERA_RESOLUTION });
    return true;
  }
  if (videoDevices.length < 2) return false;
  const current = settings.deviceId ?? room.getActiveDevice("videoinput");
  const idx = videoDevices.findIndex((d) => d.deviceId === current);
  const next = videoDevices[(idx + 1) % videoDevices.length];
  await room.switchActiveDevice("videoinput", next.deviceId);
  return true;
}

export type CallSheetKind = "speaker" | "devices" | "share";

export function CallControls({
  onLeave,
  onOpenSheet,
  deviceIssue,
  onDeviceIssue,
  audioRoute,
}: {
  onLeave: () => void;
  onOpenSheet: (sheet: CallSheetKind) => void;
  deviceIssue: DeviceIssue | null;
  onDeviceIssue: (issue: DeviceIssue | null) => void;
  audioRoute?: CallAudioRouteState;
}) {
  const room = useRoomContext();
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled, isScreenShareEnabled } = useLocalParticipant();
  const { devices: videoDevices } = useMediaDeviceSelect({ kind: "videoinput", room });
  const touch = useIsTouchDevice();
  const [pending, setPending] = useState<"mic" | "camera" | "flip" | "screen" | null>(null);
  const canShareScreen = !touch && typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
  const canFlip = isCameraEnabled && (touch || videoDevices.length > 1);
  const [routeHint, setRouteHint] = useState<string | null>(null);
  // Phones get Telegram's Speaker toggle; desktop keeps the output picker.
  const routeToggle = touch && audioRoute && audioRoute.strategy !== "none" ? audioRoute : null;

  async function run(kind: "mic" | "camera" | "flip" | "screen", fn: () => Promise<unknown>) {
    if (pending) return;
    setPending(kind);
    try {
      await fn();
      if (deviceIssue && (deviceIssue.kind === kind || (kind === "flip" && deviceIssue.kind === "camera"))) onDeviceIssue(null);
    } catch (e) {
      // Cancelling the browser's screen picker isn't an error worth showing.
      if (kind !== "screen") onDeviceIssue(toDeviceIssue(kind === "mic" ? "mic" : "camera", e));
    } finally {
      setPending(null);
    }
  }

  return (
    <>
    {routeHint ? (
      <p role="status" className="mx-auto max-w-[360px] px-4 pt-2 text-center text-[13px] text-white/75">
        {routeHint}
      </p>
    ) : null}
    <div
      role="toolbar"
      aria-label="Call controls"
      className="flex shrink-0 items-start justify-center gap-1.5 px-2 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 sm:gap-4"
    >
      {routeToggle ? (
        <AudioRouteControl
          state={routeToggle}
          onHint={(hint) => {
            setRouteHint(hint);
            if (hint) setTimeout(() => setRouteHint((h) => (h === hint ? null : h)), 5000);
          }}
        />
      ) : (
        // Desktop (or a phone browser with no route control): every output
        // picker, speaker first.
        <CallControl
          label="Speaker"
          onClick={() => onOpenSheet("speaker")}
          icon={<Volume2 strokeWidth={1.9} aria-hidden />}
          haspopup
        />
      )}
      {!touch ? (
        <CallControl
          label="Microphone and camera"
          shortLabel="Devices"
          onClick={() => onOpenSheet("devices")}
          icon={<Settings2 strokeWidth={1.9} aria-hidden />}
          haspopup
        />
      ) : null}
      <CallControl
        label={isCameraEnabled ? "Stop video" : "Start video"}
        shortLabel="Video"
        pressed={isCameraEnabled}
        busy={pending === "camera"}
        warn={deviceIssue?.kind === "camera"}
        onClick={() => run("camera", () => enableCamera(localParticipant, !isCameraEnabled))}
        icon={isCameraEnabled ? <Video strokeWidth={1.9} aria-hidden /> : <VideoOff strokeWidth={1.9} aria-hidden />}
      />
      {canFlip ? (
        <CallControl
          label="Flip camera"
          shortLabel="Flip"
          busy={pending === "flip"}
          onClick={() => run("flip", () => flipCamera(room, videoDevices, touch))}
          icon={<SwitchCamera strokeWidth={1.9} aria-hidden />}
        />
      ) : null}
      {canShareScreen ? (
        <CallControl
          label={isScreenShareEnabled ? "Stop sharing" : "Share screen"}
          shortLabel="Screen"
          pressed={isScreenShareEnabled}
          busy={pending === "screen"}
          haspopup={!isScreenShareEnabled}
          onClick={() => (isScreenShareEnabled ? run("screen", () => localParticipant.setScreenShareEnabled(false)) : onOpenSheet("share"))}
          icon={<MonitorUp strokeWidth={1.9} aria-hidden />}
        />
      ) : null}
      <CallControl
        label={isMicrophoneEnabled ? "Mute" : "Unmute"}
        shortLabel={isMicrophoneEnabled ? "Mute" : "Unmute"}
        pressed={!isMicrophoneEnabled}
        busy={pending === "mic"}
        warn={deviceIssue?.kind === "mic"}
        onClick={() => run("mic", () => localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled))}
        icon={isMicrophoneEnabled ? <Mic strokeWidth={1.9} aria-hidden /> : <MicOff strokeWidth={1.9} aria-hidden />}
      />
      <CallControl label="End call" shortLabel="End" danger onClick={onLeave} icon={<PhoneOff strokeWidth={2} aria-hidden />} />
    </div>
    </>
  );
}

/** Telegram's Speaker toggle: lit when the loudspeaker is on. With a headset
 *  connected the other state reads "Headset"; where the page can't choose
 *  (iPhone) it explains instead of pretending. */
function AudioRouteControl({ state, onHint }: { state: CallAudioRouteState; onHint: (hint: string | null) => void }) {
  if (state.strategy === "unsupported") {
    return (
      <CallControl
        label={`Speaker. ${IOS_ROUTE_HINT}`}
        shortLabel="Speaker"
        dimmed
        onClick={() => onHint(IOS_ROUTE_HINT)}
        icon={<Volume2 strokeWidth={1.9} aria-hidden />}
      />
    );
  }
  const speaker = state.route === "speaker";
  const other = state.headset ? "Headset" : "Earpiece";
  return (
    <CallControl
      label={speaker ? `Speaker on — switch to ${other.toLowerCase()}` : `Speaker off (${other.toLowerCase()}) — switch to speaker`}
      shortLabel={speaker ? "Speaker" : other}
      pressed={speaker}
      onClick={() => {
        onHint(null);
        state.toggle();
      }}
      icon={speaker ? <Volume2 strokeWidth={1.9} aria-hidden /> : state.headset ? <Headphones strokeWidth={1.9} aria-hidden /> : <Ear strokeWidth={1.9} aria-hidden />}
    />
  );
}

/** A 56px round call button with its label underneath. Toggles expose
 * their state with `aria-pressed` and flip to a filled white disc when "on". */
export function CallControl({
  label,
  shortLabel,
  icon,
  onClick,
  pressed,
  danger,
  busy,
  warn,
  haspopup,
  dimmed,
}: {
  label: string;
  shortLabel?: string;
  icon: React.ReactNode;
  onClick: () => void;
  pressed?: boolean;
  danger?: boolean;
  busy?: boolean;
  warn?: boolean;
  haspopup?: boolean;
  /** Shown but not actionable here (explains why on tap). */
  dimmed?: boolean;
}) {
  return (
    <button
      type="button"
      data-call-control
      onClick={onClick}
      aria-pressed={pressed}
      aria-busy={busy || undefined}
      aria-haspopup={haspopup ? "dialog" : undefined}
      aria-label={label}
      title={label}
      className="group flex w-[64px] flex-col items-center gap-1.5 rounded-[var(--radius-md)] text-[12.5px] font-medium text-white/85 outline-offset-4 focus-visible:outline-white sm:w-[72px] sm:text-[13px]"
    >
      <span
        className={cn(
          "pressable relative flex size-14 items-center justify-center rounded-full [&_svg]:size-6 group-active:scale-95",
          danger
            ? "bg-[var(--call-danger)] text-white group-hover:brightness-110"
            : pressed
              ? "bg-white text-[var(--call-bg)] group-hover:bg-white/90"
              : "bg-white/12 text-white group-hover:bg-white/20",
          busy && "opacity-70",
          dimmed && "opacity-50",
        )}
      >
        {icon}
        {warn ? <span aria-hidden className="absolute end-0.5 top-0.5 size-3 rounded-full border-2 border-[var(--call-bg)] bg-[var(--call-warning)]" /> : null}
      </span>
      <span aria-hidden className="max-w-full truncate">
        {shortLabel ?? label}
      </span>
    </button>
  );
}
