import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { OnEvent } from "@nestjs/event-emitter";
import { Model, Types } from "mongoose";
import { Message } from "./schema/message.schema";
import { MessageReaction } from "./schema/message-reaction.schema";
import {
  READ_CHECKPOINT_TTL_SECONDS,
  ReadCheckpoint,
} from "./schema/read-checkpoint.schema";
import { ChatMembers } from "src/chat/schema/chat-members.schema";
import { Chat } from "src/chat/schema/chat.schema";
import { User } from "src/user/schema/user.schema";
import { Block } from "src/user/schema/block.schema";
import { ChatType, UserRole } from "src/enum/base.enum";
import { PublicUserDto } from "src/common/dto/user-view.dto";
import { PrivacyService, PrivacyView } from "src/privacy/privacy.service";
import { MESSAGES_READ, MessagesReadEvent } from "src/events/domain-events";

/** Above this many members the reader list is hidden (count only), like Telegram. */
export const SEEN_LIST_MAX_MEMBERS = 100;
const REACTION_LIST_LIMIT = 500;
/** Read-state scans the most recent readers only — in a huge group the furthest read
 *  pointer is (all but always) among the people who read most recently. */
const READ_STATE_MAX_READERS = 200;

export interface MessageReadInfo {
  messageId: string;
  chatType: ChatType;
  /** Readers newest-read first; `readAt` is null when the read time is no longer known
   *  (read more than 7 days ago, or before read times were recorded). */
  readers: { user: PublicUserDto; readAt: Date | null }[];
  /** How many members have read it — set even when `hidden`. */
  total: number;
  /** Members besides the author who could read it. */
  eligible: number;
  /** False when the message is older than the read-time window (times may be missing). */
  kept: boolean;
  /** True when the chat is too large to list readers (only `total` is given). */
  hidden: boolean;
  /** Legacy shape kept for the read tick (ConversationView). */
  readBy: { userId: string; readAt: Date | null }[];
}

export interface MessageReactionEntry {
  user: PublicUserDto;
  emoji: string | null;
  packItemId: string | null;
  relativePath: string | null;
  packId: string | null;
  reactedAt: Date;
}

/**
 * Telegram-style "message info": who read a message and when (author-only, DMs and groups),
 * and who reacted with what. Read times come from `read_checkpoints` (see that schema).
 */
@Injectable()
export class MessageInfoService {
  private readonly logger = new Logger(MessageInfoService.name);

