import { ApiProperty } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";
import { LINK_PATTERN } from "./create-chat.dto";

export class UpdateChatDto {
  @ApiProperty({
    example: "team-news",
    type: String,
    description: "Owner only.",
  })
  @IsNotEmpty()
  @IsString()
  @IsOptional()
  @Matches(LINK_PATTERN, {
    message: "The link can use 3–64 letters, numbers, underscores and hyphens.",
  })
  link?: string;

  @ApiProperty({
    required: false,
    description:
      "Owner only. Public: searchable, readable before joining, joinable by anyone.",
  })
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @ApiProperty({
    required: false,
    description:
      "Channels only. On: each post shows its author's name next to the time.",
  })
  @IsOptional()
  @IsBoolean()
  signature?: boolean;

  @ApiProperty({ example: "Test", type: String })
  @IsOptional()
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiProperty({
    example: [],
    type: [String],
    description: "Owner only. Replaces the full admin set.",
  })
  @IsOptional()
  @IsArray()
  admins?: string[];

  @ApiProperty({ example: "A great channel", required: false })
  @IsOptional()
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
  @ArrayMaxSize(1)
  @IsString({ each: true })
  imageUrl?: string[];
}
