"use client";

/** Message notifications are tagged `chat-<channelId>:<messageId>` (see the push sender). The channel is also
 *  in each notification's data, so matching doesn't rely on the tag alone. */
type ChatData = { channelId?: string; FCM_MSG?: { data?: { channelId?: string } } } | null;

function isChatNotification(n: Notification): boolean {
  const data = n.data as ChatData;
  return (n.tag ?? "").startsWith("chat-") || !!(data?.channelId ?? data?.FCM_MSG?.data?.channelId);
}

function belongsTo(n: Notification, channelId: string): boolean {
  const data = n.data as ChatData;
  const fromData = data?.channelId ?? data?.FCM_MSG?.data?.channelId;
  if (fromData) return fromData === channelId;
  const tag = n.tag ?? "";
  return tag === `chat-${channelId}` || tag.startsWith(`chat-${channelId}:`);
}

/** Message notifications are tagged `chat-<channelId>` (see the push sender). Clears the shown ones:
 *  one chat's when it's opened, or every chat's when the app comes to the front. */
export async function clearChatNotifications(channelId?: string): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    const list = await reg.getNotifications();
    for (const n of list) {
      if (!isChatNotification(n)) continue;
      if (channelId && !belongsTo(n, channelId)) continue;
      n.close();
    }
  } catch {
    // No notification support here: nothing to clear.
  }
}
