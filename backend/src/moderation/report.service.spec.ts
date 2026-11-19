import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import {
  Report,
  ReportSchema,
  ReportStatus,
  ReportTargetType,
} from "./schema/report.schema";
import {
  ModerationLog,
  ModerationLogSchema,
} from "./schema/moderation-log.schema";
import { ReportService } from "./report.service";
import { ModerationLogService } from "./moderation-log.service";
import { User, UserSchema } from "src/user/schema/user.schema";

describe("ReportService (B10: report -> queue -> action)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let ReportModel: Model<Report>;
  let ModerationLogModel: Model<ModerationLog>;
  let service: ReportService;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    ReportModel = connection.model(Report.name, ReportSchema);
    ModerationLogModel = connection.model(
      ModerationLog.name,
      ModerationLogSchema,
    );
    // Registered so `.populate("reporterId", ...)` in ReportService can resolve the ref — not
    // used directly by these tests otherwise.
    connection.model(User.name, UserSchema);
    await ReportModel.createIndexes();

    const moderationLog = new ModerationLogService(ModerationLogModel);
    service = new ReportService(ReportModel, moderationLog);
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  afterEach(async () => {
    await Promise.all([
      ReportModel.deleteMany({}),
      ModerationLogModel.deleteMany({}),
    ]);
  });

  const reporterId = new Types.ObjectId().toString();
  const targetId = new Types.ObjectId().toString();
  const adminId = new Types.ObjectId().toString();

  it("creates a report", async () => {
    const report = await service.create(reporterId, {
      targetType: ReportTargetType.MESSAGE,
      targetId,
      reason: "spam",
    });
    expect(report.status).toBe(ReportStatus.OPEN);
  });

  it("dedupes a repeat report of the same target by the same reporter", async () => {
    await service.create(reporterId, {
      targetType: ReportTargetType.MESSAGE,
      targetId,
      reason: "spam",
    });
    await expect(
      service.create(reporterId, {
        targetType: ReportTargetType.MESSAGE,
        targetId,
        reason: "harassment",
      }),
    ).rejects.toThrow(/already reported/i);
  });

  it("allows a different reporter to report the same target", async () => {
    await service.create(reporterId, {
      targetType: ReportTargetType.MESSAGE,
      targetId,
      reason: "spam",
    });
    const otherReporter = new Types.ObjectId().toString();
    await expect(
      service.create(otherReporter, {
        targetType: ReportTargetType.MESSAGE,
        targetId,
        reason: "spam",
      }),
    ).resolves.toBeTruthy();
  });

  it("lists reports filtered by status and type", async () => {
    await service.create(reporterId, {
      targetType: ReportTargetType.MESSAGE,
      targetId: new Types.ObjectId().toString(),
      reason: "spam",
    });
    const userReport = await service.create(reporterId, {
      targetType: ReportTargetType.USER,
      targetId: new Types.ObjectId().toString(),
      reason: "impersonation",
    });
    await service.resolve(userReport._id.toString(), adminId, {
      status: ReportStatus.DISMISSED,
    });

    const openOnly = await service.list(ReportStatus.OPEN);
    expect(openOnly).toHaveLength(1);

    const usersOnly = await service.list(undefined, ReportTargetType.USER);
    expect(usersOnly).toHaveLength(1);
    expect(usersOnly[0].status).toBe(ReportStatus.DISMISSED);
  });

  it("resolve sets handledBy/handledAt/action and logs a moderation entry", async () => {
    const report = await service.create(reporterId, {
      targetType: ReportTargetType.CHANNEL,
      targetId,
      reason: "harassment",
    });

    const resolved = await service.resolve(report._id.toString(), adminId, {
      status: ReportStatus.ACTIONED,
      action: "locked channel",
    });

    expect(resolved.status).toBe(ReportStatus.ACTIONED);
    expect(resolved.action).toBe("locked channel");
    expect(resolved.handledBy?.toString()).toBe(adminId);
    expect(resolved.handledAt).toBeTruthy();

    const logs = await ModerationLogModel.find({
      targetType: ReportTargetType.CHANNEL,
      targetId,
    }).exec();
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("report.resolve");
  });

  it("rejects resolving an unknown report", async () => {
    await expect(
      service.resolve(new Types.ObjectId().toString(), adminId, {
        status: ReportStatus.DISMISSED,
      }),
    ).rejects.toThrow(/not found/i);
  });
});
