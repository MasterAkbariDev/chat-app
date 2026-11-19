import {
  Body,
  Controller,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "src/auth/auth.guard";
import { JWTPayload } from "src/interface/base.interface";
import { AllExceptionsFilter } from "src/common/filters/all-exceptions.filter";
import { ReportService } from "./report.service";
import { CreateReportDto } from "./dto/create-report.dto";

@ApiTags("Reports")
@Controller({ path: "reports", version: "1" })
@UseGuards(JwtAuthGuard)
@UseFilters(AllExceptionsFilter)
@ApiBearerAuth()
export class ReportController {
  constructor(private reportService: ReportService) {}

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: "Report a message, user, or channel",
    description:
      "Lands in the admin moderation queue. One report per reporter+target.",
  })
  @ApiBody({ type: CreateReportDto })
  create(@Body() dto: CreateReportDto, @Req() req: { user: JWTPayload }) {
    return this.reportService.create(req.user.userId, dto);
  }
}
