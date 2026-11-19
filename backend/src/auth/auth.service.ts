import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { EventEmitter2 } from "eventemitter2";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { randomBytes, createHash } from "crypto";
import { UserService } from "src/user/user.service";
import { JWTPayload } from "src/interface/base.interface";
import { comparePassword, hashPassword } from "src/utils/hash.util";
import { CreateUserDto } from "src/user/dto/create-user.dto";
import { User } from "src/user/schema/user.schema";
import { Session } from "./schema/session.schema";
import {
  RecoveryRequest,
  RecoveryRequestStatus,
} from "./schema/recovery-request.schema";
import { RecoveryToken } from "./schema/recovery-token.schema";
import { SessionDto } from "src/common/dto/session.dto";
import { toMeDto } from "src/common/dto/user-view.dto";
import { TokenCacheService } from "./token-cache.service";

const hashToken = (raw: string) =>
  createHash("sha256").update(raw).digest("hex");

// Per-account login lockout (B4) — on top of B0's IP-based throttler, which doesn't stop a
// distributed attempt (many IPs) against one specific account.
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

// Password-recovery link (B4 Q1). 45 min is generous enough for an admin to send the link out
// of band and the user to act on it, short enough to bound a leaked-link's window.
const RECOVERY_TOKEN_TTL_MS = 45 * 60 * 1000;
// Crockford's alphabet — no 0/O, 1/I/L ambiguity, safe to read aloud or retype by hand.
const BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function randomBase32(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += BASE32_ALPHABET[bytes[i] % BASE32_ALPHABET.length];
  }
  return out;
}

@Injectable()
export class AuthService {
  constructor(
    private userService: UserService,
    private jwtService: JwtService,
    private tokenCache: TokenCacheService,
    @InjectModel(Session.name) private sessionModel: Model<Session>,
    @InjectModel(RecoveryRequest.name)
    private recoveryRequestModel: Model<RecoveryRequest>,
    @InjectModel(RecoveryToken.name)
    private recoveryTokenModel: Model<RecoveryToken>,
    @Optional() private eventEmitter?: EventEmitter2,
  ) {}

  buildPayload(user: {
    _id: Types.ObjectId;
    email: string;
    tokenVersion?: number;
  }): JWTPayload {
    return {
      userId: user._id.toString(),
      email: user.email,
      tokenVersion: user.tokenVersion ?? 0,
    };
  }

  /** `sid` ties the access token to its session family, so revoking that device cuts it off at once. */
  signToken(
    user: { _id: Types.ObjectId; email: string; tokenVersion?: number },
    sid?: string,
  ): string {
    const payload = this.buildPayload(user);
    return this.jwtService.sign(sid ? { ...payload, sid } : payload);
  }

  /** A device's access is cut off: its family is marked (for as long as an access token can live) and its
   *  open sockets are told to disconnect. */
  async revokeFamilyAccess(familyId: string): Promise<void> {
    await this.tokenCache.markFamilyRevoked(familyId);
    this.eventEmitter?.emit("auth.session_revoked", { familyId });
  }

  isSessionRevoked(familyId: string): Promise<boolean> {
    return this.tokenCache.isFamilyRevoked(familyId);
  }

  assertTokenVersion(
    user: Pick<User, "tokenVersion">,
    payload: JWTPayload,
  ): void {
    const current = user.tokenVersion ?? 0;
    const inToken = payload.tokenVersion ?? 0;
    if (inToken !== current) {
      throw new UnauthorizedException("Session expired. Please sign in again.");
    }
  }

  async incrementTokenVersion(userId: string): Promise<number> {
    const user = await this.userService.userModel
      .findOneAndUpdate(
        { _id: userId, isDeleted: false },
        { $inc: { tokenVersion: 1 } },
        { new: true },
      )
      .select("tokenVersion email")
      .exec();
    if (!user) {
      throw new UnauthorizedException("User not found");
    }
    await this.tokenCache.invalidate(userId);
    return user.tokenVersion ?? 0;
  }

  /**
   * Creates a brand-new refresh-token family (a fresh login, not a rotation) and returns the
   * raw token — only the SHA-256 hash is ever persisted.
   */
  private async issueSession(
    userId: string,
    opts: { device?: string; ip?: string } = {},
  ): Promise<{ raw: string; familyId: string }> {
    const raw = randomBytes(32).toString("hex");
    const familyId = randomBytes(16).toString("hex");
    await this.sessionModel.create({
      userId: new Types.ObjectId(userId),
      refreshTokenHash: hashToken(raw),
      familyId,
      device: opts.device ?? null,
      ip: opts.ip ?? null,
    });
    return { raw, familyId };
  }

