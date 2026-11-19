import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean, IsIn, IsMongoId, Matches } from "class-validator";

/** Shared by create/update: a chat link / public handle. */
export const LINK_PATTERN = /^[a-zA-Z0-9_-]{3,64}$/;
import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import { ChatType } from "src/enum/base.enum";

export class CreateChatDto {
  @ApiProperty({ example: [], type: [String] })
  @IsArray()
  @IsOptional()
  @IsMongoId({ each: true })
  admins?: string[];

  @ApiProperty({
    example: "team-news",
    type: String,
    description: "Public handle / link slug (3–64 of a-z, 0-9, _ and -).",
  })
  @IsNotEmpty()
  @IsString()
  @Matches(LINK_PATTERN, {
    message: "The link can use 3–64 letters, numbers, underscores and hyphens.",
  })
  link: string;

  @ApiProperty({ example: "Channel", type: String })
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiProperty({
    example: ChatType.CHANNEL,
    enum: [ChatType.GROUP, ChatType.CHANNEL],
  })
  // Only groups and channels are created here — DMs go through
  // GET /chats/direct/:userId and Saved Messages is per-account.
  @IsIn([ChatType.GROUP, ChatType.CHANNEL], {
    message: "type must be group or channel",
  })
  @IsNotEmpty()
  type: string;

  @ApiProperty({
    required: false,
    default: false,
    description: "Public: searchable and joinable by anyone.",
  })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @ApiProperty({ example: [], type: [String] })
  @IsArray()
  @IsOptional()
  @IsMongoId({ each: true })
  members?: string[];

  @ApiProperty({ example: "A great channel", required: false })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({
    example: ["https://example.com/img.png"],
    required: false,
    type: [String],
    description:
      "Wire name for the internal `image` field — matches what every client actually sends.",
  })
  @IsArray()
  @IsOptional()
  imageUrl?: string[];

  @ApiProperty({ example: ["tech", "news"], required: false, type: [String] })
  @IsArray()
  @IsOptional()
  tags?: string[];
}
