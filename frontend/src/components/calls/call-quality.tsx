"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRoomContext } from "@livekit/components-react";
import {
  ConnectionQuality,
  ParticipantEvent,
  RoomEvent,
  Track,
  TrackEvent,
  VideoQuality,
  type LocalVideoTrack,
  type RemoteTrackPublication,
  type Room,
} from "livekit-client";
import { useIsTouchDevice } from "./call-hooks";
import {
  AUTO_TIMING,
  autoStep,
  initialAutoState,
  layerPlan,
  readSendHealth,
  SEND_LEVELS,
  recvCapStep,
  startLevel,
  type AutoState,
  type RecvCap,
  type RecvCapState,
  type SendLevel,
  type SendPref,
} from "./call-utils";

export type RecvPref = "auto" | "high" | "medium" | "low";

interface CallQualityValue {
  /** What the user picked for their own camera. */
  sendPref: SendPref;
  setSendPref: (p: SendPref) => void;
  /** The level the camera is actually sent at right now (null: camera off). */
  sendLevel: SendLevel | null;
  recvPref: (identity: string) => RecvPref;
  setRecvPref: (identity: string, p: RecvPref) => void;
  /** Auto's current cap on incoming video because our connection is weak. */
  recvCap: RecvCap;
}

const CallQualityContext = createContext<CallQualityValue | null>(null);

export function useCallQuality(): CallQualityValue {
  const v = useContext(CallQualityContext);
  if (!v) throw new Error("useCallQuality outside CallQualityProvider");
  return v;
}

const PREF_KEY = "chat:call-camera-quality";
function loadSendPref(): SendPref {
  try {
    const v = localStorage.getItem(PREF_KEY);
    const num = Number(v);
    return num === 1080 || num === 720 || num === 480 || num === 360 ? num : "auto";
  } catch {
    return "auto";
  }
}

const TICK_MS = 2_000;

function cameraTrack(room: Room): LocalVideoTrack | undefined {
  const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
  return pub && !pub.isMuted ? (pub.track as LocalVideoTrack | undefined) : undefined;
}

/** Re-captures (only when crossing 720p↔1080p) and re-encodes the published
 * camera at `level`: the simulcast layers are rescaled and given matching
 * bitrates with `RTCRtpSender.setParameters`, so there's no renegotiation,
 * no camera reopen and no blip for the people watching. Returns the level
 * actually reached (a 720p webcam can't do 1080p). */
async function applyCameraLevel(track: LocalVideoTrack, level: SendLevel): Promise<{ reached: SendLevel; ok: boolean }> {
  const mst = track.mediaStreamTrack;
  if (!mst || mst.readyState !== "live") return { reached: level, ok: false };
  let s = mst.getSettings();
  let short = Math.min(s.width ?? 0, s.height ?? 0);
  const capture = level === 1080 ? 1080 : 720;
  if (short && (level === 1080 ? short < 1080 : short > 720)) {
    const portrait = (s.height ?? 0) > (s.width ?? 0);
    const long = Math.round((capture * 16) / 9);
    await mst
      .applyConstraints({
        width: { ideal: portrait ? capture : long },
        height: { ideal: portrait ? long : capture },
        frameRate: { ideal: 30 },
      })
      .catch(() => {});
    s = mst.getSettings();
    short = Math.min(s.width ?? 0, s.height ?? 0);
  }
  const sender = track.sender;
  let ok = false;
  if (sender && short) {
    try {
      const params = sender.getParameters();
      const encs = params.encodings ?? [];
      if (encs.length > 0) {
        // Top layer = smallest downscale (rids f/h/q in any order).
        const order = encs.map((e, i) => ({ i, scale: e.scaleResolutionDownBy ?? 1 })).sort((a, b) => a.scale - b.scale);
        const plan = layerPlan(short, level, encs.length);
        order.forEach(({ i }, rank) => {
          encs[i].scaleResolutionDownBy = plan[rank].scaleResolutionDownBy;
          encs[i].maxBitrate = plan[rank].maxBitrate;
        });
        params.encodings = encs;
        await sender.setParameters(params);
        ok = true;
      }
    } catch {
      /* a concurrent dynacast update won the race — the next tick retries */
    }
  }
  const reached = short >= level || !short ? level : (SEND_LEVELS.find((l) => l <= short) ?? 360);
  return { reached, ok };
}