  /**
   * Rotates a refresh token: the presented raw token must match an unrevoked session row.
   * Presenting an already-rotated (revoked) token is reuse — the whole family is revoked
   * immediately (docs/plans/BACKEND_PLAN.md B4).
   */
  async rotateRefreshToken(
    rawToken: string,
    opts: { device?: string; ip?: string } = {},
  ): Promise<SessionDto> {
    const hash = hashToken(rawToken);
    const session = await this.sessionModel
      .findOne({ refreshTokenHash: hash })
      .exec();
    if (!session) {
      throw new UnauthorizedException("Invalid refresh token");
    }
    if (session.revokedAt) {
      // Reuse of a token already rotated away — treat as a stolen token, kill the family.
      await this.sessionModel.updateMany(
        { familyId: session.familyId, revokedAt: null },
        { $set: { revokedAt: new Date() } },
      );
      throw new UnauthorizedException(
        "Refresh token reuse detected — all sessions revoked, please sign in again",
      );
    }

    const user = await this.userService.userModel
      .findOne({ _id: session.userId, isDeleted: false })
      .exec();
    if (!user) {
      throw new UnauthorizedException("User not found");
    }

    const newRaw = randomBytes(32).toString("hex");
    session.revokedAt = new Date();
    session.lastUsedAt = new Date();
    await session.save();
    await this.sessionModel.create({
      userId: user._id,
      refreshTokenHash: hashToken(newRaw),
      familyId: session.familyId,
      device: opts.device ?? session.device,
      ip: opts.ip ?? session.ip,
    });

    return {
      access_token: this.signToken(user, session.familyId),
      refresh_token: newRaw,
      user: toMeDto(user),
    };
  }

  async listSessions(userId: string) {
    return this.sessionModel
      .find({ userId: new Types.ObjectId(userId), revokedAt: null })
      .select("device ip createdAt lastUsedAt")
      .sort({ lastUsedAt: -1 })
      .lean()
      .exec();
  }

  /** The device signing itself out: revokes the session its refresh token belongs to. */
  async revokeSessionByRefreshToken(rawRefreshToken: string): Promise<void> {
    const row = await this.sessionModel
      .findOneAndUpdate(
        { refreshTokenHash: hashToken(rawRefreshToken), revokedAt: null },
        { $set: { revokedAt: new Date() } },
      )
      .lean()
      .exec();
    if (row) await this.revokeFamilyAccess(row.familyId);
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const row = await this.sessionModel
      .findOneAndUpdate(
        { _id: sessionId, userId: new Types.ObjectId(userId), revokedAt: null },
        { $set: { revokedAt: new Date() } },
      )
      .lean()
      .exec();
    if (row) await this.revokeFamilyAccess(row.familyId);
  }

