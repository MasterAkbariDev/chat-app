"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Pause, RotateCcw, SendHorizontal, Square, SwitchCamera, Trash2 } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/recording";
import { VideoNotePlayer } from "./VideoNotePlayer";
import { useMediaRecording, type AcquiredStreams, type RecordingResult } from "./use-media-recording";

const MAX_VIDEO_NOTE_SEC = 60;
const CANVAS_PX = 480;
const FPS = 30;
/** Camera constraints: a 4:3/16:9 ~640px stream at 30 fps — enough for a 480px circle, and far
 *  cheaper to decode + draw every frame than 720p (which made slower machines drop frames). */
const CAMERA: MediaTrackConstraints = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: FPS, max: FPS } };

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export interface VideoNoteRecorderProps {
  onSend: (recording: RecordingResult) => Promise<void>;
  onClose: () => void;
}

/** Records a round video message. The camera is drawn into a square canvas
 * (centre-cropped, mirrored for the selfie camera) and *that* is what's
 * recorded — so the circle you see while recording is exactly what gets
 * sent, and switching cameras mid-recording doesn't break the file. */
export function VideoNoteRecorder({ onSend, onClose }: VideoNoteRecorderProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRef = useRef<MediaStream | null>(null);
  const mirrorRef = useRef(true);
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const [cameraCount, setCameraCount] = useState(0);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [size, setSize] = useState(280);

  useEffect(() => {
    const update = () => setSize(Math.round(Math.min(300, window.innerWidth * 0.74, window.innerHeight * 0.42)));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const acquire = useCallback(async (): Promise<AcquiredStreams> => {
    const media = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", ...CAMERA },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    mediaRef.current = media;
    mirrorRef.current = true;
    const video = videoRef.current!;
    video.srcObject = media;
    await video.play().catch(() => {});

    // "Record again" starts from the review screen, where the canvas isn't
    // mounted yet — give React a frame to put it back.
    for (let i = 0; i < 10 && !canvasRef.current; i++) await new Promise((r) => requestAnimationFrame(r));
    const canvas = canvasRef.current;
    if (!canvas) {
      media.getTracks().forEach((t) => t.stop());
      throw new Error("camera preview unavailable");
    }
    canvas.width = CANVAS_PX;
    canvas.height = CANVAS_PX;
    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true })!;
    const v = video as FrameCallbackVideo;
    let raf = 0;
    let vfc = 0;
    let stopped = false;
    let firstFrame: () => void = () => {};
    const firstFrameDrawn = new Promise<void>((resolve) => {
      firstFrame = resolve;
    });
    const paint = () => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;
      const side = Math.min(vw, vh);
      const sx = (vw - side) / 2;
      const sy = (vh - side) / 2;
      ctx.save();
      if (mirrorRef.current) {
        ctx.translate(CANVAS_PX, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video, sx, sy, side, side, 0, 0, CANVAS_PX, CANVAS_PX);
      ctx.restore();
      firstFrame();
    };
    // One canvas paint per *camera* frame (requestVideoFrameCallback) instead of per display
    // refresh: no repeated frames at 60/120 Hz, no skipped ones when rAF and the camera drift —
    // the captured track gets the camera's own 30 fps cadence. rAF is the fallback (Firefox).
    if (v.requestVideoFrameCallback) {
      const onFrame = () => {
        if (stopped) return;
        paint();
        vfc = v.requestVideoFrameCallback!(onFrame);
      };
      vfc = v.requestVideoFrameCallback(onFrame);
      paint();
    } else {
      const draw = () => {
        if (stopped) return;
        paint();
        raf = requestAnimationFrame(draw);
      };
      draw();
    }

    // Don't hand the stream to MediaRecorder until a real frame is on the canvas — otherwise the
    // clip starts with blank/black frames and its video track begins later than the audio
    // (what looked like the start being cut). The camera usually delivers within ~100–500 ms.
    await Promise.race([firstFrameDrawn, new Promise((r) => setTimeout(r, 3000))]);

    const canvasStream = canvas.captureStream(FPS);
    const stream = new MediaStream([...canvasStream.getVideoTracks(), ...media.getAudioTracks()]);

    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => setCameraCount(devices.filter((d) => d.kind === "videoinput").length))
      .catch(() => {});

    return {
      stream,
      audio: new MediaStream(media.getAudioTracks()),
      // Only tear down what *this* acquisition owns: an abandoned start (dev
      // double-mount, "record again") must not blank a newer one's preview.
      release: () => {
        stopped = true;
        cancelAnimationFrame(raf);
        if (vfc) v.cancelVideoFrameCallback?.(vfc);
        canvasStream.getTracks().forEach((t) => t.stop());
        media.getTracks().forEach((t) => t.stop());
        const own = mediaRef.current === media || (mediaRef.current?.getAudioTracks()[0] === media.getAudioTracks()[0]);
        if (own) {
          mediaRef.current?.getTracks().forEach((t) => t.stop());
          mediaRef.current = null;
          if (videoRef.current) videoRef.current.srcObject = null;
        }
      },
    };
  }, []);

  const rec = useMediaRecording({ kind: "video", maxSec: MAX_VIDEO_NOTE_SEC, acquire });
  const { start, pause, phase } = rec;

  useEffect(() => {
    void start();
  }, [start]);

  // The canvas only redraws while the tab is visible, so recording a hidden
  // tab would freeze the picture — pause instead.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden && phase === "recording") pause();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [phase, pause]);

  async function flipCamera() {
    const current = mediaRef.current;
    if (!current) return;
    const next = facing === "user" ? "environment" : "user";
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: next }, ...CAMERA },
      });
      current.getVideoTracks().forEach((t) => t.stop());
      const combined = new MediaStream([...fresh.getVideoTracks(), ...current.getAudioTracks()]);
      mediaRef.current = combined;
      mirrorRef.current = next === "user";
      if (videoRef.current) {
        videoRef.current.srcObject = combined;
        await videoRef.current.play().catch(() => {});
      }
      setFacing(next);
    } catch {
      // Keep the current camera if the other one can't be opened.
    }
  }

  function discard() {
    if (sending) return;
    rec.cancel();
    onClose();
  }

  async function send() {
    if (sending) return;
    setSendError(null);
    const result = rec.phase === "review" ? rec.result : await rec.stop();
    if (!result) return;
    setSending(true);
    try {
      await onSend(result);
      onClose();
    } catch (err) {
      setSendError(err instanceof Error && err.message ? err.message : "The video message didn't send. Try again.");
    } finally {
      setSending(false);
    }
  }

  const live = rec.phase === "recording" || rec.phase === "paused";
  const stroke = 5;
  const ringR = size / 2 + 6;
  const ringBox = size + 24;
  const circumference = 2 * Math.PI * ringR;
  const progress = Math.min(1, rec.elapsed / MAX_VIDEO_NOTE_SEC);
  const ctrl = "pressable flex size-12 items-center justify-center rounded-full disabled:opacity-40";

  return (
    <Dialog onClose={discard} aria-label="Record a video message" hideClose dismissible={!sending} size="sm" bodyClassName="flex flex-col items-center gap-5 pb-2 pt-4">
      {/* Source for the canvas. Not `display:none` — Chrome stops decoding
       * frames for a non-rendered video, which left the circle (and the
       * recording) blank. Kept rendered at 1px, invisible. */}
      <video ref={videoRef} muted playsInline autoPlay aria-hidden className="pointer-events-none fixed start-0 top-0 size-px opacity-0" />

      <div className="relative flex items-center justify-center" style={{ width: ringBox, height: ringBox }}>
        {rec.phase === "review" && rec.result ? (
          <VideoNotePlayer src={rec.result.url} durationSec={rec.result.durationSec} size={size} autoPlay label="Your video message" />
        ) : (
          <div className="relative overflow-hidden rounded-full bg-sunken" style={{ width: size, height: size }}>
            <canvas ref={canvasRef} className={cn("size-full", !live && "opacity-0")} aria-hidden />
            {rec.phase === "starting" ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[13.5px] text-muted">
                <span className="size-7 animate-spin rounded-full border-2 border-muted border-t-transparent" aria-hidden />
                Starting camera…
              </div>
            ) : rec.phase === "error" ? (
              <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center text-[13.5px] text-danger">
                {rec.error}
                <button type="button" onClick={() => void rec.start()} className="pressable rounded-full bg-danger-soft px-3 py-1 font-semibold">
                  Try again
                </button>
              </div>
            ) : null}
            {rec.phase === "paused" ? (
              <div className="absolute inset-0 flex items-center justify-center bg-black/35">
                <span className="rounded-full bg-black/55 px-3 py-1 text-[13px] font-semibold text-white">Paused</span>
              </div>
            ) : null}
          </div>
        )}
        {live ? (
          <svg className="pointer-events-none absolute inset-0 -rotate-90" width={ringBox} height={ringBox} aria-hidden>
            <circle cx={ringBox / 2} cy={ringBox / 2} r={ringR} fill="none" stroke="var(--line)" strokeWidth={stroke} />
            <circle
              cx={ringBox / 2}
              cy={ringBox / 2}
              r={ringR}
              fill="none"
              stroke={rec.phase === "recording" ? "var(--danger)" : "var(--muted)"}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - progress)}
            />
          </svg>
        ) : null}
      </div>

      <div className="flex h-6 items-center gap-2 text-[14px]" aria-live="polite">
        {live ? (
          <>
            <span aria-hidden className={cn("size-2.5 rounded-full", rec.phase === "recording" ? "animate-pulse bg-danger" : "bg-muted")} />
            <span className="tabular font-semibold text-fg">{formatDuration(rec.elapsed)}</span>
            <span className="tabular text-muted">/ {formatDuration(MAX_VIDEO_NOTE_SEC)}</span>
          </>
        ) : rec.phase === "review" ? (
          <span className="text-muted">Tap the circle to watch it again</span>
        ) : null}
      </div>

      <div className="flex items-center justify-center gap-3">
        <button type="button" onClick={discard} disabled={sending} aria-label="Discard video message" title="Discard (Esc)" className={cn(ctrl, "bg-danger-soft text-danger")}>
          <Trash2 className="size-5" strokeWidth={1.9} />
        </button>

        {live && cameraCount > 1 ? (
          <button type="button" onClick={() => void flipCamera()} aria-label="Switch camera" title="Switch camera" className={cn(ctrl, "bg-sunken text-fg-2 hover:text-fg")}>
            <SwitchCamera className="size-5" strokeWidth={1.9} />
          </button>
        ) : null}

        {live ? (
          <>
            <button
              type="button"
              onClick={rec.phase === "recording" ? rec.pause : rec.resume}
              aria-label={rec.phase === "recording" ? "Pause recording" : "Resume recording"}
              title={rec.phase === "recording" ? "Pause" : "Resume"}
              className={cn(ctrl, "bg-sunken text-fg-2 hover:text-fg")}
            >
              {rec.phase === "recording" ? <Pause className="size-5" fill="currentColor" strokeWidth={0} /> : <Mic className="size-5 text-danger" strokeWidth={2} />}
            </button>
            <button type="button" onClick={() => void rec.stop()} aria-label="Stop and watch" title="Stop and watch" className={cn(ctrl, "bg-sunken text-fg-2 hover:text-fg")}>
              <Square className="size-[18px]" fill="currentColor" strokeWidth={0} />
            </button>
          </>
        ) : rec.phase === "review" ? (
          <button type="button" onClick={() => void rec.start()} disabled={sending} aria-label="Record again" title="Record again" className={cn(ctrl, "bg-sunken text-fg-2 hover:text-fg")}>
            <RotateCcw className="size-5" strokeWidth={1.9} />
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => void send()}
          disabled={sending || !(live || rec.phase === "review")}
          aria-label="Send video message"
          title="Send"
          className={cn(ctrl, "size-14 bg-accent text-accent-fg hover:bg-accent-hover")}
        >
          {sending ? (
            <span className="size-5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
          ) : (
            <SendHorizontal className="size-6 rtl:rotate-180" strokeWidth={2} />
          )}
        </button>
      </div>

      {sendError ? (
        <p role="alert" className="text-center text-[13.5px] text-danger">
          {sendError}
        </p>
      ) : sending ? (
        <p className="text-center text-[13.5px] text-muted" role="status">
          Sending your video message…
        </p>
      ) : null}
    </Dialog>
  );
}
