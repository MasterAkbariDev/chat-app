import { randomBytes } from "crypto";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Chat } from "./schema/chat.schema";
import { Model, Types } from "mongoose";
import { ChatMembers } from "./schema/chat-members.schema";
import { CreateChatDto } from "./dto/create-chat.dto";
import { ChatType, MessageType, UserRole } from "src/enum/base.enum";
import { UpdateChatDto } from "./dto/update-chat.dto";
import { User } from "src/user/schema/user.schema";
import { Message } from "src/message/schema/message.schema";
import { ChatGateway } from "src/gateway/chat.gateway";
import { PublicUserDto } from "src/common/dto/user-view.dto";
import { PrivacyService } from "src/privacy/privacy.service";
import { EventEmitter2 } from "eventemitter2";
import { MEMBERSHIP_CHANGED } from "src/events/domain-events";
import {
  SAVED_MESSAGES_LINK_PREFIX,
  privateChatLink,
} from "./private-chat-link.util";
import { escapeRegex } from "src/common/utils/escape-regex";
import {
  ADMIN_RIGHT_KEYS,
  AdminRights,
  MEMBER_PERMISSION_KEYS,
  MemberPermissions,
  adminRightsOf,
  defaultPermissionsOf,
  effectivePermissions,
  pickRights,
} from "./permissions";

/** 12 url-safe random characters for an invite link. */
function newInviteCode(): string {
  return randomBytes(9).toString("base64url");
}

