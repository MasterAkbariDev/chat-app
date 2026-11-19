import { Module, forwardRef } from "@nestjs/common";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtModule } from "@nestjs/jwt";
import { JwtStrategy } from "./jwt.strategy";
import { UserModule } from "src/user/user.module";
import { PassportModule } from "@nestjs/passport";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { MongooseModule } from "@nestjs/mongoose";
import { Session, SessionSchema } from "./schema/session.schema";
import {
  RecoveryRequest,
  RecoveryRequestSchema,
} from "./schema/recovery-request.schema";
import {
  RecoveryToken,
  RecoveryTokenSchema,
} from "./schema/recovery-token.schema";
import { TokenCacheModule } from "./token-cache.module";

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>("JWT_SECRET"),
        // Short-lived access token (B4) — the refresh token (opaque, rotated, in `sessions`)
        // is what actually stays valid for a while.
        signOptions: { expiresIn: "15m" },
      }),
    }),
    PassportModule,
    MongooseModule.forFeature([
      { name: Session.name, schema: SessionSchema },
      { name: RecoveryRequest.name, schema: RecoveryRequestSchema },
      { name: RecoveryToken.name, schema: RecoveryTokenSchema },
    ]),
    TokenCacheModule,
    forwardRef(() => UserModule),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [JwtModule, JwtStrategy, AuthService],
})
export class AuthModule {}
