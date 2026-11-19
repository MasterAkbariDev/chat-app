import {
  BadRequestException,
  Body,
  Controller,
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
import { AllExceptionsFilter } from "src/common/filters/all-exceptions.filter";
import { TicketStatus } from "src/support/schema/support-ticket.schema";
import { AdminJwtAuthGuard } from "./admin-jwt.guard";
import { AdminRoles } from "./admin-roles.decorator";
import { AdminRolesGuard } from "./admin-roles.guard";
import { AdminSupportService } from "./admin-support.service";
import { AdminTicketReplyDto, UpdateTicketDto } from "./dto/ticket-admin.dto";
import { pageOf } from "./admin-query.util";
import { AdminRole } from "./schema/admin-user.schema";
import { ParseObjectIdPipe } from "src/common/pipes/parse-object-id.pipe";

interface AdminRequest {
  user: { adminId: string; email: string; role: string };
}

@ApiTags("Admin — Support")
@Controller({ path: "admin/tickets", version: "1" })
@Public()
@AdminRoles(AdminRole.SUPPORT, AdminRole.SUPERADMIN)
@UseGuards(AdminJwtAuthGuard, AdminRolesGuard)
@UseFilters(AllExceptionsFilter)
@ApiBearerAuth()
export class AdminSupportController {
  constructor(private support: AdminSupportService) {}

  @Get()
  @ApiOperation({ summary: "Ticket queue, filterable by status and assignee" })
  @ApiQuery({ name: "status", required: false, enum: TicketStatus })
  @ApiQuery({
    name: "assignedTo",
    required: false,
    description: "An admin id, or 'me'",
  })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "offset", required: false })
  list(
    @Query("status") status: string | undefined,
    @Query("assignedTo") assignedTo: string | undefined,
    @Query("limit") limit: string | undefined,
    @Query("offset") offset: string | undefined,
    @Req() req: AdminRequest,
  ) {
    const allowed = Object.values(TicketStatus) as string[];
    if (status !== undefined && !allowed.includes(status)) {
      throw new BadRequestException(
        `"status" must be one of ${allowed.join(", ")}`,
      );
    }
    return this.support.list({
      status: status as TicketStatus | undefined,
      assignedTo: assignedTo === "me" ? req.user.adminId : assignedTo,
      ...pageOf(limit, offset),
    });
  }

  @Get(":id")
  @ApiParam({ name: "id" })
  @ApiOperation({ summary: "One ticket with its full thread" })
  get(@Param("id", ParseObjectIdPipe) id: string) {
    return this.support.get(id);
  }

  @Post(":id/messages")
  @ApiParam({ name: "id" })
  @ApiOperation({
    summary:
      "Reply to the user. Sets the ticket to pending and notifies them. Audited.",
  })
  reply(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: AdminTicketReplyDto,
    @Req() req: AdminRequest,
  ) {
    return this.support.reply(id, req.user.adminId, dto.body);
  }

  @Patch(":id")
  @ApiParam({ name: "id" })
  @ApiOperation({ summary: "Change status, assignee or links. Audited." })
  update(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: UpdateTicketDto,
    @Req() req: AdminRequest,
  ) {
    return this.support.update(id, req.user.adminId, dto);
  }
}
