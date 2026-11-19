"use client";

import { useEffect, useRef, useState } from "react";
import { RoomEvent, Track, TrackEvent, type LocalAudioTrack, type RemoteAudioTrack, type RemoteTrack, type Room } from "livekit-client";
import { setCallAudioActive } from "@/lib/call-audio-state";

/**
 * Earpiece ↔ speaker on phones (Telegram's "Speaker" toggle).
 *
 * Call audio always plays one way: LiveKit's `<audio>` elements
 * (RoomAudioRenderer; `webAudioMix` off). Other app sounds stay silent
 * during a call (see lib/call-audio-state.ts) so nothing flips the route.
 *
 * How the route is switched, best first:
 * - `input` (Chrome on Android): while the mic is captured Android puts
 *   Chrome in communication mode, and *all* its output — `<audio>` and Web
 *   Audio alike — follows the "communication device". Chrome exposes those
 *   devices as **microphones** ("Speakerphone", "Headset earpiece", "Wired
 *   headset", "Bluetooth headset", "USB audio"); picking the Speakerphone
 *   input switches the communication device to the loudspeaker, "Headset
 *   earpiece" back to the earpiece. So the toggle restarts the mic on that
 *   input (`room.switchActiveDevice("audioinput", id)`).
 * - `sink`: the browser lists separate earpiece/speaker *outputs* and
 *   supports `setSinkId` → `room.switchActiveDevice("audiooutput", id)`.
 * - `webaudio`: last resort on Android when neither list has routes — plays
 *   the remote mix through an AudioContext. Usually has no effect while the
 *   mic is open (see above), so it's only used when nothing else exists.
 * - `unsupported` (iPhone/iPad Safari): iOS decides; the page can't.
 * - `none` (desktop): the device picker sheet handles outputs instead.
 */
export type AudioRoute = "earpiece" | "speaker";
export type RouteStrategy = "input" | "sink" | "webaudio" | "unsupported" | "none";
export type Platform = "ios" | "android" | "desktop";

export function detectPlatform(ua: string, maxTouchPoints = 0): Platform {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
  return "desktop";
}

type Dev = Pick<MediaDeviceInfo, "kind" | "deviceId" | "label">;

export interface ClassifiedRoutes {
  earpiece?: string;
  speaker?: string;
  /** A wired/Bluetooth/USB headset is connected. */
  headset?: { id: string; label: string };
}

// Matched against labels (Chrome's device ids are opaque hashes). Chrome's
// Android names are fixed English strings; the extra words cover other
// Chromium builds/vendors and a few translations (fa/de/fr/es/ru/tr/ar).
const EARPIECE = /earpiece|receiver|handset|phone earpiece|گوشی|هندزفری گوشی|hörmuschel|écouteur interne|auricular|динамик телефона|ahize|سماعة الأذن/i;
const SPEAKER = /speaker\s*phone|speakerphone|loud\s*speaker|built-?in speaker|\bspeaker\b|بلندگو|lautsprecher|haut-parleur|altavoz|громкоговоритель|динамик|hoparlör|مكبر الصوت/i;
const HEADSET = /wired headset|bluetooth|\bbt\b|headphone|earbud|\bbuds\b|airpods|usb audio|\busb\b|hands-?free|a2dp|hfp|headset|هدست|بلوتوث|kopfhörer|casque|auriculares|наушники|kulaklık/i;

function classify(devices: Dev[], kind: MediaDeviceKind): ClassifiedRoutes {
  const out: ClassifiedRoutes = {};
  for (const d of devices) {
    if (d.kind !== kind || !d.label) continue;
    if (d.deviceId === "default" || d.deviceId === "communications") continue;
    // Order matters: "Headset earpiece" is the phone's earpiece, not a headset.
    if (EARPIECE.test(d.label)) out.earpiece ??= d.deviceId;
    else if (HEADSET.test(d.label)) out.headset ??= { id: d.deviceId, label: d.label };
    else if (SPEAKER.test(d.label)) out.speaker ??= d.deviceId;
  }
  return out;
}

/** Chrome-on-Android communication routes, exposed as microphones. */
export function classifyInputRoutes(devices: Dev[]): ClassifiedRoutes {
  return classify(devices, "audioinput");
}

/** Real output devices (desktop-style `setSinkId` targets). */
export function classifyOutputs(devices: Dev[]): ClassifiedRoutes {
  return classify(devices, "audiooutput");
}

