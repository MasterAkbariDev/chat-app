import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { FilterQuery, Model, Types } from "mongoose";
import { User } from "src/user/schema/user.schema";
import { Session } from "src/auth/schema/session.schema";
import { Chat } from "src/chat/schema/chat.schema";
import { ChatMembers } from "src/chat/schema/chat-members.schema";
import { Report, ReportTargetType } from "src/moderation/schema/report.schema";
import { Message } from "src/message/schema/message.schema";
import { ModerationLogService } from "src/moderation/moderation-log.service";
import { AdminAuditService, AuditEntry } from "./admin-audit.service";
import { escapeRegex } from "./admin-query.util";
import {
  maskEmail,
  maskIp,
  maskPhone,
  shouldRedact,
} from "./admin-privacy.util";

export type AdminUserStatus = "active" | "suspended" | "deleted";
export const ADMIN_USER_STATUSES: AdminUserStatus[] = [
  "active",
  "suspended",
  "deleted",
];

export interface UserDirectoryRow {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber: string;
  avatar: string | null;
  status: AdminUserStatus;
  suspendedUntil: Date | null;
  createdAt: Date;
  lastSeen: Date | null;
}

export interface UserDetail {
  profile: UserDirectoryRow & { bio: string };
  memberships: Array<{
    chatId: string;
    name: string;
    type: string;
    role: string;
    isBanned: boolean;
    mutedByAdmin: boolean;
    isChatLocked: boolean;
    isChatDeleted: boolean;
  }>;
  sessions: Array<{
    id: string;
    device: string | null;
    ip: string | null;
    lastUsedAt: Date;
    revokedAt: Date | null;
    createdAt: Date;
  }>;
  reports: Array<{
    id: string;
    /** `reporter`: this user filed it. `target`: it is about this user. */
    /** `reporter`: filed by this user. `target`: about this user. `message`: about one of their messages. */
    role: "reporter" | "target" | "message";
    targetType: string;
    targetId: string;
    reason: string;
    status: string;
    action: string | null;
    createdAt: Date;
  }>;
  history: AuditEntry[];
}

const DIRECTORY_FIELDS =
  "username firstName lastName email phoneNumber image isDeleted suspendedUntil createdAt lastSeen";
const DETAIL_FIELDS = `${DIRECTORY_FIELDS} bio`;

export function statusOf(
  user: { isDeleted?: boolean; suspendedUntil?: Date | null },
  now: Date,
): AdminUserStatus {
  if (user.isDeleted) {
    return "deleted";
  }
  if (user.suspendedUntil && user.suspendedUntil > now) {
    return "suspended";
  }
  return "active";
}

function toRow(
  redact: boolean,
  user: {
    _id: Types.ObjectId;
    username?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phoneNumber?: string;
    image?: string[];
    isDeleted?: boolean;
    suspendedUntil?: Date | null;
    createdAt: Date;
    lastSeen?: Date | null;
  },
  now: Date,
): UserDirectoryRow {
  return {
    id: String(user._id),
    username: user.username ?? "",
    firstName: user.firstName ?? "",
    lastName: user.lastName ?? "",
    email: redact ? maskEmail(user.email ?? "") : (user.email ?? ""),
    phoneNumber: redact
      ? maskPhone(user.phoneNumber ?? "")
      : (user.phoneNumber ?? ""),
    avatar: user.image?.[0] ?? null,
    status: statusOf(user, now),
    suspendedUntil: user.suspendedUntil ?? null,
    createdAt: user.createdAt,
    lastSeen: user.lastSeen ?? null,
  };
}

