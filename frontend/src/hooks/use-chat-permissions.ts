"use client";

import { useQuery } from "@tanstack/react-query";
import { CHANNELS_QUERY_KEY, chatPermissionsKey, getChannelsMine, getChatPermissions, getChatPreview } from "@/lib/api/chats";
import { ApiError } from "@/lib/api/client";
import type { EffectivePermissions } from "@/lib/api/types";
import { chatPreviewKey } from "@/hooks/use-chat-meta-events";

/** Your rights in a chat, for showing and hiding actions. Read from the chat
 *  list's summary when the chat is on it, else from a cached preview, else
 *  from `GET /chats/:id/permissions`. All three refresh on the
 *  `chat_permissions_updated` / `channel_roles_updated` socket events
 *  (use-chat-meta-events). `undefined` while unknown — treat that as "no". */
export function useChatPermissions(channelId: string): EffectivePermissions | undefined {
  const channelsQuery = useQuery({ queryKey: CHANNELS_QUERY_KEY, queryFn: () => getChannelsMine() });
  const fromList = channelsQuery.data?.items.find((c) => c.channelId === channelId)?.myPermissions;
  // Only reads a preview someone else already fetched (never fetches one itself).
  const previewQuery = useQuery({ queryKey: chatPreviewKey(channelId), queryFn: () => getChatPreview(channelId), enabled: false });
  const fromPreview = previewQuery.data?.myPermissions;
  const settingsQuery = useChatPermissionSettings(channelId, channelsQuery.isSuccess && !fromList && !fromPreview);
  return fromList ?? fromPreview ?? settingsQuery.data?.myPermissions;
}

/** `GET /chats/:id/permissions` — your rights plus the group's default
 *  member permissions (the permissions screen needs both). */
export function useChatPermissionSettings(channelId: string, enabled = true) {
  return useQuery({
    queryKey: chatPermissionsKey(channelId),
    queryFn: () => getChatPermissions(channelId),
    enabled,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
  });
}