export function pickStrategy(platform: Platform, sinkSupported: boolean, inputs: ClassifiedRoutes, outputs: ClassifiedRoutes): RouteStrategy {
  if (platform === "ios") return "unsupported";
  if (platform === "android" && inputs.speaker && (inputs.earpiece || inputs.headset)) return "input";
  if (sinkSupported && outputs.speaker && (outputs.earpiece || outputs.headset)) return "sink";
  if (platform === "android") return "webaudio";
  return "none";
}

/** The device to select for `route` — a connected headset replaces the
 *  earpiece (Telegram: headset wins; the toggle then means speaker ↔ headset). */
export function deviceForRoute(route: AudioRoute, r: ClassifiedRoutes): string | undefined {
  if (route === "speaker") return r.speaker;
  return r.headset?.id ?? r.earpiece;
}

export interface RoutePrefs {
  voice?: AudioRoute;
  video?: AudioRoute;
}

/** Earpiece for a voice call and speaker once video is on (Telegram) —
 *  unless this device remembers another choice for that kind of call. A
 *  connected headset always wins. */
export function defaultRoute(videoOn: boolean, prefs: RoutePrefs, headset: boolean): AudioRoute {
  if (headset) return "earpiece";
  const saved = videoOn ? prefs.video : prefs.voice;
  return saved ?? (videoOn ? "speaker" : "earpiece");
}

const PREFS_KEY = "chat:call-audio-route";
export function loadRoutePrefs(): RoutePrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as RoutePrefs | null;
    const ok = (v: unknown): v is AudioRoute => v === "earpiece" || v === "speaker";
    return { voice: ok(raw?.voice) ? raw.voice : undefined, video: ok(raw?.video) ? raw.video : undefined };
  } catch {
    return {};
  }
}
export function saveRoutePrefs(prefs: RoutePrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode */
  }
}

/** Hint shown where the page can't choose the output. */
export const IOS_ROUTE_HINT = "Your iPhone chooses the speaker. Use Control Center or connect headphones to switch.";

export const STRATEGY_LABEL: Record<RouteStrategy, string> = {
  input: "Android call route (via microphone choice)",
  sink: "Output device (setSinkId)",
  webaudio: "Web Audio fallback (may not move the sound)",
  unsupported: "Chosen by the phone (iOS)",
  none: "Output picker (desktop)",
};

function remoteAudioTracks(room: Room): RemoteAudioTrack[] {
  const out: RemoteAudioTrack[] = [];
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.audioTrackPublications.values()) {
      if (pub.track) out.push(pub.track as RemoteAudioTrack);
    }
  }
  return out;
}

/** Route one remote audio track through `ctx` (Web Audio fallback) or its
 *  own `<audio>` element(s). */
function routeTrack(track: RemoteAudioTrack, ctx: AudioContext | null) {
  track.setAudioContext(ctx ?? undefined);
  const volume = track.getVolume() || 1;
  for (const el of track.attachedElements) {
    el.muted = !!ctx;
    el.volume = ctx ? 0 : Math.min(1, volume);
  }
}

export interface AudioRouteDiagnostics {
  platform: Platform;
  sinkSupported: boolean;
  outputs: string[];
  inputs: string[];
  /** Label of the microphone the track is really capturing from (read back from the track). */
  activeInput: string | null;
  /** What the last route change did, in words: "Switched mic to Speakerphone — ok". */
  lastAction: string | null;
  lastError: string | null;
}

export interface CallAudioRouteState {
  route: AudioRoute;
  strategy: RouteStrategy;
  /** A headset is connected (label it "Headset" instead of "Earpiece"). */
  headset: string | null;
  toggle: () => void;
  diagnostics: AudioRouteDiagnostics;
}

function micTrack(room: Room): LocalAudioTrack | undefined {
  return room.localParticipant?.getTrackPublication(Track.Source.Microphone)?.track as LocalAudioTrack | undefined;
}

/** The microphone the call is really capturing from, by the track's own settings. */
function activeMicLabel(room: Room, devices: Dev[]): string | null {
  const mic = micTrack(room);
  const id = mic?.mediaStreamTrack?.getSettings().deviceId;
  if (!id) return null;
  return devices.find((d) => d.kind === "audioinput" && d.deviceId === id)?.label || "Microphone (name hidden until allowed)";
}

