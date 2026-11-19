import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { Public } from "src/common/decorators/public.decorator";
import { ParseObjectIdPipe } from "src/common/pipes/parse-object-id.pipe";
import { AllExceptionsFilter } from "src/common/filters/all-exceptions.filter";
import { RecoveryRequestStatus } from "src/auth/schema/recovery-request.schema";
import { AdminJwtAuthGuard } from "./admin-jwt.guard";
import { AdminRoles } from "./admin-roles.decorator";
import { AdminRolesGuard } from "./admin-roles.guard";
import { AdminRecoveryService } from "./admin-recovery.service";
import { DenyRecoveryDto } from "./dto/deny-recovery.dto";
import { pageOf } from "./admin-query.util";
import { AdminRole } from "./schema/admin-user.schema";

interface AdminRequest {
  user: { adminId: string; email: string; role: string };
}

/** Password recovery is support work. Moderators do not see or act on it. */
@ApiTags("Admin — Recovery")
@Controller({ path: "admin", version: "1" })
@Public()
@AdminRoles(AdminRole.SUPPORT, AdminRole.SUPERADMIN)
@UseGuards(AdminJwtAuthGuard, AdminRolesGuard)
@UseFilters(AllExceptionsFilter)
@ApiBearerAuth()
export class AdminRecoveryController {
  constructor(private recovery: AdminRecoveryService) {}

  @Get("recovery-requests")
  @ApiOperation({
    summary: "Recovery queue, filtered by status (default pending)",
  })
  @ApiQuery({ name: "status", required: false, enum: RecoveryRequestStatus })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "offset", required: false })
  list(
    @Query("status") status: string | undefined,
    @Query("limit") limit: string | undefined,
    @Query("offset") offset: string | undefined,
  ) {
    const allowed = Object.values(RecoveryRequestStatus) as string[];
    if (status !== undefined && !allowed.includes(status)) {
      throw new BadRequestException(
        `"status" must be one of ${allowed.join(", ")}`,
      );
    }
    return this.recovery.list({
      status:
        (status as RecoveryRequestStatus | undefined) ??
        RecoveryRequestStatus.PENDING,
      ...pageOf(limit, offset),
    });
  }

  @Post("recovery-requests/:id/approve")
  @ApiOperation({
    summary: "Approve a request: mints a one-time link, returned once",
    description:
      "The link is shown once here and can never be read back. Audited.",
  })
  @ApiParam({ name: "id" })
  approve(
    @Param("id", ParseObjectIdPipe) id: string,
    @Req() req: AdminRequest,
  ) {
    return this.recovery.approve(id, req.user.adminId);
  }

  @Post("recovery-requests/:id/deny")
  @ApiOperation({ summary: "Deny a request, with an optional note. Audited." })
  @ApiParam({ name: "id" })
  deny(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() body: DenyRecoveryDto,
    @Req() req: AdminRequest,
  ) {
    return this.recovery.deny(id, req.user.adminId, body.note);
  }

  @Post("recovery-tokens/:id/mark-sent")
  @ApiOperation({
    summary: "Record that the link was sent to the user out of band. Audited.",
  })
  @ApiParam({ name: "id" })
  markSent(
    @Param("id", ParseObjectIdPipe) id: string,
    @Req() req: AdminRequest,
  ) {
    return this.recovery.markSent(id, req.user.adminId);
  }

  @Post("recovery-tokens/:id/revoke")
  @ApiOperation({
    summary: "Revoke an unused link before it expires. Audited.",
  })
  @ApiParam({ name: "id" })
  revoke(@Param("id", ParseObjectIdPipe) id: string, @Req() req: AdminRequest) {
    return this.recovery.revoke(id, req.user.adminId);
  }
}
