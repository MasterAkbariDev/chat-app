import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { JwtService } from "@nestjs/jwt";
import { authenticator } from "otplib";
import { AdminUser } from "./schema/admin-user.schema";
import { AdminJWTPayload } from "src/interface/base.interface";
import { comparePassword } from "src/utils/hash.util";

/** Longer-lived than a user access token (15 min) — admins have no refresh-rotation flow yet
 *  (not required by this phase's acceptance criteria); see README's "not done" note. */
const ADMIN_TOKEN_TTL = "12h";

// Per-account lockout, same numbers as the user login (AuthService). The IP throttler on the
// route does not stop a distributed attempt against one admin account.
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

@Injectable()
export class AdminAuthService {
  constructor(
    @InjectModel(AdminUser.name) private adminUserModel: Model<AdminUser>,
    private jwtService: JwtService,
  ) {}

  private buildPayload(admin: {
    _id: unknown;
    email: string;
    role: string;
    tokenVersion?: number;
  }): AdminJWTPayload {
    return {
      adminId: String(admin._id),
      email: admin.email,
      role: admin.role,
      aud: "admin",
      tv: admin.tokenVersion ?? 0,
    };
  }

  /** Counts one failed attempt; the lock is applied once the threshold is reached. */
  private async recordFailedAttempt(adminId: unknown, current: number) {
    const attempts = current + 1;
    const locked = attempts >= MAX_FAILED_LOGIN_ATTEMPTS;
    await this.adminUserModel
      .updateOne(
        { _id: adminId },
        {
          $set: {
            // Reset as soon as a lock is applied, so the next window starts fresh.
            failedLoginAttempts: locked ? 0 : attempts,
            lockedUntil: locked
              ? new Date(Date.now() + LOCKOUT_DURATION_MS)
              : null,
          },
        },
      )
      .exec();
  }

  /** MFA is required on every login (B4 acceptance) — not optional, no bypass. */
  async login(
    email: string,
    password: string,
    totpCode: string,
  ): Promise<{ access_token: string }> {
    const admin = await this.adminUserModel
      .findOne({ email: email.toLowerCase().trim() })
      .exec();
    if (!admin || admin.isDisabled) {
      throw new UnauthorizedException("Invalid credentials");
    }

    if (admin.lockedUntil && admin.lockedUntil.getTime() > Date.now()) {
      const minutesLeft = Math.ceil(
        (admin.lockedUntil.getTime() - Date.now()) / 60_000,
      );
      throw new ForbiddenException(
        `Too many failed login attempts. Try again in ${minutesLeft} minute(s).`,
      );
    }

    const validPassword = await comparePassword(password, admin.passwordHash);
    if (!validPassword) {
      await this.recordFailedAttempt(admin._id, admin.failedLoginAttempts ?? 0);
      throw new UnauthorizedException("Invalid credentials");
    }

    const valid = authenticator.check(totpCode, admin.mfaSecret);
    if (!valid) {
      await this.recordFailedAttempt(admin._id, admin.failedLoginAttempts ?? 0);
      throw new UnauthorizedException("Invalid MFA code");
    }

    if (admin.failedLoginAttempts || admin.lockedUntil) {
      await this.adminUserModel
        .updateOne(
          { _id: admin._id },
          { $set: { failedLoginAttempts: 0, lockedUntil: null } },
        )
        .exec();
    }

    return {
      access_token: this.jwtService.sign(this.buildPayload(admin), {
        expiresIn: ADMIN_TOKEN_TTL,
      }),
    };
  }
}
