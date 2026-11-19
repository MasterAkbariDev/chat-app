"use client";

/* eslint-disable @next/next/no-img-element -- backend-hosted cover art */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Pause, Play, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useUpload } from "@/lib/file-transfers";
import { formatBytes } from "@/lib/files";
import { resolveAttachmentUrl } from "@/lib/media-src";
import { chatMusicResolver, musicLabels, musicTrackId } from "@/lib/music";
import * as playback from "@/lib/playback";
import type { AdjacentResolver, PlaybackTrack } from "@/lib/playback";
import { formatDuration } from "@/lib/recording";
import type { AttachmentMeta } from "@/lib/api/types";

export interface MusicMessageProps {
  /** Outer box classes (e.g. `w-full` in a list instead of the bubble width). */
  className?: string;
  /** Message id — an optimistic `temp-…` id shows its upload (lib/file-transfers). */
  id: string;
  url?: string;
  meta?: AttachmentMeta | null;
  originalFilename?: string | null;
  durationSec?: number | null;
  own?: boolean;
  senderLabel: string;
  createdAt?: string;
  channelId?: string;
  currentUserId?: string;
  /** Position in a music group (one message, several tracks); 0 for a single track. */
  trackIndex?: number;
  /** Transfer-store key of this row's upload (`<tempId>#<index>` in a group). */
  uploadKey?: string;
  /** Previous/next track (default: this chat's music, from its loaded messages). The shared
   *  media page passes its own list. */
  resolveAdjacent?: AdjacentResolver;
}

/** Telegram-style music message: a round play button over the cover art (or a note), title and
 *  artist, and — once started — a seek bar with elapsed / total time. Plays through the app-wide
 *  player, so it shows in the now-playing bar (with previous / next through this chat's music)
 *  and keeps playing when you scroll away or switch chats. */
