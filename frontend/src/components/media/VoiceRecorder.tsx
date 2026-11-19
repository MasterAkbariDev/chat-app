"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Pause, SendHorizontal, Square, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatDuration } from "@/lib/recording";
import { VoicePlayer } from "./VoicePlayer";
import { useMediaRecording, type AcquiredStreams, type RecordingResult } from "./use-media-recording";

const MAX_VOICE_SEC = 15 * 60;

export interface VoiceRecorderProps {
  /** Upload + send. Rejecting keeps the clip so the user can try again. */
  onSend: (recording: RecordingResult) => Promise<void>;
  onClose: () => void;
}

async function acquireMic(): Promise<AcquiredStreams> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  return { stream, audio: stream, release: () => stream.getTracks().forEach((t) => t.stop()) };
}

/** Replaces the composer row while a voice message is being made:
 *  recording (pause/resume, stop to review, send straight away, discard)
 *  → review (play it back, scrub, then send or discard). */
export function VoiceRecorder({ onSend, onClose }: VoiceRecorderProps) {
  const rec = useMediaRecording({ kind: "voice", maxSec: MAX_VOICE_SEC, acquire: acquireMic });
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const { start } = rec;

  useEffect(() => {
    void start();
  }, [start]);

  useEffect(() => {
    if (rec.phase === "recording" || rec.phase === "review") primaryRef.current?.focus();
  }, [rec.phase]);

  const discard = useCallback(() => {
    rec.cancel();
    onClose();
  }, [rec, onClose]);

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
      setSendError(err instanceof Error && err.message ? err.message : "The voice message didn't send. Try again.");
    } finally {
      setSending(false);
    }
  }

  const live = rec.phase === "recording" || rec.phase === "paused";
  const iconBtn = "pressable flex size-10 shrink-0 items-center justify-center rounded-full disabled:opacity-40";

  return (
    <div
      className="flex flex-col gap-1.5"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !sending) {
          e.preventDefault();
          discard();
        }
      }}
    >
      <div role="group" aria-label="Voice message" className="flex min-h-11 items-center gap-1.5">
        <button
          type="button"
          onClick={discard}
          disabled={sending}
          aria-label="Discard voice message"
          title="Discard (Esc)"
          className={cn(iconBtn, "text-danger hover:bg-danger-soft")}
        >
          <Trash2 className="size-5" strokeWidth={1.8} />
        </button>

        {rec.phase === "error" ? (
          <div role="alert" className="flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-md)] bg-danger-soft px-3 py-2 text-[13.5px] text-danger">
            <span className="min-w-0 flex-1">{rec.error}</span>
            <button type="button" onClick={() => void rec.start()} className="pressable shrink-0 rounded-full px-2 py-0.5 font-semibold hover:bg-danger/10">
              Try again
            </button>
          </div>
        ) : rec.phase === "review" && rec.result ? (
          <div className="flex min-w-0 flex-1 items-center rounded-[22px] border border-line bg-sunken px-2 py-1">
            <VoicePlayer src={rec.result.url} durationSec={rec.result.durationSec} waveform={rec.result.waveform} label="Your recording" />
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3 rounded-[22px] border border-line bg-sunken px-3.5 py-2">
            <span
              aria-hidden
              className={cn("size-2.5 shrink-0 rounded-full", rec.phase === "recording" ? "animate-pulse bg-danger" : "bg-muted")}
            />
            <span className="tabular w-11 shrink-0 text-[14.5px] font-semibold text-fg" aria-live="off">
              {formatDuration(rec.elapsed)}
            </span>
            <span className="sr-only" role="status">
              {rec.phase === "starting" ? "Waiting for the microphone" : rec.phase === "paused" ? "Recording paused" : "Recording"}
            </span>
            {rec.phase === "starting" ? (
              <span className="truncate text-[13.5px] text-muted">Waiting for the microphone…</span>
            ) : (
              <span aria-hidden className="flex h-7 min-w-0 flex-1 items-center justify-end gap-[3px] overflow-hidden">
                {rec.levels.map((v, i) => (
                  <span
                    key={i}
                    className={cn("w-[3px] shrink-0 rounded-full", rec.phase === "paused" ? "bg-line-strong" : "bg-accent")}
                    style={{ height: `${Math.max(12, v * 100)}%` }}
                  />
                ))}
              </span>
            )}
            {rec.phase === "paused" ? <span className="shrink-0 text-[13px] font-medium text-muted">Paused</span> : null}
          </div>
        )}

        {live ? (
          <>
            <button
              ref={rec.phase === "recording" ? primaryRef : undefined}
              type="button"
              onClick={rec.phase === "recording" ? rec.pause : rec.resume}
              aria-label={rec.phase === "recording" ? "Pause recording" : "Resume recording"}
              title={rec.phase === "recording" ? "Pause" : "Resume"}
              className={cn(iconBtn, "text-fg-2 hover:bg-sunken hover:text-fg")}
            >
              {rec.phase === "recording" ? <Pause className="size-5" fill="currentColor" strokeWidth={0} /> : <Mic className="size-5 text-danger" strokeWidth={2} />}
            </button>
            <button
              type="button"
              onClick={() => void rec.stop()}
              aria-label="Stop and listen back"
              title="Stop and listen back"
              className={cn(iconBtn, "text-fg-2 hover:bg-sunken hover:text-fg")}
            >
              <Square className="size-[18px]" fill="currentColor" strokeWidth={0} />
            </button>
          </>
        ) : null}

        <button
          ref={rec.phase === "review" ? primaryRef : undefined}
          type="button"
          onClick={() => void send()}
          disabled={sending || !(live || rec.phase === "review")}
          aria-label="Send voice message"
          title="Send"
          className={cn(iconBtn, "size-11 bg-accent text-accent-fg hover:bg-accent-hover")}
        >
          {sending ? (
            <span className="size-5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
          ) : (
            <SendHorizontal className="size-5 rtl:rotate-180" strokeWidth={2} />
          )}
        </button>
      </div>
      {sendError ? (
        <p role="alert" className="ps-12 text-[13px] text-danger">
          {sendError}
        </p>
      ) : null}
    </div>
  );
}
