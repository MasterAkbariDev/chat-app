import { ForbiddenException } from "@nestjs/common";
import { ChatType, MessageType, UserRole } from "src/enum/base.enum";

/**
 * Telegram-style rights for groups and channels.
 *
 * - **Admin rights** are per admin, chosen by whoever promotes them (the owner, or an admin
 *   with `addAdmins` — who can only hand out rights they hold themselves).
 * - **Member permissions** are a chat-wide default (`Chat.defaultPermissions`, groups only),
 *   plus optional per-person exceptions (`ChatMembers.permissions`) that override any key —
 *   so a specific member can be allowed more, or less, than everyone else.
 * - The owner can do everything. Direct chats and Saved Messages have no rights model.
 */

export const ADMIN_RIGHT_KEYS = [
  "changeInfo",
  "deleteMessages",
  "banUsers",
  "inviteUsers",
  "pinMessages",
  "addAdmins",
  /** Channels: post. */
  "postMessages",
  /** Channels: edit other people's posts. */
  "editMessages",
] as const;
export type AdminRightKey = (typeof ADMIN_RIGHT_KEYS)[number];
export type AdminRights = Record<AdminRightKey, boolean>;

export const MEMBER_PERMISSION_KEYS = [
  "sendMessages",
  /** Photos, videos and files. */
  "sendMedia",
  /** Stickers and GIFs. */
  "sendStickers",
  /** Voice and round video messages. */
  "sendVoice",
  "addMembers",
  "pinMessages",
  "changeInfo",
] as const;
export type MemberPermissionKey = (typeof MEMBER_PERMISSION_KEYS)[number];
export type MemberPermissions = Record<MemberPermissionKey, boolean>;

/** What a newly promoted admin gets unless told otherwise (Telegram's default too:
 *  everything except appointing other admins). */
export const DEFAULT_ADMIN_RIGHTS: AdminRights = {
  changeInfo: true,
  deleteMessages: true,
  banUsers: true,
  inviteUsers: true,
  pinMessages: true,
  addAdmins: false,
  postMessages: true,
  editMessages: true,
};

export const DEFAULT_MEMBER_PERMISSIONS: MemberPermissions = {
  sendMessages: true,
  sendMedia: true,
  sendStickers: true,
  sendVoice: true,
  addMembers: true,
  pinMessages: false,
  changeInfo: false,
};

const ALL_ADMIN_RIGHTS = Object.fromEntries(
  ADMIN_RIGHT_KEYS.map(k => [k, true]),
) as AdminRights;
const NO_ADMIN_RIGHTS = Object.fromEntries(
  ADMIN_RIGHT_KEYS.map(k => [k, false]),
) as AdminRights;
const ALL_MEMBER_PERMISSIONS = Object.fromEntries(
  MEMBER_PERMISSION_KEYS.map(k => [k, true]),
) as MemberPermissions;
const NO_MEMBER_PERMISSIONS = Object.fromEntries(
  MEMBER_PERMISSION_KEYS.map(k => [k, false]),
) as MemberPermissions;

