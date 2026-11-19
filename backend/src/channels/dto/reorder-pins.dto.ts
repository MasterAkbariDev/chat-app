import { ApiProperty } from "@nestjs/swagger";
import { ArrayMaxSize, IsArray, IsMongoId } from "class-validator";

export class ReorderPinsDto {
  @ApiProperty({
    type: [String],
    description:
      "Your pinned chats' ids, top first. Unknown or unpinned ids are ignored.",
  })
  @IsArray()
  @ArrayMaxSize(200)
  @IsMongoId({ each: true })
  channelIds: string[];
}
