"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api/client";
import { uploadDocument } from "@/lib/api/files";
import { uploadEditedVideo, uploadImageWithProgress } from "@/lib/api/media";
import { getSocket } from "@/lib/socket";
import type { MediaEditorResult, PreparedMedia } from "./types";

/** One outgoing message (an album of photos, a video, a GIF or a file) being uploaded. */
export interface MediaSendJob {
  id: string;
  label: string;
  /** 0–1 of the bytes uploaded. */
  progress: number;
  status: "queued" | "uploading" | "processing" | "sending" | "failed";
  error?: string;
}

type AlbumItem = Extract<PreparedMedia, { kind: "image" | "video" }>;
type Part = { kind: "album"; items: AlbumItem[] } | { kind: "single"; item: Extract<PreparedMedia, { kind: "gif" | "file" }> };

const ALBUM_MAX = 10;

/** Consecutive photos and videos become albums (one message, up to 10, like Telegram); GIFs
 *  and files go alone. */
export function groupParts(items: PreparedMedia[]): Part[] {
  const parts: Part[] = [];
  for (const it of items) {
    const last = parts[parts.length - 1];
    if (it.kind === "image" || it.kind === "video") {
      if (last?.kind === "album" && last.items.length < ALBUM_MAX) last.items.push(it);
      else parts.push({ kind: "album", items: [it] });
    } else parts.push({ kind: "single", item: it });
  }
  return parts;
}

function labelOf(p: Part): string {
  if (p.kind === "album") {
    if (p.items.length === 1) return p.items[0].kind === "video" ? "Video" : "Photo";
    const videos = p.items.filter((i) => i.kind === "video").length;
    return videos === 0 ? `${p.items.length} photos` : videos === p.items.length ? `${videos} videos` : `Album of ${p.items.length}`;
  }
  return p.item.kind === "gif" ? "GIF" : p.item.file.name;
}

interface Options {
  channelId: string;
  /** Message being replied to — attached to the first message sent. */
  replyToId?: string;
  onReplyUsed?: () => void;
}

/** Uploads what the media editor prepared and sends it, one message at a time (in order),
 *  exposing progress / retry / cancel for the strip above the composer. */
