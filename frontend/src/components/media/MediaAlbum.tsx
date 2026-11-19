"use client";

/* eslint-disable @next/next/no-img-element -- backend-hosted poster frames */
import { useState } from "react";
import { Play } from "lucide-react";
import { albumLayout, attachmentIsVideo } from "@/lib/album-layout";
import { resolveAttachmentUrl } from "@/lib/media-src";
import { videoPosterUrl } from "@/lib/media-url";
import { formatDuration } from "@/lib/recording";
import type { AttachmentMeta } from "@/lib/api/types";
import { BubbleImage, MediaPlaceholder } from "./BubbleMedia";

interface MediaAlbumProps {
  type: string;
  attachments: string[];
  meta?: Record<string, AttachmentMeta> | null;
  senderLabel: string;
  onOpen: (index: number) => void;
}

/** Several photos and/or videos sent together, as one Telegram-style mosaic: rows (or a tall
 *  first item with a column beside it) that keep each picture near its own shape. Video cells
 *  show their poster, a play button and their length; any cell opens the viewer there. */
export function MediaAlbum({ type, attachments, meta, senderLabel, onOpen }: MediaAlbumProps) {
  const ratios = attachments.map((u) => {
    const m = meta?.[u];
    return m?.width && m?.height ? m.width / m.height : null;
  });
  const layout = albumLayout(ratios);
  const n = attachments.length;

  const cell = (i: number, share: number) => {
    const url = attachments[i];
    const m = meta?.[url];
    const video = attachmentIsVideo(type, url, m);
    const label = `Open ${video ? "video" : "photo"} ${i + 1} of ${n} from ${senderLabel}`;
    return video ? (
      <VideoCell url={url} meta={m} label={label} onOpen={() => onOpen(i)} />
    ) : (
      // Narrow cells load the grid-sized variant.
      <BubbleImage url={url} meta={m} fill grid={share < 0.75} label={label} onOpen={() => onOpen(i)} />
    );
  };

  if (layout.kind === "column") {
    return (
      <div className="flex w-full gap-[2px]" style={{ aspectRatio: String(layout.aspect) }} data-media-box="">
        <div className="min-w-0" style={{ flex: `${layout.firstShare} 1 0` }}>
          {cell(layout.first, layout.firstShare)}
        </div>
        <div className="flex min-w-0 flex-col gap-[2px]" style={{ flex: `${1 - layout.firstShare} 1 0` }}>
          {layout.rest.map((i) => (
            <div key={i} className="min-h-0 flex-1">
              {cell(i, 1 - layout.firstShare)}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-[2px]" style={{ aspectRatio: String(layout.aspect) }} data-media-box="">
      {layout.rows.map((row, r) => {
        const sum = row.aspects.reduce((a, b) => a + b, 0);
        return (
          <div key={r} className="flex min-h-0 gap-[2px]" style={{ flex: `${1 / sum} 1 0` }}>
            {row.items.map((i, k) => (
              <div key={i} className="min-w-0" style={{ flex: `${row.aspects[k]} 1 0` }}>
                {cell(i, row.aspects[k] / sum)}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function VideoCell({ url, meta, label, onOpen }: { url: string; meta?: AttachmentMeta | null; label: string; onOpen: () => void }) {
  const poster = meta?.posterUrl ? resolveAttachmentUrl(meta.posterUrl) : videoPosterUrl(resolveAttachmentUrl(url));
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const duration = meta?.durationSec;
  return (
    <button type="button" onClick={onOpen} aria-label={label} className="relative block size-full overflow-hidden bg-black" data-media-box="">
      {!loaded ? <MediaPlaceholder blurhash={meta?.blurhash} /> : null}
      {poster && !failed ? (
        <img
          src={poster}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
      ) : null}
      <span aria-hidden className="absolute start-1/2 top-1/2 flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white rtl:translate-x-1/2">
        <Play className="ms-0.5 size-5" fill="currentColor" strokeWidth={0} />
      </span>
      {duration ? (
        <span className="tabular pointer-events-none absolute start-1.5 top-1.5 rounded-full bg-black/55 px-1.5 py-0.5 text-[11.5px] font-semibold text-white">
          {formatDuration(duration)}
        </span>
      ) : null}
    </button>
  );
}
