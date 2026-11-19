import {
  Controller,
  Param,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { Public } from "src/common/decorators/public.decorator";
import { ParseObjectIdPipe } from "src/common/pipes/parse-object-id.pipe";
import { AllExceptionsFilter } from "src/common/filters/all-exceptions.filter";
import { AdminJwtAuthGuard } from "./admin-jwt.guard";
import { AdminRoles } from "./admin-roles.decorator";
import { AdminRolesGuard } from "./admin-roles.guard";
import { AdminAccountsService } from "./admin-accounts.service";
import { AdminRole } from "./schema/admin-user.schema";

interface AdminRequest {
  user: { adminId: string; email: string; role: string };
}

@ApiTags("Admin — Accounts")
@Controller({ path: "admin", version: "1" })
@Public()
@UseGuards(AdminJwtAuthGuard, AdminRolesGuard)
@UseFilters(AllExceptionsFilter)
@ApiBearerAuth()
export class AdminAccountsController {
  constructor(private adminAccounts: AdminAccountsService) {}

  @Post("auth/logout-all")
  @ApiOperation({ summary: "Sign out every admin session, including this one" })
  logoutAll(@Req() req: AdminRequest) {
    return this.adminAccounts.revokeTokens(req.user.adminId, req.user.adminId);
  }

  @Post("admins/:id/revoke-tokens")
  @AdminRoles(AdminRole.SUPERADMIN)
  @ApiOperation({
    summary: "Revoke every token of another admin (superadmin only)",
  })
  @ApiParam({ name: "id" })
  revokeTokens(
    @Param("id", ParseObjectIdPipe) id: string,
    @Req() req: AdminRequest,
  ) {
    return this.adminAccounts.revokeTokens(req.user.adminId, id);
  }
}
