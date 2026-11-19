import { ApiProperty } from "@nestjs/swagger";
import { IsArray, IsString } from "class-validator";

export class UpdatePackItemDto {
  @ApiProperty({ type: [String], example: ["😂", "😆", "lol"] })
  @IsArray()
  @IsString({ each: true })
  keywords: string[];
}
