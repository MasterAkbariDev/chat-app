import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Connection, Model } from "mongoose";
import { JwtService } from "@nestjs/jwt";
import { User, UserSchema } from "src/user/schema/user.schema";
import { Session, SessionSchema } from "./schema/session.schema";
import {
  RecoveryRequest,
  RecoveryRequestSchema,
} from "./schema/recovery-request.schema";
import {
  RecoveryToken,
  RecoveryTokenSchema,
} from "./schema/recovery-token.schema";
import { AuthService } from "./auth.service";
import { TokenCacheService } from "./token-cache.service";
import { hashPassword } from "src/utils/hash.util";
import { createHash } from "crypto";
import type { UserService } from "src/user/user.service";

describe("AuthService (B4: rotating refresh tokens + reuse detection)", () => {
  let mongod: MongoMemoryServer;
  let connection: Connection;
  let UserModel: Model<User>;
  let SessionModel: Model<Session>;
  let RecoveryRequestModel: Model<RecoveryRequest>;
  let RecoveryTokenModel: Model<RecoveryToken>;
  let service: AuthService;
  let userId: string;

  const fakeTokenCache = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn(),
    invalidate: jest.fn(),
    markFamilyRevoked: jest.fn(),
    isFamilyRevoked: jest.fn().mockResolvedValue(false),
  } as unknown as TokenCacheService;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    connection = await mongoose.createConnection(mongod.getUri()).asPromise();
    UserModel = connection.model(User.name, UserSchema);
    SessionModel = connection.model(Session.name, SessionSchema);
    RecoveryRequestModel = connection.model(
      RecoveryRequest.name,
      RecoveryRequestSchema,
    );
    RecoveryTokenModel = connection.model(
      RecoveryToken.name,
      RecoveryTokenSchema,
    );

    const fakeUserService = { userModel: UserModel } as unknown as UserService;
    service = new AuthService(
      fakeUserService,
      new JwtService({
        secret: "test-secret",
        signOptions: { expiresIn: "15m" },
      }),
      fakeTokenCache,
      SessionModel,
      RecoveryRequestModel,
      RecoveryTokenModel,
    );

    const user = await UserModel.create({
      username: "alice",
      email: "alice@example.com",
      password: "hashed",
    });
    userId = user._id.toString();
  }, 90_000);

  afterAll(async () => {
    await connection.close();
    await mongod.stop();
  });

  it("login issues a refresh token that can be rotated for a new pair", async () => {
    const user = await UserModel.findById(userId).exec();
    const session = await service.login(user! as never);

    expect(session.refresh_token).toEqual(expect.any(String));

    const rotated = await service.rotateRefreshToken(session.refresh_token);
    expect(rotated.access_token).toEqual(expect.any(String));
    expect(rotated.refresh_token).not.toBe(session.refresh_token);
  });

  it("reusing an already-rotated refresh token revokes the whole family", async () => {
    const user = await UserModel.findById(userId).exec();
    const session = await service.login(user! as never);
    const firstRaw = session.refresh_token;

    const rotated = await service.rotateRefreshToken(firstRaw);

    // Reusing the OLD (already-rotated) token is the attack this guards against.
    await expect(service.rotateRefreshToken(firstRaw)).rejects.toThrow(
      /reuse detected/i,
    );

    // The family is dead — even the token issued by the (legitimate) rotation above no longer works.
    await expect(
      service.rotateRefreshToken(rotated.refresh_token),
    ).rejects.toThrow(/invalid refresh token|reuse detected/i);
  });

  it("rejects an unknown refresh token", async () => {
    await expect(
      service.rotateRefreshToken("not-a-real-token"),
    ).rejects.toThrow(/invalid refresh token/i);
  });

  // Regression test: `userId` on Session is declared `@Prop({ type: Types.ObjectId })`, which
  // this codebase's Mongoose/NestJS versions resolve to a Mixed-typed path (not a real ObjectId
  // SchemaType), so passing a plain string here does NOT auto-cast the way it would for a normal
  // ObjectId path — every query against `sessionModel` by `userId` must cast explicitly with
  // `new Types.ObjectId(userId)`, matching the convention used elsewhere in this codebase.
  it("listSessions/revokeSession/revokeAllSessions find the caller's sessions by string userId", async () => {
    const user = await UserModel.create({
      username: "bob",
      email: "bob@example.com",
      password: "hashed",
    });
    const bobId = user._id.toString();

    await service.login(user as never);
    await service.login(user as never);

    const sessions = await service.listSessions(bobId);
    expect(sessions.length).toBe(2);

    const firstSessionDoc = await SessionModel.findOne({ userId: user._id })
      .sort({ createdAt: 1 })
      .exec();
    await service.revokeSession(bobId, firstSessionDoc!._id.toString());
    const afterRevoke = await service.listSessions(bobId);
    expect(afterRevoke.length).toBe(1);

    await service.revokeAllSessions(bobId);
    const afterRevokeAll = await service.listSessions(bobId);
    expect(afterRevokeAll.length).toBe(1); // the fresh session issued by revokeAllSessions itself
  });

  describe("validateUser (B4: per-account login lockout)", () => {
    it("locks the account after 5 failed attempts and rejects further tries even with the right password", async () => {
      const user = await UserModel.create({
        username: "carol",
        email: "carol@example.com",
        password: await hashPassword("correct-horse"),
      });

      for (let i = 0; i < 5; i++) {
        await expect(
          service.validateUser("carol@example.com", "wrong-password"),
        ).rejects.toThrow(/invalid credentials/i);
      }

      // Locked now — even the correct password is rejected until the lock expires.
      await expect(
        service.validateUser("carol@example.com", "correct-horse"),
      ).rejects.toThrow(/too many failed login attempts/i);

      const locked = await UserModel.findById(user._id).exec();
      expect(locked?.lockedUntil).toBeTruthy();
      expect(locked?.failedLoginAttempts).toBe(0);
    });

    it("a successful login resets the failed-attempt counter", async () => {
      await UserModel.create({
        username: "dave",
        email: "dave@example.com",
        password: await hashPassword("correct-horse"),
      });

      await expect(
        service.validateUser("dave@example.com", "wrong"),
      ).rejects.toThrow(/invalid credentials/i);
      await expect(
        service.validateUser("dave@example.com", "wrong"),
      ).rejects.toThrow(/invalid credentials/i);

      const validated = await service.validateUser(
        "dave@example.com",
        "correct-horse",
      );
      expect(validated).toBeTruthy();

      const user = await UserModel.findOne({
        email: "dave@example.com",
      }).exec();
      expect(user?.failedLoginAttempts).toBe(0);
      expect(user?.lockedUntil).toBeNull();
    });
  });

  describe("password-recovery link flow (B4 Q1)", () => {
    it("requestRecovery creates a pending request only for a real account, but always returns ok", async () => {
      const user = await UserModel.create({
        username: "erin",
        email: "erin@example.com",
        password: "hashed",
      });

      await expect(
        service.requestRecovery("erin@example.com"),
      ).resolves.toEqual({ ok: true });
      await expect(
        service.requestRecovery("nobody-with-this-email@example.com"),
      ).resolves.toEqual({ ok: true }); // identical response — no account enumeration

      const requests = await RecoveryRequestModel.find({
        userId: user._id,
      }).exec();
      expect(requests).toHaveLength(1);
      expect(requests[0].status).toBe("pending");
    });

    it("approve mints a token that resets the password and logs the user out everywhere", async () => {
      const user = await UserModel.create({
        username: "frank",
        email: "frank@example.com",
        password: await hashPassword("old-password"),
      });
      await service.login(user as never); // an active session to confirm gets revoked

      await service.requestRecovery("frank@example.com");
      const request = await RecoveryRequestModel.findOne({
        userId: user._id,
      }).exec();

      const adminId = new mongoose.Types.ObjectId().toString();
      const { token } = await service.approveRecoveryRequest(
        request!._id.toString(),
        adminId,
      );

      await expect(service.validateRecoveryToken(token)).resolves.toEqual({
        valid: true,
      });

      await expect(
        service.resetPasswordWithRecoveryToken(token, "brand-new-password"),
      ).resolves.toEqual({ ok: true });

      // Single-use: the same token can't be used again.
      await expect(service.validateRecoveryToken(token)).resolves.toEqual({
        valid: false,
      });
      await expect(
        service.resetPasswordWithRecoveryToken(token, "another-password"),
      ).rejects.toThrow(/invalid or expired/i);

      const sessions = await service.listSessions(user._id.toString());
      expect(sessions).toHaveLength(0); // every session revoked
    });

    it("deny marks the request denied and mints no token", async () => {
      const user = await UserModel.create({
        username: "grace",
        email: "grace@example.com",
        password: "hashed",
      });
      await service.requestRecovery("grace@example.com");
      const request = await RecoveryRequestModel.findOne({
        userId: user._id,
      }).exec();

      const adminId = new mongoose.Types.ObjectId().toString();
      await expect(
        service.denyRecoveryRequest(
          request!._id.toString(),
          adminId,
          "not you",
        ),
      ).resolves.toEqual({ userId: String(user._id) });

      const updated = await RecoveryRequestModel.findById(request!._id).exec();
      expect(updated?.status).toBe("denied");
      expect(updated?.denyNote).toBe("not you");
      expect(
        await RecoveryTokenModel.countDocuments({ userId: user._id }),
      ).toBe(0);

      // Can't approve/deny an already-reviewed request.
      await expect(
        service.approveRecoveryRequest(request!._id.toString(), adminId),
      ).rejects.toThrow(/not found or already reviewed/i);
    });

    it("an expired token is rejected", async () => {
      const user = await UserModel.create({
        username: "henry",
        email: "henry@example.com",
        password: "hashed",
      });
      const raw = "EXPIREDTOK";
      await RecoveryTokenModel.create({
        tokenHash: createHash("sha256").update(raw).digest("hex"),
        userId: user._id,
        expiresAt: new Date(Date.now() - 1000),
      });

      await expect(service.validateRecoveryToken(raw)).resolves.toEqual({
        valid: false,
      });
      await expect(
        service.resetPasswordWithRecoveryToken(raw, "new-password"),
      ).rejects.toThrow(/invalid or expired/i);
    });
  });

  describe("validateUser (B10: suspended-user enforcement)", () => {
    it("blocks login for a currently-suspended user, even with the correct password", async () => {
      await UserModel.create({
        username: "isaac",
        email: "isaac@example.com",
        password: await hashPassword("correct-password"),
        suspendedUntil: new Date(Date.now() + 60_000),
      });

      await expect(
        service.validateUser("isaac@example.com", "correct-password"),
      ).rejects.toThrow(/suspended/i);
    });

    it("allows login again once the suspension has expired", async () => {
      await UserModel.create({
        username: "julia",
        email: "julia@example.com",
        password: await hashPassword("correct-password"),
        suspendedUntil: new Date(Date.now() - 1000), // already in the past
      });

      await expect(
        service.validateUser("julia@example.com", "correct-password"),
      ).resolves.toBeTruthy();
    });
  });
});
