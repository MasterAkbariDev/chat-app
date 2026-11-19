"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isTrackReference,
  LiveKitRoom,
  RoomAudioRenderer,
  useAudioPlayback,
  useConnectionState,
  useLocalParticipant,
  useRoomContext,
  useTracks,
} from "@livekit/components-react";
import { ConnectionState, RoomEvent, Track } from "livekit-client";
import { ChevronDown, LayoutGrid, Loader2, PhoneMissed, PictureInPicture2, Settings2, Users, Volume2, VolumeX, Wifi } from "lucide-react";
import type { ActiveCall } from "@/contexts/call-context";
import { enableCamera, ROOM_OPTIONS } from "./call-media";
import { ActiveCallContext, describeDeviceIssue, toDeviceIssue, useIsTouchDevice, type DeviceIssue } from "./call-hooks";
import { formatDuration, pickLayout } from "./call-utils";
import { CallControls, type CallSheetKind } from "./CallControls";
import { CallMiniBar } from "./CallMiniBar";
import { CallDevicesDialog, CallParticipantsDialog, CallShareDialog } from "./CallSheets";
import { CallStage, type StageTile } from "./CallStage";
import { CallQualityProvider } from "./call-quality";
import { useCallAudioRoute, type CallAudioRouteState } from "./call-audio-route";
import { useShareEchoGuard } from "./share-echo-guard";

/** The call screen's own dark palette — the stage is always dark (video
 * reads best on near-black), independent of the app theme. Status colours
 * reuse Hearth's dark-mode values. */
const CALL_VARS = {
  "--call-bg": "#0c0d12",
  "--call-tile": "#1b1d26",
  "--call-speaking": "#4ccf8a",
  "--call-danger": "#e5484d",
  "--call-danger-text": "#ff8a8a",
  "--call-warning": "#f5b94a",
} as React.CSSProperties;

/** The avatar halo while someone talks (no video): a steady ring plus a
 * soft pulse. The global reduced-motion rule stops the pulse. */
const CALL_CSS = `
.call-speaking-halo {
  outline: 3px solid var(--call-speaking);
  outline-offset: 4px;
  animation: call-speak 1.4s ease-out infinite;
}
@keyframes call-speak {
  0% { box-shadow: 0 0 0 4px rgb(76 207 138 / 0.45); }
  100% { box-shadow: 0 0 0 18px rgb(76 207 138 / 0); }
}
`;


/** Mounted for the whole lifetime of an active call (see CallOverlay). The
 * LiveKit room lives here and stays connected whether the call is shown
 * full screen or minimized to the floating card; unmounting it (End call,
 * the other side hanging up) disconnects and stops every local track. */
export function CallView({ call, onLeave }: { call: ActiveCall; onLeave: () => void }) {
  const [connectError, setConnectError] = useState<string | null>(null);
  return (
    <ActiveCallContext.Provider value={call}>
      <LiveKitRoom
        serverUrl={call.livekitUrl}
        token={call.roomToken}
        connect
        options={ROOM_OPTIONS}
        onDisconnected={onLeave}
        onError={(err) => setConnectError(err.message)}
        className="contents"
        style={CALL_VARS}
      >
        <style href="call-view-styles" precedence="medium">{CALL_CSS}</style>
        <RoomAudioRenderer />
        <CallQualityProvider>
          <CallSession call={call} onLeave={onLeave} connectError={connectError} />
        </CallQualityProvider>
      </LiveKitRoom>
    </ActiveCallContext.Provider>
  );
}

