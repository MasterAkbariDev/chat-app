import { ApiProperty } from "@nestjs/swagger";
import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";
import { ReportStatus } from "../schema/report.schema";

export class ResolveReportDto {
  @ApiProperty({ enum: ReportStatus })
  @IsEnum(ReportStatus)
  status: ReportStatus;

  @ApiProperty({
    required: false,
    description:
      'Free-text description of what was done, e.g. "suspended user"',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  action?: string;
}
