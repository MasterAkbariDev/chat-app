"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { describeMediaError, downsampleWaveform, pickRecordingMimeType, type RecordingKind } from "@/lib/recording";

export type RecordingPhase = "idle" | "starting" | "recording" | "paused" | "review" | "error";

export interface RecordingResult {
  blob: Blob;
  url: string;
  mimeType: string;
  durationSec: number;
  /** 0–1, 48 bars — only meaningful for voice. */
  waveform: number[];
}

export interface AcquiredStreams {
  /** What gets recorded. */
  stream: MediaStream;
  /** Mic track(s) to meter — usually the same stream. */
  audio: MediaStream;
  /** Stops every device track and any drawing loop. */
  release: () => void;
}

const TICK_MS = 80;
const LIVE_BARS = 36;

/** MediaRecorder lifecycle for one clip: start → (pause ⇄ resume) → stop →
 * review, or cancel at any point. Elapsed time counts only while actually
 * recording, and recording stops itself at `maxSec`. Devices are released
 * as soon as recording stops, so the camera light / mic indicator goes off
 * during review. */
export function useMediaRecording({
  kind,
  maxSec,
  acquire,
}: {
  kind: RecordingKind;
  maxSec: number;
  acquire: () => Promise<AcquiredStreams>;
}) {
  const [phase, setPhase] = useState<RecordingPhase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(LIVE_BARS).fill(0));
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RecordingResult | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const releaseRef = useRef<(() => void) | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const samplesRef = useRef<number[]>([]);
  const accumulatedRef = useRef(0);
  const segmentStartRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const discardRef = useRef(false);
  // Bumped by cancel/unmount so a start() still waiting on the permission
  // prompt knows it's been abandoned and releases what it got.
  const generationRef = useRef(0);
  const stopResolversRef = useRef<((r: RecordingResult | null) => void)[]>([]);
  const resultUrlRef = useRef<string | null>(null);
  const acquireRef = useRef(acquire);
  useEffect(() => {
    acquireRef.current = acquire;
  });

  const activeSeconds = () =>
    (accumulatedRef.current + (segmentStartRef.current != null ? performance.now() - segmentStartRef.current : 0)) / 1000;

  const teardownDevices = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    releaseRef.current?.();
    releaseRef.current = null;
    analyserRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }, []);

  const revokeResult = useCallback(() => {
    if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
    resultUrlRef.current = null;
  }, []);

  const stop = useCallback((): Promise<RecordingResult | null> => {
    const rec = recorderRef.current;
    if (!rec || rec.state === "inactive") return Promise.resolve(null);
    if (segmentStartRef.current != null) {
      accumulatedRef.current += performance.now() - segmentStartRef.current;
      segmentStartRef.current = null;
    }
    return new Promise((resolve) => {
      stopResolversRef.current.push(resolve);
      rec.stop();
    });
  }, []);

  const tick = useCallback(() => {
    const secs = activeSeconds();
    setElapsed(secs);
    const analyser = analyserRef.current;
    if (analyser && segmentStartRef.current != null) {
      const buf = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.min(1, Math.sqrt(sum / buf.length) * 3.2);
      samplesRef.current.push(rms);
      setLevels((prev) => [...prev.slice(1), rms]);
    }
    if (secs >= maxSec) void stop();
  }, [maxSec, stop]);

  const start = useCallback(async () => {
    revokeResult();
    setResult(null);
    setError(null);
    setElapsed(0);
    setLevels(Array(LIVE_BARS).fill(0));
    samplesRef.current = [];
    accumulatedRef.current = 0;
    chunksRef.current = [];
    discardRef.current = false;
    const generation = ++generationRef.current;
    setPhase("starting");

    let acquired: AcquiredStreams;
    try {
      acquired = await acquireRef.current();
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(describeMediaError(err, kind));
      setPhase("error");
      return;
    }
    if (generation !== generationRef.current) {
      acquired.release();
      return;
    }
    releaseRef.current = acquired.release;

    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (Ctx && acquired.audio.getAudioTracks().length) {
        const ctx = new Ctx();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(acquired.audio).connect(analyser);
        audioCtxRef.current = ctx;
        analyserRef.current = analyser;
      }
    } catch {
      // Metering is cosmetic — recording still works without it.
    }

    const mimeType = pickRecordingMimeType(kind);
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(acquired.stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: kind === "voice" ? 48_000 : 64_000,
        // ~1.2 Mbps keeps a 480px, 30 fps circle sharp without making the encoder fall behind
        // (it's re-encoded server-side anyway).
        ...(kind === "video" ? { videoBitsPerSecond: 1_200_000 } : {}),
      });
    } catch {
      teardownDevices();
      setError("This browser can't record here. Try a recent Chrome, Edge, Firefox or Safari.");
      setPhase("error");
      return;
    }
    recorderRef.current = rec;
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      teardownDevices();
      const resolvers = stopResolversRef.current;
      stopResolversRef.current = [];
      if (discardRef.current) {
        chunksRef.current = [];
        resolvers.forEach((r) => r(null));
        return;
      }
      const type = rec.mimeType || mimeType || (kind === "voice" ? "audio/webm" : "video/webm");
      const blob = new Blob(chunksRef.current, { type });
      const url = URL.createObjectURL(blob);
      resultUrlRef.current = url;
      const res: RecordingResult = {
        blob,
        url,
        mimeType: type,
        durationSec: Math.max(1, Math.round(accumulatedRef.current / 1000)),
        waveform: downsampleWaveform(samplesRef.current),
      };
      setResult(res);
      setElapsed(accumulatedRef.current / 1000);
      setPhase("review");
      resolvers.forEach((r) => r(res));
    };
    rec.start(250);
    segmentStartRef.current = performance.now();
    timerRef.current = setInterval(tick, TICK_MS);
    setPhase("recording");
  }, [kind, revokeResult, teardownDevices, tick]);

  const pause = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== "recording") return;
    rec.pause();
    if (segmentStartRef.current != null) accumulatedRef.current += performance.now() - segmentStartRef.current;
    segmentStartRef.current = null;
    setElapsed(accumulatedRef.current / 1000);
    setPhase("paused");
  }, []);

  const resume = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== "paused") return;
    rec.resume();
    segmentStartRef.current = performance.now();
    setPhase("recording");
  }, []);

  /** Throws away the clip (recording or reviewed) and frees the devices. */
  const cancel = useCallback(() => {
    generationRef.current++;
    discardRef.current = true;
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    else teardownDevices();
    segmentStartRef.current = null;
    revokeResult();
    setResult(null);
    setPhase("idle");
  }, [revokeResult, teardownDevices]);

  // Unmount: never leave the mic or camera running.
  useEffect(
    () => () => {
      generationRef.current++;
      discardRef.current = true;
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") rec.stop();
      teardownDevices();
      revokeResult();
    },
    [teardownDevices, revokeResult],
  );

  return { phase, elapsed, levels, error, result, start, pause, resume, stop, cancel };
}
