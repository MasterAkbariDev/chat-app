import { ChatType } from "src/enum/base.enum";

/**
 * Channel posts are written by admins but shown as the channel (Telegram-style). These helpers
 * are the one place that decides what a subscriber is allowed to see of a post's author:
 *
 * - signature off → the author is the channel itself (its name and photo); no id, name or photo
 *   of whoever posted reaches a subscriber.
 * - signature on  → the same, plus `signature`: the author's display name and nothing else.
 *
 * `Message.senderId` keeps the real author in the database, so editing, deleting and the
 * owner's/admins' rights keep working; only what goes out over the wire is masked.
 */

export interface ChannelAuthorChat {
  _id?: unknown;
  name?: string | null;
  image?: string[] | null;
  signature?: boolean | null;
}

/** The "sender" a subscriber sees for a channel post: the channel, never the admin. */
export function channelSenderView(channelId: string, chat: ChannelAuthorChat) {
  return {
    _id: channelId,
    username: "",
    firstName: chat.name ?? "",
    lastName: "",
    avatarUrl: chat.image ?? [],
  };
}

export function isChannelChat(
  chat: { type?: string | null } | null | undefined,
) {
  return chat?.type === ChatType.CHANNEL;
}

/** Name to show as the signature, or null when this channel doesn't sign posts. */
export function signatureFor(
  chat: ChannelAuthorChat,
  authorName: string,
): string | null {
  return chat.signature ? authorName : null;
}

/** Applies the channel author rule to one message that belongs to a channel. */
export function maskChannelMessage<T extends { senderId?: unknown }>(
  message: T,
  channelId: string,
  chat: ChannelAuthorChat,
  authorName: string,
): T & { signature: string | null } {
  return {
    ...message,
    senderId: channelSenderView(channelId, chat),
    signature: signatureFor(chat, authorName),
  };
}
