/** Shared helpers for in-browser voice and video-message recording. */

export type RecordingKind = "voice" | "video";

const VOICE_TYPES = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
// The server transcodes every video to H.264/AAC MP4, so the cheapest
// encoder to run live (VP8) is preferred over a "nicer" container.
const VIDEO_TYPES = ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm", "video/mp4;codecs=avc1,mp4a", "video/mp4"];

export function pickRecordingMimeType(kind: RecordingKind): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const list = kind === "voice" ? VOICE_TYPES : VIDEO_TYPES;
  return list.find((t) => {
    try {
      return MediaRecorder.isTypeSupported(t);
    } catch {
      return false;
    }
  });
}

export function extensionForMime(mime: string): string {
  if (mime.includes("mp4")) return mime.startsWith("audio") ? "m4a" : "mp4";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

/** Recording needs a secure context, getUserMedia and MediaRecorder. */
export function canRecord(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** Reduces a run of level samples to `bars` values in 0–1, normalised to
 * the loudest bar so quiet recordings still draw a readable shape. */
export function downsampleWaveform(samples: number[], bars = 48): number[] {
  if (samples.length === 0) return Array.from({ length: bars }, () => 0.08);
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    const start = Math.floor((i / bars) * samples.length);
    const end = Math.max(start + 1, Math.floor(((i + 1) / bars) * samples.length));
    let peak = 0;
    for (let j = start; j < end && j < samples.length; j++) peak = Math.max(peak, samples[j]);
    out.push(peak);
  }
  const max = Math.max(...out, 0.0001);
  return out.map((v) => Math.round(Math.max(0.06, Math.min(1, v / max)) * 100) / 100);
}

/** Plain-language message for a getUserMedia failure. */
export function describeMediaError(err: unknown, kind: RecordingKind): string {
  const device = kind === "voice" ? "microphone" : "camera and microphone";
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return `Access to your ${device} is blocked. Allow it from the site settings next to the address bar, then try again.`;
  if (name === "NotFoundError" || name === "OverconstrainedError") return `No ${device} was found on this device.`;
  if (name === "NotReadableError") return `Your ${device} is being used by another app. Close it and try again.`;
  return `Couldn't start recording. Check your ${device} and try again.`;
}

/** MediaRecorder output (WebM especially) often has no duration in its
 * header, so `duration` reads `Infinity` and seeking breaks. Seeking far
 * past the end makes the browser scan the file and settle the real value. */
export function fixInfiniteDuration(el: HTMLMediaElement) {
  if (Number.isFinite(el.duration) && el.duration > 0) return;
  const restore = () => {
    el.removeEventListener("durationchange", restore);
    el.currentTime = 0;
  };
  el.addEventListener("durationchange", restore);
  try {
    el.currentTime = 1e101;
  } catch {
    el.removeEventListener("durationchange", restore);
  }
}

// One clip at a time across the whole app: starting a voice or video
// message pauses whatever else was playing.
let current: HTMLMediaElement | null = null;
export function claimPlayback(el: HTMLMediaElement) {
  if (current && current !== el && !current.paused) current.pause();
  current = el;
}
