"use client";

import {
  AudioPresets,
  type AudioCaptureOptions,
  VideoPresets,
  type LocalParticipant,
  type RoomOptions,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
} from "livekit-client";

/**
 * Capture / publish settings for calls, in one place.
 *
 * Why the camera looked bad before: a 16:9 *aspect ratio* was part of the
 * capture constraints (VideoPresets.h720.resolution carries one), so 4:3 and
 * portrait phone cameras were cropped/rescaled by the browser before
 * encoding; and adaptive stream sized layers at 1 CSS px = 1 video px, so on
 * a 2–3× phone screen a spotlighted tile still pulled a low simulcast layer
 * and was upscaled (soft, washed-out colour). Now width/height are only
 * *ideals* (the camera's own aspect and orientation win), layers are picked
 * for the screen's real pixel density, and the top layer gets a proper
 * bitrate.
 */
export const CAMERA_RESOLUTION = { width: 1280, height: 720, frameRate: 30 };

export const ROOM_OPTIONS: RoomOptions = {
  // Download only the layer each tile needs (at device pixels), and pause
  // video nobody can see (filmstrip scrolled away, call minimized, tab hidden).
  adaptiveStream: { pixelDensity: "screen", pauseVideoInBackground: true },
  dynacast: true,
  // One deterministic playback path: remote audio through `<audio>` elements
  // (RoomAudioRenderer), never a shared Web Audio mix — on phones the two are
  // routed differently (call → earpiece vs media → loudspeaker). The
  // Earpiece/Speaker toggle (call-audio-route.ts) is the only thing that
  // switches. And the mic track keeps capturing while muted (just disabled),
  // so Android stays in "voice call" audio mode instead of flipping when you
  // mute/unmute.
  webAudioMix: false,
  videoCaptureDefaults: { resolution: CAMERA_RESOLUTION, facingMode: "user" },
  // The mic always keeps echo cancellation/noise suppression/AGC — that's
  // what stops a shared tab's sound (played on the other side) echoing back.
  audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  publishDefaults: {
    simulcast: true,
    // VP8: simulcast everywhere, decodes on every browser (Safari included)
    // without LiveKit's backup-codec dance; VP9/AV1 are software-encoded on
    // many phones and would trade heat/battery for little gain at 720p.
    videoCodec: "vp8",
    videoEncoding: { maxBitrate: 1_700_000, maxFramerate: 30 },
    videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
    screenShareEncoding: { maxBitrate: 2_500_000, maxFramerate: 15 },
    dtx: true,
    red: true,
    // Mute = disable the track, not stop the mic (see webAudioMix above).
    stopMicTrackOnMute: false,
  },
};

/** Camera publish options: under a weak uplink keep a balance of sharpness
 *  and smoothness rather than collapsing to a postage stamp. */
export const CAMERA_PUBLISH: TrackPublishOptions = { degradationPreference: "balanced" };

export function enableCamera(lp: LocalParticipant, on = true) {
  return lp.setCameraEnabled(on, on ? { resolution: CAMERA_RESOLUTION } : undefined, on ? CAMERA_PUBLISH : undefined);
}

export type ShareContent = "detail" | "motion";

/** Can this browser capture audio with a screen share? Chromium desktop only
 *  (tab audio everywhere; whole-system audio on Windows/ChromeOS). Firefox
 *  and Safari return video only. */
export function canShareAudio(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|Mobile/i.test(ua);
  const chromium = /Chrome\/|Chromium\/|Edg\//.test(ua) && !/OPR\/|SamsungBrowser/.test(ua);
  return chromium && !mobile;
}

export type DesktopOS = "mac" | "windows" | "chromeos" | "linux" | "other";
export function desktopOS(): DesktopOS {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/CrOS/.test(ua)) return "chromeos";
  if (/Windows/.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/.test(ua)) return "mac";
  if (/Linux/.test(ua)) return "linux";
  return "other";
}

/** Only Windows and ChromeOS can share the whole computer's sound; on a Mac
 * and Linux, Chrome captures sound from a *tab* only — picking a window or
 * the entire screen silently returns video without audio. */
export function systemAudioSupported(os = desktopOS()): boolean {
  return os === "windows" || os === "chromeos";
}