export function MusicMessage({ id: messageId, url, meta, originalFilename, durationSec, own = false, senderLabel, createdAt, channelId, currentUserId, trackIndex = 0, uploadKey, resolveAdjacent, className }: MusicMessageProps) {
  const queryClient = useQueryClient();
  const upload = useUpload(uploadKey ?? (messageId.startsWith("temp-") ? messageId : undefined));
  // The player's track id: the message id, plus `#<i>` for later tracks of a group.
  const id = musicTrackId(messageId, trackIndex);
  const shared = playback.usePlayback((s) => (s.track?.id === id ? s : null));
  const [coverFailed, setCoverFailed] = useState(false);

  const { title, artist } = upload
    ? musicLabels(null, upload.file.name)
    : musicLabels(meta, originalFilename, url);
  const cover = !coverFailed && meta?.thumbUrl ? resolveAttachmentUrl(meta.thumbUrl) : null;
  const known = shared?.duration || meta?.durationSec || durationSec || 0;
  const current = shared?.current ?? 0;
  const playing = !!shared?.playing;
  const started = !!shared;
  const progress = known > 0 ? Math.min(1, current / known) : 0;

  const track: PlaybackTrack | null =
    url && !upload
      ? {
          id,
          kind: "music",
          src: resolveAttachmentUrl(url),
          durationSec: meta?.durationSec ?? durationSec,
          senderName: senderLabel,
          createdAt,
          channelId,
          title,
          artist,
          coverUrl: cover,
        }
      : null;

  function toggle() {
    if (upload) {
      if (upload.status === "failed") upload.retry();
      else upload.cancel();
      return;
    }
    if (!track) return;
    if (shared) playback.toggle();
    else playback.play(track, { resolveAdjacent: resolveAdjacent ?? (channelId ? chatMusicResolver(queryClient, channelId, currentUserId) : undefined) });
  }

  function seekTo(fraction: number) {
    if (!track || known <= 0) return;
    const t = Math.max(0, Math.min(known, fraction * known));
    if (!shared) playback.play(track, { from: t, resolveAdjacent: resolveAdjacent ?? (channelId ? chatMusicResolver(queryClient, channelId, currentUserId) : undefined) });
    else playback.seek(t);
  }

  const uploading = upload && upload.status !== "failed";
  const uploadFailed = upload?.status === "failed";
  const ringSize = 48;
  const r = ringSize / 2 - 2.5;
  const c = 2 * Math.PI * r;

  let line2: string;
  if (uploadFailed) line2 = upload?.error ?? "Couldn't send";
  else if (uploading)
    line2 = upload.status === "sending" ? "Sending…" : `${formatBytes(upload.file.size * upload.progress)} of ${formatBytes(upload.file.size)}`;
  else if (shared?.failed) line2 = "Can't play this track";
  else line2 = [artist, known ? formatDuration(known) : null].filter(Boolean).join(" · ") || "Music";

  const label = `${title}${artist ? ` by ${artist}` : ""}`;

  return (
    <div className={cn("flex w-[min(300px,66vw)] min-w-0 items-center gap-3", className)}>
      <button
        type="button"
        onClick={toggle}
        aria-label={uploading ? `Cancel sending ${title}` : uploadFailed ? `Retry sending ${title}` : playing ? `Pause ${label}` : `Play ${label}`}
        title={uploading ? "Cancel" : uploadFailed ? "Retry" : playing ? "Pause" : "Play"}
        className={cn(
          "pressable relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full",
          !cover && (own ? "bg-own-fg text-own" : "bg-accent text-accent-fg hover:bg-accent-hover"),
        )}
      >
        {cover ? (
          <>
            <img src={cover} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setCoverFailed(true)} className="absolute inset-0 size-full object-cover" />
            <span aria-hidden className="absolute inset-0 bg-black/30" />
          </>
        ) : null}
        <span className={cn("relative flex items-center justify-center", cover && "text-white")}>
          {uploading ? (
            <X className="size-5" strokeWidth={2.4} aria-hidden />
          ) : uploadFailed ? (
            <RotateCcw className="size-5" strokeWidth={2.2} aria-hidden />
          ) : playing ? (
            <Pause className="size-5" fill="currentColor" strokeWidth={0} aria-hidden />
          ) : (
            <Play className="ms-0.5 size-5" fill="currentColor" strokeWidth={0} aria-hidden />
          )}
        </span>
        {uploading ? (
          <svg className={cn("pointer-events-none absolute inset-0 -rotate-90", upload.status === "sending" && "animate-spin", cover && "text-white")} width={ringSize} height={ringSize} aria-hidden>
            <circle
              cx={ringSize / 2}
              cy={ringSize / 2}
              r={r}
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeDasharray={c}
              strokeDashoffset={c * (1 - Math.max(0.04, upload.status === "sending" ? 0.25 : upload.progress))}
            />
          </svg>
        ) : null}
      </button>

      <div className="flex min-w-0 flex-1 flex-col">
        <span dir="auto" className="truncate text-[14.5px] font-semibold leading-snug" title={title}>
          {title}
        </span>
        {started && !shared?.failed ? (
          <div className="mt-1 flex flex-col gap-1">
            <div
              role="slider"
              tabIndex={0}
              aria-label={`${title} position`}
              aria-valuemin={0}
              aria-valuemax={Math.round(known)}
              aria-valuenow={Math.round(current)}
              aria-valuetext={`${formatDuration(current)} of ${formatDuration(known)}`}
              onPointerDown={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const frac = getComputedStyle(e.currentTarget).direction === "rtl" ? 1 - x / rect.width : x / rect.width;
                seekTo(frac);
              }}
              onKeyDown={(e) => {
                if (known <= 0) return;
                if (e.key === "ArrowRight" || e.key === "ArrowUp") {
                  e.preventDefault();
                  seekTo((current + 5) / known);
                } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
                  e.preventDefault();
                  seekTo((current - 5) / known);
                } else if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  toggle();
                }
              }}
              className="group relative flex h-4 cursor-pointer items-center"
            >
              <span aria-hidden className={cn("h-[3px] w-full overflow-hidden rounded-full", own ? "bg-own-fg/30" : "bg-line-strong")}>
                <span className={cn("block h-full rounded-full", own ? "bg-own-fg" : "bg-accent")} style={{ width: `${progress * 100}%` }} />
              </span>
              <span
                aria-hidden
                className={cn("absolute top-1/2 size-3 -translate-y-1/2 rounded-full rtl:translate-x-1/2", own ? "bg-own-fg" : "bg-accent")}
                style={{ insetInlineStart: `calc(${progress * 100}% - 6px)` }}
              />
            </div>
            <span className={cn("tabular text-[12px] leading-none", own ? "text-own-meta" : "text-muted")}>
              {formatDuration(current)} / {formatDuration(known)}
            </span>
          </div>
        ) : (
          <span dir="auto" className={cn("tabular mt-0.5 truncate text-[12.5px] leading-snug", uploadFailed || shared?.failed ? "text-danger" : own ? "text-own-meta" : "text-muted")}>
            {line2}
          </span>
        )}
      </div>
      {uploadFailed && upload ? (
        <button
          type="button"
          onClick={upload.cancel}
          aria-label={`Remove ${title}`}
          title="Remove"
          className={cn("pressable flex size-9 shrink-0 items-center justify-center rounded-full", own ? "hover:bg-white/15" : "hover:bg-sunken")}
        >
          <X className="size-[18px]" strokeWidth={2} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
