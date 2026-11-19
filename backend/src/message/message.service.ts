import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { AttachmentMetaEntry, Message } from "./schema/message.schema";
import { MessageReaction } from "./schema/message-reaction.schema";
import { CreateMessageDto } from "./dto/create-message.dto";
import { UpdateMessageDto } from "./dto/update-message.dto";
import { ChatMembers } from "src/chat/schema/chat-members.schema";
import { Chat } from "src/chat/schema/chat.schema";
import { Block } from "src/user/schema/block.schema";
import { ChatState } from "src/chat/schema/chat-state.schema";
import { ChatType, MessageType, PackType, UserRole } from "src/enum/base.enum";
import { User } from "src/user/schema/user.schema";
import { MediaAsset } from "src/media/schema/media-asset.schema";
import { toPublicUserDto } from "src/common/dto/user-view.dto";
import { EventEmitter2 } from "eventemitter2";
import {
  MESSAGE_CREATED,
  MESSAGE_DELETED,
  MESSAGE_DELETED_FOR_ME,
  MESSAGES_READ,
  MessagesReadEvent,
} from "src/events/domain-events";
import { buildMessagePreview } from "./message-preview.util";
import { sanitizeMessageContent } from "./message-sanitize.util";
import {
  channelSenderView,
  isChannelChat,
  maskChannelMessage,
  signatureFor,
} from "./channel-author.util";
import { PacksService } from "src/packs/packs.service";
import { PrivacyService, PrivacyView } from "src/privacy/privacy.service";
import {
  assertMemberPermission,
  effectivePermissions,
  permissionForMessageType,
} from "src/chat/permissions";
import { escapeRegex } from "src/common/utils/escape-regex";
import {
  SHARED_MEDIA_KINDS,
  afterCursorMatch,
  decodeSharedCursor,
  encodeSharedCursor,
  explodeSharedItemsStages,
  sharedKindFilter,
  sharedMessageTypes,
  type SharedMediaKind,
} from "./shared-media.util";

/** Server-side cap on distinct reactions (emoji or pack item) per message (B5) — keeps a single
 *  message's reaction bar from growing unbounded under abuse. */
const MAX_DISTINCT_EMOJIS_PER_MESSAGE = 20;

/** Either a plain unicode emoji or a sticker/animated-emoji pack item — never both, see
 *  MessageReaction's doc comment. `packItemId`/`relativePath`/`packId` are null for a plain-emoji
 *  row, and vice versa. */
type ReactionSummary = {
  emoji: string | null;
  packItemId: string | null;
  relativePath: string | null;
  packId: string | null;
  count: number;
  me: boolean;
};

@Injectable()
export class MessageService {
  constructor(
    @InjectModel(Message.name) private readonly messageModel: Model<Message>,
    @InjectModel(MessageReaction.name)
    private readonly messageReactionModel: Model<MessageReaction>,
    @InjectModel(ChatMembers.name)
    private readonly chatMembersModel: Model<ChatMembers>,
    @InjectModel(Chat.name) private readonly chatModel: Model<Chat>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(MediaAsset.name)
    private readonly mediaAssetModel: Model<MediaAsset>,
    private readonly eventEmitter: EventEmitter2,
    private readonly packsService: PacksService,
    private readonly privacy: PrivacyService,
    // Last + optional so the many positional test constructions don't need it.
    @Optional()
    @InjectModel(ChatState.name)
    private readonly chatStateModel?: Model<ChatState>,
    @Optional()
    @InjectModel(Block.name)
    private readonly blockModel?: Model<Block>,
  ) {}

  /** Either person has blocked the other: a direct chat takes no messages from either side. */
  private async blockedInDirectChat(
    chatId: string,
    userId: string,
  ): Promise<boolean> {
    if (!this.blockModel) return false;
    const peer = await this.chatMembersModel
      .findOne({ channelId: chatId, userId: { $ne: userId } })
      .select("userId")
      .lean()
      .exec();
    if (!peer || !Types.ObjectId.isValid(String(peer.userId))) return false;
    const block = await this.blockModel
      .exists({
        $or: [
          {
            blockerId: new Types.ObjectId(userId),
            blockedId: new Types.ObjectId(String(peer.userId)),
          },
          {
            blockerId: new Types.ObjectId(String(peer.userId)),
            blockedId: new Types.ObjectId(userId),
          },
        ],
      })
      .exec();
    return !!block;
  }

  /**
   * Batched `$group` over `message_reactions` for a page of messages (B5) — one aggregation
   * regardless of page size, instead of shipping every reactor's userId in the message DTO.
   */
  private async getReactionsForMessages(
    messageIds: string[],
    currentUserId: string,
  ): Promise<Map<string, ReactionSummary[]>> {
    const result = new Map<string, ReactionSummary[]>();
    if (!messageIds.length) return result;

    const rows = await this.messageReactionModel.aggregate<{
      _id: {
        messageId: string;
        emoji: string | null;
        packItemId: string | null;
      };
      count: number;
      me: number;
      relativePath: string | null;
      packId: string | null;
    }>([
      { $match: { messageId: { $in: messageIds } } },
      {
        $group: {
          _id: {
            messageId: "$messageId",
            emoji: "$emoji",
            packItemId: "$packItemId",
          },
          count: { $sum: 1 },
          me: {
            $max: { $cond: [{ $eq: ["$userId", currentUserId] }, 1, 0] },
          },
          // Same for every row in the group (denormalized at write time onto every reaction
          // row sharing this packItemId) — $first just picks whichever the group happened to
          // see first, not a real aggregation choice.
          relativePath: { $first: "$packItemRelativePath" },
          packId: { $first: "$packId" },
        },
      },
    ]);

    for (const row of rows) {
      const list = result.get(row._id.messageId) ?? [];
      list.push({
        emoji: row._id.emoji,
        packItemId: row._id.packItemId,
        relativePath: row.relativePath,
        packId: row.packId,
        count: row.count,
        me: row.me === 1,
      });
      result.set(row._id.messageId, list);
    }
    return result;
  }

  /** Attaches `reactions: [{emoji,count,me}]` to a page of (already `.lean()`ed) messages. */
  private async withReactions<T extends { _id: unknown }>(
    messages: T[],
    currentUserId: string,
  ): Promise<(T & { reactions: ReactionSummary[] })[]> {
    const ids = messages.map(m => String(m._id));
    const byMessage = await this.getReactionsForMessages(ids, currentUserId);
    return messages.map(m => ({
      ...m,
      reactions: byMessage.get(String(m._id)) ?? [],
    }));
  }

  /** Merges an additional `createdAt > hiddenAt` bound into an existing filter (B5) — the
   *  single-pointer replacement for bulk-writing `deletedFor` on every message on chat leave. */
  private hiddenAtFilter(
    filter: Record<string, unknown>,
    hiddenAt: Date | null | undefined,
  ): Record<string, unknown> {
    if (!hiddenAt) return filter;
    const existing = (filter.createdAt as Record<string, unknown>) || {};
    return { ...filter, createdAt: { ...existing, $gt: hiddenAt } };
  }

  /**
   * Shared read-access guard (Architecture Rule #12) — the channel-exists / private-access /
   * not-banned check that used to appear 5× verbatim across the read methods below.
   */
  private async assertChannelReadAccess(
    channelId: string,
    userId: string,
  ): Promise<{ chat: { type: ChatType }; membership: ChatMembers | null }> {
    const chat = await this.chatModel
      .findOne({ _id: channelId, isDeleted: false })
      .select("type isPublic")
      .lean()
      .exec();
    if (!chat) {
      throw new NotFoundException("Channel not found");
    }
    const membership = await this.chatMembersModel.findOne({
      channelId,
      userId,
    });
    // Only *public* groups/channels can be read before joining. Previously
    // this blocked non-members for direct chats alone, so anyone with the id
    // could read someone's Saved Messages or a private group.
    const openToAll =
      (chat.type === ChatType.GROUP || chat.type === ChatType.CHANNEL) &&
      !!chat.isPublic;
    if (!membership && !openToAll) {
      throw new ForbiddenException("Access denied");
    }
    if (membership?.isBanned) {
      throw new ForbiddenException("You are banned from this channel");
    }
    return { chat, membership };
  }

