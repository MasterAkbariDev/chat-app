"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { CropOverlay } from "./CropOverlay";
import { TrimTimeline, formatClock } from "./TrimTimeline";
import { ASPECTS, FULL_RECT, type VideoEditState } from "./types";

export type VideoTool = "crop" | "cover";

export interface VideoMeta {
  duration: number;
  width: number;
  height: number;
}

interface VideoStageProps {
  file: File;
  edits: VideoEditState;
  onEdits: (update: (prev: VideoEditState) => VideoEditState) => void;
  tool: VideoTool | null;
  stageW: number;
  stageH: number;
  meta: VideoMeta | null;
  onMeta: (meta: VideoMeta | null) => void;
  lockedRatio?: number | null;
  maxLen?: number;
}

const THUMBS = 10;
const CROP_PAD = 28;

/** Preview of a video with its edits (CSS only — the server applies them for real), the
 *  trimmer below it, and the crop box or the cover-frame picker when those tools are open. */
export function VideoStage({ file, edits, onEdits, tool, stageW, stageH, meta, onMeta, lockedRatio, maxLen }: VideoStageProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);

  // Object URL made and revoked in the same effect run (Strict Mode safe).
  useEffect(() => {
    const u = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirrors a browser resource
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  // Filmstrip: seek a second, hidden <video> through the clip and grab small frames.
  useEffect(() => {
    if (!url || !meta?.duration) return;
    let cancelled = false;
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.playsInline = true;
    v.src = url;
    const canvas = document.createElement("canvas");
    const h = 96;
    canvas.height = h;
    canvas.width = Math.max(1, Math.round((h * meta.width) / Math.max(1, meta.height)));
    const ctx = canvas.getContext("2d");
    const out: string[] = [];
    const seek = (t: number) =>
      new Promise<void>((resolve) => {
        const done = () => {
          v.removeEventListener("seeked", done);
          resolve();
        };
        v.addEventListener("seeked", done);
        v.currentTime = t;
      });
    (async () => {
      await new Promise<void>((r) => {
        if (v.readyState >= 1) r();
        else v.addEventListener("loadedmetadata", () => r(), { once: true });
      });
      for (let i = 0; i < THUMBS && !cancelled; i++) {
        await seek(((i + 0.5) / THUMBS) * meta.duration);
        if (cancelled || !ctx) break;
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        out.push(canvas.toDataURL("image/jpeg", 0.6));
        setThumbs([...out]);
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
      v.removeAttribute("src");
      v.load();
    };
  }, [url, meta?.duration, meta?.width, meta?.height]);

  const duration = meta?.duration ?? 0;
  const start = edits.trimStart;
  const end = edits.trimEnd ?? duration;

  // Keep playback inside the trimmed range, and the playhead moving smoothly.
  useEffect(() => {
    if (!playing) return;
    let id = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        if (v.currentTime >= end - 0.03 || v.currentTime < start - 0.25) v.currentTime = start;
        setCurrent(v.currentTime);
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing, start, end]);

  useEffect(() => {
    const v = videoRef.current;
    if (v) v.muted = edits.muted;
  }, [edits.muted]);

  // Picking a cover frame: pause and show that frame.
  useEffect(() => {
    const v = videoRef.current;
    if (tool !== "cover" || !v) return;
    v.pause();
    v.currentTime = edits.coverSec ?? start;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the tool opens
  }, [tool]);

  function seek(t: number) {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = t;
    setCurrent(t);
  }

  async function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime < start || v.currentTime >= end - 0.05) v.currentTime = start;
      try {
        await v.play();
      } catch {
        /* autoplay policies — the button stays "play" */
      }
    } else v.pause();
  }

  // Geometry: the oriented frame, the visible part of it, fitted into the stage.
  const vw0 = meta?.width ?? 16;
  const vh0 = meta?.height ?? 9;
  const odd = edits.rotate % 2 === 1;
  const fw = odd ? vh0 : vw0;
  const fh = odd ? vw0 : vh0;
  const cropMode = tool === "crop";
  const view = cropMode ? FULL_RECT : edits.crop;
  const pad = cropMode ? CROP_PAD : 0;
  const timelineH = 64;
  const availH = Math.max(80, stageH - timelineH - 16);
  const scale = Math.max(0.01, Math.min((stageW - pad * 2) / (view.w * fw), (availH - pad * 2) / (view.h * fh)));
  const cssW = Math.round(view.w * fw * scale);
  const cssH = Math.round(view.h * fh * scale);
  const frameW = fw * scale;
  const frameH = fh * scale;
  const ratio = lockedRatio ?? ASPECTS.find((a) => a.key === edits.aspect)?.ratio ?? (edits.aspect === "original" ? fw / fh : null);

  return (
    <div className="flex size-full flex-col">
      <div className="relative flex min-h-0 flex-1 items-center justify-center">
        <div className="relative overflow-hidden" style={{ width: cssW, height: cssH }}>
          <div className="absolute" style={{ width: frameW, height: frameH, left: -view.x * frameW, top: -view.y * frameH }}>
            {url ? (
              <video
                ref={videoRef}
                src={url}
                playsInline
                preload="auto"
                muted={edits.muted}
                aria-label="Video preview"
                className="absolute max-w-none bg-black"
                style={{
                  width: odd ? frameH : frameW,
                  height: odd ? frameW : frameH,
                  objectFit: "fill",
                  // Untransformed when there's nothing to turn (cheaper to composite).
                  ...(edits.rotate || edits.flipH
                    ? {
                        left: "50%",
                        top: "50%",
                        transform: `translate(-50%, -50%) ${edits.flipH ? "scaleX(-1) " : ""}rotate(${edits.rotate * 90}deg)`,
                      }
                    : { left: 0, top: 0 }),
                }}
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget;
                  const d = v.duration;
                  if (!Number.isFinite(d) || d <= 0 || !v.videoWidth) {
                    setFailed(true);
                    onMeta(null);
                    return;
                  }
                  onMeta({ duration: d, width: v.videoWidth, height: v.videoHeight });
                  v.currentTime = Math.min(start + 0.01, d);
                }}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onError={() => {
                  setFailed(true);
                  onMeta(null);
                }}
              />
            ) : null}
          </div>
          {cropMode ? <CropOverlay width={cssW} height={cssH} rect={edits.crop} ratio={ratio} onChange={(crop) => onEdits((p) => ({ ...p, crop }))} /> : null}
          {!cropMode && tool !== "cover" && !failed ? (
            <button
              type="button"
              onClick={togglePlay}
              aria-label={playing ? "Pause" : "Play"}
              className="pressable absolute left-1/2 top-1/2 flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white transition-opacity"
              style={{ opacity: playing ? 0 : 1 }}
            >
              {playing ? <Pause className="size-7" fill="currentColor" /> : <Play className="ms-0.5 size-7" fill="currentColor" />}
            </button>
          ) : null}
        </div>
        {failed ? (
          <p className="absolute inset-x-6 top-1/2 -translate-y-1/2 text-center text-[14px] text-white/80">
            This video can&apos;t be previewed here, but it can still be sent.
          </p>
        ) : null}
      </div>
      {duration > 0 ? (
        <div className="shrink-0 pb-2 pt-3">
          <TrimTimeline
            duration={duration}
            start={start}
            end={end}
            current={tool === "cover" ? (edits.coverSec ?? start) : current}
            thumbs={thumbs}
            maxLen={maxLen}
            marker={tool === "cover"}
            onChange={(s, e, edge) => {
              onEdits((p) => ({ ...p, trimStart: s, trimEnd: e >= duration - 0.02 ? null : e }));
              videoRef.current?.pause();
              seek(edge === "start" ? s : Math.max(s, e - 0.05));
            }}
            onSeek={(t) => {
              if (tool === "cover") onEdits((p) => ({ ...p, coverSec: t }));
              seek(t);
            }}
          />
          <div className="tabular mt-1.5 flex justify-between px-4 text-[12.5px] text-white/70" dir="ltr">
            <span>{tool === "cover" ? `Cover at ${formatClock(edits.coverSec ?? start)}` : formatClock(Math.max(0, current - start))}</span>
            <span>{formatClock(end - start)}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
