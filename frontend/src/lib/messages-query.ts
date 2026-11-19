import { getMessages } from "@/lib/api/messages";

/** Size of a conversation's first page (and of each "load older" page). */
export const MESSAGES_PAGE_SIZE = 50;

export const messagesKey = (channelId: string) => ["messages", channelId] as const;

/** The conversation's newest page — shared by ConversationView's query and the
 * chat list's hover/press prefetch, so a prefetched page is exactly the one the
 * conversation would have fetched. */
export function messagesQueryOptions(channelId: string) {
  return {
    queryKey: messagesKey(channelId),
    queryFn: () => getMessages(channelId, { limit: MESSAGES_PAGE_SIZE }),
  };
}