  private displayNameOf(user: {
    firstName?: string | null;
    lastName?: string | null;
    username?: string | null;
  }): string {
    const parts = [user.firstName, user.lastName].filter(Boolean);
    const full = parts.join(" ").trim();
    return full || user.username || "User";
  }

  /**
   * `senderId` comes back from `.populate(...)` as the raw User subdocument (whatever the
   * select projection included). Map it to the same safe `PublicUserDto` shape used
   * everywhere else, rather than leaking a differently-shaped ad-hoc object per query.
   */
  /**
   * Builds `Message.attachmentMeta` from real `MediaAsset` rows — `width`/`height`/`blurhash`
   * always come from the row the server itself fetches by id, never from whatever the client
   * claims those values are. `attachments`/`attachmentMediaIds` are matched by array position
   * (the client constructs both from the same `POST /upload/image` responses, in order); an
   * out-of-range, missing, invalid-ObjectId, or not-found id just leaves that one attachment
   * without an entry (no blurhash placeholder for it) rather than failing the whole send.
   */
  private async buildAttachmentMeta(
    attachments?: string[],
    attachmentMediaIds?: string[],
    attachmentNames?: string[],
  ): Promise<Record<string, AttachmentMetaEntry> | null> {
    if (!attachments?.length || !attachmentMediaIds?.length) return null;

    const validIds = attachmentMediaIds.filter(id =>
      Types.ObjectId.isValid(id),
    );
    if (!validIds.length) return null;

    const assets = await this.mediaAssetModel
      .find({ _id: { $in: validIds.map(id => new Types.ObjectId(id)) } })
      .select(
        "width height blurhash kind sizeBytes mimeType durationSec title artist variants.thumb variants.poster",
      )
      .lean()
      .exec();
    const byId = new Map(assets.map(a => [String(a._id), a]));

    const meta: Record<string, AttachmentMetaEntry> = {};
    attachments.forEach((url, i) => {
      const mediaId = attachmentMediaIds[i];
      const asset = mediaId ? byId.get(mediaId) : undefined;
      if (asset) {
        meta[url] = {
          mediaId,
          width: asset.width,
          height: asset.height,
          blurhash: asset.blurhash,
        };
        // File/music messages: the facts the bubble shows (size, type, tags, cover/thumbnail),
        // all from the stored asset — never from the client.
        if (asset.kind === "video") {
          // Albums mix photos and videos: each cell needs its own kind, length and poster.
          Object.assign(meta[url], {
            kind: "video",
            durationSec: asset.durationSec ?? null,
            posterUrl: asset.variants?.poster
              ? `/uploads/media/${asset.variants.poster}`
              : null,
          });
        }
        if (asset.kind === "file" || asset.kind === "audio") {
          const name = attachmentNames?.[i]?.trim();
          Object.assign(meta[url], {
            kind: asset.kind,
            fileName: name ? name.slice(0, 255) : null,
            sizeBytes: asset.sizeBytes ?? null,
            mimeType: asset.mimeType ?? null,
            durationSec: asset.durationSec ?? null,
            title: asset.title ?? null,
            artist: asset.artist ?? null,
            thumbUrl: asset.variants?.thumb
              ? `/uploads/media/${asset.variants.thumb}`
              : null,
          });
        }
      }
    });
    return Object.keys(meta).length ? meta : null;
  }

  private mapSender<T extends { senderId?: unknown }>(
    message: T,
    view: PrivacyView,
  ): T {
    const sender = message.senderId;
    if (sender && typeof sender === "object" && "username" in sender) {
      return {
        ...message,
        senderId: view.publicUser(sender as unknown as { _id: unknown }),
      };
    }
    return message;
  }

  /** Maps populated senders to `PublicUserDto`, photos filtered by each sender's privacy
   *  as `viewerId` may see them (one batch for the whole page). */
  private async mapSenders<T extends { senderId?: unknown }>(
    messages: T[],
    viewerId: string,
  ): Promise<T[]> {
    const view = await this.privacy.forViewer(
      viewerId,
      messages.map(m =>
        m.senderId && typeof m.senderId === "object"
          ? (m.senderId as { _id?: unknown })._id
          : m.senderId,
      ),
    );
    return this.maskChannelAuthors(messages.map(m => this.mapSender(m, view)));
  }

  /**
   * Channel posts go out as the channel, whoever wrote them (see channel-author.util.ts). One
   * batch lookup for the whole page; non-channel messages pass through untouched.
   */
  private async maskChannelAuthors<T extends { senderId?: unknown }>(
    messages: T[],
  ): Promise<T[]> {
    const channelIds = [
      ...new Set(
        messages
          .map(m => (m as { channelId?: unknown }).channelId)
          .filter(id => id && Types.ObjectId.isValid(String(id as string)))
          .map(id => String(id as string)),
      ),
    ];
    if (!channelIds.length) return messages;
    const channels = await this.chatModel
      .find({ _id: { $in: channelIds }, type: ChatType.CHANNEL })
      .select("name image signature")
      .lean()
      .exec();
    if (!channels.length) return messages;
    const byId = new Map(channels.map(c => [String(c._id), c]));
    return messages.map(m => {
      const channelId = String((m as { channelId?: unknown }).channelId);
      const chat = byId.get(channelId);
      if (!chat) return m;
      return maskChannelMessage(
        m,
        channelId,
        chat,
        this.authorNameOf(m.senderId),
      );
    });
  }

  /** The author's display name for a populated sender; "Someone" when it isn't populated. */
  private authorNameOf(sender: unknown): string {
    if (sender && typeof sender === "object" && "username" in sender) {
      return this.displayNameOf(
        sender as { firstName?: string; lastName?: string; username?: string },
      );
    }
    return "Someone";
  }

  private async mapSenderOne<T extends { senderId?: unknown }>(
    message: T,
    viewerId: string,
  ): Promise<T> {
    return (await this.mapSenders([message], viewerId))[0];
  }

