import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

export class AddRecentEmojiDto {
  @ApiPropertyOptional({
    description: "A plain emoji (give this or packItemId)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  emoji?: string;

  @ApiPropertyOptional({
    description:
      "An animated emoji from a pack you own or added (give this or emoji)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  packItemId?: string;
}
