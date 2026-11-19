import { Injectable, Logger, Optional } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { OnEvent } from "@nestjs/event-emitter";
import { PushToken } from "./schema/push-token.schema";
import { ChatMembers } from "src/chat/schema/chat-members.schema";
import { Chat } from "src/chat/schema/chat.schema";
import { User } from "src/user/schema/user.schema";
import { ChatType } from "src/enum/base.enum";
import {
  CALL_RING_STOPPED,
  CALL_RINGING,
  CallRingStoppedEvent,
  CallRingingEvent,
  MESSAGE_CREATED,
  MessageCreatedEvent,
} from "src/events/domain-events";
import { ChatGateway } from "src/gateway/chat.gateway";
import { FcmService } from "./fcm.service";
import { PushQueueService, type QueuedPush } from "./push-queue.service";

/**
 * B7 (docs/plans/BACKEND_PLAN.md) — decides "should notify" and pushes over FCM. Android/Flutter
 * only: no APNs (not wanted for this app), and web is intentionally foreground-only (the
 * realtime socket events it already gets drive an in-app toast — that's frontend work, not this
 * service). Runs off the send hot path (`{async:true}`, wrapped in try/catch) — a failed or slow
 * push fan-out never delays the message response, same pattern as `ChatStateListener`.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectModel(PushToken.name)
    private readonly pushTokenModel: Model<PushToken>,
    @InjectModel(ChatMembers.name)
    private readonly chatMembersModel: Model<ChatMembers>,
    @InjectModel(Chat.name) private readonly chatModel: Model<Chat>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly chatGateway: ChatGateway,
    private readonly fcmService: FcmService,
    @Optional() private readonly pushQueue?: PushQueueService,
  ) {}

  async registerToken(
    userId: string,
    token: string,
    ua?: string,
  ): Promise<{ success: boolean }> {
    await this.pushTokenModel
      .findOneAndUpdate(
        { token },
        {
          $set: {
            userId,
            platform: "android",
            ua: ua ?? null,
            lastSeenAt: new Date(),
          },
        },
        { upsert: true },
      )
      .exec();
    return { success: true };
  }

  async removeToken(
    userId: string,
    token: string,
  ): Promise<{ success: boolean }> {
    await this.pushTokenModel.deleteOne({ userId, token }).exec();
    return { success: true };
  }

  private displayName(user: {
    firstName?: string;
    lastName?: string;
    username?: string;
  }): string {
    const parts = [user.firstName, user.lastName].filter(Boolean);
    const full = parts.join(" ").trim();
    return full || user.username || "Someone";
  }

  /** Builds the data payload of an "incoming call" push (all values strings — FCM data). */
  static incomingCallData(event: CallRingingEvent): Record<string, string> {
    return {
      type: "incoming_call",
      callId: event.callId,
      channelId: event.channelId,
      fromUserId: event.callerId,
      fromName: event.callerName,
      isPrivate: "1",
      expiresAt: String(event.expiresAt),
    };
  }

  /**
   * DM call ringing → a high-priority push to every device of the callee, so a phone or a
   * browser with no live socket (closed tab, killed app, socket mid-reconnect) still rings.
   * Sent regardless of chat mute / notification level (Telegram: calls ring through mute);
   * the service worker stays quiet when an app window is focused (that window rings itself).
   */
  @OnEvent(CALL_RINGING, { async: true })
  async onCallRinging(event: CallRingingEvent): Promise<void> {
    if (!this.fcmService.isConfigured) return;
    try {
      const ttlSec = Math.max(
        1,
        Math.round((event.expiresAt - Date.now()) / 1000),
      );
      await this.pushToUsers(
        event.calleeIds,
        NotificationService.incomingCallData(event),
        ttlSec,
      );
    } catch (err) {
      this.logger.warn(`call push failed for ${event.callId}: ${String(err)}`);
    }
  }

  /** The ring stopped — withdraw the "Incoming call" notification on every device. */
  @OnEvent(CALL_RING_STOPPED, { async: true })
  async onCallRingStopped(event: CallRingStoppedEvent): Promise<void> {
    if (!this.fcmService.isConfigured) return;
    try {
      await this.pushToUsers(
        event.userIds,
        {
          type: "call_ended",
          callId: event.callId,
          channelId: event.channelId,
          reason: event.reason,
        },
        60,
      );
    } catch (err) {
      this.logger.warn(`call-ended push failed: ${String(err)}`);
    }
  }

  private async pushToUsers(
    userIds: string[],
    data: Record<string, string>,
    ttlSec: number,
  ): Promise<void> {
    if (!userIds.length) return;
    const tokens = await this.pushTokenModel
      .find({ userId: { $in: userIds } })
      .lean()
      .exec();
    await Promise.all(
      tokens.map(async t => {
        const result = await this.fcmService.sendData(t.token, data, ttlSec);
        if (result.invalidToken) {
          await this.pushTokenModel.deleteOne({ _id: t._id }).exec();
        }
      }),
    );
  }

  @OnEvent(MESSAGE_CREATED, { async: true })
  async onMessageCreated(event: MessageCreatedEvent): Promise<void> {
    if (!this.fcmService.isConfigured) return;
    if (!event.senderId || !event.messageId) return;

    try {
      const members = await this.chatMembersModel
        .find({
          channelId: event.channelId,
          isJoined: true,
          isBanned: { $ne: true },
          userId: { $ne: event.senderId },
          isMuted: { $ne: true },
        })
        .select("userId")
        .lean()
        .exec();
      if (!members.length) return;

      const mentionSet = new Set(event.mentions ?? []);
      // A direct chat has one other person, so every message in it is addressed to you.
      const directChat =
        (
          await this.chatModel
            .findById(event.channelId)
            .select("type")
            .lean()
            .exec()
        )?.type === ChatType.PRIVATE;
      const memberIds = members.map(m => m.userId);
      const users = await this.userModel
        .find({ _id: { $in: memberIds }, isDeleted: false })
        .select("notificationLevel")
        .lean()
        .exec();
      const levelByUser = new Map(
        users.map(u => [String(u._id), u.notificationLevel ?? "all"]),
      );

      const recipientIds = memberIds.filter(userId => {
        const level = levelByUser.get(userId) ?? "all";
        if (level === "none") return false;
        if (level === "mentions" && !directChat && !mentionSet.has(userId))
          return false;
        return !this.chatGateway.isUserInChannelRoom(userId, event.channelId);
      });
      if (!recipientIds.length) return;

      const tokens = await this.pushTokenModel
        .find({ userId: { $in: recipientIds } })
        .lean()
        .exec();
      if (!tokens.length) return;

      const [sender, chat] = await Promise.all([
        this.userModel
          .findById(event.senderId)
          .select("username firstName lastName")
          .lean()
          .exec(),
        this.chatModel
          .findById(event.channelId)
          .select("name type signature")
          .lean()
          .exec(),
      ]);
      const senderName = sender ? this.displayName(sender) : "Someone";
      const isPrivate = chat?.type === ChatType.PRIVATE;
      const isChannel = chat?.type === ChatType.CHANNEL;
      // A channel post notifies as the channel; the author's name only with signatures on.
      const title = isPrivate ? senderName : chat?.name || senderName;
      const body = isPrivate
        ? event.preview
        : isChannel
          ? chat?.signature
            ? `${senderName}: ${event.preview}`
            : event.preview
          : `${senderName}: ${event.preview}`;

      const data = { channelId: event.channelId, messageId: event.messageId };
      // One tag per message: each notification stays (they stack); reading the chat clears them by prefix.
      const web = {
        tag: `chat-${event.channelId}:${event.messageId}`,
        link: `/app/c/${event.channelId}`,
      };
      // FCM is down: keep these for the queue rather than trying each one now.
      if (this.fcmService.isDegraded && this.pushQueue) {
        await this.pushQueue.enqueue(
          tokens.map(t => ({
            token: t.token,
            userId: t.userId,
            notification: { title, body },
            data,
            web,
          })),
        );
        return;
      }
      const queued: QueuedPush[] = [];
      await Promise.all(
        tokens.map(async t => {
          const result = await this.fcmService.send(
            t.token,
            { title, body },
            data,
            web,
          );
          if (result.invalidToken) {
            await this.pushTokenModel.deleteOne({ _id: t._id }).exec();
          } else if (!result.ok && result.transient) {
            queued.push({
              token: t.token,
              userId: t.userId,
              notification: { title, body },
              data,
              web,
            });
          }
        }),
      );
      await this.pushQueue?.enqueue(queued);
    } catch (err) {
      this.logger.warn(
        `notification fan-out failed for ${event.channelId}: ${String(err)}`,
      );
    }
  }
}
