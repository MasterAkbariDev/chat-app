import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { User } from "src/user/schema/user.schema";
import { Chat } from "src/chat/schema/chat.schema";
import { Message } from "src/message/schema/message.schema";
import { ChatMembers } from "src/chat/schema/chat-members.schema";
import { Block } from "src/user/schema/block.schema";
import { ChatType, MessageType } from "src/enum/base.enum";
import { PublicUserDto } from "src/common/dto/user-view.dto";
import { PrivacyService } from "src/privacy/privacy.service";
import { SearchScope } from "./search-scope.enum";
import { buildMessagePreview } from "src/message/message-preview.util";
import { escapeRegex } from "src/common/utils/escape-regex";
import { PeopleDiscoveryService } from "src/user/people-discovery.service";

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 100;
const MAX_LIMIT = 50;

export interface ChannelSearchHit {
  _id: string;
  type: ChatType;
  name: string;
  description: string | null;
  image: string[];
  link: string;
  isPublic: boolean;
  memberCount: number;
  /** Whether the searcher is already in it (Open vs Join). */
  isMember: boolean;
}

export interface MessageSearchHit {
  _id: string;
  channelId: string;
  snippet: string;
  createdAt: Date;
  /** Raw text (for highlighting the match); empty for non-text messages. */
  content?: string;
  senderId?: string;
  senderName?: string;
  /** The chat it's in, resolved for display (other person for a DM). */
  chat?: {
    type: ChatType;
    name: string;
    image: string[];
    otherUser?: PublicUserDto;
  };
}

/** Matches `token` at the start of any word (start, or after a space,
 *  underscore, dot or hyphen) — how people search names in big apps:
 *  "ali" finds "aliakbar", "kar" finds "Omid Karimi". */
function wordPrefix(token: string): RegExp {
  return new RegExp(`(?:^|[\\s_.\\-])${escapeRegex(token)}`, "i");
}

function tokensOf(query: string): string[] {
  return query.split(/\s+/).filter(Boolean).slice(0, 5);
}