/** Shown in the pre-share dialog, before the browser's own picker. */
export function screenShareAudioHint(os = desktopOS()): string {
  return systemAudioSupported(os)
    ? "Others hear the sound of a tab, or of your whole computer if you share the entire screen. In the next step, keep \u201cAlso share tab audio\u201d or \u201cAlso share system audio\u201d on. Sharing a single window has no sound."
    : "Only a browser tab can share sound here. In the next step, pick a tab (not a window or the entire screen) and keep \u201cAlso share tab audio\u201d on.";
}

/** After sharing started without the sound the user asked for. `surface` is
 * the shared video's displaySurface ("browser" | "window" | "monitor"). */
export function noShareAudioMessage(surface: string | undefined, os = desktopOS()): string {
  if (surface === "browser") return "No sound is being shared. Share again and keep \u201cAlso share tab audio\u201d on.";
  if (surface === "monitor" && systemAudioSupported(os))
    return "No sound is being shared. Share again and keep \u201cAlso share system audio\u201d on.";
  return systemAudioSupported(os)
    ? "No sound is being shared — a window can't share sound. Share again and pick a tab or the entire screen."
    : "No sound is being shared — only a browser tab can share sound. Share again and pick a tab with \u201cAlso share tab audio\u201d on.";
}

export function screenShareOptions(
  withAudio: boolean,
  content: ShareContent,
  /** Keep the shared tab audible on the sharer's own device. Off mutes it locally (Chrome's
   *  `suppressLocalAudioPlayback`), which stops a speaker → mic echo but silences the tab. */
  hearLocally = true,
): {
  capture: ScreenShareCaptureOptions;
  publish: TrackPublishOptions;
} {
  const motion = content === "motion";
  return {
    capture: {
      // Raw sound for shared media: the speech-call processing (AEC/NS/AGC)
      // would mangle music and film audio.
      // `suppressLocalAudioPlayback` goes *inside* the audio constraints:
      // livekit-client 2.22 accepts the top-level option but never passes it
      // to getDisplayMedia. When on, it stops the captured tab playing through
      // the sharer's own speakers (no speaker → mic echo, but the sharer hears
      // nothing); the sharer chooses ("Hear it on this device"). Either way the
      // app never plays the sharer's own share track back to them.
      audio: withAudio
        ? ({
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            suppressLocalAudioPlayback: !hearLocally,
          } as AudioCaptureOptions)
        : false,
      // With sound on a Mac/Linux, open the picker on its Tab pane — the
      // only kind of source that has sound there.
      video: withAudio && !systemAudioSupported() ? { displaySurface: "browser" } : true,
      systemAudio: "include",
      suppressLocalAudioPlayback: withAudio && !hearLocally,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
      contentHint: motion ? "motion" : "detail",
      resolution: { width: 1920, height: 1080, frameRate: motion ? 30 : 15 },
    },
    publish: {
      screenShareEncoding: motion ? { maxBitrate: 4_000_000, maxFramerate: 30 } : { maxBitrate: 2_500_000, maxFramerate: 15 },
      degradationPreference: motion ? "balanced" : "maintain-resolution",
      audioPreset: AudioPresets.musicHighQualityStereo,
      // Tab/system audio is stereo. livekit-client would detect that from
      // channelCount, but its own publishDefaults carry forceStereo: false,
      // which wins over the detection — so ask for it explicitly.
      forceStereo: withAudio,
      dtx: false,
      red: false,
    },
  };
}

/** Whether this browser lets a page choose the audio output device. */
export function canPickSpeaker(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

const PREFS_KEY = "chat:call-share";
export interface SharePrefs {
  audio: boolean;
  content: ShareContent;
  /** Keep hearing the shared audio on this device (default on). */
  hearLocally: boolean;
}
export function loadSharePrefs(): SharePrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as {
      audio?: unknown;
      content?: unknown;
      hearLocally?: unknown;
    } | null;
    return {
      audio: raw?.audio !== false,
      content: raw?.content === "motion" ? "motion" : "detail",
      hearLocally: raw?.hearLocally !== false,
    };
  } catch {
    return { audio: true, content: "detail", hearLocally: true };
  }
}
export function saveSharePrefs(prefs: SharePrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode */
  }
}