  private async resolveMentions(
    channelId: string,
    content: string,
    currentUserId: string,
  ): Promise<string[]> {
    const usernames = new Set<string>();
    const mentionRegex = /@([a-zA-Z0-9_]+)/g;
    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(content)) !== null) {
      const raw = match[1]?.trim();
      if (!raw) continue;
      usernames.add(raw.toLowerCase());
    }
    if (usernames.size === 0) return [];

    const users = await this.userModel
      .find({
        username: { $in: Array.from(usernames.values()) },
        isDeleted: false,
      })
      .select("_id username")
      .lean()
      .exec();
    if (!users.length) return [];

    const userIds = users
      .map(u => String(u._id))
      .filter(id => id !== currentUserId);
    if (!userIds.length) return [];

    const members = await this.chatMembersModel
      .find({
        channelId,
        userId: { $in: userIds },
      })
      .select("userId")
      .lean()
      .exec();
    if (!members.length) return [];

    const allowed = new Set(members.map(m => String(m.userId)));
    return userIds.filter(id => allowed.has(id));
  }

  async create(
    createMessageDto: CreateMessageDto,
    userId: string,
    /** Server-internal only (never from a client DTO): `metadata` for system messages the
     *  server itself posts, e.g. a group call's "X started a voice chat". */
    internal?: { metadata?: Record<string, unknown> },
  ) {
    // A resend of a message already stored (the client's outbox replays unacknowledged sends after
    // a reconnect): answer with that message instead of storing a second copy.
    if (createMessageDto.tempId) {
      const stored = await this.messageModel
        .findOne({
          channelId: createMessageDto.channelId,
          senderId: new Types.ObjectId(userId),
          clientTempId: createMessageDto.tempId,
        })
        .lean()
        .exec();
      if (stored) return stored;
    }
    // The 3 pre-checks below are independent of each other — run them in one round trip
    // instead of 3 sequential ones (B5: "parallelise independent reads in send").
    const [membership, senderDoc, chat] = await Promise.all([
      this.chatMembersModel.findOne({
        channelId: createMessageDto.channelId,
        userId,
      }),
      this.userModel
        .findOne({ _id: userId, isDeleted: false })
        .select("username firstName lastName image bio")
        .lean()
        .exec(),
      this.chatModel
        .findOne({ _id: createMessageDto.channelId, isDeleted: false })
        .select("type isLocked defaultPermissions name image signature")
        .lean()
        .exec(),
    ]);

    if (!membership || membership.isBanned) {
      throw new ForbiddenException(
        membership?.isBanned
          ? "You are banned from this chat"
          : "Access denied",
      );
    }
    if (!senderDoc) {
      throw new NotFoundException("Sender not found");
    }
    if (!chat) {
      throw new NotFoundException("Channel not found");
    }
    if (
      chat.type === ChatType.PRIVATE &&
      (await this.blockedInDirectChat(String(chat._id), userId))
    ) {
      throw new ForbiddenException("You can't message this person");
    }
    // Left a group/channel → no longer a member. (A direct chat you hid is
    // reopened by writing in it, as before.)
    if (
      membership.isJoined === false &&
      (chat.type === ChatType.GROUP || chat.type === ChatType.CHANNEL)
    ) {
      throw new ForbiddenException("Access denied");
    }
    const perms = effectivePermissions(chat, membership);
    if (chat.type === ChatType.CHANNEL && !perms.canPost) {
      throw new ForbiddenException("Only admins can post in this channel");
    }
    const requiredFor = (type: string | undefined) => {
      const key = permissionForMessageType(type);
      if (key) assertMemberPermission(perms, key);
    };
    requiredFor(createMessageDto.type);
    // Service messages ("X started a voice chat", call logs) are only ever posted by the
    // server itself — a client sending one would be spoofing it.
    if (
      !internal &&
      (createMessageDto.type === MessageType.SYSTEM ||
        createMessageDto.type === MessageType.VOICE_CALL)
    ) {
      throw new ForbiddenException("This message type can't be sent");
    }
    if (chat?.isLocked) {
      throw new ForbiddenException("This channel is locked");
    }

    const sanitizedContent = sanitizeMessageContent(
      createMessageDto.content || "",
    );

    const messageData: Record<string, unknown> = {
      channelId: createMessageDto.channelId,
      senderId: new Types.ObjectId(userId),
      ...(createMessageDto.tempId
        ? { clientTempId: createMessageDto.tempId }
        : {}),
      content: sanitizedContent,
      type: createMessageDto.type || "text",
      attachments: createMessageDto.attachments || [],
      attachmentMeta: await this.buildAttachmentMeta(
        createMessageDto.attachments,
        createMessageDto.attachmentMediaIds,
        createMessageDto.attachmentNames,
      ),
      durationSec: createMessageDto.durationSec ?? null,
      waveform: createMessageDto.waveform ?? null,
      originalFilename: createMessageDto.originalFilename ?? null,
      packId: null,
      packItemId: null,
      ...(internal?.metadata ? { metadata: internal.metadata } : {}),
      customEmoji:
        !createMessageDto.type || createMessageDto.type === MessageType.TEXT
          ? await this.resolveCustomEmoji(
              createMessageDto.content || "",
              sanitizedContent,
              createMessageDto.customEmoji,
              userId,
            )
          : [],
    };

    // A sticker/animated-emoji message sent from a pack item — authorize + resolve it (and
    // bump its usage) the same way a reaction does, so a received sticker can be traced back
    // to its pack (closing the "encountered a pack via a message" gap a bare attachments URL
    // can't). Not done for a forward (below) — a forward copies the original's own resolved
    // packId/packItemId directly instead of re-authorizing the forwarder for it.
    if (createMessageDto.packItemId) {
      const resolved = await this.packsService.resolveItemForUse(
        createMessageDto.packItemId,
        userId,
      );
      messageData.packId = resolved.packId;
      messageData.packItemId = createMessageDto.packItemId;
      // The sticker's real proportions, so the bubble reserves the right box before it loads
      // (stickers aren't all square).
      const stickerUrl = createMessageDto.attachments?.[0];
      if (stickerUrl && resolved.width && resolved.height) {
        messageData.attachmentMeta = {
          [stickerUrl]: {
            mediaId: resolved.mediaId ?? "",
            width: resolved.width,
            height: resolved.height,
            blurhash: null,
          },
        };
      }
    }

    // Forwarded message: copy payload from original and attach a minimal display-only
    // snapshot of the original sender (no userId — see message.schema.ts).
    if (createMessageDto.forwardFrom) {
      const original = await this.messageModel
        .findOne({
          _id: createMessageDto.forwardFrom,
          isDeleted: false,
        })
        .lean()
        .exec();
      if (!original) {
        throw new NotFoundException("Original message to forward not found");
      }
      // You can only forward what you can read.
      await this.assertChannelReadAccess(String(original.channelId), userId);
      requiredFor(original.type);
      if (!original.senderId) {
        throw new NotFoundException("Original message sender not found");
      }
      const originalUser = await this.userModel
        .findOne(
          { _id: original.senderId, isDeleted: false },
          { firstName: 1, lastName: 1, username: 1, image: 1 },
        )
        .lean()
        .exec();
      if (!originalUser) {
        throw new NotFoundException("Original message sender not found");
      }

      // "Forwarded messages" privacy: with a link, the forward carries the original sender's
      // id (tap → their profile) and photo; without, only their name (Telegram's
      // "The account was hidden by the user"). Judged against the forwarder; the snapshot is
      // what everyone in the destination chat sees, so the photo also needs to be one anyone
      // may see.
      const originalSenderId = String(original.senderId);
      const [forwardView, photoAudience, originChat] = await Promise.all([
        this.privacy.forViewer(userId, [originalSenderId]),
        this.privacy.audienceOf(originalSenderId, "profilePhotos"),
        this.chatModel
          .findOne({ _id: original.channelId })
          .select("type name")
          .lean()
          .exec(),
      ]);
      const linked = forwardView.can(originalSenderId, "forwards");
      const image = (originalUser as { image?: string[] }).image?.[0];
      const priorForward = (
        original as { forwardFrom?: Message["forwardFrom"] }
      ).forwardFrom;
      // Forwarding a forward keeps crediting the original author (as decided back then).
      messageData.forwardFrom = priorForward?.name
        ? priorForward
        : isChannelChat(originChat)
          ? { name: originChat?.name ?? "", hidden: true }
          : linked
            ? {
                name: this.displayNameOf(originalUser),
                userId: originalSenderId,
                ...(image && photoAudience.everyone
                  ? { avatarUrl: image }
                  : {}),
              }
            : { name: this.displayNameOf(originalUser), hidden: true };
      messageData.content = original.content;
      messageData.type = original.type;
      messageData.attachments = original.attachments ?? [];
      messageData.attachmentMeta =
        (original as { attachmentMeta?: unknown }).attachmentMeta ?? null;
      messageData.durationSec =
        (original as { durationSec?: number }).durationSec ?? null;
      messageData.waveform =
        (original as { waveform?: number[] }).waveform ?? null;
      messageData.packId = (original as { packId?: string }).packId ?? null;
      messageData.packItemId =
        (original as { packItemId?: string }).packItemId ?? null;
      messageData.customEmoji =
        (original as { customEmoji?: unknown[] }).customEmoji ?? [];
    }

    const mentions = await this.resolveMentions(
      createMessageDto.channelId,
      createMessageDto.content,
      userId,
    );
    const normalizedMentions = new Set<string>(mentions);

    if (createMessageDto.replyTo) {
      // Populate the original sender's name here — the one place this snapshot is ever
      // built — so every later read of this message needs no `.populate("replyTo")` (B5).
      const replyToMessage = await this.messageModel
        .findOne({
          _id: createMessageDto.replyTo,
          channelId: createMessageDto.channelId,
          isDeleted: false,
        })
        .populate("senderId", "username firstName lastName")
        .lean()
        .exec();
      if (!replyToMessage) {
        throw new NotFoundException("Reply-to message not found");
      }
      messageData.replyTo = new Types.ObjectId(createMessageDto.replyTo);

      const replySender = replyToMessage.senderId as unknown as {
        _id: Types.ObjectId;
        username?: string;
        firstName?: string;
        lastName?: string;
      };
      const replyAuthor = this.displayNameOf(replySender);
      messageData.replySnapshot = {
        id: String(replyToMessage._id),
        senderName: isChannelChat(chat)
          ? (signatureFor(chat, replyAuthor) ?? chat.name ?? "")
          : replyAuthor,
        snippet: buildMessagePreview(replyToMessage),
        messageType: replyToMessage.type,
      };

      // Treat replies as mentions of the original sender at the data layer so
      // unread-mentions and @ search automatically include replies-to-you.
      const originalSenderId = replySender?._id;
      if (originalSenderId) {
        const originalSenderStr = String(originalSenderId);
        if (originalSenderStr !== userId) {
          normalizedMentions.add(originalSenderStr);
        }
      }
    }

    if (normalizedMentions.size > 0) {
      messageData.mentions = Array.from(normalizedMentions.values());
    }

    if (chat?.type === ChatType.PRIVATE) {
      const otherMember = await this.chatMembersModel.findOne({
        channelId: createMessageDto.channelId,
        userId: { $nin: userId },
      });

      if (otherMember && !otherMember?.isJoined) {
        // No ban check here: `setBanned` explicitly rejects private chats, so a private
        // channel's membership can never be isBanned.
        const existing = await this.chatMembersModel.findOne({
          channelId: createMessageDto.channelId,
          userId: otherMember.userId,
        });
        if (existing) {
          if (existing.isJoined === false) {
            await this.chatMembersModel.updateOne(
              {
                channelId: createMessageDto.channelId,
                userId: otherMember.userId,
              },
              { $set: { isJoined: true } },
            );
          }
        } else {
          const channel = new this.chatMembersModel({
            channelId: createMessageDto.channelId,
            role: UserRole.MEMBER,
            userId: otherMember.userId,
          });
          await channel.save();
        }
      }
    }

    const message = await this.messageModel.create(messageData);

    this.eventEmitter.emit(MESSAGE_CREATED, {
      channelId: message.channelId,
      createdAt: message.createdAt,
      preview: buildMessagePreview(message),
      senderId: userId,
      messageId: message._id.toString(),
      mentions: message.mentions,
    });

    // No re-fetch: everything the response needs is already in hand (B5 — "drop the
    // post-create re-`findById().populate()`"). A brand-new message has 0 reactions.
    return {
      _id: message._id,
      channelId: message.channelId,
      // Sender's own view; ChatGateway removes the photo per recipient when their privacy
      // hides it. No bio on message senders (populated senders never carry one either).
      // A channel post goes out as the channel (see channel-author.util.ts) — for everyone,
      // the author included, so the wire shape matches what subscribers get.
      ...(isChannelChat(chat)
        ? {
            senderId: channelSenderView(createMessageDto.channelId, chat),
            signature: signatureFor(chat, this.displayNameOf(senderDoc)),
          }
        : {
            senderId: {
              ...toPublicUserDto({ ...senderDoc, _id: userId }),
              bio: "",
            },
            signature: null,
          }),
      content: message.content,
      forwardFrom: message.forwardFrom,
      type: message.type,
      attachments: message.attachments,
      attachmentMeta: message.attachmentMeta,
      replyTo: message.replyTo,
      replySnapshot: message.replySnapshot,
      isEdited: message.isEdited,
      isPinned: message.isPinned,
      mentions: message.mentions,
      durationSec: message.durationSec,
      waveform: message.waveform,
      originalFilename: message.originalFilename,
      deletedFor: message.deletedFor,
      metadata: message.metadata,
      packId: message.packId,
      packItemId: message.packItemId,
      customEmoji: (message.customEmoji ?? []).map(
        ({ offset, length, packItemId, packId, relativePath, stillPath }) => ({
          offset,
          length,
          packItemId,
          packId,
          relativePath,
          stillPath,
        }),
      ),
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      reactions: [] as ReactionSummary[],
    };
  }

  async findAll(
    channelId: string,
    userId: string,
    limit = 50,
    offset = 0,
    afterDate?: string,
    beforeDate?: string,
    /** "newer": the `limit` *oldest* messages in range (paging forward from `afterDate`, e.g.
     *  after jumping to an old message). Default "older": the newest ones (paging back). */
    direction: "older" | "newer" = "older",
  ) {
    const { chat, membership } = await this.assertChannelReadAccess(
      channelId,
      userId,
    );

    let filter: Record<string, unknown> = {
      channelId,
      isDeleted: false,
      deletedFor: { $nin: [new Types.ObjectId(userId)] },
    };
    filter = this.hiddenAtFilter(filter, membership?.hiddenAt);
    if (afterDate) {
      const d = new Date(afterDate);
      if (!isNaN(d.getTime())) {
        filter.createdAt = {
          ...(filter.createdAt as Record<string, unknown> | undefined),
          $gte: d,
        };
      }
    }
    if (beforeDate) {
      const d = new Date(beforeDate);
      if (!isNaN(d.getTime())) {
        filter.createdAt = {
          ...(filter.createdAt as Record<string, unknown> | undefined),
          $lt: d,
        };
      }
    }

    if (chat.type === ChatType.CHANNEL) {
      filter.type = { $ne: "system" };
    }

    const newer = direction === "newer";
    const messages = await this.messageModel
      .find(filter)
      .sort({ createdAt: newer ? 1 : -1 })
      .limit(limit)
      .skip(offset)
      .populate("senderId", "username firstName lastName image")
      .lean()
      .exec();

    const withReactions = await this.withReactions(messages, userId);
    // Always oldest-first on the wire.
    return this.mapSenders(
      newer ? withReactions : withReactions.reverse(),
      userId,
    );
  }

  /**
   * Reconnect resync (B3): the messages a member missed while disconnected, newer than
   * `sinceMessageId`. Capped at 200 — a gap bigger than that is a client fetching `findAll`'s
   * normal history pagination instead, not a realtime resync.
   */
  async findSinceMessage(
    channelId: string,
    userId: string,
    sinceMessageId: string,
  ) {
    const membership = await this.chatMembersModel.findOne({
      channelId,
      userId,
      isBanned: { $ne: true },
    });
    if (!membership) {
      throw new ForbiddenException("Access denied");
    }
    const anchor = await this.messageModel
      .findById(sinceMessageId)
      .select("createdAt")
      .lean()
      .exec();
    if (!anchor) {
      throw new NotFoundException("Anchor message not found");
    }

    const sinceChat = await this.chatModel
      .findOne({ _id: channelId, isDeleted: false })
      .select("type")
      .lean()
      .exec();
    let filter: Record<string, unknown> = {
      channelId,
      isDeleted: false,
      deletedFor: { $nin: [new Types.ObjectId(userId)] },
      createdAt: { $gt: anchor.createdAt },
    };
    filter = this.hiddenAtFilter(filter, membership.hiddenAt);
    if (isChannelChat(sinceChat)) filter.type = { $ne: "system" };

    const messages = await this.messageModel
      .find(filter)
      .sort({ createdAt: 1 })
      .limit(200)
      .populate("senderId", "username firstName lastName image")
      .lean()
      .exec();

    const withReactions = await this.withReactions(messages, userId);
    return this.mapSenders(withReactions, userId);
  }

  async getFirstMessageOfDate(
    channelId: string,
    userId: string,
    dateStr: string,
  ): Promise<{ messageId: string | null }> {
    const { chat, membership } = await this.assertChannelReadAccess(
      channelId,
      userId,
    );

    const d = new Date(dateStr + "T00:00:00.000Z");
    if (isNaN(d.getTime())) {
      return { messageId: null };
    }
    const nextDay = new Date(d);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);

    let filter: Record<string, unknown> = {
      channelId,
      isDeleted: false,
      deletedFor: { $nin: [new Types.ObjectId(userId)] },
      createdAt: { $gte: d, $lt: nextDay },
    };
    filter = this.hiddenAtFilter(filter, membership?.hiddenAt);
    // Same as findAll: a channel's feed never shows system messages.
    if (chat.type === ChatType.CHANNEL) filter.type = { $ne: "system" };

    const first = await this.messageModel
      .findOne(filter)
      .sort({ createdAt: 1 })
      .select("_id")
      .lean()
      .exec();

    return { messageId: first ? String(first._id) : null };
  }

  async getFirstMessageFromDate(
    channelId: string,
    userId: string,
    dateStr: string,
    /** An exact instant (ISO) instead: the first message at or after it. The client sends the
     *  start of the picked day in *its own* time zone — `dateStr` alone is read as UTC, which
     *  for Tehran (+3:30) skips that day's first 3½ hours. */
    from?: string,
  ): Promise<{ messageId: string | null; createdAt: string | null }> {
    const { chat, membership } = await this.assertChannelReadAccess(
      channelId,
      userId,
    );

    let start: Date;
    const fromDate = from ? new Date(from) : null;
    if (fromDate && !isNaN(fromDate.getTime())) {
      start = fromDate;
    } else {
      const startOfChosen = new Date(dateStr + "T00:00:00.000Z");
      if (isNaN(startOfChosen.getTime())) {
        return { messageId: null, createdAt: null };
      }
      // Legacy "nearest newer" = first message strictly after the chosen UTC date.
      start = new Date(startOfChosen);
      start.setUTCDate(start.getUTCDate() + 1);
    }

    let filter: Record<string, unknown> = {
      channelId,
      isDeleted: false,
      deletedFor: { $nin: [new Types.ObjectId(userId)] },
      createdAt: { $gte: start },
    };
    filter = this.hiddenAtFilter(filter, membership?.hiddenAt);
    if (chat.type === ChatType.CHANNEL) filter.type = { $ne: "system" };

    const first = await this.messageModel
      .findOne(filter)
      .sort({ createdAt: 1 })
      .select("_id createdAt")
      .lean()
      .exec();

    if (!first) {
      return { messageId: null, createdAt: null };
    }
    return {
      messageId: String(first._id),
      createdAt: (first as { createdAt: Date }).createdAt
        ? new Date((first as { createdAt: Date }).createdAt).toISOString()
        : null,
    };
  }

  async getOldestMessageInChannel(
    channelId: string,
    userId: string,
  ): Promise<{ messageId: string | null; createdAt: string | null }> {
    const { chat, membership } = await this.assertChannelReadAccess(
      channelId,
      userId,
    );

    let filter: Record<string, unknown> = {
      channelId,
      isDeleted: false,
      deletedFor: { $nin: [new Types.ObjectId(userId)] },
    };
    filter = this.hiddenAtFilter(filter, membership?.hiddenAt);
    if (chat.type === ChatType.CHANNEL) filter.type = { $ne: "system" };

    const oldest = await this.messageModel
      .findOne(filter)
      .sort({ createdAt: 1 })
      .select("_id createdAt")
      .lean()
      .exec();

    if (!oldest) {
      return { messageId: null, createdAt: null };
    }
    return {
      messageId: String(oldest._id),
      createdAt: (oldest as { createdAt: Date }).createdAt
        ? new Date((oldest as { createdAt: Date }).createdAt).toISOString()
        : null,
    };
  }

  async searchInChannel(
    channelId: string,
    userId: string,
    q: string,
    limit: number,
  ): Promise<{ messageIds: string[]; total: number }> {
    const { membership } = await this.assertChannelReadAccess(
      channelId,
      userId,
    );

    let filter: Record<string, unknown> = {
      channelId,
      isDeleted: false,
      deletedFor: { $nin: [new Types.ObjectId(userId)] },
    };
    filter = this.hiddenAtFilter(filter, membership?.hiddenAt);
    const trimmed = (q || "").trim();
    if (trimmed === "@") {
      filter.mentions = userId;
    } else if (trimmed.length > 0) {
      filter.content = { $regex: escapeRegex(trimmed), $options: "i" };
    }

    const [messages, total] = await Promise.all([
      this.messageModel
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .select("_id")
        .lean()
        .exec(),
      this.messageModel.countDocuments(filter),
    ]);
    const messageIds = messages.map(m => String(m._id));
    return { messageIds, total };
  }

  async findOne(messageId: string, userId: string) {
    const message = await this.messageModel
      .findOne({ _id: messageId, isDeleted: false })
      .populate("senderId", "username firstName lastName image")
      .lean()
      .exec();

    if (!message) {
      throw new NotFoundException("Message not found");
    }

    const membership = await this.chatMembersModel.findOne({
      channelId: message.channelId,
      userId,
    });
    if (!membership) {
      throw new ForbiddenException("Access denied");
    }

    const [withReactions] = await this.withReactions([message], userId);
    return this.mapSenderOne(withReactions, userId);
  }

  /**
   * Validates + resolves inline animated emoji for a text message. Offsets
   * arrive relative to the client's raw `content`; the server trims it, so
   * they're shifted by the leading whitespace removed — and if sanitizing
   * removed anything *else* (control characters), positions can't be trusted
   * and the entities are dropped rather than drawn in the wrong place. Each
   * span must be a whitespace-free run inside the text, spans can't overlap,
   * and every item must come from an animated-emoji pack the sender owns or
   * has added (`resolveItemForUse` — same rule, and usage bump, as stickers).
   */
  private async resolveCustomEmoji(
    rawContent: string,
    sanitized: string,
    entities:
      { offset: number; length: number; packItemId: string }[] | undefined,
    userId: string,
  ): Promise<
    {
      offset: number;
      length: number;
      packItemId: string;
      packId: string;
      relativePath: string;
      stillPath: string;
    }[]
  > {
    if (!entities?.length || !sanitized) return [];
    if (sanitizeMessageContent(rawContent) !== rawContent.trim()) return [];
    const shift = rawContent.length - rawContent.trimStart().length;
    const resolved = new Map<
      string,
      Awaited<ReturnType<PacksService["resolveItemForUse"]>>
    >();
    const out: {
      offset: number;
      length: number;
      packItemId: string;
      packId: string;
      relativePath: string;
      stillPath: string;
    }[] = [];
    let lastEnd = 0;
    for (const e of [...entities].sort((a, b) => a.offset - b.offset)) {
      const offset = e.offset - shift;
      if (offset < lastEnd || offset + e.length > sanitized.length) continue;
      const span = sanitized.slice(offset, offset + e.length);
      if (!span || /\s/.test(span)) continue;
      let item = resolved.get(e.packItemId);
      if (!item) {
        item = await this.packsService.resolveItemForUse(e.packItemId, userId);
        resolved.set(e.packItemId, item);
      }
      if (item.packType !== PackType.EMOJI) {
        throw new BadRequestException(
          "Only animated emoji can be placed inside a message",
        );
      }
      // The small (160px) animated variant: inline emoji render at text size.
      out.push({
        offset,
        length: e.length,
        packItemId: e.packItemId,
        packId: item.packId,
        relativePath: item.thumbPath,
        stillPath: item.stillPath,
      });
      lastEnd = offset + e.length;
    }
    return out;
  }

  async update(
    messageId: string,
    updateMessageDto: UpdateMessageDto,
    userId: string,
  ) {
    const message = await this.messageModel.findOne({
      _id: messageId,
      isDeleted: false,
    });
    if (!message) {
      throw new NotFoundException("Message not found");
    }
    if (message.senderId.toString() !== userId) {
      // Channel admins with "edit messages" may edit other admins' posts.
      const [chatForEdit, editorMembership] = await Promise.all([
        this.chatModel
          .findById(message.channelId)
          .select("type defaultPermissions")
          .lean()
          .exec(),
        this.chatMembersModel
          .findOne({ channelId: message.channelId, userId })
          .lean()
          .exec(),
      ]);
      const mayEdit =
        chatForEdit?.type === ChatType.CHANNEL &&
        effectivePermissions(chatForEdit, editorMembership).admin.editMessages;
      if (!mayEdit) {
        throw new ForbiddenException("You can only edit your own messages");
      }
    }

    const sanitizedContent = sanitizeMessageContent(updateMessageDto.content);
    if (!sanitizedContent) {
      throw new BadRequestException("Content cannot be empty");
    }

    const mentions = await this.resolveMentions(
      message.channelId,
      sanitizedContent,
      userId,
    );
    const customEmoji = await this.resolveCustomEmoji(
      updateMessageDto.content,
      sanitizedContent,
      updateMessageDto.customEmoji,
      userId,
    );

    const updated = await this.messageModel
      .findByIdAndUpdate(
        messageId,
        {
          $set: {
            content: sanitizedContent,
            isEdited: true,
            updatedAt: new Date(),
            mentions,
            customEmoji,
          },
        },
        { new: true },
      )
      .populate("senderId", "username firstName lastName image")
      .lean()
      .exec();
    if (!updated) return updated;
    const [withReactions] = await this.withReactions([updated], userId);
    return this.mapSenderOne(withReactions, userId);
  }

  async remove(messageId: string, userId: string) {
    const message = await this.messageModel.findOne({
      _id: messageId,
      isDeleted: false,
    });
    if (!message) {
      throw new NotFoundException("Message not found");
    }

    const membership = await this.chatMembersModel.findOne({
      channelId: message.channelId,
      userId,
    });
    if (!membership) {
      throw new ForbiddenException("Access denied");
    }

    const chatForDelete = await this.chatModel
      .findById(message.channelId)
      .select("type defaultPermissions")
      .lean()
      .exec();
    const canDelete =
      message.senderId.toString() === userId ||
      (!!chatForDelete &&
        effectivePermissions(chatForDelete, membership).admin.deleteMessages);

    if (!canDelete) {
      throw new ForbiddenException(
        "You can only delete your own messages here",
      );
    }

    const deleted = await this.messageModel
      .findByIdAndUpdate(
        messageId,
        { $set: { isDeleted: true, isPinned: false } },
        { new: true },
      )
      .exec();
    await this.recomputeAfterDelete(message.channelId);
    return deleted;
  }

  /**
   * Recomputes the chat list summary after any delete-for-everyone (own, admin, moderator).
   * Awaited: the `message_deleted` broadcast carries the recomputed summary, so it must exist
   * first (the listener never throws).
   */
  async recomputeAfterDelete(channelId: string): Promise<void> {
    await Promise.resolve(
      this.eventEmitter.emitAsync?.(MESSAGE_DELETED, { channelId }),
    ).catch(() => {});
  }

  /** The channel's chat-list summary (`chat_state`), for the `message_deleted` broadcast. */
  async channelLastState(channelId: string): Promise<{
    lastMessageAt: Date | null;
    lastMessagePreview: string | null;
  }> {
    const state = await this.chatStateModel
      ?.findOne({ channelId })
      .select("lastMessageAt lastMessagePreview")
      .lean()
      .exec();
    return {
      lastMessageAt: state?.lastMessageAt ?? null,
      lastMessagePreview: state?.lastMessagePreview ?? null,
    };
  }

  async removeForMeOnly(messageId: string, userId: string) {
    const message = await this.messageModel.findOne({
      _id: messageId,
      isDeleted: false,
    });
    if (!message) {
      throw new NotFoundException("Message not found");
    }

    const membership = await this.chatMembersModel.findOne({
      channelId: message.channelId,
      userId,
    });
    if (!membership) {
      throw new ForbiddenException("Access denied");
    }

    await this.messageModel.findByIdAndUpdate(messageId, {
      $addToSet: { deletedFor: new Types.ObjectId(userId) },
    });
    // My chat list preview may now need an earlier message — awaited so the client's
    // list refetch right after this request already sees it.
    await Promise.resolve(
      this.eventEmitter.emitAsync?.(MESSAGE_DELETED_FOR_ME, {
        channelId: message.channelId,
        userId,
      }),
    ).catch(() => {});
    return { success: true };
  }

  /**
   * Toggle a reaction (B5) — either a plain unicode emoji, or a sticker/animated-emoji pack
   * item (exactly one of `emoji`/`packItemId`, never both — see MessageReaction's doc comment).
   * Replaces the old read-modify-write of the whole message's `reactions` Map with a single
   * delete (removing) or a distinct-count check + insert (adding) against the
   * `message_reactions` collection.
   */
  async toggleReaction(
    messageId: string,
    userId: string,
    emoji?: string,
    packItemId?: string,
  ) {
    const trimmedEmoji = (emoji || "").trim() || null;
    const trimmedPackItemId = (packItemId || "").trim() || null;
    if (!trimmedEmoji && !trimmedPackItemId) {
      throw new BadRequestException("emoji or packItemId is required");
    }
    if (trimmedEmoji && trimmedPackItemId) {
      throw new BadRequestException(
        "Provide either emoji or packItemId, not both",
      );
    }

    const message = await this.messageModel
      .findById(messageId)
      .select("channelId isDeleted")
      .lean()
      .exec();
    if (!message || message.isDeleted) {
      throw new NotFoundException("Message not found");
    }

    const membership = await this.chatMembersModel.findOne({
      channelId: message.channelId,
      userId,
    });
    if (!membership) {
      throw new ForbiddenException("Access denied");
    }

    const removed = await this.messageReactionModel
      .findOneAndDelete({
        messageId,
        userId,
        emoji: trimmedEmoji,
        packItemId: trimmedPackItemId,
      })
      .exec();

    let action: "added" | "removed";
    if (removed) {
      action = "removed";
    } else {
      const distinctGroups = await this.messageReactionModel.aggregate([
        { $match: { messageId } },
        { $group: { _id: { emoji: "$emoji", packItemId: "$packItemId" } } },
        { $count: "n" },
      ]);
      const distinctCount =
        (distinctGroups[0] as { n: number } | undefined)?.n ?? 0;
      if (distinctCount >= MAX_DISTINCT_EMOJIS_PER_MESSAGE) {
        throw new BadRequestException(
          `This message already has the maximum of ${MAX_DISTINCT_EMOJIS_PER_MESSAGE} distinct reactions`,
        );
      }

      // Authorize + resolve the pack item (and bump its usage) BEFORE inserting — if the caller
      // doesn't have this pack, nothing should be created. Only happens on the add path: a
      // removal doesn't need to re-authorize something the caller already successfully added.
      let packId: string | null = null;
      let packItemRelativePath: string | null = null;
      if (trimmedPackItemId) {
        const resolved = await this.packsService.resolveItemForUse(
          trimmedPackItemId,
          userId,
        );
        packId = resolved.packId;
        // Reaction pills are ~16px — the small variant, not the original.
        packItemRelativePath = resolved.thumbPath;
      }

      try {
        await this.messageReactionModel.create({
          messageId,
          channelId: message.channelId,
          userId,
          emoji: trimmedEmoji,
          packItemId: trimmedPackItemId,
          packId,
          packItemRelativePath,
        });
      } catch (err: unknown) {
        // Unique-index race: another request added the same (messageId,userId,emoji,
        // packItemId) concurrently. That's the same end state as this request "adding" it —
        // not an error.
        if ((err as { code?: number })?.code !== 11000) throw err;
      }
      action = "added";
    }

    const grouped = await this.getReactionsForMessages([messageId], userId);
    return {
      channelId: message.channelId,
      messageId,
      emoji: trimmedEmoji,
      packItemId: trimmedPackItemId,
      userId,
      action,
      reactions: grouped.get(messageId) ?? [],
    };
  }

  async pinMessage(messageId: string, userId: string) {
    const message = await this.messageModel.findById(messageId);
    if (!message || message.isDeleted) {
      throw new NotFoundException("Message not found");
    }

    const membership = await this.chatMembersModel.findOne({
      channelId: message.channelId,
      userId,
    });
    if (!membership) {
      throw new ForbiddenException("Access denied");
    }

    const chat = await this.chatModel.findById(message.channelId).lean().exec();
    const isPrivate = chat?.type === ChatType.PRIVATE;
    if (
      !isPrivate &&
      chat &&
      !effectivePermissions(chat, membership).member.pinMessages
    ) {
      throw new ForbiddenException("You can't pin messages here");
    }

    const pinned = await this.messageModel
      .findByIdAndUpdate(messageId, { $set: { isPinned: true } }, { new: true })
      .populate("senderId", "username firstName lastName image")
      .lean()
      .exec();
    if (!pinned) return pinned;
    const [withReactions] = await this.withReactions([pinned], userId);
    return this.mapSenderOne(withReactions, userId);
  }

  async unpinMessage(messageId: string, userId: string) {
    const message = await this.messageModel.findById(messageId);
    if (!message || message.isDeleted) {
      throw new NotFoundException("Message not found");
    }
    const membership = await this.chatMembersModel.findOne({
      channelId: message.channelId,
      userId,
    });
    if (!membership) {
      throw new ForbiddenException("Access denied");
    }

    const chat = await this.chatModel.findById(message.channelId).lean().exec();
    const isPrivate = chat?.type === ChatType.PRIVATE;
    if (
      !isPrivate &&
      chat &&
      !effectivePermissions(chat, membership).member.pinMessages
    ) {
      throw new ForbiddenException("You can't unpin messages here");
    }
    const unpinned = await this.messageModel
      .findByIdAndUpdate(
        messageId,
        { $set: { isPinned: false } },
        { new: true },
      )
      .populate("senderId", "username firstName lastName image")
      .lean()
      .exec();
    if (!unpinned) return unpinned;
    const [withReactions] = await this.withReactions([unpinned], userId);
    return this.mapSenderOne(withReactions, userId);
  }

  /**
   * A chat's "shared media" browser (the profile/info page's Media · Files ·
   * Music · Links · Voice tabs), newest first, paged by `before` (an ISO
   * date — the oldest `createdAt` the client already has). Same visibility
   * rules as history: membership (or a public chat), soft deletes,
   * delete-for-me and the member's `hiddenAt` (cleared history).
   */
  async getSharedMessages(
    channelId: string,
    userId: string,
    kind: SharedMediaKind,
    before?: string,
    limit = 40,
  ) {
    const { membership } = await this.assertChannelReadAccess(
      channelId,
      userId,
    );
    let filter: Record<string, unknown> = {
      channelId,
      isDeleted: false,
      deletedFor: { $nin: [new Types.ObjectId(userId)] },
      ...sharedKindFilter(kind),
    };
    filter = this.hiddenAtFilter(filter, membership?.hiddenAt);
    if (before) {
      const d = new Date(before);
      if (!isNaN(d.getTime())) {
        filter.createdAt = {
          ...(filter.createdAt as Record<string, unknown> | undefined),
          $lt: d,
        };
      }
    }
    const messages = await this.messageModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("senderId", "username firstName lastName image")
      .lean()
      .exec();
    return this.mapSenders(messages, userId);
  }

  /** The visibility filter every shared-media read starts from: this chat, not deleted
   *  (for everyone or for me), after my "clear history". */
  private sharedBaseFilter(
    channelId: string,
    userId: string,
    hiddenAt: Date | null | undefined,
  ): Record<string, unknown> {
    return this.hiddenAtFilter(
      {
        channelId,
        isDeleted: false,
        deletedFor: { $nin: [new Types.ObjectId(userId)] },
      },
      hiddenAt,
    );
  }

  /**
   * How many ITEMS each shared-media tab holds — an album of three photos counts three, a
   * group of four files four; a link message counts once. Lets the client hide empty tabs
   * (Telegram does) and show counts without fetching every list.
   */
  async getSharedCounts(channelId: string, userId: string) {
    const { membership } = await this.assertChannelReadAccess(
      channelId,
      userId,
    );
    const rows = await this.messageModel
      .aggregate<{ _id: SharedMediaKind; n: number }>([
        {
          $match: {
            ...this.sharedBaseFilter(channelId, userId, membership?.hiddenAt),
            type: { $in: sharedMessageTypes(SHARED_MEDIA_KINDS) },
          },
        },
        ...explodeSharedItemsStages(),
        { $match: { kind: { $ne: null } } },
        { $group: { _id: "$kind", n: { $sum: 1 } } },
      ])
      .exec();
    const counts = Object.fromEntries(
      SHARED_MEDIA_KINDS.map(k => [k, 0]),
    ) as Record<SharedMediaKind, number>;
    for (const r of rows) if (r._id in counts) counts[r._id] = r.n;
    return counts;
  }

  /**
   * One shared-media tab as ITEMS (each photo/video of an album, each file of a file group,
   * each track of a music group…), newest first, paged by item: `cursor` is the previous
   * page's `nextCursor`. Returns the item refs in order plus the messages they come from
   * (once each, senders mapped through privacy like history). Same visibility rules as
   * history: membership (or a public chat), soft deletes, delete-for-me and `hiddenAt`.
   */
  async getSharedItems(
    channelId: string,
    userId: string,
    kind: SharedMediaKind,
    cursor?: string,
    limit = 60,
  ) {
    const { membership } = await this.assertChannelReadAccess(
      channelId,
      userId,
    );
    const after = decodeSharedCursor(cursor, id =>
      Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null,
    );
    if (cursor && !after) throw new BadRequestException("Invalid cursor");
    const match: Record<string, unknown> = {
      ...this.sharedBaseFilter(channelId, userId, membership?.hiddenAt),
      type: { $in: sharedMessageTypes([kind]) },
    };
    if (after) {
      match.createdAt = {
        ...(match.createdAt as Record<string, unknown> | undefined),
        $lte: after.createdAt,
      };
    }
    const refs = await this.messageModel
      .aggregate<{ _id: Types.ObjectId; idx: number; createdAt: Date }>([
        { $match: match },
        { $sort: { createdAt: -1, _id: -1 } },
        ...explodeSharedItemsStages(),
        { $match: { kind, ...(after ? afterCursorMatch(after) : {}) } },
        { $limit: limit },
        { $project: { _id: 1, idx: 1, createdAt: 1 } },
      ])
      .exec();

    const ids = [...new Set(refs.map(r => String(r._id)))];
    const messages = ids.length
      ? await this.messageModel
          .find({ _id: { $in: ids.map(id => new Types.ObjectId(id)) } })
          .populate("senderId", "username firstName lastName image")
          .lean()
          .exec()
      : [];
    const byId = new Map(messages.map(m => [String(m._id), m]));
    const ordered = ids.map(id => byId.get(id)).filter(m => !!m);
    const last = refs[refs.length - 1];
    return {
      items: refs.map(r => ({ messageId: String(r._id), index: r.idx })),
      messages: await this.mapSenders(ordered, userId),
      nextCursor:
        refs.length === limit && last
          ? encodeSharedCursor({
              createdAt: last.createdAt,
              messageId: String(last._id),
              index: last.idx,
            })
          : null,
    };
  }

  async getPinnedMessages(channelId: string, userId: string) {
    const chat = await this.chatModel
      .findOne({ _id: channelId, isDeleted: false })
      .lean()
      .exec();
    if (!chat) return [];

    const membership = await this.chatMembersModel
      .findOne({ channelId, userId })
      .lean()
      .exec();

    let filter: Record<string, unknown> = {
      channelId,
      isPinned: true,
      isDeleted: false,
      deletedFor: { $nin: [new Types.ObjectId(userId)] },
    };
    filter = this.hiddenAtFilter(filter, membership?.hiddenAt);

    const pinned = await this.messageModel
      .find(filter)
      .sort({ createdAt: -1 })
      .populate("senderId", "username firstName lastName image")
      .lean()
      .exec();
    const withReactions = await this.withReactions(pinned, userId);
    return this.mapSenders(withReactions, userId);
  }

  async getUnreadCount(channelId: string, userId: string): Promise<number> {
    const membership = await this.chatMembersModel.findOne({
      channelId,
      userId,
    });
    if (!membership) return 0;

    let newerThan: Date | null = null;
    if (membership.lastReadMessageId) {
      const lastRead = await this.messageModel
        .findById(membership.lastReadMessageId)
        .select("createdAt")
        .lean()
        .exec();
      if (lastRead?.createdAt) newerThan = lastRead.createdAt;
    }

    let filter: Record<string, unknown> = {
      channelId,
      isDeleted: false,
      type: { $ne: MessageType.SYSTEM },
      senderId: { $ne: new Types.ObjectId(userId) },
    };
    filter = this.hiddenAtFilter(filter, membership.hiddenAt);
    if (newerThan) {
      filter.createdAt = {
        ...(filter.createdAt as Record<string, unknown> | undefined),
        $gt: newerThan,
      };
    }

    return this.messageModel.countDocuments(filter).exec();
  }

  async getUnreadMentions(
    channelId: string,
    userId: string,
    limit = 50,
  ): Promise<{ count: number; messages: Message[] }> {
    const membership = await this.chatMembersModel.findOne({
      channelId,
      userId,
    });

    let newerThan: Date | null = null;
    if (membership && membership.lastReadMessageId) {
      const lastRead = await this.messageModel
        .findById(membership.lastReadMessageId)
        .select("createdAt")
        .lean()
        .exec();
      if (lastRead?.createdAt) newerThan = lastRead.createdAt;
    }

    let baseFilter: Record<string, unknown> = {
      channelId,
      isDeleted: false,
      deletedFor: { $nin: [new Types.ObjectId(userId)] },
      mentions: { $in: [userId] },
    };
    baseFilter = this.hiddenAtFilter(baseFilter, membership?.hiddenAt);
    if (newerThan) {
      baseFilter.createdAt = {
        ...(baseFilter.createdAt as Record<string, unknown> | undefined),
        $gt: newerThan,
      };
    }

    const [messages, count] = await Promise.all([
      this.messageModel
        .find(baseFilter)
        .sort({ createdAt: 1 })
        .limit(Math.min(Math.max(limit, 1), 100))
        .populate("senderId", "username firstName lastName image")
        .lean()
        .exec(),
      this.messageModel.countDocuments(baseFilter).exec(),
    ]);

    const withReactions = await this.withReactions(messages, userId);
    return {
      count,
      messages: (await this.mapSenders(
        withReactions,
        userId,
      )) as unknown as Message[],
    };
  }

  /**
   * Messages in the channel, unread by this user, that have at least one reaction (B5:
   * backed by `message_reactions` now that `message.reactions` is gone).
   */
  async getUnreadReactions(
    channelId: string,
    userId: string,
    limit = 50,
  ): Promise<{ count: number; messages: Message[] }> {
    const membership = await this.chatMembersModel.findOne({
      channelId,
      userId,
    });
    if (!membership) {
      throw new ForbiddenException("Access denied");
    }

    let newerThan: Date | null = null;
    if (membership.lastReadMessageId) {
      const lastRead = await this.messageModel
        .findById(membership.lastReadMessageId)
        .select("createdAt")
        .lean()
        .exec();
      if (lastRead?.createdAt) newerThan = lastRead.createdAt;
    }

    const reactedMessageIds = await this.messageReactionModel.distinct(
      "messageId",
      { channelId },
    );
    if (!reactedMessageIds.length) {
      return { count: 0, messages: [] };
    }

    let baseFilter: Record<string, unknown> = {
      _id: { $in: reactedMessageIds.map(id => new Types.ObjectId(id)) },
      channelId,
      isDeleted: false,
      deletedFor: { $nin: [new Types.ObjectId(userId)] },
    };
    baseFilter = this.hiddenAtFilter(baseFilter, membership.hiddenAt);
    if (newerThan) {
      baseFilter.createdAt = {
        ...(baseFilter.createdAt as Record<string, unknown> | undefined),
        $gt: newerThan,
      };
    }

    const [messages, count] = await Promise.all([
      this.messageModel
        .find(baseFilter)
        .sort({ createdAt: 1 })
        .limit(Math.min(Math.max(limit, 1), 100))
        .select("_id channelId createdAt")
        .lean()
        .exec(),
      this.messageModel.countDocuments(baseFilter).exec(),
    ]);

    return {
      count,
      messages: messages as unknown as Message[],
    };
  }

  async markAsRead(
    channelId: string,
    userId: string,
    lastReadMessageId: string,
  ): Promise<{
    success: boolean;
    channelId: string;
    lastReadMessageId: string;
    /** `createdAt` of that message — rides along on `read:updated` so senders can turn
     *  every message up to it into ✓✓ without a lookup. */
    upToCreatedAt: string | null;
  }> {
    // A malformed id used to reach the ObjectId cast and surface as a 500.
    if (!Types.ObjectId.isValid(lastReadMessageId)) {
      throw new BadRequestException("Invalid message id");
    }
    const message = await this.messageModel
      .findOne({
        _id: lastReadMessageId,
        channelId,
        isDeleted: false,
      })
      .select("_id createdAt")
      .lean()
      .exec();
    if (!message) {
      throw new NotFoundException("Message not found");
    }

    // Single write on the membership pointer (B5) — replaces the old per-message `readBy`
    // Map bulk-update (`message.readBy` is gone from the schema entirely).
    const readAt = new Date();
    // Only ever forward: a client marking an older message read (a stale tab, a jump back
    // in history) must not pull the pointer back and un-read later messages. ObjectId hex
    // strings sort in creation order, so a string comparison is enough.
    const updated = await this.chatMembersModel.updateOne(
      {
        channelId,
        userId,
        $or: [
          { lastReadMessageId: null },
          { lastReadMessageId: { $lt: lastReadMessageId } },
        ],
      },
      {
        $set: {
          lastReadMessageId,
          lastReadAt: readAt,
        },
      },
    );

    // Per-message read times ("Seen by" sheet) — awaited so the checkpoint exists before the
    // `read:updated` broadcast makes the author's open sheet refetch. Never fails the read.
    if (updated.matchedCount > 0 && message.createdAt) {
      const event: MessagesReadEvent = {
        channelId,
        userId,
        upToCreatedAt: message.createdAt,
        readAt,
      };
      await this.eventEmitter.emitAsync(MESSAGES_READ, event).catch(() => {});
    }

    return {
      success: true,
      channelId,
      lastReadMessageId,
      upToCreatedAt: message.createdAt
        ? new Date(message.createdAt).toISOString()
        : null,
    };
  }
}
