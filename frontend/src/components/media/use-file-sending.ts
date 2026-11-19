"use client";

import { useCallback, useLayoutEffect, useRef } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/client";
import { FILE_MAX_BYTES, uploadDocument, type UploadedDocument } from "@/lib/api/files";
import type { ChatMessage } from "@/lib/api/types";
import { formatBytes, looksLikeAudio } from "@/lib/files";
import { patchUpload, setUpload } from "@/lib/file-transfers";
import { messagesKey } from "@/lib/messages-query";
import { getSocket } from "@/lib/socket";

type SendStatuses = Map<string, "pending" | "failed">;

export interface FileSendingOptions {
  channelId: string;
  userId: string | undefined;
  /** The message being replied to — attached to the first file sent. */
  replyToId?: string;
  /** Called once the reply has been used, so the composer's banner clears. */
  onReplyUsed?: () => void;
  /** The conversation's optimistic-send map: a pending entry disables actions on the bubble. */
  setSendStatuses: (update: (prev: SendStatuses) => SendStatuses) => void;
  /** A file that can't be sent at all (too big). */
  onError?: (message: string) => void;
}

/** Sends picked files as Telegram-style file / music messages: each file appears at once as an
 *  optimistic bubble with an upload ring (cancel / retry live in the bubble — see
 *  lib/file-transfers.ts), uploads through `POST /upload/file`, then goes out over the socket
 *  with the same `tempId`, which the conversation's `new_message` handler reconciles.
 *  In `"file"` mode, audio files are still sent as music (like Telegram's file picker). */
export function useFileSending({ channelId, userId, replyToId, onReplyUsed, setSendStatuses, onError }: FileSendingOptions) {
  const queryClient = useQueryClient();
  const optsRef = useRef({ setSendStatuses, onError });
  useLayoutEffect(() => {
    optsRef.current = { setSendStatuses, onError };
  });

  const removeTemp = useCallback(
    (tempId: string) => {
      queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) => (prev ?? []).filter((m) => m._id !== tempId));
      optsRef.current.setSendStatuses((prev) => {
        if (!prev.has(tempId)) return prev;
        const next = new Map(prev);
        next.delete(tempId);
        return next;
      });
    },
    [channelId, queryClient],
  );

  const run = useCallback(
    (tempId: string, files: File[], mode: "file" | "music", reply: string | undefined, caption: string) =>
      startGroup({ channelId, queryClient, removeTemp }, tempId, files, mode, reply, caption),
    [channelId, queryClient, removeTemp],
  );

  return useCallback(
    (files: File[], mode: "file" | "music", caption = "") => {
      if (!userId || !files.length) return;
      const ok = files.filter((file) => {
        if (file.size > FILE_MAX_BYTES) {
          optsRef.current.onError?.(`“${file.name}” is too big. Files can be up to ${formatBytes(FILE_MAX_BYTES)}.`);
          return false;
        }
        if (file.size === 0) {
          optsRef.current.onError?.(`“${file.name}” is empty.`);
          return false;
        }
        return true;
      });
      // Telegram groups files sent together: one message per run of music / other files,
      // up to 10 each. The caption and the reply go on the first message.
      const groups: { music: boolean; files: File[] }[] = [];
      for (const file of ok) {
        const music = mode === "music" || looksLikeAudio(file);
        const last = groups[groups.length - 1];
        if (last && last.music === music && last.files.length < GROUP_MAX) last.files.push(file);
        else groups.push({ music, files: [file] });
      }
      let reply = replyToId;
      let text = caption.trim();
      for (const group of groups) {
        const tempId = `temp-file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const now = new Date().toISOString();
        const optimistic: ChatMessage = {
          _id: tempId,
          channelId,
          senderId: userId,
          content: text,
          type: group.music ? "audio" : "file",
          // One placeholder per row; each row reads its upload from `<tempId>#<i>`.
          attachments: group.files.map((_, i) => `pending:${i}`),
          attachmentMeta: null,
          replyTo: reply ?? null,
          replySnapshot: null,
          isEdited: false,
          isPinned: false,
          mentions: [],
          durationSec: null,
          waveform: null,
          originalFilename: group.files[0].name,
          deletedFor: [],
          forwardFrom: null,
          metadata: null,
          packId: null,
          packItemId: null,
          createdAt: now,
          updatedAt: now,
          reactions: [],
        };
        queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) => [...(prev ?? []), optimistic]);
        optsRef.current.setSendStatuses((prev) => new Map(prev).set(tempId, "pending"));
        run(tempId, group.files, group.music ? "music" : "file", reply, text);
        reply = undefined;
        text = "";
      }
      if (replyToId && groups.length) onReplyUsed?.();
    },
    [channelId, onReplyUsed, queryClient, replyToId, run, userId],
  );
}

