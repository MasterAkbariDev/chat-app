import {
  Body,
  Controller,
  Post,
  Get,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Public } from "src/common/decorators/public.decorator";
import { AllExceptionsFilter } from "src/common/filters/all-exceptions.filter";
import { AdminAuthService } from "./admin-auth.service";
import { AdminJwtAuthGuard } from "./admin-jwt.guard";
import { AdminLoginDto } from "./dto/admin-login.dto";

interface AdminRequest {
  user: { adminId: string; email: string; role: string };
}

/**
 * All routes here are `@Public()` at the class level — that only skips the *global* user
 * `JwtAuthGuard`. Every route except login re-applies its own `AdminJwtAuthGuard`, which
 * requires a real admin-audience token; login has none since there's no token yet at that point.
 */
@ApiTags("Admin")
@Controller({ path: "admin", version: "1" })
@Public()
@UseFilters(AllExceptionsFilter)
export class AdminAuthController {
  constructor(private adminAuthService: AdminAuthService) {}

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("auth/login")
  @ApiOperation({
    summary: "Admin login (MFA required)",
    description:
      "Password + a valid 6-digit TOTP code, every time — no MFA bypass.",
  })
  @ApiBody({ type: AdminLoginDto })
  login(@Body() body: AdminLoginDto) {
    return this.adminAuthService.login(
      body.email,
      body.password,
      body.totpCode,
    );
  }

  @UseGuards(AdminJwtAuthGuard)
  @ApiBearerAuth()
  @Get("auth/me")
  @ApiOperation({
    summary: "The signed-in admin",
    description:
      "Returned from the admin-jwt strategy, which also checks the admin still exists and is enabled.",
  })
  me(@Req() req: AdminRequest) {
    return {
      adminId: req.user.adminId,
      email: req.user.email,
      role: req.user.role,
    };
  }
}
