import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model, Types } from "mongoose";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { UnauthorizedException, NotFoundException } from "@nestjs/common";
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
import { AdminJwtStrategy } from "./admin-jwt.strategy";
import { AdminAccountsService } from "./admin-accounts.service";
import { AdminAuthService } from "./admin-auth.service";
import { hashPassword } from "src/utils/hash.util";
import { authenticator } from "otplib";
import { AdminJWTPayload } from "src/interface/base.interface";

const SECRET = "test-secret";

describe("Admin token revocation (server-side)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let AdminModel: Model<AdminUser>;
  let LogModel: Model<ModerationLog>;
  let jwt: JwtService;
  let strategy: AdminJwtStrategy;
  let accounts: AdminAccountsService;
  let adminId: Types.ObjectId;
  let mfaSecret: string;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    AdminModel = connection.model(AdminUser.name, AdminUserSchema);
    LogModel = connection.model(ModerationLog.name, ModerationLogSchema);
    jwt = new JwtService({ secret: SECRET });
    strategy = new AdminJwtStrategy(
      { get: () => SECRET } as unknown as ConfigService,
      AdminModel,
    );
    accounts = new AdminAccountsService(
      AdminModel,
      new ModerationLogService(LogModel),
    );
    mfaSecret = authenticator.generateSecret();
    const admin = await AdminModel.create({
      email: "boss@example.com",
      passwordHash: await hashPassword("pw-long-enough"),
      role: AdminRole.SUPERADMIN,
      mfaSecret,
    });
    adminId = admin._id;
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  const issue = async () => {
    const auth = new AdminAuthService(AdminModel, jwt);
    const { access_token } = await auth.login(
      "boss@example.com",
      "pw-long-enough",
      authenticator.generate(mfaSecret),
    );
    return access_token;
  };

  it("accepts a token issued at the current tokenVersion", async () => {
    const token = await issue();
    const payload = jwt.verify<AdminJWTPayload>(token, { secret: SECRET });
    await expect(strategy.validate(payload as never)).resolves.toMatchObject({
      adminId: String(adminId),
    });
  });

  it("rejects every token issued before a revoke, and accepts one issued after", async () => {
    const before = jwt.verify<AdminJWTPayload>(await issue(), {
      secret: SECRET,
    });

    await accounts.revokeTokens(String(adminId), String(adminId));

    await expect(strategy.validate(before as never)).rejects.toThrow(
      UnauthorizedException,
    );
    const after = jwt.verify<AdminJWTPayload>(await issue(), {
      secret: SECRET,
    });
    await expect(strategy.validate(after as never)).resolves.toBeDefined();
  });

  it("treats a token without tv (issued before this feature) as version 0", async () => {
    const legacy = {
      adminId: String(adminId),
      email: "boss@example.com",
      role: "superadmin",
      aud: "admin",
    };
    await AdminModel.updateOne(
      { _id: adminId },
      { $set: { tokenVersion: 0 } },
    ).exec();
    await expect(strategy.validate(legacy as never)).resolves.toBeDefined();
  });

  it("logs a self sign-out as admin.logout_all and another admin's revoke as admin.revoke_tokens", async () => {
    const other = await AdminModel.create({
      email: "other@example.com",
      passwordHash: "x",
      role: AdminRole.SUPPORT,
      mfaSecret: "x",
    });
    await accounts.revokeTokens(String(other._id), String(other._id));
    await accounts.revokeTokens(String(adminId), String(other._id));

    const selfRow = await LogModel.findOne({
      action: "admin.logout_all",
      targetId: String(other._id),
    }).lean();
    const revokeRow = await LogModel.findOne({
      action: "admin.revoke_tokens",
      targetId: String(other._id),
    }).lean();
    expect(selfRow?.actorId.toString()).toBe(String(other._id));
    expect(revokeRow?.actorId.toString()).toBe(String(adminId));
  });

  it("returns NotFound when revoking an unknown admin", async () => {
    await expect(
      accounts.revokeTokens(String(adminId), String(new Types.ObjectId())),
    ).rejects.toThrow(NotFoundException);
  });
});
