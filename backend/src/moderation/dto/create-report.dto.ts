import { ApiProperty } from "@nestjs/swagger";
import {
  IsEnum,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import { ReportTargetType } from "../schema/report.schema";

export class CreateReportDto {
  @ApiProperty({ enum: ReportTargetType })
  @IsEnum(ReportTargetType)
  targetType: ReportTargetType;

  @ApiProperty({ description: "The message/user/channel id being reported" })
  @IsMongoId()
  targetId: string;

  @ApiProperty({ example: "spam" })
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  reason: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