/**
 * Switch the call's output for one route and say what happened. For the
 * microphone (Android communication routes) this restarts the mic on the
 * chosen input; it resolves with a readable outcome and throws with the
 * reason when the route did not take. A stale device id is retried once with
 * the device found again by its label.
 */
async function switchRoute(
  room: Room,
  kind: "audioinput" | "audiooutput",
  id: string,
  label: string,
  name: string,
  /** After a reconnect the mic may have come back on the default input: restart it even if it looks right. */
  force: boolean,
): Promise<{ action: string }> {
  if (kind === "audiooutput") {
    const ok = await room.switchActiveDevice("audiooutput", id);
    if (ok === false) throw new Error("the browser kept the previous output");
    return { action: `Switched output to ${name}: ok` };
  }
  const what = `Switched mic to ${name}`;
  const mic = micTrack(room);
  if (!mic) {
    // No mic published yet: LiveKit uses the chosen input for the first one.
    await room.switchActiveDevice("audioinput", id);
    return { action: `${what}: will apply when the microphone starts` };
  }
  if (mic.isMuted) {
    // LiveKit only queues the change while muted and applies it on unmute.
    await room.switchActiveDevice("audioinput", id);
    return { action: `${what}: waiting until the microphone is unmuted` };
  }
  if (!force && mic.mediaStreamTrack?.getSettings().deviceId === id) return { action: `${what}: ok` };
  const attempt = async (deviceId: string) => {
    const ok = await room.switchActiveDevice("audioinput", deviceId);
    const landed = mic.mediaStreamTrack?.getSettings().deviceId;
    return ok !== false && (!landed || landed === deviceId);
  };
  let landed = false;
  let failure: unknown = null;
  try {
    landed = await attempt(id);
  } catch (e) {
    failure = e;
  }
  if (!landed && label) {
    // The id may have changed since the list was read: find the device again by name.
    const fresh = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
    const again = fresh.find((d) => d.kind === "audioinput" && d.label === label)?.deviceId;
    if (again && again !== id) {
      failure = null;
      try {
        landed = await attempt(again);
      } catch (e) {
        failure = e;
      }
    }
  }
  if (landed) return { action: `${what}: ok` };
  if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
  throw new Error(`the microphone is still on "${mic.mediaStreamTrack?.label || "the previous input"}"`);
}

