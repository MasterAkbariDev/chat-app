import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";

export enum AdminRole {
  SUPERADMIN = "superadmin",
  SUPPORT = "support",
  MODERATOR = "moderator",
}

/**
 * A separate identity from `user` (B4, docs/plans/BACKEND_PLAN.md) — an admin never has a
 * regular-user document, and a regular user is never promoted in place. `mfaSecret` is a
 * Base32 TOTP secret (otplib) — MFA is required on every admin login, not optional. Bootstrapped
 * with `scripts/seed-admin.ts`; there is no public "register admin" endpoint.
 */
@Schema({ collection: "admin_users", timestamps: true, versionKey: false })
export class AdminUser {
  _id: Types.ObjectId;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ required: true })
  passwordHash: string;

  @Prop({ required: true, enum: AdminRole })
  role: AdminRole;

  @Prop({ required: true })
  mfaSecret: string;

  @Prop({ default: false })
  isDisabled: boolean;

  /**
   * Per-account lockout, mirroring the user login (B4). Counts failed password *and* TOTP
   * attempts, since both are guesses against the same account. Cleared on a successful login.
   */
  @Prop({ type: Number, default: 0 })
  failedLoginAttempts: number;

  @Prop({ type: Date, default: null })
  lockedUntil: Date | null;

  /**
   * Bumped to revoke every admin token issued so far (sign out everywhere, or a superadmin
   * revoking another admin). Each token carries the value it was issued with (`tv`); the
   * strategy rejects any token whose `tv` no longer matches.
   */
  @Prop({ type: Number, default: 0 })
  tokenVersion: number;

  createdAt: Date;
  updatedAt: Date;
}

export const AdminUserSchema = SchemaFactory.createForClass(AdminUser);
