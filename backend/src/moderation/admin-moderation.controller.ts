import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
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
import { AdminJwtAuthGuard } from "src/admin/admin-jwt.guard";
import { ReportService } from "./report.service";
import { ModerationService } from "./moderation.service";
import { ResolveReportDto } from "./dto/resolve-report.dto";
import { SuspendUserDto, WarnUserDto } from "./dto/moderation-action.dto";
import { ReportStatus, ReportTargetType } from "./schema/report.schema";

interface AdminRequest {
  user: { adminId: string; email: string; role: string };
}

/** `@Public()` at the class level only skips the *global* user `JwtAuthGuard` — every route
 *  re-applies `AdminJwtAuthGuard`, which requires a real admin-audience token. */
@ApiTags("Admin — Moderation")
@Controller({ path: "admin", version: "1" })
@Public()
@UseGuards(AdminJwtAuthGuard)
@UseFilters(AllExceptionsFilter)
@ApiBearerAuth()
export class AdminModerationController {
  constructor(
    private reportService: ReportService,
    private moderationService: ModerationService,
  ) {}

  @Get("reports")
  @ApiOperation({ summary: "List reports" })
  @ApiQuery({ name: "status", required: false, enum: ReportStatus })
  @ApiQuery({ name: "type", required: false, enum: ReportTargetType })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "offset", required: false })
  listReports(
    @Query("status") status?: ReportStatus,
    @Query("type") type?: ReportTargetType,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.reportService.list(
      status,
      type,
      Math.min(Math.max(Number(limit) || 50, 1), 100),
      Math.max(Number(offset) || 0, 0),
    );
  }

  @Patch("reports/:id")
  @ApiOperation({ summary: "Assign/resolve a report" })
  @ApiParam({ name: "id" })
  resolveReport(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: ResolveReportDto,
    @Req() req: AdminRequest,
  ) {
    return this.reportService.resolve(id, req.user.adminId, dto);
  }

  @Post("users/:id/suspend")
  @ApiOperation({ summary: "Suspend a user (blocks login and API access)" })
  @ApiParam({ name: "id" })
  suspendUser(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: SuspendUserDto,
    @Req() req: AdminRequest,
  ) {
    return this.moderationService.suspendUser(
      req.user.adminId,
      id,
      dto.until,
      dto.reason,
    );
  }

  @Post("users/:id/unsuspend")
  @ApiOperation({ summary: "Lift a user's suspension" })
  @ApiParam({ name: "id" })
  unsuspendUser(
    @Param("id", ParseObjectIdPipe) id: string,
    @Req() req: AdminRequest,
  ) {
    return this.moderationService.unsuspendUser(req.user.adminId, id);
  }

  @Post("users/:id/warn")
  @ApiOperation({
    summary: "Warn a user — delivered as a DM from the 'Moderation' account",
  })
  @ApiParam({ name: "id" })
  warnUser(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: WarnUserDto,
    @Req() req: AdminRequest,
  ) {
    return this.moderationService.warnUser(req.user.adminId, id, dto.message);
  }

  @Delete("messages/:id")
  @ApiOperation({
    summary: "Hard-hide a message (content scrubbed, not just flagged)",
  })
  @ApiParam({ name: "id" })
  hardHideMessage(
    @Param("id", ParseObjectIdPipe) id: string,
    @Req() req: AdminRequest,
  ) {
    return this.moderationService.hardHideMessage(req.user.adminId, id);
  }

  @Post("channels/:id/lock")
  @ApiOperation({ summary: "Lock a channel (blocks new messages)" })
  @ApiParam({ name: "id" })
  lockChannel(
    @Param("id", ParseObjectIdPipe) id: string,
    @Req() req: AdminRequest,
  ) {
    return this.moderationService.lockChannel(req.user.adminId, id);
  }

  @Post("channels/:id/unlock")
  @ApiOperation({ summary: "Unlock a channel" })
  @ApiParam({ name: "id" })
  unlockChannel(
    @Param("id", ParseObjectIdPipe) id: string,
    @Req() req: AdminRequest,
  ) {
    return this.moderationService.unlockChannel(req.user.adminId, id);
  }

  @Post("channels/:id/members/:userId/remove")
  @ApiOperation({ summary: "Remove a member from a channel" })
  @ApiParam({ name: "id" })
  @ApiParam({ name: "userId" })
  removeChannelMember(
    @Param("id", ParseObjectIdPipe) id: string,
    @Param("userId", ParseObjectIdPipe) userId: string,
    @Req() req: AdminRequest,
  ) {
    return this.moderationService.removeChannelMember(
      req.user.adminId,
      id,
      userId,
    );
  }
}
