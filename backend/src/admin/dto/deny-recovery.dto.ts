import { ApiProperty } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

export class DenyRecoveryDto {
  @ApiProperty({
    required: false,
    description: "Why it was denied. Internal only.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
