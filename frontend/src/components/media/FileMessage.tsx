"use client";

/* eslint-disable @next/next/no-img-element -- backend-hosted thumbnails */
import { useState } from "react";
import {
  ArrowDown,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
  RotateCcw,
  Smartphone,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { categoryColors, fileCategory, fileExtension, fileNameOf, formatBytes, splitForMiddleEllipsis, type FileCategory } from "@/lib/files";
import { openDownloaded, startDownload, useDownload, useUpload } from "@/lib/file-transfers";
import { resolveAttachmentUrl } from "@/lib/media-src";
import type { AttachmentMeta } from "@/lib/api/types";

const CATEGORY_ICON: Record<FileCategory, LucideIcon> = {
  pdf: FileText,
  doc: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
  archive: FileArchive,
  apk: Smartphone,
  audio: FileAudio,
  video: FileVideo,
  image: FileImage,
  code: FileCode,
  text: FileText,
  other: FileIcon,
};

export interface FileMessageProps {
  /** Outer box classes (e.g. `w-full` in a list instead of the bubble width). */
  className?: string;
  /** Message id — an optimistic `temp-…` id reads its upload progress from lib/file-transfers. */
  id: string;
  url?: string;
  meta?: AttachmentMeta | null;
  originalFilename?: string | null;
  /** On the sender's own (accent) bubble. */
  own?: boolean;
  /** Transfer-store key of this row's upload when it isn't the message id (a file group's
   *  rows are `<tempId>#<index>`). */
  uploadKey?: string;
}

/** A ring that fills clockwise around a 48px circle; `null` spins (unknown progress). */
function ProgressRing({ progress, size = 48 }: { progress: number | null; size?: number }) {
  const r = size / 2 - 2.5;
  const c = 2 * Math.PI * r;
  return (
    <svg
      className={cn("pointer-events-none absolute inset-0 -rotate-90", progress == null && "animate-spin")}
      width={size}
      height={size}
      aria-hidden
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.max(0.04, progress ?? 0.25))}
        style={{ transition: "stroke-dashoffset 120ms linear" }}
      />
    </svg>
  );
}

/** Telegram-style file message: a round, type-coloured icon (or a thumbnail for images) that
 *  downloads with a progress ring and then opens; the name ellipsized in the middle so the
 *  extension stays visible; size and type underneath. While sending, the same ring shows the
 *  upload, with cancel / retry. */
