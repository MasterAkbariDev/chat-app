import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { JwtService } from "@nestjs/jwt";
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { User, UserSchema } from "src/user/schema/user.schema";
import { Session, SessionSchema } from "src/auth/schema/session.schema";
import {
  RecoveryRequest,
  RecoveryRequestSchema,
  RecoveryRequestStatus,
} from "src/auth/schema/recovery-request.schema";
import {
  RecoveryToken,
  RecoveryTokenSchema,
} from "src/auth/schema/recovery-token.schema";
import { AuthService } from "src/auth/auth.service";
import { TokenCacheService } from "src/auth/token-cache.service";
import { UserService } from "src/user/user.service";
import {
  ModerationLog,
  ModerationLogSchema,
} from "src/moderation/schema/moderation-log.schema";
import { ModerationLogService } from "src/moderation/moderation-log.service";
import {
  AdminUser,
  AdminUserSchema,
  AdminRole,
} from "./schema/admin-user.schema";
import {
  AdminRecoveryService,
  recoveryTokenStatus,
} from "./admin-recovery.service";

describe("AdminRecoveryService (D2: recovery queue, links, audit)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let UserModel: Model<User>;
  let RequestModel: Model<RecoveryRequest>;
  let TokenModel: Model<RecoveryToken>;
  let LogModel: Model<ModerationLog>;
  let auth: AuthService;
  let admin: AdminRecoveryService;
  let adminId: string;
  let userId: Types.ObjectId;
  // Set by the approve test, used by the tests that follow it.
  let stashedTokenId = "";
  let stashedToken = "";

  const fakeTokenCache = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn(),
    invalidate: jest.fn(),
  } as unknown as TokenCacheService;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    UserModel = connection.model(User.name, UserSchema);
    const SessionModel = connection.model<Session>(Session.name, SessionSchema);
    RequestModel = connection.model(
      RecoveryRequest.name,
      RecoveryRequestSchema,
    );
    TokenModel = connection.model(RecoveryToken.name, RecoveryTokenSchema);
    LogModel = connection.model(ModerationLog.name, ModerationLogSchema);
    const AdminModel = connection.model(AdminUser.name, AdminUserSchema);

    auth = new AuthService(
      { userModel: UserModel } as unknown as UserService,
      new JwtService({ secret: "s", signOptions: { expiresIn: "15m" } }),
      fakeTokenCache,
      SessionModel,
      RequestModel,
      TokenModel,
    );
    admin = new AdminRecoveryService(
      auth,
      RequestModel,
      TokenModel,
      UserModel,
      new ModerationLogService(LogModel),
    );

    const a = await AdminModel.create({
      email: "help@example.com",
      passwordHash: "x",
      role: AdminRole.SUPPORT,
      mfaSecret: "x",
    });
    adminId = String(a._id);
    userId = (
      await UserModel.create({
        username: "ivy",
        email: "ivy@example.com",
        password: "old",
        firstName: "Ivy",
      })
    )._id;
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  it("a request carries the requester's IP and appears in the pending queue", async () => {
    await auth.requestRecovery("ivy@example.com", "203.0.113.9");
    const { items, total } = await admin.list({
      status: RecoveryRequestStatus.PENDING,
      limit: 50,
      offset: 0,
    });
    expect(total).toBe(1);
    expect(items[0].ip).toBe("203.0.113.9");
    expect(items[0].user?.username).toBe("ivy");
    expect(items[0].token).toBeNull();
  });

  it("approve returns a one-time link and audits it against the user", async () => {
    const requestId = String(
      (await RequestModel.findOne({ userId }).exec())?._id,
    );
    const { token, tokenId } = await admin.approve(requestId, adminId);
    expect(token).toEqual(expect.any(String));

    const approved = await admin.list({
      status: RecoveryRequestStatus.APPROVED,
      limit: 50,
      offset: 0,
    });
    expect(approved.items[0].token).toMatchObject({
      id: tokenId,
      status: "active",
      sentAt: null,
    });

    const log = await LogModel.findOne({
      action: "recovery.approve",
      targetId: String(userId),
    }).lean();
    expect(log?.actorId.toString()).toBe(adminId);
    // The raw link is never stored: nothing in the log or queue carries it.
    expect(JSON.stringify(log)).not.toContain(token);
    expect(JSON.stringify(approved.items)).not.toContain(token);

    stashedTokenId = tokenId;
    stashedToken = token;
  });

  it("mark-sent records the send time and audits it", async () => {
    const tokenId = stashedTokenId;
    await expect(admin.markSent(tokenId, adminId)).resolves.toEqual({
      success: true,
    });
    const row = await admin.list({
      status: RecoveryRequestStatus.APPROVED,
      limit: 50,
      offset: 0,
    });
    expect(row.items[0].token?.sentAt).toEqual(expect.any(Date));
    expect(
      await LogModel.countDocuments({ action: "recovery.mark_sent" }),
    ).toBe(1);
  });

  it("revoke kills an unused link: it stops validating and cannot be used to reset", async () => {
    const tokenId = stashedTokenId;
    const token = stashedToken;
    await expect(admin.revoke(tokenId, adminId)).resolves.toEqual({
      success: true,
    });

    await expect(auth.validateRecoveryToken(token)).resolves.toEqual({
      valid: false,
    });
    await expect(
      auth.resetPasswordWithRecoveryToken(token, "new-password"),
    ).rejects.toThrow(UnauthorizedException);

    const row = await admin.list({
      status: RecoveryRequestStatus.APPROVED,
      limit: 50,
      offset: 0,
    });
    expect(row.items[0].token?.status).toBe("revoked");
    await expect(admin.markSent(tokenId, adminId)).rejects.toThrow(
      BadRequestException,
    );
    await expect(admin.revoke(tokenId, adminId)).rejects.toThrow(
      /already revoked/,
    );
    expect(await LogModel.countDocuments({ action: "recovery.revoke" })).toBe(
      1,
    );
  });

  it("a used link cannot be revoked, and shows as used", async () => {
    await auth.requestRecovery("ivy@example.com", "203.0.113.9");
    const requestId = String(
      (await RequestModel.findOne({ status: "pending" }).exec())?._id,
    );
    const { token, tokenId } = await admin.approve(requestId, adminId);
    await auth.resetPasswordWithRecoveryToken(token, "a-new-password");

    await expect(admin.revoke(tokenId, adminId)).rejects.toThrow(
      /already used/,
    );
    const row = await admin.list({
      status: RecoveryRequestStatus.APPROVED,
      limit: 50,
      offset: 0,
    });
    expect(row.items.find(i => i.token?.id === tokenId)?.token?.status).toBe(
      "used",
    );
  });

  it("deny stores the note and audits it; the note is shown in the denied list", async () => {
    await auth.requestRecovery("ivy@example.com", "198.51.100.2");
    const requestId = String(
      (await RequestModel.findOne({ status: "pending" }).exec())?._id,
    );
    await admin.deny(requestId, adminId, "identity could not be confirmed");

    const denied = await admin.list({
      status: RecoveryRequestStatus.DENIED,
      limit: 50,
      offset: 0,
    });
    expect(denied.items[0].denyNote).toBe("identity could not be confirmed");
    expect(
      await LogModel.countDocuments({
        action: "recovery.deny",
        targetId: String(userId),
      }),
    ).toBe(1);
  });

  it("unknown link ids are 404, malformed ids are 400", async () => {
    await expect(
      admin.revoke(String(new Types.ObjectId()), adminId),
    ).rejects.toThrow(NotFoundException);
    await expect(admin.markSent("not-an-id", adminId)).rejects.toThrow(
      BadRequestException,
    );
  });

  it("recoveryTokenStatus: revoked and used win over expired", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const future = new Date("2026-06-02T00:00:00Z");
    const past = new Date("2026-05-31T00:00:00Z");
    expect(recoveryTokenStatus({ expiresAt: future }, now)).toBe("active");
    expect(recoveryTokenStatus({ expiresAt: past }, now)).toBe("expired");
    expect(recoveryTokenStatus({ expiresAt: past, usedAt: now }, now)).toBe(
      "used",
    );
    expect(recoveryTokenStatus({ expiresAt: past, revokedAt: now }, now)).toBe(
      "revoked",
    );
  });
});