export function useMediaSendQueue({ channelId, replyToId, onReplyUsed }: Options) {
  const [jobs, setJobs] = useState<MediaSendJob[]>([]);
  const runners = useRef(new Map<string, { run: () => Promise<void>; ctrl: AbortController }>());
  const chain = useRef<Promise<void>>(Promise.resolve());
  const opts = useRef({ replyToId, onReplyUsed });
  useEffect(() => {
    opts.current = { replyToId, onReplyUsed };
  });

  const patch = useCallback((id: string, p: Partial<MediaSendJob>) => {
    setJobs((list) => list.map((j) => (j.id === id ? { ...j, ...p } : j)));
  }, []);
  const remove = useCallback((id: string) => {
    runners.current.delete(id);
    setJobs((list) => list.filter((j) => j.id !== id));
  }, []);

  const emit = useCallback(
    (dto: Record<string, unknown>) =>
      new Promise<void>((resolve, reject) => {
        const socket = getSocket();
        if (!socket?.connected) {
          reject(new Error("You're offline. Reconnect and try again."));
          return;
        }
        const timer = setTimeout(() => reject(new Error("Sending took too long. Try again.")), 20_000);
        socket.emit("send_message", { channelId, ...dto } as never, (ack: { error?: unknown } | object) => {
          clearTimeout(timer);
          if (ack && "error" in ack && ack.error) reject(new Error(typeof ack.error === "string" ? ack.error : "The message didn't send. Try again."));
          else resolve();
        });
      }),
    [channelId],
  );

  const send = useCallback(
    (result: MediaEditorResult) => {
      const parts = groupParts(result.items);
      let caption = result.caption;
      let reply = opts.current.replyToId;
      if (reply) opts.current.onReplyUsed?.();
      for (const part of parts) {
        const id = `ms${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const text = caption;
        caption = "";
        const replyTo = reply;
        reply = undefined;
        const ctrl = new AbortController();
        const run = async () => {
          const socket = getSocket();
          socket?.emit("uploading_start", { channelId });
          patch(id, { status: "uploading", progress: 0, error: undefined });
          try {
            const extra = { content: text, ...(replyTo ? { replyTo } : {}) };
            if (part.kind === "album") {
              const fractions = part.items.map(() => 0);
              const onProgress = (i: number) => (f: number) => {
                fractions[i] = f;
                const avg = fractions.reduce((a, b) => a + b, 0) / fractions.length;
                patch(id, avg >= 1 && part.items.some((x) => x.kind === "video") ? { progress: 1, status: "processing" } : { progress: avg });
              };
              const uploaded = await Promise.all(
                part.items.map(async (it, i) => {
                  if (it.kind === "image") {
                    const u = await uploadImageWithProgress(it.file, { signal: ctrl.signal, onProgress: onProgress(i) });
                    // The editor already made the file at the chosen quality: send what was stored.
                    return { url: u.variants.original.url, mediaId: u.mediaId, durationSec: null as number | null };
                  }
                  const u = await uploadEditedVideo(it.file, { resolution: it.resolution, edits: it.edits, signal: ctrl.signal, onProgress: onProgress(i) });
                  return { url: u.url, mediaId: u.mediaId, durationSec: u.durationSec ?? it.durationSec };
                }),
              );
              patch(id, { status: "sending", progress: 1 });
              const onlyVideos = part.items.every((x) => x.kind === "video");
              await emit({
                ...extra,
                // A mixed album is an image message whose video cells say so in attachmentMeta.
                type: onlyVideos ? "video" : "image",
                attachments: uploaded.map((u) => u.url),
                attachmentMediaIds: uploaded.map((u) => u.mediaId),
                ...(onlyVideos && uploaded.length === 1 && uploaded[0].durationSec != null ? { durationSec: uploaded[0].durationSec } : {}),
              });
            } else if (part.item.kind === "gif") {
              const u = await uploadImageWithProgress(part.item.file, { signal: ctrl.signal, onProgress: (f) => patch(id, { progress: f }) });
              patch(id, { status: "sending", progress: 1 });
              await emit({ ...extra, type: "gif", attachments: [u.variants.original.url], attachmentMediaIds: [u.mediaId] });
            } else {
              const u = await uploadDocument(part.item.file, "file", { signal: ctrl.signal, onProgress: (f) => patch(id, { progress: f }) });
              patch(id, { status: "sending", progress: 1 });
              const isAudio = u.kind === "audio";
              await emit({
                ...extra,
                type: isAudio ? "audio" : "file",
                attachments: [u.url],
                attachmentMediaIds: [u.mediaId],
                originalFilename: u.fileName,
                ...(isAudio && u.durationSec ? { durationSec: Math.round(u.durationSec) } : {}),
              });
            }
            remove(id);
          } catch (err) {
            if (ctrl.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
              remove(id);
              return;
            }
            patch(id, { status: "failed", error: err instanceof ApiError || err instanceof Error ? err.message : "The upload failed." });
          } finally {
            socket?.emit("uploading_stop", { channelId });
          }
        };
        runners.current.set(id, { run, ctrl });
        setJobs((list) => [...list, { id, label: labelOf(part), progress: 0, status: "queued" }]);
        // In order: each message waits for the one before it.
        chain.current = chain.current.then(() => (ctrl.signal.aborted ? undefined : run()));
      }
    },
    [channelId, emit, patch, remove],
  );

  const cancel = useCallback(
    (id: string) => {
      runners.current.get(id)?.ctrl.abort();
      remove(id);
    },
    [remove],
  );

  const retry = useCallback((id: string) => {
    const r = runners.current.get(id);
    if (!r) return;
    chain.current = chain.current.then(() => r.run());
  }, []);

  return { jobs, send, cancel, retry };
}
