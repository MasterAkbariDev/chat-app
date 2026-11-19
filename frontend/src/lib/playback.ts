"use client";

import { useSyncExternalStore } from "react";
import { claimPlayback, fixInfiniteDuration } from "@/lib/recording";

/** One voice message, round video message or music track, as the app-wide player knows it. */
export interface PlaybackTrack {
  /** Message id. */
  id: string;
  kind: "voice" | "video_note" | "music";
  src: string;
  durationSec?: number | null;
  senderName: string;
  createdAt?: string;
  channelId?: string;
  /** Music: from the file's tags (else its file name) / artist line / cover art URL. */
  title?: string;
  artist?: string | null;
  coverUrl?: string | null;
}

/** Finds the music track before (-1) or after (+1) `id` in its chat. */
export type AdjacentResolver = (id: string, dir: 1 | -1) => PlaybackTrack | null;

export interface PlaybackState {
  track: PlaybackTrack | null;
  playing: boolean;
  current: number;
  duration: number;
  rate: number;
  failed: boolean;
  /** A video note's video is shown inside its bubble (else the floating circle shows it). */
  inBubble: boolean;
}

export const PLAYBACK_RATES = [1, 1.5, 2] as const;

const EMPTY: PlaybackState = { track: null, playing: false, current: 0, duration: 0, rate: 1, failed: false, inBubble: false };

let state: PlaybackState = EMPTY;
const listeners = new Set<() => void>();
let audioEl: HTMLAudioElement | null = null;
let videoEl: HTMLVideoElement | null = null;
let parking: HTMLDivElement | null = null;
let bubbleHost: HTMLElement | null = null;
let pipHost: HTMLElement | null = null;
/** Finds the message to play after `id` ends (the chat's next voice message). */
let nextResolver: ((id: string) => PlaybackTrack | null) | null = null;
/** Music: the chat's previous/next track (Telegram plays a chat's music as a playlist). */
let adjacentResolver: AdjacentResolver | null = null;
let raf = 0;

function set(patch: Partial<PlaybackState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getPlaybackState(): PlaybackState {
  return state;
}

/** Subscribe to a slice — a bubble that isn't playing selects `null` and never re-renders. */
export function usePlayback<T>(selector: (s: PlaybackState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(EMPTY),
  );
}

function element(kind: PlaybackTrack["kind"]): HTMLMediaElement {
  if (kind !== "video_note") {
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.preload = "auto";
      wire(audioEl);
    }
    return audioEl;
  }
  if (!videoEl) {
    videoEl = document.createElement("video");
    videoEl.playsInline = true;
    videoEl.preload = "auto";
    videoEl.className = "block size-full rounded-full object-cover bg-black";
    videoEl.setAttribute("aria-hidden", "true");
    wire(videoEl);
  }
  return videoEl;
}

function active(): HTMLMediaElement | null {
  if (!state.track) return null;
  return state.track.kind === "video_note" ? videoEl : audioEl;
}

function tick() {
  const el = active();
  if (el && !el.paused) {
    if (Math.abs(el.currentTime - state.current) > 0.03) set({ current: el.currentTime });
    raf = requestAnimationFrame(tick);
  } else raf = 0;
}

function wire(el: HTMLMediaElement) {
  const mine = () => active() === el;
  el.addEventListener("loadedmetadata", () => {
    fixInfiniteDuration(el);
    if (mine() && Number.isFinite(el.duration) && el.duration > 0) set({ duration: el.duration });
  });
  el.addEventListener("durationchange", () => {
    if (mine() && Number.isFinite(el.duration) && el.duration > 0) set({ duration: el.duration });
  });
  el.addEventListener("timeupdate", () => {
    if (mine()) set({ current: el.currentTime });
  });
  el.addEventListener("play", () => {
    if (!mine()) return;
    set({ playing: true, failed: false });
    if (!raf) raf = requestAnimationFrame(tick);
  });
  el.addEventListener("pause", () => {
    if (mine()) set({ playing: false });
  });
  el.addEventListener("error", () => {
    if (mine()) set({ playing: false, failed: true });
  });
  el.addEventListener("ended", () => {
    if (!mine()) return;
    const finished = state.track;
    if (finished?.kind === "music") {
      // The chat's next track, else stop at the end (the bar stays, paused at the start, like
      // Telegram — so it can be replayed).
      const next = adjacentResolver?.(finished.id, 1) ?? null;
      if (next) play(next);
      else {
        el.currentTime = 0;
        set({ playing: false, current: 0 });
      }
      return;
    }
    const next = finished && nextResolver ? nextResolver(finished.id) : null;
    if (next && finished?.kind === "voice" && next.kind === "voice") {
      play(next);
    } else {
      stop();
    }
  });
}

function placeVideo() {
  if (!videoEl || typeof document === "undefined") return;
  const host = state.track?.kind === "video_note" ? (bubbleHost ?? pipHost) : null;
  let target: HTMLElement | null = host;
  if (!target) {
    if (!parking) {
      parking = document.createElement("div");
      parking.style.cssText = "position:fixed;width:1px;height:1px;left:-9999px;top:0;overflow:hidden;";
      parking.setAttribute("aria-hidden", "true");
      document.body.appendChild(parking);
    }
    target = parking;
  }
  // appendChild moves the node in one step — it never leaves the document, so it keeps playing.
  if (videoEl.parentElement !== target) target.appendChild(videoEl);
  const inBubble = !!bubbleHost && state.track?.kind === "video_note";
  if (inBubble !== state.inBubble) set({ inBubble });
}