function qualityName(q: ConnectionQuality): "excellent" | "good" | "poor" | "lost" | "unknown" {
  switch (q) {
    case ConnectionQuality.Excellent:
      return "excellent";
    case ConnectionQuality.Good:
      return "good";
    case ConnectionQuality.Poor:
      return "poor";
    case ConnectionQuality.Lost:
      return "lost";
    default:
      return "unknown";
  }
}

/** Owns camera send quality (manual or Auto) and receive quality for the
 * whole call — mounted with the room, so it keeps working while the call
 * is minimized. */
export function CallQualityProvider({ children }: { children: React.ReactNode }) {
  const room = useRoomContext();
  const touch = useIsTouchDevice();
  const [sendPref, setSendPrefState] = useState<SendPref>(loadSendPref);
  const [sendLevel, setSendLevel] = useState<SendLevel | null>(null);
  const [recvPrefs, setRecvPrefs] = useState<Record<string, RecvPref>>({});
  const [recvCap, setRecvCap] = useState<RecvCap>("none");

  const auto = useRef<AutoState | null>(null);
  const applied = useRef<{ track: LocalVideoTrack; level: SendLevel } | null>(null);
  // Phones/tablets top out at 720p in Auto (heat, battery); 1080p stays
  // available as a manual choice. Lowered further if the camera can't.
  const autoMax = useRef<SendLevel>(touch ? 720 : 1080);
  useEffect(() => {
    autoMax.current = touch ? 720 : 1080;
  }, [touch]);

  const setSendPref = useCallback((p: SendPref) => {
    setSendPrefState(p);
    try {
      localStorage.setItem(PREF_KEY, String(p));
    } catch {
      /* private mode */
    }
  }, []);

  // ---- Sending ---------------------------------------------------------
  useEffect(() => {
    let alive = true;
    let busy = false;
    const conn = (navigator as Navigator & { connection?: { effectiveType?: string; downlink?: number; saveData?: boolean } }).connection;

    const apply = async (force = false) => {
      const track = cameraTrack(room);
      if (!track) {
        applied.current = null;
        setSendLevel(null);
        return;
      }
      let target: SendLevel;
      if (sendPref === "auto") {
        if (!auto.current) auto.current = initialAutoState(Math.min(startLevel(conn), autoMax.current) as SendLevel, Date.now());
        target = auto.current.level;
      } else {
        target = sendPref;
      }
      if (!force && applied.current?.track === track && applied.current.level === target) return;
      const { reached, ok } = await applyCameraLevel(track, target);
      if (!alive) return;
      if (ok) applied.current = { track, level: target };
      if (reached < target && sendPref === "auto" && target === 1080) autoMax.current = 720;
      setSendLevel(reached);
    };

    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const track = cameraTrack(room);
        if (sendPref === "auto" && track?.sender && auto.current) {
          const report = await track.sender.getStats().catch(() => undefined);
          if (!alive) return;
          if (report) {
            const q = room.localParticipant.connectionQuality;
            const health = readSendHealth(
              report.values() as Iterable<Record<string, unknown>>,
              q === ConnectionQuality.Poor || q === ConnectionQuality.Lost,
            );
            auto.current = autoStep(auto.current, health, Date.now(), autoMax.current);
          }
        }
        await apply();
      } finally {
        busy = false;
      }
    };

    // A new/restarted camera (flip, device switch, video off→on) gets
    // default encodings from LiveKit again, so reapply the level to it.
    let watched: LocalVideoTrack | undefined;
    const onRestart = () => {
      if (sendPref === "auto" && auto.current) {
        const now = Date.now();
        auto.current = { ...auto.current, changedAt: now, rampUntil: now + AUTO_TIMING.ramp };
      }
      void apply(true);
    };
    const rewatch = () => {
      const t = room.localParticipant.getTrackPublication(Track.Source.Camera)?.track as LocalVideoTrack | undefined;
      if (t === watched) return;
      watched?.off(TrackEvent.Restarted, onRestart);
      watched = t;
      watched?.on(TrackEvent.Restarted, onRestart);
      if (t && auto.current) {
        const now = Date.now();
        auto.current = { ...auto.current, changedAt: now, rampUntil: now + AUTO_TIMING.ramp };
      }
    };
    const onLocalChange = () => {
      rewatch();
      void apply(true);
    };

    rewatch();
    void apply(true);
    const id = setInterval(tick, TICK_MS);
    room
      .on(RoomEvent.LocalTrackPublished, onLocalChange)
      .on(RoomEvent.LocalTrackUnpublished, onLocalChange)
      .on(RoomEvent.TrackMuted, onLocalChange)
      .on(RoomEvent.TrackUnmuted, onLocalChange);
    return () => {
      alive = false;
      clearInterval(id);
      watched?.off(TrackEvent.Restarted, onRestart);
      room
        .off(RoomEvent.LocalTrackPublished, onLocalChange)
        .off(RoomEvent.LocalTrackUnpublished, onLocalChange)
        .off(RoomEvent.TrackMuted, onLocalChange)
        .off(RoomEvent.TrackUnmuted, onLocalChange);
    };
  }, [room, sendPref]);

  // ---- Receiving -------------------------------------------------------
  const capState = useRef<RecvCapState>({ cap: "none", badSince: null, goodSince: null });
  useEffect(() => {
    const step = () => {
      const next = recvCapStep(capState.current, qualityName(room.localParticipant.connectionQuality), Date.now());
      capState.current = next;
      setRecvCap(next.cap);
    };
    const id = setInterval(step, 1_000);
    room.localParticipant.on(ParticipantEvent.ConnectionQualityChanged, step);
    return () => {
      clearInterval(id);
      room.localParticipant.off(ParticipantEvent.ConnectionQualityChanged, step);
    };
  }, [room]);

  useEffect(() => {
    const applyAll = () => {
      for (const p of room.remoteParticipants.values()) {
        const pub = p.getTrackPublication(Track.Source.Camera) as RemoteTrackPublication | undefined;
        if (!pub || !pub.isSubscribed) continue;
        const pref = recvPrefs[p.identity] ?? "auto";
        // With adaptive stream on, LiveKit still never sends more than the
        // tile can show; these only lower the ceiling.
        const q =
          pref === "low" || (pref === "auto" && recvCap === "low")
            ? VideoQuality.LOW
            : pref === "medium" || (pref === "auto" && recvCap === "medium")
              ? VideoQuality.MEDIUM
              : VideoQuality.HIGH;
        pub.setVideoQuality(q);
      }
    };
    applyAll();
    room.on(RoomEvent.TrackSubscribed, applyAll).on(RoomEvent.ParticipantConnected, applyAll);
    return () => {
      room.off(RoomEvent.TrackSubscribed, applyAll).off(RoomEvent.ParticipantConnected, applyAll);
    };
  }, [room, recvPrefs, recvCap]);

  const value = useMemo<CallQualityValue>(
    () => ({
      sendPref,
      setSendPref,
      sendLevel,
      recvPref: (identity) => recvPrefs[identity] ?? "auto",
      setRecvPref: (identity, p) => setRecvPrefs((prev) => ({ ...prev, [identity]: p })),
      recvCap,
    }),
    [sendPref, setSendPref, sendLevel, recvPrefs, recvCap],
  );

  return <CallQualityContext.Provider value={value}>{children}</CallQualityContext.Provider>;
}
