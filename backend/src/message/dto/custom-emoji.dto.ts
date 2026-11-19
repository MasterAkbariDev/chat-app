import { ApiProperty } from "@nestjs/swagger";
import { IsInt, IsNotEmpty, IsString, Max, Min } from "class-validator";

/** One animated emoji placed *inside* a text message (Telegram-style custom
 * emoji). `content` keeps a plain unicode fallback at
 * `[offset, offset + length)` (UTF-16 code units), so previews, search,
 * notifications and older clients still read sensibly; capable clients draw
 * the pack item over that span instead. */
export class CustomEmojiEntityDto {
  @ApiProperty({ example: 6 })
  @IsInt()
  @Min(0)
  @Max(4000)
  offset: number;

  @ApiProperty({
    example: 2,
    description: "UTF-16 code units of the fallback emoji",
  })
  @IsInt()
  @Min(1)
  @Max(32)
  length: number;

  @ApiProperty({ example: "507f1f77bcf86cd799439013" })
  @IsString()
  @IsNotEmpty()
  packItemId: string;
}
