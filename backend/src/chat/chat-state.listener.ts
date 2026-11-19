import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { OnEvent } from "@nestjs/event-emitter";
import { ChatState } from "./schema/chat-state.schema";
import { ChatMembers } from "./schema/chat-members.schema";
import { Message } from "src/message/schema/message.schema";
import { buildMessagePreview } from "src/message/message-preview.util";
import {
  MEMBERSHIP_CHANGED,
  MESSAGE_CREATED,
  MESSAGE_DELETED,
  MESSAGE_DELETED_FOR_ME,
  MembershipChangedEvent,
  MessageCreatedEvent,
  MessageDeletedEvent,
  MessageDeletedForMeEvent,
} from "src/events/domain-events";

const PREVIEW_FIELDS =
  "content type createdAt metadata originalFilename attachments attachmentMeta";

/** `deletedFor` holds ObjectIds; a non-ObjectId id (tests, legacy) is matched as-is. */
function toObjectIdOrSelf(id: string): Types.ObjectId | string {
  return Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : id;
}

/**
 * Keeps `chat_state` in sync with the events domain services emit. Runs off the request path —
 * a failure here delays the next list refresh, it never blocks the send/join/ban that triggered it.
 */
@Injectable()
export class ChatStateListener {
  private readonly logger = new Logger(ChatStateListener.name);

  constructor(
    @InjectModel(ChatState.name)
    private readonly chatStateModel: Model<ChatState>,
    @InjectModel(ChatMembers.name)
    private readonly chatMembersModel: Model<ChatMembers>,
    @InjectModel(Message.name) private readonly messageModel: Model<Message>,
  ) {}

  @OnEvent(MESSAGE_CREATED, { async: true })
  async onMessageCreated(event: MessageCreatedEvent): Promise<void> {
    try {
      await this.chatStateModel.updateOne(
        { channelId: event.channelId },
        {
          $set: {
            lastMessageAt: event.createdAt,
            lastMessagePreview: event.preview,
            lastMessageId: event.messageId ?? null,
            lastMessageSenderId: event.senderId ?? null,
          },
        },
        { upsert: true },
      );
    } catch (err) {
      this.logger.warn(
        `chat_state update failed for ${event.channelId} on message.created: ${String(err)}`,
      );
    }
  }

  /**
   * Awaited by the delete paths (`emitAsync` + `promisify`) so `chat_state` is already
   * recomputed when the `message_deleted` broadcast makes clients refresh their list.
   */
  @OnEvent(MESSAGE_DELETED, { async: true, promisify: true })
  async onMessageDeleted(event: MessageDeletedEvent): Promise<void> {
    try {
      const last = await this.messageModel
        .findOne({ channelId: event.channelId, isDeleted: false })
        .sort({ createdAt: -1 })
        .select(PREVIEW_FIELDS + " deletedFor senderId")
        .lean()
        .exec();
      const lastMessageAt = last?.createdAt ?? null;
      await this.chatStateModel.updateOne(
        { channelId: event.channelId },
        {
          $set: {
            lastMessageAt,
            lastMessagePreview: last ? buildMessagePreview(last) : null,
            lastMessageId: last ? String(last._id) : null,
            lastMessageSenderId: last ? String(last.senderId) : null,
          },
        },
        { upsert: true },
      );

      // The channel's last message moved, so per-member overrides are now anchored to a
      // stale value. Recompute them, plus for anyone who had hidden the new last message
      // for themselves (it's theirs to not see, even though it's the channel's latest).
      const withOverride = await this.chatMembersModel
        .find({
          channelId: event.channelId,
          lastVisibleOverride: { $ne: null },
        })
        .select("userId")
        .lean()
        .exec();
      const userIds = new Set<string>(withOverride.map(m => m.userId));
      for (const id of last?.deletedFor ?? []) userIds.add(String(id));
      for (const userId of userIds) {
        await this.recomputeMemberOverride(
          event.channelId,
          userId,
          lastMessageAt,
          last?._id ? String(last._id) : null,
        );
      }
    } catch (err) {
      this.logger.warn(
        `chat_state recompute failed for ${event.channelId} on message.deleted: ${String(err)}`,
      );
    }
  }

  @OnEvent(MESSAGE_DELETED_FOR_ME, { async: true, promisify: true })
  async onMessageDeletedForMe(event: MessageDeletedForMeEvent): Promise<void> {
    try {
      const last = await this.messageModel
        .findOne({ channelId: event.channelId, isDeleted: false })
        .sort({ createdAt: -1 })
        .select("_id createdAt")
        .lean()
        .exec();
      await this.recomputeMemberOverride(
        event.channelId,
        event.userId,
        last?.createdAt ?? null,
        last?._id ? String(last._id) : null,
      );
    } catch (err) {
      this.logger.warn(
        `preview override recompute failed for ${event.channelId}/${event.userId}: ${String(err)}`,
      );
    }
  }

  /**
   * The member's own last visible message (not soft-deleted, not deleted-for-me, after their
   * `hiddenAt`). Stored as an override only when it isn't the channel's last message — the
   * common case keeps no per-member state at all. One indexed `findOne` (channelId+createdAt).
   */
  private async recomputeMemberOverride(
    channelId: string,
    userId: string,
    channelLastAt: Date | null,
    channelLastId: string | null,
  ): Promise<void> {
    const membership = await this.chatMembersModel
      .findOne({ channelId, userId })
      .select("hiddenAt")
      .lean()
      .exec();
    if (!membership) return;
    const filter: Record<string, unknown> = {
      channelId,
      isDeleted: false,
      deletedFor: { $nin: [toObjectIdOrSelf(userId)] },
    };
    if (membership.hiddenAt) filter.createdAt = { $gt: membership.hiddenAt };
    const mine = await this.messageModel
      .findOne(filter)
      .sort({ createdAt: -1 })
      .select(PREVIEW_FIELDS)
      .lean()
      .exec();
    const same = mine ? String(mine._id) === channelLastId : !channelLastId;
    await this.chatMembersModel.updateOne(
      { channelId, userId },
      {
        $set: {
          lastVisibleOverride: same
            ? null
            : {
                anchorAt: channelLastAt,
                lastMessageAt: mine?.createdAt ?? null,
                lastMessagePreview: mine ? buildMessagePreview(mine) : null,
              },
        },
      },
    );
  }

  @OnEvent(MEMBERSHIP_CHANGED, { async: true })
  async onMembershipChanged(event: MembershipChangedEvent): Promise<void> {
    try {
      const memberCount = await this.chatMembersModel.countDocuments({
        channelId: event.channelId,
        isJoined: true,
        isBanned: { $ne: true },
      });
      await this.chatStateModel.updateOne(
        { channelId: event.channelId },
        { $set: { memberCount } },
        { upsert: true },
      );
    } catch (err) {
      this.logger.warn(
        `chat_state member count update failed for ${event.channelId}: ${String(err)}`,
      );
    }
  }
}