  /** Invalidate all existing tokens/sessions and issue a fresh pair for this device. */
  async revokeAllSessions(
    userId: string,
    opts: { device?: string; ip?: string } = {},
  ): Promise<{ access_token: string; refresh_token: string }> {
    await this.incrementTokenVersion(userId);
    await this.sessionModel.updateMany(
      { userId: new Types.ObjectId(userId), revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    const user = await this.userService.userModel
      .findOne({ _id: userId, isDeleted: false })
      .select("email tokenVersion")
      .exec();
    if (!user) {
      throw new UnauthorizedException("User not found");
    }
    const session = await this.issueSession(userId, opts);
    return {
      access_token: this.signToken(
        { _id: user._id, email: user.email, tokenVersion: user.tokenVersion },
        session.familyId,
      ),
      refresh_token: session.raw,
    };
  }

  async validateUser(emailOrPhone: string, pass: string) {
    if (!emailOrPhone || !pass) {
      throw new BadRequestException("Invalid credentials");
    }
    const user = await this.userService.userModel.findOne({
      $or: [{ email: emailOrPhone }, { phoneNumber: emailOrPhone }],
      isDeleted: false,
    });

    if (
      !user ||
      typeof user !== "object" ||
      !("password" in user) ||
      !user.password
    ) {
      return null;
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const minutesLeft = Math.ceil(
        (user.lockedUntil.getTime() - Date.now()) / 60_000,
      );
      throw new ForbiddenException(
        `Too many failed login attempts. Try again in ${minutesLeft} minute(s).`,
      );
    }
    if (user.suspendedUntil && user.suspendedUntil.getTime() > Date.now()) {
      throw new ForbiddenException("Your account is suspended");
    }

    const isMatch = await comparePassword(pass, user.password);
    if (!isMatch) {
      const attempts = (user.failedLoginAttempts ?? 0) + 1;
      const locked = attempts >= MAX_FAILED_LOGIN_ATTEMPTS;
      await this.userService.userModel
        .updateOne(
          { _id: user._id },
          {
            $set: {
              // Reset to 0 the moment a lock is applied — the next window starts fresh once
              // lockedUntil expires, rather than the counter creeping ever higher.
              failedLoginAttempts: locked ? 0 : attempts,
              lockedUntil: locked
                ? new Date(Date.now() + LOCKOUT_DURATION_MS)
                : null,
            },
          },
        )
        .exec();
      throw new BadRequestException("Invalid credentials");
    }

    if (user.failedLoginAttempts || user.lockedUntil) {
      await this.userService.userModel
        .updateOne(
          { _id: user._id },
          { $set: { failedLoginAttempts: 0, lockedUntil: null } },
        )
        .exec();
    }

    return user;
  }

  async login(
    user: {
      _id: Types.ObjectId;
      email: string;
      tokenVersion?: number;
      password?: string;
      [key: string]: unknown;
    },
    opts: { device?: string; ip?: string } = {},
  ): Promise<SessionDto> {
    // Map to MeDto explicitly — never pass the Mongoose document (or its `._doc`) through
    // directly, since that leaks `password`/`tokenVersion` (this previously shipped the
    // bcrypt hash to the client). See docs/plans/BACKEND_PLAN.md B1.
    const session = await this.issueSession(user._id.toString(), opts);
    return {
      access_token: this.signToken(user, session.familyId),
      refresh_token: session.raw,
      user: toMeDto(user),
    };
  }

  async register(
    data: CreateUserDto,
    opts: { device?: string; ip?: string } = {},
  ): Promise<SessionDto> {
    const newUser = await this.userService.create(data);
    const session = await this.issueSession(newUser._id.toString(), opts);
    return {
      access_token: this.signToken(newUser, session.familyId),
      refresh_token: session.raw,
      user: toMeDto(newUser),
    };
  }

  async getProfile(email: string | null): Promise<ReturnType<typeof toMeDto>> {
    if (!email) {
      throw new UnauthorizedException("Invalid credentials");
    }
    const user = await this.userService.findByEmail(email);
    if (!user) {
      throw new UnauthorizedException("Invalid credentials");
    }
    return toMeDto(user);
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ access_token: string }> {
    if (currentPassword === newPassword) {
      throw new BadRequestException(
        "New password must be different from the current password",
      );
    }

    const user = await this.userService.userModel
      .findOne({ _id: userId, isDeleted: false })
      .select("password email tokenVersion")
      .exec();
    if (!user?.password) {
      throw new UnauthorizedException("User not found");
    }

    const valid = await comparePassword(currentPassword, user.password);
    if (!valid) {
      throw new BadRequestException("Current password is incorrect");
    }

    const hashed = await hashPassword(newPassword);
    const updated = await this.userService.userModel
      .findOneAndUpdate(
        { _id: userId, isDeleted: false },
        { $set: { password: hashed }, $inc: { tokenVersion: 1 } },
        { new: true },
      )
      .select("email tokenVersion")
      .exec();
    if (!updated) {
      throw new UnauthorizedException("User not found");
    }
    await this.tokenCache.invalidate(userId);

    return {
      access_token: this.signToken({
        _id: updated._id,
        email: updated.email,
        tokenVersion: updated.tokenVersion,
      }),
    };
  }

  issueTokenForUserId(userId: string): Promise<string | null> {
    return this.userService.userModel
      .findOne({ _id: userId, isDeleted: false })
      .select("email tokenVersion")
      .exec()
      .then(user => {
        if (!user) return null;
        return this.signToken(user);
      });
  }

  /**
   * "Please help me get back into my account" (B4 Q1). Always returns the same generic
   * response, whether or not `identifier` matches a real account — the point of this endpoint
   * is that a stranger can't use it to confirm an account exists.
   */
  async requestRecovery(
    identifier: string,
    ip?: string,
  ): Promise<{ ok: true }> {
    const user = await this.userService.userModel
      .findOne({
        $or: [{ email: identifier }, { username: identifier }],
        isDeleted: false,
      })
      .select("_id")
      .exec();
    if (user) {
      await this.recoveryRequestModel.create({
        userId: user._id,
        status: RecoveryRequestStatus.PENDING,
        ip: ip ?? null,
      });
    }
    return { ok: true };
  }

  async listPendingRecoveryRequests() {
    return this.recoveryRequestModel
      .find({ status: RecoveryRequestStatus.PENDING })
      .populate("userId", "username firstName lastName email")
      .sort({ createdAt: 1 })
      .lean()
      .exec();
  }

  /** Mints the short opaque link an admin copies and sends the user out of band. */
  async approveRecoveryRequest(
    requestId: string,
    adminId: string,
  ): Promise<{
    tokenId: string;
    token: string;
    expiresAt: string;
    userId: string;
  }> {
    const request = await this.recoveryRequestModel
      .findOne({ _id: requestId, status: RecoveryRequestStatus.PENDING })
      .exec();
    if (!request) {
      throw new NotFoundException(
        "Recovery request not found or already reviewed",
      );
    }

    const raw = randomBase32(10);
    const expiresAt = new Date(Date.now() + RECOVERY_TOKEN_TTL_MS);
    const created = await this.recoveryTokenModel.create({
      tokenHash: hashToken(raw),
      userId: request.userId,
      expiresAt,
      recoveryRequestId: request._id,
      issuedBy: new Types.ObjectId(adminId),
    });

    request.status = RecoveryRequestStatus.APPROVED;
    request.reviewedBy = new Types.ObjectId(adminId);
    request.reviewedAt = new Date();
    await request.save();

    return {
      tokenId: String(created._id),
      token: raw,
      expiresAt: expiresAt.toISOString(),
      userId: String(request.userId),
    };
  }

  async denyRecoveryRequest(
    requestId: string,
    adminId: string,
    note?: string,
  ): Promise<{ userId: string }> {
    const request = await this.recoveryRequestModel
      .findOneAndUpdate(
        { _id: requestId, status: RecoveryRequestStatus.PENDING },
        {
          $set: {
            status: RecoveryRequestStatus.DENIED,
            reviewedBy: new Types.ObjectId(adminId),
            reviewedAt: new Date(),
            denyNote: note ?? null,
          },
        },
        { new: true },
      )
      .select("userId")
      .lean()
      .exec();
    if (!request) {
      throw new NotFoundException(
        "Recovery request not found or already reviewed",
      );
    }
    return { userId: String(request.userId) };
  }

  async validateRecoveryToken(rawToken: string): Promise<{ valid: boolean }> {
    const token = await this.recoveryTokenModel
      .findOne({ tokenHash: hashToken(rawToken) })
      .exec();
    const valid =
      !!token &&
      !token.usedAt &&
      !token.revokedAt &&
      token.expiresAt.getTime() > Date.now();
    return { valid };
  }

  /** Resets the password, bumps tokenVersion, and revokes every session — "logs the user out
   *  everywhere" (B4 acceptance). Single-use: the token is marked used immediately after. */
  async resetPasswordWithRecoveryToken(
    rawToken: string,
    newPassword: string,
  ): Promise<{ ok: true }> {
    const token = await this.recoveryTokenModel
      .findOne({ tokenHash: hashToken(rawToken) })
      .exec();
    if (
      !token ||
      token.usedAt ||
      token.revokedAt ||
      token.expiresAt.getTime() <= Date.now()
    ) {
      throw new UnauthorizedException("Invalid or expired recovery link");
    }

    const hashed = await hashPassword(newPassword);
    await this.userService.userModel
      .updateOne(
        { _id: token.userId },
        { $set: { password: hashed }, $inc: { tokenVersion: 1 } },
      )
      .exec();
    await this.tokenCache.invalidate(token.userId.toString());
    await this.sessionModel.updateMany(
      { userId: token.userId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );

    token.usedAt = new Date();
    await token.save();
    return { ok: true };
  }
}