function CallSession({ call, onLeave, connectError }: { call: ActiveCall; onLeave: () => void; connectError: string | null }) {
  const room = useRoomContext();
  const connectionState = useConnectionState(room);
  // Earpiece/speaker lives here (not in CallSurface) so it keeps applying
  // while the call is minimized. Video on (either side) → speaker default.
  const videoOn = useTracks([Track.Source.Camera], { onlySubscribed: false }).some((r) => r.publication && !r.publication.isMuted);
  const audioRoute = useCallAudioRoute(room, videoOn);
  // A screen share with system sound would send everyone's own voice back to them (see share-echo-guard.ts).
  useShareEchoGuard(room);
  const [minimized, setMinimized] = useState(false);
  const [answeredAt, setAnsweredAt] = useState<number | null>(null);
  const [deviceIssue, setDeviceIssue] = useState<DeviceIssue | null>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const minimizeRef = useRef<HTMLButtonElement>(null);

  const connected = connectionState === ConnectionState.Connected;

  // Publishing the mic only once connected (not `<LiveKitRoom audio>`): a
  // device error during the join negotiation would fail the whole
  // connection; this way "no working microphone" just means "joined muted".
  const micStarted = useRef(false);
  useEffect(() => {
    // Only on the first connect — not on every reconnect, which would undo
    // a deliberate mute.
    if (!connected || micStarted.current) return;
    micStarted.current = true;
    room.localParticipant.setMicrophoneEnabled(true).catch((e) => setDeviceIssue(toDeviceIssue("mic", e)));
  }, [connected, room]);

  // The timer starts once someone else is actually there (the backend's own
  // definition of "answered"), and keeps running if people come and go.
  useEffect(() => {
    const mark = () => {
      if (room.remoteParticipants.size > 0) setAnsweredAt((t) => t ?? Date.now());
    };
    room.on(RoomEvent.ParticipantConnected, mark).on(RoomEvent.Connected, mark);
    return () => {
      room.off(RoomEvent.ParticipantConnected, mark).off(RoomEvent.Connected, mark);
    };
  }, [room]);

  const reconnecting = connectionState === ConnectionState.Reconnecting || connectionState === ConnectionState.SignalReconnecting;
  const statusText = reconnecting ? "Reconnecting…" : !connected ? "Connecting…" : answeredAt === null ? (call.isPrivate ? "Ringing…" : "Waiting for others…") : null;
  const status = statusText ?? <CallTimer since={answeredAt!} />;

  const minimize = useCallback(() => {
    setMinimized(true);
    requestAnimationFrame(() => expandRef.current?.focus({ preventScroll: true }));
  }, []);
  const expand = useCallback(() => {
    setMinimized(false);
    requestAnimationFrame(() => minimizeRef.current?.focus({ preventScroll: true }));
  }, []);

  if (connectError && connectionState !== ConnectionState.Connected) {
    return <ConnectErrorScreen message={connectError} onClose={onLeave} />;
  }

  if (minimized) {
    return <CallMiniBar ref={expandRef} call={call} status={status} onExpand={expand} onLeave={onLeave} />;
  }

  return (
    <CallSurface
      call={call}
      status={status}
      statusText={statusText}
      reconnecting={reconnecting}
      onLeave={onLeave}
      onMinimize={minimize}
      minimizeRef={minimizeRef}
      deviceIssue={deviceIssue}
      onDeviceIssue={setDeviceIssue}
      audioRoute={audioRoute}
    />
  );
}

