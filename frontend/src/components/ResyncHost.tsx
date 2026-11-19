"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { messagesKey } from "@/components/chat/ConversationView";
import { CHANNELS_QUERY_KEY } from "@/lib/api/chats";
import { getSocket } from "@/lib/socket";
import type { ChatMessage } from "@/lib/api/types";

/** Backfills messages missed while the socket was disconnected — flaky
 * wifi, laptop sleep, a tab backgrounded long enough to drop the
 * connection. The backend already supports this (`resync`, a per-channel
 * last-message-id cursor — see socket.ts), nothing client-side ever called
 * it, so a reconnect silently left a gap until the user did something else
 * that happened to trigger a refetch. Mounted once in AppShell (i.e. only
 * while authenticated). */
export function ResyncHost() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    function handleReconnect() {
      if (!socket) return;

      // `resync` itself only covers new messages (confirmed by reading the
      // backend service) — an edit/delete/reaction/pin on a message from
      // *before* the gap isn't in its response at all. A plain refetch of
      // the channel list is the honest fallback for those (fresh
      // lastMessagePreview/unread/isMuted etc.), cheap enough to always do.
      queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY });

      // Only channels with a cached message list (i.e. opened at some point
      // this session) have a watermark to resync from — there's no
      // per-channel timestamp tracked for channels never opened, and a
      // fresh open fetches current history anyway, so this deliberately
      // doesn't try to cover those.
      const since: Record<string, string> = {};
      for (const query of queryClient.getQueryCache().findAll({ queryKey: ["messages"] })) {
        const key = query.queryKey;
        if (key.length !== 2 || key[0] !== "messages") continue;
        const channelId = key[1] as string;
        const messages = query.state.data as ChatMessage[] | undefined;
        const last = messages?.[messages.length - 1];
        if (last) since[channelId] = last._id;
      }
      if (Object.keys(since).length === 0) return;

      socket.emit("resync", { since }, (res) => {
        if (!("success" in res) || !res.success) return;
        for (const [channelId, result] of Object.entries(res.channels)) {
          if (!Array.isArray(result) || result.length === 0) continue;
          queryClient.setQueryData<ChatMessage[]>(messagesKey(channelId), (prev) => {
            if (!prev) return prev;
            const seen = new Set(prev.map((m) => m._id));
            const additions = result.filter((m) => !seen.has(m._id));
            return additions.length ? [...prev, ...additions] : prev;
          });
        }
      });
    }

    // The underlying Manager's own "reconnect" fires only on a *second or
    // later* successful connection after a drop — unlike the socket's own
    // "connect" event, which fires on the first connect too. That
    // distinction is exactly "was there actually a gap to backfill."
    socket.io.on("reconnect", handleReconnect);
    return () => {
      socket.io.off("reconnect", handleReconnect);
    };
  }, [queryClient]);

  return null;
}
