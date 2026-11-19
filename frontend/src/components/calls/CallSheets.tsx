"use client";

import { useCallback, useEffect, useId, useState } from "react";
import {
  useConnectionQualityIndicator,
  useIsSpeaking,
  useLocalParticipant,
  useMediaDeviceSelect,
  useParticipants,
  useRoomContext,
  useTrackMutedIndicator,
} from "@livekit/components-react";
import { ConnectionQuality, Track, type Participant } from "livekit-client";
import { Camera, Gauge, Mic, MicOff, Signal, SignalLow, SignalMedium, Video, Volume2, WifiOff } from "lucide-react";
import { cn } from "@/lib/cn";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { SegmentedTabs } from "@/components/ui/SegmentedTabs";
import { Switch } from "@/components/ui/Switch";
import { useIsTouchDevice, useParticipantDisplay, useVideoPublication } from "./call-hooks";
import { canPickSpeaker, canShareAudio, loadSharePrefs, noShareAudioMessage, saveSharePrefs, screenShareAudioHint, screenShareOptions } from "./call-media";
import { useCallQuality, type RecvPref } from "./call-quality";
import { STRATEGY_LABEL, type CallAudioRouteState } from "./call-audio-route";
import { deviceLabel, formatVideoStats, readVideoStats, type SendPref, type VideoStatsSample } from "./call-utils";

export type DevicesSheetMode = "speaker" | "devices";

/** Microphone / camera / speaker pickers. Lists stay live: plugging a
 * headset in or out updates them (`devicechange`, via useMediaDeviceSelect),
 * and LiveKit itself falls back to the default device if the active one
 * disappears. On phones one sheet holds everything (speaker first); on
 * desktop the Speaker and Devices buttons open just their part. */
export function CallDevicesDialog({
  mode,
  onClose,
  audioRoute,
}: {
  mode: DevicesSheetMode;
  onClose: () => void;
  audioRoute?: CallAudioRouteState;
}) {
  const touch = useIsTouchDevice();
  const speaker = touch || mode === "speaker";
  const inputs = touch || mode === "devices";
  return (
    <Dialog
      onClose={onClose}
      title={touch ? "Audio and video" : mode === "speaker" ? "Speaker" : "Microphone and camera"}
      size="sm"
      bodyClassName="space-y-5"
    >
      {speaker ? <SpeakerSection showTitle={inputs} /> : null}
      {inputs ? <DeviceSection kind="audioinput" title="Microphone" icon={<Mic className="size-4" aria-hidden />} /> : null}
      {inputs ? <DeviceSection kind="videoinput" title="Camera" icon={<Camera className="size-4" aria-hidden />} /> : null}
      {inputs ? <CameraQualitySection /> : null}
      {audioRoute && (touch || mode === "speaker") ? <AudioRoutingDetails state={audioRoute} /> : null}
    </Dialog>
  );
}

/** Collapsed readout of how call sound is being routed — something a user
 *  can screenshot when the Speaker button doesn't move the sound. */
function AudioRoutingDetails({ state }: { state: CallAudioRouteState }) {
  const d = state.diagnostics;
  const platform = d.platform === "android" ? "Android" : d.platform === "ios" ? "iPhone / iPad" : "Computer";
  const rows: [string, string][] = [
    ["Device", platform],
    ["Method", STRATEGY_LABEL[state.strategy]],
    ["Sound now", state.route === "speaker" ? "Speaker" : state.headset ? `Headset (${state.headset})` : "Earpiece"],
    ["Microphone in use", d.activeInput ?? "Default"],
    ["Can pick outputs", d.sinkSupported ? "Yes" : "No"],
    ["Last change", d.lastAction ?? "None yet"],
  ];
  return (
    <details data-audio-routing className="rounded-[var(--radius-md)] border border-line px-3.5 py-2.5 text-[13.5px]">
      <summary className="cursor-pointer select-none font-semibold text-fg-2">Audio routing details</summary>
      <dl className="mt-2 space-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-3">
            <dt className="w-[42%] shrink-0 text-muted">{k}</dt>
            <dd className="min-w-0 break-words text-fg">{v}</dd>
          </div>
        ))}
        <DeviceList title="Outputs" items={d.outputs} />
        <DeviceList title="Microphones" items={d.inputs} />
        {d.lastError ? (
          <div className="flex gap-3">
            <dt className="w-[42%] shrink-0 text-muted">Last error</dt>
            <dd className="min-w-0 break-words text-danger">{d.lastError}</dd>
          </div>
        ) : null}
      </dl>
    </details>
  );
}

