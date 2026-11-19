import { ApiProperty } from "@nestjs/swagger";
import {
  IsEnum,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import { TicketStatus } from "src/support/schema/support-ticket.schema";

export class AdminTicketReplyDto {
  @ApiProperty({ maxLength: 4000 })
  @IsNotEmpty()
  @IsString()
  @MaxLength(4000)
  body: string;
}

export class UpdateTicketDto {
  @ApiProperty({ required: false, enum: TicketStatus })
  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  @ApiProperty({
    required: false,
    nullable: true,
    description: "An admin id, or null to unassign",
  })
  @IsOptional()
  @IsMongoId()
  assignedTo?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsMongoId()
  relatedRecoveryRequestId?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsMongoId()
  relatedReportId?: string | null;
}
