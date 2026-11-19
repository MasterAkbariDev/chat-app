import {
  Body,
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
import { AdminUserActionsService } from "./admin-user-actions.service";
import { SoftDeleteUserDto } from "./dto/soft-delete-user.dto";
import { AdminRole } from "./schema/admin-user.schema";

interface AdminRequest {
  user: { adminId: string; email: string; role: string };
}

/** Account actions are support work. Each one is audited. */
@ApiTags("Admin — User actions")
@Controller({ path: "admin/users", version: "1" })
@Public()
@AdminRoles(AdminRole.SUPPORT, AdminRole.SUPERADMIN)
@UseGuards(AdminJwtAuthGuard, AdminRolesGuard)
@UseFilters(AllExceptionsFilter)
@ApiBearerAuth()
export class AdminUserActionsController {
  constructor(private actions: AdminUserActionsService) {}

  @Post(":id/force-logout")
  @ApiOperation({ summary: "End every session on every device. Audited." })
  @ApiParam({ name: "id" })
  forceLogout(
    @Param("id", ParseObjectIdPipe) id: string,
    @Req() req: AdminRequest,
  ) {
    return this.actions.forceLogout(req.user.adminId, id);
  }

  @Post(":id/soft-delete")
  @ApiOperation({
    summary:
      "Soft-delete an account (reversible). Requires the username as confirmation.",
  })
  @ApiParam({ name: "id" })
  softDelete(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() body: SoftDeleteUserDto,
    @Req() req: AdminRequest,
  ) {
    return this.actions.softDelete(
      req.user.adminId,
      id,
      body.reason,
      body.confirm,
    );
  }

  @Post(":id/restore")
  @ApiOperation({ summary: "Restore a soft-deleted account. Audited." })
  @ApiParam({ name: "id" })
  restore(
    @Param("id", ParseObjectIdPipe) id: string,
    @Req() req: AdminRequest,
  ) {
    return this.actions.restore(req.user.adminId, id);
  }
}
