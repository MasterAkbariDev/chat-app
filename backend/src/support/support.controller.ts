import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { JWTPayload } from "src/interface/base.interface";
import { AllExceptionsFilter } from "src/common/filters/all-exceptions.filter";
import { ParseObjectIdPipe } from "src/common/pipes/parse-object-id.pipe";
import { SupportService } from "./support.service";
import { CreateTicketDto, TicketReplyDto } from "./dto/ticket.dto";

@ApiTags("Support")
@Controller({ path: "tickets", version: "1" })
@UseGuards(JwtAuthGuard)
@UseFilters(AllExceptionsFilter)
@ApiBearerAuth()
export class SupportController {
  constructor(private support: SupportService) {}

  @Post()
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @ApiOperation({ summary: "Open a support ticket" })
  @ApiBody({ type: CreateTicketDto })
  create(@Body() dto: CreateTicketDto, @Req() req: { user: JWTPayload }) {
    return this.support.create(req.user.userId, dto.subject, dto.body);
  }

  @Get()
  @ApiOperation({ summary: "Your support tickets, newest activity first" })
  list(@Req() req: { user: JWTPayload }) {
    return this.support.listMine(req.user.userId);
  }

  @Get(":id")
  @ApiParam({ name: "id" })
  @ApiOperation({ summary: "One of your tickets, with its thread" })
  get(
    @Param("id", ParseObjectIdPipe) id: string,
    @Req() req: { user: JWTPayload },
  ) {
    return this.support.getMine(req.user.userId, id);
  }

  @Post(":id/messages")
  @Throttle({ default: { limit: 20, ttl: 600_000 } })
  @ApiParam({ name: "id" })
  @ApiOperation({ summary: "Reply on your ticket (reopens it)" })
  @ApiBody({ type: TicketReplyDto })
  reply(
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: TicketReplyDto,
    @Req() req: { user: JWTPayload },
  ) {
    return this.support.reply(req.user.userId, id, dto.body);
  }
}
