import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { User, UserSchema } from "src/user/schema/user.schema";
import { Session, SessionSchema } from "src/auth/schema/session.schema";
import { TokenCacheService } from "src/auth/token-cache.service";
import {
  ModerationLog,
  ModerationLogSchema,
} from "src/moderation/schema/moderation-log.schema";
import { ModerationLogService } from "src/moderation/moderation-log.service";
import { AdminUserActionsService } from "./admin-user-actions.service";

describe("AdminUserActionsService (D2: force logout, soft delete, restore)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let UserModel: Model<User>;
  let SessionModel: Model<Session>;
  let LogModel: Model<ModerationLog>;
  let actions: AdminUserActionsService;
  let invalidate: jest.Mock;
  const adminId = String(new Types.ObjectId());

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    UserModel = connection.model(User.name, UserSchema);
    SessionModel = connection.model(Session.name, SessionSchema);
    LogModel = connection.model(ModerationLog.name, ModerationLogSchema);
    invalidate = jest.fn().mockResolvedValue(undefined);
    actions = new AdminUserActionsService(
      UserModel,
      SessionModel,
      { invalidate } as unknown as TokenCacheService,
      new ModerationLogService(LogModel),
    );
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  const makeUser = (username: string) =>
    UserModel.create({
      username,
      email: `${username}@example.com`,
      password: "x",
    });

  const sessionFor = (userId: Types.ObjectId, n: string) =>
    SessionModel.create({
      userId,
      refreshTokenHash: `h-${n}`,
      familyId: `f-${n}`,
    });

  it("force logout ends every session, bumps the token version, and clears the cache", async () => {
    const user = await makeUser("jack");
    await sessionFor(user._id, "j1");
    await sessionFor(user._id, "j2");

    await expect(
      actions.forceLogout(adminId, String(user._id)),
    ).resolves.toEqual({ success: true });

    const after = await UserModel.findById(user._id).lean().exec();
    expect(after?.tokenVersion).toBe(1);
    expect(
      await SessionModel.countDocuments({ userId: user._id, revokedAt: null }),
    ).toBe(0);
    expect(invalidate).toHaveBeenCalledWith(String(user._id));
    expect(
      await LogModel.countDocuments({
        action: "user.force_logout",
        targetId: String(user._id),
      }),
    ).toBe(1);
  });

  it("soft delete needs the exact username, then hides the account and ends its sessions", async () => {
    const user = await makeUser("kate");
    await sessionFor(user._id, "k1");

    await expect(
      actions.softDelete(adminId, String(user._id), "spam", "Kate"),
    ).rejects.toThrow(BadRequestException);
    expect((await UserModel.findById(user._id).lean().exec())?.isDeleted).toBe(
      false,
    );

    await actions.softDelete(adminId, String(user._id), "spam", "kate");
    const after = await UserModel.findById(user._id).lean().exec();
    expect(after?.isDeleted).toBe(true);
    expect(
      await SessionModel.countDocuments({ userId: user._id, revokedAt: null }),
    ).toBe(0);

    const log = await LogModel.findOne({
      action: "user.soft_delete",
      targetId: String(user._id),
    }).lean();
    expect(log?.meta).toEqual({ reason: "spam" });
  });

  it("soft delete of an already-deleted account is a conflict", async () => {
    const user = await makeUser("liam");
    await actions.softDelete(adminId, String(user._id), "spam", "liam");
    await expect(
      actions.softDelete(adminId, String(user._id), "spam", "liam"),
    ).rejects.toThrow(ConflictException);
  });

  it("restore brings the account back and audits it; restoring a live account is a conflict", async () => {
    const user = await makeUser("mia");
    await expect(actions.restore(adminId, String(user._id))).rejects.toThrow(
      ConflictException,
    );

    await actions.softDelete(adminId, String(user._id), "spam", "mia");
    await actions.restore(adminId, String(user._id));
    expect((await UserModel.findById(user._id).lean().exec())?.isDeleted).toBe(
      false,
    );
    expect(
      await LogModel.countDocuments({
        action: "user.restore",
        targetId: String(user._id),
      }),
    ).toBe(1);
  });

  it("unknown users are 404 for every action", async () => {
    const ghost = String(new Types.ObjectId());
    await expect(actions.forceLogout(adminId, ghost)).rejects.toThrow(
      NotFoundException,
    );
    await expect(actions.softDelete(adminId, ghost, "x", "x")).rejects.toThrow(
      NotFoundException,
    );
    await expect(actions.restore(adminId, ghost)).rejects.toThrow(
      NotFoundException,
    );
  });
});