function DeviceList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="flex gap-3">
      <dt className="w-[42%] shrink-0 text-muted">{title}</dt>
      <dd className="min-w-0 text-fg">
        {items.length ? (
          <ul className="space-y-0.5">
            {items.map((label, i) => (
              <li key={i} className="break-words" dir="auto">
                {label}
              </li>
            ))}
          </ul>
        ) : (
          "None listed"
        )}
      </dd>
    </div>
  );
}

const SEND_OPTIONS: { value: SendPref; label: string; hint?: string }[] = [
  { value: "auto", label: "Auto", hint: "Best your connection can carry" },
  { value: 1080, label: "1080p", hint: "Full HD — needs a fast connection" },
  { value: 720, label: "720p" },
  { value: 480, label: "480p" },
  { value: 360, label: "360p", hint: "Saves data" },
];

/** How sharp your own camera is sent. Auto follows your connection (and
 * the readout shows where it is now); a fixed level is a ceiling — on a
 * bad network the browser still sends less rather than freezing. */
function CameraQualitySection() {
  const { sendPref, setSendPref, sendLevel } = useCallQuality();
  const name = useId();
  return (
    <fieldset data-camera-quality>
      <legend className="mb-1.5 flex items-center gap-2 text-[13.5px] font-semibold text-fg-2">
        <Gauge className="size-4" aria-hidden />
        Camera quality
      </legend>
      <div className="overflow-hidden rounded-[var(--radius-md)] border border-line">
        {SEND_OPTIONS.map((o) => {
          const checked = sendPref === o.value;
          const now = o.value === "auto" && checked && sendLevel ? `Now ${sendLevel}p` : null;
          return (
            <label
              key={o.value}
              className={cn(
                "flex min-h-[48px] cursor-pointer items-center gap-3 border-b border-line px-3.5 py-1.5 text-[15px] last:border-b-0 focus-within:bg-sunken hover:bg-sunken",
                checked && "text-accent-text",
              )}
            >
              <input
                type="radio"
                name={name}
                value={String(o.value)}
                className="size-[18px] shrink-0 accent-[var(--accent)]"
                checked={checked}
                onChange={() => setSendPref(o.value)}
              />
              <span className="min-w-0 flex-1">
                <span className="block">{o.label}</span>
                {now || o.hint ? <span className="block text-[13px] text-muted">{now ?? o.hint}</span> : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Sound output. Switching goes through `room.switchActiveDevice`
 * (setSinkId on every call audio element, and on ones added later). Where
 * the browser can't route audio (iOS Safari, older Android browsers), the
 * option stays visible but explains what to do instead. */
function SpeakerSection({ showTitle }: { showTitle: boolean }) {
  const touch = useIsTouchDevice();
  if (canPickSpeaker()) {
    return <DeviceSection kind="audiooutput" title="Speaker" hideTitle={!showTitle} icon={<Volume2 className="size-4" aria-hidden />} />;
  }
  const ios = typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent);
  return (
    <fieldset disabled aria-describedby="call-speaker-hint">
      {showTitle ? (
        <legend className="mb-1.5 flex items-center gap-2 text-[13.5px] font-semibold text-fg-2">
          <Volume2 className="size-4" aria-hidden />
          Speaker
        </legend>
      ) : null}
      <div className="overflow-hidden rounded-[var(--radius-md)] border border-line opacity-60">
        <label className="flex min-h-[48px] items-center gap-3 px-3.5 text-[15px]">
          <input type="radio" checked readOnly className="size-[18px] shrink-0 accent-[var(--accent)]" />
          <span className="min-w-0 flex-1 truncate">{touch ? "Chosen by your phone" : "System default"}</span>
        </label>
      </div>
      <p id="call-speaker-hint" className="mt-2 text-[14px] leading-relaxed text-muted">
        {ios
          ? "Safari on iPhone and iPad doesn't let websites pick the speaker. Open Control Center and tap the AirPlay icon on the audio card, or connect headphones."
          : touch
            ? "This browser doesn't let websites pick the speaker. Use your phone's audio controls, or connect headphones. Chrome on Android can switch it here."
            : "This browser doesn't let websites pick the speaker. Change it in your computer's sound settings, or use Chrome or Edge."}
      </p>
    </fieldset>
  );
}

function DeviceSection({
  kind,
  title,
  icon,
  hideTitle,
}: {
  kind: MediaDeviceKind;
  title: string;
  icon: React.ReactNode;
  hideTitle?: boolean;
}) {
  const room = useRoomContext();
  const [error, setError] = useState<string | null>(null);
  // Device names stay blank until the page has media permission; asking
  // again (one getUserMedia) fills them in.
  const [askNames, setAskNames] = useState(false);
  // Stable callback: useMediaDeviceSelect re-subscribes when it changes,
  // and an inline arrow here loops the device observer forever.
  const onError = useCallback((e: Error) => setError(e.message), []);
  const { devices, activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({ kind, room, onError, requestPermissions: askNames });
  const unnamed = devices.length > 0 && devices.every((d) => !d.label);
  const name = useId();
  // Chrome lists a "default" pseudo-device plus the real one it points at;
  // when the active id is "default" (or unset) that's the one to tick.
  const active = activeDeviceId || "default";
  const hasDefault = devices.some((d) => d.deviceId === "default");

  return (
    <fieldset>
      <legend className={hideTitle ? "sr-only" : "mb-1.5 flex items-center gap-2 text-[13.5px] font-semibold text-fg-2"}>
        {hideTitle ? null : icon}
        {title}
      </legend>
      {devices.length === 0 ? (
        <p className="text-[14px] text-muted">{kind === "videoinput" ? "No camera found." : kind === "audioinput" ? "No microphone found." : "No speakers found."}</p>
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-md)] border border-line">
          {devices.map((d, i) => {
            const checked = d.deviceId === active || (!hasDefault && i === 0 && !devices.some((x) => x.deviceId === active));
            return (
              <label
                key={d.deviceId || i}
                className={cn(
                  "flex min-h-[48px] cursor-pointer items-center gap-3 border-b border-line px-3.5 text-[15px] last:border-b-0 focus-within:bg-sunken hover:bg-sunken",
                  checked && "text-accent-text",
                )}
              >
                <input
                  type="radio"
                  name={name}
                  className="size-[18px] shrink-0 accent-[var(--accent)]"
                  checked={checked}
                  onChange={() => {
                    setError(null);
                    setActiveMediaDevice(d.deviceId).catch((e: Error) => setError(e.message));
                  }}
                />
                <span className="min-w-0 flex-1 truncate">{deviceLabel(d, kind, i)}</span>
              </label>
            );
          })}
        </div>
      )}
      {unnamed && !askNames ? (
        <button type="button" onClick={() => setAskNames(true)} className="mt-1.5 text-[14px] font-medium text-accent-text hover:underline">
          Show device names
        </button>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1.5 text-[13.5px] text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

export function CallParticipantsDialog({ onClose, onSpotlight }: { onClose: () => void; onSpotlight: (identity: string) => void }) {
  const participants = useParticipants();
  const sorted = [...participants].sort((a, b) => Number(b.isLocal) - Number(a.isLocal));
  return (
    <Dialog onClose={onClose} title={`In this call (${participants.length})`} size="sm" bodyClassName="px-0 py-1">
      <ul>
        {sorted.map((p) => (
          <ParticipantRow
            key={p.identity || "local"}
            participant={p}
            onClick={() => {
              onSpotlight(p.identity);
              onClose();
            }}
          />
        ))}
      </ul>
    </Dialog>
  );
}

const RECV_OPTIONS: { value: RecvPref; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

function ParticipantRow({ participant, onClick }: { participant: Participant; onClick: () => void }) {
  const { name, photo, isLocal, colorId } = useParticipantDisplay(participant);
  const speaking = useIsSpeaking(participant);
  const { isMuted } = useTrackMutedIndicator({ participant, source: Track.Source.Microphone });
  const { on: cameraOn, publication: cameraPub } = useVideoPublication(participant, Track.Source.Camera);
  const { on: screenOn, publication: screenPub } = useVideoPublication(participant, Track.Source.ScreenShare);
  const { quality } = useConnectionQualityIndicator({ participant });
  const { sendPref, sendLevel, recvPref, setRecvPref, recvCap } = useCallQuality();
  const selectId = useId();
  const status = speaking ? "Speaking" : isMuted ? "Muted" : "Listening";
  const pref = recvPref(participant.identity);
  // What's chosen, then what's flowing: "Camera · Auto · 720p: 1280×720 · 30 fps …"
  const cameraLabel = isLocal
    ? `Camera · ${sendPref === "auto" ? `Auto${sendLevel ? ` · ${sendLevel}p` : ""}` : `${sendPref}p${sendLevel && sendLevel < sendPref ? ` (camera max ${sendLevel}p)` : ""}`}`
    : `Camera · ${pref === "auto" ? (recvCap === "none" ? "Auto" : `Auto · limited to ${recvCap}`) : RECV_OPTIONS.find((o) => o.value === pref)!.label}`;

  return (
    <li className="flex items-center gap-1 pe-3">
      <button
        type="button"
        onClick={onClick}
        className="focus-inset flex min-h-[60px] min-w-0 flex-1 items-center gap-3 py-2 ps-5 text-start hover:bg-sunken"
      >
        <span className={cn("rounded-full p-0.5 ring-2 transition-shadow", speaking ? "ring-[var(--success)]" : "ring-transparent")}>
          <Avatar colorId={colorId} name={name} src={photo} size={40} />
        </span>
        <span className="min-w-0 flex-1">
          <bdi className="block truncate text-[15px] font-medium text-fg">
            {name}
            {isLocal ? <span className="font-normal text-muted"> (you)</span> : null}
          </bdi>
          <span className={cn("block text-[13.5px]", speaking ? "text-success" : "text-muted")}>{status}</span>
          {cameraOn && cameraPub?.track ? <VideoStatsLine track={cameraPub.track} local={isLocal} label={cameraLabel} /> : null}
          {screenOn && screenPub?.track ? <VideoStatsLine track={screenPub.track} local={isLocal} label="Screen" /> : null}
        </span>
        <span className="flex shrink-0 items-center gap-2 text-muted">
          <QualityIcon quality={quality} />
          {cameraOn ? <Video className="size-[18px]" aria-label="Camera on" /> : null}
          {isMuted ? <MicOff className="size-[18px] text-danger" aria-label="Muted" /> : <Mic className="size-[18px]" aria-label="Mic on" />}
        </span>
      </button>
      {!isLocal && (cameraOn || pref !== "auto") ? (
        <>
          <label htmlFor={selectId} className="sr-only">
            Video quality from {name}
          </label>
          <select
            id={selectId}
            data-recv-quality
            value={pref}
            onChange={(e) => setRecvPref(participant.identity, e.target.value as RecvPref)}
            title="Video quality you receive"
            className="h-11 shrink-0 rounded-[var(--radius-sm)] border border-line bg-sunken px-2 text-[14px] text-fg"
          >
            {RECV_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </>
      ) : null}
    </li>
  );
}

function QualityIcon({ quality }: { quality: ConnectionQuality }) {
  switch (quality) {
    case ConnectionQuality.Excellent:
      return <Signal className="size-[18px] text-success" aria-label="Excellent connection" />;
    case ConnectionQuality.Good:
      return <SignalMedium className="size-[18px]" aria-label="Good connection" />;
    case ConnectionQuality.Poor:
      return <SignalLow className="size-[18px] text-warning" aria-label="Weak connection" />;
    case ConnectionQuality.Lost:
      return <WifiOff className="size-[18px] text-danger" aria-label="Connection lost" />;
    default:
      return null;
  }
}

/** Live "what's actually flowing" readout — resolution, frame rate, bitrate
 * and codec from WebRTC stats (outbound for your own video, inbound for
 * others'). Polled every 2 s while the sheet is open. */
function VideoStatsLine({ track, local, label }: { track: Track; local: boolean; label: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let prev: VideoStatsSample | null = null;
    let alive = true;
    const tick = async () => {
      const report = await track.getRTCStatsReport().catch(() => undefined);
      if (!alive || !report) return;
      const cur = readVideoStats(report.values() as Iterable<Record<string, unknown>>, local ? "outbound" : "inbound");
      if (cur) setText(formatVideoStats(cur, prev));
      prev = cur;
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [track, local]);
  if (!text) return null;
  return (
    <span data-video-stats className="tabular block text-[12.5px] leading-snug text-muted">
      {label}: {text}
    </span>
  );
}

/** Before the browser's own picker: whether to include sound, and what the
 * share is for (sharp text vs smooth motion), remembered per device. */
export function CallShareDialog({ onClose, onNoAudio }: { onClose: () => void; onNoAudio: (message: string) => void }) {
  const { localParticipant } = useLocalParticipant();
  const audioSupported = canShareAudio();
  const [prefs, setPrefs] = useState(loadSharePrefs);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioHintId = useId();
  const withAudio = audioSupported && prefs.audio;

  async function start() {
    setPending(true);
    setError(null);
    saveSharePrefs(prefs);
    const { capture, publish } = screenShareOptions(withAudio, prefs.content, prefs.hearLocally);
    try {
      const pub = await localParticipant.setScreenShareEnabled(true, capture, publish);
      // Chrome returns no audio track — silently — when the user picked a
      // window (or, on a Mac/Linux, the entire screen) or unticked the
      // picker's audio checkbox. Say so, rather than letting them talk
      // over a silent video.
      if (withAudio && pub && !localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)) {
        const surface = (pub.track?.mediaStreamTrack.getSettings() as MediaTrackSettings & { displaySurface?: string })?.displaySurface;
        onNoAudio(noShareAudioMessage(surface));
      }
      onClose();
    } catch (e) {
      // Cancelling the browser's picker is a NotAllowedError — just close.
      if ((e as Error)?.name === "NotAllowedError" || (e as Error)?.name === "AbortError") onClose();
      else setError("Couldn't start sharing your screen.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      onClose={onClose}
      title="Share your screen"
      size="sm"
      bodyClassName="space-y-5"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={start} loading={pending} data-call-share-start>
            Share
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div id={`${audioHintId}-l`} className="text-[15px] font-medium text-fg">
            Also share audio
          </div>
          <p id={audioHintId} className="mt-0.5 text-[13.5px] leading-relaxed text-muted">
            {audioSupported
              ? screenShareAudioHint()
              : "Your browser can't share sound. Use Chrome or Edge on a computer to include audio."}
          </p>
        </div>
        <Switch
          checked={withAudio}
          disabled={!audioSupported}
          onChange={(audio) => setPrefs((p) => ({ ...p, audio }))}
          aria-labelledby={`${audioHintId}-l`}
          aria-describedby={audioHintId}
          className="mt-0.5"
        />
      </div>
      {withAudio ? (
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div id={`${audioHintId}-hl`} className="text-[15px] font-medium text-fg">
              Hear it on this device
            </div>
            <p id={`${audioHintId}-hd`} className="mt-0.5 text-[13.5px] leading-relaxed text-muted">
              {prefs.hearLocally
                ? "The shared sound keeps playing for you. Best with headphones — on speakers, your microphone may pick it up and others could hear it twice."
                : "The shared sound is muted on this device while you share, so it can't echo through your microphone."}
            </p>
          </div>
          <Switch
            checked={prefs.hearLocally}
            onChange={(hearLocally) => setPrefs((p) => ({ ...p, hearLocally }))}
            aria-labelledby={`${audioHintId}-hl`}
            aria-describedby={`${audioHintId}-hd`}
            className="mt-0.5"
          />
        </div>
      ) : null}
      <div>
        <div className="mb-2 text-[15px] font-medium text-fg">Best for</div>
        <SegmentedTabs
          aria-label="Best for"
          options={[
            { key: "detail", label: "Text and slides" },
            { key: "motion", label: "Video and motion" },
          ]}
          value={prefs.content}
          onChange={(content) => setPrefs((p) => ({ ...p, content }))}
        />
      </div>
      {error ? (
        <p role="alert" className="text-[13.5px] text-danger">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