export function FileMessage({ id, url, meta, originalFilename, own = false, uploadKey, className }: FileMessageProps) {
  const upload = useUpload(uploadKey ?? (id.startsWith("temp-") ? id : undefined));
  const src = url ? resolveAttachmentUrl(url) : undefined;
  const download = useDownload(src);
  const [thumbFailed, setThumbFailed] = useState(false);

  const name = upload?.file.name ?? fileNameOf(originalFilename, url);
  const size = upload?.file.size ?? meta?.sizeBytes ?? null;
  const mime = upload?.file.type ?? meta?.mimeType ?? null;
  const category = fileCategory(name, mime);
  const ext = fileExtension(name).toUpperCase();
  const Icon = CATEGORY_ICON[category];
  const colors = categoryColors(category);
  const thumb = !thumbFailed && meta?.thumbUrl ? resolveAttachmentUrl(meta.thumbUrl) : null;
  const { head, tail } = splitForMiddleEllipsis(name);

  const uploading = upload && upload.status !== "failed";
  const uploadFailed = upload?.status === "failed";
  const downloading = download?.status === "downloading";
  const downloaded = download?.status === "done";

  function onActivate() {
    if (upload) {
      if (uploadFailed) upload.retry();
      else upload.cancel();
      return;
    }
    if (!src) return;
    if (downloaded && openDownloaded(src, name)) return;
    void startDownload(src, name);
  }

  let actionLabel: string;
  if (uploading) actionLabel = `Cancel sending ${name}`;
  else if (uploadFailed) actionLabel = `Retry sending ${name}`;
  else if (downloading) actionLabel = `Cancel download of ${name}`;
  else if (downloaded) actionLabel = `Open ${name}`;
  else actionLabel = `Download ${name}${size ? `, ${formatBytes(size)}` : ""}`;

  let status: string;
  if (uploadFailed) status = upload?.error ?? "Couldn't send";
  else if (uploading)
    status = upload.status === "sending" ? "Sending…" : size ? `${formatBytes(size * upload.progress)} of ${formatBytes(size)}` : `${Math.round(upload.progress * 100)}%`;
  else if (downloading)
    status = download?.progress != null && size ? `${formatBytes(size * download.progress)} of ${formatBytes(size)}` : "Downloading…";
  else if (download?.status === "failed") status = download.error ?? "Download failed";
  else if (downloaded) status = ["Tap to open", ext].filter(Boolean).join(" · ");
  else status = [formatBytes(size), ext].filter(Boolean).join(" · ") || "File";

  const ringProgress = uploading ? (upload.status === "sending" ? null : upload.progress) : downloading ? (download?.progress ?? null) : null;
  const busy = uploading || downloading;
  const tile = thumb ? "rounded-[var(--radius-sm)]" : "rounded-full";

  return (
    <div className={cn("flex w-[min(300px,66vw)] min-w-0 items-center gap-3", className)}>
      <button
        type="button"
        onClick={onActivate}
        aria-label={actionLabel}
        title={actionLabel}
        disabled={!upload && !src}
        className={cn("pressable relative flex size-12 shrink-0 items-center justify-center overflow-hidden", tile)}
        style={thumb ? undefined : { background: colors.bg, color: colors.fg }}
      >
        {thumb ? (
          <>
            <img src={thumb} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setThumbFailed(true)} className="absolute inset-0 size-full object-cover" />
            {busy || uploadFailed || !downloaded ? <span aria-hidden className="absolute inset-0 bg-black/35" /> : null}
          </>
        ) : null}
        <span className={cn("relative flex items-center justify-center", thumb && "text-white")}>
          {uploading || downloading ? (
            <X className="size-5" strokeWidth={2.4} aria-hidden />
          ) : uploadFailed ? (
            <RotateCcw className="size-5" strokeWidth={2.2} aria-hidden />
          ) : downloaded ? (
            thumb ? null : (
              <Icon className="size-[22px]" strokeWidth={1.9} aria-hidden />
            )
          ) : (
            <ArrowDown className="size-[22px]" strokeWidth={2.2} aria-hidden />
          )}
        </span>
        {busy ? (
          <span className={cn("absolute inset-0", thumb ? "text-white" : "")}>
            <ProgressRing progress={ringProgress} />
          </span>
        ) : null}
      </button>
      {/* The name area is a bigger mouse/touch target for the same action (the round button
       *  above is the accessible control). */}
      <div onClick={onActivate} className="min-w-0 flex-1 cursor-pointer text-start" title={name}>
        <span dir="auto" className="flex min-w-0 text-[14.5px] font-semibold leading-snug">
          <span className="min-w-0 truncate">{head}</span>
          {tail ? <span className="shrink-0 whitespace-pre">{tail}</span> : null}
        </span>
        <span
          className={cn(
            "tabular mt-0.5 block truncate text-[12.5px] leading-snug",
            uploadFailed || download?.status === "failed" ? "text-danger" : own ? "text-own-meta" : "text-muted",
          )}
          aria-live={busy ? "polite" : undefined}
        >
          {status}
        </span>
      </div>
      {uploadFailed && upload ? (
        <button
          type="button"
          onClick={upload.cancel}
          aria-label={`Remove ${name}`}
          title="Remove"
          className={cn("pressable flex size-9 shrink-0 items-center justify-center rounded-full", own ? "hover:bg-white/15" : "hover:bg-sunken")}
        >
          <X className="size-[18px]" strokeWidth={2} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
