import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { ModerationLog } from "./schema/moderation-log.schema";

@Injectable()
export class ModerationLogService {
  constructor(
    @InjectModel(ModerationLog.name)
    private moderationLogModel: Model<ModerationLog>,
  ) {}

  async log(
    actorId: string,
    action: string,
    targetType: string,
    targetId: string,
    meta: Record<string, unknown> | null = null,
  ): Promise<void> {
    await this.moderationLogModel.create({
      actorId: new Types.ObjectId(actorId),
      action,
      targetType,
      targetId,
      meta,
      at: new Date(),
    });
  }
}
