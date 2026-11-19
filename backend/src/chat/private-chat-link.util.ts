export const SAVED_MESSAGES_LINK_PREFIX = "saved-";
export const PRIVATE_CHAT_LINK_PREFIX = "private-";

/** The deterministic `chats.link` for a 1:1 chat between two users — order-independent. */
export function privateChatLink(userIdA: string, userIdB: string): string {
  const [id1, id2] = [userIdA, userIdB].sort();
  return `${PRIVATE_CHAT_LINK_PREFIX}${id1}-${id2}`;
}
