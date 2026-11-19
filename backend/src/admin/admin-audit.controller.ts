import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { Public } from "src/common/decorators/public.decorator";
import { AllExceptionsFilter } from "src/common/filters/all-exceptions.filter";
import { Types } from "mongoose";
import { AdminJwtAuthGuard } from "./admin-jwt.guard";
import { AdminRoles } from "./admin-roles.decorator";
import { AdminRolesGuard } from "./admin-roles.guard";
import { AdminAuditService } from "./admin-audit.service";
import { dateQueryOf, pageOf, textQueryOf } from "./admin-query.util";
import { AdminRole } from "./schema/admin-user.schema";

/**
 * Superadmin only: the audit log shows what every admin did, including the other admins, so it
 * is not a support or moderator tool.
 */
@ApiTags("Admin — Audit")
@Controller({ path: "admin", version: "1" })
@Public()
@UseGuards(AdminJwtAuthGuard, AdminRolesGuard)
@UseFilters(AllExceptionsFilter)
@ApiBearerAuth()
export class AdminAuditController {
  constructor(private adminAuditService: AdminAuditService) {}

  @Get("audit")
  @AdminRoles(AdminRole.SUPERADMIN)
  @ApiOperation({
    summary: "Audit log — every admin action, filterable and paginated",
  })
  @ApiQuery({ name: "actorId", required: false })
  @ApiQuery({
    name: "action",
    required: false,
    description: "e.g. user.suspend",
  })
  @ApiQuery({ name: "targetType", required: false })
  @ApiQuery({ name: "targetId", required: false })
  @ApiQuery({
    name: "from",
    required: false,
    description: "ISO date, inclusive",
  })
  @ApiQuery({ name: "to", required: false, description: "ISO date, inclusive" })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "offset", required: false })
  list(
    @Query("actorId") actorId?: string,
    @Query("action") action?: string,
    @Query("targetType") targetType?: string,
    @Query("targetId") targetId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    if (actorId && !Types.ObjectId.isValid(actorId)) {
      throw new BadRequestException('"actorId" must be a valid id');
    }
    return this.adminAuditService.list({
      actorId: actorId || undefined,
      action: textQueryOf(action),
      targetType: textQueryOf(targetType),
      targetId: textQueryOf(targetId),
      from: dateQueryOf(from, "from"),
      to: dateQueryOf(to, "to"),
      ...pageOf(limit, offset),
    });
  }
}