function CallTimer({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const text = formatDuration(Math.max(0, Math.floor((now - since) / 1000)));
  return (
    <span className="tabular inline-flex items-center gap-1.5">
      <span aria-hidden className="size-2 rounded-full bg-[var(--call-speaking)]" />
      <span>{text}</span>
    </span>
  );
}

function CallSurface({
  call,
  status,
  statusText,
  reconnecting,
  onLeave,
  onMinimize,
  minimizeRef,
  deviceIssue,
  onDeviceIssue,
  audioRoute,
}: {
  call: ActiveCall;
  status: React.ReactNode;
  statusText: string | null;
  reconnecting: boolean;
  onLeave: () => void;
  onMinimize: () => void;
  minimizeRef: React.RefObject<HTMLButtonElement | null>;
  deviceIssue: DeviceIssue | null;
  onDeviceIssue: (issue: DeviceIssue | null) => void;
  audioRoute: CallAudioRouteState;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { localParticipant, isScreenShareEnabled } = useLocalParticipant();
  const { canPlayAudio, startAudio } = useAudioPlayback();
  const [sheet, setSheet] = useState<CallSheetKind | "participants" | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [preferGrid, setPreferGrid] = useState(false);
  const [maximizedKey, setMaximizedKey] = useState<string | null>(null);
  const [swapped, setSwapped] = useState(false);
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  // Phones: the bottom row's first button is the Speaker toggle, so the
  // device pickers (mic, camera, outputs) open from the header instead.
  const touch = useIsTouchDevice();

  // Every participant's camera slot (a placeholder when they have none, so
  // camera-off people still get a tile) plus any screen shares.
  const cameraRefs = useTracks([{ source: Track.Source.Camera, withPlaceholder: true }], { onlySubscribed: false });
  const screenRefs = useTracks([Track.Source.ScreenShare], { onlySubscribed: false }).filter(isTrackReference);

  const tiles: StageTile[] = useMemo(() => {
    const cams = [...cameraRefs].sort((a, b) => {
      if (a.participant.isLocal !== b.participant.isLocal) return a.participant.isLocal ? -1 : 1;
      return (a.participant.joinedAt?.getTime() ?? 0) - (b.participant.joinedAt?.getTime() ?? 0);
    });
    return [
      ...screenRefs.map((r) => ({ key: `${r.participant.identity}:screen`, participant: r.participant, source: Track.Source.ScreenShare })),
      ...cams.map((r) => ({ key: `${r.participant.identity || "local"}:camera`, participant: r.participant, source: Track.Source.Camera })),
    ];
  }, [cameraRefs, screenRefs]);

  const participantCount = cameraRefs.length;
  const anyCameraOn = cameraRefs.some((r) => r.publication && !r.publication.isMuted && (!r.participant.isLocal || !!r.publication.track));
  const screenShareKey = tiles.find((t) => t.source === Track.Source.ScreenShare)?.key ?? null;

  // A screen share that starts later takes the spotlight automatically.
  const lastScreenKey = useRef<string | null>(null);
  useEffect(() => {
    if (screenShareKey && screenShareKey !== lastScreenKey.current) {
      setFocusKey(screenShareKey);
      setPreferGrid(false);
    }
    lastScreenKey.current = screenShareKey;
  }, [screenShareKey]);

  const { layout, focusKey: stageFocus } = pickLayout({
    tileKeys: tiles.map((t) => t.key),
    participantCount,
    screenShareKey,
    focusKey,
    anyCameraOn,
    preferGrid,
  });

  // A maximized tile whose person left / stopped sharing just closes.
  const maximized = maximizedKey && tiles.some((t) => t.key === maximizedKey) ? maximizedKey : null;

  const setMaximized = useCallback((key: string | null) => {
    setMaximizedKey(key);
    if (key) setFocusKey((f) => f ?? key);
    const root = rootRef.current;
    if (key && root && document.fullscreenEnabled && !document.fullscreenElement) {
      root.requestFullscreen?.().catch(() => {});
    } else if (!key && document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    }
  }, []);

  // Leaving browser full screen (Esc, system gesture) leaves maximized too.
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setMaximizedKey(null);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  useEffect(() => {
    if (!maximized && document.fullscreenElement === rootRef.current) document.exitFullscreen?.().catch(() => {});
  }, [maximized]);

  // Esc leaves the maximized view even when focus isn't inside the call
  // root (the tile that had focus re-renders on maximize, dropping focus to
  // <body>), and focus lands on the exit button so the keyboard path works.
  useEffect(() => {
    if (!maximized) return;
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>('button[aria-label="Exit full screen"]')?.focus({ preventScroll: true }));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      setMaximized(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [maximized, setMaximized]);

  // Focus moves in on mount; Tab stays inside (the app underneath is covered).
  useEffect(() => {
    // The dialog itself (not its first button): no focus ring flashes on
    // a phone right after tapping Accept, and Tab goes straight to the controls.
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (!rootRef.current || sheet) return;
    if (e.key === "Escape") {
      if (maximized) {
        // Handled by the window listener below.
      } else if (focusKey) {
        e.preventDefault();
        setFocusKey(null);
      }
      return;
    }
    if (e.key !== "Tab") return;
    const nodes = Array.from(rootRef.current.querySelectorAll<HTMLElement>("button:not([disabled]),a[href],[tabindex]:not([tabindex='-1'])"));
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === rootRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const canSpotlight = layout === "grid" && (screenShareKey || (participantCount === 2 && anyCameraOn)) && preferGrid;
  const showGridToggle = layout === "spotlight" || layout === "duo";

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Call with ${call.title}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-call-layout={maximized ? "maximized" : layout}
      className="fade-in fixed inset-0 z-[70] flex flex-col bg-[var(--call-bg)] text-white outline-none [color-scheme:dark]"
    >
      {!maximized ? (
        <header className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 px-2 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-4">
          <div className="flex justify-start">
            <HeaderButton ref={minimizeRef} label="Minimize call" onClick={onMinimize}>
              <ChevronDown aria-hidden />
            </HeaderButton>
          </div>
          <div className="min-w-0 max-w-[60vw] text-center">
            <h2 className="truncate text-[17px] font-semibold leading-tight">
              <bdi>{call.title}</bdi>
            </h2>
            <div className="mt-0.5 text-[13.5px] text-white/65">{status}</div>
          </div>
          <div className="flex justify-end gap-1">
            {showGridToggle ? (
              <HeaderButton
                label="Show everyone"
                onClick={() => {
                  setFocusKey(null);
                  setPreferGrid(true);
                }}
              >
                <LayoutGrid aria-hidden />
              </HeaderButton>
            ) : canSpotlight ? (
              <HeaderButton label="Speaker view" onClick={() => setPreferGrid(false)}>
                <PictureInPicture2 aria-hidden />
              </HeaderButton>
            ) : null}
            {touch ? (
              <HeaderButton label="Microphone, camera and sound" onClick={() => setSheet("speaker")} haspopup>
                <Settings2 aria-hidden />
              </HeaderButton>
            ) : null}
            <HeaderButton label={`Participants (${participantCount})`} onClick={() => setSheet("participants")} haspopup>
              <Users aria-hidden />
              {participantCount > 1 ? (
                <span aria-hidden className="tabular absolute -end-0.5 -top-0.5 min-w-[18px] rounded-full bg-white px-1 text-[11px] font-bold leading-[18px] text-[var(--call-bg)]">
                  {participantCount}
                </span>
              ) : null}
            </HeaderButton>
          </div>
        </header>
      ) : null}

      {/* Announce state changes (not every timer tick) to screen readers. */}
      <span role="status" className="sr-only">
        {statusText ?? "Call connected"}
      </span>

      {!maximized ? (
        <div className="flex shrink-0 flex-col items-center gap-2 px-3 empty:hidden">
          {reconnecting ? (
            <Banner tone="warning" icon={<Loader2 className="size-4 animate-spin" aria-hidden />}>
              Connection lost. Reconnecting…
            </Banner>
          ) : null}
          <ReconnectedNotice reconnecting={reconnecting} />
          {!canPlayAudio ? (
            <Banner tone="neutral" icon={<Volume2 className="size-4" aria-hidden />} action={{ label: "Turn on sound", onClick: () => startAudio() }}>
              Your browser paused the call audio.
            </Banner>
          ) : null}
          {deviceIssue ? (
            <Banner
              tone="danger"
              action={{
                label: "Try again",
                onClick: () => {
                  const p =
                    deviceIssue.kind === "mic" ? localParticipant.setMicrophoneEnabled(true) : enableCamera(localParticipant);
                  p.then(() => onDeviceIssue(null)).catch((e) => onDeviceIssue(toDeviceIssue(deviceIssue.kind, e)));
                },
              }}
              onDismiss={() => onDeviceIssue(null)}
            >
              {describeDeviceIssue(deviceIssue)}
            </Banner>
          ) : null}
          {shareNotice && isScreenShareEnabled ? (
            <Banner
              tone="warning"
              icon={<VolumeX className="size-4" aria-hidden />}
              action={{
                label: "Share again",
                onClick: () => {
                  setShareNotice(null);
                  void localParticipant.setScreenShareEnabled(false).finally(() => setSheet("share"));
                },
              }}
              onDismiss={() => setShareNotice(null)}
            >
              {shareNotice}
            </Banner>
          ) : null}
        </div>
      ) : null}

      <main className="relative min-h-0 flex-1 overflow-hidden pt-1">
        <CallStage
          layout={layout}
          tiles={tiles}
          focusKey={stageFocus}
          maximizedKey={maximized}
          swapped={swapped}
          statusText={statusText ?? "You're the only one here"}
          onFocus={(key) => {
            setFocusKey(key);
            if (key) setPreferGrid(false);
          }}
          onMaximize={setMaximized}
          onSwap={() => setSwapped((s) => !s)}
        />
      </main>

      {!maximized ? (
        <CallControls onLeave={onLeave} onOpenSheet={setSheet} deviceIssue={deviceIssue} onDeviceIssue={onDeviceIssue} audioRoute={audioRoute} />
      ) : null}

      {sheet === "devices" || sheet === "speaker" ? <CallDevicesDialog mode={sheet} onClose={() => setSheet(null)} audioRoute={audioRoute} /> : null}
      {sheet === "share" ? <CallShareDialog onClose={() => setSheet(null)} onNoAudio={setShareNotice} /> : null}
      {sheet === "participants" ? (
        <CallParticipantsDialog
          onClose={() => setSheet(null)}
          onSpotlight={(identity) => {
            const key = tiles.find((t) => t.participant.identity === identity && t.source === Track.Source.Camera)?.key;
            if (key && tiles.length > 1) {
              setFocusKey(key);
              setPreferGrid(false);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function ReconnectedNotice({ reconnecting }: { reconnecting: boolean }) {
  const [show, setShow] = useState(false);
  const was = useRef(reconnecting);
  useEffect(() => {
    if (was.current && !reconnecting) {
      setShow(true);
      const id = setTimeout(() => setShow(false), 2500);
      was.current = reconnecting;
      return () => clearTimeout(id);
    }
    was.current = reconnecting;
  }, [reconnecting]);
  if (!show) return null;
  return (
    <Banner tone="success" icon={<Wifi className="size-4" aria-hidden />}>
      Reconnected
    </Banner>
  );
}

function Banner({
  tone,
  icon,
  children,
  action,
  onDismiss,
}: {
  tone: "warning" | "danger" | "success" | "neutral";
  icon?: React.ReactNode;
  children: React.ReactNode;
  action?: { label: string; onClick: () => void };
  onDismiss?: () => void;
}) {
  return (
    <div
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}
      className="pop-in flex w-full max-w-[480px] items-center gap-2.5 rounded-[var(--radius-md)] bg-white/10 py-1.5 pe-1.5 ps-3 text-[13.5px] leading-snug"
    >
      {icon ? (
        <span
          className={
            tone === "danger"
              ? "text-[var(--call-danger-text)]"
              : tone === "warning"
                ? "text-[var(--call-warning)]"
                : tone === "success"
                  ? "text-[var(--call-speaking)]"
                  : "text-white/80"
          }
        >
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 py-1">{children}</span>
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="pressable h-9 shrink-0 rounded-full bg-white px-3.5 text-[13.5px] font-semibold text-[var(--call-bg)] hover:bg-white/90"
        >
          {action.label}
        </button>
      ) : null}
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          className="pressable h-9 shrink-0 rounded-full px-3 text-[13.5px] font-medium text-white/80 hover:bg-white/10"
        >
          Dismiss
        </button>
      ) : null}
    </div>
  );
}

const HeaderButton = function HeaderButton({
  ref,
  label,
  onClick,
  children,
  haspopup,
  ...rest
}: {
  ref?: React.Ref<HTMLButtonElement>;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  haspopup?: boolean;
}) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-haspopup={haspopup ? "dialog" : undefined}
      className="pressable relative flex size-11 items-center justify-center rounded-full text-white/90 outline-offset-2 hover:bg-white/10 focus-visible:outline-white [&>svg]:size-[22px]"
      {...rest}
    >
      {children}
    </button>
  );
};

function ConnectErrorScreen({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div role="alertdialog" aria-modal="true" aria-label="Couldn't connect the call" className="fixed inset-0 z-[70] flex items-center justify-center bg-[var(--call-bg)] px-6 text-white [color-scheme:dark]">
      <div role="alert" className="pop-in flex w-full max-w-[360px] flex-col items-center text-center">
        <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-[#3a1a1d] text-[var(--call-danger-text)]">
          <PhoneMissed className="size-6" strokeWidth={1.8} aria-hidden />
        </div>
        <div className="text-[18px] font-bold">Couldn&apos;t connect the call</div>
        <p className="mt-1.5 text-[14px] leading-relaxed text-white/65">{message}</p>
        <p className="mt-1 text-[14px] leading-relaxed text-white/65">Check your internet connection, then try calling again.</p>
        <button
          type="button"
          autoFocus
          onClick={onClose}
          className="pressable mt-6 h-12 w-full rounded-[var(--radius-sm)] bg-white text-[15px] font-semibold text-[var(--call-bg)] hover:bg-white/90"
        >
          Close
        </button>
      </div>
    </div>
  );
}
