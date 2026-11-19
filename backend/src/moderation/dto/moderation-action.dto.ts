import { ApiProperty } from "@nestjs/swagger";
import {
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

export class SuspendUserDto {
  @ApiProperty({
    required: false,
    description:
      "ISO date/time the suspension lifts. Omit for an indefinite suspension.",
  })
  @IsOptional()
  @IsDateString()
  until?: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  @MaxLength(500)
  reason: string;
}

export class WarnUserDto {
  @ApiProperty({
    description: "Delivered as a DM from the 'Moderation' account",
  })
  @IsNotEmpty()
  @IsString()
  @MaxLength(2000)
  message: string;
}
