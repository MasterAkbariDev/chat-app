import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { CustomEmojiEntityDto } from "./custom-emoji.dto";

export class UpdateMessageDto {
  @ApiProperty({ example: "Updated message content" })
  @IsString()
  @IsNotEmpty({ message: "Content cannot be empty" })
  @MaxLength(4000)
  content: string;

  @ApiProperty({
    required: false,
    type: [CustomEmojiEntityDto],
    description:
      "Inline animated emoji for the edited text. Omitted = none (they're positional, so stale ones are dropped).",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CustomEmojiEntityDto)
  customEmoji?: CustomEmojiEntityDto[];
}
