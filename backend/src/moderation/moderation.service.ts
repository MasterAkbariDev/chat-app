import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { randomBytes } from "crypto";
import { User } from "src/user/schema/user.schema";
import { Chat } from "src/chat/schema/chat.schema";
import { ChatMembers } from "src/chat/schema/chat-members.schema";
import { Message } from "src/message/schema/message.schema";
import { ChatType, MessageType, UserRole } from "src/enum/base.enum";
import { MessageService } from "src/message/message.service";
import { ChatGateway } from "src/gateway/chat.gateway";
import { TokenCacheService } from "src/auth/token-cache.service";
import { hashPassword } from "src/utils/hash.util";
import { ModerationLogService } from "./moderation-log.service";

/** No end date given to `suspendUser` — a plain Date field (rather than an extra boolean) can't
 *  represent "forever" any other way. Far enough out that it is never reached in practice. */
const INDEFINITE_SUSPENSION = new Date("9999-12-31T00:00:00.000Z");
const MODERATION_USERNAME = "moderation";

@Injectable()
export class ModerationService {
  constructor(
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Chat.name) private chatModel: Model<Chat>,
    @InjectModel(ChatMembers.name) private chatMembersModel: Model<ChatMembers>,
    @InjectModel(Message.name) private messageModel: Model<Message>,
    private messageService: MessageService,
    @Inject(forwardRef(() => ChatGateway)) private chatGateway: ChatGateway,
    private tokenCache: TokenCacheService,
    private moderationLog: ModerationLogService,
  ) {}

  async suspendUser(
    adminId: string,
    userId: string,
    until: string | undefined,
    reason: string,
  ): Promise<{ success: true }> {
    const suspendedUntil = until ? new Date(until) : INDEFINITE_SUSPENSION;
    const user = await this.userModel
      .findOneAndUpdate(
        { _id: userId, isDeleted: false },
        { $set: { suspendedUntil } },
        { new: true },
      )
      .exec();
    if (!user) {
      throw new NotFoundException("User not found");
    }
    // Suspension must take effect immediately, not after the token-state cache's TTL.
    await this.tokenCache.invalidate(userId);
    await this.moderationLog.log(adminId, "user.suspend", "user", userId, {
      until: suspendedUntil.toISOString(),
      reason,
    });
    return { success: true };
  }

  async unsuspendUser(
    adminId: string,
    userId: string,
  ): Promise<{ success: true }> {
    const user = await this.userModel
      .findOneAndUpdate(
        { _id: userId },
        { $set: { suspendedUntil: null } },
        { new: true },
      )
      .exec();
    if (!user) {
      throw new NotFoundException("User not found");
    }
    await this.tokenCache.invalidate(userId);
    await this.moderationLog.log(adminId, "user.unsuspend", "user", userId);
    return { success: true };
  }

  /** Get-or-create the "Moderation" system account. It's never a login target — no admin
   *  promotion path leads to it, and its password hash is a random value nobody knows — so this
   *  isn't a repeat of the removed config-bot pattern (which was reachable, unauthenticated,
   *  over HTTP; this one only exists as a message `senderId`, created from an already
   *  admin-authenticated action). */
  private async getOrCreateModerationAccount(): Promise<
    User & { _id: Types.ObjectId }
  > {
    const existing = await this.userModel
      .findOne({ username: MODERATION_USERNAME })
      .exec();
    if (existing) return existing;
    const created = await this.userModel.create({
      username: MODERATION_USERNAME,
      firstName: "Moderation",
      lastName: "",
      password: await hashPassword(randomBytes(32).toString("hex")),
    });
    return created;
  }

  private async getOrCreateModerationDm(targetUserId: string): Promise<string> {
    const moderation = await this.getOrCreateModerationAccount();
    const link = `private-mod-${targetUserId}`;
    const existing = await this.chatModel
      .findOne({ link, isDeleted: false })
      .select("_id")
      .lean()
      .exec();
    if (existing) return existing._id.toString();

    const chat = await this.chatModel.create({
      link,
      type: ChatType.PRIVATE,
      name: "Moderation",
    });
    await this.chatMembersModel.insertMany([
      {
        channelId: chat._id.toString(),
        userId: moderation._id.toString(),
        role: UserRole.MEMBER,
      },
      {
        channelId: chat._id.toString(),
        userId: targetUserId,
        role: UserRole.MEMBER,
      },
    ]);
    return chat._id.toString();
  }

  async warnUser(
    adminId: string,
    userId: string,
    message: string,
  ): Promise<{ success: true }> {
    const target = await this.userModel
      .findOne({ _id: userId, isDeleted: false })
      .exec();
    if (!target) {
      throw new NotFoundException("User not found");
    }
    await this.deliverSystemDm(userId, message);

    await this.moderationLog.log(adminId, "user.warn", "user", userId, {
      message,
    });
    return { success: true };
  }

  /**
   * Posts `text` into the user's "Moderation" DM, creating the DM on first use. Used for warnings
   * and for support notices; callers decide what the text says.
   */
  async deliverSystemDm(userId: string, text: string): Promise<void> {
    const moderation = await this.getOrCreateModerationAccount();
    const channelId = await this.getOrCreateModerationDm(userId);
    const created = await this.messageService.create(
      { channelId, content: text, type: MessageType.TEXT },
      moderation._id.toString(),
    );
    this.chatGateway.broadcastNewMessage(channelId, created);
  }

  /** Overwrites content (not just flagging `isDeleted`, which the user's own soft-delete
   *  already does) — a moderator-removed message shouldn't leave the original text sitting in
   *  the database for anyone with raw access to read. */
  async hardHideMessage(
    adminId: string,
    messageId: string,
  ): Promise<{ success: true }> {
    const message = await this.messageModel.findById(messageId).exec();
    if (!message) {
      throw new NotFoundException("Message not found");
    }
    const channelId = message.channelId;
    await this.messageModel
      .updateOne(
        { _id: messageId },
        {
          $set: {
            isDeleted: true,
            isPinned: false,
            content: "[removed by moderator]",
            attachments: [],
            metadata: null,
          },
        },
      )
      .exec();
    await this.messageService.recomputeAfterDelete(channelId);
    this.chatGateway.notifyMessageDeleted(
      channelId,
      messageId,
      await this.messageService.channelLastState(channelId),
    );
    await this.moderationLog.log(
      adminId,
      "message.hard_hide",
      "message",
      messageId,
      {
        channelId,
      },
    );
    return { success: true };
  }

  private async setChannelLock(
    adminId: string,
    channelId: string,
    isLocked: boolean,
  ): Promise<{ success: true }> {
    const chat = await this.chatModel
      .findOneAndUpdate(
        { _id: channelId, isDeleted: false },
        { $set: { isLocked } },
        { new: true },
      )
      .exec();
    if (!chat) {
      throw new NotFoundException("Channel not found");
    }
    await this.moderationLog.log(
      adminId,
      isLocked ? "channel.lock" : "channel.unlock",
      "channel",
      channelId,
    );
    return { success: true };
  }

  lockChannel(adminId: string, channelId: string) {
    return this.setChannelLock(adminId, channelId, true);
  }

  /** Not in the plan's literal endpoint list (only "lock" is named) — added for symmetry, since
   *  a lock with no way back would make the action a one-way door. */
  unlockChannel(adminId: string, channelId: string) {
    return this.setChannelLock(adminId, channelId, false);
  }

  /** Platform-level removal — bypasses the normal chat-owner/admin permission check in
   *  ChatService, since a platform admin acts regardless of their own membership in the chat. */
  async removeChannelMember(
    adminId: string,
    channelId: string,
    userId: string,
  ): Promise<{ success: true }> {
    const result = await this.chatMembersModel
      .updateOne(
        { channelId, userId, isJoined: true },
        { $set: { isJoined: false } },
      )
      .exec();
    if (result.matchedCount === 0) {
      throw new BadRequestException("User is not a member of this channel");
    }
    await this.moderationLog.log(
      adminId,
      "channel.remove_member",
      "channel",
      channelId,
      {
        userId,
      },
    );
    return { success: true };
  }
}
