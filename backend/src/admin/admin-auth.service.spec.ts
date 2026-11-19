import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model } from "mongoose";
import { JwtService } from "@nestjs/jwt";
import { authenticator } from "otplib";
import {
  AdminUser,
  AdminUserSchema,
  AdminRole,
} from "./schema/admin-user.schema";
import { AdminAuthService } from "./admin-auth.service";
import { hashPassword } from "src/utils/hash.util";
import { AdminJWTPayload } from "src/interface/base.interface";

describe("AdminAuthService (B4: admin identities, MFA required on every login)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let AdminUserModel: Model<AdminUser>;
  let service: AdminAuthService;
  let jwtService: JwtService;
  let mfaSecret: string;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    AdminUserModel = connection.model(AdminUser.name, AdminUserSchema);

    jwtService = new JwtService({
      secret: "test-secret",
      signOptions: { expiresIn: "15m" },
    });
    service = new AdminAuthService(AdminUserModel, jwtService);

    mfaSecret = authenticator.generateSecret();
    await AdminUserModel.create({
      email: "admin@example.com",
      passwordHash: await hashPassword("correct-horse-battery"),
      role: AdminRole.SUPERADMIN,
      mfaSecret,
    });
  }, 90_000);

  beforeEach(() => {
    authenticator.options = { epoch: 1_700_000_000_000 };
  });

  afterEach(() => {
    authenticator.resetOptions();
  });

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  it("logs in with the right password + a valid current TOTP code", async () => {
    const code = authenticator.generate(mfaSecret);
    const result = await service.login(
      "admin@example.com",
      "correct-horse-battery",
      code,
    );
    expect(result.access_token).toEqual(expect.any(String));

    const payload = jwtService.verify<AdminJWTPayload>(result.access_token);
    expect(payload.aud).toBe("admin");
    expect(payload.role).toBe(AdminRole.SUPERADMIN);
  });

  it("rejects a wrong password even with a valid TOTP code", async () => {
    const code = authenticator.generate(mfaSecret);
    await expect(
      service.login("admin@example.com", "wrong-password", code),
    ).rejects.toThrow(/invalid credentials/i);
  });

  it("rejects a correct password with a wrong/missing TOTP code — no MFA bypass", async () => {
    await expect(
      service.login("admin@example.com", "correct-horse-battery", "000000"),
    ).rejects.toThrow(/invalid mfa code/i);
  });

  it("rejects a disabled admin even with correct credentials + TOTP", async () => {
    const secret = authenticator.generateSecret();
    await AdminUserModel.create({
      email: "disabled@example.com",
      passwordHash: await hashPassword("whatever-password"),
      role: AdminRole.SUPPORT,
      mfaSecret: secret,
      isDisabled: true,
    });
    const code = authenticator.generate(secret);
    await expect(
      service.login("disabled@example.com", "whatever-password", code),
    ).rejects.toThrow(/invalid credentials/i);
  });

  describe("per-account lockout (B4)", () => {
    let lockSecret: string;

    beforeEach(async () => {
      lockSecret = authenticator.generateSecret();
      await AdminUserModel.create({
        email: "locked@example.com",
        passwordHash: await hashPassword("lockout-password"),
        role: AdminRole.MODERATOR,
        mfaSecret: lockSecret,
      });
    });

    afterEach(async () => {
      await AdminUserModel.deleteOne({ email: "locked@example.com" }).exec();
    });

    it("locks the account after 5 failed attempts, even with the right credentials", async () => {
      for (let i = 0; i < 5; i++) {
        await expect(
          service.login("locked@example.com", "lockout-password", "000000"),
        ).rejects.toThrow(/invalid mfa code/i);
      }
      const code = authenticator.generate(lockSecret);
      await expect(
        service.login("locked@example.com", "lockout-password", code),
      ).rejects.toThrow(/too many failed login attempts/i);
    });

    it("clears the lock once it expires and resets the counter on success", async () => {
      await AdminUserModel.updateOne(
        { email: "locked@example.com" },
        {
          $set: {
            failedLoginAttempts: 4,
            lockedUntil: new Date(Date.now() - 1000),
          },
        },
      ).exec();

      const code = authenticator.generate(lockSecret);
      await service.login("locked@example.com", "lockout-password", code);

      const admin = await AdminUserModel.findOne({
        email: "locked@example.com",
      })
        .lean()
        .exec();
      expect(admin?.failedLoginAttempts).toBe(0);
      expect(admin?.lockedUntil).toBeNull();
    });

    it("does not count a successful login towards the lock", async () => {
      for (let i = 0; i < 4; i++) {
        await expect(
          service.login("locked@example.com", "wrong-password", "000000"),
        ).rejects.toThrow(/invalid credentials/i);
      }
      const code = authenticator.generate(lockSecret);
      await service.login("locked@example.com", "lockout-password", code);

      const admin = await AdminUserModel.findOne({
        email: "locked@example.com",
      })
        .lean()
        .exec();
      expect(admin?.failedLoginAttempts).toBe(0);
      expect(admin?.lockedUntil).toBeNull();
    });
  });

  it("rejects an unknown email", async () => {
    await expect(
      service.login("nobody@example.com", "whatever", "123456"),
    ).rejects.toThrow(/invalid credentials/i);
  });
});