  constructor(
    @InjectModel(Message.name) private readonly messageModel: Model<Message>,
    @InjectModel(MessageReaction.name)
    private readonly reactionModel: Model<MessageReaction>,
    @InjectModel(ReadCheckpoint.name)
    private readonly checkpointModel: Model<ReadCheckpoint>,
    @InjectModel(ChatMembers.name)
    private readonly membersModel: Model<ChatMembers>,
    @InjectModel(Chat.name) private readonly chatModel: Model<Chat>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Block.name) private readonly blockModel: Model<Block>,
    private readonly privacy: PrivacyService,
  ) {}

  /** Records a checkpoint only when the read covers messages no earlier checkpoint
   *  (still within the window) already covers — re-reading the same tail is a no-op. */
  @OnEvent(MESSAGES_READ)
  async recordRead(event: MessagesReadEvent): Promise<void> {
    try {
      const covered = await this.checkpointModel.exists({
        channelId: event.channelId,
        userId: event.userId,
        upToCreatedAt: { $gte: event.upToCreatedAt },
      });
      if (covered) return;
      await this.checkpointModel.create({
        channelId: event.channelId,
        userId: event.userId,
        upToCreatedAt: event.upToCreatedAt,
        readAt: event.readAt,
      });
    } catch (err) {
      this.logger.warn(`recordRead failed: ${String(err)}`);
    }
  }

  /**
   * The furthest point anyone *else* in the chat has read up to — the `createdAt` of the
   * newest message covered by another member's read pointer. Every own message created at or
   * before it shows ✓✓ (Telegram: DM → the other person read it; group → at least one member
   * did). Channels never expose read data, so they (and chats with nobody else) return null;
   * Saved Messages is "read" by definition, so it returns now.
   *
   * Cheap: one indexed member scan (most-recent readers first, capped) and one lookup.
   */
  async getReadState(
    channelId: string,
    userId: string,
  ): Promise<{ chatType: ChatType; othersReadUpTo: string | null }> {
    const chat = await this.chatModel
      .findOne({ _id: channelId, isDeleted: { $ne: true } })
      .select("type")
      .lean()
      .exec();
    if (!chat) throw new NotFoundException("Chat not found");
    const membership = await this.membersModel
      .findOne({ channelId, userId })
      .select("isBanned")
      .lean()
      .exec();
    if (!membership || membership.isBanned) {
      throw new ForbiddenException("Access denied");
    }
    if (chat.type === ChatType.CHANNEL) {
      return { chatType: chat.type, othersReadUpTo: null };
    }
    if (chat.type === ChatType.SAVED_MESSAGES) {
      return { chatType: chat.type, othersReadUpTo: new Date().toISOString() };
    }

    const readers = await this.membersModel
      .find({
        channelId,
        userId: { $ne: userId },
        isJoined: { $ne: false },
        isBanned: { $ne: true },
        lastReadMessageId: { $ne: null },
      })
      .sort({ lastReadAt: -1 })
      .limit(READ_STATE_MAX_READERS)
      .select("userId lastReadMessageId")
      .lean()
      .exec();
    if (!readers.length) return { chatType: chat.type, othersReadUpTo: null };

    // Same rule as the seen-by list: people who blocked you don't send you read receipts.
    const blockedBy = await this.blockModel
      .find({
        blockedId: new Types.ObjectId(userId),
        blockerId: {
          $in: readers
            .map(m => m.userId)
            .filter(id => Types.ObjectId.isValid(id))
            .map(id => new Types.ObjectId(id)),
        },
      })
      .select("blockerId")
      .lean()
      .exec();
    const blockers = new Set(blockedBy.map(b => String(b.blockerId)));
    const pointerIds = readers
      .filter(m => !blockers.has(m.userId))
      .map(m => m.lastReadMessageId)
      .filter((id): id is string => !!id && Types.ObjectId.isValid(id));
    if (!pointerIds.length)
      return { chatType: chat.type, othersReadUpTo: null };

    const furthest = await this.messageModel
      .findOne({
        _id: { $in: pointerIds.map(id => new Types.ObjectId(id)) },
        channelId,
      })
      .sort({ createdAt: -1 })
      .select("createdAt")
      .lean()
      .exec();
    return {
      chatType: chat.type,
      othersReadUpTo: furthest?.createdAt
        ? new Date(furthest.createdAt).toISOString()
        : null,
    };
  }

  async getReadInfo(
    messageId: string,
    requesterId: string,
  ): Promise<MessageReadInfo> {
    const message = await this.messageModel
      .findOne({ _id: messageId, isDeleted: false })
      .select("channelId senderId createdAt")
      .lean()
      .exec();
    if (!message) throw new NotFoundException("Message not found");
    if (String(message.senderId) !== requesterId) {
      throw new ForbiddenException(
        "Only the message author can see who has read it",
      );
    }
    const chat = await this.chatModel
      .findOne({ _id: message.channelId })
      .select("type")
      .lean()
      .exec();
    const createdAt = new Date(message.createdAt);
    const kept =
      Date.now() - createdAt.getTime() < READ_CHECKPOINT_TTL_SECONDS * 1000;
    const empty: MessageReadInfo = {
      messageId,
      chatType: chat?.type ?? ChatType.CHANNEL,
      readers: [],
      total: 0,
      eligible: 0,
      kept,
      hidden: true,
      readBy: [],
    };
    // Channels never expose read data (docs/DECISIONS.md).
    if (!chat || chat.type === ChatType.CHANNEL) return empty;

    const channelId = String(message.channelId);
    const members = await this.membersModel
      .find({
        channelId,
        userId: { $ne: requesterId },
        isJoined: { $ne: false },
        isBanned: { $ne: true },
      })
      .select("userId lastReadMessageId")
      .lean()
      .exec();
    if (!members.length) return { ...empty, hidden: false };

    // People who blocked the author don't send them read receipts.
    const blockedBy = await this.blockModel
      .find({
        blockedId: new Types.ObjectId(requesterId),
        blockerId: {
          $in: members
            .map(m => m.userId)
            .filter(id => Types.ObjectId.isValid(id))
            .map(id => new Types.ObjectId(id)),
        },
      })
      .select("blockerId")
      .lean()
      .exec();
    const blockers = new Set(blockedBy.map(b => String(b.blockerId)));
    const candidates = members.filter(m => !blockers.has(m.userId));

    // Covered by their read pointer (works for any age, no time).
    const pointerIds = candidates
      .map(m => m.lastReadMessageId)
      .filter((id): id is string => !!id && Types.ObjectId.isValid(id));
    const pointerMsgs = pointerIds.length
      ? await this.messageModel
          .find({ _id: { $in: pointerIds.map(id => new Types.ObjectId(id)) } })
          .select("createdAt")
          .lean()
          .exec()
      : [];
    const pointerAt = new Map(
      pointerMsgs.map(p => [String(p._id), new Date(p.createdAt).getTime()]),
    );

    // Earliest checkpoint that covers this message = when they read it.
    const times = await this.checkpointModel.aggregate<{
      _id: string;
      readAt: Date;
    }>([
      {
        $match: {
          channelId,
          userId: { $in: candidates.map(m => m.userId) },
          upToCreatedAt: { $gte: createdAt },
        },
      },
      { $group: { _id: "$userId", readAt: { $min: "$readAt" } } },
    ]);
    const readAtByUser = new Map(times.map(t => [t._id, t.readAt]));

    const readerIds = candidates
      .filter(m => {
        if (readAtByUser.has(m.userId)) return true;
        const at = m.lastReadMessageId
          ? pointerAt.get(m.lastReadMessageId)
          : undefined;
        return at !== undefined && at >= createdAt.getTime();
      })
      .map(m => m.userId);

    const sorted = readerIds
      .map(userId => ({ userId, readAt: readAtByUser.get(userId) ?? null }))
      .sort((a, b) => {
        if (a.readAt && b.readAt)
          return b.readAt.getTime() - a.readAt.getTime();
        if (a.readAt) return -1;
        if (b.readAt) return 1;
        return 0;
      });

    const hidden = members.length + 1 > SEEN_LIST_MAX_MEMBERS;
    const base = {
      messageId,
      chatType: chat.type,
      total: sorted.length,
      eligible: candidates.length,
      kept,
      hidden,
    };
    if (hidden) return { ...base, readers: [], readBy: [] };

    const { users, view } = await this.loadUsers(
      sorted.map(r => r.userId),
      requesterId,
    );
    // Telegram hides read times of people whose last seen you can't see (either way).
    const readers = sorted
      .filter(r => users.has(r.userId))
      .map(r => ({
        user: users.get(r.userId)!,
        readAt: view.canSeeLastSeen(r.userId) ? r.readAt : null,
      }));
    return {
      ...base,
      readers,
      readBy: sorted.map(r => ({
        userId: r.userId,
        readAt: view.canSeeLastSeen(r.userId) ? r.readAt : null,
      })),
    };
  }

  /** Everyone who reacted, newest first. Any joined member may look; in channels only
   *  admins (reactions there are anonymous to ordinary subscribers, like Telegram). */
  async getReactionList(
    messageId: string,
    requesterId: string,
  ): Promise<{
    messageId: string;
    total: number;
    reactions: MessageReactionEntry[];
  }> {
    const message = await this.messageModel
      .findOne({ _id: messageId, isDeleted: false })
      .select("channelId")
      .lean()
      .exec();
    if (!message) throw new NotFoundException("Message not found");
    const channelId = String(message.channelId);
    const [membership, chat] = await Promise.all([
      this.membersModel
        .findOne({ channelId, userId: requesterId })
        .select("role isJoined isBanned")
        .lean()
        .exec(),
      this.chatModel.findOne({ _id: channelId }).select("type").lean().exec(),
    ]);
    if (!membership || membership.isBanned || membership.isJoined === false) {
      throw new ForbiddenException("Access denied");
    }
    if (
      chat?.type === ChatType.CHANNEL &&
      membership.role === UserRole.MEMBER
    ) {
      throw new ForbiddenException("Only admins can see who reacted here");
    }

    const [rows, total] = await Promise.all([
      this.reactionModel
        .find({ messageId })
        .sort({ createdAt: -1 })
        .limit(REACTION_LIST_LIMIT)
        .lean()
        .exec(),
      this.reactionModel.countDocuments({ messageId }).exec(),
    ]);
    const { users } = await this.loadUsers(
      [...new Set(rows.map(r => r.userId))],
      requesterId,
    );
    return {
      messageId,
      total,
      reactions: rows
        .filter(r => users.has(r.userId))
        .map(r => ({
          user: users.get(r.userId)!,
          emoji: r.emoji,
          packItemId: r.packItemId,
          relativePath: r.packItemRelativePath,
          packId: r.packId,
          reactedAt: r.createdAt,
        })),
    };
  }

  private async loadUsers(
    ids: string[],
    viewerId: string,
  ): Promise<{ users: Map<string, PublicUserDto>; view: PrivacyView }> {
    const valid = ids.filter(id => Types.ObjectId.isValid(id));
    const [users, view] = await Promise.all([
      valid.length
        ? this.userModel
            .find({ _id: { $in: valid.map(id => new Types.ObjectId(id)) } })
            .select("username firstName lastName image avatarVideo bio")
            .lean()
            .exec()
        : Promise.resolve([]),
      this.privacy.forViewer(viewerId, valid),
    ]);
    return {
      users: new Map(users.map(u => [String(u._id), view.publicUser(u)])),
      view,
    };
  }
}