@Injectable()
export class ChatService {
  constructor(
    @InjectModel(Chat.name) private readonly chatModel: Model<Chat>,
    @InjectModel(ChatMembers.name)
    private readonly chatMembersModel: Model<ChatMembers>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Message.name) private readonly messageModel: Model<Message>,
    private readonly chatGateway: ChatGateway,
    private readonly eventEmitter: EventEmitter2,
    private readonly privacy: PrivacyService,
  ) {}

  /**
   * `chatmembers.role` is the only source of truth for who is an admin (B2 —
   * docs/plans/BACKEND_PLAN.md: "one role store, drop chat.admins[] + the sync loop"). The
   * frontend still reads `chat.admins[]` on the chat object though, so rather than remove the
   * field (a frontend change out of this repo's scope), this recomputes it as a pure derived
   * mirror after every role change — there is no longer any separate path that can set it
   * independently, so it can no longer drift from `chatmembers.role`.
   */
  private async recomputeChatAdmins(
    channelId: string,
  ): Promise<Types.ObjectId[]> {
    const admins = await this.chatMembersModel
      .find({ channelId, role: UserRole.ADMIN })
      .select("userId")
      .lean()
      .exec();
    const adminIds = admins.map(a => new Types.ObjectId(String(a.userId)));
    await this.chatModel
      .updateOne({ _id: channelId }, { $set: { admins: adminIds } })
      .exec();
    return adminIds;
  }

  /** Same formula as WallpaperService.applyChat's `senderDisplayName` — kept in sync so a
   * system message's `metadata.senderName` reads the same way everywhere it's set. */
  private async resolveDisplayName(userId: string): Promise<string> {
    const user = await this.userModel
      .findById(userId)
      .select("firstName lastName username")
      .lean()
      .exec();
    return (
      [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() ||
      user?.username ||
      "Someone"
    );
  }

  async create(createChatDto: CreateChatDto, user_id: string) {
    const existing = await this.chatModel
      .findOne({ link: createChatDto.link, isDeleted: false })
      .exec();
    if (existing) {
      throw new BadRequestException("Channel already exists");
    }

    const {
      members = [],
      admins = [],
      imageUrl,
      isPublic = false,
      ...chatData
    } = createChatDto;

    // DTO field is `imageUrl` (the wire name every client actually sends); the schema's
    // internal field stays `image`. Map here so the boundary owns the rename.
    const newChannel = await this.chatModel.create({
      ...chatData,
      isPublic,
      inviteCode: newInviteCode(),
      ...(imageUrl !== undefined ? { image: imageUrl } : {}),
    });

    const requested = [
      ...new Set([
        ...members.map((m: string) => m),
        ...admins.map((a: string) => a),
      ]),
    ].filter(id => id !== user_id);
    // "Groups & channels" privacy: people who don't let the creator add them are left out.
    const view = await this.privacy.forViewer(user_id, requested);
    const restrictedMemberIds = requested.filter(
      id => !view.can(id, "groupInvites"),
    );
    const uniqueUserIds = requested.filter(
      id => !restrictedMemberIds.includes(id),
    );

    const chatMembers = uniqueUserIds.map((userId: string) => ({
      channelId: newChannel._id.toString(),
      userId,
      role: admins.includes(userId) ? UserRole.ADMIN : UserRole.MEMBER,
    }));

    await this.chatMembersModel.insertMany(chatMembers);
    await this.chatMembersModel.create({
      channelId: newChannel._id.toString(),
      userId: user_id,
      role: UserRole.OWNER,
    });
    this.eventEmitter.emit(MEMBERSHIP_CHANGED, {
      channelId: newChannel._id.toString(),
    });

    if (admins.length > 0) {
      newChannel.admins = await this.recomputeChatAdmins(
        newChannel._id.toString(),
      );
    }

    // `restrictedMemberIds`: asked for but not added because of their privacy settings
    // (the client offers them the invite link instead).
    return Object.assign(newChannel.toObject(), { restrictedMemberIds });
  }

  async update(
    channelId: string,
    updateChatDto: UpdateChatDto,
    user_id: string,
  ) {
    // Owner: everything. Admin: name, description and photo only (as in
    // Telegram's default admin rights). Visibility, link and the admin list
    // stay with the owner.
    const { perms } = await this.permissionsFor(channelId, user_id);
    const isOwner = perms.role === UserRole.OWNER;
    if (!perms.member.changeInfo) {
      throw new ForbiddenException("You can't change this chat's info");
    }
    if (
      !isOwner &&
      (updateChatDto.link !== undefined ||
        updateChatDto.isPublic !== undefined ||
        updateChatDto.admins !== undefined)
    ) {
      throw new ForbiddenException(
        "Only the owner can change the link, visibility or admins",
      );
    }

    // Build update payload explicitly so description and imageUrl are always applied when provided
    const setPayload: Record<string, unknown> = {};
    if (updateChatDto.name !== undefined) setPayload.name = updateChatDto.name;
    if (updateChatDto.link !== undefined) setPayload.link = updateChatDto.link;
    if (updateChatDto.description !== undefined)
      setPayload.description = updateChatDto.description;
    if (updateChatDto.imageUrl !== undefined)
      setPayload.image = Array.isArray(updateChatDto.imageUrl)
        ? updateChatDto.imageUrl
        : [];
    if (updateChatDto.isPublic !== undefined)
      setPayload.isPublic = updateChatDto.isPublic;
    if (updateChatDto.signature !== undefined) {
      const current = await this.chatModel
        .findOne({ _id: channelId, isDeleted: false })
        .select("type")
        .lean()
        .exec();
      if (current?.type !== ChatType.CHANNEL) {
        throw new BadRequestException("Signatures are only for channels");
      }
      setPayload.signature = updateChatDto.signature;
    }

    // Optional: update admins list. Accept either user IDs or usernames and normalize to user IDs.
    let normalizedAdminIds: string[] | null = null;
    if (updateChatDto.admins !== undefined) {
      normalizedAdminIds = [];
      for (const raw of updateChatDto.admins) {
        // If it's a valid ObjectId, treat it as a userId directly.
        if (Types.ObjectId.isValid(raw)) {
          normalizedAdminIds.push(String(raw));
          continue;
        }

        // Otherwise, try to resolve it as a username.
        const user = await this.userModel
          .findOne({ username: raw })
          .select("_id")
          .lean()
          .exec();
        // Only this chat's members can be named — a non-member gets the same error as a
        // username nobody has, so this can't be used to probe who exists.
        const isMember =
          user &&
          (await this.chatMembersModel.exists({
            channelId,
            userId: String((user as { _id: Types.ObjectId })._id),
            isJoined: true,
          }));
        if (!user || !isMember) {
          throw new BadRequestException(
            `Invalid admin identifier: "${raw}" (must be a user id or existing username)`,
          );
        }
        const uid = String((user as { _id: Types.ObjectId })._id);
        normalizedAdminIds.push(uid);
      }
      // `chatmembers.role` is the only store that's actually written for role changes —
      // `chat.admins` is never set directly (see recomputeChatAdmins).
    }

    const updated = await this.chatModel
      .findOneAndUpdate({ _id: channelId }, { $set: setPayload }, { new: true })
      .exec();

    // Sync ChatMembers.role when admins list was updated (channel/group only)
    if (
      updated &&
      updated.type !== ChatType.PRIVATE &&
      normalizedAdminIds !== null
    ) {
      const newAdminIds = new Set(
        (normalizedAdminIds ?? []).map(id => String(id)),
      );
      const owner = await this.chatMembersModel
        .findOne({ channelId, role: UserRole.OWNER })
        .exec();
      const ownerId = owner?.userId ? String(owner.userId) : null;

      const members = await this.chatMembersModel.find({ channelId }).exec();
      for (const m of members) {
        const uid = String(m.userId);
        if (m.role === UserRole.OWNER) continue;
        const shouldBeAdmin = newAdminIds.has(uid) && uid !== ownerId;
        const newRole = shouldBeAdmin ? UserRole.ADMIN : UserRole.MEMBER;
        if (m.role !== newRole) {
          m.role = newRole;
          await m.save();
        }
      }

      const adminIds = await this.recomputeChatAdmins(channelId);
      updated.admins = adminIds;

      // Emit socket event so all members update admin/composer UI in realtime
      this.chatGateway.notifyChannelRolesUpdated(channelId, adminIds);
    }

    if (updated) {
      this.chatGateway.notifyChatUpdated(channelId, {
        name: updated.name,
        description: updated.description ?? null,
        image: updated.image ?? [],
        isPublic: !!updated.isPublic,
        link: updated.link,
        signature: !!updated.signature,
      });
    }
    return updated;
  }

  /** Promote a member to admin with default rights, or demote an admin. */
  async setAdmin(
    channelId: string,
    targetUserId: string,
    requestingUserId: string,
    makeAdmin: boolean,
  ) {
    return this.setAdminRights(
      channelId,
      targetUserId,
      requestingUserId,
      makeAdmin ? {} : null,
    );
  }

  /**
   * Make someone an admin with these rights (missing keys → defaults), update an admin's
   * rights, or (`rights === null`) demote them to a plain member.
   * The owner can do this for anyone. An admin with "add admins" can promote members and
   * edit/demote only the admins they appointed, and can't grant a right they don't hold.
   */
  async setAdminRights(
    channelId: string,
    targetUserId: string,
    requestingUserId: string,
    rights: Partial<AdminRights> | null,
  ) {
    if (!Types.ObjectId.isValid(targetUserId))
      throw new BadRequestException("Invalid user ID");
    if (targetUserId === requestingUserId)
      throw new BadRequestException("You can't change your own rights");
    const { chat, perms } = await this.permissionsFor(
      channelId,
      requestingUserId,
    );
    if (chat.type !== ChatType.GROUP && chat.type !== ChatType.CHANNEL) {
      throw new BadRequestException("Channel not found");
    }
    if (!perms.admin.addAdmins)
      throw new ForbiddenException("You can't manage admins here");
    const target = await this.chatMembersModel.findOne({
      channelId,
      userId: targetUserId,
    });
    if (!target || target.isBanned || target.isJoined === false) {
      throw new BadRequestException("That person isn't a member");
    }
    if (target.role === UserRole.OWNER)
      throw new BadRequestException("The owner's role can't be changed");
    const requesterIsOwner = perms.role === UserRole.OWNER;
    if (
      !requesterIsOwner &&
      target.role === UserRole.ADMIN &&
      target.promotedBy !== requestingUserId
    ) {
      throw new ForbiddenException("You can only change admins you appointed");
    }
    if (rights === null) {
      target.role = UserRole.MEMBER;
      target.adminRights = null;
      target.promotedBy = null;
    } else {
      const wasAdmin = target.role === UserRole.ADMIN;
      const current = adminRightsOf(wasAdmin ? target.adminRights : null);
      const requested = pickRights(ADMIN_RIGHT_KEYS, rights);
      const next = { ...current, ...requested };
      if (!requesterIsOwner) {
        // Rights the requester lacks are locked for them: an existing admin keeps whatever the
        // owner gave them there, and only explicitly granting one is refused.
        for (const k of ADMIN_RIGHT_KEYS) {
          if (perms.admin[k]) continue;
          const kept = wasAdmin ? current[k] : false;
          if (requested[k] && !kept)
            throw new ForbiddenException(
              "You can't give a right you don't have",
            );
          next[k] = kept;
        }
      }
      if (target.role !== UserRole.ADMIN) target.promotedBy = requestingUserId;
      target.role = UserRole.ADMIN;
      target.adminRights = next;
      // An admin can't also be restricted.
      target.mutedByAdmin = false;
      target.permissions = null;
    }
    target.markModified("adminRights");
    target.markModified("permissions");
    await target.save();
    const adminIds = await this.recomputeChatAdmins(channelId);
    this.chatGateway.notifyChannelRolesUpdated(channelId, adminIds);
    return {
      userId: targetUserId,
      role: target.role,
      adminRights:
        target.role === UserRole.ADMIN
          ? adminRightsOf(target.adminRights)
          : null,
    };
  }

  /** Groups: what plain members may do by default. Needs "ban users" (as in Telegram). */
  async setDefaultPermissions(
    channelId: string,
    requestingUserId: string,
    permissions: Partial<MemberPermissions>,
  ) {
    const { chat, perms } = await this.permissionsFor(
      channelId,
      requestingUserId,
    );
    if (chat.type !== ChatType.GROUP)
      throw new BadRequestException("Member permissions apply to groups only");
    if (!perms.admin.banUsers)
      throw new ForbiddenException("You can't change member permissions here");
    const next = {
      ...defaultPermissionsOf(chat.defaultPermissions),
      ...pickRights(MEMBER_PERMISSION_KEYS, permissions),
    };
    await this.chatModel
      .updateOne({ _id: channelId }, { $set: { defaultPermissions: next } })
      .exec();
    this.chatGateway.notifyPermissionsUpdated(channelId);
    return { defaultPermissions: next };
  }

  /** Groups: per-person exceptions for a plain member (`null` clears them). Needs "ban users". */
  async setMemberPermissions(
    channelId: string,
    targetUserId: string,
    requestingUserId: string,
    permissions: Partial<MemberPermissions> | null,
  ) {
    const { chat, perms } = await this.permissionsFor(
      channelId,
      requestingUserId,
    );
    if (chat.type !== ChatType.GROUP)
      throw new BadRequestException("Member permissions apply to groups only");
    if (!perms.admin.banUsers)
      throw new ForbiddenException("You can't change member permissions here");
    const target = await this.chatMembersModel.findOne({
      channelId,
      userId: targetUserId,
    });
    if (!target || target.isBanned || target.isJoined === false) {
      throw new BadRequestException("That person isn't a member");
    }
    if (target.role !== UserRole.MEMBER)
      throw new BadRequestException(
        "Admins' rights are set in their admin settings",
      );
    const exceptions =
      permissions === null
        ? null
        : pickRights(MEMBER_PERMISSION_KEYS, permissions);
    target.permissions =
      exceptions && Object.keys(exceptions).length ? exceptions : null;
    target.markModified("permissions");
    // Keep the older "muted" flag in step with the send right.
    target.mutedByAdmin = exceptions?.sendMessages === false;
    await target.save();
    this.chatGateway.notifyUserMuted(
      channelId,
      targetUserId,
      target.mutedByAdmin,
    );
    this.chatGateway.notifyPermissionsUpdated(channelId, targetUserId);
    return { userId: targetUserId, permissions: target.permissions };
  }

  /** The caller's own effective rights here, plus the chat's member defaults. */
  async getPermissions(channelId: string, userId: string) {
    const { chat, perms } = await this.permissionsFor(channelId, userId);
    return {
      myPermissions: perms,
      defaultPermissions: defaultPermissionsOf(chat.defaultPermissions),
    };
  }

  /** Loads the chat and the caller's membership and works out their rights. */
  async permissionsFor(channelId: string, userId: string) {
    if (!Types.ObjectId.isValid(channelId))
      throw new NotFoundException("Chat not found");
    const [chat, membership] = await Promise.all([
      this.chatModel
        .findOne({ _id: channelId, isDeleted: false })
        .select("type defaultPermissions")
        .lean()
        .exec(),
      this.chatMembersModel
        .findOne({ channelId, userId })
        .select(
          "role adminRights permissions mutedByAdmin isBanned isJoined promotedBy",
        )
        .lean()
        .exec(),
    ]);
    if (!chat) throw new NotFoundException("Chat not found");
    return { chat, membership, perms: effectivePermissions(chat, membership) };
  }

  /** The chat's invite link code (owner/admin), created on first request for
   *  chats made before invite links existed. */
  async getInviteCode(
    channelId: string,
    requestingUserId: string,
    reset = false,
  ): Promise<{ inviteCode: string }> {
    const chat = await this.chatModel.findOne({
      _id: channelId,
      isDeleted: false,
    });
    if (
      !chat ||
      (chat.type !== ChatType.GROUP && chat.type !== ChatType.CHANNEL)
    ) {
      throw new BadRequestException("Channel not found");
    }
    const { perms } = await this.permissionsFor(channelId, requestingUserId);
    if (!perms.admin.inviteUsers) {
      throw new ForbiddenException("You can't manage the invite link here");
    }
    if (!chat.inviteCode || reset) {
      chat.inviteCode = newInviteCode();
      await chat.save();
    }
    return { inviteCode: chat.inviteCode };
  }

  /** What someone sees when they open an invite link, before joining. */
  async previewInvite(inviteCode: string, userId: string) {
    const chat = await this.chatModel
      .findOne({
        inviteCode,
        isDeleted: false,
        type: { $in: [ChatType.GROUP, ChatType.CHANNEL] },
      })
      .select("_id type name image description isPublic link")
      .lean()
      .exec();
    if (!chat)
      throw new NotFoundException(
        "This invite link is invalid or has been reset",
      );
    const membership = await this.chatMembersModel
      .findOne({ channelId: String(chat._id), userId })
      .select("isBanned isJoined")
      .lean()
      .exec();
    if (membership?.isBanned)
      throw new ForbiddenException("You are banned from this chat");
    const memberCount = await this.chatMembersModel
      .countDocuments({
        channelId: String(chat._id),
        isBanned: { $ne: true },
        isJoined: { $ne: false },
      })
      .exec();
    return {
      ...chat,
      memberCount,
      isMember: !!membership && membership.isJoined !== false,
    };
  }

  async joinByInvite(inviteCode: string, userId: string) {
    const chat = await this.chatModel
      .findOne({
        inviteCode,
        isDeleted: false,
        type: { $in: [ChatType.GROUP, ChatType.CHANNEL] },
      })
      .select("_id")
      .lean()
      .exec();
    if (!chat)
      throw new NotFoundException(
        "This invite link is invalid or has been reset",
      );
    await this.subscribe(String(chat._id), userId, { viaInvite: true });
    return { channelId: String(chat._id) };
  }

  async subscribe(
    channelId: string,
    userId: string,
    opts: { viaInvite?: boolean } = {},
  ) {
    const chat = await this.chatModel
      .findOne({ _id: channelId, isDeleted: false })
      .select("type isPublic")
      .lean()
      .exec();
    if (!chat) throw new BadRequestException("Channel not found");
    // Direct chats and Saved Messages are never joinable by id — previously
    // anyone who knew a DM's id could add themselves to it.
    if (chat.type !== ChatType.GROUP && chat.type !== ChatType.CHANNEL) {
      throw new ForbiddenException("You can't join this chat");
    }
    const existing = await this.chatMembersModel.findOne({
      channelId,
      userId,
    });
    if (existing?.isBanned) {
      throw new ForbiddenException(
        "You are banned from this channel and cannot join",
      );
    }
    // Private groups/channels: members only get in through the invite link.
    if (
      !chat.isPublic &&
      !opts.viaInvite &&
      !(existing && existing.isJoined !== false)
    ) {
      throw new ForbiddenException(
        "This chat is private. Ask a member for its invite link.",
      );
    }
    if (existing) {
      if (existing.isJoined === false) {
        const result = await this.chatMembersModel.updateOne(
          { channelId, userId },
          { $set: { isJoined: true } },
        );
        this.eventEmitter.emit(MEMBERSHIP_CHANGED, { channelId });
        return result;
      }
      return existing;
    }
    const channel = new this.chatMembersModel({
      channelId,
      role: UserRole.MEMBER,
      userId,
    });
    await channel.save();
    this.eventEmitter.emit(MEMBERSHIP_CHANGED, { channelId });

    // Groups announce joins; channels don't (Telegram). The row is never written for a channel,
    // so no subscriber's client can ever receive it.
    if (chat.type === ChatType.GROUP) {
      await this.messageModel.create({
        channelId,
        senderId: new Types.ObjectId(userId),
        content: "member_joined",
        type: MessageType.SYSTEM,
        metadata: { senderName: await this.resolveDisplayName(userId) },
      });
    }

    return channel;
  }

  async unsubscribe(channelId: string, userId: string) {
    const membership = await this.chatMembersModel.findOne({
      channelId,
      userId,
    });
    if (!membership) {
      throw new BadRequestException("User not joined");
    }
    const chat = await this.chatModel.findById(channelId);
    if (chat?.type === ChatType.PRIVATE) {
      // B5: a single pointer write instead of bulk-writing `deletedFor` onto every
      // historical message in the chat (was O(channel history) per leave — see
      // docs/plans/BACKEND_PLAN.md and chat-members.schema.ts's `hiddenAt` doc comment).
      await this.chatMembersModel.updateOne(
        { channelId, userId },
        { $set: { isJoined: false, hiddenAt: new Date() } },
      );
    } else {
      if (membership.role === UserRole.OWNER) {
        // The owner leaving must not orphan the channel (B2 — role/admin recomputation,
        // docs/plans/BACKEND_PLAN.md): promote the next-longest-tenured admin (falling back to
        // the next-longest-tenured member) to owner before removing this membership. If no other
        // members remain there's no one to hand ownership to, so the channel is simply left
        // without an owner — same as if the last member of any role leaves.
        const successor =
          (await this.chatMembersModel
            .findOne({
              channelId,
              userId: { $ne: userId },
              role: UserRole.ADMIN,
              isBanned: { $ne: true },
            })
            .sort({ createdAt: 1 })
            .exec()) ??
          (await this.chatMembersModel
            .findOne({
              channelId,
              userId: { $ne: userId },
              role: UserRole.MEMBER,
              isBanned: { $ne: true },
            })
            .sort({ createdAt: 1 })
            .exec());
        if (successor) {
          successor.role = UserRole.OWNER;
          await successor.save();
        }
      }
      await this.chatMembersModel.deleteOne({ channelId, userId });
      const adminIds = await this.recomputeChatAdmins(channelId);
      this.chatGateway.notifyChannelRolesUpdated(channelId, adminIds);
    }
    this.eventEmitter.emit(MEMBERSHIP_CHANGED, { channelId });
    return true;
  }

  /**
   * Admin-add flow for groups/channels — there was previously no backend endpoint for this
   * at all; the frontend's "add members" step called `getOrCreateDirect` per selected user,
   * which creates DM chats instead of adding anyone to the group (see
   * docs/FEATURE_INVENTORY.md, docs/plans/BACKEND_PLAN.md B2 "[NEW — fixes the broken flow]").
   */
  async addMembers(
    channelId: string,
    memberUserIds: string[],
    requestingUserId: string,
  ): Promise<{ added: string[]; skipped: string[]; restricted: string[] }> {
    const chat = await this.chatModel
      .findOne({ _id: channelId, isDeleted: false })
      .lean()
      .exec();
    if (!chat) throw new NotFoundException("Channel not found");
    if (
      chat.type === ChatType.PRIVATE ||
      chat.type === ChatType.SAVED_MESSAGES
    ) {
      throw new BadRequestException(
        "Cannot add members to a direct chat or Saved Messages",
      );
    }

    const { perms } = await this.permissionsFor(channelId, requestingUserId);
    if (!perms.member.addMembers) {
      throw new ForbiddenException("You can't add members here");
    }

    const uniqueIds = Array.from(new Set(memberUserIds)).filter(id =>
      Types.ObjectId.isValid(id),
    );
    if (uniqueIds.length === 0) {
      return { added: [], skipped: [], restricted: [] };
    }
    // "Groups & channels" privacy (Telegram): applies to everyone adding, admins included.
    const view = await this.privacy.forViewer(requestingUserId, uniqueIds);

    const existingRows = await this.chatMembersModel
      .find({ channelId, userId: { $in: uniqueIds } })
      .lean()
      .exec();
    const existingByUserId = new Map(
      existingRows.map(m => [String(m.userId), m]),
    );

    const added: string[] = [];
    const skipped: string[] = [];
    const restricted: string[] = [];
    const toInsert: { channelId: string; userId: string; role: UserRole }[] =
      [];

    for (const userId of uniqueIds) {
      const row = existingByUserId.get(userId);
      if (row?.isBanned || row?.isJoined) {
        skipped.push(userId);
        continue;
      }
      if (!view.can(userId, "groupInvites")) {
        restricted.push(userId);
        continue;
      }
      if (row) {
        // Previously left (isJoined: false, not banned) — reactivate instead of a new row.
        await this.chatMembersModel.updateOne(
          { channelId, userId },
          { $set: { isJoined: true } },
        );
      } else {
        toInsert.push({ channelId, userId, role: UserRole.MEMBER });
      }
      added.push(userId);
    }

    if (toInsert.length > 0) {
      await this.chatMembersModel.insertMany(toInsert);
    }

    if (added.length > 0) {
      this.eventEmitter.emit(MEMBERSHIP_CHANGED, { channelId });
      // Same as joins: announced in groups only, never in channels.
      if (chat.type === ChatType.GROUP) {
        await this.messageModel.create({
          channelId,
          senderId: new Types.ObjectId(requestingUserId),
          content: "members_added",
          type: MessageType.SYSTEM,
          metadata: {
            addedUserIds: added,
            senderName: await this.resolveDisplayName(requestingUserId),
          },
        });
      }
      for (const userId of added) {
        try {
          await this.chatGateway.notifyNewChat(userId, chat);
        } catch {
          // Best-effort — the member is still added even if the realtime nudge fails.
        }
      }
    }

    return { added, skipped, restricted };
  }

  async findUserJoinedChatsWithDisplay(userId: string): Promise<
    (Chat & {
      displayName: string;
      isPinned: boolean;
      isMuted: boolean;
      lastReadMessageId?: string;
      myRole?: string;
      /** Private chats only — public fields for the other user (same shape as user profile) */
      avatarUrl?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      bio?: string;
      userId?: string;
      membersCount?: number;
      lastMessageAt?: string;
    })[]
  > {
    // Ensure the user always has a Saved Messages chat created & joined
    await this.findOrCreateSavedMessages(userId);

    const memberships = await this.chatMembersModel
      .find({ userId, isBanned: { $ne: true }, isJoined: true })
      .exec();
    const channelIds = memberships
      .map(m => m.channelId)
      .filter(Boolean)
      .map(id => new Types.ObjectId(id));
    const chats = await this.chatModel
      .find({ _id: { $in: channelIds }, isDeleted: false })
      .exec();
    const membershipMap = new Map(memberships.map(m => [m.channelId, m]));

    const [lastMessageAgg, membersCountAgg] = await Promise.all([
      this.messageModel
        .aggregate<{
          _id: string;
          lastMessageAt: Date;
        }>([
          {
            $match: {
              channelId: { $in: channelIds.map(id => id.toString()) },
              isDeleted: { $ne: true },
            },
          },
          {
            $group: {
              _id: "$channelId",
              lastMessageAt: { $max: "$createdAt" },
            },
          },
        ])
        .exec(),
      this.chatMembersModel
        .aggregate<{
          _id: string;
          count: number;
        }>([
          {
            $match: { channelId: { $in: channelIds.map(id => id.toString()) } },
          },
          { $group: { _id: "$channelId", count: { $sum: 1 } } },
        ])
        .exec(),
    ]);
    const lastMessageAtMap = new Map(
      lastMessageAgg.map(r => [
        r._id,
        r.lastMessageAt?.toISOString?.() ??
          new Date(r.lastMessageAt).toISOString(),
      ]),
    );
    const membersCountMap = new Map(membersCountAgg.map(r => [r._id, r.count]));

    const result: (Chat & {
      displayName: string;
      isPinned: boolean;
      isMuted: boolean;
      mutedByAdmin?: boolean;
      lastReadMessageId?: string;
      myRole?: string;
      avatarUrl?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      bio?: string;
      userId?: string;
    })[] = [];
    for (const chat of chats) {
      const doc = chat as unknown as Chat & {
        _id: Types.ObjectId;
        type: ChatType;
        toObject?: () => Record<string, unknown>;
      };
      const channelId = doc._id.toString();
      const plain =
        typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
      const membership = membershipMap.get(channelId);

      let displayName =
        doc.type !== ChatType.PRIVATE
          ? (doc as unknown as { name: string }).name
          : "";
      let avatarUrl: string | undefined;
      let username: string | undefined;
      let firstName: string | undefined;
      let lastName: string | undefined;
      let bio: string | undefined;
      let otherUserId: string | undefined;

      if (doc.type === ChatType.PRIVATE) {
        const members = await this.chatMembersModel.find({ channelId }).exec();
        const other = members.find(m => m.userId !== userId);
        if (other) {
          const [otherUser, view] = await Promise.all([
            this.userModel
              .findById(other.userId)
              .select("username firstName lastName image bio")
              .lean()
              .exec(),
            this.privacy.forViewer(userId, [other.userId]),
          ]);
          if (otherUser) {
            const visible = view.publicUser(otherUser);
            const u = otherUser as {
              username?: string;
              firstName?: string;
              lastName?: string;
              image?: string[];
              bio?: string;
            };
            const nameFamily = [u.firstName, u.lastName]
              .filter(Boolean)
              .join(" ")
              .trim();
            displayName =
              (nameFamily || u.username) ??
              (plain as unknown as { name: string }).name ??
              "";
            avatarUrl = visible.avatarUrl[0];
            username = u.username;
            firstName = u.firstName;
            lastName = u.lastName;
            bio = visible.bio;
            otherUserId = other.userId;
          }
        }
        if (!displayName)
          displayName = (plain as unknown as { name: string }).name ?? "";
      }

      const membersCount =
        doc.type !== ChatType.PRIVATE
          ? membersCountMap.get(channelId)
          : undefined;
      const lastMessageAt = lastMessageAtMap.get(channelId);

      result.push({
        ...plain,
        displayName,
        isPinned: membership?.isPinned ?? false,
        isMuted: membership?.isMuted ?? false,
        mutedByAdmin:
          (membership as { mutedByAdmin?: boolean })?.mutedByAdmin ?? false,
        lastReadMessageId: membership?.lastReadMessageId ?? undefined,
        myRole: membership?.role,
        avatarUrl,
        username,
        firstName,
        lastName,
        bio,
        userId: otherUserId,
        membersCount,
        lastMessageAt,
      } as Chat & {
        displayName: string;
        isPinned: boolean;
        isMuted: boolean;
        mutedByAdmin?: boolean;
        lastReadMessageId?: string;
        myRole?: string;
        avatarUrl?: string;
        username?: string;
        firstName?: string;
        lastName?: string;
        bio?: string;
        userId?: string;
        membersCount?: number;
        lastMessageAt?: string;
      });
    }
    // Sort: pinned first, then by last message time descending (newest first)
    result.sort((a, b) => {
      if (a.isPinned !== b.isPinned)
        return (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0);
      const tA = (a as { lastMessageAt?: string }).lastMessageAt
        ? new Date((a as { lastMessageAt?: string }).lastMessageAt!).getTime()
        : 0;
      const tB = (b as { lastMessageAt?: string }).lastMessageAt
        ? new Date((b as { lastMessageAt?: string }).lastMessageAt!).getTime()
        : 0;
      return tB - tA;
    });
    return result;
  }

  async setPinned(channelId: string, userId: string, isPinned: boolean) {
    const membership = await this.chatMembersModel.findOne({
      channelId,
      userId,
    });
    if (!membership) throw new BadRequestException("Access denied");
    if (isPinned && !membership.isPinned) {
      // A newly pinned chat goes to the top of the pinned group (Telegram).
      const top = await this.chatMembersModel
        .findOne({ userId, isPinned: true, pinOrder: { $ne: null } })
        .sort({ pinOrder: 1 })
        .select("pinOrder")
        .lean()
        .exec();
      membership.pinOrder = Math.min(top?.pinOrder ?? 0, 0) - 1;
    }
    if (!isPinned) membership.pinOrder = null;
    membership.isPinned = isPinned;
    return membership.save();
  }

  /**
   * Clear history for me (Telegram's "Clear history"): hides everything sent
   * so far from this member only, by moving their `hiddenAt` pointer to now —
   * the same mechanism leaving a DM uses, minus the leaving. Others keep it all.
   */
  async clearHistory(channelId: string, userId: string) {
    const res = await this.chatMembersModel.updateOne(
      { channelId, userId, isBanned: { $ne: true } },
      { $set: { hiddenAt: new Date() } },
    );
    if (!res.matchedCount) throw new BadRequestException("Access denied");
    return { success: true };
  }

  /**
   * Groups both people are in ("Groups in common" on a profile). Only
   * groups — not channels, DMs or Saved Messages — and only ones the caller
   * is still a joined, unbanned member of.
   */
  async commonGroups(userId: string, otherUserId: string) {
    if (userId === otherUserId) return [];
    const mine = await this.chatMembersModel
      .find({ userId, isBanned: { $ne: true }, isJoined: { $ne: false } })
      .select("channelId")
      .lean()
      .exec();
    if (!mine.length) return [];
    const shared = await this.chatMembersModel
      .find({
        userId: otherUserId,
        channelId: { $in: mine.map(m => m.channelId) },
        isBanned: { $ne: true },
        isJoined: { $ne: false },
      })
      .select("channelId")
      .lean()
      .exec();
    if (!shared.length) return [];
    const groups = await this.chatModel
      .find({
        _id: { $in: shared.map(m => m.channelId) },
        type: ChatType.GROUP,
        isDeleted: false,
      })
      .select("_id name image type isPublic link")
      .lean()
      .exec();
    const counts = await this.chatMembersModel
      .aggregate<{ _id: string; n: number }>([
        {
          $match: {
            channelId: { $in: groups.map(g => String(g._id)) },
            isBanned: { $ne: true },
            isJoined: { $ne: false },
          },
        },
        { $group: { _id: "$channelId", n: { $sum: 1 } } },
      ])
      .exec();
    const countOf = new Map(counts.map(c => [String(c._id), c.n]));
    return groups
      .map(g => ({ ...g, memberCount: countOf.get(String(g._id)) ?? 0 }))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  }

  async setMuted(channelId: string, userId: string, isMuted: boolean) {
    const membership = await this.chatMembersModel.findOne({
      channelId,
      userId,
    });
    if (!membership) throw new BadRequestException("Access denied");
    membership.isMuted = isMuted;
    return membership.save();
  }

  /** Mute/unmute a user in a group (admin-only). Muted users cannot send messages. */
  async setMutedByAdmin(
    channelId: string,
    targetUserId: string,
    requestingUserId: string,
    isMuted: boolean,
  ) {
    const chat = await this.chatModel
      .findOne({ _id: channelId, isDeleted: false })
      .select("type")
      .lean()
      .exec();
    if (!chat) throw new NotFoundException("Chat not found");
    if (chat.type !== ChatType.GROUP) {
      throw new BadRequestException(
        "Muting members is only supported in groups",
      );
    }
    const requesterMembership = await this.chatMembersModel.findOne({
      channelId,
      userId: requestingUserId,
    });
    const { perms: mutePerms } = await this.permissionsFor(
      channelId,
      requestingUserId,
    );
    if (!requesterMembership || !mutePerms.admin.banUsers) {
      throw new ForbiddenException("You can't restrict members here");
    }
    if (
      !Types.ObjectId.isValid(targetUserId) ||
      targetUserId === requestingUserId
    ) {
      throw new BadRequestException("Invalid target user");
    }
    const targetMembership = await this.chatMembersModel.findOne({
      channelId,
      userId: targetUserId,
    });
    if (!targetMembership) {
      throw new NotFoundException("User is not a member of this group");
    }
    if (targetMembership.role === UserRole.OWNER) {
      throw new BadRequestException("Cannot mute the group owner");
    }
    if (
      targetMembership.role === UserRole.ADMIN &&
      requesterMembership.role !== UserRole.OWNER
    ) {
      throw new BadRequestException("Only the owner can mute admins");
    }
    targetMembership.mutedByAdmin = isMuted;
    // The send right is the source of truth now; keep it in step.
    const exceptions = { ...(targetMembership.permissions ?? {}) };
    if (isMuted) exceptions.sendMessages = false;
    else delete exceptions.sendMessages;
    targetMembership.permissions = Object.keys(exceptions).length
      ? exceptions
      : null;
    targetMembership.markModified("permissions");
    await targetMembership.save();
    this.chatGateway.notifyUserMuted(channelId, targetUserId, isMuted);
    return targetMembership;
  }

  async setBanned(
    channelId: string,
    targetUserId: string,
    requestingUserId: string,
    isBanned: boolean,
  ) {
    const chat = await this.chatModel.findOne({ _id: channelId }).exec();
    if (!chat) throw new BadRequestException("Channel not found");
    if (chat.type === ChatType.PRIVATE) {
      throw new BadRequestException("Cannot ban in private chats");
    }
    // Check requester is admin/owner
    const requesterMembership = await this.chatMembersModel.findOne({
      channelId,
      userId: requestingUserId,
    });
    const { perms: banPerms } = await this.permissionsFor(
      channelId,
      requestingUserId,
    );
    if (!requesterMembership || !banPerms.admin.banUsers) {
      throw new ForbiddenException("You can't ban people here");
    }
    if (!Types.ObjectId.isValid(targetUserId)) {
      throw new BadRequestException("Invalid user ID");
    }
    if (isBanned) {
      // Admins can't ban the owner, and only the owner can ban an admin.
      const target = await this.chatMembersModel
        .findOne({ channelId, userId: targetUserId })
        .select("role")
        .lean()
        .exec();
      if (target?.role === UserRole.OWNER)
        throw new ForbiddenException("The owner can't be banned");
      if (
        target?.role === UserRole.ADMIN &&
        requesterMembership.role !== UserRole.OWNER
      ) {
        throw new ForbiddenException("Only the owner can ban an admin");
      }
    }

    // `chatmembers.isBanned` is the only ban store (B2 — drops the old `chat.banned[]`
    // O(n) scan). The row is kept (not deleted) so re-checking membership after a ban
    // doesn't require a second collection; `subscribe()` already knows how to reactivate
    // an `isJoined: false` row, so unbanning leaves the user free to rejoin.
    await this.chatMembersModel.updateOne(
      { channelId, userId: targetUserId },
      {
        // Ban or unban, the user is not currently joined either way — banning revokes
        // membership, and unbanning only lifts the block (they must rejoin explicitly).
        $set: { isBanned, isJoined: false },
        $setOnInsert: { role: UserRole.MEMBER },
      },
      { upsert: true },
    );
    this.eventEmitter.emit(MEMBERSHIP_CHANGED, { channelId });

    if (isBanned) {
      // Notify banned user via websocket so their client can close the chat
      this.chatGateway.notifyChatBanned(channelId, targetUserId);
    }
  }

  /** List banned users for a channel/group (admin/owner only). */
  async getBannedList(
    channelId: string,
    requestingUserId: string,
  ): Promise<{ users: PublicUserDto[] }> {
    const chat = await this.chatModel
      .findOne({ _id: channelId, isDeleted: false })
      .select("type")
      .lean()
      .exec();
    if (!chat) throw new NotFoundException("Channel not found");
    if (chat.type === ChatType.PRIVATE) {
      return { users: [] };
    }
    const requesterMembership = await this.chatMembersModel.findOne({
      channelId,
      userId: requestingUserId,
    });
    const { perms: listPerms } = await this.permissionsFor(
      channelId,
      requestingUserId,
    );
    if (!requesterMembership || !listPerms.admin.banUsers) {
      throw new ForbiddenException("Only admins can view the ban list");
    }
    const bannedMemberships = await this.chatMembersModel
      .find({ channelId, isBanned: true })
      .select("userId")
      .lean()
      .exec();
    if (bannedMemberships.length === 0) {
      return { users: [] };
    }
    const objectIds = bannedMemberships
      .map(m => String(m.userId))
      .filter(id => Types.ObjectId.isValid(id))
      .map(id => new Types.ObjectId(id));
    const users = await this.userModel
      .find({ _id: { $in: objectIds } })
      .select("username firstName lastName image avatarVideo bio")
      .lean()
      .exec();
    const view = await this.privacy.forViewer(
      requestingUserId,
      users.map(u => u._id),
    );
    return { users: users.map(u => view.publicUser(u)) };
  }

  /** List chat participants (basic user info) for mention autocomplete. Any member can call. */
  async getParticipants(
    channelId: string,
    requestingUserId: string,
  ): Promise<(PublicUserDto & { userId: string; role?: UserRole })[]> {
    const membership = await this.chatMembersModel.findOne({
      channelId,
      userId: requestingUserId,
    });
    if (!membership) throw new ForbiddenException("Access denied");

    const chat = await this.chatModel
      .findOne({ _id: channelId, isDeleted: false })
      .select("type")
      .lean()
      .exec();
    if (!chat) throw new NotFoundException("Chat not found");

    // `isBanned` is on the same membership rows we already need to fetch — no second
    // query against `chat.banned[]` (removed in B2).
    const members = await this.chatMembersModel
      .find({ channelId, isBanned: { $ne: true } })
      .lean()
      .exec();

    const objectIds = members
      .map(m => m.userId)
      .filter(id => Types.ObjectId.isValid(id))
      .map(id => new Types.ObjectId(id));
    const users = await this.userModel
      .find({ _id: { $in: objectIds } })
      .select("username firstName lastName image avatarVideo bio")
      .lean()
      .exec();
    const userMap = new Map(
      users.map(u => [String((u as { _id: unknown })._id), u]),
    );
    const view = await this.privacy.forViewer(
      requestingUserId,
      users.map(u => u._id),
    );

    return members
      .filter(m => userMap.has(m.userId))
      .map(m => ({
        ...view.publicUser(userMap.get(m.userId)!),
        userId: m.userId,
        role: m.role,
      }));
  }

  /** List chat members (with basic user info) for admin/owner management. */
  async getMembersForManagement(
    channelId: string,
    requestingUserId: string,
  ): Promise<
    (PublicUserDto & {
      userId: string;
      role: UserRole;
      isBanned: boolean;
      mutedByAdmin: boolean;
      adminRights: AdminRights | null;
      permissions: Partial<MemberPermissions> | null;
      promotedBy: string | null;
    })[]
  > {
    const chat = await this.chatModel
      .findOne({ _id: channelId, isDeleted: false })
      .select("type")
      .lean()
      .exec();
    if (!chat) throw new NotFoundException("Chat not found");
    if (chat.type === ChatType.PRIVATE) {
      throw new BadRequestException("Not supported for private chats");
    }
    const requesterMembership = await this.chatMembersModel.findOne({
      channelId,
      userId: requestingUserId,
    });
    if (!requesterMembership) {
      throw new ForbiddenException("You are not a member here");
    }

    const members = await this.chatMembersModel
      .find({ channelId })
      .lean()
      .exec();
    const userIds = members.map(m => m.userId).filter(Boolean);
    const objectIds = userIds
      .filter(id => Types.ObjectId.isValid(id))
      .map(id => new Types.ObjectId(id));
    const users = await this.userModel
      .find({ _id: { $in: objectIds } })
      .select("username firstName lastName image avatarVideo bio")
      .lean()
      .exec();
    const userMap = new Map(
      users.map(u => [String((u as { _id: unknown })._id), u]),
    );
    const view = await this.privacy.forViewer(
      requestingUserId,
      users.map(u => u._id),
    );

    return members
      .filter(m => userMap.has(m.userId))
      .map(m => ({
        ...view.publicUser(userMap.get(m.userId)!),
        userId: m.userId,
        role: (m.role != null ? String(m.role) : UserRole.MEMBER) as UserRole,
        isBanned: (m as { isBanned?: boolean }).isBanned === true,
        mutedByAdmin: (m as { mutedByAdmin?: boolean }).mutedByAdmin === true,
        adminRights:
          m.role === UserRole.ADMIN
            ? adminRightsOf(m.adminRights)
            : m.role === UserRole.OWNER
              ? adminRightsOf(
                  Object.fromEntries(ADMIN_RIGHT_KEYS.map(k => [k, true])),
                )
              : null,
        permissions: m.permissions
          ? pickRights(MEMBER_PERMISSION_KEYS, m.permissions)
          : null,
        promotedBy: m.promotedBy ?? null,
      }));
  }

  async setTags(channelId: string, tags: string[], userId: string) {
    const membership = await this.chatMembersModel.findOne({
      channelId,
      userId,
    });
    if (!membership) throw new BadRequestException("Access denied");
    // B6 (docs/plans/BACKEND_PLAN.md): tags now feed folders, so only admins/owners can set
    // them — was any member, letting anyone silently move a chat in/out of someone else's folders.
    if (
      membership.role !== UserRole.ADMIN &&
      membership.role !== UserRole.OWNER
    ) {
      throw new ForbiddenException("Only admins and owners can set tags");
    }
    return this.chatModel
      .findByIdAndUpdate(channelId, { $set: { tags } }, { new: true })
      .exec();
  }

  /** Get or create a private chat between current user and another user. Returns existing chat if one exists. */
  async findOrCreatePrivateChat(currentUserId: string, otherUserId: string) {
    const link = privateChatLink(currentUserId, otherUserId);
    const chat = await this.chatModel
      .findOne({
        link,
        type: ChatType.PRIVATE,
        isDeleted: false,
      })
      .lean()
      .exec();
    if (chat) {
      const channelId = String((chat as { _id: unknown })._id);
      const currentJoined = await this.chatMembersModel.findOne({
        channelId,
        userId: currentUserId,
      });
      if (!currentJoined) {
        await this.chatMembersModel.create({
          channelId,
          userId: currentUserId,
          role: UserRole.MEMBER,
        });
      }
      return chat as unknown as Chat & { _id: string };
    }
    const createChatDto: CreateChatDto = {
      name: "Private",
      link,
      type: ChatType.PRIVATE,
      members: [otherUserId],
    };
    const created = await this.create(createChatDto, currentUserId);
    return (
      (created as { toObject?: () => Record<string, unknown> }).toObject?.() ??
      created
    );
  }

  async findOrCreateSavedMessages(userId: string) {
    const link = `${SAVED_MESSAGES_LINK_PREFIX}${userId}`;
    const chat = await this.chatModel.findOne({
      link,
      isDeleted: false,
    });
    if (chat) {
      const isMember = await this.chatMembersModel.findOne({
        channelId: chat._id.toString(),
        userId,
      });
      if (isMember) return chat;
      await this.chatMembersModel.create({
        channelId: chat._id.toString(),
        userId,
        role: UserRole.OWNER,
      });
      return chat;
    }
    const createChatDto: CreateChatDto = {
      name: "Saved Messages",
      link,
      type: ChatType.SAVED_MESSAGES,
    };
    return this.create(createChatDto, userId);
  }

  async findChat(keyword?: string, limit = 10, offset = 0) {
    const baseFilter = {
      isDeleted: false,
      // Public search must never surface a private 1:1 chat (its `link` embeds both
      // members' user ids — matchable if a caller guesses/knows a userId) or Saved Messages.
      type: { $in: [ChatType.GROUP, ChatType.CHANNEL] },
      // Private groups/channels are reachable by invite link only.
      isPublic: true,
      link: { $not: new RegExp(`^${SAVED_MESSAGES_LINK_PREFIX}`) },
    };
    const filter = keyword
      ? {
          ...baseFilter,
          $or: [
            { name: { $regex: escapeRegex(keyword), $options: "i" } },
            { link: { $regex: escapeRegex(keyword), $options: "i" } },
          ],
        }
      : baseFilter;

    const results = await this.chatModel
      .find(filter)
      .select("-inviteCode")
      .limit(limit)
      .skip(offset)
      .exec();

    return results;
  }

  async findChatByLink(link: string) {
    // Only public groups/channels resolve by @link — a DM's link embeds both
    // members' ids, and private chats are reachable by invite only.
    const channel = await this.chatModel.findOne({
      link,
      isDeleted: false,
      isPublic: true,
      type: { $in: [ChatType.GROUP, ChatType.CHANNEL] },
    });
    if (!channel) {
      throw new BadRequestException("Channel not found");
    }
    return channel;
  }

  /** Chat details for someone who may not be a member yet. Public groups and
   *  channels are open to anyone (not banned); private ones, direct chats and
   *  Saved Messages only to members. (This used to *join* the caller to any
   *  private chat it was asked about.) */
  async findChatByIdForPreview(channelId: string, currentUserId: string) {
    if (!Types.ObjectId.isValid(channelId))
      throw new NotFoundException("Chat not found");
    const chat = await this.chatModel
      .findOne({ _id: channelId, isDeleted: false })
      .select(
        "_id type name image link description isPublic signature defaultPermissions",
      )
      .lean()
      .exec();
    if (!chat) throw new NotFoundException("Chat not found");
    const membership = await this.chatMembersModel
      .findOne({ channelId, userId: currentUserId })
      .select("isBanned isJoined role adminRights permissions mutedByAdmin")
      .lean()
      .exec();
    const isMember =
      !!membership && membership.isJoined !== false && !membership.isBanned;
    if (membership?.isBanned)
      throw new ForbiddenException("You are banned from this channel");
    const openToAll =
      (chat.type === ChatType.GROUP || chat.type === ChatType.CHANNEL) &&
      chat.isPublic;
    if (!isMember && !openToAll) throw new NotFoundException("Chat not found");
    const memberCount = await this.chatMembersModel
      .countDocuments({
        channelId,
        isBanned: { $ne: true },
        isJoined: { $ne: false },
      })
      .exec();
    const myPermissions = effectivePermissions(
      chat,
      isMember ? membership : null,
    );
    const { defaultPermissions: _defaults, ...publicChat } = chat;
    return {
      ...publicChat,
      memberCount,
      membersCount: memberCount,
      isMember,
      myRole: isMember ? membership.role : null,
      myPermissions,
    };
  }

  /** For private chats returns the other member's username; for channel/group returns chat name. */
  async getChatDisplayName(
    channelId: string,
    currentUserId: string,
  ): Promise<string> {
    const chat = await this.chatModel.findOne({
      _id: channelId,
      isDeleted: false,
    });
    if (!chat) throw new NotFoundException("Chat not found");
    if (chat.type !== ChatType.PRIVATE) return chat.name;
    const members = await this.chatMembersModel.find({ channelId }).exec();
    const other = members.find(m => m.userId !== currentUserId);
    if (!other) return chat.name;
    const user = await this.userModel
      .findById(other.userId)
      .select("username firstName lastName")
      .lean()
      .exec();
    if (!user) return chat.name;
    const u = user as {
      username?: string;
      firstName?: string;
      lastName?: string;
    };
    const nameFamily = [u.firstName, u.lastName]
      .filter(Boolean)
      .join(" ")
      .trim();
    return (nameFamily || u.username) ?? chat.name;
  }

  async delete(channelId: string, user_id: string) {
    const channel = await this.chatModel.findOne({
      _id: new Types.ObjectId(channelId),
      isDeleted: false,
    });
    if (!channel) {
      throw new BadRequestException("Channel not found");
    }
    if (
      channel.type === ChatType.PRIVATE ||
      channel.type === ChatType.SAVED_MESSAGES
    ) {
      // Previously skipped entirely: anyone could delete any DM by id.
      const member = await this.chatMembersModel
        .exists({ channelId, userId: user_id })
        .exec();
      if (!member)
        throw new ForbiddenException("You are not allowed to delete this chat");
    } else {
      const owner = await this.chatMembersModel.findOne({
        channelId,
        role: UserRole.OWNER,
      });
      if (!owner || String(owner.userId) !== String(user_id)) {
        throw new BadRequestException(
          "You are not allowed to delete this channel",
        );
      }
    }
    // Tell everyone before the member rows (and so the room's audience) go away.
    const memberIds = (
      await this.chatMembersModel
        .find({ channelId })
        .select("userId")
        .lean()
        .exec()
    ).map(m => String(m.userId));
    await this.chatModel
      .updateOne({ _id: channelId }, { $set: { isDeleted: true } })
      .exec();
    await this.chatMembersModel.deleteMany({ channelId });
    for (const userId of memberIds)
      this.chatGateway.emitToUser(userId, "chat_deleted", { channelId });
    await this.messageModel
      .updateMany({ channelId }, { $set: { isPinned: false, isDeleted: true } })
      .exec();
    return true;
  }
}
