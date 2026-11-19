import {
  BadRequestException,
  Controller,
  Get,
  Param,
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
import { AdminJwtAuthGuard } from "./admin-jwt.guard";
import { AdminRolesGuard } from "./admin-roles.guard";
import {
  ADMIN_USER_STATUSES,
  AdminUserStatus,
  AdminUsersService,
} from "./admin-users.service";
import { pageOf, searchTextOf } from "./admin-query.util";

interface AdminRequest {
  user: { adminId: string; email: string; role: string };
}

/**
 * Every admin role may read the directory and user detail (support needs them, moderators need
 * the context on a report). Moderators get masked contact details and IPs (see admin-privacy.util).
 * Read-only; the one write here is the `user.view` audit entry.
 */
@ApiTags("Admin — Users")
@Controller({ path: "admin", version: "1" })
@Public()
@UseGuards(AdminJwtAuthGuard, AdminRolesGuard)
@UseFilters(AllExceptionsFilter)
@ApiBearerAuth()
export class AdminUsersController {
  constructor(private adminUsersService: AdminUsersService) {}

  @Get("users")
  @ApiOperation({
    summary: "User directory — search, filter by status, paginate",
  })
  @ApiQuery({
    name: "q",
    required: false,
    description: "Matches username, email, phone or name",
  })
  @ApiQuery({ name: "status", required: false, enum: ADMIN_USER_STATUSES })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "offset", required: false })
  list(
    @Query("q") q: string | undefined,
    @Query("status") status: string | undefined,
    @Query("limit") limit: string | undefined,
    @Query("offset") offset: string | undefined,
    @Req() req: AdminRequest,
  ) {
    if (
      status !== undefined &&
      !ADMIN_USER_STATUSES.includes(status as AdminUserStatus)
    ) {
      throw new BadRequestException(
        `"status" must be one of ${ADMIN_USER_STATUSES.join(", ")}`,
      );
    }
    return this.adminUsersService.list({
      q: searchTextOf(q),
      status: status as AdminUserStatus | undefined,
      viewerRole: req.user.role,
      ...pageOf(limit, offset),
    });
  }

  @Get("users/:id")
  @ApiOperation({
    summary:
      "User detail — profile, memberships, sessions, reports, moderation history",
    description: "Writes a `user.view` audit entry for the requesting admin.",
  })
  @ApiParam({ name: "id" })
  detail(@Param("id", ParseObjectIdPipe) id: string, @Req() req: AdminRequest) {
    return this.adminUsersService.detail(req.user.adminId, id, req.user.role);
  }
}