@Injectable()
export class AdminUsersService {
  constructor(
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Session.name) private sessionModel: Model<Session>,
    @InjectModel(Chat.name) private chatModel: Model<Chat>,
    @InjectModel(ChatMembers.name) private chatMembersModel: Model<ChatMembers>,
    @InjectModel(Report.name) private reportModel: Model<Report>,
    @InjectModel(Message.name) private messageModel: Model<Message>,
    private moderationLog: ModerationLogService,
    private adminAudit: AdminAuditService,
  ) {}

  /**
   * Searchable, filterable, paginated directory. Matches username, email, phone and name
   * (case-insensitive substring). Status is derived from `isDeleted` and `suspendedUntil`.
   */
  async list(params: {
    q?: string;
    status?: AdminUserStatus;
    limit: number;
    offset: number;
    viewerRole: string;
    now?: Date;
  }): Promise<{ items: UserDirectoryRow[]; total: number }> {
    const now = params.now ?? new Date();
    const redact = shouldRedact(params.viewerRole);
    const clauses: FilterQuery<User>[] = [];

    if (params.q) {
      // Prefix match, so username/email/phone can use their indexes. Usernames and emails are
      // stored lowercase, so the query is lowercased to match. Names are not indexed.
      const prefix = escapeRegex(params.q);
      const lower = new RegExp(`^${escapeRegex(params.q.toLowerCase())}`);
      const anyCase = new RegExp(`^${prefix}`, "i");
      clauses.push({
        $or: [
          { username: lower },
          { email: lower },
          { phoneNumber: new RegExp(`^${prefix}`) },
          { firstName: anyCase },
          { lastName: anyCase },
        ],
      });
    }
    if (params.status) {
      clauses.push(statusClause(params.status, now));
    }
    const filter: FilterQuery<User> = clauses.length ? { $and: clauses } : {};

    const [rows, total] = await Promise.all([
      this.userModel
        .find(filter)
        .select(DIRECTORY_FIELDS)
        .sort({ createdAt: -1, _id: -1 })
        .skip(params.offset)
        .limit(params.limit)
        .lean()
        .exec(),
      this.userModel.countDocuments(filter).exec(),
    ]);
    return { items: rows.map(row => toRow(redact, row, now)), total };
  }

  /**
   * Full context for one user, read-only. Writes a `user.view` audit entry, but only once the
   * user is known to exist, so probing random ids does not fill the log.
   */
  async detail(
    adminId: string,
    userId: string,
    viewerRole: string,
    now: Date = new Date(),
  ): Promise<UserDetail> {
    const redact = shouldRedact(viewerRole);
    const user = await this.userModel
      .findById(userId)
      .select(DETAIL_FIELDS)
      .lean()
      .exec();
    if (!user) {
      throw new NotFoundException("User not found");
    }
    await this.moderationLog.log(adminId, "user.view", "user", userId);

    const uid = new Types.ObjectId(userId);
    // The user's own messages: reports about them and moderation actions on them belong to the
    // user's history. Capped; a user with more than this shows the newest.
    const ownMessageIds = (
      await this.messageModel
        .find({ senderId: uid })
        .select("_id")
        .sort({ _id: -1 })
        .limit(500)
        .lean()
        .exec()
    ).map(m => String(m._id));

    const [memberships, sessions, reports, history] = await Promise.all([
      this.memberships(userId),
      this.sessionModel
        .find({ userId: uid })
        .select("device ip lastUsedAt revokedAt createdAt")
        .sort({ lastUsedAt: -1 })
        .limit(20)
        .lean()
        .exec(),
      this.reportModel
        .find({
          $or: [
            { reporterId: uid },
            { targetType: ReportTargetType.USER, targetId: userId },
            {
              targetType: ReportTargetType.MESSAGE,
              targetId: { $in: ownMessageIds },
            },
          ],
        })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean()
        .exec(),
      this.adminAudit.historyForUser(userId, ownMessageIds, 50),
    ]);

    return {
      profile: { ...toRow(redact, user, now), bio: user.bio ?? "" },
      memberships,
      sessions: sessions.map(s => ({
        id: String(s._id),
        device: s.device ?? null,
        ip: redact ? maskIp(s.ip ?? null) : (s.ip ?? null),
        lastUsedAt: s.lastUsedAt,
        revokedAt: s.revokedAt ?? null,
        createdAt: s.createdAt,
      })),
      reports: reports.map(r => ({
        id: String(r._id),
        role: reportRole(r, userId, ownMessageIds),
        targetType: r.targetType,
        targetId: r.targetId,
        reason: r.reason,
        status: r.status,
        action: r.action ?? null,
        createdAt: r.createdAt,
      })),
      history,
    };
  }

  private async memberships(
    userId: string,
  ): Promise<UserDetail["memberships"]> {
    const rows = await this.chatMembersModel
      .find({ userId, isJoined: true })
      .limit(200)
      .lean()
      .exec();
    const chatIds = rows
      .map(r => r.channelId)
      .filter(id => Types.ObjectId.isValid(id));
    const chats = await this.chatModel
      .find({ _id: { $in: chatIds } })
      .select("name type isLocked isDeleted")
      .lean()
      .exec();
    const byId = new Map(chats.map(c => [String(c._id), c]));

    const out: UserDetail["memberships"] = [];
    for (const row of rows) {
      const chat = byId.get(row.channelId);
      if (!chat) {
        continue;
      }
      out.push({
        chatId: row.channelId,
        name: chat.name ?? "",
        type: chat.type,
        role: row.role,
        isBanned: row.isBanned,
        mutedByAdmin: row.mutedByAdmin,
        isChatLocked: chat.isLocked,
        isChatDeleted: chat.isDeleted,
      });
    }
    return out;
  }
}

/** Why a report appears in this user's detail: they filed it, it is about them, or about their message. */
function reportRole(
  r: { reporterId: Types.ObjectId; targetType: string; targetId: string },
  userId: string,
  ownMessageIds: string[],
): "reporter" | "target" | "message" {
  if (String(r.reporterId) === userId) {
    return "reporter";
  }
  const messageType: string = ReportTargetType.MESSAGE;
  if (r.targetType === messageType && ownMessageIds.includes(r.targetId)) {
    return "message";
  }
  return "target";
}

function statusClause(status: AdminUserStatus, now: Date): FilterQuery<User> {
  switch (status) {
    case "deleted":
      return { isDeleted: true };
    case "suspended":
      return { isDeleted: false, suspendedUntil: { $gt: now } };
    case "active":
      return {
        isDeleted: false,
        $or: [{ suspendedUntil: null }, { suspendedUntil: { $lte: now } }],
      };
  }
}
