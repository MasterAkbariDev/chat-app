import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  Req,
  Res,
  BadRequestException,
  UnauthorizedException,
  Version,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from "express";
import {
  clearRefreshCookie,
  deliverRefreshToken,
  resolveRefreshToken,
} from "./refresh-cookie";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./auth.guard";
import { JWTPayload } from "src/interface/base.interface";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { CreateUserDto } from "src/user/dto/create-user.dto";
import { LoginDto } from "./dto/login.dto";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { RefreshDto } from "./dto/refresh.dto";
import {
  RecoveryRequestDto,
  RecoveryResetDto,
} from "./dto/recovery-request.dto";
import { Public } from "src/common/decorators/public.decorator";
import { ParseObjectIdPipe } from "src/common/pipes/parse-object-id.pipe";

function clientInfo(req: ExpressRequest): { device?: string; ip?: string } {
  return {
    device: req.headers["user-agent"],
    ip: req.ip,
  };
}

@ApiTags("Auth")
@Controller("auth")
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 3, ttl: 3_600_000 } })
  @Post("register")
  @ApiOperation({
    summary: "Register a new user",
    description:
      "Creates a new account. Required: email, username, password (min 6 characters). Optional: firstName, lastName, phoneNumber. Returns access_token, refresh_token, and user.",
  })
  @ApiBody({ type: CreateUserDto })
  @ApiResponse({ status: 201, description: "User registered successfully." })
  @ApiResponse({
    status: 400,
    description: "Invalid input or user already exists.",
  })
  async register(
    @Body() body: CreateUserDto,
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: ExpressResponse,
  ) {
    const session = await this.authService.register(body, clientInfo(req));
    return deliverRefreshToken(req, res, session);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("login")
  @ApiOperation({
    summary: "Login",
    description:
      "Authenticates with email or phone number and password. Returns access_token, refresh_token, and user info.",
  })
  @ApiBody({ type: LoginDto })
  @ApiResponse({
    status: 201,
    description:
      "Login successful; returns access_token, refresh_token, and user.",
  })
  @ApiResponse({ status: 400, description: "Invalid credentials." })
  async login(
    @Body() body: LoginDto,
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: ExpressResponse,
  ) {
    const user = await this.authService.validateUser(
      body?.phoneNumber || body?.email || "",
      body.password,
    );
    if (!user) {
      throw new BadRequestException("Invalid credentials");
    }
    const session = await this.authService.login(
      user as unknown as {
        _id: import("mongoose").Types.ObjectId;
        email: string;
        password?: string;
        [key: string]: unknown;
      },
      clientInfo(req),
    );
    return deliverRefreshToken(req, res, session);
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("refresh")
  @ApiOperation({
    summary: "Rotate a refresh token for a new access/refresh pair",
    description:
      "Single-use — reusing an already-rotated refresh token revokes every session in its family.",
  })
  @ApiBody({ type: RefreshDto })
  @ApiResponse({
    status: 201,
    description: "New access_token + refresh_token.",
  })
  @ApiResponse({
    status: 401,
    description: "Invalid, expired, or reused refresh token.",
  })
  async refresh(
    @Body() body: RefreshDto,
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: ExpressResponse,
  ) {
    const token = resolveRefreshToken(req, body.refresh_token);
    if (!token) throw new UnauthorizedException("No refresh token");
    try {
      const session = await this.authService.rotateRefreshToken(
        token,
        clientInfo(req),
      );
      return deliverRefreshToken(req, res, session);
    } catch (err) {
      // A rejected cookie is dead; drop it so the browser stops presenting it. Anything else
      // (a database hiccup) is transient and must not sign the user out.
      if (err instanceof UnauthorizedException) clearRefreshCookie(res);
      throw err;
    }
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("logout")
  @ApiOperation({
    summary: "Sign this device out",
    description:
      "Revokes the session of the given refresh token, so it leaves the signed-in devices list.",
  })
  @ApiBody({ type: RefreshDto })
  @ApiResponse({
    status: 201,
    description: "Session revoked (or already gone).",
  })
  async logout(
    @Body() body: RefreshDto,
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: ExpressResponse,
  ) {
    const token = resolveRefreshToken(req, body.refresh_token);
    if (token) await this.authService.revokeSessionByRefreshToken(token);
    clearRefreshCookie(res);
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @Post("profile")
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get current user profile",
    description:
      "Returns the profile of the authenticated user. Requires Bearer token.",
  })
  @ApiResponse({ status: 200, description: "User profile." })
  @ApiResponse({ status: 401, description: "Unauthorized." })
  getProfile(@Request() req: { user: JWTPayload }) {
    return this.authService.getProfile(req.user.email ?? null);
  }

  @Version("1")
  @UseGuards(JwtAuthGuard)
  @Get("me")
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get current user profile (replaces POST /auth/profile)",
  })
  getMe(@Request() req: { user: JWTPayload }) {
    return this.authService.getProfile(req.user.email ?? null);
  }

  @Version("1")
  @UseGuards(JwtAuthGuard)
  @Get("sessions")
  @ApiBearerAuth()
  @ApiOperation({ summary: "List this user's active refresh-token sessions" })
  listSessions(@Request() req: { user: JWTPayload }) {
    return this.authService.listSessions(req.user.userId);
  }

  @Version("1")
  @UseGuards(JwtAuthGuard)
  @Delete("sessions/:id")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Revoke one session by id" })
  async revokeSession(
    @Request() req: { user: JWTPayload },
    @Param("id", ParseObjectIdPipe) id: string,
  ) {
    await this.authService.revokeSession(req.user.userId, id);
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @Post("logout-all")
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Log out all other sessions",
    description:
      "Increments the user's token version and revokes every refresh-token session, then " +
      "returns a fresh access_token + refresh_token for this device.",
  })
  @ApiResponse({
    status: 201,
    description:
      "Sessions revoked; returns a new access_token + refresh_token for this client.",
  })
  @ApiResponse({ status: 401, description: "Unauthorized." })
  async logoutAll(
    @Request() req: { user: JWTPayload },
    @Req() rawReq: ExpressRequest,
    @Res({ passthrough: true }) res: ExpressResponse,
  ) {
    const session = await this.authService.revokeAllSessions(
      req.user.userId,
      clientInfo(rawReq),
    );
    return deliverRefreshToken(rawReq, res, session);
  }

  @Public()
  @Version("1")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("recovery-request")
  @ApiOperation({
    summary: "Request account recovery",
    description:
      "Surfaces in the admin panel for approval. Always returns the same generic response, " +
      "whether or not the identifier matches a real account.",
  })
  @ApiBody({ type: RecoveryRequestDto })
  async requestRecovery(
    @Body() body: RecoveryRequestDto,
    @Req() rawReq: ExpressRequest,
  ) {
    return this.authService.requestRecovery(
      body.identifier,
      clientInfo(rawReq).ip,
    );
  }

  @Public()
  @Version("1")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get("recovery/:token")
  @ApiOperation({ summary: "Check whether a recovery link is still valid" })
  async validateRecoveryToken(@Param("token") token: string) {
    return this.authService.validateRecoveryToken(token);
  }

  @Public()
  @Version("1")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("recovery/:token")
  @ApiOperation({
    summary: "Reset password using an admin-approved recovery link",
    description: "Single-use. Logs the account out everywhere on success.",
  })
  @ApiBody({ type: RecoveryResetDto })
  async resetPasswordWithRecoveryToken(
    @Param("token") token: string,
    @Body() body: RecoveryResetDto,
  ) {
    return this.authService.resetPasswordWithRecoveryToken(
      token,
      body.newPassword,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post("change-password")
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Change password",
    description:
      "Verifies the current password, sets a new one, invalidates other sessions, and returns a new access token for this device.",
  })
  @ApiBody({ type: ChangePasswordDto })
  @ApiResponse({
    status: 201,
    description: "Password changed; returns a new access_token.",
  })
  @ApiResponse({
    status: 400,
    description: "Invalid current password or input.",
  })
  @ApiResponse({ status: 401, description: "Unauthorized." })
  changePassword(
    @Request() req: { user: JWTPayload },
    @Body() body: ChangePasswordDto,
  ) {
    return this.authService.changePassword(
      req.user.userId,
      body.currentPassword,
      body.newPassword,
    );
  }
}