/** Keeps only known boolean keys (stored docs and request bodies may carry anything). */
export function pickRights<K extends string>(
  keys: readonly K[],
  value: unknown,
): Partial<Record<K, boolean>> {
  const out: Partial<Record<K, boolean>> = {};
  if (!value || typeof value !== "object") return out;
  for (const k of keys) {
    const v = (value as Record<string, unknown>)[k];
    if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

export function adminRightsOf(stored: unknown): AdminRights {
  return { ...DEFAULT_ADMIN_RIGHTS, ...pickRights(ADMIN_RIGHT_KEYS, stored) };
}

export function defaultPermissionsOf(stored: unknown): MemberPermissions {
  return {
    ...DEFAULT_MEMBER_PERMISSIONS,
    ...pickRights(MEMBER_PERMISSION_KEYS, stored),
  };
}

/** Everything a client needs to show or hide actions. */
export interface EffectivePermissions {
  role: UserRole | null;
  /** Member-level actions (always true for owner/admins in groups). */
  member: MemberPermissions;
  /** Admin rights (all false for plain members). */
  admin: AdminRights;
  /** Convenience: can write anything at all here. */
  canPost: boolean;
  canDeleteChat: boolean;
}

interface MembershipLike {
  role?: UserRole | string | null;
  adminRights?: unknown;
  permissions?: unknown;
  mutedByAdmin?: boolean;
  isBanned?: boolean;
  isJoined?: boolean;
}

interface ChatLike {
  type: ChatType | `${ChatType}`;
  defaultPermissions?: unknown;
}

export function effectivePermissions(
  chat: ChatLike,
  membership: MembershipLike | null | undefined,
): EffectivePermissions {
  const active =
    !!membership && !membership.isBanned && membership.isJoined !== false;
  const role = active
    ? ((membership.role as UserRole) ?? UserRole.MEMBER)
    : null;

  // Direct chats / Saved Messages: both people can do everything that applies.
  if (chat.type === ChatType.PRIVATE || chat.type === ChatType.SAVED_MESSAGES) {
    return {
      role,
      member: active ? ALL_MEMBER_PERMISSIONS : NO_MEMBER_PERMISSIONS,
      admin: NO_ADMIN_RIGHTS,
      canPost: active,
      canDeleteChat: active,
    };
  }
  if (!active) {
    return {
      role: null,
      member: NO_MEMBER_PERMISSIONS,
      admin: NO_ADMIN_RIGHTS,
      canPost: false,
      canDeleteChat: false,
    };
  }
  if (role === UserRole.OWNER) {
    return {
      role,
      member: ALL_MEMBER_PERMISSIONS,
      admin: ALL_ADMIN_RIGHTS,
      canPost: true,
      canDeleteChat: true,
    };
  }
  const isChannel = chat.type === ChatType.CHANNEL;
  if (role === UserRole.ADMIN) {
    const admin = adminRightsOf(membership.adminRights);
    const canPost = isChannel ? admin.postMessages : true;
    return {
      role,
      member: {
        ...ALL_MEMBER_PERMISSIONS,
        sendMessages: canPost,
        sendMedia: canPost,
        sendStickers: canPost,
        sendVoice: canPost,
        addMembers: admin.inviteUsers,
        pinMessages: admin.pinMessages,
        changeInfo: admin.changeInfo,
      },
      admin,
      canPost,
      canDeleteChat: false,
    };
  }
  // Plain member.
  if (isChannel) {
    return {
      role,
      member: NO_MEMBER_PERMISSIONS,
      admin: NO_ADMIN_RIGHTS,
      canPost: false,
      canDeleteChat: false,
    };
  }
  const member: MemberPermissions = {
    ...defaultPermissionsOf(chat.defaultPermissions),
    ...pickRights(MEMBER_PERMISSION_KEYS, membership.permissions),
  };
  // Legacy "muted by an admin" flag: still honoured.
  if (membership.mutedByAdmin) member.sendMessages = false;
  // Nothing can be sent without the base right.
  if (!member.sendMessages) {
    member.sendMedia = false;
    member.sendStickers = false;
    member.sendVoice = false;
  }
  return {
    role,
    member,
    admin: NO_ADMIN_RIGHTS,
    canPost: member.sendMessages,
    canDeleteChat: false,
  };
}

/** Which member permission a message of this type needs (null = none beyond membership). */
export function permissionForMessageType(
  type: string | undefined,
): MemberPermissionKey | null {
  switch (type) {
    case MessageType.IMAGE:
    case MessageType.VIDEO:
    case MessageType.FILE:
    case MessageType.AUDIO:
      return "sendMedia";
    case MessageType.STICKER:
    case MessageType.GIF:
      return "sendStickers";
    case MessageType.VOICE:
    case MessageType.VIDEO_NOTE:
      return "sendVoice";
    case MessageType.SYSTEM:
    case MessageType.VOICE_CALL:
      return null;
    default:
      return "sendMessages";
  }
}

const SEND_MESSAGES: Record<MemberPermissionKey, string> = {
  sendMessages: "You can't send messages here",
  sendMedia: "You can't send photos, videos or files here",
  sendStickers: "You can't send stickers or GIFs here",
  sendVoice: "You can't send voice or video messages here",
  addMembers: "You can't add members here",
  pinMessages: "You can't pin messages here",
  changeInfo: "You can't change this chat's info",
};

export function assertMemberPermission(
  perms: EffectivePermissions,
  key: MemberPermissionKey,
): void {
  if (
    perms.member.sendMessages === false &&
    key.startsWith("send") &&
    perms.role === UserRole.MEMBER
  ) {
    throw new ForbiddenException(
      key === "sendMessages"
        ? "You are muted in this group. You cannot send messages."
        : SEND_MESSAGES[key],
    );
  }
  if (!perms.member[key]) throw new ForbiddenException(SEND_MESSAGES[key]);
}

export function assertAdminRight(
  perms: EffectivePermissions,
  key: AdminRightKey,
  message: string,
): void {
  if (!perms.admin[key]) throw new ForbiddenException(message);
}
