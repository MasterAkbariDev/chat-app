import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { PassportStrategy } from "@nestjs/passport";
import { Model } from "mongoose";
import { ExtractJwt, Strategy } from "passport-jwt";
import { JWTPayload } from "src/interface/base.interface";
import { User } from "src/user/schema/user.schema";
import { AuthService } from "./auth.service";
import { TokenCacheService } from "./token-cache.service";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor(
    configService: ConfigService,
    @InjectModel(User.name) private userService: Model<User>,
    private authService: AuthService,
    private tokenCache: TokenCacheService,
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

  async validate(payload: JWTPayload) {
    // A device signed out from another one: its access token is refused at once, not at expiry.
    if (payload.sid && (await this.authService.isSessionRevoked(payload.sid))) {
      throw new UnauthorizedException("This device was signed out");
    }
    // Redis-cached {tokenVersion, isDeleted} — falls back to Mongo only on a cache miss
    // (docs/plans/BACKEND_PLAN.md B4: "JwtStrategy does 0 Mongo reads on the hot path").
    let state = await this.tokenCache.get(payload.userId);
    if (!state) {
      const user = await this.userService
        .findOne({ _id: payload.userId })
        .select("isDeleted tokenVersion suspendedUntil")
        .exec();
      if (!user) {
        throw new UnauthorizedException("User no longer exists or is inactive");
      }
      state = {
        tokenVersion: user.tokenVersion ?? 0,
        isDeleted: user.isDeleted,
        suspendedUntil: user.suspendedUntil
          ? user.suspendedUntil.toISOString()
          : null,
      };
      await this.tokenCache.set(payload.userId, state);
    }
    if (state.isDeleted) {
      throw new UnauthorizedException("User no longer exists or is inactive");
    }
    if (
      state.suspendedUntil &&
      new Date(state.suspendedUntil).getTime() > Date.now()
    ) {
      throw new ForbiddenException("Your account is suspended");
    }
    this.authService.assertTokenVersion(
      { tokenVersion: state.tokenVersion },
      payload,
    );
    return {
      userId: payload.userId,
      email: payload.email,
      tokenVersion: payload.tokenVersion ?? 0,
    };
  }
}
