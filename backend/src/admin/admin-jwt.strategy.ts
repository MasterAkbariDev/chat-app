import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { PassportStrategy } from "@nestjs/passport";
import { Model } from "mongoose";
import { ExtractJwt, Strategy } from "passport-jwt";
import { AdminJWTPayload } from "src/interface/base.interface";
import { AdminUser } from "./schema/admin-user.schema";

/**
 * A separate named strategy ("admin-jwt") from the regular user "jwt" one — a request needs a
 * token this strategy accepts, not merely a well-formed JWT, to reach an admin route (B4:
 * "admin JWT audience separate from user JWT"). Same signing secret; `aud: "admin"` is the
 * claim that actually separates the two, checked explicitly below rather than assumed.
 */
@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, "admin-jwt") {
  constructor(
    configService: ConfigService,
    @InjectModel(AdminUser.name) private adminUserModel: Model<AdminUser>,
  ) {
    const secret = configService.get<string>("JWT_SECRET");
    if (!secret) {
      throw new Error("JWT_SECRET is not defined");
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  async validate(payload: AdminJWTPayload) {
    if (payload.aud !== "admin") {
      throw new UnauthorizedException("Not an admin token");
    }
    const admin = await this.adminUserModel
      .findOne({ _id: payload.adminId, isDisabled: false })
      .select("email role tokenVersion")
      .exec();
    if (!admin) {
      throw new UnauthorizedException("Admin no longer exists or is disabled");
    }
    // Server-side revocation: a token issued before the admin's tokenVersion was bumped is void.
    if ((payload.tv ?? 0) !== (admin.tokenVersion ?? 0)) {
      throw new UnauthorizedException("Admin session was revoked");
    }
    return { adminId: payload.adminId, email: admin.email, role: admin.role };
  }
}
