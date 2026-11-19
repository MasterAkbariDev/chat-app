import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { ModerationLogService } from "src/moderation/moderation-log.service";
import { AdminUser } from "./schema/admin-user.schema";

@Injectable()
export class AdminAccountsService {
  constructor(
    @InjectModel(AdminUser.name) private adminUserModel: Model<AdminUser>,
    private moderationLog: ModerationLogService,
  ) {}

  /**
   * Revokes every admin token issued so far for `targetId`. Used both for "sign out everywhere"
   * (`actorId === targetId`) and for a superadmin revoking another admin. Audited either way.
   */
  async revokeTokens(
    actorId: string,
    targetId: string,
  ): Promise<{ success: true }> {
    const result = await this.adminUserModel
      .updateOne(
        { _id: new Types.ObjectId(targetId) },
        { $inc: { tokenVersion: 1 } },
      )
      .exec();
    if (result.matchedCount === 0) {
      throw new NotFoundException("Admin not found");
    }
    await this.moderationLog.log(
      actorId,
      actorId === targetId ? "admin.logout_all" : "admin.revoke_tokens",
      "admin",
      targetId,
    );
    return { success: true };
  }
}
