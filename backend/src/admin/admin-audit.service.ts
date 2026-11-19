import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { FilterQuery, Model, Types } from "mongoose";
import { ModerationLog } from "src/moderation/schema/moderation-log.schema";
import { AdminUser } from "./schema/admin-user.schema";

export interface AuditFilter {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}

export interface AuditEntry {
  id: string;
  actor: { id: string; email: string; role: string } | null;
  action: string;
  targetType: string;
  targetId: string;
  meta: Record<string, unknown> | null;
  at: Date;
}

/**
 * Read side of `moderation_log`. Writes still go through `ModerationLogService.log()` — this
 * service never inserts, updates or deletes (the log is append-only).
 */
@Injectable()
export class AdminAuditService {
  constructor(
    @InjectModel(ModerationLog.name)
    private moderationLogModel: Model<ModerationLog>,
    @InjectModel(AdminUser.name) private adminUserModel: Model<AdminUser>,
  ) {}

  async list(
    filter: AuditFilter,
  ): Promise<{ items: AuditEntry[]; total: number }> {
    const query: FilterQuery<ModerationLog> = {};
    if (filter.actorId) {
      query.actorId = new Types.ObjectId(filter.actorId);
    }
    if (filter.action) {
      query.action = filter.action;
    }
    if (filter.targetType) {
      query.targetType = filter.targetType;
    }
    if (filter.targetId) {
      query.targetId = filter.targetId;
    }
    if (filter.from || filter.to) {
      const range: { $gte?: Date; $lte?: Date } = {};
      if (filter.from) {
        range.$gte = filter.from;
      }
      if (filter.to) {
        range.$lte = filter.to;
      }
      query.at = range;
    }

    const [rows, total] = await Promise.all([
      this.moderationLogModel
        .find(query)
        .sort({ at: -1, _id: -1 })
        .skip(filter.offset)
        .limit(filter.limit)
        .lean()
        .exec(),
      this.moderationLogModel.countDocuments(query).exec(),
    ]);
    return { items: await this.toEntries(rows), total };
  }

  /**
   * Newest-first moderation history about one user: actions on the user, actions that name the
   * user in their metadata (e.g. a channel member removal), and actions on the user's messages.
   */
  async historyForUser(
    userId: string,
    messageIds: string[],
    limit: number,
  ): Promise<AuditEntry[]> {
    const rows = await this.moderationLogModel
      .find({
        $or: [
          { targetType: "user", targetId: userId },
          { "meta.userId": userId },
          { targetType: "message", targetId: { $in: messageIds } },
        ],
      })
      .sort({ at: -1, _id: -1 })
      .limit(limit)
      .lean()
      .exec();
    return this.toEntries(rows);
  }

  /** Attaches the acting admin's email and role. One lookup per page, not per row. */
  private async toEntries(
    rows: Array<{
      _id: Types.ObjectId;
      actorId: Types.ObjectId;
      action: string;
      targetType: string;
      targetId: string;
      meta: Record<string, unknown> | null;
      at: Date;
    }>,
  ): Promise<AuditEntry[]> {
    const actorIds = [...new Set(rows.map(r => String(r.actorId)))];
    const admins = await this.adminUserModel
      .find({ _id: { $in: actorIds } })
      .select("email role")
      .lean()
      .exec();
    const byId = new Map(admins.map(a => [String(a._id), a]));

    return rows.map(row => {
      const admin = byId.get(String(row.actorId));
      return {
        id: String(row._id),
        actor: admin
          ? { id: String(admin._id), email: admin.email, role: admin.role }
          : null,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        meta: row.meta,
        at: row.at,
      };
    });
  }
}
