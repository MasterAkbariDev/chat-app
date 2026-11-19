import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { AuthService } from "src/auth/auth.service";
import {
  RecoveryRequest,
  RecoveryRequestStatus,
} from "src/auth/schema/recovery-request.schema";
import { RecoveryToken } from "src/auth/schema/recovery-token.schema";
import { ModerationLogService } from "src/moderation/moderation-log.service";
import { User } from "src/user/schema/user.schema";

export type RecoveryTokenStatus = "active" | "used" | "expired" | "revoked";

/** The state a link is in right now. Revoked and used win over expired, so the queue reads sensibly. */
export function recoveryTokenStatus(
  token: { usedAt?: Date | null; revokedAt?: Date | null; expiresAt: Date },
  now: Date,
): RecoveryTokenStatus {
  if (token.revokedAt) {
    return "revoked";
  }
  if (token.usedAt) {
    return "used";
  }
  if (token.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  return "active";
}

/**
 * The support side of password recovery (ADMIN_PANEL_PLAN D2). Token mechanics live in
 * `AuthService`; this layer adds the queue views and writes the audit entry for every action.
 * Audit entries target the user, so they show up in that user's moderation history.
 */
@Injectable()
export class AdminRecoveryService {
  constructor(
    private authService: AuthService,
    @InjectModel(RecoveryRequest.name)
    private recoveryRequestModel: Model<RecoveryRequest>,
    @InjectModel(RecoveryToken.name)
    private recoveryTokenModel: Model<RecoveryToken>,
    @InjectModel(User.name) private userModel: Model<User>,
    private moderationLog: ModerationLogService,
  ) {}

  async list(params: {
    status: RecoveryRequestStatus;
    limit: number;
    offset: number;
    now?: Date;
  }) {
    const now = params.now ?? new Date();
    const filter = { status: params.status };
    const [rows, total] = await Promise.all([
      this.recoveryRequestModel
        .find(filter)
        .sort({
          createdAt: params.status === RecoveryRequestStatus.PENDING ? 1 : -1,
        })
        .skip(params.offset)
        .limit(params.limit)
        .lean()
        .exec(),
      this.recoveryRequestModel.countDocuments(filter).exec(),
    ]);

    const userIds = rows.map(r => r.userId);
    const users = await this.userModel
      .find({ _id: { $in: userIds } })
      .select("username firstName lastName email isDeleted suspendedUntil")
      .lean()
      .exec();
    const userById = new Map(users.map(u => [String(u._id), u]));

    const requestIds = rows.map(r => r._id);
    const tokens = await this.recoveryTokenModel
      .find({ recoveryRequestId: { $in: requestIds } })
      .lean()
      .exec();
    const tokenByRequest = new Map(
      tokens.map(t => [String(t.recoveryRequestId), t]),
    );

    const items = rows.map(r => {
      const u = userById.get(String(r.userId));
      const t = tokenByRequest.get(String(r._id));
      return {
        id: String(r._id),
        status: r.status,
        requestedAt: r.createdAt,
        ip: r.ip ?? null,
        reviewedAt: r.reviewedAt ?? null,
        denyNote: r.denyNote ?? null,
        user: u
          ? {
              id: String(u._id),
              username: u.username ?? "",
              firstName: u.firstName ?? "",
              lastName: u.lastName ?? "",
              email: u.email ?? "",
              isDeleted: u.isDeleted ?? false,
              suspendedUntil: u.suspendedUntil ?? null,
            }
          : null,
        token: t
          ? {
              id: String(t._id),
              status: recoveryTokenStatus(t, now),
              expiresAt: t.expiresAt,
              usedAt: t.usedAt ?? null,
              revokedAt: t.revokedAt ?? null,
              sentAt: t.sentAt ?? null,
            }
          : null,
      };
    });
    return { items, total };
  }

  async approve(requestId: string, adminId: string) {
    const result = await this.authService.approveRecoveryRequest(
      requestId,
      adminId,
    );
    await this.moderationLog.log(
      adminId,
      "recovery.approve",
      "user",
      result.userId,
      {
        requestId,
        tokenId: result.tokenId,
        expiresAt: result.expiresAt,
      },
    );
    return {
      tokenId: result.tokenId,
      token: result.token,
      expiresAt: result.expiresAt,
    };
  }

  async deny(requestId: string, adminId: string, note?: string) {
    const { userId } = await this.authService.denyRecoveryRequest(
      requestId,
      adminId,
      note,
    );
    await this.moderationLog.log(adminId, "recovery.deny", "user", userId, {
      requestId,
      note: note ?? null,
    });
    return { success: true };
  }

  /** Records that the admin sent the link out of band. Only an active link can be marked. */
  async markSent(tokenId: string, adminId: string, now: Date = new Date()) {
    const token = await this.findToken(tokenId);
    if (recoveryTokenStatus(token, now) !== "active") {
      throw new BadRequestException(
        "Only an active link can be marked as sent",
      );
    }
    await this.recoveryTokenModel
      .updateOne({ _id: token._id }, { $set: { sentAt: now } })
      .exec();
    await this.moderationLog.log(
      adminId,
      "recovery.mark_sent",
      "user",
      String(token.userId),
      {
        tokenId,
      },
    );
    return { success: true };
  }

  /** Kills an unused link before it expires. A link that was already used cannot be revoked. */
  async revoke(tokenId: string, adminId: string, now: Date = new Date()) {
    const token = await this.findToken(tokenId);
    const status = recoveryTokenStatus(token, now);
    if (status === "used" || status === "revoked") {
      throw new BadRequestException(`This link is already ${status}`);
    }
    await this.recoveryTokenModel
      .updateOne({ _id: token._id }, { $set: { revokedAt: now } })
      .exec();
    await this.moderationLog.log(
      adminId,
      "recovery.revoke",
      "user",
      String(token.userId),
      {
        tokenId,
      },
    );
    return { success: true };
  }

  private async findToken(tokenId: string) {
    if (!Types.ObjectId.isValid(tokenId)) {
      throw new BadRequestException('"id" must be a valid id');
    }
    const token = await this.recoveryTokenModel.findById(tokenId).lean().exec();
    if (!token) {
      throw new NotFoundException("Recovery link not found");
    }
    return token;
  }
}
