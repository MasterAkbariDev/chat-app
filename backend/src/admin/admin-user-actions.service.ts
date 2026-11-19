import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Session } from "src/auth/schema/session.schema";
import { TokenCacheService } from "src/auth/token-cache.service";
import { ModerationLogService } from "src/moderation/moderation-log.service";
import { User } from "src/user/schema/user.schema";

/**
 * Account actions beyond suspend/warn (ADMIN_PANEL_PLAN D2): force sign-out, soft delete and
 * restore. Each one is audited against the user and takes effect at once, because the token-state
 * cache is invalidated here rather than left to expire.
 */
@Injectable()
export class AdminUserActionsService {
  constructor(
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(Session.name) private sessionModel: Model<Session>,
    private tokenCache: TokenCacheService,
    private moderationLog: ModerationLogService,
  ) {}

  /** Ends every session and every token the user holds, on every device. The user must sign in again. */
  async forceLogout(
    adminId: string,
    userId: string,
  ): Promise<{ success: true }> {
    await this.loadUser(userId);
    await this.endAllSessions(userId);
    await this.moderationLog.log(adminId, "user.force_logout", "user", userId);
    return { success: true };
  }

  /**
   * Soft delete: the account can no longer sign in or use the API, and nothing is erased, so it
   * can be restored. `confirm` must be the username (or the id, if there is none), as the plan
   * requires for every destructive action.
   */
  async softDelete(
    adminId: string,
    userId: string,
    reason: string,
    confirm: string,
  ): Promise<{ success: true }> {
    const user = await this.loadUser(userId);
    if (user.isDeleted) {
      throw new ConflictException("User is already deleted");
    }
    const expected = user.username || userId;
    if (confirm !== expected) {
      throw new BadRequestException(`Type "${expected}" exactly to confirm`);
    }

    await this.userModel
      .updateOne({ _id: userId }, { $set: { isDeleted: true } })
      .exec();
    await this.endAllSessions(userId);
    await this.moderationLog.log(adminId, "user.soft_delete", "user", userId, {
      reason,
    });
    return { success: true };
  }

  /** Brings back a soft-deleted account. Its sessions stay ended; the user signs in again. */
  async restore(adminId: string, userId: string): Promise<{ success: true }> {
    const user = await this.loadUser(userId);
    if (!user.isDeleted) {
      throw new ConflictException("User is not deleted");
    }
    await this.userModel
      .updateOne({ _id: userId }, { $set: { isDeleted: false } })
      .exec();
    await this.tokenCache.invalidate(userId);
    await this.moderationLog.log(adminId, "user.restore", "user", userId);
    return { success: true };
  }

  private async loadUser(userId: string) {
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException('"id" must be a valid id');
    }
    const user = await this.userModel
      .findById(userId)
      .select("username isDeleted")
      .lean()
      .exec();
    if (!user) {
      throw new NotFoundException("User not found");
    }
    return user;
  }

  private async endAllSessions(userId: string) {
    await this.userModel
      .updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } })
      .exec();
    await this.tokenCache.invalidate(userId);
    await this.sessionModel
      .updateMany(
        { userId: new Types.ObjectId(userId), revokedAt: null },
        { $set: { revokedAt: new Date() } },
      )
      .exec();
  }
}
