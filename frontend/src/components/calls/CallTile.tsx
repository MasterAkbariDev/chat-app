"use client";

import { useId, useRef, useState } from "react";
import {
  useConnectionQualityIndicator,
  useIsSpeaking,
  useTrackMutedIndicator,
  VideoTrack,
} from "@livekit/components-react";
import { ConnectionQuality, Track, type Participant, type RemoteParticipant, type TrackPublication } from "livekit-client";
import { Maximize2, MicOff, Minimize2, MonitorUp, SignalLow, Volume2, VolumeX, WifiOff } from "lucide-react";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/ui/Avatar";
import { usePerformance } from "@/contexts/performance-context";
import { useElementSize, useParticipantDisplay, useVideoPublication } from "./call-hooks";

export type TileVariant = "grid" | "stage" | "pip" | "film";

export interface CallTileProps {
  participant: Participant;
  source?: Track.Source;
  variant: TileVariant;
  /** Single tap / Enter: spotlight this tile (or swap, for the self-view). */
  onActivate?: () => void;
  activateLabel?: string;
  /** Double tap / the corner button: full-screen this tile. */
  onMaximize?: () => void;
  maximized?: boolean;
  /** Stage tile that may crop a little when the video's shape matches the
   *  tile (the other person in a 1:1 call); otherwise stage tiles never crop. */
  fill?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/** One person (or one screen share) on the call stage. Never a black box:
 * the avatar sits underneath and the video only covers it once a real frame
 * has arrived, and it's unmounted the moment the camera is muted,
 * unpublished or its track ends. */
export function CallTile({
  participant,
  source = Track.Source.Camera,
  variant,
  onActivate,
  activateLabel,
  onMaximize,
  maximized,
  fill,
  className,
  style,
}: CallTileProps) {
  const { name, photo, isLocal, colorId } = useParticipantDisplay(participant);
  const { publication, on: videoOn, mirror } = useVideoPublication(participant, source);
  const speaking = useIsSpeaking(participant);
  const { isMuted: micMuted } = useTrackMutedIndicator({ participant, source: Track.Source.Microphone });
  const { quality } = useConnectionQualityIndicator({ participant });
  const [sizeRef, size] = useElementSize<HTMLDivElement>();
  const lastTap = useRef(0);

  const isScreen = source === Track.Source.ScreenShare;
  // Re-read on every render: the tile already re-renders on this
  // participant's track events (useVideoPublication subscribes to them).
  const audioPub = isScreen ? participant.getTrackPublication(Track.Source.ScreenShareAudio) : undefined;
  const shareAudio = !!audioPub && !audioPub.isMuted;
  const label = isScreen ? (isLocal ? "Your screen" : `${name}'s screen`) : isLocal ? `${name} (you)` : name;
  const compact = variant === "pip" || variant === "film";
  const minSide = Math.min(size.width, size.height) || (compact ? 96 : 240);
  const avatarSize = Math.round(Math.max(32, Math.min(variant === "stage" ? 148 : 120, minSide * (compact ? 0.5 : 0.36))));
  const poor = quality === ConnectionQuality.Poor || quality === ConnectionQuality.Lost;
  const showSpeaking = speaking && !isScreen;

  function onClick(e: React.MouseEvent) {
    // A second tap within ~⅓ s is a double tap → full screen. The first tap
    // already ran onActivate (spotlight), which full screen implies anyway,
    // so there's no need to delay single taps to disambiguate.
    if (onMaximize && e.timeStamp - lastTap.current < 320) {
      lastTap.current = 0;
      onMaximize();
      return;
    }
    lastTap.current = e.timeStamp;
    onActivate?.();
  }

  const status = [isScreen ? null : micMuted ? "muted" : null, showSpeaking ? "speaking" : null, videoOn ? null : isScreen ? null : "camera off"]
    .filter(Boolean)
    .join(", ");

  return (
    <div
      ref={sizeRef}
      data-call-tile={`${participant.identity}:${source}`}
      data-video={videoOn ? "on" : "off"}
      data-speaking={showSpeaking ? "true" : "false"}
      className={cn(
        "group/tile relative isolate overflow-hidden bg-[var(--call-tile)] text-white",
        variant === "pip" ? "rounded-[var(--radius-md)] shadow-lg" : variant === "film" ? "rounded-[var(--radius-sm)]" : "rounded-[var(--radius-md)]",
        maximized && "rounded-none",
        className,
      )}
      style={style}
    >
      {/* Avatar layer — always there, so a tile is never an empty black box. */}
      <div aria-hidden className="absolute inset-0 flex items-center justify-center">
        {isScreen ? (
          <MonitorUp className="size-10 text-white/40" strokeWidth={1.6} />
        ) : (
          <div className={cn("rounded-full", showSpeaking && !videoOn && "call-speaking-halo")}>
            <Avatar colorId={colorId} name={name} src={photo} size={avatarSize} />
          </div>
        )}
      </div>

      {videoOn && publication ? (
        <TileVideo
          key={publication.trackSid}
          participant={participant}
          source={source}
          publication={publication}
          fit={isScreen ? "contain" : variant === "stage" ? (fill ? "auto" : "contain") : compact ? "cover" : "auto"}
          backdrop={!isScreen}
          mirror={mirror}
          tileSize={size}
        />
      ) : null}

      {onActivate || onMaximize ? (
        <button
          type="button"
          data-call-control
          onClick={onClick}
          aria-label={activateLabel ?? `${label}${status ? ` (${status})` : ""}`}
          className="absolute inset-0 z-[1] cursor-pointer rounded-[inherit] outline-offset-[-3px] focus-visible:outline-2 focus-visible:outline-white"
        />
      ) : null}

      {/* Speaking ring — a solid border, so it reads on top of video too. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 z-[2] rounded-[inherit] border-[3px] border-[var(--call-speaking)] transition-opacity duration-[var(--dur-base)]",
          showSpeaking ? "opacity-100" : "opacity-0",
        )}
      />

      {variant === "pip" ? (
        micMuted ? (
          <span aria-hidden className="absolute bottom-1.5 start-1.5 z-[3] flex size-6 items-center justify-center rounded-full bg-black/60">
            <MicOff className="size-3.5 text-[var(--call-danger-text)]" strokeWidth={2.2} />
          </span>
        ) : null
      ) : (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute z-[3] flex max-w-[calc(100%-12px)] items-center gap-1 rounded-full bg-black/55 font-medium",
            variant === "film" ? "bottom-1 start-1 px-1.5 py-0.5 text-[12px]" : "bottom-2 start-2 px-2.5 py-1 text-[13px]",
          )}
        >
          {micMuted && !isScreen ? <MicOff className="size-3.5 shrink-0 text-[var(--call-danger-text)]" strokeWidth={2.2} /> : null}
          <bdi className="truncate">{label}</bdi>
          {shareAudio ? (
            <span data-share-audio className="flex shrink-0 items-center gap-0.5 text-white/80">
              <Volume2 className="size-3.5" strokeWidth={2.2} />
              {compact ? null : <span>{isLocal ? "Sharing sound" : "With sound"}</span>}
            </span>
          ) : null}
        </div>
      )}
      {shareAudio && !isLocal && !compact ? <ShareVolume participant={participant as RemoteParticipant} /> : null}

      {poor && !compact ? (
        <span
          title={quality === ConnectionQuality.Lost ? "Connection lost" : "Weak connection"}
          className="absolute start-2 top-2 z-[3] flex size-7 items-center justify-center rounded-full bg-black/55 text-[var(--call-warning)]"
        >
          {quality === ConnectionQuality.Lost ? <WifiOff className="size-4" aria-hidden /> : <SignalLow className="size-4" aria-hidden />}
          <span className="sr-only">{quality === ConnectionQuality.Lost ? "Connection lost" : "Weak connection"}</span>
        </span>
      ) : null}

      {onMaximize && !compact ? (
        <button
          type="button"
          data-call-control
          onClick={onMaximize}
          aria-label={maximized ? "Exit full screen" : `Full screen: ${label}`}
          title={maximized ? "Exit full screen" : "Full screen"}
          className={cn(
            "absolute bottom-1.5 end-1.5 z-[3] flex size-10 items-center justify-center rounded-full text-white transition-opacity",
            "bg-black/45 hover:bg-black/65 focus-visible:opacity-100",
            maximized || variant === "stage" ? "opacity-100" : "opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/tile:opacity-100",
          )}
        >
          {maximized ? <Minimize2 className="size-[18px]" aria-hidden /> : <Maximize2 className="size-[18px]" aria-hidden />}
        </button>
      ) : null}
    </div>
  );
}

type VideoFit = "cover" | "contain" | "auto";

/** Picks how a video sits in its tile from the video's *real* size (phone
 * cameras are often portrait; screens are anything): `cover` when the shapes
 * roughly match (a little cropping is fine), otherwise `contain` over a
 * blurred, darkened copy of the same video (Telegram style) so nothing is
 * cropped away or stretched and there are no harsh black bars. Reacts to
 * rotation/resolution changes via the element's `resize` event. */
function TileVideo({
  participant,
  source,
  publication,
  fit,
  backdrop,
  mirror,
  tileSize,
}: {
  participant: Participant;
  source: Track.Source;
  publication: TrackPublication;
  fit: VideoFit;
  backdrop: boolean;
  mirror: boolean;
  tileSize: { width: number; height: number };
}) {
  // Held transparent until the first frame decodes — otherwise a freshly
  // (re)started camera shows as a black rectangle for a beat.
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const { lite } = usePerformance();
  const onFrame = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const { videoWidth: w, videoHeight: h } = e.currentTarget;
    if (w && h) setDims((d) => (d && d.w === w && d.h === h ? d : { w, h }));
  };

  let effective: "cover" | "contain" = fit === "auto" ? "cover" : fit;
  if (fit === "auto" && dims && tileSize.width && tileSize.height) {
    const va = dims.w / dims.h;
    const ta = tileSize.width / tileSize.height;
    effective = Math.max(va / ta, ta / va) > 1.3 ? "contain" : "cover";
  }
  const showBackdrop = backdrop && effective === "contain" && !lite && !!dims;
  const ref = { participant, source, publication };

  return (
    <>
      {showBackdrop ? (
        <VideoTrack
          trackRef={ref}
          aria-hidden
          muted
          playsInline
          className="pointer-events-none absolute inset-0 size-full scale-110 object-cover opacity-70 blur-2xl brightness-[0.55]"
        />
      ) : null}
      <VideoTrack
        trackRef={ref}
        onLoadedData={onFrame}
        onResize={onFrame}
        muted
        playsInline
        data-video-size={dims ? `${dims.w}x${dims.h}` : undefined}
        data-fit={effective}
        className={cn(
          "absolute inset-0 size-full transition-opacity duration-[var(--dur-base)]",
          effective === "contain" ? "object-contain" : "object-cover",
          mirror && "-scale-x-100",
          dims ? "opacity-100" : "opacity-0",
          // Letterbox bars over the avatar layer when there's no backdrop.
          dims && effective === "contain" && !showBackdrop && "bg-[var(--call-tile)]",
        )}
      />
    </>
  );
}

/** Volume for someone else's shared audio, on their screen-share tile. */
function ShareVolume({ participant }: { participant: RemoteParticipant }) {
  const [open, setOpen] = useState(false);
  const [volume, setVolume] = useState(() => Math.round((participant.getVolume(Track.Source.ScreenShareAudio) ?? 1) * 100));
  const id = useId();
  function apply(v: number) {
    setVolume(v);
    participant.setVolume(v / 100, Track.Source.ScreenShareAudio);
  }
  return (
    <div className="absolute end-1.5 top-1.5 z-[4] flex items-center gap-1 rounded-full bg-black/55">
      {open ? (
        <input
          id={id}
          type="range"
          min={0}
          max={100}
          step={5}
          value={volume}
          onChange={(e) => apply(Number(e.target.value))}
          aria-label="Shared audio volume"
          aria-valuetext={`${volume}%`}
          className="ms-3 w-28 accent-white"
        />
      ) : null}
      <button
        type="button"
        data-call-control
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={open ? "Hide volume" : `Shared audio volume (${volume}%)`}
        title="Shared audio volume"
        className="flex size-10 items-center justify-center rounded-full text-white hover:bg-black/30"
      >
        {volume === 0 ? <VolumeX className="size-[18px]" aria-hidden /> : <Volume2 className="size-[18px]" aria-hidden />}
      </button>
    </div>
  );
}
