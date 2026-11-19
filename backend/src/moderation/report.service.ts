import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Report, ReportStatus, ReportTargetType } from "./schema/report.schema";
import { CreateReportDto } from "./dto/create-report.dto";
import { ResolveReportDto } from "./dto/resolve-report.dto";
import { ModerationLogService } from "./moderation-log.service";

const DUPLICATE_KEY_ERROR_CODE = 11000;

@Injectable()
export class ReportService {
  constructor(
    @InjectModel(Report.name) private reportModel: Model<Report>,
    private moderationLog: ModerationLogService,
  ) {}

  async create(reporterId: string, dto: CreateReportDto): Promise<Report> {
    try {
      return await this.reportModel.create({
        reporterId: new Types.ObjectId(reporterId),
        targetType: dto.targetType,
        targetId: dto.targetId,
        reason: dto.reason,
        note: dto.note ?? null,
      });
    } catch (err: unknown) {
      const isDuplicate =
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: number }).code === DUPLICATE_KEY_ERROR_CODE;
      if (isDuplicate) {
        throw new BadRequestException("You've already reported this");
      }
      throw err;
    }
  }

  async list(
    status?: ReportStatus,
    targetType?: ReportTargetType,
    limit = 50,
    offset = 0,
  ) {
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (targetType) filter.targetType = targetType;
    return this.reportModel
      .find(filter)
      .populate("reporterId", "username firstName lastName")
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(offset)
      .lean()
      .exec();
  }

  async resolve(
    reportId: string,
    adminId: string,
    dto: ResolveReportDto,
  ): Promise<Report> {
    const report = await this.reportModel.findById(reportId).exec();
    if (!report) {
      throw new NotFoundException("Report not found");
    }
    report.status = dto.status;
    report.action = dto.action ?? report.action;
    report.handledBy = new Types.ObjectId(adminId);
    report.handledAt = new Date();
    await report.save();

    await this.moderationLog.log(
      adminId,
      "report.resolve",
      report.targetType,
      report.targetId,
      { reportId, status: dto.status, action: dto.action },
    );
    return report;
  }
}