export function useCallAudioRoute(room: Room, videoOn: boolean): CallAudioRouteState {
  const [devices, setDevices] = useState<Dev[]>([]);
  const [platform] = useState<Platform>(() =>
    typeof navigator === "undefined" ? "desktop" : detectPlatform(navigator.userAgent, navigator.maxTouchPoints),
  );
  const sinkSupported = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
  const inputs = classifyInputRoutes(devices);
  const outputs = classifyOutputs(devices);
  const strategy = pickStrategy(platform, sinkSupported, inputs, outputs);
  const routes = strategy === "input" ? inputs : outputs;
  const headset = routes.headset ?? (strategy === "webaudio" ? (inputs.headset ?? outputs.headset) : undefined);
  const headsetLabel = headset?.label ?? null;

  const [chosen, setChosen] = useState<RoutePrefs>({});
  const [prefs] = useState<RoutePrefs>(() => loadRoutePrefs());
  const kind = videoOn ? "video" : "voice";
  const route = chosen[kind] ?? defaultRoute(videoOn, prefs, !!headset);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [reapply, setReapply] = useState(0);

  useEffect(() => {
    setCallAudioActive(true);
    return () => setCallAudioActive(false);
  }, []);

  // Devices (headsets coming and going); labels appear once the mic is granted.
  useEffect(() => {
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md?.enumerateDevices) return;
    let alive = true;
    const read = () =>
      md
        .enumerateDevices()
        .then((list) => alive && setDevices(list.map((d) => ({ kind: d.kind, deviceId: d.deviceId, label: d.label }))))
        .catch(() => {});
    void read();
    md.addEventListener?.("devicechange", read);
    room.on(RoomEvent.LocalTrackPublished, read);
    // After a reconnect the mic may be re-acquired on the default input — put
    // the chosen route back.
    const again = () => setReapply((n) => n + 1);
    room.on(RoomEvent.Reconnected, again);
    return () => {
      alive = false;
      md.removeEventListener?.("devicechange", read);
      room.off(RoomEvent.LocalTrackPublished, read);
      room.off(RoomEvent.Reconnected, again);
    };
  }, [room]);

  // Apply the route. Chrome-on-Android: restart the microphone on the chosen
  // route input and check that the track really landed there (LiveKit's
  // switchActiveDevice reports false, and a muted mic only *queues* the change).
  const targetId = strategy === "input" || strategy === "sink" ? deviceForRoute(route, routes) : undefined;
  const targetLabel = targetId ? devices.find((d) => d.deviceId === targetId)?.label ?? "" : "";
  const routeSeq = useRef(0);
  const micNames = devices.filter((d) => d.kind === "audioinput").map((d) => d.label || "(hidden)").join(" | ");
  useEffect(() => {
    if (strategy !== "input" && strategy !== "sink") return;
    if (!targetId) return;
    const seq = ++routeSeq.current;
    const kindName = strategy === "input" ? "audioinput" : "audiooutput";
    const name = targetLabel || (route === "speaker" ? "Speaker" : "Earpiece");
    const done = (action: string, error: string | null) => {
      if (seq !== routeSeq.current) return;
      setLastAction(action);
      setLastError(error);
    };
    console.info("[call-audio] applying route", { route, strategy, target: name, microphones: micNames });
    void (async () => {
      try {
        const result = await switchRoute(room, kindName, targetId, targetLabel, name, reapply > 0);
        done(result.action, null);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        done(`${kindName === "audioinput" ? "Switched mic to" : "Switched output to"} ${name}: failed`, message);
      }
    })();
  }, [room, strategy, targetId, targetLabel, route, headsetLabel, reapply, micNames]);

  // Web Audio last resort.
  const ctxRef = useRef<AudioContext | null>(null);
  useEffect(() => {
    if (strategy !== "webaudio") return;
    const useCtx = route === "speaker" && !headset;
    if (useCtx && !ctxRef.current) {
      try {
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        ctxRef.current = new Ctor({ latencyHint: "interactive" });
      } catch {
        ctxRef.current = null;
      }
    }
    const ctx = useCtx ? ctxRef.current : null;
    if (ctx && ctx.state !== "running") ctx.resume().catch(() => {});
    const apply = () => {
      for (const t of remoteAudioTracks(room)) routeTrack(t, ctx);
    };
    apply();
    const watched = new Set<RemoteAudioTrack>();
    const watch = () => {
      for (const t of remoteAudioTracks(room)) {
        if (watched.has(t)) continue;
        watched.add(t);
        t.on(TrackEvent.ElementAttached, apply);
      }
    };
    watch();
    const onSubscribed = (track: RemoteTrack) => {
      if (track.kind !== Track.Kind.Audio) return;
      watch();
      apply();
    };
    room.on(RoomEvent.TrackSubscribed, onSubscribed);
    return () => {
      room.off(RoomEvent.TrackSubscribed, onSubscribed);
      for (const t of watched) t.off(TrackEvent.ElementAttached, apply);
      for (const t of remoteAudioTracks(room)) routeTrack(t, null);
    };
  }, [room, strategy, route, headset]);

  useEffect(
    () => () => {
      ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
    },
    [],
  );

  const toggle = () => {
    if (strategy === "unsupported" || strategy === "none") return;
    const next: AudioRoute = route === "speaker" ? "earpiece" : "speaker";
    if (strategy === "webaudio" && next === "speaker" && !ctxRef.current) {
      // Created inside the tap so it may start (autoplay policy).
      try {
        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        ctxRef.current = new Ctor({ latencyHint: "interactive" });
        void ctxRef.current.resume();
      } catch {
        ctxRef.current = null;
      }
    }
    setChosen((c) => ({ ...c, [kind]: next }));
    saveRoutePrefs({ ...loadRoutePrefs(), [kind]: next });
  };

  const label = (d: Dev) => d.label || "(no name until the microphone is allowed)";
  return {
    route,
    strategy,
    headset: headset?.label ?? null,
    toggle,
    diagnostics: {
      platform,
      sinkSupported,
      outputs: devices.filter((d) => d.kind === "audiooutput").map(label),
      inputs: devices.filter((d) => d.kind === "audioinput").map(label),
      activeInput: activeMicLabel(room, devices),
      lastAction,
      lastError,
    },
  };
}