@Injectable()
export class SearchService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Chat.name) private readonly chatModel: Model<Chat>,
    @InjectModel(Message.name) private readonly messageModel: Model<Message>,
    @InjectModel(ChatMembers.name)
    private readonly chatMembersModel: Model<ChatMembers>,
    @InjectModel(Block.name) private readonly blockModel: Model<Block>,
    private readonly discovery: PeopleDiscoveryService,
    private readonly privacy: PrivacyService,
  ) {}

  private assertValidQuery(q: string): string {
    const trimmed = (q ?? "").trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      throw new BadRequestException(
        `Query must be at least ${MIN_QUERY_LENGTH} characters`,
      );
    }
    return trimmed.slice(0, MAX_QUERY_LENGTH);
  }

  async search(
    scope: SearchScope.PEOPLE,
    q: string,
    currentUserId: string,
    limit?: number,
    offset?: number,
  ): Promise<PublicUserDto[]>;
  async search(
    scope: SearchScope.CHANNELS,
    q: string,
    currentUserId: string,
    limit?: number,
    offset?: number,
  ): Promise<ChannelSearchHit[]>;
  async search(
    scope: SearchScope.MESSAGES,
    q: string,
    currentUserId: string,
    limit?: number,
    offset?: number,
  ): Promise<MessageSearchHit[]>;
  async search(
    scope: SearchScope,
    q: string,
    currentUserId: string,
    limit = 20,
    offset = 0,
  ): Promise<PublicUserDto[] | ChannelSearchHit[] | MessageSearchHit[]> {
    const query = this.assertValidQuery(q);
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), MAX_LIMIT);
    const safeOffset = Math.min(Math.max(Number(offset) || 0, 0), 500);
    switch (scope) {
      case SearchScope.PEOPLE:
        return this.searchPeople(query, currentUserId, safeLimit, safeOffset);
      case SearchScope.CHANNELS:
        return this.searchChannels(query, currentUserId, safeLimit, safeOffset);
      case SearchScope.MESSAGES:
        return this.searchMessages(query, currentUserId, safeLimit, safeOffset);
    }
  }

  /** Who-can-find-whom lives in PeopleDiscoveryService: names only match people you
   *  know; strangers only by @username (and only if they allow it); never email/phone. */
  private searchPeople(
    query: string,
    currentUserId: string,
    limit: number,
    offset: number,
  ): Promise<PublicUserDto[]> {
    return this.discovery.searchPeople(query, currentUserId, limit, offset);
  }

  /** Public groups/channels only (private ones are invite-link only), by
   *  word-prefix match on the name or a prefix of the link/handle. */
  private async searchChannels(
    query: string,
    currentUserId: string,
    limit: number,
    offset: number,
  ): Promise<ChannelSearchHit[]> {
    const tokens = tokensOf(query.replace(/^@/, ""));
    if (!tokens.length) return [];
    const handle = new RegExp(
      `^${escapeRegex(query.replace(/^@/, "").trim())}`,
      "i",
    );
    const chats = await this.chatModel
      .find({
        isDeleted: false,
        isPublic: true,
        type: { $in: [ChatType.GROUP, ChatType.CHANNEL] },
        $or: [
          { $and: tokens.map(t => ({ name: wordPrefix(t) })) },
          { link: handle },
        ],
      })
      .select("type name description image link isPublic")
      .limit(200)
      .lean()
      .exec();
    const q = query.toLowerCase();
    const ranked = chats
      .sort((a, b) => {
        const sa =
          (a.name ?? "").toLowerCase() === q
            ? 0
            : (a.name ?? "").toLowerCase().startsWith(q)
              ? 1
              : 2;
        const sb =
          (b.name ?? "").toLowerCase() === q
            ? 0
            : (b.name ?? "").toLowerCase().startsWith(q)
              ? 1
              : 2;
        return sa - sb;
      })
      .slice(offset, offset + limit);
    const ids = ranked.map(c => String(c._id));
    const [counts, mine] = await Promise.all([
      this.chatMembersModel
        .aggregate<{ _id: string; n: number }>([
          {
            $match: {
              channelId: { $in: ids },
              isBanned: { $ne: true },
              isJoined: { $ne: false },
            },
          },
          { $group: { _id: "$channelId", n: { $sum: 1 } } },
        ])
        .exec(),
      this.chatMembersModel
        .find({
          channelId: { $in: ids },
          userId: currentUserId,
          isBanned: { $ne: true },
          isJoined: { $ne: false },
        })
        .select("channelId")
        .lean()
        .exec(),
    ]);
    const countBy = new Map(counts.map(c => [String(c._id), c.n]));
    const memberOf = new Set(mine.map(m => String(m.channelId)));
    return ranked.map(c => ({
      _id: String(c._id),
      type: c.type,
      name: c.name ?? "",
      description: c.description ?? null,
      image: c.image ?? [],
      link: c.link,
      isPublic: !!c.isPublic,
      memberCount: countBy.get(String(c._id)) ?? 0,
      isMember: memberOf.has(String(c._id)),
    }));
  }

  /** Across the caller's own chats only — skipping chats they left, and
   *  anything from before they hid/cleared a chat (`hiddenAt`). Substring
   *  match on the text, newest first, with the chat and sender resolved so
   *  the client can show them without its own lookups. */
  private async searchMessages(
    query: string,
    currentUserId: string,
    limit: number,
    offset: number,
  ): Promise<MessageSearchHit[]> {
    const memberships = await this.chatMembersModel
      .find({
        userId: currentUserId,
        isBanned: { $ne: true },
        isJoined: { $ne: false },
      })
      .select("channelId hiddenAt")
      .lean()
      .exec();
    if (!memberships.length) return [];
    const scopes = memberships.map(m =>
      (m as { hiddenAt?: Date | null }).hiddenAt
        ? {
            channelId: m.channelId,
            createdAt: { $gt: (m as { hiddenAt: Date }).hiddenAt },
          }
        : { channelId: m.channelId },
    );

    const messages = await this.messageModel
      .find({
        $or: scopes,
        content: new RegExp(escapeRegex(query), "i"),
        type: { $ne: "system" },
        isDeleted: false,
        deletedFor: { $nin: [new Types.ObjectId(currentUserId)] },
      })
      .select("channelId content type createdAt senderId")
      .populate("senderId", "username firstName lastName")
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .lean()
      .exec();

    // Resolve each hit's chat for display (name/photo, or the other person
    // for a direct chat).
    const channelIds = [
      ...new Set(messages.map(m => String(m.channelId))),
    ].filter(id => Types.ObjectId.isValid(id));
    const chats = await this.chatModel
      .find({ _id: { $in: channelIds } })
      .select("type name image signature")
      .lean()
      .exec();
    const chatById = new Map(chats.map(c => [String(c._id), c]));
    const privateIds = chats
      .filter(c => c.type === ChatType.PRIVATE)
      .map(c => String(c._id));
    const others = privateIds.length
      ? await this.chatMembersModel
          .find({
            channelId: { $in: privateIds },
            userId: { $ne: currentUserId },
          })
          .select("channelId userId")
          .lean()
          .exec()
      : [];
    const otherUsers = others.length
      ? await this.userModel
          .find({ _id: { $in: others.map(o => o.userId) } })
          .select("username firstName lastName image avatarVideo bio")
          .lean()
          .exec()
      : [];
    const view = await this.privacy.forViewer(
      currentUserId,
      otherUsers.map(u => u._id),
    );
    const userById = new Map(
      otherUsers.map(u => [String(u._id), { dto: view.publicUser(u) }]),
    );
    const otherByChat = new Map(
      others.map(o => [String(o.channelId), userById.get(String(o.userId))]),
    );

    return messages.map(m => {
      const sender = m.senderId as unknown as {
        _id?: Types.ObjectId;
        username?: string;
        firstName?: string;
        lastName?: string;
      } | null;
      const chat = chatById.get(String(m.channelId));
      const other = otherByChat.get(String(m.channelId));
      const authorName =
        [sender?.firstName, sender?.lastName].filter(Boolean).join(" ") ||
        sender?.username ||
        "";
      // A channel post is the channel's, whoever wrote it (channel-author.util.ts).
      const channelPost = chat?.type === ChatType.CHANNEL;
      return {
        _id: String(m._id),
        channelId: String(m.channelId),
        snippet: buildMessagePreview(m),
        content: m.type === MessageType.TEXT ? m.content : "",
        createdAt: m.createdAt,
        senderId: channelPost
          ? String(m.channelId)
          : sender?._id
            ? String(sender._id)
            : undefined,
        senderName: channelPost
          ? chat?.signature
            ? authorName
            : (chat?.name ?? "")
          : sender
            ? authorName
            : undefined,
        chat: chat
          ? {
              type: chat.type,
              name:
                chat.type === ChatType.PRIVATE && other
                  ? [other.dto.firstName, other.dto.lastName]
                      .filter(Boolean)
                      .join(" ") ||
                    other.dto.username ||
                    ""
                  : (chat.name ?? ""),
              image:
                chat.type === ChatType.PRIVATE
                  ? (other?.dto.avatarUrl ?? [])
                  : (chat.image ?? []),
              ...(other ? { otherUser: other.dto } : {}),
            }
          : undefined,
      };
    });
  }

  /**
   * `GET /v1/channels/:id/messages/search` (B6) — snippet + cursor windows for a single
   * channel, replacing the legacy `searchInChannel`'s bare 500-id array.
   */
  async searchInChannel(
    channelId: string,
    userId: string,
    q: string,
    limit = 20,
    cursor?: string | null,
  ): Promise<{ items: MessageSearchHit[]; nextCursor: string | null }> {
    const membership = await this.chatMembersModel
      .findOne({ channelId, userId, isBanned: { $ne: true } })
      .lean()
      .exec();
    if (!membership) {
      throw new BadRequestException("Access denied");
    }
    const query = this.assertValidQuery(q);
    const safeLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);

    const filter: Record<string, unknown> = {
      content: new RegExp(escapeRegex(query), "i"),
      type: { $ne: "system" },
      channelId,
      isDeleted: false,
      deletedFor: { $nin: [new Types.ObjectId(userId)] },
    };
    if (cursor) {
      const cursorDate = new Date(cursor);
      if (!isNaN(cursorDate.getTime())) {
        filter.createdAt = { $lt: cursorDate };
      }
    }

    const messages = await this.messageModel
      .find(filter)
      .select("channelId content type createdAt")
      .sort({ createdAt: -1 })
      .limit(safeLimit + 1)
      .lean()
      .exec();

    const hasMore = messages.length > safeLimit;
    const page = hasMore ? messages.slice(0, safeLimit) : messages;
    const nextCursor = hasMore
      ? (page[page.length - 1]?.createdAt.toISOString() ?? null)
      : null;

    return {
      items: page.map(m => ({
        _id: String(m._id),
        channelId: m.channelId,
        snippet: buildMessagePreview(m),
        createdAt: m.createdAt,
      })),
      nextCursor,
    };
  }
}