const GROUP_MAX = 10;

interface UploadContext {
  channelId: string;
  queryClient: QueryClient;
  removeTemp: (tempId: string) => void;
}

/** Uploads a group's files in parallel (each row with its own progress, cancel and retry in the
 *  transfer store under `<tempId>#<i>`), then sends them as one message once every row that
 *  wasn't cancelled is up. Cancelling every row drops the message. */
function startGroup(ctx: UploadContext, tempId: string, files: File[], mode: "file" | "music", reply: string | undefined, caption: string) {
  const { channelId, queryClient, removeTemp } = ctx;
  const results: (UploadedDocument | null)[] = files.map(() => null);
  const cancelled = files.map(() => false);
  let sent = false;
  const key = (i: number) => `${tempId}#${i}`;
  const socket = getSocket();
  socket?.emit("uploading_start", { channelId });
  let stopped = false;
  const stopTyping = () => {
    if (stopped) return;
    stopped = true;
    socket?.emit("uploading_stop", { channelId });
  };

  function clearAll() {
    files.forEach((_, i) => setUpload(key(i), null));
  }

  function maybeSend() {
    if (sent) return;
    const live = files.map((_, i) => i).filter((i) => !cancelled[i]);
    if (!live.length) {
      sent = true;
      stopTyping();
      removeTemp(tempId);
      return;
    }
    if (live.some((i) => !results[i])) return;
    sent = true;
    stopTyping();
    const done = live.map((i) => results[i] as UploadedDocument);
    const s = getSocket();
    const fail = (error: string) => {
      sent = false;
      live.forEach((i) => patchUpload(key(i), { status: "failed", error }));
    };
    if (!s?.connected) {
      fail("You're offline. Reconnect and try again.");
      return;
    }
    const isAudio = done.every((u) => u.kind === "audio");
    s.emit(
      "send_message",
      {
        channelId,
        content: caption,
        type: isAudio ? "audio" : "file",
        attachments: done.map((u) => u.url),
        attachmentMediaIds: done.map((u) => u.mediaId),
        attachmentNames: done.map((u) => u.fileName),
        originalFilename: done[0].fileName,
        ...(isAudio && done.length === 1 && done[0].durationSec ? { durationSec: Math.round(done[0].durationSec) } : {}),
        ...(reply ? { replyTo: reply } : {}),
        tempId,
      },
      (ack) => {
        if ("error" in ack) {
          fail(typeof ack.error === "string" ? ack.error : "The message didn't send.");
          return;
        }
        queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) => {
          const without = (prev ?? []).filter((m) => m._id !== tempId);
          return without.some((m) => m._id === ack.message._id) ? without : [...without, ack.message];
        });
        clearAll();
        removeTemp(tempId);
      },
    );
  }

  function startOne(i: number) {
    const file = files[i];
    const ctrl = new AbortController();
    setUpload(key(i), {
      file,
      mode,
      progress: results[i] ? 1 : 0,
      status: results[i] ? "sending" : "uploading",
      cancel: () => {
        ctrl.abort();
        cancelled[i] = true;
        setUpload(key(i), null);
        // Drop the row from the optimistic bubble too.
        queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) =>
          (prev ?? []).map((m) => (m._id === tempId ? { ...m, attachments: m.attachments.map((a, k) => (k === i ? `cancelled:${k}` : a)) } : m)),
        );
        maybeSend();
      },
      retry: () => (results[i] ? maybeSend() : startOne(i)),
    });
    if (results[i]) {
      maybeSend();
      return;
    }
    uploadDocument(file, mode, { signal: ctrl.signal, onProgress: (p) => patchUpload(key(i), { progress: p }) })
      .then((uploaded) => {
        if (ctrl.signal.aborted) return;
        results[i] = uploaded;
        patchUpload(key(i), { progress: 1, status: "sending" });
        maybeSend();
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
        patchUpload(key(i), {
          status: "failed",
          error: err instanceof ApiError || err instanceof Error ? err.message : "The upload failed.",
        });
      });
  }

  files.forEach((_, i) => startOne(i));
}