/** Start (or restart from 0) a track with sound. `resolveNext` finds what plays after it. */
export function play(
  track: PlaybackTrack,
  opts: { resolveNext?: (id: string) => PlaybackTrack | null; resolveAdjacent?: AdjacentResolver; from?: number } = {},
) {
  if (typeof document === "undefined") return;
  if (opts.resolveNext) nextResolver = opts.resolveNext;
  if (opts.resolveAdjacent) adjacentResolver = opts.resolveAdjacent;
  const prev = active();
  const el = element(track.kind);
  if (prev && prev !== el) prev.pause();
  const same = state.track?.id === track.id;
  if (!same) {
    // A new track: the bubble that hosted the old video note no longer applies.
    bubbleHost = null;
    el.src = track.src;
    el.currentTime = 0;
    set({ track, current: opts.from ?? 0, duration: track.durationSec ?? 0, failed: false, playing: false, inBubble: false });
  }
  if (opts.from != null) el.currentTime = opts.from;
  el.muted = false;
  el.playbackRate = rateFor(track);
  if (track.kind === "video_note") placeVideo();
  updateMediaSession(track);
  claimPlayback(el);
  void el.play().catch(() => set({ playing: false }));
}

export function toggle() {
  const el = active();
  if (!el || !state.track) return;
  if (el.paused) {
    claimPlayback(el);
    el.playbackRate = rateFor(state.track);
    void el.play().catch(() => set({ playing: false }));
  } else el.pause();
}

export function pause() {
  active()?.pause();
}

export function seek(seconds: number) {
  const el = active();
  if (!el) return;
  const d = state.duration || el.duration || 0;
  const t = Math.max(0, Math.min(d > 0 ? d - 0.05 : seconds, seconds));
  el.currentTime = t;
  set({ current: t });
}

export function cycleRate() {
  const i = PLAYBACK_RATES.indexOf(state.rate as (typeof PLAYBACK_RATES)[number]);
  const rate = PLAYBACK_RATES[(i + 1) % PLAYBACK_RATES.length];
  const el = active();
  if (el && state.track) {
    set({ rate });
    el.playbackRate = rateFor(state.track);
  } else set({ rate });
}

/** Music always plays at 1× (Telegram has no speed control for music); the shared speed applies
 *  to voice and video messages. */
function rateFor(track: PlaybackTrack | null): number {
  return track?.kind === "music" ? 1 : state.rate;
}

/** Whether there's a previous/next music track in the playing track's chat. */
export function hasAdjacent(dir: 1 | -1): boolean {
  const t = state.track;
  return !!t && t.kind === "music" && !!adjacentResolver?.(t.id, dir);
}

/** Music: skip to the chat's previous (-1) / next (+1) track. "Previous" restarts the current
 *  track first when it's more than 3 s in, like every music player. */
export function skip(dir: 1 | -1) {
  const t = state.track;
  if (!t || t.kind !== "music") return;
  if (dir === -1 && state.current > 3) {
    seek(0);
    return;
  }
  const next = adjacentResolver?.(t.id, dir);
  if (next) play(next);
  else if (dir === -1) seek(0);
}

/** Lock-screen / hardware media keys for music (where the browser supports it). */
function updateMediaSession(track: PlaybackTrack) {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  try {
    const ms = navigator.mediaSession;
    if (track.kind !== "music") {
      ms.metadata = null;
      return;
    }
    ms.metadata = new MediaMetadata({
      title: track.title ?? "Music",
      artist: track.artist ?? "",
      artwork: track.coverUrl ? [{ src: track.coverUrl, sizes: "320x320", type: "image/jpeg" }] : [],
    });
    ms.setActionHandler("play", () => toggle());
    ms.setActionHandler("pause", () => pause());
    ms.setActionHandler("previoustrack", () => skip(-1));
    ms.setActionHandler("nexttrack", () => skip(1));
  } catch {
    // Media Session is optional.
  }
}

/** Stop and forget the track (the bar and floating circle go away). */
export function stop() {
  const el = active();
  if (el) {
    el.pause();
    el.removeAttribute("src");
    el.load();
  }
  bubbleHost = null;
  set({ ...EMPTY, rate: state.rate });
  placeVideo();
}

/** A video note's bubble shows the shared video while it's on screen. Returns the cleanup. */
export function hostVideoInBubble(trackId: string, host: HTMLElement): () => void {
  if (state.track?.id !== trackId) return () => {};
  bubbleHost = host;
  placeVideo();
  return () => {
    if (bubbleHost === host) {
      bubbleHost = null;
      placeVideo();
    }
  };
}

/** The floating circle registers where the video goes while its bubble is off screen. */
export function registerPipHost(host: HTMLElement | null) {
  pipHost = host;
  placeVideo();
}

// "Show this message": the open chat registers how to scroll to one of its messages.
const jumpHandlers = new Map<string, (messageId: string) => void>();
let pendingJump: { channelId: string; messageId: string } | null = null;

/** Called by the open conversation. Runs a jump that was requested before it mounted. */
export function registerJumpHandler(channelId: string, handler: (messageId: string) => void): () => void {
  jumpHandlers.set(channelId, handler);
  if (pendingJump?.channelId === channelId) {
    const id = pendingJump.messageId;
    pendingJump = null;
    setTimeout(() => handler(id), 300);
  }
  return () => {
    if (jumpHandlers.get(channelId) === handler) jumpHandlers.delete(channelId);
  };
}

/** Scrolls to the track's message if its chat is open; otherwise remembers it and returns
 *  false so the caller can navigate there. */
export function jumpToTrack(track: PlaybackTrack): boolean {
  if (!track.channelId) return true;
  // A music group's later tracks are `<messageId>#<i>` (lib/music.ts): jump to the message.
  const messageId = track.id.split("#")[0];
  const handler = jumpHandlers.get(track.channelId);
  if (handler) {
    handler(messageId);
    return true;
  }
  pendingJump = { channelId: track.channelId, messageId };
  return false;
}
